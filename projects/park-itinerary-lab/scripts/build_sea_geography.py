#!/usr/bin/env python3
"""Build a small walking graph and an offline map from a bounded OSM extract.

Usage: python scripts/build_sea_geography.py /path/to/overpass.json
       python scripts/build_sea_geography.py /path/to/osm-map.xml --park land
The input is OpenStreetMap data (ODbL), not an official park map. No network
request is made by this script. See web/data/sea-geography-LICENCE.md.
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
import re
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EARTH = 6371008.8
GRAPH_VERSION = "sea-osm-2026-11-17"


def metres(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b[0]-a[0])/2)**2
    return 2*EARTH*math.asin(min(1, math.sqrt(h)))


def normalise(value):
    return re.sub(r"[^\wぁ-んァ-ン一-龥]", "", unicodedata.normalize("NFKC", value)).lower()


def read_extract(path):
    if path.suffix.lower() != '.xml':
        return json.loads(path.read_text())
    root = ET.parse(path).getroot()
    elements = []
    for item in root:
        if item.tag not in {'node', 'way', 'relation'}:
            continue
        record = {'type':item.tag, 'id':int(item.attrib['id']),
                  'tags':{tag.attrib['k']:tag.attrib['v'] for tag in item.findall('tag')}}
        if item.tag == 'node':
            record.update(lon=float(item.attrib['lon']), lat=float(item.attrib['lat']))
        elif item.tag == 'way':
            record['nodes'] = [int(node.attrib['ref']) for node in item.findall('nd')]
        else:
            record['members'] = [{'type':m.attrib['type'], 'ref':int(m.attrib['ref']), 'role':m.attrib['role']} for m in item.findall('member')]
        elements.append(record)
    meta = root.find('meta')
    return {'elements':elements, 'osm3s':{'timestamp_osm_base':meta.attrib.get('osm_base') if meta is not None else None}}


def build(raw_path, water_map=None, park_id='sea'):
    if park_id not in {'land', 'sea'}:
        raise ValueError('Unknown park')
    graph_version = 'land-osm-2026-11-18' if park_id == 'land' else GRAPH_VERSION
    extracted_on = '2026-11-18' if park_id == 'land' else '2026-11-17'
    boundary_id = 1282875870 if park_id == 'land' else 203538370
    raw = read_extract(raw_path)
    elements = {}
    for item in raw["elements"]:
        key = (item["type"], item["id"])
        old = elements.get(key, {})
        elements[key] = {**old, **item, "tags": {**old.get("tags", {}), **item.get("tags", {})}}
    if water_map:
        # A small standard OSM Map API extract supplements multipolygon water
        # relations omitted by a way-only Overpass query. Import only these
        # relations and their geometry; the walking graph is unchanged.
        xml = ET.fromstring(water_map.read_bytes())
        xml_items = {}
        for item in xml:
            if item.tag not in {"node", "way", "relation"}:
                continue
            record = {"type": item.tag, "id": int(item.attrib["id"]),
                      "tags": {tag.attrib["k"]: tag.attrib["v"] for tag in item.findall("tag")}}
            if item.tag == "node":
                record.update({"lon": float(item.attrib["lon"]), "lat": float(item.attrib["lat"])})
            if item.tag == "way":
                record["nodes"] = [int(n.attrib["ref"]) for n in item.findall("nd")]
            if item.tag == "relation":
                record["members"] = [{"type": n.attrib["type"], "ref": int(n.attrib["ref"]), "role": n.attrib["role"]} for n in item.findall("member")]
            xml_items[(item.tag, record["id"])] = record
        water_relations = [r for r in xml_items.values() if r["type"] == "relation" and r["tags"].get("natural") == "water"]
        for relation in water_relations:
            elements[("relation", relation["id"])] = relation
            for member in relation["members"]:
                if member["type"] != "way":
                    continue
                way = xml_items.get(("way", member["ref"]))
                if way is None:
                    raise ValueError(f"Incomplete water relation {relation['id']}")
                elements[("way", way["id"])] = way
                for identifier in way["nodes"]:
                    elements[("node", identifier)] = xml_items[("node", identifier)]
    points = {i: (e["lon"], e["lat"]) for (kind, i), e in elements.items() if kind == "node"}
    ways = {i: e for (kind, i), e in elements.items() if kind == "way"}
    boundary = [points[i] for i in ways[boundary_id]["nodes"]]

    def inside(point):
        x, y = point
        result = False
        for (x1, y1), (x2, y2) in zip(boundary, boundary[1:]):
            if (y1 > y) != (y2 > y) and x < (x2-x1)*(y-y1)/(y2-y1)+x1:
                result = not result
        return result

    # Uniform local equirectangular projection, north up. It preserves aspect
    # ratio; geographic lengths below are calculated from longitude/latitude.
    lon0 = sum(p[0] for p in boundary)/len(boundary)
    lat0 = sum(p[1] for p in boundary)/len(boundary)
    cosine = math.cos(math.radians(lat0))

    def local(p):
        return (EARTH*math.radians(p[0]-lon0)*cosine, -EARTH*math.radians(p[1]-lat0))

    local_boundary = [local(p) for p in boundary]
    min_x, max_x = min(p[0] for p in local_boundary), max(p[0] for p in local_boundary)
    min_y, max_y = min(p[1] for p in local_boundary), max(p[1] for p in local_boundary)
    scale = 930/max(max_x-min_x, max_y-min_y)
    offset_x, offset_y = 500-(max_x+min_x)*scale/2, 500-(max_y+min_y)*scale/2

    def project(p):
        x, y = local(p)
        return [round(x*scale+offset_x, 3), round(y*scale+offset_y, 3)]

    adj = defaultdict(dict)
    source_segments = {}
    permitted_ways = []
    for way in ways.values():
        tags = way.get("tags", {})
        # Foot-specific access overrides general access. Queue lines, service
        # roads, railways, waterways and ferry routes are never walking edges.
        access = tags.get("foot", tags.get("access", "yes"))
        if tags.get("highway") not in {"footway", "pedestrian", "steps", "path", "corridor"} or access in {"private", "no"} or tags.get("footway") == "queue":
            continue
        permitted_ways.append(way)
        for a, b in zip(way["nodes"], way["nodes"][1:]):
            if a not in points or b not in points or a == b:
                continue
            pa, pb = points[a], points[b]
            if not inside(((pa[0]+pb[0])/2, (pa[1]+pb[1])/2)):
                continue
            # Do not route through an explicitly closed/private pedestrian gate.
            if any(elements.get(("node", i), {}).get("tags", {}).get("foot", elements.get(("node", i), {}).get("tags", {}).get("access")) in {"no", "private"} for i in [a, b]):
                continue
            distance = metres(pa, pb)
            if distance <= 0:
                continue
            adj[a][b] = adj[b][a] = distance
            source_segments[tuple(sorted([a, b]))] = way["id"]
    components = []
    remaining = set(adj)
    while remaining:
        first = min(remaining)
        seen, queue = {first}, [first]
        for node in queue:
            for neighbour in adj[node]:
                if neighbour not in seen:
                    seen.add(neighbour)
                    queue.append(neighbour)
        remaining -= seen
        components.append(seen)
    connected = max(components, key=len)
    adj = {node: {b: length for b, length in adj[node].items() if b in connected} for node in connected}

    catalogue_path = ROOT / "web/data/parks.json"
    catalogue = json.loads(catalogue_path.read_text())
    park = next(p for p in catalogue["parks"] if p["id"] == park_id)
    # Semantic IDs are stable for saved plans. Rebuilding does not retain the
    # previous build's internal graph nodes.
    old_nodes = [n for n in park["nodes"] if not n.get("routingOnly")]
    activities = {a["id"]: a for a in park["activities"]}
    pois = []
    for (kind, identifier), item in elements.items():
        name = item.get("tags", {}).get("name:ja") or item.get("tags", {}).get("name")
        if not name:
            continue
        if kind == "node":
            coordinate = points[identifier]
        elif kind == "way":
            coords = [points[i] for i in item["nodes"] if i in points]
            if not coords:
                continue
            coordinate = (sum(p[0] for p in coords)/len(coords), sum(p[1] for p in coords)/len(coords))
        else:
            continue
        if inside(coordinate):
            pois.append({"type": kind, "id": identifier, "name": name, "coordinate": coordinate})

    def by_id(kind, identifier):
        return next(p for p in pois if p["type"] == kind and p["id"] == identifier)

    def find(name):
        target = normalise(name)
        exact = [p for p in pois if normalise(p["name"]) == target]
        if exact:
            return sorted(exact, key=lambda p: p["type"] != "node")[0]
        partial = [p for p in pois if len(normalise(p["name"])) > 4 and (normalise(p["name"]) in target or target in normalise(p["name"]))]
        return max(partial, key=lambda p: len(normalise(p["name"])), default=None)

    # These are OSM landmark IDs, not invented geographic coordinates. An
    # attraction is placed at a nearby mapped public path, not its ride centre.
    references = {
        "entry": ("way", 72388087), "plaza": ("way", 72388087),
        "harbor-s": ("node", 6293124264), "venice": ("node", 11934878007),
        "harbor-w": ("way", 572228274), "american": ("node", 12055263729),
        "toy": ("node", 12052377070), "tower": ("node", 12091087402),
        "dock": ("node", 6173217218), "cape": ("node", 3694802598),
        "port": ("node", 859682633), "lost-w": ("node", 12069723014),
        "lost": ("node", 12069723021), "temple": ("node", 12037599769),
        "rage": ("way", 848506227), "fs-gate": ("way", 1281631832),
        "fs-west": ("node", 11894544574), "fs-east": ("way", 1299613463),
        "fs-south": ("way", 939103423), "arabian-n": ("way", 272116601),
        "arabian": ("node", 10983624150), "mermaid": ("node", 12030803674),
        "mermaid-under": ("node", 2770576798), "mysterious": ("node", 2770576773),
        "fortress": ("node", 6173853327), "soaring": ("way", 671983231),
        "zambini": ("node", 3694779909), "harbor-ne": ("node", 3694779909),
        "lost-bridge": ("node", 12069723014),
    }
    # Facilities with ambiguous names, temporary shows or new cart names use
    # an explicit landmark vicinity. No estimated straight connector is drawn.
    explicit = {
        "sea-attraction-230": ("node", 11934878007),
        "sea-attraction-232": ("node", 859682692), "sea-attraction-231": ("node", 859682633),
        "sea-restaurant-441": ("node", 3694806332),
        "sea-attraction-258": ("node", 12070684929),
        "sea-show-952": ("node", 6293124264), "sea-show-7404": ("node", 6293124264),
        "sea-show-953": ("node", 6293124264), "sea-show-7405": ("node", 6293124264),
        "sea-show-967": ("node", 6293124264), "sea-show-7604": ("node", 6173217218),
        "sea-show-7602": ("way", 222615180),
        "sea-greeting-901": ("way", 1286754266), "sea-greeting-902": ("way", 1286754266),
        "sea-greeting-903": ("way", 1286754266), "sea-greeting-921": ("way", 72388087),
        "sea-snack-493": ("node", 12055263729),
        "sea-snack-469": ("way", 1281631832),
        "sea-popcorn-490": ("node", 12070684929),
    }
    # Stable nearby landmarks for carts and facilities not separately mapped.
    area_fallback = {
        "メディテレーニアンハーバー": "harbor-s", "アメリカンウォーターフロント": "american",
        "ポートディスカバリー": "port", "ロストリバーデルタ": "lost",
        "ファンタジースプリングス": "fs-gate", "アラビアンコースト": "arabian",
        "マーメイドラグーン": "mermaid", "ミステリアスアイランド": "mysterious",
        "パークエントランス": "plaza", "パークワイド": "harbor-s",
    }
    if park_id == 'land':
        # Named OSM landmarks locate stable destinations on the public path
        # network. They are vicinity references, not surveyed facility gates.
        references = {
            'entry': ('way', 230091242), 'world-south': ('node', 12022612272),
            'world': ('node', 3692911382), 'hub-s': ('node', 12075259717),
            'hub-w': ('node', 10132719358), 'hub-nw': ('way', 217727348),
            'hub-e': ('way', 217930860), 'adventure-s': ('node', 12146076250),
            'adventure': ('way', 71898114), 'west': ('node', 12377676763),
            'thunder': ('node', 12058560113), 'woodchuck': ('node', 12075259730),
            'critter': ('way', 97767482), 'haunted': ('way', 72865097),
            'fantasy': ('node', 12385810200), 'small-world': ('way', 217870337),
            'pooh': ('way', 217842052), 'beauty': ('way', 754497701),
            'toon': ('node', 12030803670), 'toon-s': ('node', 12030803670),
            'tomorrow': ('node', 12074896868), 'star': ('way', 217930682),
            'monster': ('way', 217930681),
        }
        explicit = {
            **{key: ('way', 72865097) for key in ['land-parade-7003', 'land-parade-7000', 'land-parade-913']},
            'land-show-951': ('node', 12075259717),
            'land-show-985': ('way', 71898114),
            'land-show-7204': ('way', 217930860),
            'land-attraction-161': ('way', 217930682),
            'land-attraction-163': ('way', 217930681),
        }
        area_fallback = {
            'ワールドバザール': 'world', 'アドベンチャーランド': 'adventure',
            'ウエスタンランド': 'west', 'クリッターカントリー': 'critter',
            'ファンタジーランド': 'fantasy', 'トゥーンタウン': 'toon',
            'トゥモローランド': 'tomorrow', 'パークエントランス': 'entry',
            'パークワイド': 'hub-s',
        }
    anchors, node_records = {}, []
    anchor_report = []
    for old in old_nodes:
        identifier = old["id"]
        activity = activities.get(identifier.removeprefix("visit-"))
        accuracy = "landmark-vicinity"
        if identifier in references:
            poi = by_id(*references[identifier])
        elif activity:
            if activity["id"] in explicit:
                poi = by_id(*explicit[activity["id"]])
            else:
                # A cart label describes its nearest facility. Matching that
                # landmark is more informative than a random same-name cart.
                parenthetical = re.search(r"[（(](.*?)[）)]", activity["name"])
                landmark_name = parenthetical.group(1) if parenthetical else ""
                landmark_name = re.sub(r"(ショーダイニングエリア|テイクアウトカウンター|テラス席)$", "", landmark_name)
                landmark_name = re.sub(r"(入口横|入口|前|横)$", "", landmark_name)
                generic = activity["name"].startswith(("ポップコーン", "アイスクリーム"))
                poi = find(landmark_name) if generic and landmark_name else find(activity["name"])
                if poi and not generic:
                    accuracy = "named-osm-poi-vicinity"
                if not poi:
                    # Match a restaurant's base name when the label adds a
                    # service counter or terrace description.
                    base_name = re.split(r"[（(]", activity["name"])[0].replace(" テラス席", "")
                    poi = None if generic else find(base_name)
                if not poi:
                    poi = by_id(*references[area_fallback[activity["area"]]])
        else:
            raise ValueError(f"Unmapped semantic node: {identifier}")
        anchor = min(connected, key=lambda i: metres(points[i], poi["coordinate"]))
        anchors[identifier] = anchor
        lon, lat = points[anchor]
        record = {"id": identifier, "name": old["name"], "x": project(points[anchor])[0], "y": project(points[anchor])[1],
                  "lat": lat, "lon": lon, "coordinateSource": "openstreetmap-public-walkway-vicinity", "routingOnly": False,
                  "coordinateAccuracy": accuracy, "osmNodeId": anchor,
                  "osmLandmark": {"type": poi["type"], "id": poi["id"], "name": poi["name"]},
                  "landmarkOffsetMetres": round(metres(points[anchor], poi["coordinate"]), 1)}
        node_records.append(record)
        anchor_report.append({"node": identifier, "osmWalkwayNode": anchor, "landmark": record["osmLandmark"], "offsetMetres": record["landmarkOffsetMetres"], "accuracy": accuracy})

    # Retain the union of exact shortest paths between every facility anchor.
    # Degree-two compression then removes display-only vertices without
    # replacing curved paths by straight routing edges.
    unique_anchors = sorted(set(anchors.values()))
    useful_segments = set()
    for source in unique_anchors:
        distance, previous = {source: 0}, {}
        queue = [(0, source)]
        for_distance_targets = set(unique_anchors)
        while queue and for_distance_targets:
            value, node = heapq.heappop(queue)
            if value != distance[node]:
                continue
            for_distance_targets.discard(node)
            for neighbour, length in sorted(adj[node].items()):
                candidate = value+length
                if candidate < distance.get(neighbour, math.inf):
                    distance[neighbour], previous[neighbour] = candidate, node
                    heapq.heappush(queue, (candidate, neighbour))
        for target in unique_anchors:
            while target != source:
                before = previous[target]
                useful_segments.add(tuple(sorted([before, target])))
                target = before
    useful_adj = defaultdict(set)
    for a, b in useful_segments:
        useful_adj[a].add(b)
        useful_adj[b].add(a)
    keep = set(unique_anchors) | {i for i, neighbours in useful_adj.items() if len(neighbours) != 2}
    for i in sorted(keep):
        lon, lat = points[i]
        x, y = project(points[i])
        node_records.append({"id": f"osm-{i}", "name": "徒歩通路", "x": x, "y": y, "lat": lat, "lon": lon, "routingOnly": True, "osmNodeId": i, "coordinateSource": "openstreetmap-public-walkway"})
    edges, consumed = [], set()
    for start in sorted(keep):
        for neighbour in sorted(useful_adj[start]):
            if tuple(sorted([start, neighbour])) in consumed:
                continue
            path, previous, current = [start, neighbour], start, neighbour
            consumed.add(tuple(sorted([start, neighbour])))
            while current not in keep:
                following = next(i for i in useful_adj[current] if i != previous)
                consumed.add(tuple(sorted([current, following])))
                path.append(following)
                previous, current = current, following
            # Parallel compressed paths between the same endpoints are retained
            # only when shorter; a longer parallel path cannot improve any route.
            length = sum(adj[a][b] for a, b in zip(path, path[1:]))
            edge = {"from": f"osm-{start}", "to": f"osm-{current}", "metres": round(length, 2),
                    "geometry": [project(points[i]) for i in path], "osmNodeIds": path,
                    "osmWayIds": sorted({source_segments[tuple(sorted([a, b]))] for a, b in zip(path, path[1:])}),
                    "distanceSource": "osm-walkway-geodesic"}
            if 1323365214 in edge["osmWayIds"]:
                edge["mapUncertainty"] = "mapped-footway-over-small-stream-bridge-tag-unconfirmed"
            same = next((e for e in edges if {e["from"], e["to"]} == {edge["from"], edge["to"]}), None)
            if same is None:
                edges.append(edge)
            elif edge["metres"] < same["metres"]:
                edges[edges.index(same)] = edge
    for identifier, anchor in anchors.items():
        xy = project(points[anchor])
        edges.append({"from": identifier, "to": f"osm-{anchor}", "metres": 1,
                      "geometry": [xy, xy], "distanceSource": "one-metre-location-rounding-margin"})
    if len(node_records) > 1000:
        raise ValueError(f"Graph has {len(node_records)} nodes; update the graph cap deliberately.")
    park.update({"nodes": node_records, "edges": edges, "routeGraphVersion": graph_version,
                 "coordinateSystem": "local-equirectangular-metres-projected-1000",
                 "distanceSource": "OpenStreetMapの公開徒歩通路に沿う距離。施設は通路上の近傍点。待ち列・建物内の移動は含まない。",
                 "geographicMap": {"asset": f"assets/{park_id}-geographic-map.svg", "dataUrl": f"data/{park_id}-geography.json",
                                   "attribution": "© OpenStreetMap contributors", "attributionUrl": "https://www.openstreetmap.org/copyright",
                                   "licence": "ODbL-1.0", "licenceUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
                                   "asOf": extracted_on, "entryAccuracy": "メインエントランス付近の通路を入退園の基準点とする" if park_id == 'land' else "プラザ付近の通路を入退園の基準点とする"}})
    if park_id == 'land':
        catalogue['version'] = '1.3.0'
    catalogue_path.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2)+"\n")

    map_ways, water, buildings = [], [], []
    for way in sorted(ways.values(), key=lambda w: w["id"]):
        coords = [points[i] for i in way["nodes"] if i in points]
        if not coords or not any(inside(p) for p in coords):
            continue
        tags = way.get("tags", {})
        item = {"osmWayId": way["id"], "coordinates": coords, "geometry": [project(p) for p in coords]}
        if tags.get("natural") == "water" and len(coords) >= 4 and coords[0] == coords[-1]:
            water.append({**item, "name": tags.get("name:ja", tags.get("name", ""))})
        if tags.get("building"):
            buildings.append(item)
        if tags.get("highway") and any(source_segments.get(tuple(sorted([a, b]))) == way["id"] and tuple(sorted([a, b])) in useful_segments for a, b in zip(way["nodes"], way["nodes"][1:])):
            # Export only retained source segments, not a whole partly private
            # or out-of-boundary way. These prove every route follows source data.
            for a, b in zip(way["nodes"], way["nodes"][1:]):
                if tuple(sorted([a, b])) in useful_segments and source_segments.get(tuple(sorted([a, b]))) == way["id"]:
                    map_ways.append({"osmWayId": way["id"], "osmNodeIds": [a, b], "coordinates": [points[a], points[b]],
                                     "geometry": [project(points[a]), project(points[b])], "highway": tags["highway"],
                                     "bridge": tags.get("bridge"), "tunnel": tags.get("tunnel"), "layer": tags.get("layer")})

    def rings(parts):
        parts = [list(part) for part in parts]
        result = []
        while parts:
            ring = parts.pop(0)
            while ring[0] != ring[-1]:
                matching = next((part for part in parts if part[0] == ring[-1] or part[-1] == ring[-1]), None)
                if matching is None:
                    raise ValueError("Unclosed water multipolygon ring")
                parts.remove(matching)
                ring.extend((matching if matching[0] == ring[-1] else matching[::-1])[1:])
            result.append([points[i] for i in ring])
        return result

    for relation in sorted((r for r in elements.values() if r["type"] == "relation" and r.get("tags", {}).get("natural") == "water"), key=lambda r: r["id"]):
        # The bounded Map API also names neighbouring relations. Ignore water
        # wholly outside this park before requiring its complete geometry.
        outer_members = [m for m in relation['members'] if m['type'] == 'way' and m['role'] in {'outer', ''}]
        if not any(inside(points[i]) for m in outer_members if m['ref'] in ways for i in ways[m['ref']]['nodes'] if i in points):
            continue
        outer = rings([ways[m["ref"]]["nodes"] for m in relation["members"] if m["type"] == "way" and m["role"] in {"outer", ""}])
        inner = rings([ways[m["ref"]]["nodes"] for m in relation["members"] if m["type"] == "way" and m["role"] == "inner"])
        for ring in outer:
            if not any(inside(p) for p in ring):
                continue
            water.append({"osmRelationId": relation["id"], "coordinates": ring, "geometry": [project(p) for p in ring],
                          "holes": [{"coordinates": hole, "geometry": [project(p) for p in hole]} for hole in inner],
                          "name": relation.get("tags", {}).get("name", "")})
    geographic = {
        "version": graph_version, "licence": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
        "copyrightUrl": "https://www.openstreetmap.org/copyright", "source": "https://api.openstreetmap.org/api/0.6/map?bbox=139.870,35.628,139.885,35.641" if park_id == 'land' else "https://overpass-api.de/api/interpreter",
        "extractedOn": extracted_on, "osmBaseTimestamp": raw.get("osm3s", {}).get("timestamp_osm_base"),
        "queryBounds": [35.628, 139.870, 35.641, 139.885] if park_id == 'land' else [35.621, 139.878, 35.634, 139.895],
        "supplementaryWaterSource": {"url": "https://api.openstreetmap.org/api/0.6/map?bbox=139.883,35.623,139.889,35.628", "extractedOn": "2026-11-17"} if water_map else None,
        "uncertainCrossings": [] if park_id == 'land' else [{"osmWayId": 1323365214, "waterOsmWayId": 1286814536, "note": "小さな水路を横切る徒歩通路が登録されているが橋の属性は未登録。徒歩通路としての出典はあるため保持する。"}],
        "projection": {"type": "local-equirectangular", "origin": [lon0, lat0], "earthRadiusMetres": EARTH,
                       "pixelsPerMetre": scale, "offset": [offset_x, offset_y], "viewBox": [0, 0, 1000, 1000]},
        "boundary": {"osmWayId": boundary_id, "coordinates": boundary, "geometry": [project(p) for p in boundary]},
        "water": water, "buildings": buildings, "walkways": map_ways, "anchors": anchor_report,
        "limitations": ["施設の入口や待ち列の位置を保証するものではない。公開徒歩通路上の近傍点を使う。", "独立した通路は推測で接続しない。", "施設内・待ち列の徒歩距離は含まない。", "通行規制や工事は現地の案内に従う。"],
    }
    (ROOT/f"web/data/{park_id}-geography.json").write_text(json.dumps(geographic, ensure_ascii=False, separators=(",", ":"))+"\n")

    def polygon(coords, fill, stroke="none", width=1):
        return f'<polygon points="{" ".join(",".join(map(str, p)) for p in coords)}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>'

    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="{park["name"]}の徒歩通路と水域を示す地理地図">',
           f'<title>{park["name"]}の地理地図</title><desc>© OpenStreetMap contributors. ODbL 1.0. {extracted_on}取得。</desc>',
           '<rect width="1000" height="1000" fill="#ddebdc"/>', polygon(geographic["boundary"]["geometry"], "#e9eee3", "#a7b9aa", 2)]
    for item in water:
        # Even-odd rings preserve real islands and shores inside the harbour.
        parts = [item["geometry"]]+[hole["geometry"] for hole in item.get("holes", [])]
        commands = " ".join("M"+" L".join(",".join(map(str,p)) for p in ring)+" Z" for ring in parts)
        svg.append(f'<path d="{commands}" fill="#86c8df" fill-rule="evenodd" stroke="#64abc5" stroke-width="1"/>')
    svg += [polygon(item["geometry"], "#d5cbb7", "#b4aa98", .7) for item in buildings]
    svg.append('<g fill="none" stroke="#fdfbf0" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">')
    svg += [f'<polyline points="{" ".join(",".join(map(str,p)) for p in item["geometry"])}"/>' for item in map_ways]
    svg += ['</g>', '<g fill="#254c61" font-family="sans-serif" font-weight="bold"><path d="M935 82 L945 45 L955 82 L945 72Z"/><text x="945" y="35" text-anchor="middle" font-size="17">N</text></g>',
            f'<path d="M45 927 v8 h{100*scale:.3f} v-8" fill="none" stroke="#254c61" stroke-width="3"/><text x="45" y="958" font-family="sans-serif" font-size="17" fill="#254c61">100 m</text>',
            '<text x="975" y="984" text-anchor="end" font-family="sans-serif" font-size="13" fill="#254c61">© OpenStreetMap contributors · ODbL</text></svg>']
    (ROOT/f"web/assets/{park_id}-geographic-map.svg").write_text("\n".join(svg)+"\n")
    print(json.dumps({"nodes": len(node_records), "edges": len(edges), "anchors": len(anchors), "walkwaySegments": len(map_ways), "waterPolygons": len(water), "maxLandmarkOffsetMetres": max(a["offsetMetres"] for a in anchor_report)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("extract", type=Path)
    parser.add_argument("--water-map", type=Path, help="Supplementary standard OSM Map API XML with water multipolygon relations")
    parser.add_argument('--park', choices=['sea', 'land'], default='sea')
    args = parser.parse_args()
    build(args.extract, args.water_map, args.park)
