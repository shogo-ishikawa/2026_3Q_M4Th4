#!/usr/bin/env python3
"""Style the reviewed geography without changing a walking node or distance.

The entrance-facing display transform is a rotation and one uniform scale.
All shorelines, islands, footprints and walkway vertices retain their shape.
Run this after rebuilding either park's geography.
"""
from pathlib import Path
import base64
import html
import json
import math

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'web/data'

AREA_COLOURS = {
    'ワールドバザール': '#cd8d72', 'アドベンチャーランド': '#b69567',
    'ウエスタンランド': '#b7815d', 'クリッターカントリー': '#a5a76f',
    'ファンタジーランド': '#bb99bc', 'トゥーンタウン': '#ddb06c',
    'トゥモローランド': '#91b3be', 'メディテレーニアンハーバー': '#ce9973',
    'アメリカンウォーターフロント': '#bd9693', 'ポートディスカバリー': '#92abae',
    'ロストリバーデルタ': '#939f68', 'ファンタジースプリングス': '#b6a0b9',
    'アラビアンコースト': '#deb574', 'マーメイドラグーン': '#cc9caf',
    'ミステリアスアイランド': '#a58a75',
}


def display_profile(park, geography):
    entry = next(n for n in park['nodes'] if n['id'] == park['entryNode'])
    angle = math.pi / 2 - math.atan2(entry['y'] - 500, entry['x'] - 500)
    cosine, sine = math.cos(angle), math.sin(angle)
    rotated = [(cosine*(x-500)-sine*(y-500), sine*(x-500)+cosine*(y-500))
               for x, y in geography['boundary']['geometry']]
    min_y, max_y = min(y for _, y in rotated), max(y for _, y in rotated)
    # Keep the entrance on the vertical centre line and the complete boundary
    # visible. No anisotropic stretch, reflection or guessed connection.
    scale = min(900/(max_y-min_y), 450/max(abs(x) for x, _ in rotated))
    a, b, c, d = cosine*scale, sine*scale, -sine*scale, cosine*scale
    e = 500-500*a-500*c
    f = 500-(min_y+max_y)*scale/2-500*b-500*d
    return {'routeGraphVersion': park['routeGraphVersion'],
            'matrix': [round(v, 12) for v in [a, b, c, d, e, f]],
            'rotationDegrees': round(math.degrees(angle) % 360, 6),
            'scale': round(scale, 12), 'sourceCentre': [500, 500]}


def transform(point, matrix):
    a, b, c, d, e, f = matrix
    x, y = point
    return [round(a*x+c*y+e, 3), round(b*x+d*y+f, 3)]


def project(coordinates, projection):
    lon, lat = coordinates
    lon0, lat0 = projection['origin']
    earth, scale = projection['earthRadiusMetres'], projection['pixelsPerMetre']
    x = earth*math.radians(lon-lon0)*math.cos(math.radians(lat0))
    y = -earth*math.radians(lat-lat0)
    return [x*scale+projection['offset'][0], y*scale+projection['offset'][1]]


def polygon(points, **attributes):
    attrs = ' '.join(f'{k.replace("_", "-")}="{v}"' for k, v in attributes.items())
    return f'<polygon points="{" ".join(",".join(map(str,p)) for p in points)}" {attrs}/>'


ART = ROOT / 'scripts/map-art'

# Landmark pictures are intentionally a legible size at phone scale. Their
# ground contact is anchored at the mapped landmark, independently of its POI.
PICTURE_SIZES = {
    'castle': (90, 106), 'mountain': (115, 89), 'castle-small': (87, 88),
    'volcano': (115, 94), 'tower': (84, 87), 'ship': (90, 74),
    'palace': (79, 74), 'carousel': (70, 57),
}


def ink_colour(base, amount):
    """Tint with ivory for a sunlit roof, or with umber for the shaded side."""
    target = (255, 248, 217) if amount > 0 else (68, 54, 56)
    channels = [int(base[i:i + 2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{round(c + (t-c)*abs(amount)):02x}' for c, t in zip(channels, target))


def roof_gradients():
    result = []
    for index, base in enumerate(AREA_COLOURS.values()):
        for slope, offset in enumerate(('.36', '.64')):
            result.append(f'<linearGradient id="roof{index}-{slope}" x2="1" y2=".7">'
                          f'<stop stop-color="{ink_colour(base, .38)}"/>'
                          f'<stop offset="{offset}" stop-color="{ink_colour(base, .15)}"/>'
                          f'<stop offset="{offset}" stop-color="{base}"/>'
                          f'<stop offset="1" stop-color="{ink_colour(base, -.19)}"/></linearGradient>')
    return ''.join(result)


def coordinate_path(rings):
    return ' '.join('M' + ' L'.join(f'{x},{y}' for x, y in ring) + ' Z' for ring in rings)


def scenery_markup(scenery, project_point):
    surfaces = []
    rank = ['sand', 'grass', 'forest', 'scrub', 'garden', 'flowers', 'scree', 'rock']
    for item in sorted(scenery['areas'], key=lambda area: rank.index(area['kind'])):
        path = coordinate_path([[project_point(p) for p in ring] for ring in item['rings']])
        ref = f'{item["osmType"]}/{item["osmId"]}'
        surfaces.append(f'<path data-osm-surface="{ref}" fill="url(#{item["kind"]})" d="{path}" fill-rule="evenodd"/>')
    trees = []
    for osm_id, lon, lat in scenery['trees']:
        x, y = project_point([lon, lat])
        scale = .55 + (osm_id % 17) * .023
        trees.append((y, f'<use data-osm-tree="{osm_id}" href="#crown" transform="translate({x} {y}) scale({scale:.3f})"/>'))
    return surfaces, [label for _, label in sorted(trees)]


def illustrated_buildings(park, geography, points):
    nodes = {n['id']: n for n in park['nodes']}
    areas = list(AREA_COLOURS)
    activity_sites = [(nodes[a['node']], areas.index(a['area'])) for a in park['activities']
                      if a.get('area') in AREA_COLOURS and a['node'] in nodes]
    result = []
    for item in geography['buildings']:
        source = item['geometry']
        cx = sum(p[0] for p in source) / len(source)
        cy = sum(p[1] for p in source) / len(source)
        _, palette = min(activity_sites, key=lambda site: (site[0]['x'] - cx)**2 + (site[0]['y'] - cy)**2)
        shape = points(source)
        way = item['osmWayId']
        base = AREA_COLOURS[areas[palette]]
        identifier = f'b{way}'
        # The footprint is drawn at its exact surveyed vertices. The roof,
        # eaves and shadow are illustrative, with at most a few pixels of lift.
        footprint = polygon(shape, id=identifier, data_osm_building=way)
        result += [f'<defs>{footprint}</defs>',
                   f'<use href="#{identifier}" transform="translate(2.6 3.6)" fill="#685d48" opacity=".27"/>',
                   f'<use href="#{identifier}" fill="{ink_colour(base, -.34)}" stroke="{ink_colour(base, -.43)}" stroke-width=".85"/>',
                   f'<g transform="translate(-.65 -1.9)"><use href="#{identifier}" fill="url(#roof{palette}-{way%2})" stroke="{ink_colour(base, -.22)}" stroke-width=".72"/>'
                   f'<use href="#{identifier}" fill="url(#roof-lines)"/></g>']
    return result


def landmark_picture(item, project_point):
    kind = item['symbol']
    width, height = PICTURE_SIZES[kind]
    x, y = project_point(item['coordinates'])
    data = base64.b64encode((ART / f'{kind}.png').read_bytes()).decode('ascii')
    return (f'<g data-landmark-osm="{item["osmType"]}/{item["osmId"]}" transform="translate({x} {y})">'
            f'<title>{html.escape(item["name"])}</title>'
            f'<image href="data:image/png;base64,{data}" x="{-width/2:g}" y="{-height*.86:g}" width="{width}" height="{height}" preserveAspectRatio="xMidYMax meet"/></g>')


def compass_scale(profile, geography):
    angle = profile['rotationDegrees']
    north_x = 924 + 42 * math.sin(math.radians(angle))
    north_y = 78 - 42 * math.cos(math.radians(angle))
    length = 100 * geography['projection']['pixelsPerMetre'] * profile['scale']
    return [f'<g transform="translate(924 78)" stroke="#90714e">'
            '<circle r="31" fill="#faf1d9" fill-opacity=".9" stroke-width="1.5"/>'
            '<circle r="26.3" fill="none" stroke-width=".65"/>'
            f'<g transform="rotate({angle})"><path d="M0-24 5-5 19 0 5 5 0 21-5 5-19 0-5-5Z" fill="#e8cc8b"/>'
            '<path d="M0-24 5-5 0 0Zm0 24L-5 5 0 21Zm0 0 19 0-14-5Zm0 0-19 0 14 5Z" fill="#396276"/>'
            '<path d="M0-24 5-5 0-2-3-5Z" fill="#2b536a"/><circle r="2.2" fill="#efe0b7"/></g></g>',
            f'<text x="{north_x:.2f}" y="{north_y + 5:.2f}" text-anchor="middle" font-family="serif" font-weight="bold" font-size="15" fill="#394f51">N</text>',
            f'<g transform="translate(42 947)" stroke="#544f3c"><path d="M0-4v8h{length:.3f}v-8" fill="none" stroke-width="1.7"/>'
            f'<path d="M0 1h{length/2:.3f}" fill="none" stroke-width="5"/></g>',
            '<text x="42" y="974" font-family="serif" font-size="15" fill="#544f3c">100 m</text>']


def build_map(park, geography, landmarks, profile):
    matrix = profile['matrix']
    def points(shape):
        return [transform(p, matrix) for p in shape]
    def project_point(p):
        return transform(project(p, geography['projection']), matrix)

    boundary = points(geography['boundary']['geometry'])
    scenery = json.loads((DATA / f'{park["id"]}-map-scenery.json').read_text())
    surfaces, trees = scenery_markup(scenery, project_point)
    # Artwork is composited under the real paths. Water holes remain dry land.
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="{park["name"]}の地理地図" data-display-matrix="{json.dumps(matrix,separators=(",", ":"))}">',
           f'<title>{park["name"]}の園内絵地図</title>',
           '<desc>© OpenStreetMap contributors · ODbL 1.0。水域・通路・建物・植生は地理データに基づきます。建物の絵は位置を示す目印です。</desc>',
           (ART / 'illustration-defs.svg').read_text(),
           '<defs>', roof_gradients(), '<clipPath id="park">' + polygon(boundary) + '</clipPath>',
           '<g id="walk-lines" fill="none" stroke-linejoin="round" stroke-linecap="round">']
    for item in geography['walkways']:
        line = ' '.join(f'{x},{y}' for x,y in points(item['geometry']))
        svg.append(f'<polyline data-osm-way="{item["osmWayId"]}" points="{line}"/>')
    svg += ['</g></defs>', '<rect width="1000" height="1000" fill="url(#paper)"/>',
            '<rect width="1000" height="1000" fill="url(#grain)"/>',
            '<rect x="13" y="13" width="974" height="974" rx="7" stroke="#ba9d69" stroke-width="1" fill="none" opacity=".7"/>',
            '<rect x="17" y="17" width="966" height="966" rx="6" stroke="#c4aa78" stroke-width=".65" fill="none" opacity=".65"/>',
            polygon(boundary, transform='translate(2 4)', fill='#a79f79', opacity='.28'),
            polygon(boundary, fill='url(#ground)', stroke='#8b9870', stroke_width='1.6'),
            '<g clip-path="url(#park)">', *surfaces, '<rect width="1000" height="1000" fill="url(#grain)"/>']
    for index, item in enumerate(geography['water']):
        rings = [item['geometry']] + [hole['geometry'] for hole in item.get('holes', [])]
        path = coordinate_path([points(ring) for ring in rings])
        osm_id = item.get('osmWayId', item.get('osmRelationId'))
        svg.append(f'<defs><path data-osm-water="{osm_id}" d="{path}" id="w{index}" fill-rule="evenodd" clip-rule="evenodd"/>'
                   f'<clipPath id="water-clip{index}"><use href="#w{index}"/></clipPath></defs>'
                   f'<use href="#w{index}" fill="url(#water)" stroke="#568e92" stroke-width="1.2"/>'
                   f'<use href="#w{index}" fill="url(#ripples)"/>'
                   f'<use href="#w{index}" clip-path="url(#water-clip{index})" fill="none" stroke="#e4f0c6" stroke-width="4" opacity=".55"/>')
    svg += [*trees, *illustrated_buildings(park, geography, points), '</g>']
    svg.append('<g data-layer="walkways" clip-path="url(#park)"><use href="#walk-lines" stroke="#9e8661" stroke-width="3.45"/>'
               '<use href="#walk-lines" stroke="#fff2ce" stroke-width="2.65"/></g>')
    svg.extend(landmark_picture(item, project_point) for item in landmarks if item['parkId'] == park['id'])
    # Keep the road trace visible over the raised illustrations without
    # cutting through their colours with the full-width outline. The user's
    # itinerary is drawn above the whole map at full contrast by map-view.js.
    svg += ['<use data-layer="walkway-trace" href="#walk-lines" clip-path="url(#park)" stroke="#fff6d9" stroke-width="1.6" opacity=".57"/>',
            *compass_scale(profile, geography), '</svg>']
    target = ROOT / f'web/assets/{park["id"]}-geographic-map.svg'
    target.write_text('\n'.join(svg) + '\n')


def build():
    catalogue = json.loads((DATA/'parks.json').read_text())
    landmarks = json.loads((DATA/'map-landmarks.json').read_text())['landmarks']
    profiles = {}
    for park in catalogue['parks']:
        geography = json.loads((DATA/f'{park["id"]}-geography.json').read_text())
        profile = display_profile(park, geography)
        profiles[park['id']] = profile
        build_map(park, geography, landmarks, profile)
    # JavaScript only applies this display transform. The planner continues to
    # consume the unmodified source graph and geodesic edge lengths.
    module = '''/** Display-only orientation. Regenerate with scripts/build_illustrated_maps.py. */
export const mapDisplayProfiles = PROFILES;

/** Rotate all map layers alike; source graph coordinates remain untouched. */
export function displayMapPoint(park, point) {
  const profile = park.geographicMap && mapDisplayProfiles[park.id];
  if (!profile || profile.routeGraphVersion !== park.routeGraphVersion) return [...point];
  const [a,b,c,d,e,f] = profile.matrix, [x,y] = point;
  return [a*x+c*y+e,b*x+d*y+f].map(value => Math.round(value*1000)/1000);
}
'''
    (ROOT/'web/map-display.js').write_text(module.replace('PROFILES',json.dumps(profiles,ensure_ascii=False,indent=2)))
    return profiles


if __name__ == '__main__':
    print(json.dumps(build(),ensure_ascii=False,indent=2))
