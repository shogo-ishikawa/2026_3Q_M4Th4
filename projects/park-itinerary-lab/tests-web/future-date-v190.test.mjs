import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activitySchedule, defaultSettings, noPlanActions, noPlanExplanation, resetForNewVisitDay, wishInputProblem} from '../web/app.js';
import {solveItinerary} from '../web/planner.js';

const {parks:[land,sea]}=JSON.parse(readFileSync(new URL('../web/data/parks.json',import.meta.url)));
const beauty=land.activities.find(item=>item.id==='land-attraction-197');
const parade=land.activities.find(item=>item.id==='land-parade-913');
const first='2026-11-18', next='2026-11-19';
// The live updater prunes old dates. Keep these dated regression examples even
// when a later release refreshes the bundled catalogue.
Object.assign(parade,{showTimesDate:first,showTimes:[1140],dailySchedules:{
  [first]:{closed:false,showTimes:[1140]},[next]:{closed:false,showTimes:[1140]}},closedDates:[],closedPeriods:[]});
Object.assign(beauty,{windows:[[540,1260]],dailySchedules:{},closedDates:[],closedPeriods:[]});
const makeSettings=(date,selections,method='beam')=>({...defaultSettings(),date,entry:540,exit:1260,
  weatherMode:'manual',crowdMode:'manual',searchMethod:method,restEvery:0,searchSeconds:1,selections});
const currentSlot={dpaStart:560,dpaEnd:600,dpaAvailableWindows:[[560,600]]};

for(const method of ['beam','multistart','portfolio']){
  test(`${method} retains the DPA preference across dates and uses only the newly confirmed window`,()=>{
    const show={id:parade.id,required:true,dpaMode:'none',showTimes:activitySchedule(parade,first).showTimes,confirmSchedule:true};
    const wish={id:beauty.id,required:true,manualWait:90,earliest:550,latest:610,dpaMode:'consider',...currentSlot};
    const state={settings:makeSettings(first,[wish,show],method)};
    const initial=solveItinerary(land,state.settings);
    assert.equal(initial.status,'feasible');
    assert.equal(initial.visits.find(visit=>visit.id===beauty.id).method,'dpa');
    state.settings.date=next;
    resetForNewVisitDay(state,land);
    assert.equal(wish.dpaMode,'consider');
    assert.equal(wish.dpaAvailableWindows,undefined);
    assert.deepEqual(show.showTimes,parade.dailySchedules[next].showTimes);
    const problem=wishInputProblem(wish,beauty,next);
    assert.equal(problem.field,'dpaStart');
    assert.match(problem.message,/美女と野獣.*2026-11-19/);
    const withoutDpa=solveItinerary(land,{...state.settings,selections:[{...wish,dpaMode:'none'},show]});
    assert.equal(withoutDpa.status,'no-plan');
    assert.match(noPlanExplanation(withoutDpa,land),/美女と野獣.*待ち時間90分.*最大60分/);
    Object.assign(wish,structuredClone(currentSlot));
    assert.equal(wishInputProblem(wish,beauty,next),null);
    const plan=solveItinerary(land,state.settings);
    assert.equal(plan.status,'feasible');
    assert.equal(plan.visits.find(visit=>visit.id===beauty.id).method,'dpa');
    assert.equal(plan.visits.find(visit=>visit.id===parade.id).start,show.showTimes[0]);
  });
}

test('a date change clears daily facts and their invalid drafts while keeping preference hours and required wishes',()=>{
  const wish={id:beauty.id,required:true,earliest:560,latest:680,dpaMode:'owned',...currentSlot,
    dpaPurchasedAt:540,windows:[[560,600]],pauseWindows:[[565,580]],confirmedAccess:true,normalShowTimes:[650]};
  const state={settings:{...makeSettings(next,[wish]),purchases:[{id:beauty.id}],spentBudget:2500}};
  const drafts=new WeakMap([[wish,new Map([['pauseWindows',{}],['windowStart',{}],['cost',{}]])]]);
  resetForNewVisitDay(state,land,drafts);
  assert.deepEqual(wish,{id:beauty.id,required:true,earliest:560,latest:680,dpaMode:'consider'});
  assert.deepEqual(state.settings.purchases,[]);
  assert.equal(state.settings.spentBudget,0);
  assert.deepEqual([...drafts.get(wish).keys()],['cost']);
});

test('a future optional show without times can stay on the wishlist while the required ride is scheduled',()=>{
  const date='2027-01-05';
  const show={id:parade.id,required:false,showTimes:[1140],confirmSchedule:true};
  const ride={id:beauty.id,required:true,manualWait:15};
  const state={settings:makeSettings(date,[show,ride])};
  resetForNewVisitDay(state,land);
  assert.deepEqual(show.showTimes,[]);
  assert.equal(show.confirmSchedule,false);
  assert.equal(wishInputProblem(show,parade,date),null);
  const plan=solveItinerary(land,state.settings);
  assert.equal(plan.status,'feasible');
  assert.deepEqual(plan.visits.map(v=>v.id),[beauty.id]);
  assert.match(plan.omissions[0].reason,/公演時刻が未入力/);
  assert.equal(wishInputProblem({...show,required:true},parade,date).field,'showTimes');
  assert.equal(wishInputProblem({...show,showTimes:[600]},parade,date).field,'confirmSchedule');
  assert.deepEqual(solveItinerary(land,{...state.settings,selections:[{...show,showTimes:[600]},ride]}).visits.map(v=>v.id),[beauty.id]);
});

test('confirmed closure takes priority over missing show times and optional closed shows do not block a visit',()=>{
  const show=sea.activities.find(a=>a.id==='sea-show-967');
  const date='2026-11-27';
  const datedShow={...show,closedPeriods:[{startDate:date,endDate:date}]};
  assert.equal(activitySchedule(datedShow,date).closed,true);
  assert.equal(wishInputProblem({id:show.id,required:false,showTimes:[]},datedShow,date),null);
  const binding=wishInputProblem({id:show.id,required:true,showTimes:[]},datedShow,date);
  assert.equal(binding.field,'visitDate');
  assert.match(binding.message,/2026-11-27.*休止/);
});

test('a verified later opening identifies the affected required greeting and links its time window',()=>{
  const greeting=sea.activities.find(a=>a.id==='sea-greeting-901');
  const datedGreeting={...greeting,closedDates:[],closedPeriods:[],dailySchedules:{
    [first]:{closed:false,windows:[[540,1200]]},[next]:{closed:false,windows:[[570,1200]]}}};
  const park={...sea,activities:[datedGreeting]};
  const wish={id:greeting.id,required:true,manualWait:0,duration:5,earliest:540,latest:570};
  const settings={...makeSettings(first,[wish]),currentNode:greeting.node};
  assert.equal(solveItinerary(park,settings).status,'feasible');
  settings.date=next;
  const rejected=solveItinerary(park,settings);
  assert.equal(rejected.status,'no-plan');
  assert.match(noPlanExplanation(rejected,park),/2026-11-19.*ミッキー.*営業時間.*希望時間帯/);
  assert.ok(noPlanActions(rejected,park).some(action=>action.wishId===wish.id&&action.field==='earliest'));
  wish.latest=600;
  assert.equal(solveItinerary(park,settings).status,'feasible');
});

test('zero new purchases lets dated DPA candidates use the normal queue without entering a sale window',()=>{
  const wish={id:beauty.id,required:true,dpaMode:'consider',manualWait:20};
  const settings={...makeSettings(next,[wish]),dpaPurchaseLimit:0};
  assert.equal(wishInputProblem(wish,beauty,next,0),null);
  const result=solveItinerary(land,settings);
  assert.equal(result.status,'feasible');
  assert.equal(result.visits[0].method,'normal');
  assert.equal(wishInputProblem(wish,beauty,next,1).field,'dpaStart');
  assert.equal(wishInputProblem({...wish,dpaMode:'owned'},beauty,next,0).field,'dpaStart');
});
