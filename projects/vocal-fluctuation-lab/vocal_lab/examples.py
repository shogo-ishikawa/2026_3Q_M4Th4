"""再生成できる合成データ。実在の歌手の音源ではありません。"""

import numpy as np


def make_envelope(kind="pink", duration_seconds=120, sampling_rate=100, seed=22):
    """白・ピンク・ブラウンの正の音量列を作ります。"""
    exponents = {"white": 0.0, "pink": 1.0, "brown": 2.0}
    if kind not in exponents:
        raise ValueError("white / pink / brown を指定してください。")
    if not 10 <= duration_seconds <= 180 or sampling_rate != 100:
        raise ValueError("合成例は10–180秒、毎秒100点で作ります。")
    count = round(duration_seconds * sampling_rate)
    rng = np.random.default_rng(seed)
    frequency = np.fft.rfftfreq(count, 1 / sampling_rate)
    coefficient = rng.normal(size=frequency.size) + 1j * rng.normal(size=frequency.size)
    coefficient[0] = 0
    coefficient[1:] *= frequency[1:] ** (-exponents[kind] / 2)
    noise = np.fft.irfft(coefficient, n=count)
    noise /= np.std(noise)
    return 2.0 + 0.15 * noise


def demo_result(kind="pink"):
    from .analysis import analyse_envelope

    result = analyse_envelope(make_envelope(kind), 100)
    result["metadata"] = {
        "source_kind": "synthetic_control",
        "synthetic_kind": kind,
        "seed": 22,
        "separation_method": "synthetic-envelope",
        "description": "音量列を直接生成した確認用データです。歌声の抽出結果ではありません。",
    }
    return result
