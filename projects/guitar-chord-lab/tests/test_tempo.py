"""音源の時刻と、既知の打音の間隔からBPM推定を確かめます。"""

import json
from dataclasses import asdict

import numpy as np
import pytest

from guitar_chord_lab.tempo import estimate_tempo

RATE = 11025


def percussion(beats, duration_s, *, rate=RATE, meter=None, hat_delay=None, fade=0.0):
    """キックとスネア風の音を交互に置き、必要なら裏拍のハイハットを重ねます。"""
    audio = np.zeros(round(duration_s * rate), dtype=np.float32)
    time = np.arange(round(0.12 * rate)) / rate
    rng = np.random.default_rng(7)

    def add(when, pulse):
        start = round(when * rate)
        count = min(len(pulse), len(audio) - start)
        if count > 0:
            audio[start:start + count] += 0.22 * pulse[:count]

    for i, when in enumerate(beats):
        if i % 2:
            pulse = (0.15 * np.sin(2 * np.pi * 155 * time) + 0.60 * rng.normal(size=len(time))) * np.exp(-65 * time)
        else:
            pulse = np.sin(2 * np.pi * 75 * time) * np.exp(-36 * time)
        if meter and i % meter == 0:
            pulse += 2 * np.sin(2 * np.pi * 65 * time) * np.exp(-50 * time)
        add(when, pulse)
        if hat_delay is not None and i < len(beats) - 1:
            add(when + hat_delay, 0.25 * np.sin(2 * np.pi * 3400 * time) * np.exp(-110 * time))
    audio *= np.exp(-np.arange(len(audio)) / rate * fade)
    return audio


@pytest.mark.parametrize("bpm,rate,hat_delay", [(120, 22050, None), (145, RATE, None), (90, RATE, 1 / 3)])
def test_global_and_six_local_tempos_keep_the_pulse(bpm, rate, hat_delay):
    beats = np.arange(0.53, 17, 60 / bpm)
    report = estimate_tempo(percussion(beats, 18, rate=rate, hat_delay=hat_delay), rate)

    assert report.bpm == pytest.approx(bpm, abs=1)
    assert report.median_bpm == pytest.approx(bpm, abs=1)
    assert len(report.local_bpm) == 6
    assert report.local_bpm[0].start_s == report.start_s
    assert report.local_bpm[-1].end_s == pytest.approx(report.end_s)
    assert not report.variable_tempo
    assert report.start_s == pytest.approx(beats[0], abs=0.03)
    assert report.beats_s == pytest.approx(tuple(beats), abs=0.045)
    assert report.global_median_difference == pytest.approx(report.bpm - report.median_bpm, abs=0.01)
    assert json.loads(json.dumps(asdict(report), allow_nan=False))["bpm"] == report.bpm


def test_variable_tempo_uses_local_intervals_for_the_beat_times():
    beats = np.r_[np.arange(0.3, 12, 0.5), np.arange(12.3, 24, 2 / 3)]
    report = estimate_tempo(percussion(beats, 25), RATE)

    assert report.variable_tempo
    assert report.local_bpm[0].bpm == pytest.approx(120, abs=2)
    assert report.local_bpm[-1].bpm == pytest.approx(90, abs=2)
    assert report.local_spread_bpm > 25
    intervals = np.diff(report.beats_s)
    assert np.median(intervals[:10]) == pytest.approx(0.5, abs=0.03)
    assert np.median(intervals[-10:]) == pytest.approx(2 / 3, abs=0.03)


def test_bounds_keep_activity_after_a_break_and_during_a_fade():
    beats = np.r_[np.arange(0.5, 4, 0.5), np.arange(9, 17, 0.5)]
    report = estimate_tempo(percussion(beats, 18, fade=0.30), RATE)

    assert report.start_s == pytest.approx(0.5, abs=0.03)
    assert beats[-1] + 0.03 < report.end_s < 16.75
    assert report.bpm == pytest.approx(120, abs=2)
    assert any(window.bpm is None for window in report.local_bpm)
    assert report.median_bpm == pytest.approx(120, abs=2)
    assert report.meter is None


@pytest.mark.parametrize("meter", [3, 4])
def test_repeated_accents_produce_a_meter_hint(meter):
    beats = np.arange(0.3, 23, 0.5)
    report = estimate_tempo(percussion(beats, 24, meter=meter), RATE)

    assert report.bpm == pytest.approx(120, abs=2)
    assert report.meter == meter


@pytest.mark.parametrize("has_tone", [False, True])
def test_silence_and_a_sustained_tone_do_not_invent_a_tempo(has_tone):
    time = np.arange(7 * RATE) / RATE
    audio = 0.3 * np.sin(2 * np.pi * 440 * time) if has_tone else np.zeros_like(time)
    report = estimate_tempo(audio, RATE)

    assert report.bpm is None
    assert report.median_bpm is None
    assert report.beats_s == ()
    assert report.score == 0
    assert report.meter is None


def test_retry_keeps_source_time_and_reports_changed_analysis():
    beats = np.arange(0.75, 20, 2 / 3)
    report = estimate_tempo(percussion(beats, 22, hat_delay=1 / 3), RATE, retry=True)

    assert report.bpm == pytest.approx(90, abs=2)
    assert report.beats_s[0] == pytest.approx(0.75, abs=0.04)
    assert any("低・中域" in note for note in report.notes)


def test_quiet_tonal_intro_and_tail_are_preserved():
    audio = percussion(np.arange(1.2, 8, 0.5), 9)
    time = np.arange(len(audio)) / RATE
    quiet = (time < 1.2) | (time > 8)
    audio[quiet] += 0.0004 * np.sin(2 * np.pi * 221 * time[quiet])
    report = estimate_tempo(audio, RATE)

    assert report.start_s == pytest.approx(0, abs=0.03)
    assert report.end_s == pytest.approx(9, abs=0.03)


def test_stationary_background_is_removed_only_from_the_ends():
    rng = np.random.default_rng(1)
    audio = percussion(np.r_[np.arange(2, 5, 0.5), np.arange(7, 10, 0.5)], 12)
    audio += rng.normal(0, 0.0005, len(audio))
    report = estimate_tempo(audio, RATE)

    assert report.start_s == pytest.approx(2, abs=0.04)
    assert report.end_s == pytest.approx(9.62, abs=0.06)


def test_short_audio_does_not_repeat_one_window_six_times():
    report = estimate_tempo(np.zeros(RATE), RATE)

    assert len(report.local_bpm) == 1
    assert report.bpm is None
