"""Refresh known facilities from official daily lists and report catalogue changes.

python scripts/update_park_data.py --date 2026-11-17 --output outputs/catalogue-update.json
The original catalogue is preserved unless --apply is supplied.
"""
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, parse_qs
from urllib.request import Request, urlopen
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import argparse
import copy
import json
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from official_http import fetch_html

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


def valid_times(value):
    return sorted({int(h) * 60 + int(m) for h, m in re.findall(r'\b(\d{1,2}):(\d{2})\b', value or '') if int(h) <= 24 and int(m) < 60 and (int(h) < 24 or int(m) == 0)})


def daily_schedule(node):
    value = node.text()
    windows = sorted({(int(h1)*60+int(m1), int(h2)*60+int(m2)) for h1,m1,h2,m2 in re.findall(r'\b(\d{1,2}):(\d{2})\s*[-–〜～]\s*(\d{1,2}):(\d{2})\b', value) if int(h1)<24 and int(h2)<=24 and int(m1)<60 and int(m2)<60 and (int(h2)<24 or int(m2)==0) and int(h1)*60+int(m1)<int(h2)*60+int(m2)})
    times = valid_times(value)
    explicitly_closed = bool(re.search(r'終日(?:運営|公演|中止)|本日の運営はありません|休止|休演|運営中止|公演中止', value))
    return {'times': times, 'windows': [list(pair) for pair in windows], 'isRange': bool(windows), 'closed': explicitly_closed, 'published': bool(times) or explicitly_closed}


def parse_list(html, selected_date, park_id):
    """Parse all published dates once, retaining the selected day's legacy fields."""
    parser = TreeParser()
    parser.feed(html)
    records = []
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
        schedules = {}
        for daily in descendants:
            for class_name in daily.attrs.get('class', '').split():
                match = re.fullmatch(r'date-(\d{4})(\d{2})(\d{2})', class_name)
                if match:
                    try:
                        day = date(*map(int, match.groups())).isoformat()
                    except ValueError:
                        continue
                    schedules[day] = daily_schedule(daily)
        selected = schedules.get(selected_date, {})
        records.append({'parkId': park_id, 'name': name, 'sourceUrl': link, 'area': area,
                        'hasDailySchedule': selected_date in schedules, 'hasConfirmedSchedule': selected.get('published',False), 'times': selected.get('times', []),
                        'windows': selected.get('windows', []), 'isRange': selected.get('isRange', False),
                        'dailySchedules': schedules, 'dpaListed': 'プレミアアクセス対象' in node.text()})
    return records


def parse_stops(html, park_id, source_url):
    """Official closure periods include single-day and open-ended closures."""
    parser = TreeParser(); parser.feed(html)
    records = []
    for node in parser.root.walk():
        if node.tag != 'li':
            continue
        children = list(node.walk())
        heading = next((n for n in children if n.has_class('heading3')), None)
        anchor = next((n for n in children if n.tag == 'a' and n.attrs.get('href')), None)
        if not heading or not anchor:
            continue
        dates = re.findall(r'(\d{4})/(\d{1,2})/(\d{1,2})', node.text())
        if not dates:
            continue
        try:
            start = date(*map(int, dates[0])).isoformat()
            end = date(*map(int, dates[1])).isoformat() if len(dates) > 1 else None if '未定' in node.text() else start
        except ValueError:
            continue
        if end is not None and end < start:
            continue
        link = urljoin(ORIGIN, anchor.attrs['href'])
        if urlsplit(link).hostname != 'www.tokyodisneyresort.jp':
            continue
        records.append({'parkId':park_id,'name':heading.text().strip(),'sourceUrl':link,'startDate':start,'endDate':end,'periodSourceUrl':source_url})
    return records


def japanese_range(value):
    start = re.search(r'(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日', value)
    if not start:
        return None
    remainder = value[start.end():]
    end = re.search(r'[～〜-]\s*(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日', remainder)
    if not end:
        return None
    try:
        first = date(*map(int, start.groups()))
        year = int(end[1]) if end[1] else first.year + (int(end[2]) < first.month)
        last = date(year, int(end[2]), int(end[3]))
    except ValueError:
        return None
    return (first.isoformat(), last.isoformat()) if first <= last else None


def node_lines(node):
    return ''.join(node_lines(child) if isinstance(child, Node) else child for child in node.children) if node.tag != 'br' else '\n'


def parse_events(html, park_id, source_url):
    parser = TreeParser(); parser.feed(html)
    events = []
    for node in parser.root.walk():
        if node.tag == 'a' and node.attrs.get('href'):
            heading = next((n for n in node.walk() if n.tag == 'h3' and n.has_class('heading3')), None)
            period = japanese_range(node.text())
            if heading and period:
                link = urljoin(ORIGIN, node.attrs['href'])
                if urlsplit(link).hostname == 'www.tokyodisneyresort.jp':
                    events.append({'parkId':park_id,'name':heading.text().strip(),'startDate':period[0],'endDate':period[1],'sourceUrl':link})
        if node.tag == 'p' and node.has_class('text'):
            lines = [re.sub(r'\s+', ' ', line).strip() for line in node_lines(node).splitlines() if line.strip()]
            for index, title in enumerate(lines[:-1]):
                if 'スペシャルイベント' not in title:
                    continue
                period = japanese_range(lines[index+1])
                if period:
                    events.append({'parkId':park_id,'name':re.sub(r'^スペシャルイベント[「『](.*)[」』]$',r'\1',title),'startDate':period[0],'endDate':period[1],'sourceUrl':source_url})
    result = {}
    for item in events:
        result[(item['name'],item['startDate'])] = item
    return list(result.values())


def parse_opening_calendar(html, park_id):
    parser = TreeParser(); parser.feed(html)
    result = {}
    slug = 'tdl' if park_id == 'land' else 'tds'
    for node in parser.root.walk():
        if node.tag != 'a':
            continue
        source = urljoin(ORIGIN, node.attrs.get('href', ''))
        link = urlsplit(source)
        if link.scheme != 'https' or link.hostname != 'www.tokyodisneyresort.jp':
            continue
        match = re.fullmatch('/'+slug+r'/daily/calendar/(\d{4})(\d{2})(\d{2})/?', link.path)
        if not match:
            continue
        opening = next((n for n in node.walk() if n.has_class('openTime')), None)
        if not opening:
            continue
        try:
            day = date(*map(int,match.groups())).isoformat()
        except ValueError:
            continue
        schedule = daily_schedule(opening)
        if schedule['windows']:
            row = {'windows':schedule['windows'], 'sourceUrl':source}
            price = next((n.text().strip() for n in node.walk() if n.has_class('ticketStatus')), '')
            amount = re.fullmatch(r'[￥¥]\s*([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{3,4})', price)
            if amount and 1000 <= int(amount[1].replace(',', '')) <= 99999:
                row['adultOneDayYen'] = int(amount[1].replace(',', ''))
            if day not in result or 'adultOneDayYen' in row:
                result[day] = row
    return result


def record_calendar(park, entries, checked_at):
    """Only record prospective fares, retaining announcements available before each visit."""
    hours = park.setdefault('operatingCalendar', {})
    fares = park.setdefault('ticketCalendar', {})
    today = datetime.fromisoformat(checked_at.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Tokyo')).date().isoformat()
    for day, entry in entries.items():
        hours[day] = {k:v for k,v in entry.items() if k != 'adultOneDayYen'}
        price = entry.get('adultOneDayYen')
        if day < today or price is None:
            continue
        previous = fares.get(day, {})
        if previous.get('adultOneDayYen') == price:
            continue
        revisions = list(previous.get('earlierAdultFares', []))
        if 'adultOneDayYen' in previous:
            revisions.append({k:previous[k] for k in ('adultOneDayYen','adultKnownSince','sourceUrl')})
        fares[day] = {**previous, 'adultOneDayYen':price, 'adultKnownSince':checked_at, 'sourceUrl':entry['sourceUrl']}
        if revisions:
            fares[day]['earlierAdultFares'] = revisions


def url_key(url):
    return urlsplit(url).path.rstrip('/')


def refresh_catalogue(catalogue, records, selected_date, checked_on=None):
    """Keep positional data; update only facts matched to an existing official URL."""
    checked_on = checked_on or datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat()
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
            activity['checkedOn'] = checked_on
            for day, schedule in record.get('dailySchedules', {}).items():
                if not schedule.get('published',True):
                    old = activity.get('dailySchedules',{}).get(day,{})
                    if old.get('closed') and old.get('closureSource')!='explicit':activity['dailySchedules'].pop(day,None)
                    continue
                daily = {'closed':schedule['closed']}
                if schedule['closed']:daily['closureSource']='explicit'
                if schedule['isRange']: daily['windows'] = schedule['windows']
                elif activity['category'] in {'show','parade'}: daily['showTimes'] = schedule['times']
                activity.setdefault('dailySchedules', {})[day] = daily
                activity['dailyScheduleSourceUrl'] = record['sourceUrl']
                activity['dailyScheduleCheckedOn'] = checked_on
            cutoff = date.fromisoformat(checked_on).toordinal() - 35
            if 'dailySchedules' in activity:
                activity['dailySchedules'] = {day:value for day,value in activity['dailySchedules'].items() if date.fromisoformat(day).toordinal() >= cutoff}
            if record['hasDailySchedule'] and record.get('hasConfirmedSchedule',True):
                closed = set(activity.get('closedDates', []))
                if not record['times']:
                    closed.add(selected_date)
                else:
                    closed.discard(selected_date)
                    if record['isRange'] and len(record['times']) >= 2:
                        activity['windows'] = record.get('windows') or [[record['times'][0], record['times'][-1]]]
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
    updated['updatedAt'] = checked_on
    return updated, report


def calendar_links(html,park_id):
    parser=TreeParser();parser.feed(html)
    slug='tdl' if park_id=='land' else 'tds'
    result=set()
    for node in parser.root.walk():
        if node.tag!='a':continue
        url=urljoin(ORIGIN,node.attrs.get('href',''));parts=urlsplit(url);query=parse_qs(parts.query)
        if parts.hostname!='www.tokyodisneyresort.jp':continue
        path_match=re.fullmatch('/'+slug+r'/monthly/calendar/(\d{4})(\d{2})/',parts.path)
        try:
            if path_match:date(*map(int,path_match.groups()),1)
            elif parts.path=='/'+slug+'/monthly/calendar.html':date(int(query['year'][0]),int(query['month'][0]),1)
            else:continue
        except (ValueError,KeyError,IndexError):continue
        result.add(url)
    return sorted(result)[:7]


def fetch_document(url):
    return fetch_html(url)


class CatalogueRefreshError(RuntimeError):
    def __init__(self,message,source_errors=()):
        super().__init__(message)
        self.source_errors=list(source_errors)



def fetch_official_updates(selected_date, fixture_dir=None):
    """Bounded parallel requests; failures retain the last verified values."""
    requests = []
    for park_id,slug in [('land','tdl'),('sea','tds')]:
        for kind in ['attraction','show','greeting','restaurant/list','shop/list','monthly/stop','event.html','monthly/calendar.html']:
            requests.append((park_id,slug,kind,f'{ORIGIN}/{slug}/{kind}'+('' if kind.endswith('.html') else '/')))
    records,stops,events,calendars,sources,errors = [],[],[],{},[],[]
    additional_calendars=[]
    def load(item):
        park_id,slug,kind,url=item
        html = (Path(fixture_dir)/(slug+'-'+kind.replace('/','-')+'.html')).read_text() if fixture_dir else fetch_document(url)
        return item,html
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(load,item):item for item in requests}
        for future in as_completed(futures):
            item = futures[future]
            park_id,slug,kind,url = item
            try:
                _,html = future.result()
                if kind == 'monthly/stop':
                    found = parse_stops(html,park_id,url)
                    if not found and '休止を予定しているものはありません' not in html: raise ValueError('Closure list could not be parsed')
                    stops.append({'parkId':park_id,'sourceUrl':url,'records':found})
                elif kind == 'event.html':
                    found = parse_events(html,park_id,url)
                    if not found: raise ValueError('No dated event found')
                    events.extend(found)
                elif kind == 'monthly/calendar.html':
                    found = parse_opening_calendar(html,park_id)
                    if not found: raise ValueError('Opening calendar could not be parsed')
                    calendars[park_id] = found
                    if not fixture_dir:additional_calendars.extend((park_id,url) for url in calendar_links(html,park_id))
                else:
                    found = parse_list(html,selected_date,park_id)
                    if not found: raise ValueError('Facility list could not be parsed')
                    records.extend(found)
                sources.append({'url':url,'fetchedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z')})
                print(f'{slug}/{kind}: parsed',flush=True)
            except (OSError,ValueError,RuntimeError) as error:
                errors.append({'url':url,'message':str(error)[:300]})
                print(f'{slug}/{kind}: retained previous data ({error})',flush=True)
    if additional_calendars:
        with ThreadPoolExecutor(max_workers=3) as pool:
            tasks={pool.submit(fetch_document,url):(park_id,url) for park_id,url in additional_calendars}
            for future in as_completed(tasks):
                park_id,url=tasks[future]
                try:
                    found=parse_opening_calendar(future.result(),park_id)
                    if not found:
                        sources.append({'url':url,'fetchedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'status':'no-published-opening-times'})
                        continue
                    calendars.setdefault(park_id,{}).update(found)
                    sources.append({'url':url,'fetchedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z')})
                except (OSError,ValueError,RuntimeError) as error:errors.append({'url':url,'message':str(error)[:300]})
    if not records:
        raise CatalogueRefreshError('No official facility lists could be retrieved; previous catalogue retained',errors)
    return {'records':records,'stops':stops,'events':events,'calendars':calendars,'sourcesChecked':sources,'errors':errors}


def fetch_lists(selected_date):
    return fetch_official_updates(selected_date)['records']


def apply_official_updates(catalogue, bundle, selected_date, checked_on=None):
    checked_on = checked_on or datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat()
    updated,report = refresh_catalogue(catalogue,bundle['records'],selected_date,checked_on)
    report.update({'closures':[],'events':[],'sourceErrors':bundle.get('errors',[])})
    for park in updated['parks']:
        closure = next((item for item in bundle.get('stops',[]) if item['parkId']==park['id']),None)
        if closure is not None:
            for activity in park['activities']:
                periods = [{'startDate':item['startDate'],'endDate':item['endDate'],'sourceUrl':closure['sourceUrl'],'checkedOn':checked_on,'origin':'official'} for item in closure['records'] if url_key(item['sourceUrl'])==url_key(activity['sourceUrl'])]
                preserved = [item for item in activity.get('closedPeriods',[]) if item.get('origin')!='official']
                activity['closedPeriods'] = preserved+periods
            park['closuresCheckedOn'] = checked_on
            report['closures'].append({'parkId':park['id'],'periods':len(closure['records'])})
        existing = park.setdefault('events',[])
        for event in (item for item in bundle.get('events',[]) if item['parkId']==park['id']):
            current = next((item for item in existing if item['name']==event['name'] and item['startDate']==event['startDate']),None)
            if current is None:
                current = {'id':park['id']+'-event-'+hashlib.sha1((event['sourceUrl']+'|'+event['startDate']).encode()).hexdigest()[:12],'multiplier':1,'multiplierSource':'neutral-until-observed'}
                existing.append(current)
            current.update({key:event[key] for key in ['name','startDate','endDate','sourceUrl']})
            current['checkedOn']=checked_on
            report['events'].append({'parkId':park['id'],'id':current['id'],'name':current['name']})
        if park['id'] in bundle.get('calendars',{}):
            record_calendar(park, bundle['calendars'][park['id']], datetime.now(timezone.utc).isoformat())
            park['calendarCheckedOn']=checked_on
    days = sorted({day for park in updated['parks'] for activity in park['activities'] for day in activity.get('dailySchedules',{})})
    updated.update({'pipelineVersion':2,'fetchedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'sourcesChecked':bundle.get('sourcesChecked',[]),'scheduleCoverage':{'startDate':days[0] if days else None,'endDate':days[-1] if days else None},'updateStatus':'partial' if bundle.get('errors') else 'complete'})
    return updated,report


def seed_dynamic_catalogue(base, previous):
    """Reviewed source owns graph/costs; keep published date facts between refreshes."""
    result=copy.deepcopy(base)
    dynamic={'dailySchedules','dailyScheduleSourceUrl','dailyScheduleCheckedOn','closedDates','closedPeriods','windows','operatingDate','showTimes','showTimesDate','checkedOn','menuUrl','menuItems','menuCheckedOn','menuSourceUrl','menuStatus'}
    for park in result['parks']:
        old_park=next((item for item in previous.get('parks',[]) if item.get('id')==park['id']),{})
        old_activities={item['id']:item for item in old_park.get('activities',[])}
        for activity in park['activities']:
            old=old_activities.get(activity['id'],{})
            if old.get('sourceUrl')!=activity.get('sourceUrl'):continue
            for key in dynamic:
                if key.startswith('menu') and old.get('menuCheckedOn','')<activity.get('menuCheckedOn',''):continue
                if key in old:activity[key]=copy.deepcopy(old[key])
        for key in ['operatingCalendar','ticketCalendar','closuresCheckedOn','calendarCheckedOn']:
            if key in old_park:park[key]=copy.deepcopy(old_park[key])
        events=park.setdefault('events',[])
        for old in old_park.get('events',[]):
            current=next((item for item in events if item['id']==old['id'] or (item['name']==old['name'] and item['startDate']==old['startDate'])),None)
            if current is None:events.append(copy.deepcopy(old))
            else:
                for key in ['name','startDate','endDate','sourceUrl','checkedOn']:
                    if key in old:current[key]=copy.deepcopy(old[key])
    return result


def validated_cached_catalogue(value):
    """Reject incomplete or unrelated JSON before it can be a fallback catalogue."""
    if not isinstance(value,dict) or not isinstance(value.get('version'),str):raise ValueError('Catalogue version is missing')
    date.fromisoformat(value.get('updatedAt',''))
    parks=value.get('parks')
    if not isinstance(parks,list) or len(parks)!=2 or {park.get('id') for park in parks if isinstance(park,dict)}!={'land','sea'}:raise ValueError('Both park catalogues are required')
    for park in parks:
        nodes=park.get('nodes');activities=park.get('activities');edges=park.get('edges')
        if not isinstance(nodes,list) or not nodes or not isinstance(activities,list) or not activities or not isinstance(edges,list):raise ValueError('Catalogue graph and facilities are missing')
        identifiers={node.get('id') for node in nodes if isinstance(node,dict)}
        if len(identifiers)!=len(nodes) or not all(isinstance(identifier,str) and identifier for identifier in identifiers) or park.get('entryNode') not in identifiers or park.get('exitNode') not in identifiers:raise ValueError('Catalogue graph identifiers are invalid')
        activity_ids=set()
        for activity in activities:
            if not isinstance(activity,dict) or not isinstance(activity.get('id'),str) or activity['id'] in activity_ids or activity.get('node') not in identifiers or not isinstance(activity.get('sourceUrl'),str):raise ValueError('Catalogue facilities are invalid')
            activity_ids.add(activity['id'])
        if any(not isinstance(edge,dict) or edge.get('from') not in identifiers or edge.get('to') not in identifiers for edge in edges):raise ValueError('Catalogue paths are invalid')
    return value


def load_known_catalogue(bundled_path,published_path=None):
    bundled=validated_cached_catalogue(json.loads(Path(bundled_path).read_text(encoding='utf-8')))
    if published_path and Path(published_path).exists():
        try:
            previous=validated_cached_catalogue(json.loads(Path(published_path).read_text(encoding='utf-8')))
            def edition(value):
                text=value.get('version','')
                return tuple(map(int,text.split('.'))) if re.fullmatch(r'\d+\.\d+\.\d+',text) else (0,0,0)
            # New reviewed venues and graph connections must survive an older
            # data-branch snapshot, even when its last network request was later.
            if edition(bundled)>edition(previous):
                return bundled,seed_dynamic_catalogue(bundled,previous),'bundled-newer-version'
            def freshness(value):
                text=value.get('fetchedAt') or value['updatedAt']
                try:stamp=datetime.fromisoformat(text.replace('Z','+00:00'))
                except (ValueError,AttributeError):stamp=datetime.fromisoformat(value['updatedAt'])
                return stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).timestamp()
            if freshness(previous)>=freshness(bundled):return bundled,previous,'published'
            return bundled,copy.deepcopy(bundled),'bundled-newer'
        except (OSError,ValueError,TypeError):
            print('Published catalogue is unreadable; retaining the validated bundled facts.',flush=True)
    return bundled,copy.deepcopy(bundled),'bundled'


def failed_refresh(catalogue,selected_date,error,checked_at=None):
    """Record an attempted retrieval without changing any verified fact dates."""
    checked_at=checked_at or datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    updated=copy.deepcopy(catalogue)
    errors=getattr(error,'source_errors',[]) or [{'message':str(error)[:300]}]
    attempt={'checkedAt':checked_at,'status':'failed','sourceErrors':errors,'message':'公式情報を取得できなかったため確認済みの情報を保持しています。','lastSuccessfulFetchedAt':catalogue.get('fetchedAt')}
    updated['updateStatus']='failed';updated['refreshAttempt']=attempt
    report={'date':selected_date,'status':'failed','checkedAt':checked_at,'lastKnownCatalogueUsed':True,'changed':[],'newFacilities':[],'dpaReview':[],'sourceErrors':errors,'message':attempt['message'],'lastSuccessfulFetchedAt':catalogue.get('fetchedAt')}
    return updated,report


def atomic_json(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date',default=datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat())
    parser.add_argument('--catalogue',type=Path,default=ROOT/'web/data/parks.json')
    parser.add_argument('--output',type=Path,default=ROOT/'outputs/catalogue-update.json')
    parser.add_argument('--fixture-dir',type=Path)
    parser.add_argument('--previous-catalogue',type=Path,help='Retain verified date facts from the previous published catalogue')
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--seed-only',action='store_true',help='Prepare validated cached facts without requesting official pages')
    args = parser.parse_args()
    date.fromisoformat(args.date)
    bundled,previous,origin=load_known_catalogue(args.catalogue,args.previous_catalogue)
    checked_at=datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    if args.seed_only:
        atomic_json(args.output,previous)
        report_path=args.output.with_name(args.output.stem+'-report.json')
        atomic_json(report_path,{'date':args.date,'status':'seeded','checkedAt':checked_at,'origin':origin,'lastKnownCatalogueUsed':True,'sourceErrors':[]})
        print(f'Prepared validated {origin} catalogue without changing its verification dates.')
        return 0
    original=seed_dynamic_catalogue(bundled,previous)
    failure=False
    try:
        updated,report=apply_official_updates(original,fetch_official_updates(args.date,args.fixture_dir),args.date)
        updated['refreshAttempt']={'checkedAt':checked_at,'status':updated['updateStatus'],'sourceErrors':report.get('sourceErrors',[])}
        report.update({'checkedAt':checked_at,'status':updated['updateStatus'],'lastKnownCatalogueUsed':False})
    except (OSError,ValueError,RuntimeError) as error:
        updated,report=failed_refresh(previous,args.date,error,checked_at)
        failure=True
        print(f'Official retrieval failed; preserved confirmed facts: {error}',flush=True)
    atomic_json(args.output,updated)
    report_path=args.output.with_name(args.output.stem+'-report.json');atomic_json(report_path,report)
    if args.apply:atomic_json(args.catalogue,updated)
    print(f'Updated catalogue: {args.output}\nChange report: {report_path}')
    print('New facilities and changed DPA eligibility require verified graph positions and prices before addition.')
    return 1 if failure else 0


if __name__ == '__main__':
    raise SystemExit(main())
