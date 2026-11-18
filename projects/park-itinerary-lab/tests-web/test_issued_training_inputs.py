"""A closed day's realised waits must be paired with inputs known before the slot."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / 'scripts'))
from issued_training_inputs import with_issued_inputs


class IssuedTrainingInputs(unittest.TestCase):
    def test_frozen_conditions_and_observed_targets(self):
        day = '2027-01-20'
        snapshot = {
            'parkId': 'land', 'issuedAt': day+'T09:10:00+09:00',
            'weatherHours': [{'minute': 540, 'endMinute': 600, 'weather': 'rain',
                              'temperature': 8, 'precipitation': 2}],
            'visitDayFactors': {'eventIds': [], 'inputs': {'adult_ticket_yen': 10900}},
            'rows': [{'minute': 540}, {'minute': 570}, {'minute': 600, 'endMinute': 610}],
        }
        positions = [544, 570, 601, 611]
        inputs = [{'date': day, 'time': minute, 'activityId': 'land-ride', 'wait': 32,
                   'weather': 'sun', 'temperature': 14, 'precipitation': 0} for minute in positions]
        inputs.append({**inputs[1], 'activityId': 'sea-ride'})
        catalogue = {'parks': [{'id': 'land', 'activities': [{'id': 'land-ride', 'baseWait': 20}],
                                'events': [{'id': 'unannounced', 'startDate': day, 'endDate': day}]}]}
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            filename = directory / (day+'.json')
            def save(park):
                filename.write_text(json.dumps({'date': day, 'slotMinutes': 30, 'parks': [park]}))
            save(snapshot)
            joined = with_issued_inputs(inputs, directory)
            self.assertEqual([r['temperature'] for r in joined], [14, 8, None, 14, 14])
            self.assertTrue(all(r['weather']=='sun' and r['wait']==32 for r in inputs))
            self.assertEqual(joined[1]['wait'], 32)
            self.assertIsNone(joined[2]['precipitation'])
            for name, obj in [('catalogue', catalogue), ('observations', [inputs[1], inputs[2]])]:
                (directory / (name+'.json')).write_text(json.dumps(obj))
            output = directory / 'model.json'
            subprocess.run([sys.executable, str(PROJECT / 'scripts/train_wait_model.py'),
                            '--observations', str(directory/'observations.json'), '--forecast-dir', tmp,
                            '--catalogue', str(directory/'catalogue.json'), '--before-date', '2027-01-21',
                            '--output', str(output)], check=True, capture_output=True)
            fit = json.loads(output.read_text())['parks'][0]
            self.assertEqual(fit['issuedInputCoverage'], {'samples': 2, 'days': 1, 'withWeather': 1})
            self.assertEqual(fit['visitFactorSupport']['adult_ticket_yen']['knownDays'], 1)
            self.assertEqual(fit['eventIds'], [])
            save({key: value for key, value in snapshot.items() if key!='weatherHours'})
            self.assertEqual(with_issued_inputs(inputs, directory), inputs)
