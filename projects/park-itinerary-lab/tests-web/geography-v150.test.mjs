import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {routeCoordinates, renderParkMap} from '../web/map-view.js';

const catalogue = JSON.parse(fs.readFileSync(new URL('../web/data/parks.json',import.meta.url)));
const sea = catalogue.parks.find(park=>park.id==='sea');
const geography = JSON.parse(fs.readFileSync(new URL('../web/data/sea-geography.json',import.meta.url)));
const nodes = new Map(sea.nodes.map(node=>[node.id,node]));
const sourceCoordinates = new Map(geography.walkways.flatMap(way=>way.osmNodeIds.map((id,index)=>[id,way.coordinates[index]])));
const distance = (a,b) => {
  const radians=value=>value*Math.PI/180;
  const h=Math.sin(radians(b[1]-a[1])/2)**2+Math.cos(radians(a[1]))*Math.cos(radians(b[1]))*Math.sin(radians(b[0]-a[0])/2)**2;
  return 2*6371008.8*Math.asin(Math.sqrt(h));
};
function shortestPath(from,to) {
  const todo=new Set(nodes.keys()), distances=new Map([[from,0]]), previous=new Map();
  const adj=new Map([...nodes.keys()].map(id=>[id,[]]));
  for(const edge of sea.edges) {adj.get(edge.from).push([edge.to,edge.metres]);adj.get(edge.to).push([edge.from,edge.metres]);}
  while(todo.size) {
    let best=null;
    for(const node of todo)if(best===null||(distances.get(node)??Infinity)<(distances.get(best)??Infinity))best=node;
    assert.ok(Number.isFinite(distances.get(best)),'All graph nodes must be connected');
    todo.delete(best);
    for(const [next,metres]of adj.get(best))if(distances.get(best)+metres<(distances.get(next)??Infinity)) {distances.set(next,distances.get(best)+metres);previous.set(next,best);}
  }
  const path=[to];while(path.at(-1)!==from)path.push(previous.get(path.at(-1)));
  return {path:path.reverse(),metres:distances.get(to)};
}

test('シーの施設と名前付き地点を残し内部の徒歩交差点を区別する',()=>{
  assert.equal(catalogue.version,'1.2.0');
  assert.equal(sea.activities.length,109);
  assert.ok(sea.nodes.length<1000);
  assert.equal(sea.nodes.filter(node=>!node.routingOnly).length,138);
  for(const activity of sea.activities)assert.equal(nodes.get(activity.node).routingOnly,false);
  for(const node of sea.nodes)assert.ok(Number.isFinite(node.lon)&&Number.isFinite(node.lat));
  shortestPath(sea.entryNode,sea.exitNode);
});

test('全ての曲線の向きと端点が一致し逆方向も同じ通路をたどる',()=>{
  for(const edge of sea.edges) {
    const forward=routeCoordinates(sea,[edge.from,edge.to]);
    const reverse=routeCoordinates(sea,[edge.to,edge.from]);
    assert.deepEqual(reverse,[...forward].reverse());
    assert.deepEqual(forward[0],[nodes.get(edge.from).x,nodes.get(edge.from).y]);
    assert.deepEqual(forward.at(-1),[nodes.get(edge.to).x,nodes.get(edge.to).y]);
    assert.deepEqual(forward,edge.geometry);
  }
  assert.deepEqual(routeCoordinates(sea,['entry','fortress']),[],'A missing edge must not become a straight connector');
});

test('曲線の頂点は実在する徒歩通路の頂点で距離はその測地距離の合計',()=>{
  const segments=new Set(geography.walkways.map(way=>[...way.osmNodeIds].sort((a,b)=>a-b).join(',')));
  for(const edge of sea.edges) {
    if(!edge.osmNodeIds) {
      assert.equal(edge.distanceSource,'one-metre-location-rounding-margin');
      assert.deepEqual(edge.geometry[0],edge.geometry[1]);
      continue;
    }
    let sum=0;
    for(let i=1;i<edge.osmNodeIds.length;i++) {
      const a=edge.osmNodeIds[i-1],b=edge.osmNodeIds[i];
      assert.ok(segments.has([a,b].sort((x,y)=>x-y).join(',')));
      sum+=distance(sourceCoordinates.get(a),sourceCoordinates.get(b));
    }
    assert.ok(Math.abs(sum-edge.metres)<.006);
  }
});

test('ハーバーは島を持つ水域で南岸からフォートレスへは岸を回る',()=>{
  const harbour=geography.water.find(water=>water.osmRelationId===3531413);
  assert.ok(harbour.geometry.length>500);
  assert.ok(harbour.holes.length>=5);
  const route=shortestPath('harbor-s','fortress');
  const from=nodes.get('harbor-s'),to=nodes.get('fortress');
  const direct=distance([from.lon,from.lat],[to.lon,to.lat]);
  assert.ok(route.metres>direct*1.5);
  assert.ok(routeCoordinates(sea,route.path).length>30);
});

test('地理背景と帰属を表示し旧保存プランの概略線を重ねない',()=>{
  const container={innerHTML:'',querySelectorAll(){return[];},querySelector(){return null;}};
  const path=shortestPath('harbor-s','fortress').path;
  const row={kind:'walk',name:'テスト徒歩',path,metres:400};
  renderParkMap(container,sea,{plan:{rows:[row]}});
  assert.match(container.innerHTML,/assets\/sea-geographic-map.svg/);
  assert.match(container.innerHTML,/openstreetmap.org\/copyright/);
  assert.doesNotMatch(container.innerHTML,/テスト徒歩/);
  renderParkMap(container,sea,{plan:{rows:[{...row,routeSource:sea.routeGraphVersion}]}});
  assert.match(container.innerHTML,/テスト徒歩/);
});
