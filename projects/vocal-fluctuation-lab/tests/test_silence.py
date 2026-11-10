"""無音の前処理が音量や時間軸に与える変化を確認します。"""
import json
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab.audio import AudioInputError
from vocal_lab.silence import (SilenceConfig, combined_analysis_signature,
                               normalise_silence_config, preprocessing_signature, process_silence)


class SilenceTests(unittest.TestCase):
    def setUp(self):
        self.sr = 1000
        mono = np.concatenate([np.zeros(1000), np.ones(2000) * .5, np.zeros(2000), np.ones(2000), np.zeros(1000)])
        self.samples = np.column_stack([mono, -mono])

    def test_default_trims_only_edges_and_retains_internal_pause_and_antiphase(self):
        original = self.samples.copy()
        result, report = process_silence(self.samples, self.sr)
        np.testing.assert_array_equal(self.samples, original)
        np.testing.assert_array_equal(result, original[950:7050])
        self.assertGreater(np.sqrt(np.mean(result ** 2)), .5)
        self.assertFalse(report["timeline_modified"])
        self.assertEqual(report["kept_segments_seconds"], [[.95, 7.05]])
        self.assertEqual(report["internal_removed_seconds"], 0)
        self.assertAlmostEqual(report["output_duration_seconds"], 6.1)
        self.assertEqual(report["settings"], {"trim_edges": True, "remove_internal": False, "threshold_db": -40.,
                                              "min_silence_seconds": .5, "padding_seconds": .05})

    def test_internal_removal_keeps_padding_and_exact_map_without_crossfade(self):
        result, report = process_silence(self.samples, self.sr, SilenceConfig(remove_internal=True, padding_seconds=.051))
        expected = np.concatenate([self.samples[949:3051], self.samples[4949:7051]])
        np.testing.assert_array_equal(result, expected)
        self.assertEqual(report["kept_segments_seconds"], [[.949, 3.051], [4.949, 7.051]])
        self.assertTrue(report["timeline_modified"])
        self.assertAlmostEqual(report["internal_removed_seconds"], 1.898)
        total = sum(report[key] for key in ("output_duration_seconds", "leading_removed_seconds",
                                            "trailing_removed_seconds", "internal_removed_seconds"))
        self.assertAlmostEqual(total, report["input_duration_seconds"], places=12)

    def test_disabled_edges_stay_even_when_internal_gaps_are_removed(self):
        config = SilenceConfig(trim_edges=False, remove_internal=True)
        result, report = process_silence(self.samples, self.sr, config)
        np.testing.assert_array_equal(result, np.concatenate([self.samples[:3050], self.samples[4950:]]))
        self.assertEqual(report["leading_removed_seconds"], 0)
        self.assertEqual(report["trailing_removed_seconds"], 0)

    def test_minimum_internal_silence_and_padding_prevent_short_gap_removal(self):
        samples = np.concatenate([np.ones(1000), np.zeros(480), np.ones(1000), np.zeros(520), np.ones(1000)])
        result, report = process_silence(samples, self.sr, SilenceConfig(remove_internal=True))
        self.assertAlmostEqual(report["internal_removed_seconds"], .42)
        self.assertEqual(len(result), len(samples) - 420)
        result, report = process_silence(samples, self.sr, SilenceConfig(remove_internal=True, padding_seconds=1))
        np.testing.assert_array_equal(result, samples)
        self.assertFalse(report["timeline_modified"])

    def test_threshold_is_relative_amplitude_db_and_gain_invariant(self):
        samples = np.concatenate([np.ones(1000) * .005, np.ones(1000), np.ones(1000) * .005])
        _, minus40 = process_silence(samples, self.sr, SilenceConfig(padding_seconds=0))
        _, minus60 = process_silence(samples, self.sr, SilenceConfig(threshold_db=-60, padding_seconds=0))
        _, scaled = process_silence(samples * .02, self.sr, SilenceConfig(padding_seconds=0))
        self.assertEqual(minus40["kept_segments_seconds"], [[1, 2]])
        self.assertEqual(minus60["kept_segments_seconds"], [[0, 3]])
        self.assertEqual(scaled["kept_segments_seconds"], minus40["kept_segments_seconds"])

    def test_no_transform_retains_every_sample_including_partial_last_frame(self):
        samples = np.r_[np.zeros(103), np.ones(232), np.zeros(17)]
        processed, report = process_silence(samples, 11025, SilenceConfig(trim_edges=False))
        np.testing.assert_array_equal(processed, samples)
        self.assertEqual(report["kept_segments_seconds"], [[0, len(samples) / 11025]])
        json.dumps(report, allow_nan=False)

    def test_all_silent_input_fails_instead_of_fabricating_a_vocal_section(self):
        for config in [None, SilenceConfig(trim_edges=False), SilenceConfig(remove_internal=True)]:
            with self.assertRaisesRegex(AudioInputError, "すべて無音"):
                process_silence(np.zeros((1000, 2)), self.sr, config)

    def test_invalid_audio_and_settings_are_rejected(self):
        for samples in [[], [float("nan"), 1], [float("inf"), 1], [1j, 0], np.ones((2, 0))]:
            with self.subTest(samples=str(samples)), self.assertRaises(AudioInputError):
                process_silence(samples, self.sr)
        for config in [SilenceConfig(trim_edges="yes"), SilenceConfig(threshold_db=1),
                       SilenceConfig(min_silence_seconds=-1), SilenceConfig(padding_seconds=float("nan")),
                       {"wrong_setting": True}]:
            with self.subTest(config=config), self.assertRaises(AudioInputError):
                normalise_silence_config(config)

    def test_policy_fingerprint_and_combined_signature_do_not_depend_on_cut_locations(self):
        same = SilenceConfig(threshold_db=-40, min_silence_seconds=.5)
        self.assertEqual(preprocessing_signature(), preprocessing_signature(same))
        self.assertEqual(preprocessing_signature(), preprocessing_signature({"threshold_db": -40}))
        self.assertNotEqual(preprocessing_signature(), preprocessing_signature(SilenceConfig(remove_internal=True)))
        self.assertNotEqual(preprocessing_signature(), preprocessing_signature(SilenceConfig(threshold_db=-60)))
        first, report1 = process_silence(self.samples, self.sr)
        second, report2 = process_silence(self.samples[500:], self.sr)
        self.assertNotEqual(report1["kept_segments_seconds"], report2["kept_segments_seconds"])
        self.assertEqual(combined_analysis_signature("analysis-base"), combined_analysis_signature("analysis-base", same))
        parsed = json.loads(combined_analysis_signature("analysis-base"))
        self.assertEqual(parsed["preprocessing_signature"], preprocessing_signature())
        self.assertEqual(parsed["preprocessing_method_id"], "rms-silence-v1")


if __name__ == "__main__":
    unittest.main()
