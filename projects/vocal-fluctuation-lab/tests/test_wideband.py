"""包絡の20 Hzまでの応答と、長さ依存の解析帯域を合成音で検証します。"""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
from scipy import signal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab.analysis import AnalysisConfig, analyse_envelope, analyse_samples, extract_envelope


def coloured_envelope(slope, seconds=120, fs=200, seed=35, upper_slope=None):
    """30 Hz以下の、既知のPSD傾斜を持つ正の振幅包絡を作ります。"""
    rng = np.random.default_rng(seed)
    count = round(seconds * fs)
    frequency = np.fft.rfftfreq(count, 1 / fs)
    spectrum = rng.normal(size=len(frequency)) + 1j * rng.normal(size=len(frequency))
    selected = (frequency > 0) & (frequency <= 30)
    spectrum[~selected] = 0
    spectrum[selected] *= frequency[selected] ** (slope / 2)
    if upper_slope is not None:
        high = frequency > 5
        spectrum[high] *= (frequency[high] / 5) ** ((upper_slope - slope) / 2)
    noise = np.fft.irfft(spectrum, n=count)
    noise /= np.std(noise)
    envelope = 1 + 0.12 * noise
    if np.min(envelope) <= 0:
        raise AssertionError("合成包絡は正に保ち、クリップによるスペクトル変化を避けます。")
    return envelope


def sinusoid_amplitude(values, times, frequency):
    """端の0.5秒を除き、既知の変調周波数の振幅を最小二乗で求めます。"""
    chosen = (times >= 0.5) & (times <= times[-1] - 0.5)
    phase = 2 * np.pi * frequency * times[chosen]
    design = np.column_stack((np.ones(np.count_nonzero(chosen)), np.cos(phase), np.sin(phase)))
    coefficient = np.linalg.lstsq(design, values[chosen], rcond=None)[0]
    return float(np.hypot(coefficient[1], coefficient[2]))


class WidebandEnvelopeTests(unittest.TestCase):
    def test_one_to_twenty_hz_modulation_survives_multiple_rates_and_carriers(self):
        amplitude, depth = 0.3, 0.2
        for sample_rate in (8000, 44100):
            times = np.arange(4 * sample_rate) / sample_rate
            for carrier in (100, 440, 1000):
                for modulation in (1, 5, 10, 20):
                    with self.subTest(sr=sample_rate, carrier=carrier, modulation=modulation):
                        wave = amplitude * (1 + depth * np.cos(2 * np.pi * modulation * times))
                        wave *= np.sin(2 * np.pi * carrier * times)
                        envelope, rate, details = extract_envelope(wave, sample_rate)
                        envelope_times = np.arange(len(envelope)) / rate
                        measured = sinusoid_amplitude(envelope, envelope_times, modulation)
                        expected = amplitude * depth / np.sqrt(2)
                        self.assertAlmostEqual(measured / expected, 1, delta=0.05)
                        self.assertGreaterEqual(rate, 100)
                        self.assertIsInstance(details, dict)
                        json.dumps(details, allow_nan=False)

    def test_twenty_hz_is_preserved_where_the_old_fifty_ms_boxcar_erases_it(self):
        sample_rate, modulation, amplitude, depth = 8000, 20, 0.3, 0.2
        times = np.arange(4 * sample_rate) / sample_rate
        wave = amplitude * (1 + depth * np.cos(2 * np.pi * modulation * times))
        wave *= np.sin(2 * np.pi * 400 * times)
        window = round(0.05 * sample_rate)
        old_power = np.convolve(wave * wave, np.ones(window) / window, mode="valid")
        old = np.sqrt(np.maximum(old_power, 0))[::40]
        old_times = (np.arange(len(old)) * 40 + (window - 1) / 2) / sample_rate
        new, rate, _ = extract_envelope(wave, sample_rate)
        expected = amplitude * depth / np.sqrt(2)
        self.assertLess(sinusoid_amplitude(old, old_times, modulation) / expected, 0.01)
        self.assertGreater(sinusoid_amplitude(new, np.arange(len(new)) / rate, modulation) / expected, 0.95)

    def test_silence_and_burst_boundaries_remain_finite_and_nonnegative(self):
        sample_rate = 8000
        times = np.arange(4 * sample_rate) / sample_rate
        burst = np.zeros_like(times)
        active = (times >= 1) & (times < 2)
        burst[active] = 0.3 * np.sin(2 * np.pi * 440 * times[active])
        for wave in (np.zeros_like(times), burst):
            with self.subTest(silent=not np.any(wave)):
                before = wave.copy()
                envelope, rate, details = extract_envelope(wave, sample_rate)
                self.assertTrue(np.all(np.isfinite(envelope)))
                self.assertTrue(np.all(envelope >= 0))
                self.assertLessEqual(np.max(envelope), 0.5)
                self.assertAlmostEqual(len(envelope) / rate, len(wave) / sample_rate, delta=0.02)
                json.dumps(details, allow_nan=False)
                np.testing.assert_array_equal(wave, before)
                if not np.any(wave):
                    np.testing.assert_array_equal(envelope, np.zeros_like(envelope))

    def test_antiphase_stereo_preserves_the_same_energy_envelope_as_mono(self):
        sample_rate = 8000
        times = np.arange(4 * sample_rate) / sample_rate
        wave = 0.3 * (1 + 0.2 * np.cos(2 * np.pi * 10 * times)) * np.sin(2 * np.pi * 440 * times)
        mono, rate, _ = extract_envelope(wave, sample_rate)
        stereo, stereo_rate, _ = extract_envelope(np.column_stack((wave, -wave)), sample_rate)
        self.assertEqual(stereo_rate, rate)
        np.testing.assert_allclose(stereo, mono, rtol=1e-12, atol=1e-12)
        self.assertGreater(np.mean(stereo), 0.2)

    def test_known_white_pink_and_brown_slopes_survive_the_audio_path(self):
        sample_rate, seconds, envelope_rate = 8000, 120, 200
        times = np.arange(seconds * sample_rate) / sample_rate
        config = AnalysisConfig(low_hz=0.2, high_hz=20, segment_seconds=20, auto_band=False)
        for slope, expected_status in ((0, "not_near"), (-1, "near"), (-2, "not_near")):
            with self.subTest(slope=slope):
                original = coloured_envelope(slope, seconds, envelope_rate)
                amplitude = np.interp(times, np.arange(len(original)) / envelope_rate, original)
                wave = 0.2 * amplitude * np.sin(2 * np.pi * 440 * times)
                result = analyse_samples(wave, sample_rate, config)
                self.assertAlmostEqual(result["fit"]["slope"], slope, delta=0.25)
                self.assertEqual(result["status"], expected_status)
                self.assertEqual(result["fit"]["band_high_hz"], 20)


class AutomaticBandTests(unittest.TestCase):
    def test_duration_changes_resolution_and_lower_band_without_selecting_for_slope(self):
        for seconds, expected_segment, expected_low in ((60, 15, 0.2), (90, 20, 0.15),
                                                         (300, 37.5, 0.08), (600, 75, 0.04)):
            for slope in (0, -1, -2):
                with self.subTest(seconds=seconds, slope=slope):
                    result = analyse_envelope(coloured_envelope(slope, seconds), 200)
                    self.assertAlmostEqual(result["fit"]["segment_seconds"], expected_segment, places=6)
                    self.assertAlmostEqual(result["fit"]["band_low_hz"], expected_low, places=6)
                    self.assertEqual(result["fit"]["band_high_hz"], 20)

    def test_long_track_stability_blocks_each_keep_at_least_three_welch_windows(self):
        for seconds in (300, 600):
            with self.subTest(seconds=seconds):
                envelope = coloured_envelope(-1, seconds)
                with patch("vocal_lab.analysis.signal.welch", wraps=signal.welch) as welch:
                    result = analyse_envelope(envelope, 200)
                calls = [call for call in welch.call_args_list if len(call.args[0]) <= len(envelope) // 4 + 1]
                self.assertGreaterEqual(len(calls), 4)
                for call in calls:
                    length = len(call.args[0])
                    segment = call.kwargs["nperseg"]
                    overlap = call.kwargs["noverlap"]
                    self.assertGreaterEqual(1 + (length - segment) // (segment - overlap), 3)
                self.assertEqual(result["quality"]["independent_blocks"], 4)

    def test_manual_band_is_fixed_and_a_changed_high_band_changes_the_signature(self):
        envelope = coloured_envelope(-1)
        wide = analyse_envelope(envelope, 200, AnalysisConfig(low_hz=0.2, high_hz=20, segment_seconds=20, auto_band=False))
        narrow = analyse_envelope(envelope, 200, AnalysisConfig(low_hz=0.2, high_hz=5, segment_seconds=20, auto_band=False))
        self.assertEqual(wide["fit"]["segment_seconds"], 20)
        self.assertEqual(wide["fit"]["band_low_hz"], 0.2)
        self.assertEqual(narrow["fit"]["band_low_hz"], 0.2)
        self.assertNotEqual(wide["analysis_signature"], narrow["analysis_signature"])

    def test_five_hz_sensitivity_uses_same_lower_band_and_reveals_high_frequency_change(self):
        result = analyse_envelope(coloured_envelope(-1, seconds=300, upper_slope=-4), 200)
        comparison = next(row for row in result["band_sensitivity"] if row["fit"]["band_high_hz"] == 5)
        self.assertEqual(comparison["fit"]["band_low_hz"], result["fit"]["band_low_hz"])
        self.assertAlmostEqual(comparison["fit"]["slope"], -1, delta=0.2)
        self.assertLess(result["fit"]["slope"], comparison["fit"]["slope"] - 0.2)
        for row in result["band_sensitivity"]:
            self.assertIsInstance(row["quality"], dict)
            self.assertIn(row["status"], {"near", "not_near", "inconclusive"})
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
