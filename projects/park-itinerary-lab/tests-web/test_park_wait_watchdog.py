"""Independent capture, retry, and close-day decisions without live credentials."""
import argparse
import base64
import datetime as dt
import json
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / 'scripts'))
import park_wait_watchdog as watch

DAY = '2026-11-19'
NOW = dt.datetime.fromisoformat('2026-11-19T04:15:00+00:00')
MAP = json.loads((PROJECT / 'web/data/queue-times-map.json').read_text())['parks']


def row(park, minute=10):
    return {'source': 'queue-times', 'activityId': park + '-ride', 'date': DAY, 'time': 780 + minute,
            'observedAt': f'{DAY}T04:{minute:02d}:00Z', 'fetchedAt': DAY + 'T04:15:00Z', 'wait': 10}


def metadata(rows):
    doc = {'schemaVersion': 1, 'date': DAY, 'observations': rows}
    return {'sha': 'sha-1', 'encoding': 'base64', 'content': base64.b64encode(watch.compact(doc)).decode()}


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.spool = Path(directory.name)
        self.git = watch.GitHub('owner/repo', 'test-placeholder')

    def test_local_receipt_survives_failed_upload_then_retry(self):
        r = row('land')
        watch.persist(self.spool, [r])
        github = Mock()
        github.backup.side_effect = OSError('network down')
        with self.assertRaises(OSError):
            watch.flush(self.spool, github)
        saved, = self.spool.glob('*.json')
        self.assertEqual(json.loads(saved.read_text()), [r])
        github.backup.side_effect = None
        watch.flush(self.spool, github)
        github.backup.assert_called_with(DAY, [r])
        self.assertFalse(saved.exists())

    def test_cas_reloads_changed_head_and_replay_uses_no_new_commit(self):
        a, b = row('land'), row('sea')
        conflict = HTTPError('https://api.github.com/', 409, 'conflict', None, None)
        with patch.object(self.git, 'read_file', side_effect=[None, metadata([a]), metadata([a, b])]), \
                patch.object(self.git, 'request', side_effect=[conflict, {}]) as put, patch.object(watch.time, 'sleep'):
            self.git.backup(DAY, [b])
            self.git.backup(DAY, [b])
        self.assertEqual(put.call_count, 2)
        path, method, body = put.call_args.args
        self.assertEqual((method, path), ('PUT', '/contents/backup-observations/' + DAY + '.json'))
        self.assertEqual((body['sha'], body['branch']), ('sha-1', 'park-wait-data'))
        self.assertEqual(json.loads(base64.b64decode(body['content']))['observations'], [a, b])

    def test_large_backup_uses_blob_from_original_contents_sha(self):
        a, b = row('land'), row('sea')
        with patch.object(self.git, 'read_file', return_value={'encoding': 'none', 'sha': 'file-sha'}), \
                patch.object(self.git, 'request', side_effect=[metadata([a]), {}]) as api:
            self.git.backup(DAY, [b])
        self.assertEqual(api.call_args_list[0].args, ('/git/blobs/file-sha',))
        self.assertEqual(api.call_args.args[2]['sha'], 'file-sha')

    def test_capture_keeps_one_good_park_when_other_fails_and_token_missing(self):
        catalogue = self.spool / 'catalogue.json'
        parks = [{'id': park, 'activities': [{'id': activity} for activity in MAP[park]['rides'].values()]}
                 for park in ('land', 'sea')]
        catalogue.write_text(json.dumps({'parks': parks}))
        provider_id = int(next(iter(MAP['land']['rides'])))
        payload = {'rides': [{'id': provider_id, 'name': 'ride', 'is_open': True, 'wait_time': 12,
                              'last_updated': DAY + 'T04:10:00Z'}]}
        args = argparse.Namespace(action='collect', spool_dir=self.spool, catalogue=catalogue, repository='owner/repo')
        with patch.object(watch, 'request_json', side_effect=[payload, OSError('offline')]), \
                patch.dict(watch.os.environ, {'TDROUTE_GITHUB_TOKEN': ''}), self.assertRaises(ValueError):
            watch.run(args, lambda: NOW)
        saved, = self.spool.glob('????-??-??.*.json')
        actual, = json.loads(saved.read_text())
        self.assertEqual((actual['source'], actual['fetchedAt'], actual['wait']), ('queue-times', DAY+'T04:15:00Z', 12))

    def test_check_uses_actual_slot_and_park_observations(self):
        rows = [row('land'), {**row('sea'), 'source': 'themeparks-wiki'}, {**row('sea'), 'collector': 'watchdog'},
                {**row('sea'), 'observedAt': DAY+'T03:59:00Z'}, {**row('sea'), 'observedAt': DAY+'T04:16:00Z'}]
        self.assertEqual(watch.parks_in_slot(rows, NOW), {'land'})

    def test_public_check_uses_only_anonymous_gets_and_keeps_pending_receipts(self):
        watch.persist(self.spool, [row('land')])
        pending, = self.spool.glob('*.json')
        args = argparse.Namespace(action='check', spool_dir=self.spool, repository='owner/repo')
        with patch.dict(watch.os.environ, {'TDROUTE_GITHUB_TOKEN': ''}), \
                patch.object(watch, 'urlopen', side_effect=lambda *a, **kw: io.BytesIO(b'{}')) as client:
            with self.assertRaisesRegex(RuntimeError, 'forecast'):
                watch.run(args, lambda: NOW.replace(hour=14))
        self.assertEqual(json.loads(pending.read_text()), [row('land')])
        self.assertEqual(len(client.call_args_list), 3)
        for call in client.call_args_list:
            request = call.args[0]
            self.assertEqual(request.get_method(), 'GET')
            self.assertTrue(request.full_url.startswith('https://raw.githubusercontent.com/owner/repo/park-wait-data/'))
            self.assertIsNone(request.get_header('Authorization'))

    def test_recover_pins_day_and_check_reports_missing_forecast(self):
        now = NOW.replace(hour=14)
        args = argparse.Namespace(action='recover', spool_dir=self.spool, repository='owner/repo')
        with patch.dict(watch.os.environ, {'TDROUTE_GITHUB_TOKEN': 'placeholder'}), \
                patch.object(watch, 'GitHub') as factory:
            github = factory.return_value
            github.read_file.return_value = None
            watch.run(args, lambda: now)
            day = dt.date.fromisoformat(DAY)
            github.dispatch.assert_called_once_with('recover', day)
            args.action = 'check'
            with self.assertRaisesRegex(RuntimeError, 'forecast'):
                watch.run(args, lambda: now)
            github.dispatch.assert_called_once()


if __name__ == '__main__':
    unittest.main()
