#!/usr/bin/env python3
"""Capture Queue-Times observations on an independent host and check nightly publication."""
from __future__ import annotations

import argparse
import base64
from collections import defaultdict
import datetime as dt
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from archive_wait_history import valid_row
from collect_wait_data import JST, PROJECT, normalise, request_json, to_observations
from nightly_wait_training import latest_closed_day, nightly_output_issues

BRANCH = 'park-wait-data'
DEFAULT_REPO = 'shogo-ishikawa/2026_3Q_M4Th4'


def compact(document):
    return (json.dumps(document, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


class GitHub:
    def __init__(self, repository, token):
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
            raise ValueError('Expected a GitHub owner/repository.')
        self.url = 'https://api.github.com/repos/' + repository
        self.public = 'https://raw.githubusercontent.com/' + repository + '/' + BRANCH + '/'
        self.token = token

    def request(self, path, method='GET', body=None, raw=False):
        headers = {'User-Agent': 'TDRoute wait watchdog',
                   'Accept': 'application/vnd.github.raw+json' if raw else 'application/vnd.github+json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        req = Request(self.url + path, method=method, headers=headers,
                      data=None if body is None else compact(body))
        if self.token:
            req.add_unredirected_header('Authorization', 'Bearer ' + self.token)
        with urlopen(req, timeout=25) as response:
            data = response.read()
            return json.loads(data) if data else None

    def read_file(self, path, raw=True):
        try:
            if raw and not self.token:
                # Public checks do not consume the host's anonymous REST quota.
                with urlopen(Request(self.public + path), timeout=25) as response:
                    return json.load(response)
            return self.request('/contents/' + path + '?ref=' + BRANCH, raw=raw)
        except HTTPError as error:
            if error.code != 404:
                raise
            return None

    def backup(self, day, incoming):
        path = 'backup-observations/' + day + '.json'
        for attempt in range(3):
            metadata = self.read_file(path, raw=False)
            if metadata is None:
                old = []
            else:
                blob = metadata
                # Contents responses above 1 MiB omit the base64 body.
                if metadata['encoding'] == 'none':
                    blob = self.request('/git/blobs/' + metadata['sha'])
                saved = json.loads(base64.b64decode(blob['content']))
                if saved['schemaVersion'] != 1 or saved['date'] != day:
                    raise ValueError('Unexpected backup file for ' + day)
                old = saved['observations']
            if not isinstance(old, list):
                raise ValueError('Invalid saved observation array for ' + day)
            rows = {}
            for row in old + incoming:
                if not valid_row(row, dt.date.fromisoformat(day)) or row['date'] != day:
                    raise ValueError('Invalid backup observation for ' + day)
                if not row.get('observedAt') or not row.get('fetchedAt'):
                    raise ValueError('Missing observation or receipt timestamp for ' + day)
                rows.setdefault((row['activityId'], row['observedAt']), row)
            existing = {(r['activityId'], r['observedAt']) for r in old}
            if rows.keys() == existing:
                return
            document = {'schemaVersion': 1, 'date': day, 'observations': sorted(
                rows.values(), key=lambda row: (row['observedAt'], row['activityId']))}
            body = {'branch': BRANCH, 'message': 'Save independently observed park waits for ' + day,
                    'content': base64.b64encode(compact(document)).decode()}
            if metadata is not None:
                body['sha'] = metadata['sha']
            try:
                self.request('/contents/' + path, 'PUT', body)
                return
            except HTTPError as error:
                if error.code not in (409, 422) or attempt == 2:
                    raise
                time.sleep(attempt + 1)

    def dispatch(self, mode, day=None):
        inputs = {'mode': mode}
        if day:
            inputs['business_date'] = day.isoformat()
        self.request('/actions/workflows/park-wait-data.yml/dispatches', 'POST',
                     {'ref': 'main', 'inputs': inputs})
        print('Dispatched', mode, day or '')


def persist(spool, rows):
    by_date = defaultdict(list)
    for row in rows:
        by_date[row['date']].append(row)
    for day, values in by_date.items():
        destination = spool / f'{day}.{uuid4().hex}.json'
        with tempfile.NamedTemporaryFile(dir=spool, delete=False) as temp:
            try:
                temp.write(compact(values))
                temp.flush()
                os.fsync(temp.fileno())
            except BaseException:
                Path(temp.name).unlink(missing_ok=True)
                raise
        os.replace(temp.name, destination)
        # Make the rename durable across a host restart on a POSIX filesystem.
        fd = os.open(spool, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def capture(spool, catalogue, current_time):
    mappings = json.loads((PROJECT / 'web/data/queue-times-map.json').read_text())['parks']
    failed = []
    expected = set()
    for park in catalogue['parks']:
        park_id = park['id']
        local = current_time().astimezone(JST)
        hours = park.get('operatingCalendar', {}).get(local.date().isoformat(), {}).get('windows')
        if hours is None and park.get('openingHours'):
            hours = [park['openingHours']]
        if hours is not None and not any(start <= local.hour * 60 + local.minute < end for start, end in hours):
            continue
        expected.add(park_id)
        mapping = mappings[park_id]
        try:
            payload = request_json(f"https://queue-times.com/parks/{mapping['providerParkId']}/queue_times.json")
            fetched_at = current_time().isoformat().replace('+00:00', 'Z')
            snapshot = normalise(payload, park, mapping, fetched_at)
            rows = to_observations(snapshot, park)
            if not rows:
                failed.append(f'{park_id}: no fresh operating rides at {fetched_at}.')
            persist(spool, [{**row, 'fetchedAt': fetched_at} for row in rows])
            print(f'{park_id}: spooled {len(rows)} eligible observations at {fetched_at}.')
        except (OSError, ValueError) as error:
            failed.append(f'{park_id}: {error}')
    return expected, failed


def flush(spool, github):
    files = defaultdict(list)
    for path in sorted(spool.glob('????-??-??.*.json')):
        files[path.name[:10]].append(path)
    for day, paths in files.items():
        rows = []
        for path in paths:
            try:
                rows.extend(json.loads(path.read_text(encoding='utf-8')))
            except FileNotFoundError:
                continue  # A concurrent watchdog already uploaded this receipt.
        if rows:
            github.backup(day, rows)
        for path in paths:
            path.unlink(missing_ok=True)


def parks_in_slot(observations, when):
    local = when.astimezone(JST)
    start = local.replace(minute=local.minute // 30 * 30, second=0, microsecond=0)
    parks = set()
    for row in observations or []:
        if not valid_row(row, start.date()) or row['date'] != start.date().isoformat():
            continue
        if row.get('collector') == 'watchdog':
            continue  # A backup receipt does not prove that the primary collector ran.
        at_text = row.get('observedAt')
        if not isinstance(at_text, str):
            continue
        try:
            at = dt.datetime.fromisoformat(at_text.replace('Z', '+00:00'))
        except ValueError:
            continue
        if at.tzinfo and start <= at <= when:
            parks.add(row['activityId'].partition('-')[0])
    return parks


def run(args, current_time=lambda: dt.datetime.now(dt.timezone.utc)):
    when = current_time()
    if args.action != 'check':
        if args.spool_dir is None:
            raise ValueError('--spool-dir is required for collect and recover.')
        args.spool_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.action == 'collect':
        catalogue = json.loads(args.catalogue.read_text(encoding='utf-8'))
        expected, errors = capture(args.spool_dir, catalogue, current_time)
    # Save each live response locally before attempting any GitHub operation.
    token = os.getenv('TDROUTE_GITHUB_TOKEN')
    if args.action != 'check' and not token:
        raise ValueError('Set TDROUTE_GITHUB_TOKEN on the watchdog host.')
    github = GitHub(args.repository, token)
    if args.action != 'check':
        flush(args.spool_dir, github)
    if args.action == 'collect':
        if expected and expected - parks_in_slot(github.read_file('observations.json'), current_time()):
            github.dispatch('collect')
        if errors:
            raise RuntimeError('; '.join(errors))
        return

    # Use the published calendar as the workflow does for a later-than-usual closing.
    catalogue = github.read_file('catalogue.json')
    with tempfile.TemporaryDirectory() as directory:
        if catalogue:
            (Path(directory) / 'catalogue.json').write_bytes(compact(catalogue))
        day = latest_closed_day(Path(directory), when)
    tomorrow = (day + dt.timedelta(days=1)).isoformat()
    issues = nightly_output_issues(github.read_file('training-state.json') or {},
                                  github.read_file(f'forecasts/{tomorrow}.json') or {}, day)
    if issues:
        message = f'{day}: ' + ', '.join(issues)
        if args.action == 'check':
            raise RuntimeError(message)
        print(message)
        github.dispatch('recover', day)
    else:
        print(f'{day}: both parks completed training and issued the next forecast.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['collect', 'recover', 'check'],
                        help='check reads the public training state and forecasts without writing or dispatching')
    parser.add_argument('--repository', default=DEFAULT_REPO)
    parser.add_argument('--spool-dir', type=Path, help='local receipt directory (required for collect and recover)')
    parser.add_argument('--catalogue', type=Path, default=PROJECT / 'web/data/parks.json')
    try:
        run(parser.parse_args())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f'Watchdog failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
