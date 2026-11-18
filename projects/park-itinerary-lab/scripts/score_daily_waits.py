#!/usr/bin/env python3
"""Save closed-day scores against locally collected Queue-Times waits, before fitting."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys

from archive_wait_history import atomic_json
from nightly_wait_training import latest_closed_day

SCRIPTS = Path(__file__).resolve().parent


def read(path, default):
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding='utf-8'))


def report_dates(data, last):
    # Recover every saved forecast lacking a report. Revisit recent dates to pick
    # up delayed observations. Record the latest closed day even if issuance failed.
    dates = {last}
    for path in (data / 'forecasts').glob('????-??-??.json'):
        day = dt.date.fromisoformat(path.stem)
        if day <= last and (last - day <= dt.timedelta(days=1)
                            or not (data / 'accuracy-daily' / path.name).is_file()):
            dates.add(day)
    return sorted(dates)


def date_rows(path, dates):
    rows = read(path, [])
    if not isinstance(rows, list):
        raise ValueError(f'Expected observation array in {path.name}')
    return [row for row in rows if isinstance(row, dict) and row.get('date') in dates
            and row.get('source') == 'queue-times']


def preserve_coverage(prior, current):
    new_crowd = current['crowd']
    previous_comparison = (prior or {}).get('intradayComparison')
    current_comparison = current.get('intradayComparison')
    if prior and prior['issuedAt']:
        if current['issuedAt'] and (prior['issuedAt'] != current['issuedAt']
                                    or prior['slotsInDay'] != current['slotsInDay']):
            raise ValueError('The saved forecast for an already scored park has changed.')
        # Prefer more matched slots, then more distinct posted measurements
        # within them. New opening-time posts can change a slot's median.
        def support(park):
            return park['overall']['matched'], park['overall'].get('samples', 0)

        if not current['issuedAt']:
            new_crowd = prior['crowd']
            current = dict(prior)
        elif support(prior) > support(current):
            current = dict(prior)
        # A retry may recover more wait slots while omitting earlier crowd reference slots.
        # Keep the better-supported crowd reading independently of overall wait coverage.
        def crowd_support(entry):
            return entry.get('observedLevel') is not None, entry['slots'], entry['matched']

        prior_crowd = prior['crowd']
        best_crowd = max((new_crowd, prior_crowd), key=crowd_support)
        current['crowd'] = {**best_crowd}
        if 'expected' not in current['crowd'] and new_crowd.get('expected') is not None:
            current['crowd']['expected'] = new_crowd['expected']
    comparisons = [entry for entry in (current_comparison, previous_comparison) if entry]
    if comparisons:
        current['intradayComparison'] = max(comparisons, key=lambda entry: (
            entry['matched'], entry['samples'], entry['expected']))
    return current


def save_report(data, date, observations, now):
    forecast = read(data / 'forecasts' / (date + '.json'), None)
    if forecast is not None and (forecast.get('schemaVersion') != 1 or forecast.get('date') != date
                                 or forecast.get('slotMinutes') != 30 or not isinstance(forecast.get('parks'), list)):
        raise ValueError(f'Invalid saved forecast for {date}.')
    payload = dict(date=date, forecast=forecast, observations=observations,
                   asOf=now.isoformat(), source='queue-times')
    issues = []
    for path in sorted((data / 'forecasts-intraday' / date).glob('*-????.json')):
        try:
            issues.append(read(path, None))
        except (OSError, ValueError) as error:
            print(f'Ignoring unreadable intraday issue {path.name}: {error}', file=sys.stderr)
    if issues:
        payload['intradayIssues'] = issues
    scored = subprocess.run(['node', str(SCRIPTS / 'aggregate_wait_history.mjs')],
                            input=json.dumps(payload), capture_output=True, text=True, check=True)
    parks = json.loads(scored.stdout)
    if any(park['overall']['expected'] < park['slotsInDay'] for park in parks):
        raise ValueError(f'{date} still has unelapsed forecast slots. A later run will retry.')
    output = data / 'accuracy-daily' / (date + '.json')
    prior = read(output, {})
    prior_parks = {park['parkId']: park for park in prior.get('parks', [])}
    report = dict(schemaVersion=1, date=date, source='queue-times', method='median-per-slot',
                  parks=[preserve_coverage(prior_parks.get(park['parkId']), park) for park in parks])
    if report != prior:
        output.parent.mkdir(exist_ok=True)
        atomic_json(output, report)
    for park in report['parks']:
        counts = park['overall']
        print(f"{date} {park['parkId']}: {park['status']}, {counts['matched']}/{counts['expected']} slots.")


def run(data, now):
    dates = [day.isoformat() for day in report_dates(data, latest_closed_day(data, now))]
    days = set(dates)
    recent = date_rows(data / 'observations.json', days)
    for month in sorted({day[:7] for day in days}):
        rows = date_rows(data / 'history' / (month + '.json'), days)
        for day in dates:
            if day.startswith(month):
                observations = [row for row in rows + recent if row['date'] == day]
                save_report(data, day, observations, now)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    args = parser.parse_args()
    run(args.data_dir, dt.datetime.now(dt.timezone.utc))
