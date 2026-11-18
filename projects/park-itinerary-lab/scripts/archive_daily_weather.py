#!/usr/bin/env python3
"""Compare as-issued forecasts with JMA's hourly measurements near both parks."""
import argparse
import datetime as dt
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import urllib.request

from archive_wait_history import JST, atomic_json
from collect_weather import timestamp
from nightly_wait_training import latest_closed_day


STATION = {"id": "44136", "name": "江戸川臨海", "provider": "気象庁アメダス"}
METRICS = {"temperature": (-60, 60), "precipitation": (0, 500)}


def station_url(day):
    return ("https://www.data.jma.go.jp/stats/etrn/view/hourly_a1.php?prec_no=44&block_no=0370"
            f"&year={day.year}&month={day.month}&day={day.day}&view=")


class HourlyTable(HTMLParser):
    """Extract only the hourly observation table and its station/date heading."""

    def __init__(self):
        super().__init__()
        self.heading = ""
        self.in_heading = self.in_table = False
        self.row = []
        self.cell = None
        self.rows = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "h3":
            self.in_heading = True
        if tag == "table" and attrs.get("id") == "tablefix1":
            self.in_table = True
        if self.in_table and tag == "tr":
            self.row = []
        if self.in_table and tag in ("td", "th"):
            self.cell = [tag, attrs.get("class", ""), ""]

    def handle_data(self, data):
        if self.in_heading:
            self.heading += data
        if self.cell is not None:
            self.cell[2] += data

    def handle_endtag(self, tag):
        if tag == "h3":
            self.in_heading = False
        if self.in_table and tag == "table":
            self.in_table = False
        if self.cell is not None and tag == self.cell[0]:
            self.row.append(self.cell)
            self.cell = None
        if self.in_table and tag == "tr":
            self.rows.append(self.row)


def valid_number(value, metric):
    low, high = METRICS[metric]
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def parse_observations(html, day):
    table = HourlyTable()
    table.feed(html)
    heading = re.sub(r"\s+", "", table.heading)
    date_label = f"{day.year}年{day.month}月{day.day}日"
    if STATION["name"] not in heading or date_label not in heading:
        raise ValueError("Wrong AMeDAS station or date")
    if not table.rows or [cell[2].strip() for cell in table.rows[0][:3]] != ["時", "降水量(mm)", "気温(℃)"]:
        raise ValueError("Unrecognised JMA hourly table")
    hours = {}
    for row in table.rows[1:]:
        if len(row) < 3 or row[0][0] != "td" or not row[0][2].strip().isdigit():
            continue
        end_hour = int(row[0][2].strip())
        if not 1 <= end_hour <= 24:
            continue
        # Temperature is instantaneous. Rain labelled 10:00 fell during 09:00–10:00.
        for metric, column, start in (("precipitation", 1, end_hour - 1), ("temperature", 2, end_hour)):
            _, quality, value = row[column]
            value = value.strip()
            if start >= 24 or quality != "data_0_0" or not re.fullmatch(r"-?\d+(?:\.\d+)?", value):
                continue
            number = float(value)
            if valid_number(number, metric):
                hours.setdefault(start * 60, {})[metric] = number
    return hours


def fetch_observations(day):
    request = urllib.request.Request(station_url(day), headers={"User-Agent": "TDRoute/1 (park weather comparison)"})
    with urllib.request.urlopen(request, timeout=15) as reply:
        data = reply.read(600_001)
    if len(data) > 600_000:
        raise ValueError("Unexpected JMA response size")
    return parse_observations(data.decode("utf-8"), day)


def park_hours(park, day):
    windows = park.get("operatingCalendar", {}).get(day, {}).get("windows")
    if windows is None:
        windows = [[540, 1260]]
    return sorted({minute for start, end in windows for minute in range(start // 60 * 60, end, 60)})


def compare(day, park, issue, observed):
    date = day.isoformat()
    issued = timestamp(issue.get("issuedAt"))
    fetched = timestamp(issue.get("weatherFetchedAt"))
    hours = park_hours(park, date)
    source = issue.get("weatherProvider")
    issued_hours = {}
    if source in ("jma", "open-meteo") and fetched and issued and fetched <= issued:
        midnight = dt.datetime.combine(day, dt.time.min, tzinfo=JST)
        for row in issue.get("weatherHours", []):
            minute = row.get("minute")
            if minute in hours and row.get("endMinute") == minute + 60 and issued < midnight + dt.timedelta(minutes=minute):
                issued_hours[minute] = row
    metrics = {}
    for name in METRICS:
        forecast = {m: v[name] for m, v in issued_hours.items() if valid_number(v.get(name), name)}
        measured = {m: observed[m][name] for m in hours if name in observed.get(m, {})}
        errors = [forecast[m] - measured[m] for m in sorted(forecast.keys() & measured.keys())]
        metrics[name] = {"forecastHours": len(forecast), "observedHours": len(measured), "matchedHours": len(errors),
                         "meanError": round(sum(errors) / len(errors), 3) if errors else None,
                         "mae": round(sum(abs(error) for error in errors) / len(errors), 3) if errors else None}
    return {"parkId": park["id"], "operatingHours": hours, "issuedAt": issue.get("issuedAt"),
            "weatherProvider": source, "weatherFetchedAt": issue.get("weatherFetchedAt"),
            "forecastHours": [{"minute": minute, **{name: value[name] for name in METRICS if valid_number(value.get(name), name)}}
                              for minute, value in sorted(issued_hours.items())],
            "metrics": metrics}


def read(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else default


def archive_day(data, day, now, parks, fetch):
    directory = data / "weather-daily"
    directory.mkdir(exist_ok=True)
    path = directory / (day.isoformat() + ".json")
    previous = read(path, {})
    checked = timestamp(previous.get("checkedAt"))
    age = (now.astimezone(JST).date() - day).days
    # Recently closed days can still be arriving. A longstanding sensor gap needs fewer requests.
    retry_after = dt.timedelta(hours=3) if age <= 2 else dt.timedelta(days=7 if age < 30 else 30)
    if checked and (previous.get("status") == "complete" or now - checked < retry_after):
        return False
    observed = {row["minute"]: {name: row[name] for name in METRICS if valid_number(row.get(name), name)}
                for row in previous.get("observedHours", [])}
    try:
        for minute, fields in fetch(day).items():
            observed.setdefault(minute, {}).update(fields)
    except (OSError, ValueError) as error:
        print(f"AMeDAS {day}: {error}")
    forecast = read(data / "forecasts" / path.name, {})
    issues = {entry["parkId"]: entry for entry in forecast.get("parks", []) if forecast.get("date") == day.isoformat()}
    comparisons = [compare(day, park, issues.get(park["id"], {}), observed) for park in parks]
    relevant = sorted({m for item in comparisons for m in item["operatingHours"]})
    present = [{"minute": m, **observed[m]} for m in relevant if observed.get(m)]
    complete = all(len(observed.get(minute, {})) == len(METRICS) for minute in relevant)
    status = "complete" if complete else "partial" if present else "unavailable"
    result = {"schemaVersion": 1, "date": day.isoformat(), "station": {**STATION, "sourceUrl": station_url(day)},
              "checkedAt": now.isoformat(), "status": status, "observedHours": present, "parks": comparisons}
    atomic_json(path, result)
    print(f"{day} {STATION['name']}: {status}, {len(present)}/{len(relevant)} operating hours.")
    return True


def run(data, now, fetch=fetch_observations):
    latest = latest_closed_day(data, now)
    sources = [data / "catalogue.json", Path(__file__).resolve().parents[1] / "web/data/parks.json"]
    catalogue = read(next(path for path in sources if path.is_file()), {})
    parks = [p for p in catalogue["parks"] if p["id"] in ("land", "sea")]
    dates = {latest}
    for directory in ("accuracy-daily", "forecasts"):
        dates.update(dt.date.fromisoformat(p.stem) for p in (data / directory).glob("????-??-??.json"))
    # Recover operating days before the first saved forecast from the compact archive index.
    for entry in read(data / "history-index.json", {}).get("files", []):
        if entry.get("firstDate") and entry.get("lastDate"):
            first = dt.date.fromisoformat(entry["firstDate"])
            last = min(latest, dt.date.fromisoformat(entry["lastDate"]))
            dates.update(first + dt.timedelta(days=i) for i in range((last - first).days + 1))
    directory = data / "weather-daily"
    days = sorted((d for d in dates if d <= latest), reverse=True)
    days.sort(key=lambda d: (d != latest, (directory / (d.isoformat() + ".json")).is_file()))
    # Bound historical backfill and space retries for a delayed station report.
    attempted = 0
    for day in days:
        if archive_day(data, day, now, parks, fetch):
            attempted += 1
        if attempted == 2:
            break


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    args = parser.parse_args()
    run(args.data_dir, dt.datetime.now(dt.timezone.utc))
