"""Compare archived posted waits with measured weather after closing (descriptive only)."""
import datetime as dt
import json
from pathlib import Path
import statistics

from archive_wait_history import JST, bucket, valid_row


def station_hours(directory, date):
    try:
        day = json.loads((directory / (date + '.json')).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    if not isinstance(day, dict) or day.get('date') != date or day.get('schemaVersion') != 1:
        return {}
    station = day.get('station')
    if not isinstance(station, dict) or station.get('id') != '44136':
        return {}
    rows = day.get('observedHours')
    if not isinstance(rows, list):
        return {}
    return {row['minute']: row for row in rows if isinstance(row, dict)
            and type(row.get('minute')) is int and 0 <= row['minute'] < 1440 and row['minute'] % 60 == 0}


def correlation(pairs):
    days = len({day for day, _, _ in pairs})
    coefficient = None
    if len(pairs) >= 20 and days >= 3:
        try:
            coefficient = round(statistics.correlation([x for _, x, _ in pairs], [y for _, _, y in pairs]), 3)
        except statistics.StatisticsError:
            pass  # A constant variable has no defined correlation.
    return {'samples': len(pairs), 'days': days, 'r': coefficient}


def summarise_observed_waits(rows, catalogue, weather_daily_dir):
    """The caller supplies only archived rows through the last completed operating day."""
    parks = ('land', 'sea')
    baselines = {}
    for park in catalogue['parks']:
        if park['id'] not in parks:
            continue
        for ride in park['activities']:
            base = ride.get('baseWait')
            if type(base) in (float, int) and 0 < base <= 600:
                baselines[ride['id']] = (park['id'], max(5, base))

    # Use the latest genuine post in the same time bucket as the public archive.
    days = {}
    for row in rows:
        if not valid_row(row, dt.date.max) or row['activityId'] not in baselines:
            continue
        try:
            posted = dt.datetime.fromisoformat(row.get('observedAt', '').replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            continue
        if posted.tzinfo is None:
            continue
        minute = row['time']
        local = posted.astimezone(JST)
        if local.date().isoformat() != row['date'] or local.hour * 60 + local.minute != minute:
            continue
        group = days.setdefault(row['date'], {})
        key = (row['activityId'], bucket(row))
        if key not in group or posted >= group[key][0]:
            group[key] = (posted, minute, row['wait'])

    metrics = {'temperature': (-60, 60), 'precipitation': (0, 500)}
    pairs = {p: {field: [] for field in metrics} for p in parks}
    eligible = dict.fromkeys(parks, 0)
    matched = dict.fromkeys(parks, 0)
    matched_days = {p: set() for p in parks}
    for date, observations in days.items():
        hours = station_hours(Path(weather_daily_dir), date)
        for (ride_id, _), (_, minute, wait) in observations.items():
            park_id, base = baselines[ride_id]
            eligible[park_id] += 1
            hour = hours.get(minute // 60 * 60, {})
            match = False
            for field, (low, high) in metrics.items():
                value = hour.get(field)
                if type(value) in (float, int) and low <= value <= high:
                    pairs[park_id][field].append((date, value, wait / base))
                    match = True
            if match:
                matched[park_id] += 1
                matched_days[park_id].add(date)
    return {p: {'stationId': '44136', 'eligibleSamples': eligible[p], 'matchedSamples': matched[p],
                'matchedDays': len(matched_days[p]), 'firstDate': min(matched_days[p], default=None),
                'lastDate': max(matched_days[p], default=None),
                **{field: correlation(values) for field, values in pairs[p].items()}} for p in parks}
