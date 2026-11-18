import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings, noPlanActions, noPlanExplanation} from '../web/app.js';
import {solveItinerary, validatePlan} from '../web/planner.js';
import {contingencySettings} from '../web/contingency.js';
import {buildPlanJson, parsePlanJson, createShareUrl, readSharedState} from '../web/storage.js';

const categories=['restaurant','cafe','snack','popcorn','attraction'];
const activities=categories.map((category,i)=>({
  id:'land-'+category,name:category,node:i%2?'east':'gate',category,
  duration:10,baseWait:3,cost:0,windows:[[540,1260]],
}));
const park={id:'land',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate'},{id:'east'}],
  edges:[{from:'gate',to:'east',metres:140}],activities};
const wish=(category,extra={})=>({id:'land-'+category,weight:3,required:true,...extra});
const day={date:'2026-11-19',entry:540,exit:1080,speed:70,budget:5000,crowdMode:'manual',searchSeconds:0.4,avoidConsecutiveFood:true};

for(const searchMethod of ['beam','multistart','portfolio']){
  test(searchMethod+' spaces two meals with a selected non-food visit',()=>{
    const settings={...day,searchMethod,selections:[wish('restaurant'),wish('cafe'),wish('attraction',{required:false})]};
    const result=solveItinerary(park,settings);
    assert.equal(result.status,'feasible');
    assert.equal(result.visits.length,3);
    assert.equal(result.visits[1].category,'attraction');
    assert.equal(validatePlan(park,settings,result).valid,true);
    const alternative=solveItinerary(park,contingencySettings(settings,10));
    assert.equal(alternative.visits[1].category,'attraction');
  });
}

test('each kind of food uses a slot and all-required conflicts link to the controlling checkbox',()=>{
  for(const category of ['cafe','snack','popcorn']){
    const settings={...day,selections:[wish('restaurant'),wish(category)]};
    const blocked=solveItinerary(park,settings);
    assert.equal(blocked.status,'no-plan');
    assert.match(noPlanExplanation(blocked,park),/食事以外の希望/);
    assert.ok(noPlanActions(blocked,park).some(action=>!action.wishId&&action.field==='avoidConsecutiveFood'));
    const optional=solveItinerary(park,{...settings,selections:[wish('restaurant'),wish(category,{required:false})]});
    assert.equal(optional.status,'feasible');
    assert.deepEqual(optional.visits.map(v=>v.category),['restaurant']);
    assert.equal(optional.omissions[0].conflictField,'avoidConsecutiveFood');
  }
});

test('a walk, fixed break, free time and queue do not separate meals in search or validation',()=>{
  const settings={...day,selections:[wish('restaurant',{latest:590}),wish('cafe',{earliest:680})],
    fixedBreaks:[{id:'bench',label:'ベンチ',start:630,duration:10,node:'east'}]};
  const unrestricted=solveItinerary(park,{...settings,avoidConsecutiveFood:false});
  assert.equal(unrestricted.status,'feasible');
  const rows=unrestricted.rows;
  const gap=rows.slice(rows.findIndex(row=>row.kind==='activity')+1,rows.findLastIndex(row=>row.kind==='activity'));
  for(const kind of ['walk','rest','wait','queue'])assert.ok(gap.some(row=>row.kind===kind),kind);
  assert.match(validatePlan(park,settings,unrestricted).errors.join(' '),/フードが連続/);
  assert.equal(solveItinerary(park,settings).status,'no-plan');
});

test('turning spacing on during a replan preserves a food-food history but constrains the next visit',()=>{
  const oldSettings={...day,avoidConsecutiveFood:false,selections:[wish('restaurant'),wish('snack')]};
  const old=solveItinerary(park,oldSettings);
  assert.equal(old.visits.length,2);
  // This old result has the queue and activity rows but no visit summary.
  const older={...old,visits:[]};
  const replan={...day,replanFrom:600,selections:[...oldSettings.selections,wish('popcorn')]};
  assert.equal(solveItinerary(park,replan,{initialPlan:older}).status,'no-plan');
  const settings={...replan,selections:[...replan.selections,wish('attraction',{required:false})]};
  const next=solveItinerary(park,settings,{initialPlan:older});
  assert.equal(next.status,'feasible');
  const stops=next.rows.filter(row=>row.kind==='activity');
  assert.deepEqual(stops.slice(0,2).map(r=>[r.activityId,r.start,r.end]),old.rows.filter(r=>r.kind==='activity').map(r=>[r.activityId,r.start,r.end]));
  assert.ok(stops.slice(0,2).every(row=>row.preserved));
  assert.deepEqual(stops.slice(2).map(r=>r.category),['attraction','popcorn']);
  assert.equal(validatePlan(park,settings,next,{initialPlan:older}).valid,true);
});

test('new wishes use spacing while older or explicitly disabled settings retain the old ordering',()=>{
  assert.equal(defaultSettings().avoidConsecutiveFood,true);
  for(const enabled of [true,false,undefined]){
    const settings={...day,selections:[wish('restaurant'),wish('snack')]};
    if(enabled===undefined)delete settings.avoidConsecutiveFood;
    else settings.avoidConsecutiveFood=enabled;
    const state={parkId:'land',settings};
    const json=parsePlanJson(buildPlanJson(state));
    const shared=readSharedState(new URL(createShareUrl(state,'https://example.org')).hash);
    for(const saved of [json,shared]){
      assert.equal(saved.settings.avoidConsecutiveFood,enabled);
      assert.equal(solveItinerary(park,saved.settings).status,enabled?'no-plan':'feasible');
    }
  }
  const invalid={...day,avoidConsecutiveFood:'false',selections:[]};
  assert.throws(()=>solveItinerary(park,invalid),/フード/);
  assert.throws(()=>buildPlanJson({parkId:'land',settings:invalid}),/フード/);
});
