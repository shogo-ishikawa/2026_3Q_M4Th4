#!/usr/bin/env python3
"""Collect documented Queue-Times current data; retain observations for local training.

Python 3.12 standard library. Does not scrape historical calendars or third-party pages.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
from pathlib import Path
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
JST = dt.timezone(dt.timedelta(hours=9))


def request_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "ParkItineraryLab/1.2 (educational current-wait collector)"})
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def normalise(payload: dict, park: dict, mapping: dict, fetched_at: str) -> dict:
    activities = {item["id"] for item in park["activities"]}
    rides, unmatched = [], []
    all_rides = list(payload.get("rides", []))
    for land in payload.get("lands", []):
        all_rides.extend(land.get("rides", []))
    seen = set()
    for ride in all_rides:
        provider_id = ride.get("id")
        if not isinstance(provider_id, int) or isinstance(provider_id, bool) or provider_id < 0 or provider_id in seen:
            continue
        seen.add(provider_id)
        activity_id = mapping["rides"].get(str(provider_id))
        if activity_id not in activities:
            unmatched.append({"providerId": provider_id, "name": str(ride.get("name", ""))[:200]})
            continue
        wait = ride.get("wait_time")
        try:
            timestamp = dt.datetime.fromisoformat(ride["last_updated"].replace("Z", "+00:00"))
        except (KeyError, ValueError, TypeError):
            continue
        if timestamp.tzinfo is None:
            continue
        if not isinstance(wait, (int, float)) or isinstance(wait, bool) or not 0 <= wait <= 600 or not isinstance(ride.get("is_open"), bool):
            continue
        rides.append({"activityId": activity_id, "providerId": provider_id, "name": str(ride.get("name", ""))[:200], "wait": wait, "isOpen": ride["is_open"], "updatedAt": timestamp.isoformat().replace("+00:00", "Z")})
    if not rides:
        raise ValueError(f"No mapped rides returned for {park['id']}")
    return {"schemaVersion": 1, "provider": "queue-times", "parkId": park["id"], "providerParkId": mapping["providerParkId"], "fetchedAt": fetched_at, "sourceUrl": f"https://queue-times.com/parks/{mapping['providerParkId']}/queue_times.json", "attributionUrl": "https://queue-times.com/", "rides": rides, "unmatched": unmatched}


def to_observations(snapshot: dict, park: dict, weather: str = "") -> list[dict]:
    result = []
    fetched = dt.datetime.fromisoformat(snapshot["fetchedAt"].replace("Z", "+00:00"))
    for ride in snapshot["rides"]:
        updated = dt.datetime.fromisoformat(ride["updatedAt"].replace("Z", "+00:00"))
        if not ride["isOpen"] or not 0 <= (fetched - updated).total_seconds() <= 900:
            continue
        local = updated.astimezone(JST)
        date = local.date().isoformat()
        event = "|".join(item["id"] for item in park.get("events", []) if item["startDate"] <= date <= item["endDate"])
        result.append({"date": date, "activityId": ride["activityId"], "time": local.hour * 60 + local.minute, "wait": ride["wait"], "weather": weather, "event": event, "source": "queue-times", "observedAt": ride["updatedAt"]})
    return result


def merge_observations(existing: list[dict], incoming: list[dict], today: dt.date, retain_days: int = 60) -> list[dict]:
    earliest = (today - dt.timedelta(days=retain_days)).isoformat()
    rows = {}
    for row in existing + incoming:
        if earliest <= row.get("date", "") <= today.isoformat():
            key = (row["date"], row["activityId"], int(row["time"]) // 30)
            rows[key] = row
    return sorted(rows.values(), key=lambda row: (row["date"], row["time"], row["activityId"]))[-100000:]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--fixture-dir", type=Path, help="Read land.json/sea.json instead of the network")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    catalogue = json.loads((PROJECT / "web/data/parks.json").read_text())
    mappings = json.loads((PROJECT / "web/data/queue-times-map.json").read_text())["parks"]
    now = dt.datetime.now(dt.timezone.utc)
    fetched_at = now.isoformat().replace("+00:00", "Z")
    prior_path = args.output_dir / "live-waits.json"
    prior = json.loads(prior_path.read_text()) if prior_path.exists() else {"parks": []}
    observations_path = args.output_dir / "observations.json"
    existing = json.loads(observations_path.read_text()) if observations_path.exists() else []
    snapshots, incoming = [], []
    weather = ""
    if not args.fixture_dir:
        try:
            current = request_json("https://api.open-meteo.com/v1/forecast?latitude=35.632&longitude=139.883&current=weather_code&timezone=Asia%2FTokyo")["current"]
            code = current["weather_code"]
            weather = "sun" if code == 0 else "cloud" if code <= 3 or code in (45, 48) else "rain"
        except (OSError, ValueError, KeyError):
            pass  # Unknown weather is retained as unknown, never fabricated.
    for park in catalogue["parks"]:
        mapping = mappings[park["id"]]
        try:
            payload = json.loads((args.fixture_dir / f"{park['id']}.json").read_text()) if args.fixture_dir else request_json(f"https://queue-times.com/parks/{mapping['providerParkId']}/queue_times.json")
            snapshot = normalise(payload, park, mapping, fetched_at)
            incoming.extend(to_observations(snapshot, park, weather))
            print(f"{park['id']}: {len(snapshot['rides'])} mapped rides, {len(snapshot['unmatched'])} unmatched")
        except (OSError, ValueError) as error:
            snapshot = next((item for item in prior["parks"] if item["parkId"] == park["id"]), None)
            if snapshot is None:
                raise RuntimeError(f"Could not collect {park['id']}") from error
            print(f"{park['id']}: kept earlier snapshot ({error})")
        snapshots.append(snapshot)
    document = {"schemaVersion": 1, "updatedAt": fetched_at, "attribution": "Powered by Queue-Times.com", "attributionUrl": "https://queue-times.com/", "weatherAttributionUrl": "https://open-meteo.com/", "parks": snapshots}
    prior_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    rows = merge_observations(existing, incoming, now.astimezone(JST).date())
    observations_path.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Saved {len(rows)} observed waits (60-day retention, one per ride per half hour).")


if __name__ == "__main__":
    main()
