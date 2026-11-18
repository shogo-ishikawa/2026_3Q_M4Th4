#!/usr/bin/env python3
"""Refresh the four public data files from a network that can reach the sources.

This command writes a reviewable bundle. It never edits main, publishes source
HTML, requests credentials or changes the data branch by itself.
"""
import argparse
from datetime import datetime
import json
from pathlib import Path
import subprocess
import shutil
import sys
from zoneinfo import ZoneInfo

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))


def refresh(output, previous=None, visit_date=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    day = visit_date or datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat()
    catalogue = output/'catalogue.json'
    old_calendar = Path(previous).parent/'calendar.json' if previous else SCRIPTS.parent/'web/data/calendar.json'
    if not (output/'calendar.json').exists() and old_calendar.exists():
        shutil.copyfile(old_calendar, output/'calendar.json')
    command = [sys.executable, str(SCRIPTS/'update_park_data.py'), '--output', str(catalogue), '--date', day]
    if previous:
        command += ['--previous-catalogue', str(previous)]
    facts = subprocess.run(command).returncode
    # Each updater preserves last-known facts and records actual success dates.
    from update_food_menus import update_catalogue, atomic_json
    result, menus = update_catalogue(json.loads(catalogue.read_text()), day)
    atomic_json(catalogue, result)
    print(f"Food menus: {menus['updated']}/{menus['checked']} verified; {menus['status']}", flush=True)
    calendar = subprocess.run([sys.executable, str(SCRIPTS/'update_calendar.py'), '--output', str(output/'calendar.json')]).returncode
    report = {'checkedAt':datetime.now(ZoneInfo('UTC')).isoformat().replace('+00:00','Z'),
              'status':'failed' if calendar else 'complete', 'lastKnownCalendarUsed':bool(calendar)}
    atomic_json(output/'calendar-report.json', report)
    return int(bool(facts or calendar or menus['status'] == 'failed'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--previous-catalogue', type=Path)
    parser.add_argument('--date')
    args = parser.parse_args()
    return refresh(args.output_dir, args.previous_catalogue, args.date)


if __name__ == '__main__':
    raise SystemExit(main())
