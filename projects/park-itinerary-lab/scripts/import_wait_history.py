#!/usr/bin/env python3
"""Validate CSV/JSON wait observations and optionally join archived hourly weather.

Only local observation files are read. Downloaded crowd-calendar pages are not
converted into a redistributable dataset. Output stays in the selected directory.
"""
from __future__ import annotations
import argparse
import csv
import datetime as dt
import io
import json
from pathlib import Path
import urllib.parse
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
WEATHER_ATTRIBUTION = {"name": "Open-Meteo", "url": "https://open-meteo.com/", "kind": "historical-weather", "attribution": "Weather data by Open-Meteo.com (CC BY 4.0)"}


def valid_date(value):
    try:
        return isinstance(value, str) and dt.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def minute_of(value):
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 1440:
        return value
    if isinstance(value, str):
        parts = value.strip().split(":")
        if len(parts) == 2 and all(part.isdigit() for part in parts):
            hour, minute = map(int, parts)
            if 0 <= hour < 24 and 0 <= minute < 60:
                return hour * 60 + minute
    return None


def number(value, minimum, maximum):
    if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
        return None
    try:
        result = float(value)
        return result if minimum <= result <= maximum else None
    except (ValueError, TypeError):
        return None


def load_rows(path):
    if path.suffix.lower() == ".csv":
        return list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("observations"), list):
        return payload["observations"]
    raise ValueError("JSON must be an observation array or contain observations[]")


def normalise_rows(rows, catalogue, before_date):
    activities = {activity["id"]: (park, activity) for park in catalogue["parks"] for activity in park["activities"]}
    result, rejected, dedup = [], {}, {}
    for row in rows:
        reason = None
        if not isinstance(row, dict):
            reason = "record_format"
        else:
            date = row.get("date")
            activity_id = row.get("activityId", row.get("activity_id", row.get("id")))
            minute = minute_of(row.get("time", row.get("minute")))
            wait = number(row.get("wait", row.get("waitMinutes", row.get("wait_minutes"))), 0, 600)
            if not valid_date(date) or date >= before_date:
                reason = "date_or_future"
            elif activity_id not in activities:
                reason = "unknown_activity"
            elif minute is None:
                reason = "time"
            elif wait is None:
                reason = "wait"
            elif row.get("isOpen") is False or row.get("status") in ("CLOSED", "DOWN", "REFURBISHMENT"):
                reason = "not_operating"
        if reason:
            rejected[reason] = rejected.get(reason, 0) + 1
            continue
        park, activity = activities[activity_id]
        opening = minute_of(row.get("openingMinute"))
        if opening is None:
            opening = minute_of(activity.get("windows", [[540, 1260]])[0][0]) or 540
        event = row.get("event")
        if not isinstance(event, str) or not event.strip():
            event = "|".join(item["id"] for item in park.get("events", []) if item["startDate"] <= date <= item["endDate"])
        item = {"date": date, "activityId": activity_id, "time": minute, "wait": wait, "weather": row.get("weather") if row.get("weather") in ("sun", "cloud", "rain") else "", "event": event[:2000], "openingMinute": opening, "source": str(row.get("source") or "user-provided")[:120]}
        for field, limits in (("temperature", (-40, 60)), ("precipitation", (0, 200))):
            value = number(row.get(field), *limits)
            if value is not None:
                item[field] = value
        bucket = 10 if opening <= minute < opening + 90 else 30
        key = (date, activity_id, bucket, minute // bucket)
        dedup[key] = item
    result = sorted(dedup.values(), key=lambda row: (row["date"], row["time"], row["activityId"]))
    return result, rejected


def request_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "ParkItineraryLab/1.3 (educational weather enrichment)"})
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def weather_rows(payload):
    hourly = payload.get("hourly", {})
    result = {}
    for index, stamp in enumerate(hourly.get("time", [])):
        if not isinstance(stamp, str) or len(stamp) < 16:
            continue
        code = hourly.get("weather_code", [])[index] if index < len(hourly.get("weather_code", [])) else None
        weather = "sun" if code == 0 else "cloud" if isinstance(code, (int, float)) and (code <= 3 or code in (45, 48)) else "rain" if isinstance(code, (int, float)) else ""
        row = {"weather": weather}
        for field, api_field, limits in (("temperature", "temperature_2m", (-40, 60)), ("precipitation", "precipitation", (0, 200))):
            values = hourly.get(api_field, [])
            value = number(values[index], *limits) if index < len(values) else None
            if value is not None:
                row[field] = value
        result[(stamp[:10], stamp[11:13])] = row
    return result


def enrich_weather(rows, output, fetch_json=request_json):
    """Join the timestamp's hourly reanalysis; missing values are never invented."""
    dates = sorted({row["date"] for row in rows})
    if not dates:
        return {"matched": 0, "missing": 0, "errors": []}
    cache = output / "weather-cache"
    cache.mkdir(parents=True, exist_ok=True)
    all_weather, errors = {}, []
    cursor, final = dt.date.fromisoformat(dates[0]), dt.date.fromisoformat(dates[-1])
    while cursor <= final:
        end = min(cursor + dt.timedelta(days=30), final)
        cache_file = cache / f"{cursor.isoformat()}_{end.isoformat()}.json"
        try:
            if cache_file.exists():
                payload = json.loads(cache_file.read_text())
            else:
                query = urllib.parse.urlencode({"latitude": 35.632, "longitude": 139.883, "start_date": cursor.isoformat(), "end_date": end.isoformat(), "hourly": "temperature_2m,precipitation,weather_code", "timezone": "Asia/Tokyo"})
                payload = fetch_json("https://archive-api.open-meteo.com/v1/archive?" + query)
                cache_file.write_text(json.dumps(payload, ensure_ascii=False))
            all_weather.update(weather_rows(payload))
        except (OSError, ValueError, KeyError) as error:
            errors.append({"startDate": cursor.isoformat(), "endDate": end.isoformat(), "error": str(error)})
        cursor = end + dt.timedelta(days=1)
    matched = 0
    for row in rows:
        weather = all_weather.get((row["date"], f"{row['time'] // 60:02}"))
        if weather:
            for key, value in weather.items():
                if key == "weather" and row.get("weather"):
                    continue
                if key in ("temperature", "precipitation") and key in row:
                    continue
                row[key] = value
            row["weatherSource"] = "open-meteo-reanalysis"
            matched += 1
    return {"matched": matched, "missing": len(rows) - matched, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--output-dir", type=Path, default=PROJECT / "outputs/imported-waits")
    parser.add_argument("--catalogue", type=Path, default=PROJECT / "web/data/parks.json")
    parser.add_argument("--before-date", default=(dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date() + dt.timedelta(days=1)).isoformat())
    parser.add_argument("--enrich-weather", action="store_true")
    parser.add_argument("--source-name", default="利用者の観測記録")
    parser.add_argument("--source-url", default="")
    args = parser.parse_args()
    if not valid_date(args.before_date):
        parser.error("--before-date must be YYYY-MM-DD")
    source_rows = []
    for path in args.input:
        source_rows.extend(load_rows(path))
    catalogue = json.loads(args.catalogue.read_text())
    rows, rejected = normalise_rows(source_rows, catalogue, args.before_date)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    weather = enrich_weather(rows, args.output_dir) if args.enrich_weather else {"matched": 0, "missing": len(rows), "errors": []}
    sources = [{"name": args.source_name, "url": args.source_url, "kind": "user-provided-observations", "attribution": args.source_name}]
    if args.enrich_weather:
        sources.append(WEATHER_ATTRIBUTION)
    payload = {"observations": rows, "dataSources": sources}
    (args.output_dir / "observations.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    report = {"inputRows": len(source_rows), "observations": len(rows), "days": len({row["date"] for row in rows}), "rejected": rejected, "weather": weather, "beforeDate": args.before_date}
    (args.output_dir / "import-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
