import test from 'node:test';
import assert from 'node:assert/strict';
import { solveItinerary, validatePlan } from '../web/planner.js';
import { contingencySettings } from '../web/contingency.js';
import { buildPlanJson, parsePlanJson, createShareUrl, readSharedState } from '../web/storage.js';

const ride = id => ({id, name:id, node:'gate', category:'attraction', duration:10, baseWait:45,
  windows:[[540,1260]], cost:0, dpa:{kind:'attraction',price:1000,wait:2}});
const park = {id:'land', entryNode:'gate', exitNode:'gate', nodes:[{id:'gate'}], edges:[],
  activities:['land-a','land-b','land-c'].map(ride)};
const candidates = park.activities.map(({id},i) => ({id, weight:3, dpaMode:'consider', dpaAvailableWindows:[[550+i*60,650+i*60]]}));
const day = {date:'2026-11-19',entry:540,exit:1200,speed:70,budget:10000,dpaBudget:10000,
  crowdMode:'manual',budgetPreference:'dpa',restEvery:0,restMinutes:0,searchSeconds:0.5,selections:candidates};
const owned = {...candidates[0],dpaMode:'owned',dpaStart:550,dpaEnd:580,dpaPurchasedAt:540};

for (const searchMethod of ['beam','multistart','portfolio']) {
  test(searchMethod+' keeps the candidates, limits new purchases and can use ordinary queues', () => {
    const settings={...day,searchMethod,dpaPurchaseLimit:1};
    const result=solveItinerary(park,settings);
    assert.equal(result.status,'feasible');
    assert.equal(result.visits.length,3);
    assert.equal(result.totals.plannedDpaCount,1);
    assert.equal(result.totals.dpaCost,1000);
    assert.equal(result.settings.selections.filter(wish=>wish.dpaMode==='consider').length,3);
    assert.equal(validatePlan(park,settings,result).valid,true);
    const delayed=solveItinerary(park,contingencySettings(settings,10));
    assert.equal(delayed.totals.plannedDpaCount,1);
  });
}

test('zero excludes new purchases, including free passes, while the confirmed ticket remains required and paid',()=>{
  const withFree={...park,activities:park.activities.map((ride,i)=>i===0?ride:{...ride,dpa:{...ride.dpa,price:0}})};
  const settings={...day,selections:[owned,...candidates.slice(1)],dpaPurchaseLimit:0};
  const result=solveItinerary(withFree,settings);
  assert.equal(result.totals.plannedDpaCount,0);
  assert.equal(result.totals.dpaCost,1000);
  assert.deepEqual(result.visits.filter(visit=>visit.method==='dpa').map(visit=>visit.id),[owned.id]);
  assert.equal(solveItinerary(withFree,{...settings,dpaPurchaseLimit:1}).totals.plannedDpaCount,1);
});

test('a tighter money limit still wins and older settings remain unlimited by count',()=>{
  const limited=solveItinerary(park,{...day,dpaBudget:1000,dpaPurchaseLimit:3});
  assert.equal(limited.totals.plannedDpaCount,1);
  const unlimited=solveItinerary(park,day);
  assert.equal(unlimited.totals.plannedDpaCount,3);
  assert.match(validatePlan(park,{...day,dpaPurchaseLimit:2},unlimited).errors.join(' '),/購入件数の上限/);
});

test('repeated replans keep used slots from old plans and leave owned slots outside the limit',()=>{
  const initial=solveItinerary(park,{...day,selections:[candidates[0]]});
  // v1.8 plans carried the ticket and its charge, without the explicit purchase marker.
  delete initial.rows.find(row=>row.kind==='activity').plannedDpaPurchase;
  delete initial.totals.plannedDpaCount;
  const secondOwned={...candidates[1],dpaMode:'owned',dpaStart:650,dpaEnd:690,dpaPurchasedAt:620};
  const settings={...day,dpaPurchaseLimit:1,replanFrom:600,selections:[candidates[0],secondOwned,candidates[2]]};
  const next=solveItinerary(park,settings,{initialPlan:initial});
  assert.equal(next.totals.plannedDpaCount,1);
  assert.equal(next.totals.dpaCost,2000);
  assert.equal(next.purchases.filter(p=>!p.owned).length,0);
  assert.equal(next.visits.find(v=>v.id===secondOwned.id).method,'dpa');
  const restored=parsePlanJson(buildPlanJson({parkId:'land',settings,result:next}));
  const repeated=solveItinerary(park,{...settings,replanFrom:615},{initialPlan:restored.result});
  assert.equal(repeated.totals.plannedDpaCount,1);
  assert.equal(repeated.totals.dpaCost,2000);
  // A tighter limit respects the immutable prefix and permits no additional purchases.
  const lowered=solveItinerary(park,{...settings,dpaPurchaseLimit:0},{initialPlan:initial});
  assert.equal(lowered.totals.plannedDpaCount,1);
  assert.equal(lowered.purchases.filter(p=>!p.owned).length,0);
  const tooExpensive=solveItinerary(park,{...settings,dpaBudget:1000},{initialPlan:initial});
  assert.equal(tooExpensive.status,'no-plan');
  // Confirming the same actual ticket later only charges it once.
  const confirmed={...settings,purchases:[initial.purchases[0]]};
  assert.equal(solveItinerary(park,confirmed,{initialPlan:initial}).totals.dpaCost,2000);
});

test('JSON and links retain zero, a positive limit, and an omitted limit, rejecting invalid values',()=>{
  for(const limit of [undefined,0,2]){
    const settings={...day,...(limit===undefined?{}:{dpaPurchaseLimit:limit})};
    const state={parkId:'land',settings};
    assert.equal(parsePlanJson(buildPlanJson(state)).settings.dpaPurchaseLimit,limit);
    const url=new URL(createShareUrl(state,'https://example.org/'));
    assert.equal(readSharedState(url.hash).settings.dpaPurchaseLimit,limit);
  }
  for(const limit of [-1,1.5,201,null,'1']){
    const settings={...day,dpaPurchaseLimit:limit};
    assert.throws(()=>buildPlanJson({parkId:'land',settings}),/購入件数/);
    assert.throws(()=>solveItinerary(park,settings),/購入件数/);
  }
});

test('one shared count covers both attraction and performance tickets even when their purchase clocks are independent',()=>{
  const show={...ride('land-c'),category:'show',showTimes:[700],dpa:{kind:'show',price:1000,wait:5}};
  const twoKinds={...park,activities:[park.activities[0],show]};
  const wishes=[candidates[0],{...candidates[2],dpaAvailableWindows:[[685,705],[690,705]]}];
  for(const limit of [1,2]){
    const settings={...day,selections:wishes,dpaPurchaseLimit:limit};
    const result=solveItinerary(twoKinds,settings);
    assert.equal(result.totals.plannedDpaCount,limit);
    assert.equal(result.visits.length,2);
    const forged=structuredClone(result);
    forged.totals.plannedDpaCount--;
    assert.match(validatePlan(twoKinds,settings,forged).errors.join(' '),/合計件数/);
  }
});
