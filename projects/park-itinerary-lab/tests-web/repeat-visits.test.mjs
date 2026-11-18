import test from 'node:test';
import assert from 'node:assert/strict';
import {expandRepeatVisits, repeatVisitId, resolveDpaVisit} from '../web/repeat-visits.js';
import {solveItinerary, validatePlan} from '../web/planner.js';
import {operationPauseInfo} from '../web/operation-windows.js';

const ride = {id:'land-ride', name:'水の冒険', category:'attraction', node:'gate', duration:10,
  cost:100, baseWait:5, access:'normal', windows:[[540,1260]], dpa:{kind:'attraction', price:1500, wait:2}};
const park = {id:'land', entryNode:'gate', exitNode:'gate', nodes:[{id:'gate',x:50,y:50}], edges:[], activities:[ride]};
const date = '2026-11-19';
const second = repeatVisitId(ride.id);
const wish = {id:ride.id, weight:4, required:true, repeatCount:2};
const day = {date, entry:600, exit:720, speed:65, budget:5000, crowdMode:'manual', restEvery:0, searchSeconds:0.1, selections:[wish]};

test('repeat expansion is opt-in, limited to two attraction visits, and preserves original settings', () => {
  const one = {...day, selections:[{id:ride.id}]};
  assert.equal(expandRepeatVisits(park,one).park,park);
  assert.equal(expandRepeatVisits(park,one).settings,one);
  const {park:expanded, settings} = expandRepeatVisits(park,day);
  assert.equal(expanded.activities.length,2);
  assert.equal(settings.selections[1].id,second);
  assert.equal(park.activities.length,1);
  assert.equal(day.selections.length,1);
  const again = expandRepeatVisits(expanded,settings);
  assert.equal(again.park,expanded);
  assert.equal(again.settings,settings);
  assert.throws(() => expandRepeatVisits(park,{...day,selections:[{...wish,repeatCount:3}]}),/体験回数/);
  assert.throws(() => expandRepeatVisits({...park,activities:[{...ride,category:'shop'}]},day),/アトラクション/);
});

for (const searchMethod of ['beam','multistart','portfolio']) {
  test(searchMethod + ' schedules two requested rides in order, and a one-ride wish remains one ride', () => {
    const settings = {...day,searchMethod};
    const result = solveItinerary(park,settings);
    assert.equal(result.status,'feasible');
    assert.deepEqual(result.visits.map(visit=>visit.id),[ride.id,second]);
    assert.ok(result.visits[1].queueStart >= result.visits[0].end);
    assert.match(result.visits[1].name,/2回目/);
    assert.equal(result.totals.visitCount,2);
    assert.equal(result.totals.cost,200);
    assert.deepEqual(validatePlan(park,settings,result).errors,[]);
    const ordinary = {...settings,selections:[{...wish,repeatCount:1}]};
    assert.deepEqual(solveItinerary(park,ordinary).visits.map(visit=>visit.id),[ride.id]);
    assert.equal(validatePlan(park,ordinary,result).valid,false);
  });
}

test('one confirmed DPA is consumed once, and one completed visit leaves exactly one repeat', () => {
  const owned = {...wish,dpaMode:'owned',dpaStart:600,dpaEnd:640,dpaPurchasedAt:600};
  const settings = {...day,selections:[owned]};
  const first = solveItinerary(park,settings);
  assert.equal(first.status,'feasible');
  assert.equal(first.visits.length,2);
  const experiences = first.rows.filter(row=>row.kind==='activity');
  assert.equal(experiences[0].dpa,true);
  assert.equal(experiences[1].dpa,false);
  assert.equal(first.purchases.length,1);
  const current = {...settings,replanFrom:first.visits[0].end};
  const next = solveItinerary(park,current,{initialPlan:first});
  assert.deepEqual(next.visits.map(visit=>visit.id),[ride.id,second]);
  assert.deepEqual(next.rows.filter(row=>row.kind==='activity'&&!row.preserved).map(row=>row.activityId),[second]);
  assert.equal(next.purchases.length,1);
  assert.deepEqual(validatePlan(park,current,next,{initialPlan:first}).errors,[]);
});

test('saving an owned DPA preserves an optional second ride that did not fit', () => {
  const owned = {...wish,required:false,dpaMode:'owned',dpaStart:600,dpaEnd:623,dpaPurchasedAt:600};
  const result = solveItinerary(park,{...day,exit:623,selections:[owned]});
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.visits.map(visit=>visit.id),[ride.id]);
  assert.deepEqual(validatePlan(park,result.settings,result).errors,[]);
});

test('reducing the target to one rejects an unstarted repeat but preserves a completed repeat in the original timeline', () => {
  const two = solveItinerary(park,day);
  const one = {...day,selections:[{...wish,repeatCount:1}],replanFrom:day.entry};
  assert.equal(validatePlan(park,one,two,{initialPlan:two}).valid,false);
  const after = {...one,replanFrom:two.visits.at(-1).end};
  const revised = solveItinerary(park,after,{initialPlan:two});
  assert.deepEqual(revised.rows.filter(row=>row.preserved && row.kind==='activity').map(row=>row.activityId),[ride.id,second]);
  assert.deepEqual(validatePlan(park,after,revised,{initialPlan:two}).errors,[]);
});

test('both visits use the same facility observation; a later replan excludes the repeat if the facility stops', () => {
  const originalNow = Date.now;
  const moment = Date.parse(date+'T10:00:00+09:00');
  const stamp = new Date(moment).toISOString();
  const snapshot = {schemaVersion:1, provider:'queue-times', parkId:park.id, fetchedAt:stamp, unmatched:[],
    rides:[{activityId:ride.id,providerId:1,name:ride.name,updatedAt:stamp,isOpen:true,wait:7}]};
  try {
    Date.now=()=>moment;
    const settings = {...day,crowdMode:'auto',liveData:snapshot};
    const result = solveItinerary(park,settings);
    assert.equal(result.status,'feasible');
    assert.deepEqual(result.rows.filter(row=>row.kind==='queue').map(row=>[row.estimatedMinutes,row.waitSource]),[[7,'live'],[7,'live']]);
    const stopped = {...settings, completedIds:[ride.id], replanFrom:600, liveData:{...snapshot,rides:[{...snapshot.rides[0],isOpen:false,wait:0}]}};
    assert.equal(solveItinerary(park,stopped).status,'no-plan');
  } finally { Date.now=originalNow; }
});

test('the second gondola visit respects the harbour-show interruption on the physical facility', () => {
  const gondola = {...ride,id:'sea-attraction-230'};
  const show = {id:'sea-show-7404',category:'show',name:'公演',dailySchedules:{[date]:{showTimes:[630]}}};
  const p = {...park,id:'sea',activities:[gondola,show]};
  const {park:expanded} = expandRepeatVisits(p,{...day,selections:[{id:gondola.id,repeatCount:2}]});
  const secondGondola = expanded.activities.find(activity=>activity.id===repeatVisitId(gondola.id));
  assert.deepEqual(operationPauseInfo(expanded,secondGondola,{},day).windows,[[630,645]]);
});

test('a morning standby ride keeps the single unused midday DPA for the repeat on replan and round-trip', () => {
  const noon = {id:ride.id,owned:true,kind:'attraction',cost:1500,purchasedAt:600,start:720,end:750};
  const owned = {...wish,required:false,dpaMode:'owned',dpaPurchasedAt:600,dpaStart:720,dpaEnd:750};
  const original = {...day,exit:840,selections:[owned],purchases:[noon]};
  const prior = solveItinerary(park,original);
  assert.equal(prior.visits[0].method,'dpa');
  for (const first of [{status:'done',endsAt:620},{status:'done',reportedAt:623},{status:'done'}]) {
    const current = {...original,replanFrom:623,dayProgress:{parkId:park.id,date,visits:{[ride.id]:first}}};
    assert.equal(resolveDpaVisit(owned,current,prior),2);
    const revised = solveItinerary(park,current,{initialPlan:prior});
    assert.equal(revised.status,'feasible');
    const future = revised.rows.filter(r=>r.kind==='activity'&&!r.preserved);
    assert.deepEqual(future.map(r=>[r.activityId,r.dpa]),[[second,true]]);
    assert.ok(revised.visits.find(v=>v.id===second).queueStart>=720);
    assert.deepEqual(revised.purchases.map(p=>[p.id,p.cost]),[[ride.id,1500]]);
    assert.equal(revised.totals.dpaCost,1500);
    assert.equal(revised.settings.selections.length,1);
    assert.equal(revised.settings.selections[0].dpaMode,'owned');
    assert.equal(revised.settings.selections[0].dpaVisit,2);
    assert.deepEqual(validatePlan(park,revised.settings,revised,{initialPlan:prior}).errors,[]);
    const sc = JSON.parse(JSON.stringify(revised.settings));
    const rerun = solveItinerary(park,sc,{initialPlan:revised});
    assert.deepEqual(rerun.purchases.map(p=>[p.id,p.cost]),[[ride.id,1500]]);
    assert.deepEqual(rerun.rows.filter(r=>r.kind==='activity'&&!r.preserved).map(r=>[r.activityId,r.dpa]),[[second,true]]);
  }
});

test('a planned second-visit DPA candidate charges one physical ticket and does not give the first visit DPA access', () => {
  const offer = {...wish,dpaMode:'consider',dpaVisit:2,dpaAvailableWindows:[[635,650]],manualWait:25};
  const s = {...day,budgetPreference:'dpa',exit:650,selections:[offer]};
  const r = solveItinerary(park,s);
  assert.equal(r.status,'feasible');
  assert.deepEqual(r.visits.map(v=>[v.id,v.method]),[[ride.id,'normal'],[second,'dpa']]);
  assert.deepEqual(r.purchases.map(p=>[p.id,p.owned,p.cost]),[[ride.id,false,1500]]);
  assert.equal(r.totals.dpaCost,1500);
  assert.equal(r.settings.selections[0].dpaMode,'consider');
  assert.equal(r.settings.selections[0].dpaVisit,2);
  assert.deepEqual(validatePlan(park,r.settings,r).errors,[]);
});

test('a later replan cannot spend the same used first-visit pass on a requested second DPA', () => {
  const owned = {...wish,dpaMode:'owned',dpaStart:600,dpaEnd:670,dpaPurchasedAt:600};
  const s = {...day,selections:[owned]};
  const first = solveItinerary(park,s);
  const retry = {...s,replanFrom:first.visits[0].end,selections:[{...owned,dpaVisit:2}]};
  assert.equal(resolveDpaVisit(retry.selections[0],retry,first),1);
  const revised = solveItinerary(park,retry,{initialPlan:first});
  assert.equal(revised.status,'feasible');
  assert.deepEqual(revised.rows.filter(r=>r.kind==='activity').map(r=>[r.activityId,r.dpa]),[[ride.id,true],[second,false]]);
  assert.deepEqual(revised.purchases.map(p=>p.id),[ride.id]);
  assert.equal(revised.totals.dpaCost,1500);
});
