"""Exercise the all-network-timeout path that failed on the hosted runner."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

PROJECT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('catalogue_failure_updater',PROJECT/'scripts/update_park_data.py')
updater=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(updater)


class CatalogueFailureTests(unittest.TestCase):
    def setUp(self):
        self.bundled=json.loads((PROJECT/'web/data/parks.json').read_text())
        self.bundled['updatedAt']='2026-11-16'
        self.bundled['fetchedAt']='2026-11-16T10:00:00Z'

    def invoke(self,*args,timeout=False):
        with contextlib.redirect_stdout(io.StringIO()),mock.patch('sys.argv',['update_park_data.py',*map(str,args)]):
            if timeout:
                with mock.patch.object(updater,'fetch_document',side_effect=TimeoutError('operation timed out')):
                    return updater.main()
            return updater.main()

    def test_first_all_source_timeout_seeds_verified_bundle_and_records_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundled=root/'bundled.json';output=root/'catalogue.json'
            bundled.write_text(json.dumps(self.bundled))
            self.assertEqual(self.invoke('--catalogue',bundled,'--previous-catalogue',output,'--output',output,'--seed-only'),0)
            self.assertEqual(json.loads(output.read_text()),self.bundled)
            result=self.invoke('--catalogue',bundled,'--previous-catalogue',output,'--output',output,'--date','2026-11-17',timeout=True)
            self.assertEqual(result,1)
            cached=json.loads(output.read_text());report=json.loads((root/'catalogue-report.json').read_text())
            self.assertEqual(cached['parks'],self.bundled['parks'])
            self.assertEqual(cached['fetchedAt'],self.bundled['fetchedAt'])
            self.assertEqual(cached['updatedAt'],self.bundled['updatedAt'])
            self.assertEqual(cached['updateStatus'],'failed')
            self.assertEqual(cached['refreshAttempt']['status'],'failed')
            self.assertNotEqual(cached['refreshAttempt']['checkedAt'],cached['fetchedAt'])
            self.assertEqual(len(report['sourceErrors']),16)
            self.assertTrue(report['lastKnownCatalogueUsed'])
            self.assertTrue(all('timed out' in row['message'] for row in report['sourceErrors']))
            self.assertEqual(json.loads(bundled.read_text()),self.bundled)

    def test_timeout_never_overwrites_a_newer_published_catalogue(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundled=root/'bundled.json';output=root/'catalogue.json'
            previous=copy.deepcopy(self.bundled);previous.update(updatedAt='2026-11-17',fetchedAt='2026-11-17T01:00:00Z')
            previous['parks'][0]['activities'][0]['name']='Previously verified newer name'
            previous['parks'][0]['activities'][0]['menuCheckedOn']='2026-11-17'
            previous['parks'][0]['activities'][0]['menuItems']=[{'name':'Previously verified menu','url':'https://www.tokyodisneyresort.jp/'}]
            bundled.write_text(json.dumps(self.bundled));output.write_text(json.dumps(previous))
            self.assertEqual(self.invoke('--catalogue',bundled,'--previous-catalogue',output,'--output',output,'--date','2026-11-17',timeout=True),1)
            result=json.loads(output.read_text())
            self.assertEqual(result['parks'],previous['parks'])
            self.assertEqual(result['fetchedAt'],previous['fetchedAt'])
            self.assertEqual(result['updatedAt'],previous['updatedAt'])
            self.assertEqual(result['pipelineVersion'],previous['pipelineVersion'])

    def test_incomplete_published_model_json_cannot_replace_a_valid_catalogue(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundled=root/'bundled.json';output=root/'catalogue.json'
            bundled.write_text(json.dumps(self.bundled));output.write_text(json.dumps({'parks':[{'id':'land'},{'id':'sea'}]}))
            self.assertEqual(self.invoke('--catalogue',bundled,'--previous-catalogue',output,'--output',output,'--seed-only'),0)
            self.assertEqual(json.loads(output.read_text()),self.bundled)

    def test_new_reviewed_catalogue_edition_survives_a_newer_but_older_edition_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundled=root/'bundled.json';output=root/'catalogue.json'
            current=copy.deepcopy(self.bundled);current['version']='1.1.0'
            previous=copy.deepcopy(current);previous['version']='1.0.0';previous['fetchedAt']='2026-11-17T12:00:00Z'
            previous['parks'][0]['activities']=previous['parks'][0]['activities'][:-1]
            existing=previous['parks'][0]['activities'][0]
            existing['dailySchedules']['2026-12-24']={'closed':True,'closureSource':'explicit'}
            bundled.write_text(json.dumps(current));output.write_text(json.dumps(previous))
            self.assertEqual(self.invoke('--catalogue',bundled,'--previous-catalogue',output,'--output',output,'--seed-only'),0)
            seeded=json.loads(output.read_text())
            self.assertEqual(seeded['version'],'1.1.0')
            self.assertEqual(len(seeded['parks'][0]['activities']),len(current['parks'][0]['activities']))
            self.assertTrue(seeded['parks'][0]['activities'][0]['dailySchedules']['2026-12-24']['closed'])
            self.assertEqual(self.invoke('--catalogue',bundled,'--previous-catalogue',output,'--output',output,'--date','2026-11-17',timeout=True),1)
            failed=json.loads(output.read_text())
            self.assertEqual(failed['version'],'1.1.0')
            self.assertEqual(len(failed['parks'][0]['activities']),len(current['parks'][0]['activities']))


if __name__=='__main__':unittest.main()
