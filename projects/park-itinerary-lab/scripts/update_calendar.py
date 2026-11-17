#!/usr/bin/env python3
"""Update Japanese public holidays from the Cabinet Office CSV (Python standard library)."""
from __future__ import annotations
import argparse
import csv
import datetime as dt
import io
import json
from pathlib import Path
import urllib.request

SOURCE = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'
PAGE = 'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html'


def parse_holidays(raw: bytes) -> list[dict]:
    content = raw.decode('utf-8-sig') if raw.startswith(b'\xef\xbb\xbf') else raw.decode('cp932')
    result = {}
    for row in csv.reader(io.StringIO(content)):
        if len(row) < 2:
            continue
        try:
            date = dt.datetime.strptime(row[0].strip(), '%Y/%m/%d').date().isoformat()
        except ValueError:
            continue  # CSV heading.
        name = row[1].strip()
        if not name or len(name) > 100:
            raise ValueError('Invalid public holiday name')
        if date in result and result[date] != name:
            raise ValueError('Conflicting public holiday date')
        result[date] = name
    if not result:
        raise ValueError('No public holidays were found')
    return [{'date': date, 'name': name} for date, name in sorted(result.items())]


def calendar_document(raw: bytes) -> dict:
    rows = parse_holidays(raw)
    return {'schemaVersion': 1, 'updatedAt': dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
            'sourceUrl': SOURCE, 'sourcePage': PAGE,
            'attribution': '内閣府「国民の祝日」CSVを加工',
            'coverage': {'startDate': rows[0]['date'][:4]+'-01-01', 'endDate': rows[-1]['date'][:4]+'-12-31'},
            'holidays': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--input', type=Path, help='Use a previously downloaded official CSV')
    args = parser.parse_args()
    if args.input:
        raw = args.input.read_bytes()
    else:
        request = urllib.request.Request(SOURCE, headers={'User-Agent': 'ParkItineraryLab/1.3 educational-calendar'})
        with urllib.request.urlopen(request, timeout=25) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError('Holiday CSV is unexpectedly large')
    document = calendar_document(raw)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    temporary.replace(args.output)
    print(f"Updated {len(document['holidays'])} holidays through {document['coverage']['endDate']}")


if __name__ == '__main__':
    main()
