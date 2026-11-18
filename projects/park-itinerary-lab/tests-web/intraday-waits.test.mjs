import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjustedIntradayMinutes, deriveIntradayAdjustment, summariseIntradayResiduals,
} from '../web/intraday-waits.js';
import {estimateWait, setWaitForecastContext, solveItinerary, validatePlan} from '../web/planner.js';

const now = Date.parse('2026-11-19T02:00:00Z'); // 11:00 in Tokyo
const stamp = minutesAgo => new Date(now - minutesAgo * 60000).toISOString();
const activities = ['a','b','c','d'].map(id => ({id:'land-'+id, category:'attraction', baseWait:40}));
const park = {id:'land', activities};
const model = {
  schemaVersion:1, method:'ridge-regression', parkId:'land', status:'trained', usable:true,
  lastDate:'2026-11-18', days:7, samples:120, activityIds:activities.map(a=>a.id),
  coefficients:[1,0,0,0,0,0,0,0,0,0,0],
  validation:{method:'later-days-holdout', trainThrough:'2026-11-16', testFrom:'2026-11-17',
    testThrough:'2026-11-18', testSamples:20, modelMae:3, baselineMae:10},
};
const rows = activities.map((activity,i) => ({
  activityId:activity.id, providerId:i, updatedAt:stamp(5), isOpen:true, wait:i === 3 ? 590 : 60,
}));
function settings(overrides = {}) {
  return {date:'2026-11-19', replanFrom:660, waitAsOf:now, waitModel:model, liveMode:'auto',
    liveData:{schemaVersion:1, parkId:'land', provider:'queue-times', fetchedAt:stamp(1), rides:rows},
    ...overrides};
}

test('same-day replan uses posted waits up to one hour, a fading adjustment up to three hours, then the original model', () => {
  const s = settings();
  setWaitForecastContext(park,s);
  assert.equal(estimateWait(activities[0],720,s).minutes,60);
  assert.equal(estimateWait(activities[0],720,s).source,'live');
  assert.equal(estimateWait(activities[0],721,s).minutes,50);
  assert.equal(estimateWait(activities[0],780,s).minutes,45);
  assert.equal(estimateWait(activities[0],780,s).source,'intraday');
  assert.equal(estimateWait(activities[0],840,s).minutes,40);
  assert.equal(estimateWait(activities[0],840,s).source,'ml');
  // Daily forecast code calls this same entry point with liveMode off and no replan.
  const baseline = settings({liveMode:'off', replanFrom:undefined});
  setWaitForecastContext(park,baseline);
  assert.equal(estimateWait(activities[0],780,baseline).minutes,40);
  assert.equal(estimateWait(activities[0],780,baseline).source,'ml');
  assert.deepEqual(model.coefficients,[1,0,0,0,0,0,0,0,0,0,0]);
});

test('only distinct, recently observed, open attractions in the same park contribute', () => {
  const s = settings();
  assert.deepEqual(deriveIntradayAdjustment(park,s), {asOfMinute:660,rides:4,agreeing:4,medianDifference:20,offset:10});
  const invalid = [
    {...rows[2], isOpen:false}, {...rows[2], wait:null}, {...rows[2], updatedAt:stamp(16)},
    {...rows[2], updatedAt:stamp(-1)}, rows[0],
  ];
  for (const ride of invalid) {
    const liveData = {...s.liveData, rides:[...rows.slice(0,2),ride]};
    assert.equal(deriveIntradayAdjustment(park,settings({liveData})),null);
  }
  for (const patch of [
    {liveData:{...s.liveData,parkId:'sea'}}, {liveData:{...s.liveData,fetchedAt:stamp(16)}},
    {date:'2026-11-20'}, {liveMode:'off'}, {crowdMode:'manual'}, {replanFrom:undefined},
    {waitModel:null}, {waitModel:{...model,lastDate:'2026-11-19'}},
  ]) assert.equal(deriveIntradayAdjustment(park,settings(patch)),null);
});

test('require a shared direction, shrink the median and bound any future change', () => {
  const samples = waits=>waits.map((observed,i)=>({activityId:String(i+1),observed,expected:50}));
  assert.equal(summariseIntradayResiduals(samples([95,95,5,5]),660),null);
  assert.equal(summariseIntradayResiduals(samples([53,53,53]),660),null);
  const empty = summariseIntradayResiduals(samples([0,0,0,600]),660);
  assert.equal(empty.offset,-15);
  assert.equal(adjustedIntradayMinutes(10,721,empty),7);
  assert.equal(adjustedIntradayMinutes(0,721,empty),0);
  const busy = summariseIntradayResiduals(samples([150,150,130,40]),660);
  assert.equal(busy.offset,15);
  assert.equal(adjustedIntradayMinutes(10,721,busy),13);
  assert.equal(adjustedIntradayMinutes(100,721,busy),115);
});

test('the solver and the independent schedule check agree on the adjusted queue duration', () => {
  const dayPark = {...park, entryNode:'gate', exitNode:'gate', nodes:[{id:'gate',x:20,y:20}], edges:[],
    activities:activities.map(a=>({...a,name:a.id, duration:10, node:'gate', cost:0, windows:[[540,1260]]}))};
  const s = settings({entry:540, exit:1000, speed:60, budget:0, restEvery:0,
    selections:[{id:activities[0].id, weight:5, required:true, earliest:780}]});
  const originalClock = Date.now;
  Date.now = () => now;
  try {
    const result = solveItinerary(dayPark,s,{deadlineMs:100});
    assert.equal(result.status,'feasible');
    const queue = result.rows.find(row=>row.kind==='queue');
    assert.equal(queue.waitSource,'intraday');
    assert.equal(queue.estimatedMinutes,45);
    assert.ok(result.diagnostics.notes.some(note=>note.includes('4施設の掲示')));
    assert.deepEqual(validatePlan(dayPark,s,result).errors,[]);
  } finally {Date.now = originalClock;}
});
