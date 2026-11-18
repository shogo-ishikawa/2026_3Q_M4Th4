#!/usr/bin/env python3
"""Catch up the nightly wait-history job on the first available GitHub runner."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys

from archive_wait_history import JST, atomic_json, update_archive

SCRIPTS = Path(__file__).resolve().parent
RETRY_DELAY = dt.timedelta(hours=6)


def closed_day(now):
    local = now.astimezone(JST)
    if local.time() >= dt.time(21, 55):
        return local.date()
    return local.date() - dt.timedelta(days=1)


def training_due(state, day, now):
    if state.get('completedThrough', '') >= day:
        return False
    if state.get('attemptedFor') != day:
        return True
    last = dt.datetime.fromisoformat(state['attemptedAt'])
    return now - last >= RETRY_DELAY


def training_complete(model, day):
    parks = {park['parkId']: park for park in model['parks']}
    for park_id in ('land', 'sea'):
        park = parks.get(park_id, {})
        # When validation keeps an older model, inspect the NEW fitting attempt.
        retained = park.get('lastBootstrapAttempt')
        attempt = retained or park.get('bootstrap') or {}
        if attempt.get('lastObservedDate') != day or (retained and attempt.get('failedDays')):
            return False
    return True


def run(data, now, force=False):
    marker = data / 'training-state.json'
    state = json.loads(marker.read_text()) if marker.exists() else {}
    day = closed_day(now).isoformat()
    if not force and not training_due(state, day, now):
        print(f'No nightly training due for {day}.')
        return
    state.update(attemptedFor=day, attemptedAt=now.isoformat())
    atomic_json(marker, state)
    # Archive current-day observations as well. Only complete days enter training.
    update_archive(data, now.astimezone(JST).date())
    fallback = SCRIPTS.parent / 'web' / 'data'
    catalogue = data / 'catalogue.json'
    calendar = data / 'calendar.json'
    model = data / 'wait-model.json'
    # bootstrap keeps provider responses in its temporary directory and writes the
    # resulting model atomically, so a failed attempt leaves the prior model intact.
    subprocess.run([
        sys.executable, str(SCRIPTS / 'bootstrap_wait_history.py'),
        '--catalogue', str(catalogue if catalogue.exists() else fallback / 'parks.json'),
        '--calendar', str(calendar if calendar.exists() else fallback / 'calendar.json'),
        '--history-dir', str(data / 'history'), '--end-date', day,
        '--output-model', str(model), '--fallback-model', str(model),
        '--max-history-requests', '1000',
    ], check=True)
    if not training_complete(json.loads(model.read_text()), day):
        raise RuntimeError(f'Incomplete wait history for {day}. A later collection can retry.')
    state['completedThrough'] = day
    atomic_json(marker, state)
    print(f'Archived and evaluated wait history through {day}.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--force', action='store_true', help='Run even if already processed or recently attempted')
    args = parser.parse_args()
    run(args.data_dir, dt.datetime.now(dt.timezone.utc), args.force)
