#!/usr/bin/env python3
"""Replay fresh-at-capture Queue-Times readings saved by the independent collector."""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from archive_wait_history import BACKUP_COLLECTOR, atomic_json, valid_row
from collect_wait_data import JST, PROJECT, RETAIN_DAYS, day_fields, merge_observations
from collect_weather import timestamp


def validated_observation(row, day, now, activity_fields):
    if not valid_row(row, day) or row['date'] != day.isoformat() or row['activityId'] not in activity_fields:
        return None
    observed = timestamp(row.get('observedAt'))
    received = timestamp(row.get('fetchedAt'))
    if not observed or not received or received > now or not 0 <= (received - observed).total_seconds() <= 900:
        return None
    local = observed.astimezone(JST)
    if local.date() != day or local.hour * 60 + local.minute != row['time']:
        return None
    return {'date': row['date'], 'activityId': row['activityId'], 'time': row['time'], 'wait': row['wait'],
            'observedAt': observed.isoformat().replace('+00:00', 'Z'), 'source': 'queue-times',
            'collector': BACKUP_COLLECTOR, 'weather': '',
            **activity_fields[row['activityId']]}


def run(data, now):
    folder = data / 'backup-observations'
    if not folder.is_dir() or folder.is_symlink():
        return False
    today = now.astimezone(JST).date()
    catalogue = data / 'catalogue.json'
    bundled = PROJECT / 'web' / 'data'
    parks = json.loads((catalogue if catalogue.exists() else bundled / 'parks.json').read_text())['parks']
    mapping = json.loads((bundled / 'queue-times-map.json').read_text())['parks']
    calendar = data / 'calendar.json'
    holidays = json.loads(calendar.read_text()) if calendar.exists() else {}
    incoming = []
    for offset in range(RETAIN_DAYS + 1):
        day = today - dt.timedelta(days=offset)
        path = folder / f'{day}.json'
        if path.is_symlink() or not path.is_file():
            continue
        saved = json.loads(path.read_text())
        if (not isinstance(saved, dict) or type(saved.get('schemaVersion')) is not int or saved['schemaVersion'] != 1
                or saved.get('date') != day.isoformat() or not isinstance(saved.get('observations'), list)):
            raise ValueError(f'Invalid backup observation file: {path.name}')
        fields = {}
        for park in parks:
            allowed = set(mapping[park['id']]['rides'].values())
            metadata = day_fields(park, day.isoformat(), holidays)
            fields.update((activity['id'], metadata) for activity in park['activities'] if activity['id'] in allowed)
        invalid = 0
        for row in saved['observations']:
            checked = validated_observation(row, day, now, fields)
            if checked is None:
                invalid += 1
            else:
                incoming.append(checked)
        if invalid:
            print(f'{path.name}: ignored {invalid} invalid backup readings.', file=sys.stderr)
    if not incoming:
        return False
    path = data / 'observations.json'
    existing = json.loads(path.read_text()) if path.exists() else []
    if not isinstance(existing, list):
        raise ValueError('Recent observations must be a record array')
    # A later catalogue correction can change the opening bucket width. Keep the
    # primary row on an exact observation-time match, regardless of that width.
    known = {(row['activityId'], row.get('observedAt')) for row in existing if row.get('source') == 'queue-times'}
    missing = [row for row in incoming if (row['activityId'], row['observedAt']) not in known]
    if not missing:
        return False
    merged = merge_observations(missing, existing, today)
    if merged == existing:
        return False
    atomic_json(path, merged)
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    args = parser.parse_args()
    changed = run(args.data_dir, dt.datetime.now(dt.timezone.utc))
    print('Merged backup readings.' if changed else 'No change to recent observations.')
