import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from score_daily_waits import run

DAY = '2026-11-19'
NOW = dt.datetime.fromisoformat(DAY + 'T22:00:00+09:00')


class DailyScores(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name)
        for name in ('history', 'forecasts'):
            (self.data / name).mkdir()
        self.output = self.data / 'accuracy-daily' / (DAY + '.json')

    def write(self, name, value):
        (self.data / name).write_text(json.dumps(value))

    def issue(self, date=DAY):
        parks = []
        for park in ('land', 'sea'):
            rows = [dict(activityId=park + '-ride', minute=m, wait=30) for m in (540, 570, 600)]
            parks.append(dict(parkId=park, issuedAt=date + 'T09:00:00+09:00', rows=rows))
        self.write(f'forecasts/{date}.json', dict(date=date, schemaVersion=1, slotMinutes=30, parks=parks))

    def post(self, park, minute, wait, date=DAY):
        return dict(source='queue-times', activityId=park + '-ride', date=date,
                    observedAt=f'{date}T{minute//60:02d}:{minute%60:02d}:00+09:00',
                    time=minute, wait=wait)

    def test_frozen_future_only_slots_duplicate_inputs_and_later_retry(self):
        self.issue()
        original = (self.data / 'forecasts' / (DAY + '.json')).read_bytes()
        early = self.post('land', 545, 100)
        a = self.post('land', 571, 35)
        b = self.post('land', 574, 45)
        self.write('history/2026-11.json', [early, a])
        self.write('observations.json', [a, b, {**b, 'source':'themeparks-wiki'}])
        run(self.data, NOW)
        land, sea = json.loads(self.output.read_text())['parks']
        self.assertEqual((land['overall']['matched'], land['overall']['expected'], land['overall']['mae']),
                         (1, 2, 10))
        self.assertEqual(land['overall']['bias'], -10)
        self.assertEqual(sea['status'], 'no-observations')
        self.write('observations.json', [a, b, self.post('land', 588, 75), self.post('sea', 605, 45)])
        run(self.data, NOW)
        improved = self.output.read_bytes()
        land, sea = json.loads(improved)['parks']
        self.assertEqual((land['overall']['matched'], land['overall']['samples'], land['overall']['mae']),
                         (1, 3, 15))
        self.assertEqual(sea['overall']['matched'], 1)
        run(self.data, NOW + dt.timedelta(hours=1))
        self.assertEqual(self.output.read_bytes(), improved)
        # Loss of an input cannot erase previously measured results from either park.
        self.write('observations.json', [a])
        self.write('history/2026-11.json', [])
        run(self.data, NOW)
        self.assertEqual(self.output.read_bytes(), improved)
        self.assertEqual((self.data / 'forecasts' / (DAY + '.json')).read_bytes(), original)

    def test_more_non_reference_waits_cannot_erase_a_supported_crowd_reading(self):
        rows, anchors, other = [], [], []
        for suffix in 'abc':
            for minute in (570, 600, 630, 660, 690, 720, 750, 870):
                ride = 'land-' + suffix
                row = dict(activityId=ride, minute=minute, wait=20)
                note = {**self.post('land', minute + 1, 35), 'activityId':ride}
                if minute in (630, 750, 870):
                    row['reference'] = 20
                    anchors.append(note)
                else:
                    other.append(note)
                rows.append(row)
        park = dict(parkId='land', issuedAt=DAY+'T08:00:00+09:00', crowd={'level':'normal'}, rows=rows)
        self.write('forecasts/'+DAY+'.json', dict(date=DAY, schemaVersion=1, slotMinutes=30, parks=[park]))
        self.write('observations.json', anchors)
        run(self.data, NOW)
        self.write('observations.json', other)
        run(self.data, NOW)
        land = json.loads(self.output.read_text())['parks'][0]
        self.assertEqual(land['overall']['matched'], 15)
        self.assertEqual(land['crowd']['observedLevel'], 'busy')
        self.assertEqual((land['crowd']['matched'], land['crowd']['expected']), (9, 9))

    def test_missing_issuance_is_persisted_and_prior_unscored_dates_catch_up(self):
        previous = '2026-10-26'
        self.issue(previous)
        self.write('history/2026-10.json', [self.post('sea', 599, 45, previous)])
        run(self.data, NOW)
        for park in json.loads(self.output.read_text())['parks']:
            self.assertEqual(park['status'], 'no-forecast')
            self.assertIsNone(park['overall']['mae'])
        prior = self.data / 'accuracy-daily' / (previous + '.json')
        self.assertEqual(json.loads(prior.read_text())['parks'][1]['overall']['mae'], 15)

    def test_waits_for_last_published_park_close(self):
        self.issue()
        calendar = {DAY: {'windows': [[540, 1380]]}}
        self.write('catalogue.json', {'parks':[{'id':'sea', 'operatingCalendar':calendar}]})
        run(self.data, NOW)
        self.assertFalse(self.output.exists())
        run(self.data, NOW + dt.timedelta(hours=1))
        self.assertTrue(self.output.exists())


if __name__ == '__main__':
    unittest.main()
