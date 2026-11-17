"""Refresh known facilities from official daily lists and report catalogue changes.

python scripts/update_park_data.py --date 2026-11-17 --output outputs/catalogue-update.json
The original catalogue is preserved unless --apply is supplied.
"""
from datetime import date, datetime
from zoneinfo import ZoneInfo
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen
import argparse
import copy
import json
import re

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://www.tokyodisneyresort.jp'
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        return ' '.join(child.text() if isinstance(child, Node) else child for child in self.children)

    def has_class(self, value):
        return value in self.attrs.get('class', '').split()


class TreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, value):
        self.stack[-1].children.append(value)


def parse_list(html, selected_date, park_id):
    """Parse names, official links and date-specific operating/show times."""
    parser = TreeParser()
    parser.feed(html)
    records = []
    date_class = 'date-' + selected_date.replace('-', '')
    for node in parser.root.walk():
        if node.tag != 'li' or 'data-categorize' not in node.attrs:
            continue
        descendants = list(node.walk())
        heading = next((n for n in descendants if n.tag == 'h3' and n.has_class('heading3')), None)
        anchor = next((n for n in descendants if n.tag == 'a' and n.attrs.get('href')), None)
        if heading is None or anchor is None:
            continue
        name = re.sub(r'\s*NEW!?\s*$', '', heading.text()).strip()
        link = urljoin(ORIGIN, anchor.attrs['href'])
        if urlsplit(link).hostname not in {'www.tokyodisneyresort.jp', 'www.tokyodisneyresort.co.jp'}:
            continue
        area = next((n.text().strip() for n in descendants if n.has_class('area')), '')
        daily = next((n for n in descendants if n.has_class(date_class)), None)
        time_text = daily.text() if daily else None
        times = sorted({int(h) * 60 + int(m) for h, m in re.findall(r'\b(\d{1,2}):(\d{2})\b', time_text or '')})
        is_range = bool(time_text and re.search(r'\d:\d{2}\s*[-–〜～]\s*\d', time_text))
        records.append({'parkId': park_id, 'name': name, 'sourceUrl': link, 'area': area,
                        'hasDailySchedule': daily is not None, 'times': times,
                        'isRange': is_range, 'dpaListed': 'プレミアアクセス対象' in node.text()})
    return records


def url_key(url):
    return urlsplit(url).path.rstrip('/')


def refresh_catalogue(catalogue, records, selected_date):
    """Keep positional data; update only facts matched to an existing official URL."""
    updated = copy.deepcopy(catalogue)
    report = {'date': selected_date, 'changed': [], 'newFacilities': [], 'dpaReview': []}
    for park in updated['parks']:
        known = {url_key(a['sourceUrl']): a for a in park['activities']}
        seen_new = set()
        for record in (r for r in records if r['parkId'] == park['id']):
            activity = known.get(url_key(record['sourceUrl']))
            if activity is None:
                key = url_key(record['sourceUrl'])
                if key not in seen_new:
                    report['newFacilities'].append(record)
                    seen_new.add(key)
                continue
            before = copy.deepcopy(activity)
            activity['name'], activity['area'] = record['name'], record['area']
            activity['checkedOn'] = selected_date
            if record['hasDailySchedule']:
                closed = set(activity.get('closedDates', []))
                if not record['times']:
                    closed.add(selected_date)
                else:
                    closed.discard(selected_date)
                    if record['isRange'] and len(record['times']) >= 2:
                        activity['windows'] = [[record['times'][0], record['times'][-1]]]
                        activity['operatingDate'] = selected_date
                    elif activity['category'] in {'show', 'parade'}:
                        activity['showTimes'] = record['times']
                        activity['showTimesDate'] = selected_date
                activity['closedDates'] = sorted(closed)
            if bool(activity.get('dpa')) != record['dpaListed']:
                report['dpaReview'].append({'id': activity['id'], 'name': activity['name'], 'sourceUrl': record['sourceUrl'],
                                            'listed': record['dpaListed'], 'action': '公式DPA案内で対象と料金を確認する'})
            if activity != before:
                report['changed'].append({'id': activity['id'], 'name': activity['name'],
                                           'fields': [k for k in activity if activity.get(k) != before.get(k)]})
    updated['updatedAt'] = selected_date
    return updated, report


def fetch_lists(selected_date):
    records = []
    for park_id, slug in [('land', 'tdl'), ('sea', 'tds')]:
        for kind in ['attraction', 'show', 'greeting', 'restaurant/list', 'shop/list']:
            url = f'{ORIGIN}/{slug}/{kind}/'
            request = Request(url, headers={'User-Agent': 'ParkItineraryLab/1.0 (public catalogue update)'})
            with urlopen(request, timeout=30) as response:
                html = response.read(8_000_000).decode('utf-8')
            found = parse_list(html, selected_date, park_id)
            if not found:
                raise RuntimeError(f'施設一覧を読み取れませんでした。元のデータは変更しません: {url}')
            print(f'{slug}/{kind}: {len(found)} facilities', flush=True)
            records.extend(found)
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', default=datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat())
    parser.add_argument('--catalogue', type=Path, default=ROOT / 'web/data/parks.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'outputs/catalogue-update.json')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    date.fromisoformat(args.date)
    original = json.loads(args.catalogue.read_text(encoding='utf-8'))
    updated, report = refresh_catalogue(original, fetch_lists(args.date), args.date)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report_path = args.output.with_name(args.output.stem + '-report.json')
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.apply:
        args.catalogue.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Updated catalogue: {args.output}\nChange report: {report_path}')
    print('新施設の位置・DPA対象変更・料金はレポートの公式リンクで確認してください。')


if __name__ == '__main__':
    main()
