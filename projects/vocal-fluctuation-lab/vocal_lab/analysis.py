"""RMS 振幅包絡の時間変動を調べます。音色の周波数傾斜とは異なる量です。"""
from dataclasses import asdict, dataclass, replace
from fractions import Fraction
import hashlib
import json
import math
from numbers import Real

import numpy as np
from scipy import signal


METHOD_ID = "rms-welch-v2"
QUALITY_METHOD_ID = "four-block-welch-v2"
SCHEMA_VERSION = "vocal-fluctuation-result-v1"
ENVELOPE_RATE = 200.0
ENVELOPE_PASS_HZ = 20.0
ENVELOPE_STOP_HZ = 40.0
ENVELOPE_METHOD = "power-polyphase-fir-sqrt-v1"


def _positive_number(value, name):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        raise ValueError(f"{name} は有限の正の数で指定してください。")
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} は有限の正の数で指定してください。")
    return value


@dataclass(frozen=True)
class AnalysisConfig:
    low_hz: float = 0.02
    high_hz: float = 20.0
    segment_seconds: float = 120.0
    auto_band: bool = True

    def __post_init__(self):
        if not isinstance(self.auto_band, bool):
            raise ValueError("帯域の自動調整にはTrueまたはFalseを指定してください。")
        for name in ("low_hz", "high_hz", "segment_seconds"):
            value = getattr(self, name)
            object.__setattr__(self, name, _positive_number(value, name))
        if not 1e-6 <= self.low_hz < self.high_hz <= ENVELOPE_PASS_HZ:
            raise ValueError("解析周波数は0.000001〜20 Hz内で下限より上限を大きくしてください。")
        if not 2 <= self.segment_seconds <= 3600:
            raise ValueError("Welch の区間長は2〜3600秒にしてください。")


def _config(config):
    if config is None:
        return AnalysisConfig()
    if not isinstance(config, AnalysisConfig):
        raise ValueError("config には AnalysisConfig を指定してください。")
    return config


def analysis_signature(config, low_hz, high_hz, segment_seconds=None, envelope_rate=ENVELOPE_RATE):
    """解析と品質確認の方法を識別し、DB作成時にも同じ条件を使います。"""
    config = _config(config)
    low_hz = _positive_number(low_hz, "解析帯域の下限")
    high_hz = _positive_number(high_hz, "解析帯域の上限")
    conditions = {"method_id": METHOD_ID, "quality_method_id": QUALITY_METHOD_ID,
                  "config": asdict(config), "band_low_hz": round(low_hz, 8),
                  "band_high_hz": round(high_hz, 8),
                  "welch_segment_seconds": round(config.segment_seconds if segment_seconds is None else segment_seconds, 8),
                  "envelope_rate_hz": float(envelope_rate), "envelope_method": ENVELOPE_METHOD}
    encoded = json.dumps(conditions, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()[:24]


def analysis_request_signature(config=None):
    """再取得の省略に使う設定識別子です。DB比較には実効帯域の署名を使います。"""
    value = {"method_id": METHOD_ID, "quality_method_id": QUALITY_METHOD_ID,
             "envelope_method": ENVELOPE_METHOD, "config": asdict(_config(config))}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]


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


def _analyse_one(envelope, envelope_rate, duration, config, offset=0.0):
    mean = float(np.mean(envelope))
    spread = float(np.std(envelope))
    cv = spread / mean if mean > 0 else 0.0
    near_zero_fraction = float(np.mean(envelope <= max(mean * 0.001, 1e-12)))
    variable = mean > 1e-10 and cv > 1e-4
    # 長曲では四等分した各ブロックに平均用の窓を残します。
    desired = max(round(20 * envelope_rate), len(envelope) // 8) if config.auto_band else round(config.segment_seconds * envelope_rate)
    segment_length = max(2, min(len(envelope), max(2, len(envelope) // 4),
                                round(config.segment_seconds * envelope_rate), desired))
    actual_segment = segment_length / envelope_rate
    low = max(config.low_hz, 3 / actual_segment, 10 / duration)
    high = min(config.high_hz, ENVELOPE_PASS_HZ, envelope_rate / 5)
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
        # 全体を常に4等分し、長い曲ほど最大値−最小値が増える偏りを避けます。
        # 各区間内でもWelch法を使います。4区間の重なりはありませんが、
        # 統計的な独立性を仮定した検定や信頼区間ではありません。
        for block in np.array_split(envelope, 4):
            if len(block) < 8 or np.std(block) <= mean * 1e-5:
                continue
            block_length = min(segment_length, len(block))
            block_f, block_p = signal.welch(
                block, fs=envelope_rate, window="hann", nperseg=block_length,
                noverlap=block_length // 2, detrend="constant", scaling="density", average="mean",
            )
            bf, bp = _log_bins(block_f, block_p, low, high)
            if len(bf) >= 12:
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
            summary = f"{low:.3g}〜{high:g} Hzの範囲では、強弱のゆらぎが1/fに近い傾向です。"
        elif distance > 0.3:
            status = "not_near"
            summary = f"{low:.3g}〜{high:g} Hzの範囲では、1/fに近い傾きではありません。"
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
    signature = analysis_signature(config, low, high, actual_segment, envelope_rate)
    return {
        "schema_version": SCHEMA_VERSION, "method_id": METHOD_ID,
        "analysis_signature": signature, "status": status, "summary": summary,
        "duration_seconds": float(duration), "envelope_sample_rate_hz": float(envelope_rate),
        "config": asdict(config),
        "quality": {
            "method_id": QUALITY_METHOD_ID,
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


def _analyse(envelope, envelope_rate, duration, config, offset=0.0):
    result = _analyse_one(envelope, envelope_rate, duration, config, offset)
    fit = result["fit"]
    low, high = fit["band_low_hz"], fit["band_high_hz"]
    result["band_selection"] = {
        "mode": "auto" if config.auto_band else "fixed",
        "requested_low_hz": config.low_hz, "requested_high_hz": config.high_hz,
        "actual_low_hz": low, "actual_high_hz": high,
        "welch_segment_seconds": fit["segment_seconds"],
        "period_min_seconds": 1 / high, "period_max_seconds": 1 / low,
        "reason": "無音調整後の長さとWelch窓の分解能から下限を決めます。傾きが−1に近くなる帯域を探してはいません。" if config.auto_band else
                  "共通の設定で比較します。短い入力では、分解能に応じて実際の帯域と窓を制限します。",
    }
    names = ("fit", "quality", "status", "summary", "features")
    result["band_sensitivity"] = [dict({"label": "主解析"}, **{name: result[name] for name in names})]
    if low < min(5.0, high) < high:
        limited = _analyse_one(envelope, envelope_rate, duration, replace(config, high_hz=5.0), offset)
        result["band_sensitivity"].append(dict({"label": "5 Hzまでの比較"}, **{name: limited[name] for name in names}))
    return result


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


def extract_envelope(samples, sr):
    """二乗波形を低域通過し、20 Hzまで扱うRMS包絡と処理条件を返します。"""
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
    ratio = Fraction(ENVELOPE_RATE / sr).limit_denominator(1_000_000)
    rate = sr * ratio.numerator / ratio.denominator
    # 間引き前の低域通過で、声の速い振動の折り返しを防ぎます。
    power = signal.resample_poly(squared, ratio.numerator, ratio.denominator,
                                 window=("kaiser", 8.6), padtype="reflect")
    count, beta = signal.kaiserord(60, (ENVELOPE_STOP_HZ - ENVELOPE_PASS_HZ) / (rate / 2))
    count |= 1
    taps = signal.firwin(count, (ENVELOPE_PASS_HZ + ENVELOPE_STOP_HZ) / 2,
                         window=("kaiser", beta), fs=rate)
    half = count // 2
    power = np.convolve(np.pad(power, (half, half), mode="reflect"), taps, mode="valid")
    negative_fraction = float(np.mean(power < 0))
    envelope = np.sqrt(np.maximum(power, 0))
    details = {"method_id": ENVELOPE_METHOD, "sample_rate_hz": rate,
               "passband_high_hz": ENVELOPE_PASS_HZ, "stopband_low_hz": ENVELOPE_STOP_HZ,
               "fir_taps": count, "fir_kaiser_beta": beta, "attenuation_design_db": 60,
               "resample_kaiser_beta": 8.6, "edge_extension": "reflect",
               "negative_power_handling": "clip-to-zero-before-square-root",
               "negative_power_fraction": negative_fraction}
    return envelope, rate, details


def analyse_samples(samples, sr, config=None):
    """チャンネルごとのエネルギーから包絡を求め、共通の帯域解析へ渡します。"""
    config = _config(config)
    envelope, rate, details = extract_envelope(samples, sr)
    result = _analyse(envelope, rate, len(samples) / float(sr), config)
    result["envelope_processing"] = details
    return result
