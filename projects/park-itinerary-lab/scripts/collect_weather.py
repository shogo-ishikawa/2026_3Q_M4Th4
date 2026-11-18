#!/usr/bin/env python3
"""Publish a small forecast cache so browser plans can survive a provider timeout.

Python 3.12 standard library. Each provider is refreshed at most once an hour.
Failed refreshes retain the original collection/issue times of the last good data.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import json
from pathlib import Path
import urllib.request

OPEN_METEO = "https://api.open-meteo.com/v1/forecast?latitude=35.632&longitude=139.883&hourly=temperature_2m,precipitation,precipitation_probability,weather_code&forecast_days=16&timezone=Asia%2FTokyo"
JMA_FORECAST = "https://www.jma.go.jp/bosai/forecast/data/forecast/120000.json"
JMA_SERIES = "https://www.jma.go.jp/bosai/jmatile/data/wdist/VPFD/120010.json"
UTC = dt.timezone.utc


def request_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": "ParkItineraryLab/1.5 (hourly educational forecast cache)"})
    with urllib.request.urlopen(request, timeout=12) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Forecast response is too large")
        return json.loads(raw)


def timestamp(value: str | None) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def weather_fields(code, temperature, precipitation=None) -> dict:
    fields = {}
    if isinstance(code, int) and not isinstance(code, bool):
        if code == 0:
            fields["weather"] = "sun"
        elif code in (1, 2, 3, 45, 48):
            fields["weather"] = "cloud"
        elif code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99):
            fields["weather"] = "rain"
    for key, value, low, high in (("temperature", temperature, -40, 60), ("precipitation", precipitation, 0, 200)):
        if isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high:
            fields[key] = value
    return fields


def hourly_weather(data: dict) -> dict:
    """Match Open-Meteo's JST forecasts to the containing hour, as in web/weather.js."""
    if not isinstance(data, dict) or data.get("timezone", "Asia/Tokyo") != "Asia/Tokyo":
        return {}
    hours = data.get("hourly")
    if not isinstance(hours, dict) or not isinstance(hours.get("time"), list):
        return {}
    times = {}
    for i, stamp in enumerate(hours["time"]):
        try:
            hour = dt.datetime.strptime(stamp, "%Y-%m-%dT%H:00")
        except (TypeError, ValueError):
            continue
        times[hour] = i

    def value(name, index):
        values = hours.get(name)
        return values[index] if isinstance(values, list) and index is not None and index < len(values) else None

    result = {}
    for hour, i in times.items():
        # Precipitation is end-labelled. A gap or missing next day must stay unknown.
        following = times.get(hour + dt.timedelta(hours=1))
        fields = weather_fields(value("weather_code", i), value("temperature_2m", i), value("precipitation", following))
        if fields:
            result[hour.strftime("%Y-%m-%dT%H")] = fields
    return result


def fill_weather(row: dict, weather: dict, source: str) -> dict:
    """Keep existing weather and attribute retrospective additions to their source."""
    fields = ("weather", "temperature", "precipitation")
    added = {key: weather[key] for key in fields if key in weather and row.get(key) in (None, "")}
    if not added:
        return row
    if any(row.get(key) not in (None, "") for key in fields):
        added["supplementalWeather"] = {"source": source, "fields": sorted(added)}
    else:
        added["weatherSource"] = source
    return {**row, **added}


def valid_open_meteo(data) -> bool:
    hours = data.get("hourly") if isinstance(data, dict) else None
    if not isinstance(hours, dict) or not isinstance(hours.get("time"), list) or not 1 <= len(hours["time"]) <= 400:
        return False
    return all(isinstance(hours.get(key), list) and len(hours[key]) == len(hours["time"]) for key in ["temperature_2m", "weather_code", "precipitation", "precipitation_probability"])


def valid_jma(data) -> bool:
    return isinstance(data, list) and 1 <= len(data) <= 5 and isinstance(data[0], dict) and timestamp(data[0].get("reportDatetime")) is not None and isinstance(data[0].get("timeSeries"), list) and bool(data[0]["timeSeries"])


def collect(existing: dict | None = None, *, now: dt.datetime | None = None, fetch=request_json, force: bool = False) -> dict:
    now = (now or dt.datetime.now(UTC)).astimezone(UTC)
    checked_at = now.isoformat().replace("+00:00", "Z")
    previous = existing.get("providers", {}) if isinstance(existing, dict) and existing.get("schemaVersion") == 1 else {}
    providers, failures, pending = {}, [], {}

    def fresh(item, provider):
        valid = valid_open_meteo(item.get("data")) if provider == "open-meteo" else valid_jma(item.get("forecast"))
        fetched = timestamp(item.get("fetchedAt"))
        return valid and fetched is not None and -60 <= (now - fetched).total_seconds() < 3600

    # Three independent official endpoints, bounded by the request timeout.
    with ThreadPoolExecutor(max_workers=3) as executor:
        for provider in ["open-meteo", "jma"]:
            old = previous.get(provider, {})
            if not force and fresh(old, provider):
                providers[provider] = old
                continue
            pending[provider] = executor.submit(fetch, OPEN_METEO if provider == "open-meteo" else JMA_FORECAST)
            if provider == "jma":
                pending["jma-series"] = executor.submit(fetch, JMA_SERIES)
        for provider in ["open-meteo", "jma"]:
            if provider not in pending:
                continue
            try:
                data = pending[provider].result()
                if not (valid_open_meteo(data) if provider == "open-meteo" else valid_jma(data)):
                    raise ValueError("Invalid forecast response")
                if provider == "open-meteo":
                    providers[provider] = {"fetchedAt": checked_at, "sourceUrl": "https://open-meteo.com/", "data": data}
                else:
                    series = None
                    try:
                        candidate = pending["jma-series"].result()
                        if not isinstance(candidate, dict) or candidate.get("reportDateTime") != data[0]["reportDatetime"] or not isinstance(candidate.get("areaTimeSeries"), dict):
                            raise ValueError("Invalid or differently issued JMA three-hour forecast")
                        series = candidate
                    except Exception:
                        failures.append("jma-series")
                    providers[provider] = {"fetchedAt": checked_at, "sourceUrl": "https://www.jma.go.jp/bosai/forecast/", "forecast": data, "series": series}
            except Exception:
                failures.append(provider)
                old = previous.get(provider, {})
                if (valid_open_meteo(old.get("data")) if provider == "open-meteo" else valid_jma(old.get("forecast"))) and timestamp(old.get("fetchedAt")) is not None:
                    providers[provider] = old
    if not providers:
        raise ValueError("No valid forecast was obtained; existing data has not been replaced")
    failed_main = set(failures) & {"open-meteo", "jma"}
    status = "partial" if failures and any(provider not in failed_main for provider in providers) else "failed" if failures else "complete"
    return {"schemaVersion": 1, "providers": providers, "refreshAttempt": {"checkedAt": checked_at, "status": status, "failedProviders": failures}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    existing = None
    if args.output.exists():
        try:
            existing = json.loads(args.output.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    result = collect(existing, force=args.force)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"Forecast cache: {result['refreshAttempt']['status']}; {', '.join(result['providers'])}")


if __name__ == "__main__":
    main()
