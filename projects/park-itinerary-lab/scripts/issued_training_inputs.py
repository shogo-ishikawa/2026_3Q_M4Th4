"""Pair historical waits with the inputs available when their park forecast was issued."""
import datetime as dt
import json
import re

JST = dt.timezone(dt.timedelta(hours=9))


def forecasts_for_day(directory, day):
    if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        return {}
    path = directory / (day + '.json')
    if not path.is_file():
        return {}
    document = json.loads(path.read_text())
    if document.get('date') != day or document.get('slotMinutes') != 30:
        return {}
    by_park = {}
    for park in document.get('parks', []):
        # Older forecasts kept a daily weather assumption but no hourly inputs.
        if not isinstance(park.get('weatherHours'), list):
            continue
        issued = dt.datetime.fromisoformat(park['issuedAt'])
        if issued.tzinfo is None:
            continue
        midnight = dt.datetime.fromisoformat(day).replace(tzinfo=JST)
        minutes_after_midnight = (issued - midnight).total_seconds() / 60
        slot_ends = {}
        for row in park['rows']:
            start = row['minute']
            if start > minutes_after_midnight:
                slot_ends[start] = max(slot_ends.get(start, start), row.get('endMinute', start + 30))
        hours = {hour['minute']: hour for hour in park['weatherHours']}
        by_park[park['parkId']] = {'ends': slot_ends, 'hours': hours,
                                   'factors': park.get('visitDayFactors', {})}
    return by_park


def with_issued_inputs(rows, directory):
    """Retain the observed wait as the target. Never use a later weather measurement as an issued input."""
    if directory is None:
        return rows
    result = []
    days = {}
    for row in rows:
        if not isinstance(row, dict):
            result.append(row)
            continue
        day = row.get('date')
        minute = row.get('time')
        if isinstance(minute, str) and re.fullmatch(r'(?:[01]?\d|2[0-3]):[0-5]\d', minute):
            hour, minutes = minute.split(':')
            minute = int(hour) * 60 + int(minutes)
        if not isinstance(day, str) or type(minute) is not int or not 0 <= minute < 1440:
            result.append(row)
            continue
        if day not in days:
            days[day] = forecasts_for_day(directory, day)
        park_id = str(row.get('activityId', '')).partition('-')[0]
        snapshot = days[day].get(park_id)
        if snapshot and minute < snapshot['ends'].get(minute // 30 * 30, 0):
            weather = snapshot['hours'].get(minute // 60 * 60, {})
            row = {**row, 'weather': weather.get('weather'), 'temperature': weather.get('temperature'),
                   'precipitation': weather.get('precipitation'), 'issuedVisitFactors': snapshot['factors']}
        result.append(row)
    return result
