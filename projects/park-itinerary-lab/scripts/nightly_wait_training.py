#!/usr/bin/env python3
"""Archive the collected waits and fit a model after the last park closes."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from archive_wait_history import JST, atomic_json, update_archive
from train_wait_model import fit_summary, load_history
from observed_wait_summary import summarise_observed_waits

SCRIPTS = Path(__file__).resolve().parent
BUNDLED = SCRIPTS.parent / 'web' / 'data'
RETRY_DELAY = dt.timedelta(hours=6)
NIGHTLY_MINUTE = 21 * 60 + 55


def closed_day(now, closing_minute=NIGHTLY_MINUTE):
    local = now.astimezone(JST)
    if local.hour * 60 + local.minute >= closing_minute:
        return local.date()
    return local.date() - dt.timedelta(days=1)


def latest_closed_day(data, now):
    """Gate both parks together, including a later published closing time."""
    key = now.astimezone(JST).date().isoformat()
    ends = {}
    for path in (BUNDLED / 'parks.json', data / 'catalogue.json'):
        if path.exists():
            for park in json.loads(path.read_text())['parks']:
                if park['id'] not in ('land', 'sea'):
                    continue
                hours = park.get('operatingCalendar', {}).get(key, {}).get('windows', [])
                closes = [w[1] for w in hours if isinstance(w, list) and len(w) == 2
                          and type(w[1]) is int and 0 < w[1] <= 1440]
                if closes:
                    ends[park['id']] = max(closes)
    return closed_day(now, max([NIGHTLY_MINUTE, *ends.values()]))


def training_due(state, day, now):
    if state.get('completedThrough', '') >= day:
        return False
    if state.get('attemptedFor') != day:
        return True
    last = dt.datetime.fromisoformat(state['attemptedAt'])
    return now - last >= RETRY_DELAY


def supplement_sparse_history(data, catalogue, calendar, local_model, output, day):
    """Try the free recent history window, capped independently of any configured key."""
    env = os.environ.copy()
    env.pop('THEMEPARKS_API_KEY', None)
    try:
        subprocess.run([
            sys.executable, str(SCRIPTS / 'bootstrap_wait_history.py'),
            '--catalogue', str(catalogue), '--calendar', str(calendar),
            '--history-dir', str(data / 'history'), '--forecast-dir', str(data / 'forecasts'), '--end-date', day,
            '--days', '7', '--max-history-requests', '14',
            '--fallback-model', str(local_model), '--output-model', str(output),
        ], env=env, timeout=90, check=True)
        return json.loads(output.read_text())
    except (subprocess.SubprocessError, OSError, ValueError) as error:
        print(f'Anonymous supplement unavailable ({type(error).__name__}). Using the local fit.')
        return {}


def run(data, now, force=False):
    marker = data / 'training-state.json'
    state = json.loads(marker.read_text()) if marker.exists() else {}
    end = latest_closed_day(data, now)
    day = end.isoformat()
    if not force and not training_due(state, day, now):
        print(f'No nightly training due for {day}.')
        return
    state.update(attemptedFor=day, attemptedAt=now.isoformat())
    atomic_json(marker, state)
    # Archive current-day observations as well. Only complete days enter training.
    update_archive(data, now.astimezone(JST).date())
    catalogue = data / 'catalogue.json'
    calendar = data / 'calendar.json'
    catalogue = catalogue if catalogue.exists() else BUNDLED / 'parks.json'
    calendar = calendar if calendar.exists() else BUNDLED / 'calendar.json'
    model = data / 'wait-model.json'
    # Fit from all archived measurements. No historical provider or key is needed.
    # A private output path keeps partial writes out of the published branch.
    with tempfile.TemporaryDirectory(dir=data) as temporary:
        candidate = Path(temporary) / 'candidate.json'
        subprocess.run([
            sys.executable, str(SCRIPTS / 'train_wait_model.py'),
            '--catalogue', str(catalogue),
            '--calendar', str(calendar),
            '--history-dir', str(data / 'history'), '--forecast-dir', str(data / 'forecasts'),
            '--before-date', (end + dt.timedelta(days=1)).isoformat(),
            '--output', str(candidate), '--fallback-model', str(model),
        ], check=True)
        result = json.loads(candidate.read_text())
        needed = {park['parkId'] for park in result['parks']
                  if 'latestAttempt' in park or not park['usable'] or park['lastDate'] != day}
        supplements = {}
        supplemental_attempts = {}
        if needed:
            augmented = supplement_sparse_history(data, catalogue, calendar, candidate,
                                                   Path(temporary) / 'augmented.json', day)
            for park in augmented.get('parks', []):
                park_id = park['parkId']
                if park_id not in needed:
                    continue
                provider = park.get('bootstrap', {})
                attempt = park.get('lastBootstrapAttempt')
                if attempt:
                    # The fitter retained the wider prior and summarised the new candidate.
                    if attempt.get('fit') and attempt.get('historySamples', 0) > 0:
                        supplemental_attempts[park_id] = attempt
                elif provider.get('historySamples', 0) > 0:
                    if park['usable'] and park['lastDate'] == day:
                        supplements[park_id] = park
                    else:
                        supplemental_attempts[park_id] = {**provider, 'fit': fit_summary(park)}
        archived, _ = load_history(data / 'history')
        closed_rows = (row for row in archived if row['date'] <= day)
        weather_statistics = summarise_observed_waits(
            closed_rows, json.loads(catalogue.read_text()), data / 'weather-daily')
        attempts = {}
        for index, park in enumerate(result['parks']):
            fit = park.get('latestAttempt', park)
            park_id = park['parkId']
            active = supplements.get(park_id, park)
            if park_id in supplemental_attempts:
                active['lastBootstrapAttempt'] = supplemental_attempts[park_id]
            result['parks'][index] = active
            attempts[park_id] = {
                'archiveThrough': fit['lastDate'], 'archiveDays': fit['days'], 'archiveSamples': fit['samples'],
                'lastObservedDate': active['lastDate'] if park_id in supplements else fit['lastDate'],
                'activeModelThrough': active['lastDate'], 'retainedPriorModel': 'latestAttempt' in active,
                'activeModelSamples': active['samples'] if active['usable'] else None,
                'activeModelDays': active['days'] if active['usable'] else None,
                'observedWeather': weather_statistics[park_id],
                'fitSource': 'queue-times+anonymous-history' if park_id in supplements else 'queue-times',
            }
        if set(attempts) != {'land', 'sea'}:
            raise ValueError('Expected fitting attempts for both parks.')
        atomic_json(model, result)
    state['parks'] = attempts
    complete = all(attempt['lastObservedDate'] == day for attempt in attempts.values())
    if complete:
        state['completedThrough'] = day
    atomic_json(marker, state)
    if not complete:
        raise RuntimeError(f'Collected waits are incomplete for {day}. A later run can retry.')
    print(f'Archived and fitted collected waits through {day}.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--force', action='store_true', help='Run even if already processed or recently attempted')
    args = parser.parse_args()
    run(args.data_dir, dt.datetime.now(dt.timezone.utc), args.force)
