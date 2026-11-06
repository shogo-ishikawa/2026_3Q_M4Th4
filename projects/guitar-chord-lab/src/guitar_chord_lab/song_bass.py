"""独立したベースの基音推定と、区間内での持続性の確認。"""

from dataclasses import dataclass
from math import gcd

import numpy as np
from scipy.fft import irfft, next_fast_len, rfft
from scipy.signal import butter, resample_poly, sosfiltfilt

from .chords import PITCH_NAMES


@dataclass(frozen=True)
class BassTrack:
    """フレームごとの音名クラスと、周期性に基づく内部スコア。"""

    times_s: np.ndarray
    pitch_classes: np.ndarray  # 基音を特定できないフレームは -1
    strength: np.ndarray


def _period_at_dip(frame, minimum_lag, maximum_lag):
    """正規化した差分が最初に小さくなる周期を選びます。"""
    n_fft = next_fast_len(2 * len(frame) - 1)
    spectrum = rfft(frame, n=n_fft)
    correlation = irfft(np.abs(spectrum) ** 2, n=n_fft)[:maximum_lag + 1]
    lags = np.arange(maximum_lag + 1)
    square = np.r_[0.0, np.cumsum(frame ** 2)]
    difference = np.maximum(0, square[len(frame) - lags] + square[-1] - square[lags] - 2 * correlation)
    normalised = np.ones(len(lags))
    sums = np.cumsum(difference[1:])
    np.divide(difference[1:] * lags[1:], sums, out=normalised[1:], where=sums > 1e-20)
    candidates = np.flatnonzero(normalised[minimum_lag:maximum_lag + 1] < 0.22)
    if not len(candidates):
        return None, 0.0
    lag = int(minimum_lag + candidates[0])
    while lag < maximum_lag and normalised[lag + 1] < normalised[lag]:
        lag += 1
    period = float(lag)
    if 0 < lag < maximum_lag:
        left, mid, right = normalised[lag - 1:lag + 2]
        curvature = left - 2 * mid + right
        if curvature > 1e-10:
            period += float(np.clip(0.5 * (left - right) / curvature, -0.5, 0.5))
    return period, float(np.clip(1 - normalised[lag], 0, 1))


def analyse_bass(samples, sample_rate, *, hop_s=0.02, low_band=False):
    """低音域を調べ、周期的な波形から基音を推定します。

    分離したベースを渡すと約30〜330 Hzを調べます。合奏しかない場合は
    low_band=True で上限を下げ、低音以外の混入を減らします。
    """
    rate = min(sample_rate, 6000)
    divisor = gcd(sample_rate, rate)
    values = np.asarray(samples, dtype=np.float64)
    if sample_rate != rate:
        values = resample_poly(values, rate // divisor, sample_rate // divisor)
    if len(values) < 30:
        return BassTrack(np.empty(0), np.empty(0, dtype=int), np.empty(0))
    upper = 155.0 if low_band else 330.0
    sos = butter(3, [26, 300 if low_band else 660], btype="bandpass", fs=rate, output="sos")
    values = sosfiltfilt(sos, values)
    hop = max(1, round(hop_s * rate))
    centres = np.arange(0, len(values), hop)
    size = max(1, round(0.14 * rate))
    minimum_lag = max(2, int(rate / upper))
    maximum_lag = int(np.ceil(rate / 30.0))
    padded = np.pad(values, (size // 2, size - size // 2))
    notes = np.full(len(centres), -1, dtype=int)
    strength = np.zeros(len(centres))
    silence = max(1e-5, float(np.max(np.abs(values))) * 0.018)
    for i, centre in enumerate(centres):
        frame = padded[centre:centre + size]
        if np.sqrt(np.mean(frame ** 2)) < silence:
            continue
        period, certainty = _period_at_dip(frame, minimum_lag, maximum_lag)
        if period is None:
            continue
        midi = 69 + 12 * np.log2(rate / period / 440)
        if abs(midi - round(midi)) <= 0.42:
            notes[i] = round(midi) % 12
            strength[i] = certainty
    return BassTrack(centres / rate, notes, strength)


def stable_bass(track, start_s, end_s):
    """区間に十分長く現れる音を返します。2番目の値は占有率です。"""
    if track is None:
        return None, 0.0
    frames = (track.times_s >= start_s) & (track.times_s < end_s)
    notes = track.pitch_classes[frames]
    valid = (notes >= 0) & (track.strength[frames] >= 0.78)
    if not np.any(valid) or end_s - start_s < 0.12:
        return None, 0.0
    counts = np.bincount(notes[valid], minlength=12)
    pitch_class = int(np.argmax(counts))
    fraction = float(counts[pitch_class] / len(notes))
    return (PITCH_NAMES[pitch_class], fraction) if fraction >= 0.62 else (None, fraction)
