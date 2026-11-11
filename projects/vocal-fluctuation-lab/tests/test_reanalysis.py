"""保存済み包絡の再解析で、音源や過去の処理履歴を変えないことを確認します。"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab import analysis
from vocal_lab.reanalyse import reanalyse_result, main
from vocal_lab.silence import (SilenceConfig, combined_analysis_signature,
                              preprocessing_signature)


def saved_result(internal=False):
    duration, rate = 90.003, 200.0
    n = int(np.ceil(duration * rate))
    rng = np.random.default_rng(76)
    f = np.fft.rfftfreq(n, 1 / rate)
    spectrum = rng.normal(size=len(f)) + 1j * rng.normal(size=len(f))
    spectrum[0] = 0
    spectrum[1:] /= np.sqrt(f[1:])
    values = np.fft.irfft(spectrum, n=n)
    values = 1 + .1 * values / np.std(values)
    result = analysis._analyse(values, rate, duration, analysis.AnalysisConfig())
    silence = SilenceConfig(remove_internal=internal)
    result["analysis_signature"] = combined_analysis_signature(result["analysis_signature"], silence)
    result["envelope_processing"] = {"method_id": analysis.ENVELOPE_METHOD, "sample_rate_hz": rate,
                                     "passband_high_hz": 20, "stopband_low_hz": 40}
    result["metadata"] = {
        "source_sha256": "a" * 64, "source_hash_scope": "selected-clip",
        "start_seconds": 0, "end_seconds": duration, "separation_method": "already-vocals",
        "model_version": "", "sample_rate_hz": 44100, "created_at": "2026-11-11T00:00:00+00:00",
        "preprocessing_signature": preprocessing_signature(silence),
        "analysis_request_signature": combined_analysis_signature(analysis.analysis_request_signature(), silence),
        "preprocessing": {
            "method_id": "rms-silence-v1", "timeline_modified": internal,
            "settings": {"trim_edges": True, "remove_internal": internal, "threshold_db": -40,
                         "min_silence_seconds": .5, "padding_seconds": .05},
            "output_duration_seconds": duration,
        },
    }
    return result


class ReanalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = saved_result()

    def test_default_fixed_reanalysis_matches_common_core_and_keeps_fractional_duration(self):
        original = deepcopy(self.original)
        before = deepcopy(original)
        with patch.object(analysis, "extract_envelope", side_effect=AssertionError("must reuse saved envelope")):
            result = reanalyse_result(original)
        fixed = analysis.AnalysisConfig(low_hz=.2, high_hz=20, segment_seconds=20, auto_band=False)
        expected = analysis._analyse(np.asarray(original["series"]["envelope"]), 200, 90.003, fixed)
        self.assertEqual(result["fit"], expected["fit"])
        self.assertEqual(result["features"], expected["features"])
        self.assertEqual(result["duration_seconds"], 90.003)
        self.assertNotEqual(result["duration_seconds"], len(result["series"]["envelope"]) / 200)
        self.assertEqual((result["fit"]["band_low_hz"], result["fit"]["band_high_hz"], result["fit"]["segment_seconds"]), (.2, 20, 20))
        self.assertFalse(result["config"]["auto_band"])
        self.assertEqual(original, before)

    def test_same_settings_reproduce_original_numbers_and_signature(self):
        result = reanalyse_result(self.original, analysis.AnalysisConfig(**self.original["config"]))
        self.assertEqual(result["fit"], self.original["fit"])
        self.assertEqual(result["features"], self.original["features"])
        self.assertEqual(result["spectrum"], self.original["spectrum"])
        self.assertEqual(result["analysis_signature"], self.original["analysis_signature"])

    def test_separation_metadata_is_preserved_and_never_relabelled(self):
        for method, model in (("already-vocals", ""), ("demucs:htdemucs", "4.1.0")):
            with self.subTest(method=method):
                original = deepcopy(self.original)
                original["metadata"]["separation_method"] = method
                original["metadata"]["model_version"] = model
                result = reanalyse_result(original)
                expected = deepcopy(original["metadata"])
                expected["analysis_request_signature"] = result["metadata"]["analysis_request_signature"]
                self.assertEqual(result["metadata"], expected)
                self.assertNotEqual(result["metadata"]["analysis_request_signature"], original["metadata"]["analysis_request_signature"])
                self.assertEqual(result["envelope_processing"], original["envelope_processing"])
                result["metadata"]["preprocessing"]["settings"]["trim_edges"] = False
                self.assertTrue(original["metadata"]["preprocessing"]["settings"]["trim_edges"])

    def test_provenance_hash_identifies_the_unchanged_original_document(self):
        result = reanalyse_result(self.original)
        canonical = json.dumps(self.original, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        self.assertEqual(result["reanalysis"]["source_result_canonical_sha256"], hashlib.sha256(canonical.encode()).hexdigest())
        self.assertEqual(result["reanalysis"]["source_config"], self.original["config"])
        self.assertEqual(result["reanalysis"]["source_created_at"], self.original["metadata"]["created_at"])
        second = reanalyse_result(result)
        self.assertEqual(second["reanalysis"]["source_reanalysis"], result["reanalysis"])

    def test_internal_silence_warning_is_kept_on_the_shortened_timeline(self):
        result = reanalyse_result(saved_result(internal=True))
        self.assertTrue(result["metadata"]["preprocessing"]["timeline_modified"])
        self.assertIn("時間軸", result["summary"])
        self.assertTrue(any("途中の無音" in reason for reason in result["quality"]["reasons"]))

    def test_nonzero_time_origin_is_preserved(self):
        original = deepcopy(self.original)
        original["series"]["time_seconds"] = [value + 3 for value in original["series"]["time_seconds"]]
        result = reanalyse_result(original)
        self.assertEqual(result["series"]["time_seconds"], original["series"]["time_seconds"])

    def test_old_incomplete_nonfinite_and_inconsistent_results_are_rejected(self):
        changes = {
            "old method": lambda d: d.update(method_id="rms-welch-v1"),
            "unknown envelope": lambda d: d["envelope_processing"].update(method_id="unknown"),
            "wrong rate": lambda d: d.update(envelope_sample_rate_hz=100),
            "over ten minutes": lambda d: d.update(duration_seconds=601),
            "nonuniform time": lambda d: d["series"]["time_seconds"].__setitem__(3, .017),
            "missing sample": lambda d: (d["series"]["time_seconds"].pop(), d["series"]["envelope"].pop()),
            "negative": lambda d: d["series"]["envelope"].__setitem__(3, -1),
            "nan": lambda d: d["series"]["envelope"].__setitem__(3, float("nan")),
            "bad silence signature": lambda d: d["metadata"].update(preprocessing_signature="unknown"),
            "changed slope": lambda d: d["fit"].update(slope=d["fit"]["slope"] + .01),
            "changed request signature": lambda d: d["metadata"].update(analysis_request_signature="unknown"),
        }
        for name, change in changes.items():
            with self.subTest(name=name):
                original = deepcopy(self.original)
                change(original)
                with self.assertRaises(ValueError):
                    reanalyse_result(original)

    def test_point_limit_is_checked_before_calculation(self):
        original = deepcopy(self.original)
        original["series"] = {"envelope": [1.0] * 120001, "time_seconds": [0.0] * 120001}
        with self.assertRaises(ValueError):
            reanalyse_result(original)

    def test_cli_creates_a_separate_result_without_overwriting_inputs_or_outputs(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "original.json", Path(folder) / "fixed.json"
            source.write_text(json.dumps(self.original))
            before = source.read_bytes()
            with patch("builtins.print"):
                main([str(source), "--output", str(output)])
            result = json.loads(output.read_text())
            self.assertFalse(result["config"]["auto_band"])
            self.assertEqual(source.read_bytes(), before)
            fixed_before = output.read_bytes()
            with patch("sys.stderr"), self.assertRaises(SystemExit):
                main([str(source), "--output", str(output)])
            self.assertEqual(output.read_bytes(), fixed_before)
            with patch("sys.stderr"), self.assertRaises(SystemExit):
                main([str(source), "--output", str(source)])
            self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
