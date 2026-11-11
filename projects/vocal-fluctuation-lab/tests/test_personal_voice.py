"""自分の録音向けの設定と、現在の比較DBの一覧を確認します。"""
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab import notebook_ui as ui, reference_db as db


def analysis(number=99, processing="already-vocals"):
    return {"schema_version": db.RESULT_SCHEMA, "method_id": db.METHOD_ID,
            "analysis_signature": "test-fixed-0.2-20Hz", "status": "near",
            "quality": {"usable_for_comparison": True},
            "features": {"slope": -1.1, "envelope_cv": .5, "low_band_fraction": .4, "spectral_flatness": .25},
            "metadata": {"source_sha256": f"{number:064x}", "start_seconds": 0, "end_seconds": 90,
                         "source_hash_scope": "selected-clip", "separation_method": processing,
                         "model_version": "" if processing == "already-vocals" else "4.1.0"}}


def catalogue():
    value = db.add_reference(db.empty_database(), analysis(1), "声のみの歌手", "曲A")
    return db.add_reference(value, analysis(2, "demucs:htdemucs"), "分離した歌手", "曲B")


class PersonalVoiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.pipeline = Mock()
        self.lab = ui.VocalNotebookUI(self.folder.name, pipeline=self.pipeline, database=db)
        self.lab.result_output.clear_output = Mock()
        self.lab.database = catalogue()
        self.lab._show_comparison()

    def seed_result(self):
        self.lab.bundle = {"analysis": analysis()}
        self.lab.results_zip = Path("old-results.zip")
        self.lab.comparison_output.value = "以前の比較結果"
        for button in (self.lab.result_download, self.lab.raw_vocals_download,
                       self.lab.vocals_download, self.lab.add_reference_button):
            button.disabled = False

    def assert_result_cleared(self):
        self.assertIsNone(self.lab.bundle)
        self.assertIsNone(self.lab.results_zip)
        self.assertEqual(self.lab.comparison_output.value, "")
        self.lab.result_output.clear_output.assert_called_with(wait=False)
        for button in (self.lab.result_download, self.lab.raw_vocals_download,
                       self.lab.vocals_download, self.lab.add_reference_button):
            self.assertTrue(button.disabled)

    def test_preset_keeps_selected_recording_names_and_seconds_but_clears_old_results(self):
        source = Path(self.folder.name) / "my-voice.wav"
        source.write_bytes(b"example-recording")
        self.lab.runtime_file_path.value = str(source)
        self.lab.use_runtime_file_button.click()
        selected_audio = self.lab.selected_audio.value
        self.lab.mode.value = "youtube"
        self.lab.start.value, self.lab.end.value = 30, 150
        self.lab.artist.value, self.lab.track.value = "自分", "録音1"
        self.lab.trim_edges.value, self.lab.remove_internal.value = False, True
        self.lab.threshold_db.value, self.lab.min_silence_seconds.value = -60, 2
        database_before = deepcopy(self.lab.database)
        self.seed_result()
        self.lab.voice_preset_button.click()
        self.assertEqual(self.lab.mode.value, "file")
        self.assertTrue(self.lab.vocals_only.value)
        self.assertTrue(self.lab.whole_track.value)
        self.assertEqual(self.lab.analysis_mode.value, "auto")
        self.assertEqual(self.lab._audio_input_path, source)
        self.assertEqual(self.lab._audio_input_route, "path")
        self.assertEqual(self.lab.selected_audio.value, selected_audio)
        self.assertEqual((self.lab.start.value, self.lab.end.value), (30, 150))
        self.assertEqual((self.lab.artist.value, self.lab.track.value), ("自分", "録音1"))
        silence = self.lab._silence_config()
        self.assertTrue(silence.trim_edges)
        self.assertFalse(silence.remove_internal)
        self.assertEqual((silence.threshold_db, silence.min_silence_seconds), (-40, .5))
        self.assertEqual(self.lab.database, database_before)
        self.assert_result_cleared()
        self.pipeline.assert_not_called()

    def test_changing_goal_applies_new_mode_and_clears_previous_goal_result(self):
        self.lab.voice_goal.value = "fixed"
        self.assertEqual(self.lab.analysis_mode.value, "fixed")
        self.assertFalse(self.lab._analysis_config().auto_band)
        self.assertTrue(self.lab.vocals_only.value)
        self.seed_result()
        self.lab.voice_goal.value = "auto"
        self.assertTrue(self.lab._analysis_config().auto_band)
        self.assertIn("自動モード", self.lab.status.value)
        self.assert_result_cleared()

    def test_preset_analysis_uses_whole_recording_and_keeps_demucs_records_ineligible(self):
        source = Path(self.folder.name) / "my-voice.wav"
        source.write_bytes(b"example-recording")
        self.lab.runtime_file_path.value = str(source)
        self.lab.use_runtime_file_button.click()
        self.lab.voice_goal.value = "fixed"

        def process(*args, **kwargs):
            self.assertTrue(self.lab.voice_goal.disabled)
            self.assertTrue(self.lab.voice_preset_button.disabled)
            self.assertIn("歌声抽出モデルは使いません", self.lab.status.value)
            self.assertEqual(args[1:3], (0, None))
            self.assertEqual(kwargs["source_kind"], "file")
            self.assertTrue(kwargs["already_vocals"])
            config = kwargs["config"]
            self.assertEqual((config.auto_band, config.low_hz, config.high_hz, config.segment_seconds),
                             (False, .2, 20, 20))
            return {"analysis": analysis(), "clip_path": str(source), "vocals_path": str(source)}

        self.pipeline.side_effect = process
        with patch.object(ui, "export_results", return_value=Path(self.folder.name) / "result.zip"), \
             patch.object(self.lab, "_show_result"):
            self.lab.analyse_button.click()
        self.pipeline.assert_called_once()
        self.assertIn("声のみの歌手", self.lab.comparison_output.value)
        self.assertNotIn("分離した歌手", self.lab.comparison_output.value)
        self.assertIn("今回比較できるのは1曲", self.lab.db_coverage.value)
        self.assertIn("歌声分離方法・モデルの違い：1区間", self.lab.db_coverage.value)
        self.assertFalse(self.lab.voice_goal.disabled)
        self.assertFalse(self.lab.voice_preset_button.disabled)

    def test_transfer_blocks_preset_without_clearing_input_or_result(self):
        self.lab._audio_upload_busy = True
        self.lab.mode.value = "youtube"
        self.seed_result()
        self.lab.voice_preset_button.click()
        self.assertEqual(self.lab.mode.value, "youtube")
        self.assertIsNotNone(self.lab.bundle)
        self.assertIn("転送・解析が終わってから", self.lab.status.value)

    def test_colab_upload_disables_preset_until_transfer_completes(self):
        def receive(target_dir):
            self.assertTrue(self.lab.voice_goal.disabled)
            self.assertTrue(self.lab.voice_preset_button.disabled)
            path = Path(target_dir) / "my-voice.wav"
            path.write_bytes(b"example-recording")
            return {str(path): path.read_bytes()}

        self.lab._colab_files = SimpleNamespace(upload=receive)
        path = self.lab.upload_audio_from_colab(use_output=False)
        self.assertEqual(path.name, "my-voice.wav")
        self.assertEqual(self.lab._audio_input_path, path)
        self.assertFalse(self.lab.voice_goal.disabled)
        self.assertFalse(self.lab.voice_preset_button.disabled)


class DatabaseCatalogueTests(unittest.TestCase):
    def test_catalogue_groups_intervals_across_processing_records_and_escapes_names(self):
        data = catalogue()
        data = db.add_reference(data, analysis(3), "声のみの歌手", "曲A")
        data = db.add_reference(data, analysis(5, "demucs:htdemucs"), "声のみの歌手", "曲A")
        data = db.add_reference(data, analysis(4, "<unknown>"), "<script>x</script>", "A&B")
        rendered = ui.database_catalogue_html(data)
        self.assertEqual(rendered.count("声のみの歌手"), 1)
        self.assertIn("<td>3</td>", rendered)
        self.assertEqual(rendered.count("<th>"), 3)
        self.assertNotIn("歌声の前処理</th>", rendered)
        self.assertNotIn("Demucs / htdemucs", rendered)
        self.assertIn("&lt;script&gt;x&lt;/script&gt;", rendered)
        self.assertIn("A&amp;B", rendered)
        self.assertNotIn("&lt;unknown&gt;", rendered)
        self.assertIn("数値の解析結果", rendered)
        self.assertIn("音声ファイルや音楽データは含みません", rendered)
        self.assertNotIn("<script>", rendered)

    def test_current_session_list_refreshes_after_import_add_and_failed_import(self):
        with tempfile.TemporaryDirectory() as folder:
            lab = ui.VocalNotebookUI(folder, pipeline=Mock(), database=db)
            self.assertIn("現在の比較DBは空", lab.db_catalogue.value)
            self.assertEqual(lab.db_catalogue_options.get_title(0), "現在のDBに登録された解析結果")
            self.assertIsNone(lab.db_catalogue_options.selected_index)
            path = db.save_database(catalogue(), Path(folder) / "saved.json")
            lab._import_database({"new": ({"name": "saved.json", "content": path.read_bytes()},)})
            self.assertIn("声のみの歌手", lab.db_catalogue.value)
            self.assertIn("分離した歌手", lab.db_catalogue.value)
            self.assertNotIn("現在の比較DBは空", lab.db_catalogue.value)
            lab.bundle = {"analysis": analysis()}
            lab.artist.value, lab.track.value = "追加した自分", "録音1"
            lab.add_reference_button.disabled = False
            lab.add_reference_button.click()
            self.assertIn("追加した自分", lab.db_catalogue.value)
            self.assertIn("3曲", lab.db_coverage.value)
            previous_list = lab.db_catalogue.value
            lab._import_database({"new": ({"name": "broken.json", "content": b"{broken"},)})
            self.assertIn("読み込めませんでした", lab.db_status.value)
            self.assertEqual(lab.db_catalogue.value, previous_list)


if __name__ == "__main__":
    unittest.main()
