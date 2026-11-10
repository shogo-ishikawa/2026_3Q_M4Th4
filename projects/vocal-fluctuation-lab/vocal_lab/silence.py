"""歌声の前後を整え、指定した場合だけ途中の長い無音も取り除きます。"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import math

import numpy as np

from .audio import AudioInputError

METHOD_ID = "rms-silence-v1"
RMS_FRAME_SECONDS = 0.02


@dataclass(frozen=True)
class SilenceConfig:
    trim_edges: bool = True
    remove_internal: bool = False
    threshold_db: float = -40.0
    min_silence_seconds: float = 0.5
    padding_seconds: float = 0.05


def normalise_silence_config(config=None):
    """Notebook、CLI、比較DBで同じ前処理条件を使います。"""
    if config is None:
        config = SilenceConfig()
    elif isinstance(config, dict):
        try:
            config = SilenceConfig(**config)
        except TypeError as error:
            raise AudioInputError("無音処理の設定名を確認してください。") from error
    if not isinstance(config, SilenceConfig):
        raise AudioInputError("無音処理にはSilenceConfigまたは設定の辞書を指定してください。")
    if type(config.trim_edges) is not bool or type(config.remove_internal) is not bool:
        raise AudioInputError("無音処理のオン・オフにはTrueまたはFalseを指定してください。")
    numbers = {}
    for name in ("threshold_db", "min_silence_seconds", "padding_seconds"):
        value = getattr(config, name)
        if isinstance(value, bool):
            raise AudioInputError("無音処理のしきい値と秒数には数値を指定してください。")
        try:
            numbers[name] = float(value)
        except (TypeError, ValueError) as error:
            raise AudioInputError("無音処理のしきい値と秒数には数値を指定してください。") from error
        if not math.isfinite(numbers[name]):
            raise AudioInputError("無音処理のしきい値と秒数には有限の数値を指定してください。")
    if not -120 <= numbers["threshold_db"] <= 0:
        raise AudioInputError("無音のしきい値は最大RMSに対して−120〜0 dBで指定してください。")
    if not 0 <= numbers["min_silence_seconds"] <= 600 or not 0 <= numbers["padding_seconds"] <= 10:
        raise AudioInputError("無音の最小長は0〜600秒、前後に残す余白は0〜10秒にしてください。")
    return SilenceConfig(config.trim_edges, config.remove_internal, **numbers)


def preprocessing_signature(config=None):
    """音源ごとの切り出し位置を含めず、処理方針だけを識別します。"""
    settings = asdict(normalise_silence_config(config))
    value = {"method_id": METHOD_ID, "settings": settings, "rms_frame_seconds": RMS_FRAME_SECONDS}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]


def combined_analysis_signature(base_signature, config=None):
    """既存の解析条件に前処理を加え、比較DBでも設定の違いを区別します。"""
    return json.dumps({"analysis_signature": base_signature,
                       "preprocessing_signature": preprocessing_signature(config),
                       "preprocessing_method_id": METHOD_ID}, sort_keys=True, separators=(",", ":"))


def _frame_rms(audio, frame_samples):
    """逆位相でも打ち消さず、20msごとにチャンネルの二乗を平均します。"""
    frames = math.ceil(len(audio) / frame_samples)
    rms = np.empty(frames, dtype=np.float64)
    # 一曲全体を二乗した巨大な配列を作らず、10秒程度ずつ計算します。
    for first in range(0, frames, 500):
        last = min(frames, first + 500)
        block = audio[first * frame_samples:min(len(audio), last * frame_samples)]
        complete = len(block) // frame_samples
        if complete:
            shaped = block[:complete * frame_samples].reshape(complete, frame_samples, -1)
            rms[first:first + complete] = np.sqrt(np.mean(shaped * shaped, axis=(1, 2)))
        if complete < last - first:
            tail = block[complete * frame_samples:]
            rms[last - 1] = math.sqrt(float(np.mean(tail * tail)))
    return rms


def process_silence(samples, sr, config=None):
    """前処理後の配列と、元の時刻へ戻せる区間表を返します。

    デフォルトでは冒頭と末尾だけを整え、途中の休符や間奏は残します。
    内部無音の削除は時間軸を詰める操作です。クロスフェードは加えません。
    """
    config = normalise_silence_config(config)
    if np.iscomplexobj(samples):
        raise AudioInputError("音源には実数の配列を指定してください。")
    if isinstance(sr, bool):
        raise AudioInputError("サンプリング周波数には100〜1000000 Hzの数値を指定してください。")
    try:
        rate = float(sr)
        audio = np.asarray(samples, dtype=np.float64)
    except (TypeError, ValueError) as error:
        raise AudioInputError("音源とサンプリング周波数には数値を指定してください。") from error
    if not math.isfinite(rate) or not 100 <= rate <= 1e6:
        raise AudioInputError("実数の音源と100〜1000000 Hzのサンプリング周波数を指定してください。")
    if audio.ndim not in (1, 2) or len(audio) < 2 or (audio.ndim == 2 and not 1 <= audio.shape[1] <= 8):
        raise AudioInputError("音源はサンプル数×チャンネル数の配列で指定してください。")
    if not np.isfinite(audio).all() or np.max(np.abs(audio)) > 1e100:
        raise AudioInputError("音源にNaN、無限大、極端に大きな数は使えません。")
    frame_samples = max(1, round(RMS_FRAME_SECONDS * rate))
    rms = _frame_rms(audio, frame_samples)
    peak = float(np.max(rms))
    if peak <= 0:
        raise AudioInputError("抽出した歌声音源がすべて無音です。別の区間を選ぶか、歌声の抽出結果を確認してください。")
    threshold = peak * 10 ** (config.threshold_db / 20)
    active = (rms >= threshold) & (rms > 0)
    indices = np.flatnonzero(active)
    if len(indices) == 0:
        raise AudioInputError("しきい値を超える歌声がありません。無音処理のしきい値を下げてください。")
    length = len(audio)
    padding = round(config.padding_seconds * rate)
    first_active = int(indices[0]) * frame_samples
    last_active = min(length, (int(indices[-1]) + 1) * frame_samples)
    start = max(0, first_active - padding) if config.trim_edges else 0
    end = min(length, last_active + padding) if config.trim_edges else length
    removed = []
    if config.remove_internal:
        # 音がある区間の間に挟まれた、十分に長い無音だけを詰めます。
        quiet = np.flatnonzero(~active)
        groups = np.split(quiet, np.flatnonzero(np.diff(quiet) != 1) + 1)
        minimum = math.ceil(config.min_silence_seconds * rate)
        for group in groups:
            if len(group) == 0:
                continue
            gap_start = int(group[0]) * frame_samples
            gap_end = min(length, (int(group[-1]) + 1) * frame_samples)
            if gap_start < first_active or gap_end > last_active or gap_end - gap_start < minimum:
                continue
            cut_start, cut_end = max(start, gap_start + padding), min(end, gap_end - padding)
            if cut_start < cut_end:
                removed.append((cut_start, cut_end))
    segments = []
    cursor = start
    for cut_start, cut_end in removed:
        if cursor < cut_start:
            segments.append((cursor, cut_start))
        cursor = cut_end
    if cursor < end:
        segments.append((cursor, end))
    processed = np.concatenate([audio[left:right] for left, right in segments], axis=0)
    report = {"method_id": METHOD_ID, "settings": asdict(config),
              "rms_frame_seconds": frame_samples / rate,
              "input_duration_seconds": length / rate,
              "output_duration_seconds": len(processed) / rate,
              "leading_removed_seconds": start / rate,
              "trailing_removed_seconds": (length - end) / rate,
              "internal_removed_seconds": sum(right - left for left, right in removed) / rate,
              "kept_segments_seconds": [[left / rate, right / rate] for left, right in segments],
              "timeline_modified": bool(removed), "peak_rms": peak, "threshold_rms": threshold}
    return processed, report
