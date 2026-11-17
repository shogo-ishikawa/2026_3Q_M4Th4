#!/usr/bin/env python3
"""Train forecasts from the recent ThemeParks.wiki history without publishing raw data.

Anonymous access permits seven calendar days (today is included). Raw responses and
normalised observations stay in a temporary directory. Only fitted coefficients,
validation statistics and aggregate metadata are written to --output-model.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
API = 'https://api.themeparks.wiki/v1'
JST = dt.timezone(dt.timedelta(hours=9))
PARK_IDS = {'land': '3cc919f1-d16d-43e0-8c3f-1dd269bd1a42',
            'sea': '67b290d5-3478-4f23-b601-2f8fb71ba803'}
SOURCES = [{'name': 'ThemeParks.wiki', 'url': 'https://www.themeparks.wiki/',
            'kind': 'recent-historical-waits', 'attribution': 'Powered by ThemeParks.wiki',
            'termsUrl': 'https://www.themeparks.wiki/terms'},
           {'name': 'Open-Meteo', 'url': 'https://open-meteo.com/',
            'kind': 'past-weather-forecast', 'attribution': 'Weather data by Open-Meteo.com',
            'licenceUrl': 'https://creativecommons.org/licenses/by/4.0/'}]


def request_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={'User-Agent': 'ParkItineraryLab/1.3 (educational forecast training)'})
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read(16_000_001)
    if len(raw) > 16_000_000:
        raise ValueError('Response is larger than the permitted training input.')
    return json.loads(raw)


def timestamp(value: object) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def entity_mapping(children: dict, park: dict) -> dict[str, str]:
    """The provider externalId is the official TDR facility ID, not a fuzzy name match."""
    activities = {item['id']: item for item in park['activities']}
    result = {}
    for entity in children.get('children', []):
        if entity.get('entityType') != 'ATTRACTION':
            continue
        local_id = f"{park['id']}-attraction-{entity.get('externalId')}"
        if local_id in activities and activities[local_id].get('category') == 'attraction':
            result[entity['id']] = local_id
    return result


def opening_minute(park: dict, date: str) -> int:
    values = []
    for activity in park['activities']:
        schedule = activity.get('dailySchedules', {}).get(date, {})
        windows = schedule.get('windows') or activity.get('windows', [])
        if schedule.get('closed'):
            continue
        values.extend(pair[0] for pair in windows if len(pair) == 2 and isinstance(pair[0], int) and 360 <= pair[0] <= 720)
    return min(values, default=540)


def normalise_history(payload: dict, park: dict, mapping: dict[str, str], date: str,
                      *, now: dt.datetime | None = None) -> list[dict]:
    """Use observed changes only; never manufacture a zero or fill an absent day."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if payload.get('id') != PARK_IDS[park['id']] or payload.get('timezone') != 'Asia/Tokyo':
        raise ValueError('History is for another park or timezone.')
    if payload.get('range', {}).get('from') != date or payload.get('range', {}).get('to') != date:
        raise ValueError('History date does not match the requested day.')
    if payload.get('next'):
        raise ValueError('A park-day response unexpectedly requires pagination.')
    opening = opening_minute(park, date)
    buckets = {}
    for entity in payload.get('entities', []):
        activity_id = mapping.get(entity.get('id'))
        if not activity_id:
            continue
        events = list(entity.get('history', []))
        carried = entity.get('opening') or {}
        # Opening can carry a value from weeks ago. Only a same-day actual observation is eligible.
        by_kind = carried.get('observedAtByKind')
        observed = timestamp(by_kind.get('queue.STANDBY') if isinstance(by_kind, dict) else carried.get('observedAt'))
        if not carried.get('degraded') and observed and observed.astimezone(JST).date().isoformat() == date:
            events.append({**carried, 'time': observed.isoformat()})
        for event in events:
            at = timestamp(event.get('time'))
            wait = ((event.get('queue') or {}).get('STANDBY') or {}).get('waitTime')
            if (not at or at > now or at.astimezone(JST).date().isoformat() != date
                    or event.get('status') != 'OPERATING' or not isinstance(wait, (int, float))
                    or isinstance(wait, bool) or not math.isfinite(wait) or not 0 <= wait <= 600):
                continue
            local = at.astimezone(JST)
            minute = local.hour * 60 + local.minute
            width = 10 if opening <= minute < opening + 90 else 30
            key = (activity_id, minute // width, width)
            row = {'date': date, 'activityId': activity_id, 'time': minute, 'wait': wait,
                   'openingMinute': opening, 'weather': '', 'temperature': None, 'precipitation': None,
                   'event': '|'.join(item['id'] for item in park.get('events', [])
                                    if item['startDate'] <= date <= item['endDate']),
                   'source': 'themeparks-wiki', 'observedAt': at.isoformat().replace('+00:00', 'Z')}
            if key not in buckets or row['observedAt'] > buckets[key]['observedAt']:
                buckets[key] = row
    return sorted(buckets.values(), key=lambda item: (item['date'], item['time'], item['activityId']))


def weather_lookup(payload: dict) -> dict[str, dict]:
    hourly = payload.get('hourly') or {}
    result = {}
    for index, time in enumerate(hourly.get('time', [])):
        def value(key):
            values = hourly.get(key) or []
            number = values[index] if index < len(values) else None
            return number if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) else None
        code = value('weather_code')
        result[time[:13]] = {'weather': '' if code is None else 'sun' if code == 0 else 'cloud' if code <= 3 or code in (45, 48) else 'rain',
                            'temperature': value('temperature_2m'), 'precipitation': value('precipitation'),
                            'weatherSource': 'open-meteo-past-forecast'}
    return result


def enrich_weather(rows: list[dict], lookup: dict[str, dict]) -> list[dict]:
    return [{**row, **lookup.get(row['date'] + 'T' + str(row['time'] // 60).zfill(2), {})} for row in rows]


def fetch_day(park: dict, mapping: dict, date: str, private_dir: Path) -> tuple[list[dict], dict]:
    cache = private_dir / f"{park['id']}-history-{date}.json"
    url = f"{API}/entity/{PARK_IDS[park['id']]}/history?date={date}"
    try:
        payload = json.loads(cache.read_text()) if cache.exists() else request_json(url)
        cache.write_text(json.dumps(payload, ensure_ascii=False))
        rows = normalise_history(payload, park, mapping, date)
        return rows, {'parkId': park['id'], 'date': date, 'samples': len(rows), 'status': 'ok'}
    except urllib.error.HTTPError as error:
        # Do not bypass authentication/window restrictions or spin on a spent hourly budget.
        return [], {'parkId': park['id'], 'date': date, 'samples': 0, 'status': f'HTTP {error.code}'}
    except (OSError, ValueError, TypeError, KeyError) as error:
        return [], {'parkId': park['id'], 'date': date, 'samples': 0, 'status': type(error).__name__}


def choose_model(candidate: dict, prior: dict | None) -> dict:
    if not prior:
        return candidate
    # A brief outage or a shorter new history must not destroy a useful existing predictor.
    if prior.get('usable') and (not candidate.get('usable')
            or str(candidate.get('lastDate', '')) < str(prior.get('lastDate', ''))
            or candidate.get('days', 0) < prior.get('days', 0)
            or (str(candidate.get('firstDate', '')) > str(prior.get('firstDate', ''))
                and str(candidate.get('lastDate', '')) <= str(prior.get('lastDate', '')))):
        return {**prior, 'lastBootstrapAttempt': candidate.get('bootstrap')}
    return candidate


def fit_models(rows: list[dict], catalogue: dict, calendar: dict | None, before_date: str,
               model_module: Path) -> dict:
    script = ('import {trainWaitModel} from ' + json.dumps(model_module.as_uri()) + ';'
              "let raw='';for await(const c of process.stdin)raw+=c;const d=JSON.parse(raw);"
              "console.log(JSON.stringify({schemaVersion:2,updatedAt:new Date().toISOString(),parks:d.parks.map(p=>trainWaitModel(d.rows,p,{beforeDate:d.beforeDate,calendarData:d.calendar,dataSources:d.sources}))}));")
    output = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps({'rows': rows, 'parks': catalogue['parks'], 'calendar': calendar, 'beforeDate': before_date, 'sources': SOURCES}), text=True, capture_output=True, check=True)
    return json.loads(output.stdout)


def bootstrap(args, private_dir: Path) -> dict:
    catalogue = json.loads(args.catalogue.read_text())
    calendar = json.loads(args.calendar.read_text()) if args.calendar and args.calendar.exists() else None
    end = dt.date.fromisoformat(args.end_date)
    dates = [(end - dt.timedelta(days=offset)).isoformat() for offset in range(args.days - 1, -1, -1)]
    rows, reports = [], []
    jobs = []
    for park in catalogue['parks']:
        cache = private_dir / f"{park['id']}-children.json"
        children = json.loads(cache.read_text()) if cache.exists() else request_json(f"{API}/entity/{PARK_IDS[park['id']]}/children")
        cache.write_text(json.dumps(children, ensure_ascii=False))
        mapping = entity_mapping(children, park)
        jobs.extend((park, mapping, date, private_dir) for date in dates)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for observations, report in pool.map(lambda job: fetch_day(*job), jobs):
            rows.extend(observations); reports.append(report)
    weather = {}
    try:
        weather_url = 'https://historical-forecast-api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode({'latitude': 35.632, 'longitude': 139.883, 'hourly': 'temperature_2m,precipitation,weather_code', 'start_date': dates[0], 'end_date': dates[-1], 'timezone': 'Asia/Tokyo'})
        weather_cache = private_dir / 'past-weather.json'
        payload = json.loads(weather_cache.read_text()) if weather_cache.exists() else request_json(weather_url)
        weather_cache.write_text(json.dumps(payload))
        weather = weather_lookup(payload)
    except (OSError, ValueError):
        pass
    rows = enrich_weather(rows, weather)
    # This file is deliberately private and never included in either source ZIP or public data branch.
    (private_dir / 'normalised-history.json').write_text(json.dumps(rows, ensure_ascii=False))
    existing = []
    if args.history_dir and args.history_dir.exists():
        for month in sorted(args.history_dir.glob('????-??.json')):
            archived = json.loads(month.read_text())
            existing.extend(archived if isinstance(archived, list) else archived.get('observations', []))
    if args.existing_observations and args.existing_observations.exists():
        existing.extend(json.loads(args.existing_observations.read_text()))
    # Provider history wins exact duplicate buckets only because it has richer time/weather detail.
    rows = existing + rows
    before = (end + dt.timedelta(days=1)).isoformat()
    result = fit_models(rows, catalogue, calendar, before, args.model_module.resolve())
    previous = json.loads(args.fallback_model.read_text()) if args.fallback_model and args.fallback_model.exists() else {}
    for index, model in enumerate(result['parks']):
        model['dataSources'] = SOURCES
        model['bootstrap'] = {'provider': 'themeparks-wiki', 'fromDate': dates[0], 'throughDate': dates[-1],
                              'partialThroughDate': dates[-1] if dates[-1] == dt.datetime.now(JST).date().isoformat() else None,
                              'attemptedAt': result['updatedAt'], 'requestedDays': args.days,
                              'observedDays': len({row['date'] for row in rows if row['activityId'].startswith(model['parkId'] + '-')}),
                              'weatherProvenance': 'past-weather-forecast' if weather else 'unavailable',
                              'requests': [row for row in reports if row['parkId'] == model['parkId']]}
        prior = next((item for item in previous.get('parks', []) if item.get('parkId') == model['parkId']), None)
        result['parks'][index] = choose_model(model, prior)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalogue', type=Path, default=PROJECT / 'web/data/parks.json')
    parser.add_argument('--calendar', type=Path)
    parser.add_argument('--existing-observations', type=Path)
    parser.add_argument('--history-dir', type=Path, help='Monthly Queue-Times history, not private provider data')
    parser.add_argument('--output-model', type=Path, required=True)
    parser.add_argument('--fallback-model', type=Path)
    parser.add_argument('--private-dir', type=Path)
    parser.add_argument('--days', type=int, choices=range(1, 8), default=7)
    parser.add_argument('--end-date', default=dt.datetime.now(JST).date().isoformat())
    parser.add_argument('--model-module', type=Path, default=PROJECT / 'web/wait-model.js')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='park-history-') as temporary:
        private_dir = args.private_dir.resolve() if args.private_dir else Path(temporary)
        # Raw provider data must not become a public asset or a tracked source file.
        repository = PROJECT.parents[1]
        if private_dir.is_relative_to(repository):
            raise ValueError('--private-dir must be outside the repository; only derived models may be published.')
        private_dir.mkdir(parents=True, exist_ok=True)
        result = bootstrap(args, private_dir)
    args.output_model.parent.mkdir(parents=True, exist_ok=True)
    args.output_model.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    for model in result['parks']:
        print(f"{model['parkId']}: {model['status']}, {model['days']} days, {model['samples']} samples, usable={model['usable']}")


if __name__ == '__main__':
    main()
