/** Display-only orientation. Regenerate with scripts/build_illustrated_maps.py. */
export const mapDisplayProfiles = {
  "land": {
    "routeGraphVersion": "land-osm-2026-11-18",
    "matrix": [
      -0.835945911109,
      -0.69420545003,
      0.69420545003,
      -0.835945911109,
      570.870230539698,
      1251.612293440655
    ],
    "rotationDegrees": 219.707699,
    "scale": 1.086612522085,
    "sourceCentre": [
      500,
      500
    ]
  },
  "sea": {
    "routeGraphVersion": "sea-osm-2026-11-17",
    "matrix": [
      0.042214426283,
      0.957315929803,
      -0.957315929803,
      0.042214426283,
      957.550751760314,
      2.330449575739
    ],
    "rotationDegrees": 87.475084,
    "scale": 0.958246235183,
    "sourceCentre": [
      500,
      500
    ]
  }
};

/** Rotate all map layers alike; source graph coordinates remain untouched. */
export function displayMapPoint(park, point) {
  const profile = park.geographicMap && mapDisplayProfiles[park.id];
  if (!profile || profile.routeGraphVersion !== park.routeGraphVersion) return [...point];
  const [a,b,c,d,e,f] = profile.matrix, [x,y] = point;
  return [a*x+c*y+e,b*x+d*y+f].map(value => Math.round(value*1000)/1000);
}
