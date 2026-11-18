import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings,resetForNewVisitDay,skipScheduledRest} from '../web/app.js';
import {solveItinerary,validatePlan} from '../web/planner.js';
import {buildPlanJson,parsePlanJson,buildCalendar,buildScheduleCsv,buildOfflineHtml} from '../web/storage.js';

const park={id:'land',name:'ランド',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate',x:0,y:0}],edges:[],events:[],
  activities:['first','next','second','last'].map((id,i)=>({id,name:id,node:'gate',category:'attraction',
    sourceUrl:'https://example.org/',duration:15,baseWait:i%2===0?45:0,cost:0,access:'normal',windows:[[540,900]]}))};
const setup=()=>({date:'2026-11-18',entry:540,exit:900,speed:70,budget:5000,crowdMode:'manual',weather:'sun',
  crowdLevel:'normal',restEvery:90,restMinutes:10,searchSeconds:.15,selections:park.activities.map((a,i)=>({
    id:a.id,weight:3,required:true,earliest:[540,600,645,710][i],latest:[600,645,708,760][i]}))});
const rests=plan=>plan.rows.filter(row=>row.kind==='rest');

test('automatic breaks are opt-in for a new visit and old explicit intervals survive a round trip',()=>{
  assert.equal(defaultSettings().restEvery,0);
  for(const interval of [0,60,90,120]){
    const settings={...setup(),restEvery:interval};
    assert.equal(parsePlanJson(buildPlanJson({settings,parkId:'land'})).settings.restEvery,interval);
  }
  const settings=setup();delete settings.restEvery;
  assert.equal(rests(solveItinerary(park,settings)).length,0);
});

test('skipping one interval edits the schedule immediately and does not move any later rows',()=>{
  const settings=setup(),plan=solveItinerary(park,settings),index=plan.rows.findIndex(row=>row.kind==='rest');
  assert.deepEqual(rests(plan).map(r=>r.start),[600,705]);
  const edited=skipScheduledRest(settings,plan,index);
  assert.deepEqual(edited.result.rows,plan.rows.filter((_,i)=>i!==index));
  assert.deepEqual(edited.result.visits,plan.visits);
  assert.deepEqual(edited.result.totals,{...plan.totals,restMinutes:10});
  assert.equal(edited.settings.restEvery,90);
  assert.equal(settings.skipAutoRestAfter,undefined);
  assert.equal(rests(plan).length,2);
  assert.deepEqual(edited.settings.skipAutoRestAfter,['first']);
  assert.deepEqual(edited.result.settings.skipAutoRestAfter,['first']);
  assert.equal(validatePlan(park,edited.settings,edited.result).valid,true);
  const saved=parsePlanJson(buildPlanJson({parkId:'land',...edited}));
  assert.deepEqual(saved.result.rows,edited.result.rows);
  for(const build of [buildScheduleCsv,buildCalendar,buildOfflineHtml]){
    const output=build(saved.result,park,saved.settings);
    assert.equal((output.match(/ひと休み/g)||[]).length,1);
  }
});

test('skipped recovery follows the preceding visit on explicit searches with a different next stop',()=>{
  const s=setup(),first=solveItinerary(park,s);
  const edited=skipScheduledRest(s,first,first.rows.findIndex(r=>r.kind==='rest'));
  const settings={...edited.settings,selections:edited.settings.selections.filter(w=>w.id!=='next')};
  for(const searchMethod of ['beam','multistart','portfolio']){
    const plan=solveItinerary(park,{...settings,searchMethod});
    assert.equal(plan.status,'feasible');
    assert.deepEqual(rests(plan).map(r=>r.start),[705]);
    assert.equal(validatePlan(park,settings,plan).valid,true);
  }
  resetForNewVisitDay({settings:edited.settings});assert.equal(edited.settings.skipAutoRestAfter,undefined);
});

test('replanning during the freed time preserves the completed visit and the remaining rest',()=>{
  const s=setup(),plan=solveItinerary(park,s);
  const edited=skipScheduledRest(s,plan,plan.rows.findIndex(r=>r.kind==='rest'));
  const replanned={...edited.settings,replanFrom:604};
  const next=solveItinerary(park,replanned,{initialPlan:edited.result});
  assert.equal(next.status,'feasible');
  assert.equal(next.rows.find(r=>r.activityId==='first'&&r.kind==='activity').preserved,true);
  assert.deepEqual(rests(next).map(r=>r.start),[705]);
  assert.equal(validatePlan(park,replanned,next,{initialPlan:edited.result}).valid,true);
});

test('removing a fixed rest keeps its connecting movement and protects started or preserved breaks',()=>{
  const route={...park,nodes:[...park.nodes,{id:'garden',x:1,y:1}],edges:[{from:'gate',to:'garden',metres:70}]};
  const settings={...setup(),restEvery:0,fixedBreaks:[{id:'tea',node:'garden',start:780,duration:15,label:'お茶休憩'}]};
  const plan=solveItinerary(route,settings),index=plan.rows.findIndex(r=>r.fixedBreakId==='tea');
  const edited=skipScheduledRest(settings,plan,index);
  assert.deepEqual(edited.settings.fixedBreaks,[]);
  assert.deepEqual(edited.result.settings.fixedBreaks,[]);
  assert.deepEqual(edited.result.rows.map(r=>[r.kind,r.start,r.end]),plan.rows.filter((_,i)=>i!==index).map(r=>[r.kind,r.start,r.end]));
  assert.equal(edited.result.rows.some(r=>r.name.includes('休憩')),false);
  assert.ok(edited.result.rows.some(r=>r.kind==='walk'&&r.from==='gate'&&r.to==='garden'));
  assert.equal(validatePlan(route,edited.settings,edited.result).valid,true);
  assert.equal(skipScheduledRest({...settings,replanFrom:785},plan,index),null);
  const historical=structuredClone(plan);historical.rows[index].preserved=true;
  assert.equal(skipScheduledRest(settings,historical,index),null);
});
