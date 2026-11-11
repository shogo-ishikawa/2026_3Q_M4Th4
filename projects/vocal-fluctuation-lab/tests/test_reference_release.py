"""実際に同梱する参考値と、比較できる範囲の整合を確認します。"""
import json
from pathlib import Path
import sys
import unittest

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from vocal_lab import reference_db as db


class ReferenceReleaseTests(unittest.TestCase):
    def setUp(self):
        self.database = db.load_database(PROJECT / "data/reference_database.json")
        self.manifest = json.loads((PROJECT / "data/reference_measurements.json").read_text())

    def test_only_records_approved_for_comparison_are_in_the_default_database(self):
        declared = {(r["artist"], r["track"]) for r in self.manifest["records"] if r["include_in_comparison"]}
        actual = {(r["artist"], r["track"]) for r in self.database["references"]}
        self.assertTrue(actual)
        self.assertEqual(actual, declared)
        self.assertFalse(self.manifest["audio_included"])
        self.assertFalse(self.manifest["full_envelope_included"])

    def test_the_default_database_uses_one_fixed_band_without_changing_separation_history(self):
        by_title = {(r["artist"], r["track"]): r for r in self.manifest["records"]}
        signatures = set()
        for record in self.database["references"]:
            report = by_title[(record["artist"], record["track"])]
            self.assertEqual(report["fixed_config"], {"low_hz": .2, "high_hz": 20., "segment_seconds": 20., "auto_band": False})
            self.assertEqual((report["fixed_fit"]["band_low_hz"], report["fixed_fit"]["band_high_hz"], report["fixed_fit"]["segment_seconds"]), (.2, 20., 20.))
            self.assertEqual(record["features"]["slope"], report["fixed_fit"]["slope"])
            self.assertEqual(record["metadata"]["separation_method"], report["separation_method"])
            self.assertEqual(record["metadata"]["model_version"], report["model_version"])
            self.assertNotIn("series", record)
            self.assertNotIn("spectrum", record)
            signatures.add(record["analysis_signature"])
        self.assertEqual(len(signatures), 1)

    def test_each_saved_record_matches_its_own_processing_group_and_excludes_itself(self):
        records = self.database["references"]
        for query in records:
            expected = [r for r in records if r["id"] != query["id"] and
                        (r["metadata"]["separation_method"], r["metadata"]["model_version"]) ==
                        (query["metadata"]["separation_method"], query["metadata"]["model_version"])]
            ranking = db.compare_reference(query, self.database, limit=100)
            self.assertEqual({r["artist"] for r in ranking}, {r["artist"] for r in expected})
            coverage = db.comparison_coverage(query, self.database)
            self.assertEqual(coverage["eligible"]["records"], len(expected))
            self.assertEqual(coverage["self_excluded"], 1)

    def test_held_out_records_cannot_be_loaded_as_a_comparison_database(self):
        held = json.loads((PROJECT / "data/reference_holdout.json").read_text())
        declared = {(r["artist"], r["track"]) for r in self.manifest["records"] if not r["include_in_comparison"]}
        self.assertEqual({(r["artist"], r["track"]) for r in held["records"]}, declared)
        self.assertTrue(all(r["holdout_reason"] for r in held["records"]))
        with self.assertRaises(ValueError):
            db.validate_database(held)


if __name__ == "__main__":
    unittest.main()
