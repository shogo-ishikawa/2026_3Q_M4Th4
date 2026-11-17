"""Independent examples for current observation collection and cold-start training."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collector", PROJECT / "scripts/collect_wait_data.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.park = {"id": "land", "activities": [{"id": "land-a"}], "events": [{"id": "christmas", "startDate": "2026-11-01", "endDate": "2026-12-25"}]}
        self.mapping = {"providerParkId": 274, "rides": {"1": "land-a"}}
        self.ride = {"id": 1, "name": "Ride A", "wait_time": 25, "is_open": True, "last_updated": "2026-11-17T03:00:00Z"}
        self.fetched = "2026-11-17T03:05:00Z"

    def snapshot(self, **changes):
        return collector.normalise({"lands": [{"rides": [{**self.ride, **changes}]}]}, self.park, self.mapping, self.fetched)

    def test_mapping_and_jst_conversion(self):
        snapshot = self.snapshot()
        self.assertEqual(snapshot["rides"][0]["activityId"], "land-a")
        rows = collector.to_observations(snapshot, self.park, "sun")
        self.assertEqual((rows[0]["date"], rows[0]["time"], rows[0]["event"]), ("2026-11-17", 720, "christmas"))

    def test_closed_status_not_a_zero_wait_observation(self):
        self.assertEqual(collector.to_observations(self.snapshot(is_open=False, wait_time=0), self.park), [])

    def test_stale_or_future_provider_timestamps_not_used_for_training(self):
        for timestamp in ["2026-11-17T02:00:00Z", "2026-11-17T04:00:00Z"]:
            self.assertEqual(collector.to_observations(self.snapshot(last_updated=timestamp), self.park), [])

    def test_invalid_api_types_rejected(self):
        for changes in [{"wait_time": -1}, {"wait_time": True}, {"is_open": "true"}, {"last_updated": "bad"}, {"last_updated": "2026-11-17T03:00:00"}, {"id": -1}]:
            with self.assertRaises(ValueError):
                self.snapshot(**changes)

    def test_half_hour_dedup_and_retention(self):
        row = {"date": "2026-11-17", "activityId": "land-a", "time": 720, "wait": 20}
        rows = collector.merge_observations([row, {**row, "date": "2026-01-01"}], [{**row, "time": 725, "wait": 30}], dt.date(2026, 11, 17))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["wait"], 30)

    def test_wrapper_trains_canonical_browser_model_without_fabricated_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "observations.json").write_text("[]")
            subprocess.run(["python", str(PROJECT / "scripts/train_wait_model.py"), "--observations", str(root / "observations.json"), "--output", str(root / "model.json"), "--before-date", "2026-11-17"], check=True, capture_output=True, text=True)
            model = json.loads((root / "model.json").read_text())
            self.assertEqual(len(model["parks"]), 2)
            self.assertTrue(all(park["status"] == "insufficient-data" and park["samples"] == 0 and park["validation"] is None for park in model["parks"]))


if __name__ == "__main__":
    unittest.main()
