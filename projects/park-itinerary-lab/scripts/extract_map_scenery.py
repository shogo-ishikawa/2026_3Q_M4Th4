#!/usr/bin/env python3
"""Extract visual land cover from OSM. This never writes to the routing graph."""
import argparse
from functools import lru_cache
import json
from pathlib import Path

from build_sea_geography import read_extract


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'web/data'
SURFACES = {
    'natural': {'wood': 'forest', 'grassland': 'grass', 'bare_rock': 'rock',
                'scree': 'scree', 'sand': 'sand', 'beach': 'sand', 'scrub': 'scrub'},
    'landuse': {'forest': 'forest', 'grass': 'grass', 'flowerbed': 'flowers'},
    'leisure': {'garden': 'garden'},
}


def surface(tags):
    for key, options in SURFACES.items():
        if tags.get(key) in options:
            return options[tags[key]]
    return None


def inside(point, boundary):
    x, y = point
    result = False
    for (ax, ay), (bx, by) in zip(boundary, boundary[1:]):
        if (ay > y) != (by > y) and x < ax + (bx - ax) * (y - ay) / (by - ay):
            result = not result
    return result


def closed_rings(parts):
    """Join relation members by node ID. Never invent a closing edge."""
    remaining = list(parts)
    rings = []
    while remaining:
        ring = remaining.pop()[:]
        while ring[0] != ring[-1]:
            index = next((i for i, part in enumerate(remaining)
                          if ring[-1] in (part[0], part[-1])), None)
            if index is None:
                return []
            part = remaining.pop(index)
            ring.extend((part if part[0] == ring[-1] else part[::-1])[1:])
        rings.append(ring)
    return rings


def extract(park, xml, extracted_on):
    geography = json.loads((DATA / f'{park}-geography.json').read_text())
    sources = json.loads((DATA / 'map-landmarks.json').read_text())['sources']
    elements = read_extract(xml)['elements']
    coords = {e['id']: [e['lon'], e['lat']] for e in elements if e['type'] == 'node'}
    ways = {e['id']: e for e in elements if e['type'] == 'way'}

    @lru_cache(maxsize=None)
    def in_park(node):
        return inside(coords[node], geography['boundary']['coordinates'])

    trees = [[e['id'], *coords[e['id']]] for e in elements if e['type'] == 'node'
             and e['tags'].get('natural') == 'tree' and in_park(e['id'])]
    areas = []

    def add(item, kind, rings):
        if rings and any(in_park(n) for ring in rings for n in ring):
            areas.append({'kind': kind, 'osmType': item['type'], 'osmId': item['id'],
                          'rings': [[coords[n] for n in ring] for ring in rings]})

    # Never promote an inner member into its own solid patch.
    used = set()
    for rel in elements:
        kind = surface(rel['tags'])
        if rel['type'] != 'relation' or not kind or rel['tags'].get('type') != 'multipolygon':
            continue
        members = [m for m in rel['members'] if m['type'] == 'way' and m['role'] in ('', 'outer', 'inner')]
        used.update(m['ref'] for m in members)
        if not members or any(m['ref'] not in ways for m in members):
            continue
        outer = [ways[m['ref']]['nodes'] for m in members if m['role'] in ('', 'outer')]
        inner = [ways[m['ref']]['nodes'] for m in members if m['role'] == 'inner']
        outlines, holes = closed_rings(outer), closed_rings(inner)
        if outlines and (not inner or holes):
            add(rel, kind, outlines + holes)
    for way in ways.values():
        kind = surface(way['tags'])
        ring = way['nodes']
        if kind and way['id'] not in used and len(ring) >= 4 and ring[0] == ring[-1]:
            add(way, kind, [ring])

    result = {'attribution': '© OpenStreetMap contributors', 'licence': 'ODbL-1.0',
              'source': sources[park], 'extractedOn': extracted_on, 'trees': trees, 'areas': areas}
    destination = DATA / f'{park}-map-scenery.json'
    destination.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'{park}: {len(areas)} land-cover features, {len(trees)} trees')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('park', choices=['land', 'sea'])
    parser.add_argument('xml', type=Path)
    parser.add_argument('--extracted-on', required=True, help='Date of the source extract (YYYY-MM-DD)')
    args = parser.parse_args()
    extract(args.park, args.xml, args.extracted_on)
