"""実測値の比較条件、重複、自分自身との比較を確認します。"""

from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab import reference_db as db


def analysis(number=1, slope=-1.0, start=10.0, end=100.0, **changes):
    value = {
        "schema_version": "vocal-fluctuation-result-v1",
        "method_id": "rms-welch-v1",
        "analysis_signature": "test:0.2-5Hz;RMS50ms;hop10ms",
        "quality": {"usable_for_comparison": True},
        "features": {"slope": slope, "envelope_cv": 0.5,
                     "low_band_fraction": 0.4, "spectral_flatness": 0.25},
        "metadata": {"source_sha256": f"{number:064x}", "start_seconds": start,
                     "end_seconds": end, "separation_method": "demucs:htdemucs",
                     "model_version": "4.1.0", "source_hash_scope": "original-file"},
    }
    value.update(changes)
    return value


class ReferenceDatabaseTests(unittest.TestCase):
    def test_an_empty_database_does_not_invent_an_artist(self):
        self.assertEqual(db.compare_reference(analysis(), db.empty_database()), [])

    def test_add_and_round_trip_preserve_the_caller_and_only_store_features(self):
        original = db.empty_database()
        result = analysis()
        result["series"] = {"envelope": [1, 2, 3]}
        snapshot = deepcopy(result)
        saved = db.add_reference(original, result, "歌手A", "曲A", notes="自分で測った区間")
        self.assertEqual(original, db.empty_database())
        self.assertEqual(result, snapshot)
        self.assertNotIn("series", saved["references"][0])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "database.json"
            neighbour = Path(directory) / "database.json.tmp"
            neighbour.write_text("keep this unrelated file")
            self.assertEqual(db.save_database(saved, path), path)
            self.assertEqual(db.load_database(path), saved)
            self.assertEqual(neighbour.read_text(), "keep this unrelated file")

    def test_same_clip_cannot_be_added_twice_even_with_another_artist_name(self):
        saved = db.add_reference(db.empty_database(), analysis(), "Artist A", "Track A")
        with self.assertRaisesRegex(ValueError, "すでに登録"):
            db.add_reference(saved, analysis(), "Artist B", "Track B")

    def test_same_original_file_can_supply_different_measured_intervals(self):
        saved = db.add_reference(db.empty_database(), analysis(start=0, end=90), "A", "Track")
        saved = db.add_reference(saved, analysis(start=90, end=180), "A", "Track")
        ranking = db.compare_reference(analysis(2), saved)
        self.assertEqual((ranking[0]["tracks_count"], ranking[0]["clips_count"]), (1, 2))

    def test_selected_clip_fingerprint_is_not_counted_twice_under_other_timestamps(self):
        first = analysis()
        first["metadata"]["source_hash_scope"] = "selected-clip"
        second = deepcopy(first)
        second["metadata"].update(start_seconds=110, end_seconds=200)
        saved = db.add_reference(db.empty_database(), first, "A", "Track")
        with self.assertRaisesRegex(ValueError, "すでに登録"):
            db.add_reference(saved, second, "A", "Track")
        self.assertEqual(db.compare_reference(second, saved), [])

    def test_a_query_is_never_compared_with_its_own_clip(self):
        saved = db.add_reference(db.empty_database(), analysis(), "A", "Track A")
        saved = db.add_reference(saved, analysis(2, slope=-1.2), "B", "Track B")
        ranking = db.compare_reference(analysis(), saved)
        self.assertEqual([row["artist"] for row in ranking], ["B"])

    def test_same_method_signature_and_preprocessing_are_required(self):
        saved = db.add_reference(db.empty_database(), analysis(2), "A", "Track")
        for field, value in [("analysis_signature", "different band"),
                             ("separation_method", "already-vocals"),
                             ("model_version", "different version")]:
            query = analysis()
            if field in query:
                query[field] = value
            else:
                query["metadata"][field] = value
            with self.subTest(field=field):
                self.assertEqual(db.compare_reference(query, saved), [])

    def test_legacy_spectral_slope_and_low_quality_results_are_refused(self):
        for changes in [{"method_id": "student-waveform-fft-100-8000-hz"},
                        {"quality": {"usable_for_comparison": False}},
                        {"quality": {"usable_for_comparison": 1}}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                db.add_reference(db.empty_database(), analysis(**changes), "A", "Track")

    def test_ranking_uses_scaled_feature_distance_without_identity_percentages(self):
        saved = db.empty_database()
        for number, artist, slope in [(2, "Further", -2), (3, "Nearer", -1.1)]:
            saved = db.add_reference(saved, analysis(number, slope=slope), artist, "Track")
        ranking = db.compare_reference(analysis(), saved)
        self.assertEqual([row["artist"] for row in ranking], ["Nearer", "Further"])
        self.assertAlmostEqual(ranking[0]["distance"], 0.1)
        self.assertNotIn("identity", ranking[0])
        self.assertIn("一致率ではありません", ranking[0]["comparison_basis"])

    def test_multiple_windows_of_one_song_do_not_outweigh_another_song(self):
        saved = db.empty_database()
        for number in range(2, 12):
            saved = db.add_reference(saved, analysis(number, slope=0), "A", "Many windows")
        saved = db.add_reference(saved, analysis(12, slope=-2), "a", "One window")
        ranking = db.compare_reference(analysis(), saved)
        self.assertEqual(len(ranking), 1)
        self.assertEqual(ranking[0]["tracks_count"], 2)
        self.assertEqual(ranking[0]["clips_count"], 11)
        self.assertAlmostEqual(ranking[0]["feature_means"]["slope"], -1)
        self.assertAlmostEqual(ranking[0]["distance"], 0)

    def test_nonfinite_features_invalid_intervals_and_missing_provenance_are_refused(self):
        cases = []
        for invalid in [float("nan"), float("inf"), True, "-1", 10**1000, 1e200]:
            result = analysis()
            result["features"]["slope"] = invalid
            cases.append(result)
        for start, end in [(-1, 90), (1, 1), (100, 1), (True, 90)]:
            cases.append(analysis(start=start, end=end))
        cases.append(analysis(metadata={}))
        result = analysis()
        result["features"]["spectral_flatness"] = 1.1
        cases.append(result)
        for result in cases:
            with self.subTest(result=result), self.assertRaises(ValueError):
                db.add_reference(db.empty_database(), result, "A", "Track")

    def test_invalid_names_limits_ids_and_duplicate_database_rows_are_refused(self):
        for artist, track in [("", "Track"), ("A", " "), (False, "Track")]:
            with self.assertRaises(ValueError):
                db.add_reference(db.empty_database(), analysis(), artist, track)
        saved = db.add_reference(db.empty_database(), analysis(2), "A", "Track")
        for limit in [0, -1, 101, 1.2, True]:
            with self.assertRaises(ValueError):
                db.compare_reference(analysis(), saved, limit=limit)
        bad = deepcopy(saved)
        bad["references"][0]["id"] = "edited"
        with self.assertRaises(ValueError):
            db.validate_database(bad)
        saved["references"].append(deepcopy(saved["references"][0]))
        with self.assertRaises(ValueError):
            db.validate_database(saved)

    def test_loading_refuses_invalid_json_large_files_and_legacy_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "database.json"
            for content in ["{", json.dumps({"schema_version": "student-legacy-results-v1"}),
                            " " * (db.MAX_DATABASE_BYTES + 1)]:
                path.write_text(content)
                with self.assertRaises(ValueError):
                    db.load_database(path)

    def test_already_vocal_inputs_can_omit_model_version(self):
        result = analysis()
        result["metadata"].update(separation_method="already-vocals", model_version=None)
        saved = db.add_reference(db.empty_database(), result, "A", "Track")
        query = analysis(2)
        query["metadata"].update(separation_method="already-vocals", model_version="")
        self.assertEqual(db.compare_reference(query, saved)[0]["artist"], "A")


if __name__ == "__main__":
    unittest.main()
