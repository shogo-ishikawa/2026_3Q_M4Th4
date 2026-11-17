import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, PROJECT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class HistoryImportTests(unittest.TestCase):
    def setUp(self):
        self.importer = load('import_wait_history')
        self.catalogue = {'parks': [{'id': 'land', 'activities': [{'id': 'land-a', 'baseWait': 40, 'windows': [[540, 1260]]}], 'events': []}, {'id': 'sea', 'activities': [], 'events': []}]}

    def test_rejects_unknown_future_closed_and_empty_records(self):
        good = {'date': '2026-11-01', 'activityId': 'land-a', 'time': '09:03', 'wait': '5'}
        records = [good, {**good, 'time': '09:29', 'wait': '40'}, {**good, 'wait': None}, {**good, 'wait': ''}, {**good, 'wait': False}, {**good, 'activityId': 'unknown'}, {**good, 'date': '2026-11-18'}, {**good, 'isOpen': False}]
        rows, rejected = self.importer.normalise_rows(records, self.catalogue, '2026-11-18')
        self.assertEqual([row['wait'] for row in rows], [5, 40])
        self.assertEqual(rejected, {'wait': 3, 'unknown_activity': 1, 'date_or_future': 1, 'not_operating': 1})

    def test_archived_weather_joins_the_observation_hour_and_keeps_unknowns_unknown(self):
        rows = [{'date': '2026-11-01', 'time': 570, 'weather': ''}, {'date': '2026-11-01', 'time': 600, 'weather': ''}]
        response = {'hourly': {'time': ['2026-11-01T09:00'], 'weather_code': [61], 'temperature_2m': [14.5], 'precipitation': [2]}}
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            report = self.importer.enrich_weather(rows, Path(directory), lambda url: calls.append(url) or response)
            self.assertEqual(report['matched'], 1)
            self.assertEqual(report['missing'], 1)
            self.assertEqual(rows[0]['weather'], 'rain')
            self.assertEqual(rows[0]['temperature'], 14.5)
            self.assertEqual(rows[1]['weather'], '')
            self.assertIn('archive-api.open-meteo.com', calls[0])
            self.importer.enrich_weather(rows, Path(directory), lambda url: self.fail('cached request'))

    def test_weather_failures_do_not_fabricate_weather(self):
        rows = [{'date': '2026-11-01', 'time': 570, 'weather': ''}]
        def failed(url):
            raise OSError('temporarily unavailable')
        with tempfile.TemporaryDirectory() as directory:
            report = self.importer.enrich_weather(rows, Path(directory), failed)
        self.assertEqual(report['matched'], 0)
        self.assertEqual(len(report['errors']), 1)
        self.assertNotIn('temperature', rows[0])

    def test_monthly_archive_loader_ignores_other_files_and_other_months(self):
        trainer = load('train_wait_model')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / '2026-10.json').write_text(json.dumps([{'date': '2026-10-01'}, {'date': '2026-11-01'}]))
            (path / '2026-11.json').write_text(json.dumps({'observations': [{'date': '2026-11-01'}], 'dataSources': []}))
            (path / 'secrets.json').write_text('invalid JSON must not be read')
            rows, sources = trainer.load_history(path)
        self.assertEqual(rows, [{'date': '2026-10-01'}, {'date': '2026-11-01'}])

    def test_cli_import_and_canonical_training_with_calendar(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'catalogue.json').write_text(json.dumps(self.catalogue))
            (path / 'history.csv').write_text('date,activityId,time,wait,weather,event\n' + '\n'.join(f'2026-11-{day:02},land-a,{hour:02}:00,20,sun,' for day in range(1, 11) for hour in range(9, 21)))
            imported = path / 'imported'
            subprocess.run(['python', str(PROJECT / 'scripts/import_wait_history.py'), '--input', str(path / 'history.csv'), '--catalogue', str(path / 'catalogue.json'), '--output-dir', str(imported), '--before-date', '2026-11-17'], check=True, capture_output=True)
            model_path = path / 'model.json'
            subprocess.run(['python', str(PROJECT / 'scripts/train_wait_model.py'), '--observations', str(imported / 'observations.json'), '--catalogue', str(path / 'catalogue.json'), '--output', str(model_path), '--before-date', '2026-11-17'], check=True, capture_output=True)
            model = json.loads(model_path.read_text())['parks'][0]
            self.assertEqual(model['schemaVersion'], 2)
            self.assertEqual(model['status'], 'trained')
            self.assertTrue(model['usable'])
            self.assertEqual(model['days'], 10)
            self.assertLess(model['validation']['modelMae'], model['validation']['baselineMae'])

    def test_training_retains_a_valid_broader_model_and_rejects_a_corrupt_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'catalogue.json').write_text(json.dumps(self.catalogue))
            observations = [{'date': f'2026-11-{day:02}', 'activityId': 'land-a', 'time': hour * 60, 'wait': 20, 'weather': 'sun'} for day in range(1, 11) for hour in range(9, 21)]
            (path / 'observations.json').write_text(json.dumps(observations))
            common = ['python', str(PROJECT / 'scripts/train_wait_model.py'), '--catalogue', str(path / 'catalogue.json'), '--before-date', '2026-11-17']
            subprocess.run(common + ['--observations', str(path / 'observations.json'), '--output', str(path / 'prior.json')], check=True, capture_output=True)
            narrower = [{'date': f'2026-11-{day:02}', 'activityId': 'land-a', 'time': hour * 60 + minute, 'wait': 20, 'weather': 'sun'} for day in range(5, 12) for hour in range(9, 21) for minute in (0, 30)]
            (path / 'narrower.json').write_text(json.dumps(narrower))
            subprocess.run(common + ['--observations', str(path / 'narrower.json'), '--fallback-model', str(path / 'prior.json'), '--output', str(path / 'retained.json')], check=True, capture_output=True)
            retained = json.loads((path / 'retained.json').read_text())['parks'][0]
            self.assertEqual(retained['days'], 10)
            self.assertEqual(retained['latestAttempt']['days'], 7)
            self.assertIn('retainedModelReason', retained)
            corrupt = json.loads((path / 'prior.json').read_text())
            corrupt['parks'][0]['validation'] = None
            (path / 'corrupt.json').write_text(json.dumps(corrupt))
            (path / 'empty.json').write_text('[]')
            subprocess.run(common + ['--observations', str(path / 'empty.json'), '--fallback-model', str(path / 'corrupt.json'), '--output', str(path / 'cold.json')], check=True, capture_output=True)
            self.assertEqual(json.loads((path / 'cold.json').read_text())['parks'][0]['status'], 'insufficient-data')
