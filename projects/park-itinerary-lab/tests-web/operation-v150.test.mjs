import test from 'node:test';
import assert from 'node:assert/strict';
import {operationPauseInfo,subtractPauseWindows,GONDOLA_ID} from '../web/operation-windows.js';
import {solveItinerary,validatePlan,graphDistances} from '../web/planner.js';
import {normaliseThemeParksLive,prepareLiveForReplan} from '../web/wait-data.js';

const date='2026-11-17';
const gondola={id:GONDOLA_ID,name:'ヴェネツィアン・ゴンドラ',category:'attraction',node:'a',duration:10,baseWait:10,cost:0,windows:[[540,1260]],access:'normal'};
const harbour={id:'sea-show-7404',name:'ハーバーショー',category:'show',node:'a',duration:15,baseWait:0,cost:0,windows:[[540,1260]],dailySchedules:{[date]:{closed:false,showTimes:[600]}}};
const park=()=>({id:'sea',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate',x:0,y:0},{id:'a',x:100,y:0}],edges:[{from:'gate',to:'a',metres:100}],activities:[structuredClone(gondola),structuredClone(harbour)],events:[]});
const settings=extra=>({date,entry:580,exit:720,speed:50,budget:5000,restEvery:0,restMinutes:0,searchSeconds:.1,crowdMode:'manual',weather:'sun',selections:[{id:GONDOLA_ID,weight:5,required:true,earliest:590}],...extra});

test('only known dated harbour performances create labelled Gondola avoidance windows',()=>{
 const p=park();p.activities.push({...harbour,id:'sea-show-7405',name:'環境演出',dailySchedules:{[date]:{closed:false,showTimes:[650]}}});
 const info=operationPauseInfo(p,gondola,{},settings());assert.deepEqual(info.windows,[[600,615]]);assert.equal(info.items[0].kind,'show-avoidance');assert.match(info.note,/目安/);assert.match(info.items[0].sourceUrl,/tokyodisneyresort/);
 assert.deepEqual(operationPauseInfo(p,gondola,{},settings({date:'2026-11-18'})).windows,[]);
 p.activities[1].dailySchedules[date].closed=true;assert.deepEqual(operationPauseInfo(p,gondola,{},settings()).windows,[]);
});
test('explicit pauses and show avoidance split openings with half-open boundaries',()=>{
 assert.deepEqual(subtractPauseWindows([[540,720]],[[600,615],[615,620]]),[[540,600],[620,720]]);
 const p=park(),s=settings({entry:578,selections:[{id:GONDOLA_ID,weight:5,required:true,earliest:580}]});
 const r=solveItinerary(p,s);assert.equal(r.visits[0].end,600); // May finish exactly as avoidance begins.
 const later=solveItinerary(p,settings());assert.equal(later.visits[0].queueStart,615);assert.equal(later.visits[0].end,635);
 const disabled=solveItinerary(p,settings({gondolaAvoidHarbourShows:false}));assert.equal(disabled.visits[0].queueStart,590);
 const manual=solveItinerary(p,settings({gondolaAvoidHarbourShows:false,selections:[{id:GONDOLA_ID,weight:5,required:true,earliest:590,pauseWindows:[[585,630]]}]}));assert.equal(manual.visits[0].queueStart,630);
});
test('DPA queue and ride cannot cross a pause, and a later feasible slot is considered',()=>{
 const p=park();p.activities[0].dpa={price:1000,wait:5,kind:'attraction'};
 const s=settings({selections:[{id:GONDOLA_ID,weight:5,dpaMode:'owned',dpaPurchasedAt:580,dpaStart:590,dpaEnd:650}]});
 const r=solveItinerary(p,s);assert.equal(r.status,'feasible');assert.equal(r.visits[0].queueStart,615);assert.equal(r.rows.find(row=>row.kind==='activity').dpa,true);assert.equal(validatePlan(p,s,r).valid,true);
 const impossible=solveItinerary(p,{...s,selections:[{...s.selections[0],dpaEnd:610}]});assert.equal(impossible.status,'no-plan');
});
test('independent verification rejects a new queue or ride overlapping a pause',()=>{
 const p=park(),s=settings(),r=solveItinerary(p,{...s,gondolaAvoidHarbourShows:false});
 assert.equal(validatePlan(p,s,r).valid,false);
 const noRoom=solveItinerary(p,settings({exit:620}));assert.equal(noRoom.status,'no-plan');assert.equal(noRoom.coverage.requiredCount,0);
});
test('a newly reported pause does not rewrite an already-started visit',()=>{
 const p=park(),firstSettings=settings({gondolaAvoidHarbourShows:false}),first=solveItinerary(p,firstSettings);
 const s={...firstSettings,replanFrom:595,gondolaAvoidHarbourShows:true};
 const r=solveItinerary(p,s,{initialPlan:first});assert.equal(r.status,'feasible');assert.ok(r.rows.some(row=>row.kind==='activity'&&row.preserved&&row.start===600));
 assert.equal(validatePlan(p,s,r,{initialPlan:first}).valid,true);
});
test('a confirmed OPEN → DOWN → OPEN cycle updates the remaining Gondola plan',async()=>{
 const original=Date.now,moment=Date.parse(date+'T01:00:00Z');Date.now=()=>moment;
 try{
  const p=park(),s=settings({entry:600,replanFrom:600,gondolaAvoidHarbourShows:false});
  const snapshot=status=>normaliseThemeParksLive({id:'67b290d5-3478-4f23-b601-2f8fb71ba803',liveData:[{entityType:'ATTRACTION',externalId:'230',name:gondola.name,status,queue:{STANDBY:{waitTime:10}}}]},p,{now:moment});
  let current=await prepareLiveForReplan(s,p,{now:moment,fetchRealtimeWaitsImpl:async()=>snapshot('OPERATING')});assert.equal(solveItinerary(p,current).status,'feasible');
  current=await prepareLiveForReplan(current,p,{now:moment,fetchRealtimeWaitsImpl:async()=>snapshot('DOWN')});assert.equal(solveItinerary(p,current).status,'no-plan');
  current=await prepareLiveForReplan(current,p,{now:moment,fetchRealtimeWaitsImpl:async()=>snapshot('OPERATING')});assert.equal(solveItinerary(p,current).status,'feasible');assert.equal(current.operationalHolds,null);
 }finally{Date.now=original;}
});
test('route upgrades keep a source-plan completed walk and use the new graph for future legs',()=>{
 const p=park(),s=settings({gondolaAvoidHarbourShows:false}),first=solveItinerary(p,s),visit=first.rows.find(row=>row.kind==='activity');
 const upgraded={...p,routeGraphVersion:'sea-osm-test',edges:[{from:'gate',to:'a',metres:600}]};
 const nextSettings={...s,replanFrom:visit.end},next=solveItinerary(upgraded,nextSettings,{initialPlan:first});
 const walks=next.rows.filter(row=>row.kind==='walk');assert.equal(walks[0].metres,100);assert.equal(walks[0].preserved,true);assert.equal(walks[1].metres,600);assert.equal(walks[1].routeSource,'sea-osm-test');
 assert.equal(validatePlan(upgraded,nextSettings,next,{initialPlan:first}).valid,true);assert.equal(validatePlan(upgraded,nextSettings,next).valid,false);
 const forged=structuredClone(next);forged.rows.find(row=>row.preserved&&row.kind==='walk').metres=99;assert.equal(validatePlan(upgraded,nextSettings,forged,{initialPlan:first}).valid,false);
});
test('larger sparse pedestrian graphs retain exact shortest paths',()=>{
 const nodes=Array.from({length:500},(_,i)=>({id:'n'+i}));
 const edges=nodes.slice(1).map((node,i)=>({from:'n'+i,to:node.id,metres:2}));edges.push({from:'n0',to:'n499',metres:2000});
 const graph=graphDistances({nodes,edges});assert.equal(graph.distances.n0.n499,998);assert.equal(graph.paths.n0.n499.length,500);
});
test('lazy distances match an independent small Floyd oracle including unreachable nodes',()=>{
 const nodes=Array.from({length:14},(_,i)=>({id:'n'+i})),edges=[];
 for(let i=0;i<12;i++)for(let j=i+1;j<13;j++)if((i*17+j*7)%4===0)edges.push({from:'n'+i,to:'n'+j,metres:(i+j+1)*1.25});
 edges.push({from:'n0',to:'n1',metres:0},{from:'n0',to:'n1',metres:50});
 const oracle=nodes.map((_,i)=>nodes.map((_,j)=>i===j?0:Infinity));for(const edge of edges){const a=Number(edge.from.slice(1)),b=Number(edge.to.slice(1));oracle[a][b]=oracle[b][a]=Math.min(oracle[a][b],edge.metres);}
 for(let k=0;k<nodes.length;k++)for(let i=0;i<nodes.length;i++)for(let j=0;j<nodes.length;j++)oracle[i][j]=Math.min(oracle[i][j],oracle[i][k]+oracle[k][j]);
 const graph=graphDistances({nodes,edges});
 for(let i=0;i<nodes.length;i++)for(let j=0;j<nodes.length;j++){
  assert.equal(graph.distances['n'+i]['n'+j],oracle[i][j]);
  const path=graph.paths['n'+i]['n'+j];if(!Number.isFinite(oracle[i][j]))assert.deepEqual(path,[]);else{assert.equal(path[0],'n'+i);assert.equal(path.at(-1),'n'+j);let length=0;for(let k=1;k<path.length;k++)length+=Math.min(...edges.filter(edge=>(edge.from===path[k-1]&&edge.to===path[k])||(edge.to===path[k-1]&&edge.from===path[k])).map(edge=>edge.metres));assert.equal(length,oracle[i][j]);}
 }
});
test('independent geometric validation rejects a path that shortcuts an absent pedestrian edge',()=>{
 const p=park();p.nodes.push({id:'junction',x:50,y:100});p.edges=[{from:'gate',to:'junction',metres:100},{from:'junction',to:'a',metres:100}];
 const s=settings({gondolaAvoidHarbourShows:false}),r=solveItinerary(p,s);assert.equal(validatePlan(p,s,r).valid,true);
 const forged=structuredClone(r);forged.rows.find(row=>row.kind==='walk').path=['gate','a'];assert.equal(validatePlan(p,s,forged).valid,false);
});
test('replanning a dated legacy plan retains verified history before the current entry boundary',()=>{
 const p=park();p.id='land';p.activities=[{...gondola,id:'land-attraction-152',duration:15,baseWait:0,windows:[[540,1260]]}];p.edges[0].metres=490;
 const oldSettings=settings({entry:480,exit:1260,speed:70,gondolaAvoidHarbourShows:false,selections:[{id:'land-attraction-152',weight:5,manualWait:0}]});
 const first=solveItinerary(p,oldSettings);assert.equal(first.rows[0].start,480);assert.equal(first.rows[0].end,487);assert.equal(first.rows.find(row=>row.kind==='activity').start,540);
 const nextSettings={...oldSettings,entry:540,replanFrom:840},next=solveItinerary(p,nextSettings,{initialPlan:first});
 assert.equal(next.status,'feasible');assert.equal(next.rows[0].start,480);assert.equal(validatePlan(p,nextSettings,next,{initialPlan:first}).valid,true);assert.equal(validatePlan(p,nextSettings,next).valid,false);
 const forged=structuredClone(next);forged.rows[0].name='changed history';assert.equal(validatePlan(p,nextSettings,forged,{initialPlan:first}).valid,false);
 const wrongDate=structuredClone(first);wrongDate.settings.date='2026-11-16';assert.equal(validatePlan(p,nextSettings,next,{initialPlan:wrongDate}).valid,false);
 const future=structuredClone(next);future.rows[0].preserved=false;assert.equal(validatePlan(p,nextSettings,future,{initialPlan:first}).valid,false);
});
test('historical entry provenance survives saved-plan round trips and repeated replanning',async()=>{
 const {buildPlanJson,parsePlanJson,validateSavedState}=await import('../web/storage.js');
 const p=park();p.id='land';p.activities=[{...gondola,id:'land-attraction-152',duration:15,baseWait:0,windows:[[540,1260]]}];p.edges[0].metres=490;
 const s=settings({entry:480,exit:1260,speed:70,gondolaAvoidHarbourShows:false,selections:[{id:'land-attraction-152',weight:5,manualWait:0}]}),first=solveItinerary(p,s);
 const current={...s,entry:540,replanFrom:840};let previous=solveItinerary(p,current,{initialPlan:first});
 for(const cutoff of [900,960]){
  const restored=parsePlanJson(buildPlanJson({parkId:'land',settings:{...current,replanFrom:cutoff-60},result:previous}));
  const nextSettings={...current,replanFrom:cutoff},next=solveItinerary(p,nextSettings,{initialPlan:restored.result});
  assert.equal(next.rows[0].start,480);assert.deepEqual(next.historicalVisitBounds,{date:s.date,parkId:'land',entry:480,exit:1260});assert.equal(validatePlan(p,nextSettings,next,{initialPlan:restored.result}).valid,true);
  const forged=structuredClone(next);forged.historicalVisitBounds.entry=400;assert.equal(validatePlan(p,nextSettings,forged,{initialPlan:restored.result}).valid,false);previous=next;
 }
 const expanded=structuredClone(previous);expanded.historicalVisitBounds.entry=0;const nextSettings={...current,replanFrom:1020};const checked=solveItinerary(p,nextSettings,{initialPlan:expanded});assert.equal(checked.historicalVisitBounds.entry,480);
 const invalid={parkId:'land',settings:current,result:structuredClone(previous)};invalid.result.historicalVisitBounds.date='2026-02-30';assert.throws(()=>validateSavedState(invalid));
});
