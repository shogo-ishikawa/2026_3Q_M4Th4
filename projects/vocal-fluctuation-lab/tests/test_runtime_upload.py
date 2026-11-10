"""ブラウザ転送とファイル選択を分け、保存済みWAVを確実に渡します。"""
import datetime
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from vocal_lab import notebook_ui as ui


def widget_record(name="old.wav"):
    return {"name": name, "type": "audio/wav", "size": 3, "content": memoryview(b"old"),
            "last_modified": datetime.datetime.now(datetime.timezone.utc)}


class RuntimeUploadTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.directory = Path(self.folder.name)
        self.pipeline = Mock(return_value={"analysis": {"quality": {}}, "vocals_path": "output.wav"})
        self.database = Mock()
        self.database.empty_database.return_value = {"references": []}
        self.database.compare_reference.return_value = []
        self.lab = ui.VocalNotebookUI(self.directory / "work", pipeline=self.pipeline, database=self.database)
        self.lab.result_output.clear_output = Mock()
        self.lab.upload_output.clear_output = Mock()

    def seed_old_selection_and_result(self):
        self.lab.audio_upload.value = (widget_record(),)
        self.lab.bundle = {"old": True}
        self.lab.results_zip = Path("old.zip")
        for button in (self.lab.result_download, self.lab.vocals_download,
                       self.lab.raw_vocals_download, self.lab.add_reference_button):
            button.disabled = False

    def assert_no_old_input(self):
        self.assertIsNone(self.lab._audio_input_route)
        self.assertIsNone(self.lab._audio_input_path)
        self.assertIsNone(self.lab.bundle)
        self.assertIsNone(self.lab.results_zip)
        for button in (self.lab.result_download, self.lab.vocals_download,
                       self.lab.raw_vocals_download, self.lab.add_reference_button):
            self.assertTrue(button.disabled)
        self.lab._analyse()
        self.pipeline.assert_not_called()
        self.assertIn("認識できていません", self.lab.status.value)

    def analyse(self):
        with patch.object(ui, "export_results", return_value=self.directory / "result.zip"), \
                patch.object(self.lab, "_show_result"):
            self.lab.analyse_button.click()

    def test_colab_environment_uses_native_picker_without_widget_transfer(self):
        fake = types.ModuleType("google.colab")
        fake.files = types.SimpleNamespace(upload=Mock())
        with patch.dict(sys.modules, {"google.colab": fake}):
            lab = ui.VocalNotebookUI(self.directory / "native", pipeline=self.pipeline, database=self.database)
        self.assertIs(lab._colab_files, fake.files)
        self.assertEqual(lab.audio_upload.layout.display, "none")
        self.assertEqual(lab.colab_upload_button.layout.display, "")
        self.assertEqual(lab.colab_upload_button.description, "音源を選ぶ")
        self.assertEqual(lab.audio_upload.value, ())

    def test_native_upload_uses_actual_renamed_path_and_blocks_early_analysis(self):
        self.seed_old_selection_and_result()
        self.lab.audio_upload.value = ()
        def transfer(target_dir):
            self.assertTrue(self.lab._audio_upload_busy)
            self.assertTrue(self.lab.analyse_button.disabled)
            self.assertTrue(self.lab.colab_upload_button.disabled)
            self.assertTrue(self.lab.use_runtime_file_button.disabled)
            self.assertTrue(self.lab.mode.disabled)
            self.lab._analyse()
            self.pipeline.assert_not_called()
            path = Path(target_dir) / "<vocals> (1).WAV"
            path.write_bytes(b"saved vocal audio")
            return {str(path): b"saved vocal audio"}
        self.lab._colab_files = types.SimpleNamespace(upload=Mock(side_effect=transfer))
        selected = self.lab.upload_audio_from_colab(use_output=False)
        self.assertEqual(selected.name, "<vocals> (1).WAV")
        self.assertEqual(self.lab._audio_input_route, "colab")
        self.assertEqual(self.lab.audio_upload.value, ())
        self.assertIn("&lt;vocals&gt; (1).WAV", self.lab.selected_audio.value)
        self.assertIn("MiB", self.lab.selected_audio.value)
        self.assertFalse(self.lab._audio_upload_busy)
        self.assertFalse(self.lab.analyse_button.disabled)
        self.assertFalse(self.lab.colab_upload_button.disabled)
        self.assertFalse(self.lab.mode.disabled)
        self.assertIsNone(self.lab.bundle)
        self.lab.vocals_only.value, self.lab.whole_track.value = True, True
        self.lab.analysis_mode.value = "fixed"
        self.analyse()
        self.assertEqual(self.pipeline.call_args.args[:3], (str(selected), 0.0, None))
        self.assertTrue(self.pipeline.call_args.kwargs["already_vocals"])
        self.assertEqual(self.pipeline.call_args.kwargs["source_kind"], "file")
        self.assertEqual(self.pipeline.call_args.kwargs["config"].high_hz, 20)
        self.assertEqual(selected.read_bytes(), b"saved vocal audio")

    def test_cancel_failed_multiple_missing_and_invalid_native_upload_clear_old_selection(self):
        for problem in ("cancel", "exception", "multiple", "missing", "outside", "extension", "empty", "oversize"):
            with self.subTest(problem=problem):
                self.pipeline.reset_mock()
                self.seed_old_selection_and_result()
                def transfer(target_dir):
                    directory = Path(target_dir)
                    if problem == "cancel":
                        return {}
                    if problem == "exception":
                        raise RuntimeError("transfer failed")
                    if problem == "multiple":
                        return {str(directory / "one.wav"): b"a", str(directory / "two.wav"): b"b"}
                    path = directory / ("song.txt" if problem == "extension" else "song.wav")
                    if problem == "outside":
                        path = self.directory / "outside.wav"
                    if problem != "missing":
                        path.write_bytes(b"" if problem == "empty" else b"audio")
                    if problem == "oversize":
                        with path.open("wb") as handle:
                            handle.truncate(ui.MAX_UPLOAD_BYTES + 1)
                    return {str(path): b""}
                self.lab._colab_files = types.SimpleNamespace(upload=Mock(side_effect=transfer))
                self.assertIsNone(self.lab.upload_audio_from_colab())
                self.assertIn("認識できませんでした", self.lab.status.value)
                self.assert_no_old_input()
                self.assertFalse(self.lab._audio_upload_busy)
                self.assertFalse(self.lab.analyse_button.disabled)
                self.assertFalse(self.lab.colab_upload_button.disabled)
                self.assertEqual(bytes(self.lab.audio_upload.value[0]["content"]), b"old")

    def test_existing_path_uses_saved_wav_read_only_and_does_not_copy_widget_bytes(self):
        self.seed_old_selection_and_result()
        source = self.directory / "保存済み歌声.wav"
        source.write_bytes(b"existing vocals")
        self.lab.runtime_file_path.value = str(source)
        self.lab.use_runtime_file_button.click()
        self.assertEqual(self.lab._audio_input_route, "path")
        self.assertEqual(self.lab._audio_input_path, source)
        self.assertIn(source.name, self.lab.selected_audio.value)
        self.lab.vocals_only.value = True
        self.analyse()
        self.assertEqual(self.pipeline.call_args.args[0], str(source))
        self.assertTrue(self.pipeline.call_args.kwargs["already_vocals"])
        self.assertEqual(source.read_bytes(), b"existing vocals")
        self.assertEqual(bytes(self.lab.audio_upload.value[0]["content"]), b"old")

    def test_bad_runtime_path_cannot_fall_back_to_old_widget_input(self):
        self.seed_old_selection_and_result()
        self.lab.runtime_file_path.value = "/missing/song.wav"
        self.lab.use_runtime_file_button.click()
        self.assert_no_old_input()

    def test_editing_selected_path_requires_explicit_reselection(self):
        source = self.directory / "song.wav"
        source.write_bytes(b"audio")
        self.lab.runtime_file_path.value = str(source)
        self.lab.use_runtime_file_button.click()
        self.lab.runtime_file_path.value = str(self.directory / "other.wav")
        self.assert_no_old_input()
        self.assertTrue(source.is_file())

    def test_deleted_runtime_file_is_rechecked_before_processing(self):
        source = self.directory / "song.wav"
        source.write_bytes(b"audio")
        self.lab.runtime_file_path.value = str(source)
        self.lab.use_runtime_file_button.click()
        source.unlink()
        self.lab._analyse()
        self.pipeline.assert_not_called()
        self.assertIn("見つかりません", self.lab.status.value)

    def test_ten_minute_float_wav_size_is_admitted_without_loading_all_bytes(self):
        source = self.directory / "ten-minutes.wav"
        # 44,100 Hz / stereo / float32 output exceeds the previous 200 MiB cap.
        size = 600 * 44100 * 2 * 4 + 92
        with source.open("wb") as handle:
            handle.truncate(size)
        self.assertGreater(size, 200 * 1024 * 1024)
        with patch.object(Path, "read_bytes", side_effect=AssertionError("must not load full WAV")):
            self.lab.runtime_file_path.value = str(source)
            self.lab.use_runtime_file_button.click()
        self.assertEqual(self.lab._audio_input_path, source)
        self.assertIn("201.9 MiB", self.lab.selected_audio.value)

    def test_path_validation_rejects_relative_empty_missing_and_oversize_inputs(self):
        for name, size in (("empty.wav", 0), ("large.wav", ui.MAX_UPLOAD_BYTES + 1), ("bad.txt", 4)):
            path = self.directory / name
            with path.open("wb") as handle:
                handle.truncate(size)
            with self.subTest(name=name), self.assertRaises(ValueError):
                ui.validate_audio_path(path)
        for path in ("song.wav", self.directory / "missing.wav"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                ui.validate_audio_path(path)

    def test_rescue_cell_is_opt_in_and_uses_top_level_colab_output(self):
        notebook = json.loads((PROJECT / "notebooks/vocal_fluctuation_lab.ipynb").read_text())
        source = next(cell["source"] for cell in notebook["cells"] if cell["cell_type"] == "code" and "import_audio_now =" in cell["source"])
        exec(compile(source, "upload-rescue-cell", "exec"), {})
        active = source.replace("import_audio_now = False", "import_audio_now = True")
        with self.assertRaises(RuntimeError):
            exec(compile(active, "upload-rescue-cell", "exec"), {})
        lab = Mock()
        exec(compile(active, "upload-rescue-cell", "exec"), {"vocal_lab_ready": True, "lab": lab})
        lab.upload_audio_from_colab.assert_called_once_with(use_output=False)


if __name__ == "__main__":
    unittest.main()
