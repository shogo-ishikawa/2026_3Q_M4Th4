"""音量の推移と帯域別オンセットから、曲の範囲・テンポ・拍位置を推定します。"""

from dataclasses import dataclass
from math import gcd

import numpy as np
from scipy import fft, signal

LOCAL_SCORE_MINIMUM = 0.23


@dataclass(frozen=True)
class TempoWindow:
    """部分解析の範囲と推定値。時刻は元音源の先頭を0秒とします。"""

    start_s: float
    end_s: float
    bpm: float | None
    score: float


@dataclass(frozen=True)
class TempoReport:
    """推定結果。scoreは周期性を表す内部スコアです。"""

    start_s: float
    end_s: float
    bpm: float | None
    beats_s: tuple[float, ...]
    local_bpm: tuple[TempoWindow, ...]
    median_bpm: float | None
    meter: int | None
    score: float
    variable_tempo: bool
    global_median_difference: float | None
    notes: tuple[str, ...]
    local_spread_bpm: float | None = None
    octave_ambiguous: bool = False


def _block_rms(samples: np.ndarray, block_size: int) -> np.ndarray:
    padding = (-len(samples)) % block_size
    blocks = np.pad(samples, (0, padding)).reshape(-1, block_size)
    return np.sqrt(np.mean(blocks * blocks, axis=1))


def _song_bounds(samples: np.ndarray, rate: int) -> tuple[int, int]:
    """曲の両端にある静かな区間を見つけ、内側の休止は残します。"""
    size = max(1, round(0.02 * rate))
    levels = _block_rms(samples, size)
    peak = max(float(np.percentile(levels, 95)), 0.10 * float(levels.max()))
    if peak <= 1e-6:
        return 0, len(samples)

    # 両端は別々に調べます。微小なフェードを残しつつ、定常的な背景音を基準にします。
    edge_size = min(12, max(1, len(levels) // 8))
    minimum = max(1e-6, peak * 10 ** (-76 / 20))
    bounds = []
    edge_samples = edge_size * size
    for ordered, waveform in ((levels, samples[:edge_samples]), (levels[::-1], samples[-edge_samples:])):
        edge = ordered[:edge_size]
        noise = float(np.median(edge))
        stationary = np.percentile(edge, 90) < 1.4 * max(noise, 1e-6)
        floor = minimum
        if stationary and noise < 0.05 * peak:
            # 音量が小さく一定でも、特定の周波数に集中している音はイントロや余韻として残します。
            spectrum = np.abs(fft.rfft(waveform * signal.windows.hann(len(waveform)))) ** 2
            if spectrum.max() <= 0.08 * spectrum.sum():
                floor = max(minimum, 2.5 * noise)
        active = ordered > floor
        # 60 ms以内に二度以上活動がある場所を境界にし、単発のクリックを避けます。
        if len(active) >= 3:
            support = np.convolve(active, np.ones(3, dtype=int), mode="same")
            positions = np.flatnonzero(active & (support >= 2))
        else:
            positions = np.flatnonzero(active)
        bounds.append(int(positions[0]) if positions.size else 0)

    start = bounds[0] * size
    end = min(len(samples), (len(levels) - bounds[1]) * size)
    return (start, end) if start < end else (0, len(samples))


def _onset_bands(samples: np.ndarray, rate: int) -> tuple[np.ndarray, float]:
    """低・中・高域のスペクトル強度の立ち上がりを約10 msごとに計算します。"""
    target_rate = min(11025, rate)
    if target_rate != rate:
        divisor = gcd(target_rate, rate)
        samples = signal.resample_poly(samples, target_rate // divisor, rate // divisor)
    hop = max(1, round(target_rate * 0.01))
    frame_size = 512
    # 窓の後半に立ち上がりが入った時点を取り、拍の時刻は後で窓中心にそろえます。
    padded = np.pad(samples, (frame_size // 2, frame_size // 2))
    frames = np.lib.stride_tricks.sliding_window_view(padded, frame_size)[::hop]
    frequencies = fft.rfftfreq(frame_size, 1 / target_rate)
    bands = [(40, 180), (180, 1800), (1800, target_rate / 2 + 1)]
    masks = [(frequencies >= low) & (frequencies < high) for low, high in bands]
    envelope = np.zeros((len(frames), len(bands) + 1), dtype=np.float32)
    window = signal.windows.hann(frame_size).astype(np.float32)
    # 数分の音源でも、大きいスペクトログラムを一度に作らないようにします。
    for start in range(0, len(frames), 1024):
        end = min(start + 1024, len(frames))
        frame = frames[start:end] * window
        spectrum = np.abs(fft.rfft(frame, axis=1)) ** 2
        for column, mask in enumerate(masks):
            if mask.any():
                envelope[start:end, column] = np.sqrt(spectrum[:, mask].mean(axis=1))
        envelope[start:end, -1] = np.sqrt(np.mean(frame * frame, axis=1))

    scales = np.percentile(envelope, 98, axis=0)
    # 音量の小さい打楽器も拾い、元々エネルギーのない帯域は増幅しません。
    scales = np.maximum(scales, np.maximum(0.006 * envelope.max(axis=0), 1e-6))
    compressed = np.log1p(10 * envelope / scales)
    onsets = np.maximum(np.diff(compressed, axis=0, prepend=compressed[:1]), 0)
    return onsets, hop / target_rate


def _onset_strength(onsets: np.ndarray, retry: bool) -> tuple[np.ndarray, np.ndarray]:
    """全帯域と低・中域の二つのオンセット列を作ります。"""
    scale = np.maximum(np.percentile(onsets, 98, axis=0), 1e-5)
    scale = np.maximum(scale, onsets.max(axis=0) * 0.14)
    bands = np.minimum(onsets / scale, 4)
    weight = [1.0, 0.72, 0.25, 0.55] if retry else [0.9, 0.9, 0.50, 0.65]
    total = bands @ weight
    low_mid = bands[:, :2] @ [1.0, 0.9]
    return total, low_mid


def _autocorrelation(values: np.ndarray, max_lag: int) -> np.ndarray:
    """時差ごとに、実際に重なる部分のエネルギーで相関を正規化します。"""
    values = np.asarray(values, dtype=float)
    values = values - np.mean(values)
    if np.max(np.abs(values)) < 1e-7:
        return np.zeros(max_lag + 1)
    acf = signal.correlate(values, values, mode="full", method="fft")
    acf = acf[len(values) - 1 : len(values) + max_lag]
    prefix = np.r_[0.0, np.cumsum(values * values)]
    lags = np.arange(max_lag + 1)
    energy = np.sqrt(np.maximum(0, prefix[len(values) - lags] * (prefix[-1] - prefix[lags])))
    return np.divide(acf, energy, out=np.zeros_like(acf), where=energy > 1e-10)


def _periodicity(
    total: np.ndarray, low_mid: np.ndarray, step_s: float
) -> tuple[float | None, float, bool]:
    """周期性を比較し、BPMと内部スコア、倍・半テンポの曖昧さを返します。"""
    low_lag = round(60 / 230 / step_s)
    high_lag = min(round(60 / 40 / step_s), len(total) // 3)
    if high_lag <= low_lag or np.max(total, initial=0.0) < 0.15:
        return None, 0.0, False
    # 3回以上現れるリズムに限り、開始・終了の音だけでテンポを決めることを防ぎます。
    hits, _ = signal.find_peaks(total, distance=0.14 / step_s, prominence=max(total) * 0.12)
    if len(hits) < 4:
        return None, 0.0, False
    accented_hits, _ = signal.find_peaks(
        low_mid, distance=0.14 / step_s, prominence=0.20 * max(low_mid)
    )
    intervals = np.diff(hits)
    accented_intervals = np.diff(accented_hits)
    max_lag = min(high_lag * 2, len(total) // 2)
    full = _autocorrelation(total, max_lag)
    bass_and_drums = _autocorrelation(low_mid, max_lag)
    acf = 0.68 * full + 0.32 * bass_and_drums
    if not np.any(bass_and_drums):
        acf = full
    peaks, _ = signal.find_peaks(acf[: high_lag + 2])
    peaks = peaks[(peaks >= low_lag) & (peaks <= high_lag)]
    peaks = peaks[acf[peaks] >= 0.19]
    if not len(peaks):
        return None, 0.0, False

    def interval_support(distances: np.ndarray, lag: int) -> float:
        return float(np.mean(np.abs(distances - lag) <= max(2, 0.13 * lag))) if distances.size else 0.0

    def ranking(lag: int) -> float:
        score = float(acf[lag])
        if 2 * lag <= max_lag:
            score += 0.12 * max(0.0, acf[2 * lag])
        # 強い打音同士の間隔も使い、二拍・三拍分の周期の方が強く出る場合に備えます。
        score += 0.11 * interval_support(intervals, lag) + 0.22 * interval_support(accented_intervals, lag)
        # 半分の時差にも強いピークがある場合、二拍を一拍と読む候補を下げます。
        nearby_half = peaks[np.abs(peaks - lag / 2) <= max(2, lag * 0.045)]
        if len(nearby_half) and max(acf[nearby_half]) > 0.77 * acf[lag]:
            score -= 0.13
        bpm = 60 / (lag * step_s)
        return score + 0.018 * np.exp(-((bpm - 110) / 65) ** 2)

    lag = int(max(peaks, key=ranking))
    a, b, c = acf[lag - 1 : lag + 2]
    correction = 0.5 * (a - c) / (a - 2 * b + c) if a - 2 * b + c < -1e-8 else 0
    bpm = 60 / ((lag + float(np.clip(correction, -0.5, 0.5))) * step_s)
    octave = any(
        (abs(p / lag - 2) < 0.10 or abs(p / lag - 0.5) < 0.04) and acf[p] > 0.78 * acf[lag]
        for p in peaks if p != lag
    )
    return round(bpm, 2), float(np.clip(acf[lag], 0, 1)), bool(octave)


def _local_tempos(
    total: np.ndarray, low_mid: np.ndarray, step_s: float, start_s: float, end_s: float, retry: bool
) -> tuple[TempoWindow, ...]:
    duration = end_s - start_s
    width = min(duration, max(3.5, min(16 if retry else 12, duration / 3)))
    spread_s = max(0, duration - width)
    starts = np.linspace(0, spread_s, 6) if spread_s > step_s else (0.0,)
    results = []
    for position in starts:
        first = round(position / step_s)
        last = round((position + width) / step_s)
        chunk = total[first:last]
        # ブレイク中のごく小さな周期や、偶然そろった立ち上がりを採用しません。
        if len(chunk) and np.max(chunk) >= 0.10 * np.max(total):
            bpm, score, _ = _periodicity(chunk, low_mid[first:last], step_s)
        else:
            bpm, score = None, 0.0
        results.append(TempoWindow(float(start_s + position), float(start_s + position + width), bpm, score))
    return tuple(results)


def _track_beats(
    onset: np.ndarray, step_s: float, bpm: float, duration: float,
    local: tuple[TempoWindow, ...], start_s: float, variable: bool,
) -> np.ndarray:
    """観測された立ち上がりを使って拍の時刻を追跡します。"""
    peaks, _ = signal.find_peaks(onset, distance=max(1, round(0.16 / step_s)), prominence=0.12 * max(onset))
    if not peaks.size:
        return np.array([])
    # FFT窓が実際の打音より先に音を拾う分を補正します。
    times = peaks * step_s + 0.012
    centres = [(window.start_s + window.end_s) / 2 - start_s for window in local]
    tempos = [window.bpm for window in local]

    def period_at(time: float) -> float:
        tempo = np.interp(time, centres, tempos) if variable and centres else bpm
        return 60 / tempo

    # 始めの数拍で、後続の立ち上がりもよく説明する位相を選びます。
    period = period_at(times[0])
    head = times < times[0] + 6 * period
    candidates, weights = times[head], onset[peaks[head]]
    if not len(candidates):
        return np.array([])
    phase = candidates[:, None] - candidates[None, :]
    distances = np.abs(phase - period * np.round(phase / period))
    phase_score = np.exp(-0.5 * (distances / (period * 0.13)) ** 2) @ weights
    anchor = float(candidates[np.flatnonzero(phase_score >= 0.985 * max(phase_score))[0]])

    def advance(direction: int) -> list[float]:
        beats = []
        current = anchor
        while True:
            interval = period_at(current)
            target = current + direction * interval
            if target < -0.18 * interval or target >= duration + 0.18 * interval:
                break
            first = np.searchsorted(times, target - 0.23 * interval)
            last = np.searchsorted(times, target + 0.23 * interval, side="right")
            if first < last:
                nearby = times[first:last]
                closeness = np.exp(-0.5 * ((nearby - target) / (0.13 * interval)) ** 2)
                current = float(nearby[np.argmax(onset[peaks[first:last]] * closeness)])
            else:
                current = target
            if 0 <= current < duration:
                beats.append(current)
        return beats

    beats = np.array([*reversed(advance(-1)), anchor, *advance(1)])
    return beats[(beats >= 0) & (beats < duration)]


def _meter_hint(beats: np.ndarray, samples: np.ndarray, rate: int) -> int | None:
    """強拍の繰り返しが明瞭な場合だけ、三拍子か四拍子の候補を返します。"""
    if len(beats) < 12:
        return None
    frames = np.round(beats * rate).astype(int)
    before, after = max(1, round(0.03 * rate)), max(1, round(0.09 * rate))
    accents = []
    for index in frames:
        attack = samples[max(0, index - before) : index + after]
        accents.append(float(np.sqrt(np.mean(attack * attack))) if attack.size else 0.0)
    accents = np.array(accents)
    scores = {}
    for meter in (3, 4):
        bars = accents[: len(accents) // meter * meter].reshape(-1, meter)
        peaks = bars.max(axis=1)
        present = peaks > 0.005 * accents.max()
        if np.count_nonzero(present) < 4:
            continue
        # 小節内で比べて、フェードの音量低下そのものを拍子の証拠にしません。
        bars = bars[present] / peaks[present, None]
        phase_strength = bars.mean(axis=0)
        phase = int(np.argmax(phase_strength))
        ordered = np.sort(phase_strength)
        contrast = (ordered[-1] - ordered[-2]) / ordered[-1]
        second_peaks = np.sort(bars, axis=1)[:, -2]
        repeats = np.mean((np.argmax(bars, axis=1) == phase) & (second_peaks <= 0.75))
        if contrast >= 0.25 and repeats >= 0.70:
            scores[meter] = contrast * repeats
    if not scores:
        return None
    if len(scores) == 2 and abs(scores[3] - scores[4]) < 0.10:
        return None
    return max(scores, key=scores.get)


def estimate_tempo(samples: np.ndarray, sample_rate: int, *, retry: bool = False) -> TempoReport:
    """元音源の範囲・BPM・拍の候補を推定します。retryでは低中域を重視して再解析します。"""
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim != 1 or not samples.size or not np.all(np.isfinite(samples)):
        raise ValueError("テンポ解析には有限値の空でないモノラル音源を指定してください")
    if not isinstance(sample_rate, (int, np.integer)) or sample_rate < 1000:
        raise ValueError("サンプリング周波数は1000 Hz以上の整数を指定してください")
    start, end = _song_bounds(samples, sample_rate)
    start_s, end_s = float(start / sample_rate), float(end / sample_rate)
    onsets, step_s = _onset_bands(samples[start:end], sample_rate)
    total, low_mid = _onset_strength(onsets, retry)
    bpm, score, octave = _periodicity(total, low_mid, step_s)
    windows = _local_tempos(total, low_mid, step_s, start_s, end_s, retry)
    reliable = tuple(window for window in windows if window.bpm is not None and window.score >= LOCAL_SCORE_MINIMUM)
    local_bpms = [window.bpm for window in reliable]
    median = round(float(np.median(local_bpms)), 2) if local_bpms else None
    spread = round(float(max(local_bpms) - min(local_bpms)), 2) if local_bpms else None
    notes = []
    tolerance = max(5, 0.085 * median) if median is not None else 5
    tracking_windows = reliable
    # 全体と多数の部分が一致する場合、単独の倍・半テンポ候補だけを拍追跡から除きます。
    # 区間が続く実際のテンポ変化は追跡し、除いた推定値も確認画面には残します。
    if len(reliable) >= 4 and median is not None and (bpm is None or abs(bpm - median) <= tolerance):
        agreeing = sum(abs(value - median) <= tolerance for value in local_bpms)
        aliases = [
            window for window in reliable
            if abs(2 * window.bpm - median) <= 0.06 * median
            or abs(window.bpm / 2 - median) <= 0.06 * median
        ]
        if len(aliases) == 1 and agreeing > len(reliable) / 2:
            tracking_windows = tuple(window for window in reliable if window is not aliases[0])
            octave = True
            notes.append("他の区間と合わない倍・半テンポ候補が1区間あったため、その値を拍位置の推定から外しました。")
    tracked_bpms = [window.bpm for window in tracking_windows]
    variable = len(tracked_bpms) >= 3 and round(max(tracked_bpms) - min(tracked_bpms), 2) > tolerance
    if variable:
        notes.append("部分BPMに差があり、テンポ変化または倍・半テンポの可能性があります。拍位置は局所のテンポを使って推定しました。")
    if median is not None and any(abs(value - median) > 0.25 * median for value in local_bpms):
        notes.append("部分BPMに中央値から25%以上離れた値があります。該当区間を聴いて、外れ値かテンポの変化かを確認してください。")
    if octave:
        notes.append("倍・半テンポにも周期性があるため、拍の速さは聴いて確認してください。")
    if bpm is None:
        notes.append("全体で一貫した周期を推定できませんでした。部分BPMを確認し、必要なら手動でBPMを指定してください。")
    if len(reliable) < len(windows):
        notes.append("周期性の弱い部分区間は中央値から除きました。")
    if len(windows) < 6:
        notes.append("音源が短いため、部分解析の区間を分散できませんでした。")
    if retry:
        notes.append("再解析では低・中域の立ち上がりを重視し、長い曲では部分解析の窓を広げました。")
    difference = round(bpm - median, 2) if bpm is not None and median is not None else None
    if difference is not None and abs(difference) > max(4, 0.08 * median):
        notes.append("全体BPMと部分BPMの中央値に差があります。")
    beat_bpm = bpm if bpm is not None else median
    beats = (
        _track_beats(total, step_s, beat_bpm, end_s - start_s, tracking_windows, start_s, variable)
        if beat_bpm is not None else np.array([])
    )
    meter = _meter_hint(beats, samples[start:end], sample_rate)
    return TempoReport(
        start_s, end_s, bpm, tuple(round(float(beat + start_s), 6) for beat in beats), windows,
        median, meter, score, bool(variable), difference, tuple(notes), spread, octave,
    )
