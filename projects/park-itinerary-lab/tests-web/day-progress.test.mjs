import assert from 'node:assert/strict';
import test from 'node:test';
import {solveItinerary, validatePlan} from '../web/planner.js';

const date='2026-11-19';
const park={id:'land',entryNode:'gate',exitNode:'gate',nodes:['gate','ride','out'].map(id=>({id})),
  edges:[{from:'gate',to:'ride',metres:70},{from:'ride',to:'out',metres:70}],
  activities:['a','b','c'].map((id,i)=>({id,name:id,category:'attraction',node:i?'gate':'ride',
    ...(i?{}:{endNode:'out'}),duration:10,baseWait:0,windows:[[540,780]]}))};
const base={date,entry:540,exit:780,speed:70,budget:10000,crowdMode:'manual',selections:[],searchSeconds:.1};
const wish=(id,more={})=>({id,weight:3,required:true,...more});
const progress=(visits,extra={})=>({...base,replanFrom:610,dayProgress:{date,parkId:park.id,visits},...extra});

test('queue declared off the original route uses remaining wait, full ride and the exit node, on repeated replans',()=>{
  const settings=progress({a:{status:'queue',startedAt:600,endsAt:635}},{currentNode:'gate',selections:[wish('b')]});
  for(const cutoff of [610,615]) {
    const day={...settings,replanFrom:cutoff};
    const result=solveItinerary(park,day);
    const queue=result.rows.find(r=>r.kind==='queue'), ride=result.rows.find(r=>r.activityId==='a'&&r.kind==='activity');
    assert.deepEqual([queue.start,queue.end,ride.start,ride.end,ride.endNode],[600,625,625,635,'out']);
    assert.ok(result.rows.some(r=>r.kind==='walk'&&r.start===635&&r.from==='out'));
    assert.deepEqual(validatePlan(park,day,result).errors,[]);
  }
  assert.throws(()=>solveItinerary(park,{...settings,replanFrom:636}),/終了見込み/);
});

test('explicit pending restores a missed morning wish, skipped waives a required wish and done excludes an early actual visit',()=>{
  const planDay={...base,selections:[wish('a'),wish('b',{earliest:660}),wish('c',{earliest:670})]};
  const first=solveItinerary(park,planDay);
  const settings=progress({a:{status:'pending'},b:{status:'done',endsAt:600},c:{status:'skipped'}},{selections:planDay.selections});
  const result=solveItinerary(park,settings,{initialPlan:first});
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.rows.filter(r=>r.kind==='activity').map(r=>[r.activityId,!!r.preserved]),[['b',true],['a',false]]);
  assert.equal(result.rows.find(r=>r.activityId==='a'&&r.kind==='activity').start>=610,true);
  assert.deepEqual(validatePlan(park,settings,result,{initialPlan:first}).errors,[]);
});

test('an explicit ongoing visit supersedes a different inferred queue; switching parks prevents carrying that progress',()=>{
  const old={...base,selections:[wish('b',{manualWait:85})]};
  const first=solveItinerary(park,old);
  const settings=progress({a:{status:'riding',startedAt:607,endsAt:618}},{selections:old.selections});
  const result=solveItinerary(park,settings,{initialPlan:first});
  assert.equal(result.rows.filter(r=>r.activityId==='b'&&r.preserved).length,0);
  assert.ok(result.rows.some(r=>r.activityId==='b'&&!r.preserved&&r.start>=618));
  assert.ok(!solveItinerary(park,{...settings,dayProgress:{...settings.dayProgress,parkId:'sea'}}).visits.some(v=>v.id==='a'));
});

test('a done first ride and a queue for its requested repeat leave no third ride',()=>{
  const settings=progress({a:{status:'done',endsAt:590},'a~2':{status:'queue',startedAt:602,endsAt:645}},
    {selections:[wish('a',{repeatCount:2}),wish('c')]});
  const result=solveItinerary(park,settings);
  assert.deepEqual(result.rows.filter(r=>r.kind==='activity').map(r=>r.activityId),['a','a~2','c']);
  assert.deepEqual(validatePlan(park,settings,result).errors,[]);
});

test('validation rejects missing historical rows, repeated confirmed rides and new rows dated before replanning',()=>{
  const old={...base,selections:[wish('a')]};
  const first=solveItinerary(park,old);
  const settings={...old,replanFrom:610,completedIds:['a']};
  const result=solveItinerary(park,settings,{initialPlan:first});
  const past=result.rows.find(r=>r.activityId==='a'&&r.kind==='activity');
  const missing=structuredClone(result);missing.rows=missing.rows.filter(r=>r.kind!=='activity');
  assert.equal(validatePlan(park,settings,missing,{initialPlan:first}).valid,false);
  const duplicate=structuredClone(result);duplicate.rows.splice(-1,0,{...past,preserved:false,start:610,end:620});
  assert.ok(validatePlan(park,settings,duplicate,{initialPlan:first}).errors.some(e=>e.includes('重複')));
  const early=structuredClone(result);early.rows.splice(-1,0,{kind:'wait',start:608,end:609,node:'gate'});
  assert.ok(validatePlan(park,settings,early,{initialPlan:first}).errors.some(e=>e.includes('時刻より前')));
});

test('a first ride marked complete without a time supports an ongoing repeat without inventing a time for the first',()=>{
  const settings=progress({a:{status:'done'},'a~2':{status:'queue',startedAt:598,endsAt:620}},{selections:[wish('a',{repeatCount:2})]});
  const result=solveItinerary(park,settings);
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.rows.filter(r=>r.kind==='activity').map(r=>r.activityId),['a~2']);
  assert.deepEqual(validatePlan(park,settings,result).errors,[]);
});

test('undoing the last manual completion in a restored replan returns a future wish to the schedule',()=>{
  const settings=progress({a:{status:'done',endsAt:595}},{selections:[wish('a',{earliest:680})]});
  const first=solveItinerary(park,settings);
  const restored=JSON.parse(JSON.stringify(first));
  const changed={...settings,replanFrom:620,dayProgress:{...settings.dayProgress,visits:{}}};
  const next=solveItinerary(park,changed,{initialPlan:restored});
  assert.equal(next.status,'feasible');
  const visits=next.rows.filter(r=>r.activityId==='a' && r.kind==='activity');
  assert.equal(visits.length,1);assert.equal(!!visits[0].preserved,false);
  assert.ok(visits[0].start>=680);
});

test('reporting the first ride late moves an already elapsed inferred second queue after it',()=>{
  const old={...base,selections:[wish('a',{repeatCount:2})]}, first=solveItinerary(park,old);
  const formerSecond=first.rows.find(r=>r.activityId==='a~2'&&r.kind==='activity');
  assert.ok(formerSecond.end<610);
  for (const record of [{status:'queue',startedAt:605,endsAt:645},{status:'done',endsAt:600},{status:'pending'}]) {
    const settings=progress({a:record},{selections:old.selections});
    const next=solveItinerary(park,settings,{initialPlan:first});
    const rides=next.rows.filter(r=>r.kind==='activity');
    assert.deepEqual(rides.map(r=>r.activityId),['a','a~2']);
    assert.ok(!rides[1].preserved && rides[1].start>=Math.max(610,rides[0].end));
  }
});

test('an explicitly contradictory first and second visit must be corrected',()=>{
  for(const first of [{status:'pending'},{status:'riding',startedAt:609,endsAt:630},{status:'done',endsAt:604}]){
    const settings=progress({a:first,'a~2':{status:'done',endsAt:600}},{selections:[wish('a',{repeatCount:2})]});
    assert.throws(()=>solveItinerary(park,settings),/2回目/);
  }
});

test('one physical DPA receipt pays for a later second ride; the validator refuses a second admission on that receipt',()=>{
  const paidPark={...park,activities:park.activities.map(a=>a.id==='a'?{...a,baseWait:2,dpa:{kind:'attraction',price:1500,wait:1}}:a)};
  const settings={...base,selections:[wish('a',{repeatCount:2,dpaMode:'owned',dpaVisit:2,dpaStart:550,dpaEnd:620,dpaPurchasedAt:540})]};
  const first=solveItinerary(paidPark,settings);
  assert.equal(first.status,'feasible');
  assert.deepEqual(first.visits.map(v=>[v.id,v.method]),[['a','normal'],['a~2','dpa']]);
  assert.deepEqual(first.purchases.map(p=>[p.id,p.cost]),[['a',1500]]);
  assert.equal(first.totals.cost,1500);
  const restored=JSON.parse(JSON.stringify(first));
  const revised=solveItinerary(paidPark,{...restored.settings,replanFrom:first.visits[0].end},{initialPlan:restored});
  assert.deepEqual(revised.visits.map(v=>v.method),['normal','dpa']);
  assert.deepEqual(validatePlan(paidPark,settings,first).errors,[]);
  const overlap=structuredClone(first);
  // Both admissions lie in this longer ticket window. Turning the historical
  // standby visit into a second DPA admission must never validate.
  overlap.purchases[0].start=540;
  for (const row of overlap.rows.filter(r=>r.activityId==='a')) row.dpa=true;
  assert.ok(validatePlan(paidPark,settings,overlap).errors.some(e=>e.includes('複数の体験')));
});

test('an expired owned DPA assigned to the second occurrence is reported and its fee is retained once',()=>{
  const paidPark={...park,activities:park.activities.map(a=>a.id==='a'?{...a,dpa:{kind:'attraction',price:1500,wait:2}}:a)};
  const settings=progress({a:{status:'done',endsAt:565}},{selections:[wish('a',{
    repeatCount:2,dpaMode:'owned',dpaVisit:2,dpaStart:575,dpaEnd:600,dpaPurchasedAt:540,
  })]});
  const result=solveItinerary(paidPark,settings);
  assert.equal(result.status,'no-plan');
  assert.match(result.omissions.find(o=>o.id==='a~2').reason,/受付終了/);
  assert.ok(result.diagnostics.notes.some(s=>s.includes('10:00で受付終了')));
  assert.deepEqual(result.purchases.map(p=>p.id),['a']);
  assert.equal(result.totals.cost,1500);
});

test('confirming a DPA completion beyond its admission window keeps the original scan and fee',()=>{
  const p={...park,activities:[{...park.activities[1],dpa:{kind:'attraction',price:2000,wait:2}}]};
  const firstWish=wish('b',{repeatCount:2, required:false, manualWait:90, dpaMode:'consider',dpaAvailableWindows:[[560,566]]});
  const day={...base,exit:620,selections:[firstWish]};
  const first=solveItinerary(p,day), end=first.visits[0].end;
  const owned={...firstWish,dpaMode:'owned',dpaPurchasedAt:540,dpaStart:560,dpaEnd:566};
  const settings={...day,replanFrom:585,selections:[owned],dayProgress:{date,parkId:park.id,visits:{b:{status:'done',endsAt:end}}}};
  let source=first;
  for(const cutoff of [585,590]) {
    const updated={...settings,replanFrom:cutoff};
    const result=solveItinerary(p,updated,{initialPlan:source});
    const completed=result.rows.find(r=>r.kind==='activity'&&r.activityId==='b');
    assert.equal(result.status,'feasible');assert.equal(completed.dpaAdmission,560);
    assert.equal(result.totals.cost,2000);
    assert.deepEqual(validatePlan(p,updated,result,{initialPlan:source}).errors,[]);
    assert.ok(!result.diagnostics.notes.some(note=>note.includes('この枠の利用記録はなく')));
    source=JSON.parse(JSON.stringify(result));
  }
});
