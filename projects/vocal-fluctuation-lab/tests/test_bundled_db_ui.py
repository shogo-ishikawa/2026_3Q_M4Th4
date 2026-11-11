"""同梱DBの読み込みと、実際の照合対象の件数を確認します。"""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab import notebook_ui as ui, reference_db as db


def analysis(number=99, processing="already-vocals"):
    return {"schema_version": db.RESULT_SCHEMA, "method_id": db.METHOD_ID,
            "analysis_signature": "test-fixed-0.2-20Hz",
            "quality": {"usable_for_comparison": True},
            "features": {"slope": -1.1, "envelope_cv": .5, "low_band_fraction": .4, "spectral_flatness": .25},
            "metadata": {"source_sha256": f"{number:064x}", "start_seconds": 0, "end_seconds": 90,
                         "source_hash_scope": "selected-clip", "separation_method": processing,
                         "model_version": "" if processing == "already-vocals" else "4.1.0"}}


def six_tracks():
    value = db.empty_database()
    for number in range(1, 7):
        processing = "already-vocals" if number <= 3 else "demucs:htdemucs"
        value = db.add_reference(value, analysis(number, processing), "歌手" + str(number), "曲" + str(number))
    return value


class CoverageTests(unittest.TestCase):
    def test_counts_and_rankings_use_the_same_strict_conditions(self):
        data = six_tracks()
        for processing in ("already-vocals", "demucs:htdemucs"):
            query = analysis(processing=processing)
            counts = db.comparison_coverage(query, data)
            ranking = db.compare_reference(query, data, limit=100)
            self.assertEqual(counts["total"], {"records": 6, "tracks": 6, "artists": 6})
            self.assertEqual(counts["eligible"]["artists"], len(ranking))
            self.assertEqual(counts["eligible"]["records"], 3)
            self.assertEqual(counts["processing_excluded"], 3)

    def test_self_and_different_settings_are_not_counted_as_available(self):
        data = six_tracks()
        query = analysis(1)
        counts = db.comparison_coverage(query, data)
        self.assertEqual(counts["self_excluded"], 1)
        self.assertEqual(counts["eligible"]["tracks"], 2)
        query["analysis_signature"] = "different-auto-band"
        counts = db.comparison_coverage(query, data)
        self.assertEqual(counts["settings_excluded"], 6)
        self.assertEqual(counts["eligible"]["tracks"], 0)
        self.assertEqual(db.compare_reference(query, data), [])

    def test_multiple_clips_of_one_track_do_not_inflate_track_count(self):
        data = six_tracks()
        data = db.add_reference(data, analysis(7), "歌手1", "曲1")
        counts = db.comparison_coverage(None, data)
        self.assertEqual(counts["total"], {"records": 7, "tracks": 6, "artists": 6})
        self.assertIsNone(counts["eligible"])


class BundledDatabaseUITests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "reference_database.json"
        db.save_database(six_tracks(), self.path)

    def launch(self, **kwargs):
        with patch.object(ui, "BUNDLED_DATABASE_PATH", self.path):
            lab = ui.VocalNotebookUI(Path(self.folder.name) / "runs", pipeline=Mock(), **kwargs)
        lab.result_output.clear_output = Mock()
        return lab

    def test_default_launch_loads_bundled_database_and_reports_coverage(self):
        lab = self.launch()
        self.assertEqual(len(lab.database["references"]), 6)
        self.assertIn("同梱の比較DBを読み込みました", lab.db_status.value)
        self.assertIn("6曲・6アーティスト", lab.db_coverage.value)
        self.assertIn("固定", lab.db_coverage.value)
        lab.bundle = {"analysis": analysis()}
        lab._show_comparison()
        self.assertIn("今回比較できるのは3曲", lab.db_coverage.value)
        self.assertIn("歌声分離方法・モデルの違い：3区間", lab.db_coverage.value)
        self.assertIn("同梱の比較DBを読み込みました", lab.db_status.value)

    def test_injected_database_api_is_isolated_from_bundled_file(self):
        lab = self.launch(database=db)
        self.assertEqual(lab.database, db.empty_database())
        self.assertIn("0曲", lab.db_coverage.value)
        self.assertNotIn("同梱の比較DBを読み込みました", lab.db_status.value)

    def test_missing_or_invalid_bundle_falls_back_with_an_explicit_message(self):
        self.path.unlink()
        lab = self.launch()
        self.assertEqual(lab.database, db.empty_database())
        self.assertIn("見つかりません", lab.db_status.value)
        self.path.write_text("{malformed-json")
        lab = self.launch()
        self.assertEqual(lab.database, db.empty_database())
        self.assertIn("読み込めませんでした", lab.db_status.value)
        self.assertNotIn("同梱の比較DBを読み込みました", lab.db_status.value)

    def test_result_reset_clears_query_coverage_but_keeps_database_and_notices(self):
        lab = self.launch()
        lab.bundle = {"analysis": analysis()}
        lab._show_comparison()
        notice = lab.db_status.value
        lab._reset_results()
        self.assertIn("6曲・6アーティスト", lab.db_coverage.value)
        self.assertNotIn("今回比較できる", lab.db_coverage.value)
        self.assertEqual(lab.db_status.value, notice)
        self.assertEqual(len(lab.database["references"]), 6)

    def test_import_and_add_messages_survive_coverage_updates(self):
        lab = self.launch(database=db)
        content = self.path.read_bytes()
        lab._import_database({"new": ({"name": "references.json", "content": content},)})
        self.assertIn("比較DBを読み込みました", lab.db_status.value)
        self.assertIn("6曲", lab.db_coverage.value)
        lab.bundle = {"analysis": analysis()}
        lab.artist.value, lab.track.value = "追加歌手", "追加曲"
        lab._add_reference()
        self.assertIn("登録しました", lab.db_status.value)
        self.assertIn("7曲", lab.db_coverage.value)
        self.assertIn("同じ音源・同じ区間：1区間", lab.db_coverage.value)


if __name__ == "__main__":
    unittest.main()
