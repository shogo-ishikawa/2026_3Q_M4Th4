#!/usr/bin/env python3
"""Style the reviewed geography without changing a walking node or distance.

The entrance-facing display transform is a rotation and one uniform scale.
All shorelines, islands, footprints and walkway vertices retain their shape.
Run this after rebuilding either park's geography.
"""
from pathlib import Path
import html
import json
import math

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'web/data'

AREA_COLOURS = {
    'ワールドバザール': '#e9b9a2', 'アドベンチャーランド': '#c7aa7f',
    'ウエスタンランド': '#bc9370', 'クリッターカントリー': '#b4b48e',
    'ファンタジーランド': '#d8bfd8', 'トゥーンタウン': '#efd496',
    'トゥモローランド': '#acc9d9', 'メディテレーニアンハーバー': '#d9af8d',
    'アメリカンウォーターフロント': '#c4abb0', 'ポートディスカバリー': '#a8bec5',
    'ロストリバーデルタ': '#a7b38c', 'ファンタジースプリングス': '#c4bedb',
    'アラビアンコースト': '#e8d1a0', 'マーメイドラグーン': '#d8b9c9',
    'ミステリアスアイランド': '#b6a9a0',
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


def landmark_symbol(kind):
    """Original tiny upright symbols; the underlying footprint remains visible."""
    if kind in {'castle', 'castle-small'}:
        roof = '#7194c6' if kind == 'castle' else '#b88d66'
        return (f'<g fill="#f6ead5" stroke="#8c7b78" stroke-width="1.2"><path d="M-25 6V-22H-15V-8H-7V-36H7V-8H15V-22H25V6Z"/>'
                f'<path d="M-29-22L-20-39L-11-22ZM-11-36L0-56L11-36ZM11-22L20-39L29-22Z" fill="{roof}"/>'
                '<path d="M-4 6V-5Q0-13 4-5V6" fill="#9b7e73"/><path d="M0-56V-65L12-61L0-58" fill="#d6b35b" stroke="#b48b3e"/></g>')
    if kind in {'mountain', 'volcano'}:
        volcano = kind == 'volcano'
        return ('<g stroke="#8b6c54" stroke-width="1.2"><path d="M-37 7L-23-20L-12-22L-4-52L8-48L18-15L29-13L39 7Z" fill="#b18c67"/>'
                '<path d="M-37 7L-9-11L-4-52L4-18L39 7Z" fill="#d0af87"/>'
                '<path d="M-4-52L8-48L12-36L1-38Z" fill="#655658"/>'
                + ('<path d="M4-53Q19-66 6-75Q-4-83 4-91" fill="none" stroke="#c9d3d6" stroke-width="5" opacity=".85"/>' if volcano else '')
                + '</g>')
    if kind == 'tower':
        return '<g fill="#b9a58b" stroke="#776b64" stroke-width="1.3"><path d="M-22 7V-27H-14V-47H-7V-62H7V-47H14V-27H22V7Z"/><path d="M-17-27H17M-10-46H10"/><path d="M-4-36V-29M4-36V-29M-4-18V-11M4-18V-11" stroke="#806a55" stroke-width="4"/></g>'
    if kind == 'ship':
        return '<g stroke="#7c8996" stroke-width="1.2"><path d="M-43-4H44L29 12H-28Z" fill="#344e66"/><path d="M-29-4V-20H29V-4Z" fill="#f7f3e7"/><path d="M-20-20V-29H22V-20" fill="#f7f3e7"/><path d="M-10-29V-43H-2V-29M8-29V-43H16V-29" fill="#bd725f"/><path d="M-22-13H25" stroke="#94a7b9" stroke-width="3"/></g>'
    if kind == 'palace':
        return '<g stroke="#967b99" stroke-width="1.2"><path d="M-30 7V-9H-21V-25H-12V-13H-5V-33H6V-13H14V-25H23V-9H31V7Z" fill="#d7b5cd"/><path d="M-27-25Q-25-45-17-40Q-11-35-12-25ZM-9-33Q-5-55 2-49Q9-44 10-33ZM12-25Q14-43 23-39Q30-34 28-25Z" fill="#8dc4ca"/><path d="M-4 7V-3Q1-12 6-3V7" fill="#a7d5d7"/></g>'
    raise ValueError(kind)


def build_map(park, geography, landmarks, profile):
    matrix = profile['matrix']
    points = lambda shape: [transform(p, matrix) for p in shape]
    sea = park['id'] == 'sea'
    boundary = points(geography['boundary']['geometry'])
    nodes = {n['id']: n for n in park['nodes']}
    activities = [a for a in park['activities'] if a.get('area') in AREA_COLOURS and a['node'] in nodes]
    def area_colour(item):
        shape = item['geometry']
        x, y = sum(p[0] for p in shape)/len(shape), sum(p[1] for p in shape)/len(shape)
        nearby = min(activities, key=lambda a: (nodes[a['node']]['x']-x)**2+(nodes[a['node']]['y']-y)**2)
        return AREA_COLOURS[nearby['area']]
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="{park["name"]}の地理地図" data-display-matrix="{json.dumps(matrix,separators=(",", ":"))}">',
           f'<title>{park["name"]}の入口を下にした地理地図</title>',
           f'<desc>© OpenStreetMap contributors. ODbL 1.0. {geography["extractedOn"]}取得。建物と水域の輪郭はOSM地理データ。ランドマークの絵は位置を示す記号です。徒歩通路は元の頂点を保持しています。</desc>',
           '<defs><linearGradient id="paper" x2="1" y2="1"><stop stop-color="#f7f2e9"/><stop offset="1" stop-color="#edf1e7"/></linearGradient>',
           '<linearGradient id="water" x2="0" y2="1"><stop stop-color="#a7d9dd"/><stop offset="1" stop-color="#73b8cf"/></linearGradient>',
           '<pattern id="ripples" width="37" height="24" patternUnits="userSpaceOnUse"><path d="M3 9Q9 6 15 9M22 20Q28 17 34 20" fill="none" stroke="#e4f6f2" stroke-width=".8" opacity=".55"/></pattern>',
           '<clipPath id="park">'+polygon(boundary)+'</clipPath></defs>',
           '<rect width="1000" height="1000" fill="url(#paper)"/>',
           polygon(boundary, fill='#e8ead7' if not sea else '#e5e8dd', stroke='#c0cbb9', stroke_width='2'),
           '<g clip-path="url(#park)">']
    for item in geography['water']:
        rings = [item['geometry']]+[h['geometry'] for h in item.get('holes', [])]
        path = ' '.join('M'+' L'.join(','.join(map(str,p)) for p in points(ring))+' Z' for ring in rings)
        svg += [f'<path data-osm-water="{item.get("osmWayId",item.get("osmRelationId"))}" d="{path}" fill="url(#water)" fill-rule="evenodd" stroke="#7db6c5" stroke-width="1.1"/>',
                f'<path d="{path}" fill="url(#ripples)" fill-rule="evenodd"/>']
    for item in geography['buildings']:
        shape = points(item['geometry'])
        svg += [polygon([[x+2.3,y+3] for x,y in shape], fill='#627376', opacity='.14'),
                polygon(shape, fill=area_colour(item), stroke='#a99c8b', stroke_width='.7', data_osm_building=item['osmWayId'])]
    svg.append('<g fill="none" stroke-linejoin="round" stroke-linecap="round">')
    for item in geography['walkways']:
        path = ' '.join(','.join(map(str,p)) for p in points(item['geometry']))
        svg.append(f'<polyline data-osm-way="{item["osmWayId"]}" points="{path}" stroke="#fbf7eb" stroke-width="5.5"/>')
    svg.append('</g></g>')
    for item in landmarks:
        if item['parkId'] != park['id']:
            continue
        x, y = transform(project(item['coordinates'], geography['projection']), matrix)
        size = .75 if item['symbol'] == 'castle-small' else .9
        svg.append(f'<g data-landmark-osm="{item["osmType"]}/{item["osmId"]}" transform="translate({x} {y}) scale({size})"><title>{html.escape(item["name"])}</title><ellipse cy="8" rx="34" ry="8" fill="#5e7167" opacity=".15"/>{landmark_symbol(item["symbol"])}</g>')
    north = profile['rotationDegrees']
    pixels = 100*geography['projection']['pixelsPerMetre']*profile['scale']
    svg += ['<g fill="#3d5866" stroke="#3d5866"><circle cx="926" cy="68" r="23" fill="#faf8ef" stroke="#b7c4be"/>',
            f'<g transform="translate(926 68) rotate({north})"><path d="M0-17L7 12L0 6L-7 12Z" stroke-width=".5"/></g>',
            '<text x="926" y="108" text-anchor="middle" font-family="sans-serif" font-size="15" stroke="none">N</text></g>',
            f'<path d="M42 944v7h{pixels:.3f}v-7" fill="none" stroke="#3d5866" stroke-width="2"/>',
            '<text x="42" y="976" font-family="sans-serif" font-size="16" fill="#3d5866">100 m</text></svg>']
    target = ROOT/f'web/assets/{park["id"]}-geographic-map.svg'
    target.write_text('\n'.join(svg)+'\n')


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


if __name__ == '__main__':
    build()
