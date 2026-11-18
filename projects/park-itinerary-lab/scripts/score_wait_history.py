#!/usr/bin/env python3
"""Score closed park days using the provider's recent standby change history.

All API responses stay in memory. Only park-level error metrics and retry times
are written to the public data branch. The stored forecasts are read-only.
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import urllib.error
from pathlib import Path

from archive_wait_history import atomic_json
from bootstrap_wait_history import (API, JST, PARK_IDS, PROJECT, entity_mapping,
                                    normalise_history, request_json, timestamp)
from nightly_wait_training import latest_closed_day, RETRY_DELAY


def read(path, fallback=None):
    if path.is_file():
        return json.loads(path.read_text(encoding='utf8'))
    return fallback


def aggregate(park, forecast, now, children, payload):
    day = forecast['date']
    observations = normalise_history(payload, park, entity_mapping(children, park), day,
                                     now=now, keep_changes=True)
    data = dict(date=day, parkId=park['id'], forecast=forecast, observations=observations,
                asOf=now.isoformat())
    result = subprocess.run(['node', str(PROJECT/'scripts'/'aggregate_wait_history.mjs')],
                            input=json.dumps(data), capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def pending_jobs(data, now, attempts):
    # Closed dates within the anonymous window also work with a registered key.
    # Published summaries remain readable long after the raw window expires.
    local_day = now.astimezone(JST).date()
    first = local_day - dt.timedelta(days=6)
    day = latest_closed_day(data, now)
    while day >= first:
        key = day.isoformat()
        forecast = read(data/'forecasts'/(key+'.json'), {})
        if forecast.get('schemaVersion') == 1 and forecast.get('date') == key:
            summary = read(data/'accuracy-history'/(key+'.json'), {'parks': []})
            finished = {(park['parkId'], park['issuedAt']) for park in summary['parks']}
            for park in forecast['parks']:
                identity = park['parkId']
                if identity not in PARK_IDS or not park['rows'] or (identity, park['issuedAt']) in finished:
                    continue
                last = timestamp(attempts.get(key, {}).get(identity))
                if last is None or now - last >= RETRY_DELAY:
                    yield key, identity, forecast
        day -= dt.timedelta(days=1)


def save_score(directory, day, summary):
    path = directory/(day+'.json')
    result = read(path, {'schemaVersion':1, 'date':day, 'source':'themeparks-wiki',
                         'method':'latest-standby-change-per-slot', 'parks':[]})
    prior = [entry for entry in result['parks'] if entry['parkId'] != summary['parkId']]
    result['parks'] = sorted([*prior, summary], key=lambda park: park['parkId'])
    atomic_json(path, result)


def run(data, now, fetch=request_json):
    directory = data/'accuracy-history'
    marker = directory/'state.json'
    state = read(marker, {'attempts':{}})
    first = (now.astimezone(JST).date() - dt.timedelta(days=6)).isoformat()
    attempts = {date:parks for date, parks in state['attempts'].items() if date >= first}
    jobs = list(pending_jobs(data, now, attempts))
    if not jobs:
        return
    directory.mkdir(exist_ok=True)
    # Four park-day history calls per invocation at most. Children lookups are
    # shared across dates. Each park-day has a six-hour automatic retry delay.
    published = data/'catalogue.json'
    catalogue = read(published if published.exists() else PROJECT/'web'/'data'/'parks.json')
    parks = {park['id']:park for park in catalogue['parks']}
    children = {}
    errors = []
    for day, park_id, forecast in jobs[:4]:
        base = API + '/entity/' + PARK_IDS[park_id]
        attempts.setdefault(day, {})[park_id] = now.isoformat()
        atomic_json(marker, {'attempts':attempts})
        try:
            if park_id not in children:
                children[park_id] = fetch(base+'/children')
            history = fetch(base+'/history?date='+day)
            summary = aggregate(parks[park_id], forecast, now, children[park_id], history)
            if summary:
                save_score(directory, day, summary)
                print(f"{day} {park_id}: compared {summary['matched']} of {summary['expected']} slots.")
            else:
                print(f"{day} {park_id}: insufficient eligible observations for a park-level result.")
        except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
            errors.append(f'{day} {park_id}: {type(error).__name__}')
            if isinstance(error, urllib.error.HTTPError) and error.code in (401,403,429):
                # The limit applies across parks. Postpone pending calls as well.
                for pending_day, pending_park, _ in jobs:
                    attempts.setdefault(pending_day, {})[pending_park] = now.isoformat()
                atomic_json(marker, {'attempts':attempts})
                break
    if errors:
        raise RuntimeError('History comparison deferred: '+', '.join(errors))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get('THEMEPARKS_API_KEY') or None
    run(args.data_dir, dt.datetime.now(dt.timezone.utc), lambda url:request_json(url, api_key=key))
