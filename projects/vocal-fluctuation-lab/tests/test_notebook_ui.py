"""Notebookの入力、表示、保存を、分離モデルを取得せずに確認します。"""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from zipfile import ZipFile
import sys

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from vocal_lab import notebook_ui as ui


def example_analysis():
    return {
        "schema_version": "vocal-fluctuation-result-v1", "method_id": "rms-welch-v1",
        "status": "inconclusive", "summary": "長さが足りないため判定保留です。", "duration_seconds": 30,
        "fit": {"slope": -1, "intercept": -2, "r_squared": 0.8, "band_low_hz": 0.2, "band_high_hz": 5},
        "series": {"time_seconds": [0, 1, 2], "envelope": [0.2, 0.3, 0.2]},
        "spectrum": {"frequency_hz": [0, 0.2, 1, 5], "power": [0, 0.05, 0.01, 0.002], "bin_frequency_hz": [0.2, 1, 5], "bin_power": [0.05, 0.01, 0.002]},
        "quality": {"usable_for_comparison": False, "reasons": ["60秒以上の区間を指定してください。"]},
        "features": {"slope": -1, "envelope_cv": 0.3, "low_band_fraction": 0.4, "spectral_flatness": 0.2},
        "analysis_signature": "test-only",
    }


class UploadTests(unittest.TestCase):
    def test_v7_and_v8_uploads_have_the_same_content(self):
        self.assertEqual(ui.uploaded_files({"x.mp3": {"content": b"audio"}})[0], {"name": "x.mp3", "content": b"audio"})
        self.assertEqual(ui.uploaded_files(({"name": "x.mp3", "content": memoryview(b"audio")},))[0]["name"], "x.mp3")

    def test_uploaded_name_cannot_escape_the_workspace(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / "input"
            path = ui.save_audio_upload(({"name": "../../personal.mp3", "content": memoryview(b"audio")},), directory)
            self.assertEqual(path.parent, directory)
            self.assertEqual(path.read_bytes(), b"audio")
            self.assertNotIn("personal", path.name)

    def test_empty_wrong_type_and_multiple_uploads_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            for value in [(), ({"name": "x.txt", "content": b"audio"},), ({"name": "x.wav", "content": b""},), ({"name": "a.wav", "content": b"a"}, {"name": "b.wav", "content": b"b"})]:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    ui.save_audio_upload(value, Path(folder))

    def test_interval_validation_accepts_seconds_and_rejects_nonfinite_bounds(self):
        self.assertEqual(ui.validate_interval(40, 130), (40, 130))
        self.assertEqual(ui.validate_interval(0, 600), (0, 600))
        for start, end in [(True, 90), (float("nan"), 90), (0, float("inf")), (-1, 90), (90, 90), (0, 9.9), (0, 601), ("bad", 90)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                ui.validate_interval(start, end)


class ExportTests(unittest.TestCase):
    def test_result_zip_contains_numbers_and_chart_without_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            path = ui.export_results(example_analysis(), Path(folder))
            with ZipFile(path) as archive:
                self.assertEqual(set(archive.namelist()), {"result.json", "envelope.csv", "spectrum.csv", "binned_spectrum.csv", "analysis.png"})
                self.assertEqual(json.loads(archive.read("result.json"))["fit"]["slope"], -1)
                self.assertIn(b"time_seconds,envelope", archive.read("envelope.csv"))
                self.assertTrue(archive.read("analysis.png").startswith(b"\x89PNG"))

    def test_comparison_escapes_names_and_does_not_invent_identity_percentages(self):
        rendered = ui.comparison_html([{"artist": "<script>x</script>", "distance": 0.25, "tracks_count": 3}])
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn("0.250", rendered)
        self.assertNotIn("%", rendered)
        self.assertIn("比較データがありません", ui.comparison_html([]))

    def test_notebook_is_clean_and_code_cells_are_valid_python(self):
        path = PROJECT / "notebooks" / "vocal_fluctuation_lab.ipynb"
        notebook = json.loads(path.read_text())
        self.assertEqual(notebook["nbformat"], 4)
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertIsNone(cell["execution_count"])
                self.assertEqual(cell["outputs"], [])
                self.assertEqual(cell["metadata"]["cellView"], "form")
                self.assertTrue(cell["source"].startswith("#@title "))
                compile("".join(cell["source"]), str(path), "exec")
        source = path.read_text()
        self.assertNotIn("authors", notebook["metadata"])
        self.assertEqual(notebook["metadata"]["colab"]["provenance"], [])
        self.assertIn("requirements-colab.txt", source)

    def test_reference_batch_uses_a_form_checkbox_and_is_not_run_by_default(self):
        notebook = json.loads((PROJECT / "notebooks" / "vocal_fluctuation_lab.ipynb").read_text())
        batch = next(cell["source"] for cell in notebook["cells"] if cell["cell_type"] == "code" and "prepare_reference_database =" in cell["source"])
        self.assertIn('prepare_reference_database = False #@param {type:"boolean"}', batch)
        namespace = {}
        with patch("builtins.print") as printed:
            exec(compile(batch, "batch-cell", "exec"), namespace)
        self.assertFalse(namespace["prepare_reference_database"])
        self.assertNotIn("build_reference_catalogue", namespace)
        self.assertTrue(printed.called)

    def test_preprocessing_reports_durations_and_shortened_time_axis(self):
        analysis = example_analysis()
        analysis["metadata"] = {"preprocessing": {"input_duration_seconds": 90, "output_duration_seconds": 70, "leading_removed_seconds": 5, "trailing_removed_seconds": 5, "internal_removed_seconds": 10, "timeline_modified": True}}
        rendered = ui.preprocessing_html(analysis)
        self.assertIn("調整前 90.00 秒 → 調整後 70.00 秒", rendered)
        self.assertIn("途中：10.00 秒", rendered)
        self.assertIn("時間短縮後", rendered)
        figure = ui.plot_analysis(analysis)
        self.addCleanup(__import__("matplotlib.pyplot", fromlist=["close"]).close, figure)
        self.assertEqual(figure.axes[0].get_xlabel(), "時間短縮後の経過時間 [秒]")
        self.assertIn("RMS振幅", figure.axes[0].get_ylabel())
        self.assertIn("変動周波数", figure.axes[1].get_xlabel())
        self.assertIn("1/fの基準線", figure.axes[1].get_legend_handles_labels()[1])


class NotebookFlowTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.database = Mock()
        self.database.empty_database.return_value = {"references": []}
        self.database.compare_reference.return_value = []
        self.pipeline = Mock()
        self.controller = ui.VocalNotebookUI(self.folder.name, pipeline=self.pipeline, database=self.database)
        self.controller.mode.value = "youtube"
        self.controller.url.value = "https://www.youtube.com/watch?v=abcdefghijk"
        self.controller.display = Mock()
        self.controller.result_output.clear_output = Mock()

    def test_missing_file_and_invalid_interval_do_not_start_processing(self):
        self.controller.mode.value = "file"
        self.controller._analyse()
        self.pipeline.assert_not_called()
        self.assertIn("音源ファイル", self.controller.status.value)
        self.assertTrue(self.controller.result_download.disabled)
        self.controller.mode.value = "youtube"
        self.controller.end.value = 1
        self.controller._analyse()
        self.pipeline.assert_not_called()
        self.assertFalse(self.controller.analyse_button.disabled)

    def test_processing_receives_times_source_mode_and_cpu_choice(self):
        self.controller.device.value = "cpu"
        bundle = {"analysis": example_analysis(), "clip_path": "clip.wav", "vocals_path": "vocals.wav"}
        self.pipeline.return_value = bundle
        with patch.object(ui, "export_results", return_value=Path(self.folder.name) / "results.zip"), patch.object(self.controller, "_show_result"):
            self.controller._analyse()
        args, kwargs = self.pipeline.call_args
        self.assertEqual(args[1:3], (0, 90))
        self.assertEqual(kwargs["source_kind"], "youtube")
        self.assertEqual(kwargs["device"], "cpu")
        self.assertFalse(kwargs["already_vocals"])
        self.assertTrue(kwargs["silence_config"].trim_edges)
        self.assertFalse(kwargs["silence_config"].remove_internal)
        self.assertFalse(self.controller.result_download.disabled)
        self.assertTrue(self.controller.add_reference_button.disabled)

    def test_reset_restores_manual_seconds_and_exits_whole_track_mode(self):
        self.controller.start.value, self.controller.end.value = 40, 150
        self.controller.whole_track.value = True
        self.assertEqual(self.controller.time_controls.layout.display, "none")
        self.controller.reset_times_button.click()
        self.assertEqual((self.controller.start.value, self.controller.end.value), (0, 90))
        self.assertFalse(self.controller.whole_track.value)
        self.assertEqual(self.controller.time_controls.layout.display, "")

    def test_whole_track_ignores_stale_manual_seconds_and_passes_eof(self):
        self.controller.start.value, self.controller.end.value = float("nan"), 1
        self.controller.whole_track.value = True
        self.pipeline.return_value = {"analysis": example_analysis(), "clip_path": "clip.wav", "vocals_path": "vocals.wav"}
        with patch.object(ui, "export_results", return_value=Path(self.folder.name) / "results.zip"), patch.object(self.controller, "_show_result"):
            self.controller._analyse()
        self.assertEqual(self.pipeline.call_args.args[1], 0)
        self.assertIsNone(self.pipeline.call_args.args[2])

    def test_silence_controls_reach_the_pipeline_without_changing_implicit_padding(self):
        self.controller.trim_edges.value = False
        self.controller.remove_internal.value = True
        self.controller.threshold_db.value = -60
        self.controller.min_silence_seconds.value = 1.2
        self.pipeline.return_value = {"analysis": example_analysis(), "clip_path": "clip.wav", "vocals_path": "vocals.wav"}
        with patch.object(ui, "export_results", return_value=Path(self.folder.name) / "results.zip"), patch.object(self.controller, "_show_result"):
            self.controller._analyse()
        config = self.pipeline.call_args.kwargs["silence_config"]
        self.assertFalse(config.trim_edges)
        self.assertTrue(config.remove_internal)
        self.assertEqual(config.threshold_db, -60)
        self.assertAlmostEqual(config.min_silence_seconds, 1.2)
        self.assertEqual(config.padding_seconds, 0.05)

    def test_failure_discards_prior_success_and_disables_exports(self):
        self.controller.bundle = {"analysis": example_analysis()}
        self.controller.result_download.disabled = False
        self.controller.vocals_download.disabled = False
        self.pipeline.side_effect = ValueError("この動画は取得できません。音源をアップロードしてください。")
        self.controller._analyse()
        self.assertIsNone(self.controller.bundle)
        self.assertTrue(self.controller.result_download.disabled)
        self.assertTrue(self.controller.vocals_download.disabled)
        self.assertTrue(self.controller.add_reference_button.disabled)
        self.assertFalse(self.controller.analyse_button.disabled)
        self.assertIn("アップロード", self.controller.status.value)

    def test_quality_reasons_are_displayed(self):
        self.controller.bundle = {"analysis": example_analysis(), "clip_path": "clip.wav", "vocals_path": "vocals.wav"}
        self.controller.Audio = Mock(return_value="audio")
        with patch.object(ui, "plot_analysis"):
            self.controller._show_result()
        rendered = " ".join(str(call.args[0].data) for call in self.controller.display.call_args_list if hasattr(call.args[0], "data"))
        self.assertIn("60秒以上", rendered)

    def test_raw_and_processed_vocals_are_distinguished_and_playable(self):
        self.controller.bundle = {"analysis": example_analysis(), "clip_path": "clip.wav", "extracted_vocals_path": "raw-vocals.wav", "vocals_path": "processed-vocals.wav"}
        self.controller.Audio = Mock(return_value="audio")
        with patch.object(ui, "plot_analysis"):
            self.controller._show_result()
        self.assertEqual([call.kwargs["filename"] for call in self.controller.Audio.call_args_list], ["clip.wav", "raw-vocals.wav", "processed-vocals.wav"])
        rendered = " ".join(str(call.args[0].data) for call in self.controller.display.call_args_list if hasattr(call.args[0], "data"))
        self.assertIn("抽出した歌声（無音調整前）", rendered)
        self.assertIn("解析に使った歌声（無音調整後）", rendered)

    def test_reference_addition_replaces_database_with_returned_copy(self):
        self.controller.bundle = {"analysis": example_analysis()}
        self.controller.artist.value = "Example artist"
        self.controller.track.value = "Example track"
        self.database.add_reference.return_value = {"references": [{"artist": "Example artist"}]}
        self.controller._add_reference()
        self.assertEqual(self.controller.database, self.database.add_reference.return_value)
        self.assertIn("登録しました", self.controller.db_status.value)

    def test_reference_source_uses_completed_analysis_when_input_has_changed(self):
        analysis = example_analysis()
        analysis["metadata"] = {"source_url": "https://www.youtube.com/watch?v=original123"}
        self.controller.bundle = {"analysis": analysis}
        self.controller.artist.value = "Example artist"
        self.controller.track.value = "Example track"
        self.controller.url.value = "https://www.youtube.com/watch?v=changed1234"
        self.database.add_reference.return_value = {"references": []}
        self.controller._add_reference()
        self.assertEqual(self.database.add_reference.call_args.kwargs["source"], analysis["metadata"]["source_url"])


if __name__ == "__main__":
    unittest.main()
