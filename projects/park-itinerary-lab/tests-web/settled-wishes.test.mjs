import assert from 'node:assert/strict';
import test from 'node:test';
import {settledReplanWishes, solveItinerary, validatePlan} from '../web/planner.js';
import {wishInputProblem} from '../web/app.js';

const park = {id:'land', entryNode:'gate', exitNode:'gate', nodes:[{id:'gate', x:200, y:200}], edges:[],
  activities:['early','later'].map((id,i)=>({id, name:id, category:'attraction', node:'gate', duration:10, baseWait:0,
    windows:[[540+i*120,650+i*120]]}))};
const date = '2026-11-19';
const settings = {date, entry:540, exit:800, speed:70, budget:5000, restEvery:0, crowdMode:'manual',
  selections:park.activities.map(a=>({id:a.id, weight:4, required:true, manualWait:20}))};

test('changed operating information only applies to wishes not yet started in the same-day plan', () => {
  const original = solveItinerary(park,settings);
  const changed = structuredClone(park);
  changed.activities[0].closedDates = [date];
  for (const cutoff of [550,600]) {
    const later = {...settings,replanFrom:cutoff};
    const settled = settledReplanWishes(changed,later,original);
    assert.deepEqual([...settled], ['early']); // In the queue, then after completing the attraction.
    assert.ok(wishInputProblem(settings.selections[0],changed.activities[0],date));
    const plan = solveItinerary(changed,later,{initialPlan:original});
    assert.equal(plan.status,'feasible');
    assert.equal(plan.visits.length,2);
    assert.deepEqual(validatePlan(changed,later,plan,{initialPlan:original}).errors,[]);
  }
  assert.deepEqual([...settledReplanWishes(park,settings,original)], []);
  assert.deepEqual([...settledReplanWishes(park,{...settings,replanFrom:540},original)], []);
});

test('past wishes require explicit completion or matching dated rows; a walk or a failed proposal is insufficient', () => {
  const later = {...settings,replanFrom:620,completedIds:['reported']};
  const source = {parkId:park.id,settings:{date},status:'feasible',rows:[
    {type:'queue',activityId:'legacy',start:600,end:630}, {type:'activity',activityId:'legacy',start:630,end:640},
    {kind:'walk',activityId:'later',start:610,end:640}, {kind:'activity',activityId:'later',start:640,end:650}
  ]};
  assert.deepEqual([...settledReplanWishes(park,later,source)], ['reported','legacy']);
  for (const other of [{...source,settings:{}}, {...source,parkId:'sea'}, {...source,settings:{date:'2026-11-18'}},
                       {...source,status:'no-plan'}]) {
    assert.deepEqual([...settledReplanWishes(park,later,other)], ['reported']);
  }
  const carried = {...source,status:'no-plan',rows:source.rows.map(row=>({...row,preserved:row.activityId==='legacy'}))};
  assert.deepEqual([...settledReplanWishes(park,later,carried)], ['reported','legacy']);
});
