"""音色の傾きとの取り違えと、不十分なデータの断定を防ぐ確認です。"""
from dataclasses import asdict
import json
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab.analysis import AnalysisConfig, analyse_envelope, analyse_samples


def coloured_envelope(beta, seconds=120, fs=100, seed=22):
    rng = np.random.default_rng(seed)
    length = round(seconds * fs)
    frequency = np.fft.rfftfreq(length, d=1 / fs)
    spectrum = rng.normal(size=len(frequency)) + 1j * rng.normal(size=len(frequency))
    spectrum[0] = 0
    spectrum[1:] *= frequency[1:] ** (-beta / 2)
    noise = np.fft.irfft(spectrum, n=length)
    noise /= np.std(noise)
    return 1 + 0.15 * noise


class AnalysisTests(unittest.TestCase):
    def test_white_control_is_flat_not_pink(self):
        result = analyse_envelope(coloured_envelope(0), 100)
        self.assertAlmostEqual(result["fit"]["slope"], 0, delta=0.15)
        self.assertEqual(result["status"], "not_near")

    def test_pink_control_is_near_minus_one(self):
        result = analyse_envelope(coloured_envelope(1), 100)
        self.assertAlmostEqual(result["fit"]["slope"], -1, delta=0.15)
        self.assertEqual(result["status"], "near")
        self.assertGreater(result["fit"]["r_squared"], 0.9)

    def test_brown_control_is_steeper_than_pink(self):
        result = analyse_envelope(coloured_envelope(2), 100)
        self.assertAlmostEqual(result["fit"]["slope"], -2, delta=0.15)
        self.assertEqual(result["status"], "not_near")

    def test_amplitude_modulated_audio_preserves_slow_pink_slope(self):
        sr = 8000
        source = coloured_envelope(1)
        time = np.arange(sr * 120) / sr
        envelope = np.interp(time, np.arange(len(source)) / 100, source)
        audio = 0.2 * envelope * np.sin(2 * np.pi * 400 * time)
        result = analyse_samples(audio, sr)
        self.assertAlmostEqual(result["fit"]["slope"], -1, delta=0.2)
        self.assertEqual(result["status"], "near")
        self.assertEqual(result["duration_seconds"], 120)

    def test_antiphase_stereo_combines_energy_without_cancelling(self):
        sr = 8000
        time = np.arange(sr * 2) / sr
        tone = 0.2 * np.sin(2 * np.pi * 440 * time)
        result = analyse_samples(np.column_stack((tone, -tone)), sr)
        self.assertGreater(np.mean(result["series"]["envelope"]), 0.1)
        self.assertEqual(result["status"], "inconclusive")

    def test_constant_tone_has_no_temporal_loudness_fluctuation(self):
        sr = 8000
        time = np.arange(sr * 90) / sr
        result = analyse_samples(0.2 * np.sin(2 * np.pi * 440 * time), sr)
        self.assertEqual(result["status"], "inconclusive")
        self.assertFalse(result["quality"]["variable_envelope"])
        self.assertIsNone(result["fit"]["slope"])

    def test_constant_and_silent_inputs_do_not_become_pink(self):
        for value in (0, 0.2):
            with self.subTest(value=value):
                result = analyse_samples(np.full(8000 * 60, value), 8000)
                self.assertEqual(result["status"], "inconclusive")
                self.assertFalse(result["quality"]["usable_for_comparison"])
                json.dumps(result, allow_nan=False)

    def test_short_pink_input_is_reported_without_a_decisive_label(self):
        result = analyse_envelope(coloured_envelope(1, seconds=30), 100)
        self.assertEqual(result["status"], "inconclusive")
        self.assertFalse(result["quality"]["duration_ok"])
        self.assertIsNotNone(result["fit"]["slope"])

    def test_two_sample_audio_returns_serialisable_inconclusive_result(self):
        result = analyse_samples([0, 0.1], 16000)
        self.assertEqual(result["status"], "inconclusive")
        self.assertLessEqual(result["series"]["time_seconds"][0], result["duration_seconds"])
        json.dumps(result, allow_nan=False)

    def test_periodic_envelopes_are_not_called_one_over_f(self):
        time = np.arange(12000) / 100
        for frequency in (0.5, 1, 2):
            with self.subTest(frequency=frequency):
                result = analyse_envelope(1 + 0.2 * np.sin(2 * np.pi * frequency * time), 100)
                self.assertNotEqual(result["status"], "near")

    def test_envelope_spectrum_uses_modulation_frequency_not_audio_pitch(self):
        sr = 8000
        time = np.arange(sr * 80) / sr
        audio = (1 + 0.2 * np.sin(2 * np.pi * time)) * np.sin(2 * np.pi * 1000 * time)
        result = analyse_samples(audio, sr)
        spectrum = result["spectrum"]
        peak = spectrum["frequency_hz"][int(np.argmax(spectrum["power"]))]
        self.assertAlmostEqual(peak, 1, delta=0.1)
        self.assertLess(max(spectrum["frequency_hz"]), 100)

    def test_silence_is_not_deleted_or_concatenated(self):
        envelope = coloured_envelope(1)
        envelope[3000:4500] = 0
        result = analyse_envelope(envelope, 100)
        self.assertEqual(len(result["series"]["time_seconds"]), len(envelope))
        np.testing.assert_allclose(np.diff(result["series"]["time_seconds"]), 0.01)
        self.assertEqual(result["series"]["envelope"][3500], 0)

    def test_mostly_silent_input_cannot_be_used_for_comparison(self):
        envelope = np.zeros(12000)
        envelope[:1000] = coloured_envelope(1, seconds=10)
        result = analyse_envelope(envelope, 100)
        self.assertGreater(result["quality"]["near_zero_fraction"], 0.8)
        self.assertFalse(result["quality"]["usable_for_comparison"])
        self.assertEqual(result["status"], "inconclusive")

    def test_scale_changes_cv_or_slope_neither(self):
        envelope = coloured_envelope(1)
        first = analyse_envelope(envelope, 100)
        second = analyse_envelope(envelope * 0.01, 100)
        self.assertAlmostEqual(first["features"]["envelope_cv"], second["features"]["envelope_cv"], places=10)
        self.assertAlmostEqual(first["fit"]["slope"], second["fit"]["slope"], places=10)
        self.assertEqual(first["analysis_signature"], second["analysis_signature"])

    def test_narrow_frequency_range_is_inconclusive(self):
        config = AnalysisConfig(low_hz=1, high_hz=3)
        result = analyse_envelope(coloured_envelope(1), 100, config)
        self.assertEqual(result["status"], "inconclusive")
        self.assertFalse(result["quality"]["usable_for_comparison"])

    def test_actual_lower_band_respects_observed_duration_and_segment_resolution(self):
        result = analyse_envelope(coloured_envelope(1, seconds=30), 100, AnalysisConfig(low_hz=0.001))
        low = result["fit"]["band_low_hz"]
        self.assertGreaterEqual(low, 10 / 30)
        self.assertGreaterEqual(low, 3 / result["fit"]["segment_seconds"])

    def test_signature_changes_for_different_configurations(self):
        envelope = coloured_envelope(1)
        standard = analyse_envelope(envelope, 100)
        altered = analyse_envelope(envelope, 100, AnalysisConfig(high_hz=4))
        self.assertNotEqual(standard["analysis_signature"], altered["analysis_signature"])
        self.assertEqual(standard["config"], asdict(AnalysisConfig()))

    def test_summary_and_feature_values_are_finite_and_json_safe(self):
        result = analyse_envelope(coloured_envelope(1), 100)
        self.assertEqual(result["schema_version"], "vocal-fluctuation-result-v1")
        self.assertEqual(result["method_id"], "rms-welch-v1")
        self.assertEqual(len(result["analysis_signature"]), 24)
        self.assertTrue(result["summary"])
        self.assertGreaterEqual(result["features"]["low_band_fraction"], 0)
        self.assertLessEqual(result["features"]["low_band_fraction"], 1)
        self.assertGreaterEqual(result["features"]["spectral_flatness"], 0)
        self.assertLessEqual(result["features"]["spectral_flatness"], 1)
        json.dumps(result, allow_nan=False)

    def test_block_slope_range_is_not_presented_as_a_confidence_interval(self):
        result = analyse_envelope(coloured_envelope(1), 100)
        quality = result["quality"]
        self.assertEqual(quality["independent_blocks"], 6)
        self.assertEqual(quality["block_slope_spread"], max(quality["block_slopes"]) - min(quality["block_slopes"]))
        self.assertNotIn("confidence_interval", result["fit"])

    def test_inputs_are_not_modified(self):
        audio = np.arange(1600, dtype=float) / 1600
        original = audio.copy()
        analyse_samples(audio, 8000)
        np.testing.assert_array_equal(original, audio)

    def test_invalid_configuration_values_are_rejected(self):
        for value in (True, 0, -1, float("nan"), float("inf"), "1"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    AnalysisConfig(low_hz=value)
        for fields in ({"low_hz": 4, "high_hz": 2}, {"hop_seconds": 0.2}, {"window_seconds": 2}, {"segment_seconds": 1}):
            with self.subTest(fields=fields):
                with self.assertRaises(ValueError):
                    AnalysisConfig(**fields)

    def test_invalid_audio_and_sample_rates_are_rejected(self):
        for samples in ([], [0], [[0] * 9] * 4, [0, float("nan")], [0, float("inf")], [1e308, 0], [1j, 0], ["x", "y"]):
            with self.subTest(samples=str(samples)):
                with self.assertRaises(ValueError):
                    analyse_samples(samples, 8000)
        for sr in (True, 0, -1, float("nan"), float("inf"), 1e100):
            with self.subTest(sr=sr):
                with self.assertRaises(ValueError):
                    analyse_samples([0, 1], sr)

    def test_invalid_envelopes_are_rejected(self):
        for envelope in ([-1, 0], [0], [[1, 2], [3, 4]], [0, float("inf")]):
            with self.subTest(envelope=str(envelope)):
                with self.assertRaises(ValueError):
                    analyse_envelope(envelope, 100)
        with self.assertRaises(ValueError):
            analyse_envelope([1, 2], 100, config={})


if __name__ == "__main__":
    unittest.main()
