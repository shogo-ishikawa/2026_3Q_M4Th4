import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {displayMapPoint,mapDisplayProfiles} from '../web/map-display.js';
import {routeCoordinates,renderParkMap} from '../web/map-view.js';

const catalogue=JSON.parse(fs.readFileSync(new URL('../web/data/parks.json',import.meta.url)));
const container=()=>({innerHTML:'',querySelectorAll(){return[];},querySelector(){return null;}});
const points=text=>[...text.matchAll(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g)].map(match=>Number(match[0]));

for(const park of catalogue.parks){
 const source=JSON.parse(fs.readFileSync(new URL(`../web/data/${park.id}-geography.json`,import.meta.url)));
 const svg=fs.readFileSync(new URL(`../web/assets/${park.id}-geographic-map.svg`,import.meta.url),'utf8');
 test(`${park.id}: entrance faces straight down and the display preserves distances and handedness`,()=>{
  const entry=park.nodes.find(node=>node.id===park.entryNode),profile=mapDisplayProfiles[park.id];
  assert.equal(profile.routeGraphVersion,park.routeGraphVersion);
  const [x,y]=displayMapPoint(park,[entry.x,entry.y]);
  assert.equal(x,500);assert.ok(y>750);
  for(const node of park.nodes)assert.ok(displayMapPoint(park,[node.x,node.y])[1]<=y+.001);
  const [a,b,c,d]=profile.matrix;
  assert.ok(a*d-b*c>0,'display must not mirror the park');
  assert.ok(Math.abs(a*a+b*b-c*c-d*d)<1e-10,'both axes use the same scale');
  assert.ok(Math.abs(a*c+b*d)<1e-10,'axes remain perpendicular');
  for(const edge of park.edges.slice(0,40)){
   const geometry=routeCoordinates(park,[edge.from,edge.to]);
   for(let index=1;index<geometry.length;index++){
    const p=geometry[index-1],q=geometry[index],r=displayMapPoint(park,p),s=displayMapPoint(park,q);
    assert.ok(Math.abs(Math.hypot(r[0]-s[0],r[1]-s[1])-Math.hypot(p[0]-q[0],p[1]-q[1])*profile.scale)<.0015);
   }
  }
 });
 test(`${park.id}: every shoreline, island and footprint retains every reviewed geometry vertex`,()=>{
  const water=[...svg.matchAll(/data-osm-water="[^"]+" d="([^"]+)"/g)];
  assert.equal(water.length,source.water.length);
  water.forEach((match,index)=>{
   const rings=[source.water[index].geometry,...(source.water[index].holes||[]).map(hole=>hole.geometry)];
   assert.equal((match[1].match(/M/g)||[]).length,rings.length);
   assert.deepEqual(points(match[1]),rings.flatMap(ring=>ring.flatMap(point=>displayMapPoint(park,point))));
  });
  const buildings=[...svg.matchAll(/<polygon points="([^"]+)"[^>]*data-osm-building="(\d+)"/g)];
  assert.equal(buildings.length,source.buildings.length);
  buildings.forEach((match,index)=>{
   assert.equal(Number(match[2]),source.buildings[index].osmWayId);
   assert.deepEqual(points(match[1]),source.buildings[index].geometry.flatMap(point=>displayMapPoint(park,point)));
  });
  assert.match(svg,/ODbL/);assert.match(svg,/data-landmark-osm=/);
 });
 test(`${park.id}: background, route and gate agree without changing graph nodes or recorded distances`,()=>{
  const before=structuredClone(park),edge=park.edges[10];
  const row={kind:'walk',name:'Display alignment',routeSource:park.routeGraphVersion,path:[edge.from,edge.to],metres:edge.metres};
  const view=container();renderParkMap(view,park,{plan:{rows:[row]}});
  const expected=routeCoordinates(park,row.path).map(point=>displayMapPoint(park,point).join(',')).join(' ');
  assert.ok(view.innerHTML.includes(`points="${expected}"`));
  assert.match(view.innerHTML,/transform="translate\(500 /);
  assert.doesNotMatch(view.innerHTML,/park-map-caption|下の場所を選ぶと/);
  assert.deepEqual(park,before);
  row.routeSource='old-schematic';renderParkMap(view,park,{plan:{rows:[row]}});
  assert.doesNotMatch(view.innerHTML,/Display alignment/);
 });
}

test('custom and schematic coordinates do not inherit a different map projection',()=>{
 assert.deepEqual(displayMapPoint({id:'land'},[123,456]),[123,456]);
 assert.deepEqual(displayMapPoint({id:'land',geographicMap:{},routeGraphVersion:'custom'},[123,456]),[123,456]);
});
