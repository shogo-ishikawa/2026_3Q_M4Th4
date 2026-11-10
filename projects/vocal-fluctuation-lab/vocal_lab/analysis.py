"""RMS 振幅包絡の時間変動を調べます。音色の周波数傾斜とは異なる量です。"""
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from numbers import Real

import numpy as np
from scipy import signal


METHOD_ID = "rms-welch-v1"
SCHEMA_VERSION = "vocal-fluctuation-result-v1"


def _positive_number(value, name):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        raise ValueError(f"{name} は有限の正の数で指定してください。")
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} は有限の正の数で指定してください。")
    return value


@dataclass(frozen=True)
class AnalysisConfig:
    low_hz: float = 0.2
    high_hz: float = 5.0
    window_seconds: float = 0.05
    hop_seconds: float = 0.01
    segment_seconds: float = 20.0

    def __post_init__(self):
        for name, value in asdict(self).items():
            object.__setattr__(self, name, _positive_number(value, name))
        if not 1e-6 <= self.low_hz < self.high_hz <= 1e4:
            raise ValueError("解析周波数は0.000001〜10000 Hz内で下限より上限を大きくしてください。")
        if self.hop_seconds > self.window_seconds:
            raise ValueError("RMS の計算間隔は窓の長さ以下にしてください。")
        if not 1e-5 <= self.window_seconds <= 0.25 or not 1e-5 <= self.hop_seconds <= 0.1:
            raise ValueError("RMS の窓は0.00001〜0.25秒、計算間隔は0.00001〜0.1秒にしてください。")
        if not 2 <= self.segment_seconds <= 3600:
            raise ValueError("Welch の区間長は2〜3600秒にしてください。")


def _config(config):
    if config is None:
        return AnalysisConfig()
    if not isinstance(config, AnalysisConfig):
        raise ValueError("config には AnalysisConfig を指定してください。")
    return config


def _vector(values, name):
    if np.iscomplexobj(values):
        raise ValueError(f"{name} には実数を指定してください。")
    try:
        result = np.asarray(values, dtype=np.float64)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} は数値の配列で指定してください。") from error
    if result.ndim != 1 or result.size < 2:
        raise ValueError(f"{name} は2点以上の一次元配列で指定してください。")
    if not np.all(np.isfinite(result)) or np.max(np.abs(result)) > 1e100:
        raise ValueError(f"{name} に NaN、無限大、極端に大きな数は使えません。")
    return result


def _log_bins(frequency, power, low, high, count=24):
    """対数周波数の各区間を等しく扱い、高周波の点数による偏りを減らします。"""
    edges = np.geomspace(low, high, count + 1)
    output_f, output_p = [], []
    for index, (left, right) in enumerate(zip(edges[:-1], edges[1:])):
        selected = (frequency >= left) & (frequency < right)
        if index == count - 1:
            selected = (frequency >= left) & (frequency <= right)
        selected &= np.isfinite(power) & (power > 0)
        if np.any(selected):
            output_f.append(float(np.exp(np.mean(np.log(frequency[selected])))))
            output_p.append(float(np.exp(np.mean(np.log(power[selected])))))
    return np.asarray(output_f), np.asarray(output_p)


def _fit(frequency, power):
    x, y = np.log10(frequency), np.log10(power)
    slope, intercept = np.polyfit(x, y, 1)
    residual = float(np.sum((y - (slope * x + intercept)) ** 2))
    total = float(np.sum((y - np.mean(y)) ** 2))
    r_squared = max(0.0, min(1.0, 1 - residual / total)) if total > 1e-20 else 0.0
    return float(slope), float(intercept), r_squared


def _band_power(frequency, power, left, right):
    selected = (frequency > left) & (frequency < right)
    points = np.concatenate(([left], frequency[selected], [right]))
    values = np.interp(points, frequency, power)
    integrate = getattr(np, "trapezoid", None) or np.trapz
    return float(integrate(values, points))


def _analyse(envelope, envelope_rate, duration, config, offset=0.0):
    mean = float(np.mean(envelope))
    spread = float(np.std(envelope))
    cv = spread / mean if mean > 0 else 0.0
    near_zero_fraction = float(np.mean(envelope <= max(mean * 0.001, 1e-12)))
    variable = mean > 1e-10 and cv > 1e-4
    segment_length = min(len(envelope), max(2, round(min(config.segment_seconds, duration / 4) * envelope_rate)))
    actual_segment = segment_length / envelope_rate
    low = max(config.low_hz, 3 / actual_segment, 10 / duration)
    high = min(config.high_hz, envelope_rate / 5)
    reasons = []
    if duration < 60:
        reasons.append("60秒未満のため、1/fに近いかどうかの判定は保留します。")
    if not variable:
        reasons.append("十分な強弱の変動がありません。無音や一定の音では評価できません。")
    if near_zero_fraction > 0.8:
        reasons.append("ほぼ無音の時間が80%を超えています。歌声のある区間を選び直してください。")

    frequency = np.asarray([], dtype=float)
    power = np.asarray([], dtype=float)
    bin_f = np.asarray([], dtype=float)
    bin_p = np.asarray([], dtype=float)
    slope = intercept = r_squared = distance = None
    block_slopes = []
    segments = 0
    if len(envelope) >= 8 and high > low and variable:
        frequency, power = signal.welch(
            envelope, fs=envelope_rate, window="hann", nperseg=segment_length,
            noverlap=segment_length // 2, detrend="constant", scaling="density", average="mean",
        )
        frequency, power = frequency[1:], power[1:]
        segments = 1 + (len(envelope) - segment_length) // (segment_length - segment_length // 2)
        bin_f, bin_p = _log_bins(frequency, power, low, high)
        if len(bin_f) >= 3:
            slope, intercept, r_squared = _fit(bin_f, bin_p)
            distance = abs(slope + 1)
        # 区間ごとの傾きは、選ぶ時間による変動です。信頼区間ではありません。
        # Welch の重複窓を独立な標本として数えず、ここでは重ならない窓を使います。
        for start in range(0, len(envelope) - segment_length + 1, segment_length):
            block_f, block_p = signal.periodogram(
                envelope[start:start + segment_length], fs=envelope_rate,
                window="hann", detrend="constant", scaling="density",
            )
            bf, bp = _log_bins(block_f, block_p, low, high)
            if len(bf) >= 12 and np.std(envelope[start:start + segment_length]) > mean * 1e-5:
                block_slopes.append(_fit(bf, bp)[0])

    log_span = math.log10(high / low) if high > low else 0.0
    if len(bin_f) < 12 or log_span < 1 or segments < 4:
        reasons.append("周波数範囲かデータ点が不足しています。より長い区間で解析してください。")
    block_spread = float(max(block_slopes) - min(block_slopes)) if len(block_slopes) >= 2 else None
    if len(block_slopes) < 3:
        reasons.append("時間を分けた比較に使える区間が3個未満です。")
    elif block_spread > 0.8:
        reasons.append("時間を分けると傾きが大きく変わります。区間を変えて確かめてください。")

    fundamental_ok = duration >= 60 and variable and near_zero_fraction <= 0.8 and len(bin_f) >= 12 and log_span >= 1 and segments >= 4 and len(block_slopes) >= 3
    stable = block_spread is not None and block_spread <= 0.8
    status = "inconclusive"
    summary = "判定保留：解析する区間や条件を見直してください。"
    if fundamental_ok and stable and slope is not None:
        if distance <= 0.3 and r_squared >= 0.75:
            status = "near"
            summary = "この区間と設定では、強弱のゆらぎが1/fに近い傾向です。"
        elif distance > 0.3:
            status = "not_near"
            summary = "この区間と設定では、1/fに近い傾きではありません。"
        else:
            reasons.append("傾きは−1に近いものの、直線への近似が弱いため判定を保留します。")

    low_fraction = flatness = None
    selected = (frequency >= low) & (frequency <= high) & (power > 0)
    if np.count_nonzero(selected) >= 3:
        middle = math.sqrt(low * high)
        total_power = _band_power(frequency, power, low, high)
        if total_power > 0:
            low_fraction = _band_power(frequency, power, low, middle) / total_power
        band_values = power[selected]
        flatness = float(np.exp(np.mean(np.log(band_values))) / np.mean(band_values))
    signature_data = {"method_id": METHOD_ID, "config": asdict(config), "band_low_hz": round(low, 8), "band_high_hz": round(high, 8)}
    signature = hashlib.sha256(json.dumps(signature_data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]
    return {
        "schema_version": SCHEMA_VERSION, "method_id": METHOD_ID,
        "analysis_signature": signature, "status": status, "summary": summary,
        "duration_seconds": float(duration), "envelope_sample_rate_hz": float(envelope_rate),
        "config": asdict(config),
        "quality": {
            "usable_for_comparison": bool(fundamental_ok and stable), "reasons": reasons,
            "duration_ok": duration >= 60, "variable_envelope": bool(variable),
            "near_zero_fraction": near_zero_fraction, "fit_bins": len(bin_f),
            "log_span_decades": log_span, "welch_segments": int(segments),
            "independent_blocks": len(block_slopes), "block_slopes": block_slopes,
            "block_slope_spread": block_spread,
        },
        "fit": {"slope": slope, "intercept": intercept, "r_squared": r_squared,
                "distance_to_pink": distance, "band_low_hz": low, "band_high_hz": high,
                "segment_seconds": actual_segment, "bin_count": len(bin_f)},
        "series": {"time_seconds": (np.arange(len(envelope)) / envelope_rate + offset).tolist(), "envelope": envelope.tolist()},
        "spectrum": {"frequency_hz": frequency.tolist(), "power": power.tolist(),
                     "bin_frequency_hz": bin_f.tolist(), "bin_power": bin_p.tolist()},
        "features": {"slope": slope, "envelope_cv": cv, "low_band_fraction": low_fraction, "spectral_flatness": flatness},
    }


def analyse_envelope(envelope, fs, config=None):
    """既に計算された非負の包絡を解析します。合成データの確認にも使えます。"""
    config = _config(config)
    fs = _positive_number(fs, "包絡のサンプリング周波数")
    if not 1 <= fs <= 1e6:
        raise ValueError("包絡のサンプリング周波数は1〜1000000 Hzにしてください。")
    envelope = _vector(envelope, "包絡")
    if np.any(envelope < 0):
        raise ValueError("RMS 包絡には負の値を指定できません。")
    return _analyse(envelope, fs, len(envelope) / fs, config)


def analyse_samples(samples, sr, config=None):
    """音声の RMS 包絡を求めます。ステレオは各チャンネルの二乗を平均します。"""
    config = _config(config)
    sr = _positive_number(sr, "音声のサンプリング周波数")
    if not 100 <= sr <= 1e6:
        raise ValueError("音声のサンプリング周波数は100〜1000000 Hzにしてください。")
    if np.iscomplexobj(samples):
        raise ValueError("音声には実数を指定してください。")
    try:
        audio = np.asarray(samples, dtype=np.float64)
    except (ValueError, TypeError) as error:
        raise ValueError("音声は数値の配列で指定してください。") from error
    if audio.ndim not in (1, 2) or len(audio) < 2 or (audio.ndim == 2 and not 1 <= audio.shape[1] <= 8):
        raise ValueError("音声はサンプル数×チャンネル数の配列で指定してください。")
    if not np.all(np.isfinite(audio)) or np.max(np.abs(audio)) > 1e100:
        raise ValueError("音声に NaN、無限大、極端に大きな数は使えません。")
    audio = audio - np.mean(audio, axis=0)
    squared = np.mean(audio * audio, axis=1) if audio.ndim == 2 else audio * audio
    window = max(1, round(config.window_seconds * sr))
    hop = max(1, round(config.hop_seconds * sr))
    if window > len(audio):
        envelope = np.asarray([math.sqrt(float(np.mean(squared)))])
    else:
        starts = np.arange(0, len(audio) - window + 1, hop)
        cumulative = np.concatenate(([0.0], np.cumsum(squared, dtype=np.float64)))
        envelope = np.sqrt(np.maximum(0, (cumulative[starts + window] - cumulative[starts]) / window))
    return _analyse(envelope, sr / hop, len(audio) / sr, config, min(window, len(audio)) / (2 * sr))
