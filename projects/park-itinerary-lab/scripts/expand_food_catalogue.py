"""Check the complete official food list against reviewed schematic access points.

Only the reviewed venue IDs below may acquire a graph connection. A newly listed
venue without a reviewed connection remains a reported candidate. Coordinates,
short access paths, time spent and budgets are planning estimates, not official
measurements. Official lists supply names, areas, menu links and dated hours.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from urllib.parse import urljoin, urlsplit

import update_food_menus as menus
import update_park_data as official

PROJECT = Path(__file__).resolve().parents[1]
# Each point connects a venue to the existing pedestrian graph in the same area.
# These are coarse area/landmark assignments. They do not assert exact entrances.
REVIEWED_ACCESS = {
    'land': {
        '317':'world', '306':'world-south', '303':'world',
        '328':'world', '311':'world', '494':'world', '495':'world',
        '323':'hub-w', '327':'adventure-s', '334':'adventure',
        '330':'adventure', '333':'adventure-s', '326':'adventure',
        '322':'adventure-s', '366':'adventure-s', '373':'adventure-s',
        '499':'west', '336':'west', '335':'hub-w', '337':'west', '368':'west',
        '345':'critter', '346':'fantasy', '347':'fantasy', '397':'fantasy',
        '291':'beauty', '371':'small-world', '372':'pooh', '391':'beauty',
        '390':'beauty', '376':'toon-s', '380':'toon', '354':'star',
        '353':'star', '352':'monster', '378':'tomorrow', '375':'tomorrow',
    },
    'sea': {
        '400':'zambini', '416':'fortress', '479':'soaring', '486':'harbor-s',
        '436':'american', '446':'cape', '447':'cape', '448':'cape',
        '493':'american', '429':'dock', '426':'dock', '423':'american',
        '430':'dock', '449':'cape', '498':'dock', '440':'american', '435':'dock',
        '472':'dock', '473':'dock', '481':'toy', '482':'dock',
        '454':'port', '453':'port', '475':'port', '483':'port',
        '460':'lost', '457':'lost-w', '456':'lost', '452':'temple',
        '476':'lost-w', '484':'temple', '489':'lost', '469':'fs-gate',
        '465':'arabian-n', '464':'arabian', '478':'arabian', '485':'arabian',
        '480':'mermaid', '477':'mermaid', '488':'mermaid-under',
        '421':'mysterious', '487':'mysterious',
    },
}


def parse_food_list(source: str, date: str, park_id: str) -> list[dict]:
    """Use the official row's links and feature tags, never infer a menu URL."""
    records = official.parse_list(source, date, park_id)
    by_path = {urlsplit(record['sourceUrl']).path: record for record in records}
    parser = official.TreeParser()
    parser.feed(source)
    for node in parser.root.walk():
        if node.tag != 'li' or 'data-categorize' not in node.attrs:
            continue
        anchors = [child for child in node.walk() if child.tag == 'a']
        details = next((child.attrs.get('href') for child in anchors if '/restaurant/detail/' in child.attrs.get('href','')), None)
        record = by_path.get(urlsplit(details or '').path)
        if record is None:
            continue
        record['tags'] = json.loads(node.attrs.get('data-tags','[]'))
        record['menuUrl'] = next((menus.official_url(child.attrs['href'], record['sourceUrl']) for child in anchors if re.fullmatch(r'/(tdl|tds)/restaurant/food/\d+/', urlsplit(child.attrs.get('href','')).path)), None)
    return records


def category_for(record: dict) -> str:
    tags = set(record.get('tags', []))
    if '6111' in tags or 'ポップコーン' in record['name']:
        return 'popcorn'
    if tags & {'502','6101','6102','6104','6001','6002','6004','6005','6007'}:
        return 'restaurant'
    return 'snack'


def expand_catalogue(catalogue: dict, lists: dict[str,str], date: str) -> tuple[dict,dict]:
    result = copy.deepcopy(catalogue)
    report = {'checkedOn':date, 'parks':[], 'added':[], 'unplaced':[], 'excluded':[]}
    for park_id in [park['id'] for park in result['parks']]:
        park = next(item for item in result['parks'] if item['id'] == park_id)
        slug = 'tdl' if park_id == 'land' else 'tds'
        list_url = f'https://www.tokyodisneyresort.jp/{slug}/restaurant/list/'
        records = parse_food_list(lists[park_id], date, park_id)
        source_stops = official.parse_stops(lists[park_id], park_id, list_url)
        known = {official.url_key(activity['sourceUrl']):activity for activity in park['activities']}
        nodes = {node['id']:node for node in park['nodes']}
        counts = {}
        for record in records:
            if record['area'] == 'パーク外':
                report['excluded'].append({'parkId':park_id,'name':record['name'],'sourceUrl':record['sourceUrl'],'reason':'outside-park'})
                continue
            path = official.url_key(record['sourceUrl'])
            activity = known.get(path)
            if activity is None:
                venue_id = path.rsplit('/',1)[-1]
                parent_id = REVIEWED_ACCESS[park_id].get(venue_id)
                if parent_id not in nodes:
                    report['unplaced'].append(record)
                    continue
                category = category_for(record)
                activity_id = f'{park_id}-{category}-{venue_id}'
                node_id = f'visit-{activity_id}'
                parent = nodes[parent_id]
                index = counts.get(parent_id,0)
                counts[parent_id] = index+1
                # Offsets merely separate markers around their coarse access point.
                node = {'id':node_id,'name':record['name'],'x':max(0,min(1000,parent['x']+(index%3-1)*13)), 'y':max(0,min(1000,parent['y']-15-(index//3)*13)), 'lat':None,'lon':None,'coordinateSource':'official-area-and-landmark-schematic','accessPoint':parent_id}
                park['nodes'].append(node)
                nodes[node_id] = node
                park['edges'].append({'from':parent_id,'to':node_id,'metres':30,'distanceSource':'schematic-access-estimate'})
                reservation = '502' in record.get('tags',[])
                meal = category == 'restaurant'
                published = sorted((day,schedule['windows']) for day,schedule in record.get('dailySchedules',{}).items() if schedule.get('published') and schedule.get('windows') and not schedule.get('closed'))
                reference = published[0] if published else None
                activity = {'id':activity_id,'name':record['name'],'category':category,'area':record['area'],'node':node_id,'duration':90 if reservation else 45 if meal else 10,'baseWait':20 if meal else 10,'cost':7000 if reservation else 2000 if meal else 500,'windows':reference[1] if reference else [park.get('openingHours',[540,1260])],'showTimes':[],'dpa':None,'sourceUrl':record['sourceUrl'],'mapUrl':record['sourceUrl']+'#map','access':'reservation' if reservation else 'normal','checkedOn':date,'windowsSource':'official-dated-reference' if reference else 'planning-until-announced','waitSource':'planning-assumption','costSource':'planning-budget','durationSource':'planning','positionSource':'official-area-and-landmark-schematic'}
                if reference:
                    activity['windowsDate'] = reference[0]
                if '505' in record.get('tags',[]):
                    activity['prioritySeating'] = True
                if '524' in record.get('tags',[]):
                    activity['mobileOrder'] = True
                if reservation:
                    activity['reservationRequired'] = True
                park['activities'].append(activity)
                known[path] = activity
                report['added'].append({'parkId':park_id,'id':activity_id,'name':record['name']})
            if record.get('menuUrl'):
                activity['menuUrl'] = record['menuUrl']
                activity['menuSourceListUrl'] = list_url
            periods = [{'startDate':stop['startDate'],'endDate':stop['endDate'],'sourceUrl':list_url,'checkedOn':date,'origin':'official'} for stop in source_stops if official.url_key(stop['sourceUrl']) == path]
            # The list is a complete source for food closure intervals. Keep other sources.
            activity['closedPeriods'] = [p for p in activity.get('closedPeriods',[]) if p.get('origin') not in {'official-food-list','official'}]+periods
        result, _ = official.refresh_catalogue(result, records, date, date)
        park = next(item for item in result['parks'] if item['id'] == park_id)
        report['parks'].append({'parkId':park_id,'listed':len(records),'inParkListed':sum(record['area']!='パーク外' for record in records),'registered':sum(activity['category'] in menus.FOOD for activity in park['activities']),'sourceUrl':list_url})
    result['foodCatalogueUpdate'] = report
    result['version'] = '1.1.0'
    return result, report


def refresh_listed_menus(catalogue: dict, date: str, *, fetcher=menus.fetch_text, workers: int=8) -> tuple[dict,dict]:
    """Menu links have already been verified in the official list itself."""
    report = {'checkedOn':date,'checked':0,'updated':0,'errors':[]}
    items = [activity for park in catalogue['parks'] for activity in park['activities'] if activity['category'] in menus.FOOD and activity.get('menuSourceListUrl') and activity.get('menuUrl')]
    report['checked'] = len(items)
    def one(activity):
        source = fetcher(activity['menuUrl'])
        return menus.parse_menu_items(source,activity['menuUrl'],activity['category'],date)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(one,activity):activity for activity in items}
        for future in concurrent.futures.as_completed(futures):
            activity = futures[future]
            try:
                activity['menuItems'] = future.result()
                activity.update({'menuCheckedOn':date,'menuSourceUrl':activity['menuUrl'],'menuStatus':'verified'})
                report['updated'] += 1
            except (OSError,ValueError,KeyError,UnicodeError) as error:
                activity.setdefault('menuItems',[])
                activity.setdefault('menuStatus','unavailable')
                report['errors'].append({'activityId':activity['id'],'reason':str(error)[:250]})
    catalogue['foodMenuUpdate'] = report
    return catalogue, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalogue',type=Path,default=PROJECT/'web/data/parks.json')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--date',default=datetime.now().astimezone().date().isoformat())
    parser.add_argument('--source-dir',type=Path,help='Previously retrieved tdl-list.html and tds-list.html')
    parser.add_argument('--refresh-menus',action='store_true')
    args = parser.parse_args()
    sources = {park:(args.source_dir/f'{slug}-list.html').read_text() if args.source_dir else official.fetch_document(f'https://www.tokyodisneyresort.jp/{slug}/restaurant/list/') for park,slug in [('land','tdl'),('sea','tds')]}
    catalogue, report = expand_catalogue(json.loads(args.catalogue.read_text()),sources,args.date)
    if args.refresh_menus:
        catalogue,_ = refresh_listed_menus(catalogue,args.date)
    menus.atomic_json(args.output,catalogue)
    print(json.dumps({'added':len(report['added']),'unplaced':len(report['unplaced']),'excluded':report['excluded'],'parks':report['parks'],'menus':catalogue.get('foodMenuUpdate')},ensure_ascii=False))


if __name__ == '__main__':
    main()
