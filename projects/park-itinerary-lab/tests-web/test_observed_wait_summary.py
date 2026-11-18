import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from observed_wait_summary import summarise_observed_waits

PARKS = {'parks': [{'id': park, 'activities': [{'id': park+'-a', 'baseWait': 10},
                                                {'id': park+'-b', 'baseWait': 20},
                                                {'id': park+'-c', 'baseWait': 0}]}
                   for park in ('land', 'sea')]}


class MeasuredWeather(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def weather(self, date, hours, station='44136'):
        (self.root / (date+'.json')).write_text(json.dumps({
            'date': date, 'schemaVersion': 1, 'station': {'id': station}, 'observedHours': hours,
            'parks': [{'parkId': 'land', 'forecastHours': [{'minute': 600, 'precipitation': 5}]}]}))

    def note(self, date, ride, minute, wait, **extra):
        return {'date':date, 'activityId':ride, 'time':minute, 'wait':wait, 'source':'queue-times',
                'observedAt':f'{date}T{minute//60:02d}:{minute%60:02d}:00+09:00', **extra}

    def test_real_station_hour_and_distinct_archive_buckets_only(self):
        day = '2026-11-18'
        self.weather(day, [{'minute': 600, 'temperature': 10}, {'minute': 660, 'precipitation': 0}])
        land = self.note(day,'land-a',615,5)
        sea = self.note(day,'sea-b',663,12)
        rows = [land, land, {**land,'source':'themeparks-wiki'}, {**land,'isOpen':False},
                self.note(day,'land-c',615,5), self.note(day,'land-a',660,30,observedAt=land['observedAt']),
                self.note(day,'land-b',695,20), self.note(day,'land-b',750,30), sea]
        scores = summarise_observed_waits(rows,PARKS,self.root)
        self.assertEqual((scores['land']['eligibleSamples'], scores['land']['matchedSamples']), (3, 2))
        self.assertEqual(scores['land']['temperature'], {'samples':1,'days':1,'r':None})
        self.assertEqual(scores['land']['precipitation'], {'samples':1,'days':1,'r':None})
        self.assertEqual(scores['sea']['matchedSamples'], 1)
        self.assertEqual(scores['sea']['precipitation']['samples'], 1)

    def test_independent_dates_and_real_variation_gate_both_park_correlations(self):
        rows = []
        for i in range(4):
            date = f'2026-11-{10+i}'
            self.weather(date,[{'minute':h*60, 'temperature':h, 'precipitation':0} for h in range(10,15)])
            for h in range(10,15):
                rows.extend([self.note(date,'land-a',h*60+1,h*10), self.note(date,'land-b',h*60+1,h*20),
                             self.note(date,'land-a',h*60,1)])
        self.assertIsNone(summarise_observed_waits(rows[:30],PARKS,self.root)['land']['temperature']['r'])
        scores = summarise_observed_waits(rows,PARKS,self.root)
        self.assertEqual(scores['land']['temperature'],{'samples':40,'days':4,'r':1.0})
        self.assertEqual(scores['land']['precipitation']['r'],None)
        self.assertEqual((scores['land']['firstDate'],scores['land']['lastDate']),('2026-11-10','2026-11-13'))
        self.assertIsNone(scores['sea']['firstDate'])

    def test_missing_malformed_or_forecast_only_inputs_give_no_matches(self):
        days = ['2026-11-10','2026-11-11','2026-11-12','2026-11-13']
        self.weather(days[0],[{'minute':600,'temperature':10}],station='other')
        (self.root/(days[1]+'.json')).write_text('{')
        self.weather(days[2],[])
        rows = [self.note(day,'land-a',600,10,temperature=16,precipitation=10) for day in days]
        land = summarise_observed_waits(rows,PARKS,self.root)['land']
        self.assertEqual((land['eligibleSamples'],land['matchedSamples'],land['matchedDays']),(4,0,0))
        self.assertIsNone(land['temperature']['r'])
