"""実測の成功分だけが保存され、失敗後にも残ることを確認します。"""

from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab import build_references as builder
from vocal_lab.reference_db import load_database


def catalogue(count=3):
    return {"schema_version": builder.CATALOGUE_SCHEMA, "candidates": [
        {"artist": f"Artist {number}", "reported_track": f"Track {number}",
         "url": f"https://www.youtube.com/watch?v=sample{number}",
         "start_seconds": None, "end_seconds": None}
        for number in range(count)]}


def measured(url, start, end, output_dir, **kwargs):
    return {"analysis": {
        "schema_version": "vocal-fluctuation-result-v1", "method_id": "rms-welch-v1",
        "analysis_signature": "test-default-analysis-conditions",
        "quality": {"usable_for_comparison": True},
        "features": {"slope": -1, "envelope_cv": 0.5,
                     "low_band_fraction": 0.4, "spectral_flatness": 0.25},
        "metadata": {"source_sha256": hashlib.sha256(url.encode()).hexdigest(),
                     "source_hash_scope": "selected-clip", "start_seconds": start, "end_seconds": end,
                     "separation_method": "demucs:htdemucs", "model_version": "4.1.0"},
    }}


class BuildReferenceTests(unittest.TestCase):
    def test_explicit_build_measures_each_candidate_and_persists_only_features(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis", side_effect=measured) as run:
            result = builder.build_reference_catalogue(catalogue(), directory, progress=lambda message: None)
            self.assertEqual(run.call_count, 3)
            self.assertEqual([row["status"] for row in result["report"]], ["added"] * 3)
            self.assertEqual(len(load_database(result["database_path"])["references"]), 3)
            for call in run.call_args_list:
                self.assertEqual(call.args[1:3], (40, 130))
                self.assertEqual(call.kwargs["source_kind"], "youtube")
                self.assertFalse(call.kwargs["already_vocals"])
            encoded = Path(result["database_path"]).read_text()
            self.assertNotIn("vocals_path", encoded)
            self.assertNotIn("series", encoded)

    def test_failed_download_and_unusable_result_do_not_destroy_saved_success(self):
        def run(url, *args, **kwargs):
            if "sample1" in url:
                raise ValueError("動画を取得できません")
            result = measured(url, *args, **kwargs)
            if "sample2" in url:
                result["analysis"]["quality"]["usable_for_comparison"] = False
            return result
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis", side_effect=run):
            result = builder.build_reference_catalogue(catalogue(), directory)
            self.assertEqual([row["status"] for row in result["report"]], ["added", "failed", "rejected"])
            self.assertEqual(len(load_database(result["database_path"])["references"]), 1)
            report = json.loads(Path(result["report_path"]).read_text())["report"]
            self.assertEqual(report, result["report"])
            self.assertIn("アップロード", report[1]["message"])

    def test_resuming_skips_existing_candidates_without_fetching_again(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(builder, "_run_analysis", side_effect=measured):
                first = builder.build_reference_catalogue(catalogue(), directory)
            with patch.object(builder, "_run_analysis") as run:
                second = builder.build_reference_catalogue(catalogue(), directory)
            run.assert_not_called()
            self.assertEqual(first["database"], second["database"])
            self.assertEqual([row["status"] for row in second["report"]], ["skipped"] * 3)

    def test_candidate_intervals_can_be_set_explicitly_in_the_catalogue(self):
        candidates = catalogue(1)
        candidates["candidates"][0].update(start_seconds=20, end_seconds=110)
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis", side_effect=measured) as run:
            builder.build_reference_catalogue(candidates, directory, start_seconds=40, end_seconds=130, device="cpu")
            self.assertEqual(run.call_args.args[1:3], (20, 110))
            self.assertEqual(run.call_args.kwargs["device"], "cpu")

    def test_invalid_input_stops_before_starting_any_analysis(self):
        invalid_catalogues = [{}, {"schema_version": builder.CATALOGUE_SCHEMA, "candidates": []},
                              {"schema_version": builder.CATALOGUE_SCHEMA, "candidates": [{}]}]
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis") as run:
            for value in invalid_catalogues:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    builder.build_reference_catalogue(value, directory)
            for start, end in [(False, 90), (0, 9), (0, 181), (-1, 90), (0, float("nan"))]:
                with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                    builder.build_reference_catalogue(catalogue(), directory, start, end)
            with self.assertRaises(ValueError):
                builder.build_reference_catalogue(catalogue(), directory, device="unknown")
            run.assert_not_called()

    def test_bad_existing_database_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis") as run:
            path = Path(directory) / "artist_references.json"
            path.write_text("broken data")
            with self.assertRaises(ValueError):
                builder.build_reference_catalogue(catalogue(), directory)
            self.assertEqual(path.read_text(), "broken data")
            run.assert_not_called()

    def test_a_catalogue_cannot_be_overwritten_by_its_output_report(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis") as run:
            path = Path(directory) / "reference_build_report.json"
            content = json.dumps(catalogue(1))
            path.write_text(content)
            with self.assertRaises(ValueError):
                builder.build_reference_catalogue(path, directory)
            self.assertEqual(path.read_text(), content)
            run.assert_not_called()

    def test_cli_all_failed_returns_nonzero_without_traceback_or_invented_measurements(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis", side_effect=ValueError("取得失敗")):
            path = Path(directory) / "catalogue.json"
            path.write_text(json.dumps(catalogue(1)))
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = builder.main(["--catalogue", str(path), "--output", str(Path(directory) / "out")])
            self.assertEqual(code, 1)
            self.assertIn("DB内の実測値: 0件", stdout.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())

    def test_catalogue_path_and_cli_success_use_the_requested_interval(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(builder, "_run_analysis", side_effect=measured) as run:
            path = Path(directory) / "catalogue.json"
            path.write_text(json.dumps(catalogue(1)))
            with redirect_stdout(io.StringIO()):
                code = builder.main(["--catalogue", str(path), "--output", str(Path(directory) / "out"),
                                     "--start", "10", "--end", "100", "--device", "cpu"])
            self.assertEqual(code, 0)
            self.assertEqual(run.call_args.args[1:3], (10, 100))


if __name__ == "__main__":
    unittest.main()
