"""Replay independently captured waits without duplicating or rolling back live data."""
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / 'scripts'))
import archive_wait_history as archive
import collect_wait_data as collector
import import_backup_observations as backup


class BackupImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.day = '2026-11-19'
        self.now = dt.datetime.fromisoformat('2026-11-20T00:10:00+09:00')
        self.activity = 'land-attraction-152'
        self.folder = self.root / 'backup-observations'
        self.folder.mkdir()
        self.path = self.root / 'observations.json'
        self.row = dict(date=self.day, activityId=self.activity, time=554, wait=25,
                        observedAt='2026-11-19T00:14:30Z', fetchedAt='2026-11-19T00:15:00Z',
                        source='queue-times')
        park = dict(id='land', activities=[{'id': self.activity}],
                    operatingCalendar={self.day: {'windows': [[540, 1260]]}})
        (self.root / 'catalogue.json').write_text(json.dumps({'parks': [park]}))

    def save_backup(self, *rows):
        (self.folder / (self.day + '.json')).write_text(json.dumps({
            'schemaVersion': 1, 'date': self.day, 'observations': rows}))

    def test_replay_across_midnight_with_actual_times_and_stable_retry(self):
        self.save_backup(self.row, dict(self.row, fetchedAt='2026-11-19T00:18:00Z'))
        self.assertTrue(backup.run(self.root, self.now))
        stored, = json.loads(self.path.read_text())
        self.assertEqual((stored['time'], stored['observedAt'], stored['openingMinute']), (554, self.row['observedAt'], 540))
        before = self.path.stat().st_mtime_ns
        self.assertFalse(backup.run(self.root, self.now))
        self.assertEqual(before, self.path.stat().st_mtime_ns)
        archive.update_archive(self.root, self.now.date())
        self.assertEqual(json.loads((self.root / 'history/2026-11.json').read_text()), [stored])

    def test_primary_wins_over_a_newer_backup_in_live_and_archived_buckets(self):
        primary = {**self.row, 'openingMinute': 540, 'weather': 'rain', 'temperature': 12}
        self.path.write_text(json.dumps([primary]))
        newer = dict(self.row, observedAt='2026-11-19T00:14:45Z', wait=40)
        self.save_backup(self.row, newer)
        self.assertFalse(backup.run(self.root, self.now))
        self.assertEqual(json.loads(self.path.read_text()), [primary])
        self.path.unlink()
        self.assertTrue(backup.run(self.root, self.now))
        stored, = json.loads(self.path.read_text())
        self.assertEqual((stored['wait'], stored['collector']), (40, 'watchdog'))
        archive.update_archive(self.root, self.now.date())
        month = self.root / 'history/2026-11.json'
        self.assertEqual(json.loads(month.read_text()), [stored])
        for original in (primary, {k: v for k, v in primary.items() if k != 'observedAt'}):
            self.assertEqual(collector.merge_observations([stored], [original], self.now.date()), [original])
            self.assertEqual(collector.merge_observations([original], [stored], self.now.date()), [original])
        self.path.write_text(json.dumps([primary]))
        archive.update_archive(self.root, self.now.date())
        archived, = json.loads(month.read_text())
        self.assertEqual((archived['wait'], archived['weather'], archived['temperature']), (25, 'rain', 12))
        self.assertNotIn('collector', archived)
        self.path.write_text(json.dumps([stored]))
        archive.update_archive(self.root, self.now.date())
        self.assertEqual(json.loads(month.read_text()), [archived])

    def test_invalid_rows_do_not_create_or_overwrite_observations(self):
        self.save_backup(
            dict(self.row, fetchedAt='2026-11-19T00:29:31Z'),
            dict(self.row, fetchedAt='2026-11-19T00:14:29Z'),
            dict(self.row, observedAt='2026-11-19T09:14:30'),
            dict(self.row, time=555), dict(self.row, date='2026-11-18'),
            dict(self.row, source='themeparks-wiki'), dict(self.row, activityId='land-unknown'),
            dict(self.row, wait=True), dict(self.row, wait=601), dict(self.row, isOpen=False))
        self.assertFalse(backup.run(self.root, self.now))
        self.assertFalse(self.path.exists())
        self.save_backup(self.row)
        self.assertFalse(backup.run(self.root, dt.datetime.fromisoformat('2026-11-19T00:14:45+00:00')))
        self.assertFalse(backup.run(self.root, self.now + dt.timedelta(days=61)))


if __name__ == '__main__':
    unittest.main()
