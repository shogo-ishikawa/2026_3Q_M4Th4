import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {graphDistances,solveItinerary,validatePlan} from '../web/planner.js';
import {validateCatalogue,parsePlanJson,buildPlanJson} from '../web/storage.js';
import {renderParkMap,routeCoordinates} from '../web/map-view.js';
const catalogue=JSON.parse(fs.readFileSync(new URL('../web/data/parks.json',import.meta.url)));
const land=catalogue.parks.find(p=>p.id==='land');
const source=JSON.parse(fs.readFileSync(new URL('../web/data/land-geography.json',import.meta.url)));
const nodes=new Map(land.nodes.map(n=>[n.id,n]));
const radians=v=>v*Math.PI/180;
function distance(a,b){const h=Math.sin(radians(b[1]-a[1])/2)**2+Math.cos(radians(a[1]))*Math.cos(radians(b[1]))*Math.sin(radians(b[0]-a[0])/2)**2;return 2*6371008.8*Math.asin(Math.sqrt(h));}

test('Land is a connected, dated OSM graph with stable semantic destinations',()=>{
 assert.equal(validateCatalogue(catalogue),catalogue);
 assert.equal(land.geographicMap.asOf,'2026-11-18');assert.equal(source.licence,'ODbL-1.0');
 assert.ok(land.nodes.length>300);assert.equal(land.nodes.filter(n=>!n.routingOnly).length,132);
 const graph=graphDistances(land);
 for(const node of land.nodes)assert.ok(Number.isFinite(graph.distances[land.entryNode][node.id]));
 for(const activity of land.activities)assert.equal(nodes.get(activity.node).routingOnly,false);
 assert.ok(source.anchors.every(a=>Number.isInteger(a.osmWalkwayNode)&&a.landmark.id));
});

test('every Land curve uses source walkway vertices and its geodesic length',()=>{
 const coordinates=new Map(source.walkways.flatMap(w=>w.osmNodeIds.map((id,i)=>[id,w.coordinates[i]])));
 const segments=new Set(source.walkways.map(w=>[...w.osmNodeIds].sort((a,b)=>a-b).join(',')));
 for(const edge of land.edges){
  const curve=routeCoordinates(land,[edge.from,edge.to]);assert.deepEqual(routeCoordinates(land,[edge.to,edge.from]),[...curve].reverse());
  if(!edge.osmNodeIds){assert.equal(edge.distanceSource,'one-metre-location-rounding-margin');continue;}
  let metres=0;for(let i=1;i<edge.osmNodeIds.length;i++){const a=edge.osmNodeIds[i-1],b=edge.osmNodeIds[i];assert.ok(segments.has([a,b].sort((x,y)=>x-y).join(',')));metres+=distance(coordinates.get(a),coordinates.get(b));}
  assert.ok(Math.abs(edge.metres-metres)<.006);
 }
});

test('Land uses the geographic background and hides former schematic routes',()=>{
 const container={innerHTML:'',querySelectorAll(){return[];},querySelector(){return null;}},graph=graphDistances(land);
 const row={kind:'walk',name:'過去の概略ルート',path:graph.paths.entry.thunder,metres:graph.distances.entry.thunder};
 renderParkMap(container,land,{plan:{rows:[row]}});assert.doesNotMatch(container.innerHTML,/過去の概略ルート/);
 assert.match(container.innerHTML,/href="assets\/land-geographic-map\.webp\?v=/);assert.match(container.innerHTML,/ODbL/);
 renderParkMap(container,land,{plan:{rows:[{...row,routeSource:land.routeGraphVersion}]}});assert.match(container.innerHTML,/過去の概略ルート/);
 const direct=distance([nodes.get('entry').lon,nodes.get('entry').lat],[nodes.get('thunder').lon,nodes.get('thunder').lat]);
 assert.ok(graph.distances.entry.thunder>direct*1.1);assert.ok(routeCoordinates(land,row.path).length>20);
});

test('a real v1.5.0 schematic Land plan keeps recorded distances across three saved replans',()=>{
 const saved=JSON.parse(fs.readFileSync(new URL('./fixtures/land-v150-plan.json',import.meta.url)));
 const cutoff=saved.result.visits[0].end+1;
 const before=saved.result.rows.filter(row=>row.kind==='walk'&&row.start<cutoff).map(row=>({start:row.start,end:row.end,metres:row.metres,path:row.path}));
 let sourcePlan=saved.result;const profile={...saved.settings,replanFrom:cutoff,waitBufferMode:'fixed',waitBufferMinutes:5,queueDelayMinutes:15};
 for(let i=0;i<3;i++){
  const result=solveItinerary(land,profile,{initialPlan:sourcePlan});assert.equal(result.status,'feasible');
  assert.equal(validatePlan(land,profile,result,{initialPlan:sourcePlan}).valid,true);
  const after=result.rows.filter(row=>row.kind==='walk'&&row.preserved).map(row=>({start:row.start,end:row.end,metres:row.metres,path:row.path}));
  assert.deepEqual(after,before);
  sourcePlan=parsePlanJson(buildPlanJson({parkId:'land',settings:profile,result})).result;
 }
});
