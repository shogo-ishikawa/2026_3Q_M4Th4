"""Regressions for closed-day boundaries, archive-only fitting and model retention."""
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import nightly_wait_training as nightly


def observations(days, parks=('land', 'sea')):
    # Constant positive waits make the fitted model better than the trend baseline.
    return [{'date': f'2026-11-{day:02}', 'source': 'queue-times', 'activityId': f'{park}-ride',
             'time': hour * 60, 'wait': 20} for day in days for park in parks for hour in range(9, 21)]


def fixture(data, rows):
    parks = [{'id': park, 'activities': [{'id': park+'-ride', 'baseWait': 45, 'category': 'attraction'}],
              'events': []} for park in ('land', 'sea')]
    (data / 'catalogue.json').write_text(json.dumps({'parks': parks}))
    (data / 'observations.json').write_text(json.dumps(rows))


def read(data, name):
    return json.loads((data / name).read_text())


class NightlyTrainingTest(unittest.TestCase):
    def test_closed_day_uses_japan_time_and_later_actual_closing(self):
        now = dt.datetime(2026, 11, 18, 12, 54, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            self.assertEqual(str(nightly.latest_closed_day(data, now)), '2026-11-17')
            self.assertEqual(str(nightly.latest_closed_day(data, now + dt.timedelta(minutes=1))), '2026-11-18')
            calendar = {'2026-11-18': {'windows': [[540, 1260], [1320, 1380]]}}
            (data / 'catalogue.json').write_text(json.dumps({'parks': [{'id': 'sea', 'operatingCalendar': calendar}]}))
            self.assertEqual(str(nightly.latest_closed_day(data, now + dt.timedelta(minutes=65))), '2026-11-17')
            self.assertEqual(str(nightly.latest_closed_day(data, now + dt.timedelta(minutes=66))), '2026-11-18')
            self.assertEqual(str(nightly.latest_closed_day(data, now + dt.timedelta(hours=12))), '2026-11-18')

    def test_real_fit_uses_archived_and_just_closed_days_once_with_no_future_or_closed_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            archive = data / 'history'
            archive.mkdir()
            (archive / '2026-11.json').write_text(json.dumps(observations(range(1, 9))))
            recent = observations([8, 9, 10])
            closed = {**recent[0], 'date': '2026-11-09', 'time': 1260, 'wait': 0, 'isOpen': False}
            fixture(data, [*recent, closed])
            now = dt.datetime(2026, 11, 10, 11, tzinfo=nightly.JST)
            nightly.run(data, now)
            state = read(data, 'training-state.json')
            self.assertEqual(state['completedThrough'], '2026-11-09')
            self.assertEqual(len(read(data, 'history/2026-11.json')), 10 * 2 * 12)
            for park in read(data, 'wait-model.json')['parks']:
                self.assertEqual(park['samples'], 9 * 12)
                self.assertEqual(park['firstDate'], '2026-11-01')
                self.assertEqual(park['lastDate'], '2026-11-09')
                self.assertLess(park['validation']['trainThrough'], park['validation']['testFrom'])
                self.assertTrue(park['usable'])
                self.assertEqual([source['name'] for source in park['dataSources']], ['Queue-Times.com'])
            with patch.object(nightly.subprocess, 'run') as runner:
                nightly.run(data, now + dt.timedelta(minutes=15))
                runner.assert_not_called()
            nightly.run(data, now.replace(hour=22))
            self.assertEqual(read(data, 'training-state.json')['completedThrough'], '2026-11-10')
            self.assertEqual(read(data, 'wait-model.json')['parks'][0]['samples'], 120)

    def test_daily_attempt_with_too_few_dates_retains_validated_baseline_and_records_new_day(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            fixture(data, observations([18]))
            # Existing validated initial models come from a wider historical bootstrap.
            bundled = read(nightly.BUNDLED, 'wait-model.json')
            (data / 'wait-model.json').write_text(json.dumps(bundled))
            real_parks = read(nightly.BUNDLED, 'parks.json')
            (data / 'catalogue.json').write_text(json.dumps(real_parks))
            rows = []
            for park in real_parks['parks']:
                key = next(a['id'] for a in park['activities'] if a.get('category') == 'attraction')
                rows.append({'date': '2026-11-18', 'activityId': key, 'wait': 30, 'time': 700, 'source': 'queue-times'})
            (data / 'observations.json').write_text(json.dumps(rows))
            with patch.object(nightly, 'supplement_sparse_history', return_value={}) as supplement:
                nightly.run(data, dt.datetime(2026, 11, 18, 22, tzinfo=nightly.JST))
                supplement.assert_called_once()
            state = read(data, 'training-state.json')
            self.assertEqual(state['completedThrough'], '2026-11-18')
            for park, prior in zip(read(data, 'wait-model.json')['parks'], bundled['parks']):
                self.assertEqual(park['coefficients'], prior['coefficients'])
                self.assertEqual(park['lastDate'], prior['lastDate'])
                self.assertTrue(state['parks'][park['parkId']]['retainedPriorModel'])
                attempt = park['latestAttempt']
                self.assertEqual(attempt['lastDate'], '2026-11-18')
                self.assertEqual(attempt['visitFactorSupport']['long_weekend_first']['knownDays'], 1)
                self.assertEqual(attempt['status'], 'insufficient-data')
                self.assertIsNone(attempt['validation'])
                self.assertEqual(state['parks'][park['parkId']]['activeModelSamples'], prior['samples'])
                self.assertEqual(state['parks'][park['parkId']]['activeModelDays'], prior['days'])

    def test_missing_one_parks_observations_does_not_complete_its_day(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            fixture(data, observations([17]) + observations([18], ['land']))
            with patch.object(nightly, 'supplement_sparse_history', return_value={}), self.assertRaisesRegex(RuntimeError, 'incomplete'):
                nightly.run(data, dt.datetime(2026, 11, 18, 22, tzinfo=nightly.JST))
            state = read(data, 'training-state.json')
            self.assertNotIn('completedThrough', state)
            self.assertEqual(state['parks']['land']['lastObservedDate'], '2026-11-18')
            self.assertEqual(state['parks']['sea']['lastObservedDate'], '2026-11-17')

    def test_anonymous_supplement_cannot_use_a_key_or_block_local_fit_on_timeout(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            with patch.dict('os.environ', {'THEMEPARKS_API_KEY': 'unused'}), patch.object(
                    nightly.subprocess, 'run', side_effect=subprocess.TimeoutExpired('bootstrap', 90)) as runner:
                result = nightly.supplement_sparse_history(data, data/'catalogue.json', data/'calendar.json',
                                                          data/'local.json', data/'out.json', '2026-11-18')
            self.assertEqual(result, {})
            args, options = runner.call_args
            self.assertEqual(args[0][args[0].index('--days') + 1], '7')
            self.assertEqual(args[0][args[0].index('--history-dir') + 1], str(data/'history'))
            self.assertNotIn('THEMEPARKS_API_KEY', options['env'])

    def test_sparse_local_archive_uses_successful_combined_candidate_only_for_eligible_park(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            fixture(data, observations([17]))
            supplemented = read(nightly.BUNDLED, 'wait-model.json')
            for park in supplemented['parks']:
                park['bootstrap'] = {'historySamples': 50}
            # Sea's broader prior was retained after a failed remote fitting attempt.
            latest_supplement = {'lastObservedDate': '2026-11-17', 'historySamples': 40,
                                 'fit': {'days': 6, 'status': 'insufficient-data', 'validation': None}}
            supplemented['parks'][1]['lastBootstrapAttempt'] = latest_supplement
            with patch.object(nightly, 'supplement_sparse_history', return_value=supplemented):
                nightly.run(data, dt.datetime(2026, 11, 17, 22, tzinfo=nightly.JST))
            state = read(data, 'training-state.json')['parks']
            self.assertEqual(state['land']['fitSource'], 'queue-times+anonymous-history')
            self.assertEqual(state['land']['archiveSamples'], 12)
            self.assertEqual(state['land']['archiveDays'], 1)
            self.assertEqual(state['sea']['fitSource'], 'queue-times')
            model = read(data, 'wait-model.json')['parks']
            self.assertTrue(model[0]['usable'])
            self.assertFalse(model[1]['usable'])
            self.assertEqual(model[1]['lastBootstrapAttempt'], latest_supplement)
            self.assertNotIn('lastBootstrapAttempt', model[0])

    def test_new_install_keeps_short_supplement_as_an_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            fixture(data, observations([17]))
            short = {'parkId': 'sea', 'usable': False, 'days': 6, 'samples': 320,
                     'lastDate': '2026-11-17', 'validation': None,
                     'bootstrap': {'historySamples': 310}}
            with patch.object(nightly, 'supplement_sparse_history', return_value={'parks': [short]}):
                nightly.run(data, dt.datetime(2026, 11, 17, 22, tzinfo=nightly.JST))
            park = read(data, 'wait-model.json')['parks'][1]
            self.assertFalse(park['usable'])
            self.assertEqual(park['samples'], 12)
            self.assertEqual(park['lastBootstrapAttempt']['fit']['samples'], 320)
            self.assertIsNone(read(data, 'training-state.json')['parks']['sea']['activeModelSamples'])

    def test_failed_fit_retains_published_files_and_bounds_retries(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            (data / 'training-state.json').write_text(json.dumps({'completedThrough': '2026-11-16'}))
            (data / 'wait-model.json').write_text('{"prior": true}')
            now = dt.datetime(2026, 11, 18, 4, tzinfo=nightly.JST)
            failure = subprocess.CalledProcessError(1, 'train_wait_model')
            with patch.object(nightly.subprocess, 'run', side_effect=failure) as runner:
                with self.assertRaises(subprocess.CalledProcessError):
                    nightly.run(data, now)
                nightly.run(data, now + dt.timedelta(hours=5, minutes=59))
                self.assertEqual(runner.call_count, 1)
                with self.assertRaises(subprocess.CalledProcessError):
                    nightly.run(data, now + dt.timedelta(hours=6))
                self.assertEqual(runner.call_count, 2)
            self.assertEqual(read(data, 'training-state.json')['completedThrough'], '2026-11-16')
            self.assertEqual(read(data, 'wait-model.json'), {'prior': True})


if __name__ == '__main__':
    unittest.main()
