import test from 'node:test';
import assert from 'node:assert/strict';
import {solveItinerary,validatePlan} from '../web/planner.js';
import {buildPlanJson,parsePlanJson} from '../web/storage.js';

const venue='land-venue';
const show={id:'land-performance',name:'劇場',node:venue,category:'show',duration:20,
  baseWait:10,cost:0,access:'entry',windows:[[540,1260]],showTimes:[900,1020],
  dpa:{kind:'show',wait:10,price:2000}};
const park={id:'land',entryNode:venue,exitNode:venue,nodes:[{id:venue}],edges:[],activities:[show]};
const base={date:'2026-11-19',entry:540,exit:1200,budget:12000,speed:70,crowdMode:'manual',searchSeconds:1};
const wish={id:show.id,weight:5,required:true,showTimes:[1020,900],confirmSchedule:true};

for (const mode of ['owned','consider']) {
  test(mode+' admission ends before the curtain: enter, wait inside, see the booked performance',()=>{
    const selection={...wish,dpaMode:mode,...(mode==='owned'
      ?{dpaStart:840,dpaEnd:870,dpaPurchasedAt:550}
      :{dpaAvailableWindows:[[840,870]]})};
    const settings={...base,selections:[selection]};
    const plan=solveItinerary(park,settings);
    assert.equal(plan.status,'feasible');
    const queue=plan.rows.find(r=>r.kind==='queue'),seated=plan.rows.find(r=>r.awaitingPerformance);
    assert.ok(queue.start>=840 && queue.start<870);
    assert.equal(queue.end-queue.start,10);
    assert.equal(seated.start,queue.end);
    assert.equal(seated.end,900);
    assert.equal(plan.visits[0].start,900);
    assert.equal(plan.visits[0].method,'dpa');
    assert.equal(validatePlan(park,settings,plan).valid,true);
    const moved=structuredClone(plan);
    moved.rows.find(r=>r.kind==='activity').start=1020;
    moved.rows.find(r=>r.kind==='activity').end=1040;
    moved.rows.find(r=>r.awaitingPerformance).end=1020;
    moved.rows.find(r=>r.kind==='exit').start=1040;
    moved.rows.find(r=>r.kind==='exit').end=1040;
    assert.match(validatePlan(park,settings,moved).errors.join(' '),/公演回/);
    // Missing the original performance (or its deadline) must not shift the ticket to 17:00.
    assert.equal(solveItinerary(park,{...settings,selections:[{...selection,earliest:870}]}).status,'no-plan');
  });
}

test('a queue or in-venue wait already in progress keeps the complete show through a saved replan',()=>{
  const settings={...base,selections:[{...wish,dpaMode:'owned',dpaStart:840,dpaEnd:870,dpaPurchasedAt:550}]};
  const plan=solveItinerary(park,settings);
  const restored=parsePlanJson(buildPlanJson({parkId:park.id,settings,result:plan})).result;
  for(const cutoff of [845,875]){
    const changed={...settings,replanFrom:cutoff};
    const result=solveItinerary(park,changed,{initialPlan:restored});
    assert.equal(result.status,'feasible');
    assert.equal(result.rows.find(row=>row.kind==='activity').preserved,true);
    const wait=result.rows.find(row=>row.awaitingPerformance);
    assert.equal(wait.preserved,true);
    assert.equal(wait.end,900);
    assert.equal(validatePlan(park,changed,result,{initialPlan:restored}).valid,true);
  }
});

test('zero-minute admission records the validation time and a late arrival cannot enter the area',()=>{
  const venuePark={...park,activities:[{...show,category:'parade',dpa:{...show.dpa,wait:0}}]};
  const selection={...wish,nodeOverride:venue,dpaMode:'consider',dpaAvailableWindows:[[840,870]]};
  const settings={...base,selections:[{...selection,earliest:869}]};
  const accepted=solveItinerary(venuePark,settings);
  assert.equal(accepted.status,'feasible');
  const queue=accepted.rows.find(row=>row.kind==='queue');
  assert.deepEqual([queue.start,queue.end],[869,869]);
  assert.equal(accepted.rows.find(row=>row.awaitingPerformance).start,869);
  assert.equal(solveItinerary(venuePark,{...settings,selections:[{...selection,earliest:870}]}).status,'no-plan');
});
