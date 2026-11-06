"""楽曲のコード候補と変化時刻を、音の変化に合わせて推定します。"""

from dataclasses import dataclass, replace
from math import gcd
from numbers import Integral

import numpy as np
from scipy.fft import next_fast_len, rfft
from scipy.signal import find_peaks, resample_poly

from .chords import PITCH_NAMES
from .song_bass import analyse_bass, stable_bass

# (種類, 表記, 根音から数えた半音の位置)
_QUALITIES = (
    ("major", "", (0, 4, 7)),
    ("minor", "m", (0, 3, 7)),
    ("dominant7", "7", (0, 4, 7, 10)),
    ("major7", "maj7", (0, 4, 7, 11)),
    ("minor7", "m7", (0, 3, 7, 10)),
    ("half_diminished7", "m7b5", (0, 3, 6, 10)),
    ("minor_major7", "mMaj7", (0, 3, 7, 11)),
    ("diminished7", "dim7", (0, 3, 6, 9)),
    ("power", "5", (0, 7)),
)

# テンションは候補だけ。9/11/13 では省略されることのある音も許します。
# (表記, 必須音, 追加の構成音, 根拠となるテンション)
_EXTENSIONS = (
    ("9", (0, 4, 10, 2), (7,), 2),
    ("11", (0, 10, 5), (4, 7, 2), 5),
    ("13", (0, 4, 10, 9), (7, 2, 5), 9),
    ("maj9", (0, 4, 11, 2), (7,), 2),
    ("m9", (0, 3, 10, 2), (7,), 2),
    ("m11", (0, 3, 10, 5), (7, 2), 5),
)


@dataclass(frozen=True)
class HarmonyEvent:
    """コードの推定区間。時刻は渡した音源の先頭からの秒数です。"""

    start_s: float
    end_s: float
    chord: str
    status: str  # confirmed / candidate / unknown
    root: str | None
    quality: str | None
    notes: tuple[str, ...]
    bass: str | None
    candidates: tuple[str, ...]
    score: float  # 内部スコア。正解の確率ではありません。
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class NoteEvidence:
    """フレーム時刻、12音の相対的な強さ、フレームごとのRMS。"""

    times_s: np.ndarray
    strengths: np.ndarray  # (フレーム数, 12)、CからB、フレームごとに最大1
    rms: np.ndarray
    lowest_hz: np.ndarray  # 根拠のある最も低いピーク。見つからない場合は nan。


@dataclass(frozen=True)
class ArpeggioSpan:
    start_s: float
    end_s: float
    repeated: bool


@dataclass(frozen=True)
class _NoteRun:
    pitch: int
    start_s: float
    end_s: float
    lowest_hz: float
    low_register: bool


def _audio_vector(samples, name):
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim != 1 or not len(values) or not np.all(np.isfinite(values)):
        raise ValueError(f"{name}には有限な値を持つ空でないモノラル音声を渡してください")
    return values


def _pitch_class_peaks(spectrum, rate, n_fft):
    """ピークを音名に変換し、低い音の倍音で説明できる成分を弱めます。"""
    scale = rate / n_fft
    low_bin = max(1, int(58 / scale))
    high_bin = min(len(spectrum) - 1, int(1800 / scale) + 1)
    band = spectrum[low_bin:high_bin]
    if not len(band) or band.max() <= 1e-9:
        return np.zeros(12), np.nan
    threshold = band.max() * 0.04
    indices = np.flatnonzero(
        (band >= threshold)
        & (band > spectrum[low_bin - 1:high_bin - 1])
        & (band >= spectrum[low_bin + 1:high_bin + 1])
    ) + low_bin
    # ピークの両隣も使い、FFTビン間の位置を補間します。
    mid = np.log(np.maximum(spectrum[indices], 1e-20))
    left = np.log(np.maximum(spectrum[indices - 1], 1e-20))
    right = np.log(np.maximum(spectrum[indices + 1], 1e-20))
    curvature = left - 2 * mid + right
    shift = np.divide(0.5 * (left - right), curvature, out=np.zeros_like(mid), where=curvature < -1e-9)
    frequencies = scale * (indices + np.clip(shift, -0.5, 0.5))
    amplitudes = np.exp(mid - 0.25 * (left - right) * shift)

    strength = np.zeros(12)
    fundamentals = []
    # 倍音の大きさの目安。真の和音と倍音列が重なる場合もあるので、
    # この大きさを超えたピークについては超えた分を根拠として残します。
    harmonic_scale = (0, 0, 0.96, 0.68, 0.55, 0.48, 0.42, 0.36, 0.32)
    for index, (frequency, amplitude) in enumerate(zip(frequencies, amplitudes)):
        midi = 69 + 12 * np.log2(frequency / 440)
        if abs(midi - round(midi)) > 0.43:
            continue
        pitch_class = round(midi) % 12
        weight = min(1, (550 / frequency) ** 2)
        predicted_harmonic = 0.0
        for base_frequency, base_amplitude, clear_series, base_pitch in fundamentals:
            ratio = frequency / base_frequency
            harmonic = round(ratio)
            if 2 <= harmonic <= 24 and abs(ratio / harmonic - 1) < 0.017:
                if clear_series:
                    if harmonic in (2, 4, 8, 16):
                        strength[base_pitch] = max(strength[base_pitch], amplitude * weight)
                    predicted_harmonic = max(predicted_harmonic, amplitude)
                elif harmonic < len(harmonic_scale):
                    predicted_harmonic = max(predicted_harmonic, base_amplitude * harmonic_scale[harmonic])
        remaining = max(0.0, amplitude - predicted_harmonic)
        if remaining < threshold:
            continue
        # 低いピークから3個以上の倍音が見えるときは、倍音の大小が
        # 音色によって大きく違っても、この一連の成分は同じ弦と見なします。
        ratios = frequencies[index + 1:] / frequency
        orders = np.round(ratios)
        matches = (orders >= 2) & (orders <= 14) & (np.abs(ratios - orders) < 0.017 * orders)
        clear_series = len(set(orders[matches])) >= 3
        fundamentals.append((frequency, remaining, clear_series, pitch_class))
        # 高いピークほど、基音を見失った弦の高次倍音である可能性も高くなります。
        strength[pitch_class] = max(strength[pitch_class], remaining * weight)
    peak = strength.max()
    if peak <= 0:
        return strength, np.nan
    lowest = next((frequency for frequency, _, _, pitch in fundamentals if strength[pitch] >= 0.18 * peak), np.nan)
    return strength / peak, lowest


def guitar_note_evidence(samples, sample_rate, *, hop_s=0.02):
    """周波数ピークの変化を追い、倍音を抑えたクロマを求めます。"""
    values = _audio_vector(samples, "入力")
    if not isinstance(sample_rate, Integral) or sample_rate < 4000:
        raise ValueError("サンプリング周波数は4000 Hz以上の整数にしてください")
    if not np.isfinite(hop_s) or not 0.005 <= hop_s <= 0.1:
        raise ValueError("hop_sは0.005〜0.1秒で指定してください")
    rate = min(sample_rate, 22050)
    if sample_rate != rate:
        divisor = gcd(sample_rate, rate)
        values = resample_poly(values, rate // divisor, sample_rate // divisor)
    frame_size = round(0.12 * rate)
    hop = max(1, round(hop_s * rate))
    centres = np.arange(0, len(values), hop)
    padded = np.pad(values, (frame_size // 2, frame_size - frame_size // 2))
    frames = np.lib.stride_tricks.sliding_window_view(padded, frame_size)[centres[0]:centres[-1] + 1:hop]
    window = np.hanning(frame_size).astype(np.float32)
    n_fft = next_fast_len(4 * frame_size)
    strengths = np.zeros((len(frames), 12))
    rms = np.zeros(len(frames))
    lowest_hz = np.full(len(frames), np.nan)
    quiet = max(1e-5, float(np.max(np.abs(values))) * 0.0015)
    for begin in range(0, len(frames), 128):
        end = min(begin + 128, len(frames))
        block = frames[begin:end]
        rms[begin:end] = np.sqrt(np.mean(block ** 2, axis=1))
        spectra = np.abs(rfft(block * window, n=n_fft, axis=1))
        for offset in range(end - begin):
            frame = begin + offset
            if rms[frame] >= quiet:
                strengths[frame], lowest_hz[frame] = _pitch_class_peaks(spectra[offset], rate, n_fft)
    return NoteEvidence(centres / rate, strengths, rms, lowest_hz)


def _progressing_arpeggios(runs, longest_gap):
    """根音から1オクターブ上まで弾く三和音が、連続して変わる区間を探します。"""
    chains = []
    previous_index = -4
    previous_end = -np.inf
    for first in range(len(runs) - 3):
        pattern = runs[first:first + 4]
        freqs = [run.lowest_hz for run in pattern]
        if not pattern[0].low_register or not all(np.isfinite(freqs)):
            continue
        intervals = tuple(round(12 * np.log2(freq / freqs[0])) for freq in freqs)
        if intervals not in {(0, 3, 7, 12), (0, 4, 7, 12)}:
            continue
        if any(b.start_s - a.end_s > longest_gap for a, b in zip(pattern, pattern[1:])):
            continue
        if not chains or first != previous_index + 4 or pattern[0].start_s - previous_end > longest_gap:
            chains.append([])
        chains[-1].append(pattern)
        previous_index = first
        previous_end = pattern[-1].end_s
    return [
        ArpeggioSpan(notes[0].start_s, notes[-1].end_s, False)
        for chain in chains if len(chain) >= 3 and len({notes[0].pitch for notes in chain}) >= 2
        for notes in chain
    ]


def detect_arpeggios(evidence, bpm=None):
    """基本和音の反復と、規則的に切り替わるアルペジオの候補を探します。"""
    if len(evidence.times_s) < 2:
        return []
    hop = evidence.times_s[1] - evidence.times_s[0]
    beat = 60 / bpm if bpm is not None else 0.5
    longest_note = float(np.clip(1.1 * beat, 0.36, 0.55))
    longest_gap = float(np.clip(0.35 * beat, 0.08, 0.16))
    audible = evidence.rms >= max(0.001, 0.09 * float(np.quantile(evidence.rms, 0.9)))
    dominant = np.argmax(evidence.strengths, axis=1)
    dominant[~audible | (evidence.strengths.max(axis=1) == 0)] = -1
    edges = np.flatnonzero(np.r_[True, dominant[1:] != dominant[:-1], True])
    single = np.count_nonzero(evidence.strengths >= 0.18, axis=1) == 1

    runs = []
    for first, last in zip(edges, edges[1:]):
        if dominant[first] < 0 or not 0.065 <= (last - first) * hop <= longest_note:
            continue
        if np.mean(single[first:last]) < 0.60:
            continue
        frequencies = evidence.lowest_hz[first:last]
        valid = frequencies[np.isfinite(frequencies)]
        lowest = float(np.median(valid)) if len(valid) >= (last - first) / 2 else np.nan
        runs.append(_NoteRun(
            int(dominant[first]), float(evidence.times_s[first]), float(evidence.times_s[last - 1] + hop),
            lowest, bool(np.mean(frequencies <= 430) >= 0.5),
        ))
    allowed = {
        frozenset((root + step) % 12 for step in intervals)
        for root in range(12) for _, _, intervals in _QUALITIES if len(intervals) >= 3
    }
    pitches = [run.pitch for run in runs]
    spans = []
    covered = 0
    for start in range(len(runs) - 5):
        if start < covered:
            continue
        for period in range(3, min(8, (len(runs) - start) // 2) + 1):
            pattern = pitches[start:start + period]
            if frozenset(pattern) not in allowed or not any(run.low_register for run in runs[start:start + period]):
                continue
            end = start + period
            while pitches[end:end + period] == pattern and all(
                runs[index].start_s - runs[index - 1].end_s <= longest_gap
                for index in range(end - period + 1, end + period)
            ):
                end += period
            if end < start + 2 * period:
                continue
            spans.append(ArpeggioSpan(runs[start].start_s, runs[end - 1].end_s, True))
            covered = end
            break
    progressions = _progressing_arpeggios(runs, longest_gap)
    spans += [
        span for span in progressions
        if not any(repeated.start_s < span.end_s and span.start_s < repeated.end_s for repeated in spans)
    ]
    return sorted(spans, key=lambda span: span.start_s)


def find_arpeggios(evidence, bpm=None):
    """アルペジオ区間の開始・終了時刻を返します。"""
    return [(span.start_s, span.end_s) for span in detect_arpeggios(evidence, bpm)]


def _normalise_rows(values):
    sums = values.sum(axis=1, keepdims=True)
    return np.divide(values, sums, out=np.zeros_like(values), where=sums > 0)


def _adjacent_means(values, radius):
    """各時刻について、すぐ前とすぐ後ろの短い区間の平均を求めます。"""
    prefix = np.vstack((np.zeros((1, values.shape[1])), values.cumsum(axis=0)))
    indices = np.arange(len(values))
    left = np.maximum(0, indices - radius)
    right = np.minimum(len(values), indices + radius)
    past = (prefix[indices] - prefix[left]) / np.maximum(indices - left, 1)[:, None]
    future = (prefix[right] - prefix[indices]) / np.maximum(right - indices, 1)[:, None]
    return past, future


def _change_times(guitar, bass_track, duration, bpm, arpeggios):
    """和音・立ち上がり・持続するベース音の変化がある場所を選びます。"""
    if len(guitar.times_s) < 3:
        return [0.0, duration]
    hop_s = guitar.times_s[1] - guitar.times_s[0]
    beat_s = 60 / bpm
    radius = max(2, round(np.clip(0.5 * beat_s, 0.12, 0.36) / hop_s))
    # 弾き直しで音量の比が変わっても、同じ構成音なら境界にしにくくします。
    active = np.clip((guitar.strengths - 0.12) / 0.28, 0, 1)
    profiles = _normalise_rows(active)
    left, right = _adjacent_means(profiles, radius)
    novelty = 0.5 * np.abs(right - left).sum(axis=1)
    # 立ち上がりだけでは判定せず、前後の音名の違いがある場所の補助にします。
    flux = np.r_[0.0, np.maximum(0, np.diff(profiles, axis=0)).sum(axis=1)]
    novelty *= 1 + 0.15 * np.minimum(flux, 1)
    # 1音ずつ弾く部分は和音の内部です。ベースの変化はこの後で別に調べます。
    for span in arpeggios:
        novelty[(guitar.times_s >= span.start_s - 0.06) & (guitar.times_s < span.end_s + 0.06)] = 0
    if bass_track is not None and len(bass_track.times_s):
        indices = np.clip(np.searchsorted(bass_track.times_s, guitar.times_s), 0, len(bass_track.times_s) - 1)
        pitches = bass_track.pitch_classes[indices]
        bass_rows = np.zeros_like(profiles)
        valid = np.flatnonzero((pitches >= 0) & (bass_track.strength[indices] >= 0.78))
        bass_rows[valid, pitches[valid]] = 1
        left_bass, right_bass = _adjacent_means(bass_rows, radius)
        bass_change = (
            (left_bass.max(axis=1) >= 0.72) & (right_bass.max(axis=1) >= 0.72)
            & (left_bass.argmax(axis=1) != right_bass.argmax(axis=1))
        )
        novelty += 0.27 * bass_change
    # 四分の一拍は境界を分ける目安です。固定幅でコードを割り当てません。
    spacing_s = max(0.10, beat_s / 4)
    edges = max(1, round(spacing_s / hop_s))
    novelty[:edges] = 0
    novelty[-edges:] = 0
    peaks, _ = find_peaks(novelty, height=0.17, prominence=0.08, distance=edges)
    times = [0.0, *(float(guitar.times_s[i]) for i in peaks if guitar.times_s[i] < duration), duration]
    for arpeggio in arpeggios:
        for time in (arpeggio.start_s, arpeggio.end_s):
            if min(abs(existing - time) for existing in times) >= 0.065:
                times.append(time)
    return sorted(times)


def _frames(evidence, start_s, end_s, hop_limit=0):
    """区間のフレームを集め、余裕がある場合は境界付近の混じった音を除きます。"""
    left = np.searchsorted(evidence.times_s, start_s)
    right = np.searchsorted(evidence.times_s, end_s)
    frames = evidence.strengths[left:right]
    if hop_limit > 0 and len(frames) > 2 * hop_limit + 4:
        frames = frames[hop_limit:-hop_limit]
    return frames


def _profile(frames):
    """区間内の音名の強さと出現頻度をまとめます。"""
    if not len(frames):
        return np.zeros(12), np.zeros(12)
    mean = frames.mean(axis=0)
    peak = mean.max()
    if peak <= 0:
        return mean, np.zeros(12)
    return mean / peak, (frames >= 0.18).mean(axis=0)


@dataclass(frozen=True)
class _Choice:
    name: str
    root: int
    quality: str
    notes: tuple[int, ...]
    score: float
    purity: float
    supported: bool


def _template_score(profile, notes, required):
    required_values = profile[list(required)]
    purity = float(profile[list(notes)].sum() / profile.sum())
    coverage = float(np.minimum(required_values / 0.24, 1).mean())
    balance = float(np.sqrt(required_values.min()))
    return 0.52 * purity + 0.35 * coverage + 0.13 * balance, purity


def _choices(profile, occupancy, quiet_occupancy, bass):
    """構成音が揃っているか、余分な音がどの程度あるかを比べます。"""
    basic, extended = [], []
    sustained = (occupancy >= 0.13) | (quiet_occupancy >= 0.60)
    for root, name in enumerate(PITCH_NAMES):
        if profile[root] < 0.11:
            continue
        thirds = [(root + step) % 12 for step in (3, 4)]
        third_present = np.any((profile[thirds] >= 0.14) & (quiet_occupancy[thirds] >= 0.60))
        for quality, suffix, intervals in _QUALITIES:
            notes = tuple((root + step) % 12 for step in intervals)
            if np.count_nonzero(profile[list(notes)] >= 0.12) < max(2, len(notes) - 1):
                continue
            # 3度が弱くても長く続く場合は、ルートと5度の組だけを採用しません。
            if quality == "power" and third_present:
                continue
            score, purity = _template_score(profile, notes, notes)
            supported = bool(np.all(profile[list(notes)] >= 0.15) and np.all(sustained[list(notes)]))
            if bass == name:
                score += 0.016
            basic.append(_Choice(name + suffix, root, quality, notes, min(score, 1.0), purity, supported))
        for suffix, required_steps, optional_steps, tension_step in _EXTENSIONS:
            required = tuple((root + step) % 12 for step in required_steps)
            tension = (root + tension_step) % 12
            if np.any(profile[list(required)] < 0.20) or occupancy[tension] < 0.42:
                continue
            notes = required + tuple((root + step) % 12 for step in optional_steps)
            score, purity = _template_score(profile, notes, required)
            extended.append(_Choice(name + suffix, root, suffix, notes, score, purity, False))
    basic.sort(key=lambda choice: -choice.score)
    extended.sort(key=lambda choice: -choice.score)
    return basic, extended


def _event(guitar, bass_track, mixture, start, end, independent_bass, arpeggio=None):
    window = (arpeggio.start_s, arpeggio.end_s) if arpeggio is not None else (start, end)
    frames = _frames(guitar, *window, hop_limit=2)
    profile, occupancy = _profile(frames)
    bass, bass_fraction = stable_bass(bass_track, start, end)
    if not np.any(profile):
        return HarmonyEvent(start, end, "N", "unknown", None, None, (), bass, (), 0.0, ("有効な音名を検出できません",))
    quiet_occupancy = (frames >= 0.12).mean(axis=0)
    basic, extended = _choices(profile, occupancy, quiet_occupancy, bass)
    choices = sorted(
        [choice for choice in basic + extended if choice.purity >= 0.55 and choice.score >= 0.66],
        key=lambda choice: -choice.score,
    )
    if not choices:
        return HarmonyEvent(start, end, "N", "unknown", None, None, (), bass, (), 0.0, ("和音を支持する音が不足しています",))
    best = choices[0]
    runner_up = choices[1].score if len(choices) > 1 else 0
    score = best.score
    evidence = [f"構成音に含まれるクロマの割合 {best.purity:.2f}"]
    if bass is not None:
        description = "分離ベース" if independent_bass else "低域の推定"
        evidence.append(f"{description} {bass} の区間占有率 {bass_fraction:.2f}")
    agreement = 1.0
    if mixture is not None:
        mix_profile, _ = _profile(_frames(mixture, *window, hop_limit=2))
        denominator = np.linalg.norm(profile) * np.linalg.norm(mix_profile)
        if denominator > 0:
            agreement = float(np.clip(np.dot(profile, mix_profile) / denominator, 0, 1))
            score *= 0.90 + 0.10 * agreement
            evidence.append(f"元音源とのクロマの一致度 {agreement:.2f}")
    # 長い区間に一時的な単音が混じっても、候補の構成音の持続を確認します。
    evidence.append(f"構成音の最小出現割合 {min(quiet_occupancy[i] for i in best.notes):.2f}（弱い音を含む）")
    together = float(np.mean(np.count_nonzero(frames[:, best.notes] >= 0.18, axis=1) >= 2))
    if arpeggio is None:
        evidence.append(f"構成音のうち2音以上が重なる割合 {together:.2f}")
    elif arpeggio.repeated:
        evidence.append("和音の構成音を順に弾く並びが繰り返されています")
    else:
        evidence.append("アルペジオに聞こえる音の並びです。単音メロディーの可能性を残します")
    names = tuple(choice.name for choice in choices[:3])
    confirmed = (
        best.supported and best.purity >= 0.74 and score >= 0.80
        and best.score - runner_up >= 0.030 and agreement >= 0.34
        and (arpeggio.repeated if arpeggio is not None else together >= 0.25)
    )
    if not confirmed:
        evidence.append("候補間の差または構成音の持続が十分ではありません")
        return HarmonyEvent(start, end, "N", "candidate", None, None, (), bass, names, score, tuple(evidence))
    root = PITCH_NAMES[best.root]
    notes = tuple(PITCH_NAMES[index] for index in best.notes)
    chord = best.name
    if bass is not None and bass != root:
        in_chord = bass in notes and bass_fraction >= (0.62 if independent_bass else 0.85)
        pedal = independent_bass and bass_fraction >= 0.87 and end - start >= 0.32 and best.purity >= 0.86
        if in_chord or pedal:
            chord += "/" + bass
    return HarmonyEvent(start, end, chord, "confirmed", root, best.quality, notes, bass, names, score, tuple(evidence))


def _join_continuations(events):
    joined = []
    for event in events:
        if joined:
            old = joined[-1]
            same = (old.chord, old.status) == (event.chord, event.status)
            same_choice = event.status != "candidate" or old.candidates == event.candidates
            if same and same_choice:
                old_duration = old.end_s - old.start_s
                new_duration = event.end_s - event.start_s
                score = (old.score * old_duration + event.score * new_duration) / (old_duration + new_duration)
                bass = old.bass if old.bass == event.bass else None
                evidence = old.evidence if old.evidence == event.evidence else old.evidence + ("同じ判定が続いた区間を統合",)
                # 同じ判定を何度も統合しても、同じ説明は一度だけ残します。
                joined[-1] = replace(old, end_s=event.end_s, score=score, bass=bass, evidence=tuple(dict.fromkeys(evidence)))
                continue
        joined.append(event)
    return joined


def _check_short_sevenths(events, bpm):
    """前後で同じ三和音が続く場合、短く加わった1音は経過音の可能性を残します。"""
    checked = list(events)
    for index, (before, event, after) in enumerate(zip(events, events[1:], events[2:]), start=1):
        if (
            before.status == event.status == after.status == "confirmed"
            and before.chord == after.chord and before.bass == event.bass == after.bass
            and len(before.notes) == 3 and len(event.notes) == 4
            and before.root == event.root and set(before.notes) < set(event.notes)
            and event.end_s - event.start_s < min(0.30, 30 / bpm)
        ):
            checked[index] = replace(
                event, chord="N", status="candidate", root=None, quality=None, notes=(),
                evidence=(*event.evidence, "前後で同じ三和音が続くため、短い追加音は経過音の可能性があります"),
            )
    return checked


def analyse_harmony(guitar, bass, sample_rate, bpm, *, mixture=None):
    """変化点で区切り、コード・ベース・候補をまとめます。

    guitar、bass、mixture は同じ時間軸を持つ1次元配列です。
    bass を省略した合奏では、mixture の低域から補助的にベース音を推定します。
    """
    guitar = _audio_vector(guitar, "ギター")
    if not np.isfinite(bpm) or not 20 <= bpm <= 400:
        raise ValueError("BPMは20〜400の範囲で指定してください")
    if bass is not None:
        bass = _audio_vector(bass, "ベース")
    if mixture is not None:
        mixture = _audio_vector(mixture, "元音源")
    if any(other is not None and len(other) != len(guitar) for other in (bass, mixture)):
        raise ValueError("ギター・ベース・元音源のサンプル数を揃えてください")
    guitar_evidence = guitar_note_evidence(guitar, sample_rate)
    mixture_evidence = None
    if mixture is not None and mixture is not guitar:
        mixture_evidence = guitar_note_evidence(mixture, sample_rate)
    if bass is not None:
        bass_track = analyse_bass(bass, sample_rate)
    elif mixture is not None:
        bass_track = analyse_bass(mixture, sample_rate, low_band=True)
    else:
        bass_track = None
    duration = len(guitar) / sample_rate
    arpeggios = [replace(span, end_s=min(span.end_s, duration)) for span in detect_arpeggios(guitar_evidence, bpm)]
    times = _change_times(guitar_evidence, bass_track, duration, bpm, arpeggios)
    events = [
        _event(
            guitar_evidence, bass_track, mixture_evidence, start, end, bass is not None,
            next((span for span in arpeggios if span.start_s <= (start + end) / 2 < span.end_s), None),
        )
        for start, end in zip(times, times[1:])
    ]
    return _join_continuations(_check_short_sevenths(events, bpm))
