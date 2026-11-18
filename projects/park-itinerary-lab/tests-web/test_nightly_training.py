"""Regressions for delayed schedules and failed history training."""
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import nightly_wait_training as nightly


def model_for(day):
    return {'parks': [{'parkId': name, 'bootstrap': {'lastObservedDate': day}}
                      for name in ('land', 'sea')]}


class NightlyTrainingTest(unittest.TestCase):
    def test_closed_day_uses_japan_time_and_the_actual_start_of_the_job(self):
        now = dt.datetime(2026, 11, 18, 12, 54, tzinfo=dt.timezone.utc)
        self.assertEqual(str(nightly.closed_day(now)), '2026-11-17')
        self.assertEqual(str(nightly.closed_day(now + dt.timedelta(minutes=1))), '2026-11-18')
        self.assertEqual(str(nightly.closed_day(now + dt.timedelta(hours=12))), '2026-11-18')

    def test_missed_evening_archive_catches_up_once_and_keeps_newer_observations(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            observations = [{'source': 'queue-times', 'date': date, 'activityId': 'land-ride',
                             'time': 550, 'wait': 10} for date in ('2026-11-17', '2026-11-18')]
            (data / 'observations.json').write_text(json.dumps(observations))
            (data / 'wait-model.json').write_text('{}')
            def fit(args, check):
                day = args[args.index('--end-date') + 1]
                model = Path(args[args.index('--output-model') + 1])
                model.write_text(json.dumps(model_for(day)))
            now = dt.datetime(2026, 11, 18, 11, tzinfo=nightly.JST)
            with patch.object(nightly.subprocess, 'run', side_effect=fit) as runner:
                nightly.run(data, now)
                self.assertEqual(json.loads((data / 'training-state.json').read_text())['completedThrough'], '2026-11-17')
                self.assertEqual(len(json.loads((data / 'history' / '2026-11.json').read_text())), 2)
                nightly.run(data, now + dt.timedelta(minutes=15))
                self.assertEqual(runner.call_count, 1)
                nightly.run(data, now, force=True)
                self.assertEqual(runner.call_count, 2)
                nightly.run(data, now.replace(hour=22))
                self.assertEqual(runner.call_count, 3)
                self.assertEqual(json.loads((data / 'training-state.json').read_text())['completedThrough'], '2026-11-18')

    def test_provider_failure_retains_previous_success_and_bounds_retries(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            marker = data / 'training-state.json'
            marker.write_text(json.dumps({'completedThrough': '2026-11-16'}))
            now = dt.datetime(2026, 11, 18, 4, tzinfo=nightly.JST)
            failure = subprocess.CalledProcessError(1, 'bootstrap_wait_history')
            with patch.object(nightly.subprocess, 'run', side_effect=failure) as runner:
                with self.assertRaises(subprocess.CalledProcessError):
                    nightly.run(data, now)
                nightly.run(data, now + dt.timedelta(hours=5, minutes=59))
                self.assertEqual(runner.call_count, 1)
                with self.assertRaises(subprocess.CalledProcessError):
                    nightly.run(data, now + dt.timedelta(hours=6))
                self.assertEqual(runner.call_count, 2)
            self.assertEqual(json.loads(marker.read_text())['completedThrough'], '2026-11-16')

    def test_fallback_or_missing_park_cannot_mask_stale_or_failed_new_attempt(self):
        model = model_for('2026-11-17')
        park = model['parks'][0]
        park['lastBootstrapAttempt'] = {'lastObservedDate': '2026-11-16'}
        self.assertFalse(nightly.training_complete(model, '2026-11-17'))
        park['lastBootstrapAttempt'] = {'lastObservedDate': '2026-11-17', 'failedDays': 3}
        self.assertFalse(nightly.training_complete(model, '2026-11-17'))
        park['lastBootstrapAttempt']['failedDays'] = 0
        self.assertTrue(nightly.training_complete(model, '2026-11-17'))
        self.assertFalse(nightly.training_complete({'parks': [park]}, '2026-11-17'))


if __name__ == '__main__':
    unittest.main()
