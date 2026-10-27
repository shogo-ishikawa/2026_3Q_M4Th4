"""テストで共通に使う、簡単な音を作る関数です。"""

import numpy as np
import pytest

from guitar_chord_lab.chords import PITCH_NAMES, chord_notes

SAMPLE_RATE = 22050


def sine_chord(label, duration_s, sample_rate=SAMPLE_RATE, amplitude=0.2):
    """コードの構成音を正弦波（倍音なし）で同時に鳴らした音を作ります。"""
    t = np.arange(int(round(duration_s * sample_rate))) / sample_rate
    samples = np.zeros_like(t)
    for note in chord_notes(label):
        midi = 60 + PITCH_NAMES.index(note)  # C4〜B4 の音域
        frequency = 440.0 * 2 ** ((midi - 69) / 12)
        samples += amplitude * np.sin(2 * np.pi * frequency * t)
    return samples


def silence(duration_s, sample_rate=SAMPLE_RATE):
    """無音を作ります。"""
    return np.zeros(int(round(duration_s * sample_rate)))


@pytest.fixture
def sample_rate():
    return SAMPLE_RATE
