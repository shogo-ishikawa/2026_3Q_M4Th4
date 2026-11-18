import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/bootstrap_wait_history.py'
sys.path.insert(0, str(SCRIPT.parent))
import bootstrap_wait_history as history

NOW = dt.datetime(2026, 11, 11, 12, 0, tzinfo=dt.timezone.utc)


def park():
    return {'id': 'land', 'activities': [{'id': 'land-attraction-153', 'category': 'attraction', 'windows': [[540, 1260]]}], 'events': [{'id': 'christmas', 'startDate': '2026-11-11', 'endDate': '2026-12-25'}]}


def event(time='2026-11-11T00:03:00Z', wait=20, status='OPERATING'):
    return {'time': time, 'status': status, 'queue': {'STANDBY': {'waitTime': wait}}}


def payload(events=None, opening=None):
    return {'id': history.PARK_IDS['land'], 'timezone': 'Asia/Tokyo', 'range': {'from': '2026-11-11', 'to': '2026-11-11'}, 'next': None, 'entities': [{'id': 'uuid', 'history': events or [], 'opening': opening or {}}]}


def normalise(data):
    return history.normalise_history(data, park(), {'uuid': 'land-attraction-153'}, '2026-11-11', now=NOW)


class HistoricalBootstrapTests(unittest.TestCase):
    def test_mapping_uses_official_id_and_type_not_similar_names(self):
        children = {'children': [{'id': 'exact', 'externalId': '153', 'entityType': 'ATTRACTION'}, {'id': 'wrong-type', 'externalId': '153', 'entityType': 'SHOW'}, {'id': 'similar-name', 'externalId': '999', 'entityType': 'ATTRACTION', 'name': 'Jungle Cruise'}]}
        self.assertEqual(history.entity_mapping(children, park()), {'exact': 'land-attraction-153'})

    def test_opening_ramp_keeps_distinct_ten_minute_bins(self):
        rows = normalise(payload([event(wait=5), event('2026-11-11T00:23:00Z', 35), event('2026-11-11T00:29:00Z', 45)]))
        self.assertEqual([(row['time'], row['wait']) for row in rows], [(543, 5), (569, 45)])
        self.assertEqual(rows[0]['openingMinute'], 540)
        self.assertEqual(rows[0]['event'], 'christmas')

    def test_later_in_day_has_one_observation_per_half_hour(self):
        rows = normalise(payload([event('2026-11-11T03:01:00Z', 40), event('2026-11-11T03:25:00Z', 60)]))
        self.assertEqual([(row['time'], row['wait']) for row in rows], [(745, 60)])

    def test_missing_days_and_stale_carried_opening_are_not_filled(self):
        stale = event('2026-11-10T15:00:00Z', 70)
        stale['observedAt'] = '2026-11-08T03:00:00Z'
        self.assertEqual(normalise(payload(opening=stale)), [])
        self.assertEqual(normalise(payload()), [])

    def test_queue_timestamp_must_be_fresh_even_if_status_changed_today(self):
        opening = event('2026-11-10T15:00:00Z', 90)
        opening.update(observedAt='2026-11-11T00:03:00Z', observedAtByKind={'status': '2026-11-11T00:03:00Z'})
        self.assertEqual(normalise(payload(opening=opening)), [])
        opening['observedAtByKind']['queue.STANDBY'] = '2026-11-11T00:04:00Z'
        self.assertEqual(normalise(payload(opening=opening))[0]['time'], 544)

    def test_only_changed_standby_values_receive_the_event_timestamp(self):
        samples = [
            {**event('2026-11-11T00:03:00Z', 20), 'changed': ['queue.STANDBY.waitTime']},
            {**event('2026-11-11T00:07:00Z', 20), 'changed': ['queue.PAID_RETURN_TIME.state']},
            {**event('2026-11-11T01:05:00Z', 20), 'changed': ['showtimes']},
            {**event('2026-11-11T01:12:00Z', 35), 'changed': ['queue.STANDBY.waitTime', 'status']},
        ]
        rows = normalise(payload(samples))
        self.assertEqual([(row['observedAt'], row['wait']) for row in rows],
                         [('2026-11-11T00:03:00Z', 20), ('2026-11-11T01:12:00Z', 35)])

    def test_reopening_with_a_carried_wait_does_not_make_a_new_measurement(self):
        samples = [
            {**event('2026-11-11T00:01:00Z', 10, 'DOWN'), 'changed': ['status', 'queue.STANDBY.waitTime']},
            {**event('2026-11-11T00:13:00Z', 10), 'changed': ['status']},
            {**event('2026-11-11T00:25:00Z', 15), 'changed': ['queue.STANDBY.waitTime']},
        ]
        self.assertEqual([(row['time'], row['wait']) for row in normalise(payload(samples))],
                         [(565, 15)])

    def test_legacy_event_without_changed_metadata_is_kept(self):
        self.assertEqual(normalise(payload([event()]))[0]['observedAt'], '2026-11-11T00:03:00Z')
        for changed in ([], None, 'queue.STANDBY.waitTime', ['queue.SINGLE_RIDER.waitTime']):
            with self.subTest(changed=changed):
                self.assertEqual(normalise(payload([{**event(), 'changed': changed}])), [])

    def test_closed_unknown_invalid_future_and_other_day_samples_are_excluded(self):
        events = [event(status='CLOSED', wait=0), event(wait=None), event(wait=True), event(wait=700), event('2026-11-11T14:00:00Z'), event('2026-11-10T00:01:00Z')]
        self.assertEqual(normalise(payload(events)), [])

    def test_wrong_park_timezone_date_and_unexpected_pagination_rejected(self):
        for field, value in [('id', 'wrong'), ('timezone', 'UTC'), ('range', {'from': '2026-11-10', 'to': '2026-11-11'}), ('next', 'https://example.test/next')]:
            data = payload(); data[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                normalise(data)

    def test_weather_keeps_missing_values_unknown_and_labels_forecast_provenance(self):
        lookup = history.hourly_weather({'hourly': {'time': ['2026-11-11T09:00', '2026-11-11T10:00'], 'weather_code': [61, None], 'temperature_2m': [12.5, None], 'precipitation': [7.2, 0.8]}})
        row = history.enrich_weather(normalise(payload([event()])), lookup)[0]
        self.assertEqual((row['weather'], row['temperature'], row['precipitation']), ('rain', 12.5, 0.8))
        self.assertEqual(row['weatherSource'], 'open-meteo-past-forecast')
        self.assertNotIn('2026-11-11T10', lookup)

    def test_supplemental_weather_only_claims_fields_it_filled(self):
        lookup = {'2026-11-11T09': {'weather': 'rain', 'temperature': 8, 'precipitation': 2}}
        legacy = {'date': '2026-11-11', 'time': 545, 'weather': 'sun', 'temperature': 11, 'precipitation': 0}
        self.assertEqual(history.enrich_weather([legacy], lookup), [legacy])
        partial = {**legacy, 'temperature': None, 'weatherSource': 'observed'}
        enriched = history.enrich_weather([partial], lookup)[0]
        self.assertEqual(enriched['weatherSource'], 'observed')
        self.assertEqual((enriched['weather'], enriched['temperature'], enriched['precipitation']), ('sun', 8, 0))
        self.assertEqual(enriched['supplementalWeather'], {'source': 'open-meteo-past-forecast', 'fields': ['temperature']})

    def test_a_weaker_or_older_refresh_does_not_replace_a_usable_model(self):
        prior = {'usable': True, 'firstDate':'2026-11-05', 'lastDate': '2026-11-11', 'days': 7}
        for candidate in [{'usable': False, 'lastDate': '2026-11-12'}, {'usable': True, 'lastDate': '2026-11-10'}, {'usable':True,'firstDate':'2026-11-08','lastDate':'2026-11-12','days':5}]:
            self.assertEqual(history.choose_model(candidate, prior)['days'], 7)
        newer = {'usable': True, 'firstDate':'2026-11-05', 'lastDate': '2026-11-12','days':8}
        self.assertEqual(history.choose_model(newer, prior), newer)

    def test_rejected_replay_records_eligible_dates_without_changing_the_active_fit(self):
        prior = {'usable': True, 'days': 7, 'coefficients': [2], 'visitFactors': []}
        support = {'adult_ticket_yen': {'knownDays': 6, 'levels': 2, 'supportedLevels': 1}}
        candidate = {'usable': False, 'status': 'insufficient-data', 'days': 6, 'coefficients': [],
                     'beforeDate': '2026-11-19', 'samples': 2100, 'visitFactorSupport': support,
                     'validation': None, 'bootstrap': {'historySamples': 2050}}
        retained = history.choose_model(candidate, prior)
        self.assertEqual(retained['coefficients'], [2])
        self.assertNotIn('visitFactorSupport', retained)
        attempt = retained['lastBootstrapAttempt']
        self.assertEqual(attempt['historySamples'], 2050)
        self.assertEqual(attempt['fit']['visitFactorSupport'], support)
        self.assertIsNone(attempt['fit']['validation'])
        self.assertNotIn('coefficients', attempt['fit'])

    def test_a_newer_rolling_week_is_published_instead_of_freezing_the_first_week(self):
        prior={'usable':True,'firstDate':'2026-11-11','lastDate':'2026-11-17','days':7}
        candidate={'usable':True,'firstDate':'2026-11-12','lastDate':'2026-11-18','days':7}
        self.assertEqual(history.choose_model(candidate,prior),candidate)

    def test_private_raw_cache_cannot_be_written_inside_public_checkout(self):
        process = subprocess.run(['python', str(SCRIPT), '--private-dir', str(SCRIPT.parents[1] / 'web/data/history'), '--output-model', '/tmp/unwritten-model.json'], text=True, capture_output=True)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn('outside the repository', process.stderr)
        self.assertFalse((SCRIPT.parents[1] / 'web/data/history').exists())


if __name__ == '__main__':
    unittest.main()
