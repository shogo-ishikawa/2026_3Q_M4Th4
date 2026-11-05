"""BPMを確認してから、伴奏ギターのコードと変化時刻を解析します。"""

import math
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from uuid import uuid4

import numpy as np

from .audio import AudioClip, load_audio, prepare_for_analysis, rms_db, to_mono
from .results import code_version, library_versions
from .separation import DEFAULT_MODEL, SeparationError, separate_stems
from .song_media import SongSourceError, normalise_youtube_url, open_song_source
from .song_results import assemble_song, beat_grid, beat_rows, load_song, save_song
from .tempo import TempoReport, estimate_tempo

ANALYSIS_RATE = 22050


class SongError(RuntimeError):
    """楽曲解析を続けられないときの、利用者向けメッセージ。"""


class SongCancelled(SongError):
    """利用者がBPM確認を中止した場合。"""


class NoBackingGuitar(SongError):
    """ギターステムに伴奏の手掛かりが足りない場合。"""

    def __init__(self, evidence):
        self.evidence = evidence
        super().__init__(
            "バッキングギターに相当する和音の手掛かりを検出できなかったため、コード解析を停止しました。"
            f" {evidence.reason}（ギター対混合音 {evidence.relative_db:.1f} dB、"
            f"複数音の区間 {evidence.polyphonic_s:.2f}秒）"
        )


@dataclass
class SongSession:
    clip: AudioClip
    source: str
    report: TempoReport


@dataclass(frozen=True)
class TempoChoice:
    bpm: float
    method: str  # estimated / manual


def prepare_song(source, *, youtube_allowed=False):
    """取得音源を読み込み、一時ファイルを閉じてからテンポを推定します。"""
    original = str(source)
    try:
        if "://" in original:
            label = normalise_youtube_url(original)
        else:
            label = Path(original).name
        with open_song_source(source, youtube_allowed=youtube_allowed) as path:
            clip = load_audio(path)
    except (SongSourceError, OSError, ValueError) as error:
        raise SongError(str(error)) from error
    if not np.isfinite(clip.samples).all():
        raise SongError("音源に読み取れないサンプル値が含まれています")
    clip.source_path = ""  # ダウンロード時の一時パスを解析結果に残さない
    report = estimate_tempo(to_mono(clip).samples[0], clip.sample_rate)
    if report.end_s <= report.start_s:
        raise SongError("解析できる楽曲区間を見つけられませんでした。音源を確認してください")
    return SongSession(clip, label, report)


def show_tempo(report, emit=print):
    """全体・局所・ばらつきと、信頼度の目安を表示します。"""
    def bpm_text(value):
        return f"{value:.2f}" if value is not None else "推定不能"

    emit(f"楽曲区間 {report.start_s:.2f}〜{report.end_s:.2f} 秒")
    emit(f"全体BPM {bpm_text(report.bpm)} ／ 局所BPMの中央値 {bpm_text(report.median_bpm)}")
    for window in report.local_bpm:
        emit(f"  {window.start_s:.2f}〜{window.end_s:.2f} 秒  {bpm_text(window.bpm)}  指標 {window.score:.2f}")
    difference = report.global_median_difference
    emit(f"全体と中央値の差 {bpm_text(difference)} ／ テンポの内部指標 {report.score:.2f}")
    meter = f"{report.meter}/4" if report.meter else "推定不能"
    emit(f"拍子の目安 {meter} ／ 小節表示は既定で4拍")
    if report.variable_tempo:
        emit("曲中でテンポが変化している可能性があります。推定値を採用するとビート位置を優先して表示します。")
    for note in report.notes:
        emit(note)


def confirm_bpm(session, *, read=input, emit=print):
    """推定値の採用、別設定での再推定、手入力のいずれかを選びます。"""
    show_tempo(session.report, emit)
    try:
        while True:
            answer = read("A 推定BPMを採用 / B 再解析 / C BPMを手入力 / Q 中止: ").strip().upper()
            if answer == "A" and session.report.bpm is not None:
                return TempoChoice(session.report.bpm, "estimated")
            if answer == "A":
                emit("BPMを推定できませんでした。Bで再解析するか、Cで入力してください。")
            elif answer == "B":
                session.report = estimate_tempo(to_mono(session.clip).samples[0], session.clip.sample_rate, retry=True)
                show_tempo(session.report, emit)
            elif answer == "C":
                try:
                    bpm = float(read("BPMを入力してください（20〜360、小数可）: "))
                except ValueError:
                    bpm = math.nan
                if 20 <= bpm <= 360:
                    return TempoChoice(bpm, "manual")
                emit("20〜360の有限な数値を入力してください。")
            elif answer == "Q":
                raise SongCancelled("BPM確認で解析を中止しました")
            else:
                emit("A、B、C、Qのいずれかを選んでください。")
    except EOFError as error:
        raise SongCancelled("BPMの確認入力を受け取れなかったため解析を中止しました") from error


@dataclass(frozen=True)
class BackingEvidence:
    present: bool
    rms_dbfs: float
    relative_db: float
    polyphonic_s: float
    repeated_arpeggio: bool
    reason: str


def detect_backing(guitar, mixture, rate):
    """ギターステムの音量、同時発音、短いアルペジオの反復から伴奏を推定します。"""
    from .song_harmony import find_arpeggios, guitar_note_evidence

    db = float(rms_db(guitar))
    relative = db - float(rms_db(mixture))
    if db < -55 or relative < -30:
        return BackingEvidence(False, db, relative, 0.0, False, "ギターステムの音量が判定基準を下回りました。")

    hop = 0.02
    notes = guitar_note_evidence(guitar, rate, hop_s=hop)
    audible = notes.rms >= max(0.001, 0.09 * float(np.quantile(notes.rms, 0.9)))
    simultaneous = audible & ((notes.strengths >= 0.18).sum(axis=1) >= 2)
    changes = np.flatnonzero(np.diff(np.r_[False, simultaneous, False]))
    durations = (changes[1::2] - changes[::2]) * hop
    polyphonic_s = float(durations[durations >= 0.08].sum())
    sustained = polyphonic_s >= max(0.24, 0.08 * int(audible.sum()) * hop)

    arpeggio = not sustained and bool(find_arpeggios(notes))
    present = sustained or arpeggio
    if sustained:
        reason = "ギターステムに複数の音が持続する区間があります。"
    elif arpeggio:
        reason = "ギターステムに複数の音を順に弾く短い反復があります。"
    else:
        reason = "ギター音はありますが、持続した複数音やアルペジオの反復が不足しています。"
    return BackingEvidence(present, db, relative, polyphonic_s, arpeggio, reason)


def crop_song(session):
    """元音源の時刻が追えるよう、サンプル単位で対象区間を切り出します。"""
    clip = session.clip
    start = max(0, round(session.report.start_s * clip.sample_rate))
    end = min(clip.samples.shape[-1], round(session.report.end_s * clip.sample_rate))
    if end - start < clip.sample_rate:
        raise SongError("楽曲の解析区間が1秒未満です。音源を確認してください")
    return AudioClip(clip.samples[:, start:end], clip.sample_rate, "", start / clip.sample_rate)


def separated_inputs(clip, device):
    """ギター・ベース・混合音を同じサンプル時刻で返します。"""
    try:
        result = separate_stems(clip, device=device)
    except SeparationError as error:
        mixture = prepare_for_analysis(clip, ANALYSIS_RATE).samples[0]
        details = {
            "status": "fallback", "reason": str(error), "harmony_input": "mixture",
            "harmony_note": "分離に失敗したため混合音から得た候補",
        }
        return mixture, None, mixture, details

    mixture = prepare_for_analysis(result.mixture, ANALYSIS_RATE).samples[0]
    guitar = prepare_for_analysis(result.stems["guitar"], ANALYSIS_RATE).samples[0]
    backing = detect_backing(guitar, mixture, ANALYSIS_RATE)
    if not backing.present:
        raise NoBackingGuitar(backing)
    bass_stem = result.stems.get("bass")
    bass = prepare_for_analysis(bass_stem, ANALYSIS_RATE).samples[0] if bass_stem is not None else None
    details = {
        "status": "separated", "model": DEFAULT_MODEL, "device": result.device,
        "seconds": round(result.seconds, 3), "backing": asdict(backing),
        "sources": sorted(result.stems), "reason": backing.reason,
        "harmony_input": "guitar", "harmony_note": None,
    }
    # ステムの合計が元の波形から大きく外れていないかを調べます。
    # この指標から各ステムの純度までは分かりません。
    residual = result.mixture.samples.copy()
    for stem in result.stems.values():
        residual -= stem.samples
    details["reconstruction_error_db"] = round(float(rms_db(residual) - rms_db(result.mixture.samples)), 3)
    drums = result.stems.get("drums")
    if drums is not None and rms_db(drums.samples) >= rms_db(result.mixture.samples) - 30:
        rhythm = estimate_tempo(to_mono(drums).samples[0], drums.sample_rate)
        details["drum_tempo"] = {"bpm": rhythm.bpm, "score": rhythm.score}
    if details["reconstruction_error_db"] > -6:
        details["harmony_input"] = "mixture"
        details["harmony_note"] = "ステムの合計と元音源との差が大きいため混合音から得た候補"
        return mixture, None, mixture, details
    if backing.relative_db < -24:
        # ギターが別ステムに漏れている可能性があります。歌声・打楽器・ベースを
        # 引いた混合音にも他の楽器が残るため、和音は候補として扱います。
        harmonic = result.mixture.samples.copy()
        removed = [name for name in ("vocals", "drums", "bass") if name in result.stems]
        for name in removed:
            harmonic -= result.stems[name].samples
        harmonic_clip = replace(result.mixture, samples=harmonic)
        details["harmony_input"] = "mixture_minus_stems"
        details["removed_stems"] = removed
        details["harmony_note"] = "ギターステムが弱いため、歌声・ドラム・ベースを除いた混合音から得た候補"
        return prepare_for_analysis(harmonic_clip, ANALYSIS_RATE).samples[0], bass, mixture, details
    return guitar, bass, mixture, details


def analyse_song(session, choice, *, device="auto", meter=None):
    """確認済みBPMを使い、分離、伴奏の判定、コード認識を順に行います。"""
    from .song_harmony import analyse_harmony

    if not isinstance(choice, TempoChoice) or not 20 <= choice.bpm <= 360 or choice.method not in {"estimated", "manual"}:
        raise SongError("BPM確認で推定値を採用するか、20〜360のBPMを入力してください")
    if device not in {"auto", "cpu", "cuda"}:
        raise SongError("分離装置は auto、cpu、cuda から選んでください")
    if meter is not None and (type(meter) is not int or not 2 <= meter <= 12):
        raise SongError("表示上の1小節の拍数は2〜12の整数を指定してください")

    clip = crop_song(session)
    harmonic_audio, bass, mixture, separation = separated_inputs(clip, device)
    reason = separation["harmony_note"]
    events = analyse_harmony(harmonic_audio, bass, ANALYSIS_RATE, choice.bpm, mixture=mixture)
    if reason:
        events = [
            replace(
                event, chord="N", status="candidate",
                candidates=tuple(dict.fromkeys((event.chord, *event.candidates)))[:3],
                evidence=(*event.evidence, reason),
            ) if event.status == "confirmed" else replace(event, evidence=(*event.evidence, reason))
            for event in events
        ]
    start, end = clip.offset_s, clip.offset_s + clip.duration_s
    grid, method = beat_grid(start, end, session.report.beats_s, choice.bpm, use_detected=choice.method == "estimated")
    metadata = {
        "schema_version": 1, "analysis_id": f"song-{uuid4().hex[:12]}",
        "source": session.source, "start_s": start, "end_s": end,
        "tempo": asdict(session.report), "accepted_bpm": choice.bpm, "bpm_choice": choice.method,
        "beat_grid_s": grid, "beat_grid_method": method, "beats_per_bar": 4 if meter is None else meter,
        "measure_origin": "先頭のビート位置を基準にした仮の小節番号",
        "target_resolution_s": 60 / choice.bpm / 4,
        "separation": separation, "software": library_versions(), "code": code_version(),
    }
    return assemble_song(metadata, events)
