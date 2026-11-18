import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('official_bundle', PROJECT/'scripts/refresh_official_bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTests(unittest.TestCase):
    def test_failed_calendar_refresh_keeps_the_previous_calendar_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);previous=root/'previous';previous.mkdir();output=root/'next'
            known={'fetchedAt':'2026-11-17T01:00:00Z','parks':[]}
            (previous/'catalogue.json').write_text(json.dumps(known))
            calendar={'sourceUrl':'https://www8.cao.go.jp/','checkedOn':'2026-11-17'}
            (previous/'calendar.json').write_text(json.dumps(calendar))
            def run(command):
                if command[1].endswith('update_park_data.py'):
                    (output/'catalogue.json').write_text(json.dumps(known))
                    (output/'catalogue-report.json').write_text('{"status":"failed"}')
                return mock.Mock(returncode=1)
            menus={'status':'failed','checked':2,'updated':0,'errors':[{'reason':'timeout'}]}
            with mock.patch.object(bundle.subprocess,'run',side_effect=run),mock.patch('update_food_menus.update_catalogue',return_value=(copy.deepcopy(known),menus)),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bundle.refresh(output,previous/'catalogue.json','2026-11-18'),1)
            self.assertEqual(json.loads((output/'calendar.json').read_text()),calendar)
            self.assertEqual(json.loads((output/'catalogue.json').read_text())['fetchedAt'],known['fetchedAt'])
            report=json.loads((output/'calendar-report.json').read_text())
            self.assertEqual(report['status'],'failed');self.assertTrue(report['lastKnownCalendarUsed'])

    def test_successful_bundle_contains_no_source_html_or_private_history(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'out'
            def run(command):
                if command[1].endswith('update_park_data.py'):
                    (output/'catalogue.json').write_text('{"parks":[]}')
                    (output/'catalogue-report.json').write_text('{"status":"complete"}')
                else:(output/'calendar.json').write_text('{"verified":true}')
                return mock.Mock(returncode=0)
            menus={'status':'complete','checked':1,'updated':1,'errors':[]}
            with mock.patch.object(bundle.subprocess,'run',side_effect=run),mock.patch('update_food_menus.update_catalogue',return_value=({'parks':[]},menus)),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bundle.refresh(output,visit_date='2026-11-18'),0)
            self.assertEqual({p.name for p in output.iterdir()},{'catalogue.json','catalogue-report.json','calendar.json','calendar-report.json'})


if __name__=='__main__':unittest.main()
