import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from score_wait_history import PARK_IDS, run

DAY = '2026-11-18'
NOW = dt.datetime.fromisoformat(DAY+'T22:10:00+09:00')
ISSUED = DAY+'T08:00:00+09:00'


class HistoricalScores(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.scores = self.root/'accuracy-history'
        self.history = {}
        self.calls = []
        self.failure = {}
        parks, forecasts = [], []
        for park in PARK_IDS:
            rides, rows, entities = [], [], []
            for n in range(3):
                ride = f'{park}-attraction-{n}'
                rides.append(dict(id=ride, category='attraction', windows=[[540,1260]]))
                rows.extend([dict(activityId=ride, minute=540, wait=30, endMinute=565),
                             dict(activityId=ride, minute=570, wait=20)])
                def change(t, w):
                    return dict(time=f'{DAY}T{t}:00+09:00', changed=['queue.STANDBY.waitTime'],
                                status='OPERATING', queue={'STANDBY':{'waitTime':w}})
                entities.append(dict(id=ride, history=[change('09:05', 15),change('09:17', 40),
                                                       change('09:27', 80),change('09:48', 20)]))
            self.history[park] = dict(id=PARK_IDS[park], timezone='Asia/Tokyo',
                                      range={'from':DAY,'to':DAY}, entities=entities)
            parks.append(dict(id=park, activities=rides))
            forecasts.append(dict(parkId=park, issuedAt=ISSUED, rows=rows, crowd={'level':'normal'}))
        self.forecast = dict(schemaVersion=1, slotMinutes=30, date=DAY, parks=forecasts)
        (self.root/'forecasts').mkdir()
        self.write('forecasts/'+DAY+'.json', self.forecast)
        self.write('catalogue.json', dict(parks=parks))

    def write(self, name, value):
        (self.root/name).write_text(json.dumps(value))

    def fetch(self, url):
        self.calls.append(url)
        park = next(key for key,value in PARK_IDS.items() if value in url)
        if url.endswith('/children'):
            return {'children':[dict(id=f'{park}-attraction-{i}', externalId=str(i),
                                     entityType='ATTRACTION') for i in range(3)]}
        if park in self.failure:
            raise self.failure[park]
        return self.history[park]

    def results(self):
        return json.loads((self.scores/(DAY+'.json')).read_text())['parks']

    def test_closed_day_ignores_changes_outside_truncated_slots_and_freezes_independent_aggregates(self):
        run(self.root, NOW.replace(hour=20), self.fetch)
        self.assertEqual(self.calls, [])
        original = (self.root/f'forecasts/{DAY}.json').read_bytes()
        run(self.root, NOW, self.fetch)
        parks = self.results()
        self.assertEqual([p['parkId'] for p in parks], ['land','sea'])
        for park in parks:
            self.assertEqual((park['expected'],park['matched'],park['mae'],park['bias'],park['within10']),
                             (6,6,5,-5,1))
            self.assertEqual(park['issuedAt'], ISSUED)
            self.assertNotIn('rows', park)
        self.assertNotIn('attraction', (self.scores/(DAY+'.json')).read_text())
        self.assertEqual((self.root/f'forecasts/{DAY}.json').read_bytes(), original)
        already = len(self.calls)
        run(self.root, NOW+dt.timedelta(days=1), self.fetch)
        self.assertEqual(len(self.calls), already)

    def test_failed_park_retries_after_cooldown_and_preserves_other_park(self):
        self.failure['land'] = OSError('transient but private details')
        with self.assertRaises(RuntimeError):
            run(self.root, NOW, self.fetch)
        self.assertEqual([p['parkId'] for p in self.results()], ['sea'])
        calls = len(self.calls)
        run(self.root, NOW+dt.timedelta(hours=1), self.fetch)
        self.assertEqual(len(self.calls), calls)
        self.failure.clear()
        run(self.root, NOW+dt.timedelta(hours=6), self.fetch)
        self.assertEqual([p['parkId'] for p in self.results()], ['land','sea'])

    def test_sparse_wrong_day_or_already_started_forecast_is_not_published(self):
        for park in self.forecast['parks']:
            park['issuedAt'] = DAY+'T09:45:00+09:00'
        self.write('forecasts/'+DAY+'.json', self.forecast)
        run(self.root, NOW, self.fetch)
        self.assertFalse((self.scores/(DAY+'.json')).exists())
        self.write('forecasts/'+DAY+'.json', {**self.forecast,'date':'2026-11-19'})
        self.calls.clear()
        run(self.root, NOW+dt.timedelta(hours=6), self.fetch)
        self.assertEqual(self.calls, [])
        self.forecast['parks'][0]['issuedAt'] = ISSUED
        self.write('forecasts/'+DAY+'.json', self.forecast)
        self.history['land']['entities'] = self.history['land']['entities'][:1]
        run(self.root, NOW+dt.timedelta(hours=6), self.fetch)
        self.assertFalse((self.scores/(DAY+'.json')).exists())

    def test_rate_limit_defers_other_parks_and_out_of_window_access(self):
        self.failure['land'] = HTTPError('provider',429,'rate limited',{},None)
        with self.assertRaises(RuntimeError):
            run(self.root, NOW, self.fetch)
        calls = len(self.calls)
        run(self.root, NOW+dt.timedelta(hours=1), self.fetch)
        run(self.root, NOW+dt.timedelta(days=7), self.fetch)
        self.assertEqual(len(self.calls), calls)


if __name__ == '__main__':
    unittest.main()
