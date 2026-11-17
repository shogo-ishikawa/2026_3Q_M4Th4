import test from 'node:test';
import assert from 'node:assert/strict';
import { solveItinerary, validatePlan } from '../web/planner.js';

const venue = (id, extra = {}) => ({ id, name:id, category:'attraction', node:id,
  duration:15, baseWait:0, cost:0, windows:[[540,1260]], access:'normal', ...extra });
const makePark = (activities = [venue('a'),venue('b'),venue('c')]) => {
  const ids = ['gate',...activities.map(item=>item.node),...activities.map(item=>item.endNode).filter(Boolean)];
  const nodes = [...new Set(ids)].map((id,i)=>({id,x:i*100,y:200}));
  return {id:'test',entryNode:'gate',exitNode:'gate',nodes,events:[],activities,
    edges:nodes.slice(1).map((node,i)=>({from:nodes[i].id,to:node.id,metres:100}))};
};
const settings = (extra={}) => ({ date:'2026-11-17',entry:540,exit:720,speed:50,budget:5000,
  crowdMode:'manual',weather:'sun',crowdLevel:'normal',restEvery:0,restMinutes:0,
  searchSeconds:0.2,selections:[{id:'a',weight:5},{id:'b',weight:3},{id:'c',weight:1}],...extra });
const clone = value=>structuredClone(value);

for (const searchMethod of ['beam','multistart','portfolio']) {
  test(searchMethod+': fixed rests split the day, include travel, and preserve feasible wishes',()=>{
    const p=makePark(),s=settings({searchMethod,fixedBreaks:[{id:'lunch-rest',start:580,duration:20,node:'c',label:'湖の前で休む'}]});
    const result=solveItinerary(p,s);
    assert.equal(result.status,'feasible');
    assert.equal(result.coverage.weight,9);
    const rest=result.rows.find(item=>item.fixedBreakId==='lunch-rest');
    assert.deepEqual([rest.kind,rest.start,rest.end,rest.node,rest.name],['rest',580,600,'c','湖の前で休む']);
    assert.ok(result.rows.some(item=>item.kind==='activity'&&item.end<=580));
    assert.ok(result.rows.some(item=>item.kind==='activity'&&item.start>=600));
    assert.equal(validatePlan(p,s,result).valid,true);
    assert.equal(result.diagnostics.optimal,false);
    assert.match(result.diagnostics.method,searchMethod==='beam'?/^beam/:searchMethod==='multistart'?/^multistart/:/^portfolio/);
  });
  test(searchMethod+': a show or owned DPA that overlaps a fixed rest is never silently accepted',()=>{
    const p=makePark([venue('a',{category:'show',showTimes:[580],dpa:{price:1500,wait:5,kind:'show'}})]);
    const s=settings({searchMethod,selections:[{id:'a',weight:5,required:true}],fixedBreaks:[{id:'r',start:580,duration:20,node:'gate',label:'休む'}]});
    assert.equal(solveItinerary(p,s).status,'no-plan');
    const dpa={...s,selections:[{id:'a',weight:5,dpaMode:'owned',dpaStart:575,dpaEnd:590,dpaPurchasedAt:540}]};
    assert.equal(solveItinerary(p,dpa).status,'no-plan');
  });
  test(searchMethod+': resting is possible without any selected activity',()=>{
    const p=makePark(),s=settings({searchMethod,selections:[],fixedBreaks:[{id:'r',start:600,duration:20,node:'c'}]});
    const result=solveItinerary(p,s);
    assert.equal(result.status,'feasible');
    assert.equal(result.visits.length,0);
    assert.equal(result.totals.walkingMetres,600);
    assert.equal(result.totals.restMinutes,20);
    assert.equal(validatePlan(p,s,result).valid,true);
  });
}

test('fixed rests must be reachable from one another, and exit travel remains compulsory',()=>{
  const p=makePark();
  const s=settings({selections:[],fixedBreaks:[{id:'r1',start:600,duration:20,node:'gate'},{id:'r2',start:621,duration:10,node:'c'}]});
  assert.equal(solveItinerary(p,s).status,'no-plan');
  const late=settings({exit:630,selections:[],fixedBreaks:[{id:'r',start:610,duration:20,node:'c'}]});
  assert.equal(solveItinerary(p,late).status,'no-plan');
});

test('a manual rest at opening time is feasible and rest ending at the exit gate at closing is feasible',()=>{
  const p=makePark();
  for(const reservation of [{id:'r',start:540,duration:10,node:'gate'},{id:'r',start:710,duration:10,node:'gate'}]) {
    const s=settings({selections:[],fixedBreaks:[reservation]});
    const result=solveItinerary(p,s);
    assert.equal(result.status,'feasible');
    assert.equal(validatePlan(p,s,result).valid,true);
  }
});

test('overlapping, unknown-location, duplicate and out-of-day fixed rests are rejected as inputs',()=>{
  const p=makePark(),r={id:'r',start:600,duration:20,node:'gate'};
  for(const fixedBreaks of [[r,{...r,id:'s',start:610}],[r,r],[{...r,node:'missing'}],[{...r,start:710}],[{...r,duration:0}],[{...r,duration:181}]]) {
    assert.throws(()=>solveItinerary(p,settings({fixedBreaks})),/休憩/);
  }
});

test('independent validator rejects removed, shortened, shifted and teleported rests',()=>{
  const p=makePark(),s=settings({fixedBreaks:[{id:'r',start:600,duration:20,node:'c'}]});
  const original=solveItinerary(p,s);
  for(const mutate of [
    result=>{result.rows=result.rows.filter(item=>!item.fixedBreakId);},
    result=>{result.rows.find(item=>item.fixedBreakId).end--;},
    result=>{result.rows.find(item=>item.fixedBreakId).start++;},
    result=>{result.rows.find(item=>item.fixedBreakId).node='gate';},
    result=>{result.rows=result.rows.filter(item=>!(item.kind==='walk'&&item.to==='c'));},
  ]) {
    const result=clone(original); mutate(result);
    assert.equal(validatePlan(p,s,result).valid,false);
  }
});

test('a started fixed rest is kept to its full end while future activities are replanned',()=>{
  const p=makePark(),fixedBreaks=[{id:'r',start:580,duration:30,node:'b',label:'午後の休憩'}];
  const first=solveItinerary(p,settings({selections:[],fixedBreaks}));
  const s=settings({fixedBreaks,replanFrom:590,selections:[{id:'a',weight:5}]});
  const result=solveItinerary(p,s,{initialPlan:first});
  const rest=result.rows.find(item=>item.fixedBreakId==='r');
  assert.equal(rest.preserved,true);assert.equal(rest.end,610);
  assert.ok(result.visits[0].start>=610);
  assert.equal(validatePlan(p,s,result).valid,true);
  assert.throws(()=>solveItinerary(p,{...s,fixedBreaks:[{...fixedBreaks[0],duration:40}]},{initialPlan:first}),/開始済み/);
});

test('a new rest cannot overlap an already-started preserved activity',()=>{
  const p=makePark([venue('a',{baseWait:30}),venue('b')]);
  const first=solveItinerary(p,settings({selections:[{id:'a',weight:5}]}));
  const queue=first.rows.find(item=>item.kind==='queue');
  const s=settings({selections:[{id:'b',weight:3}],replanFrom:queue.start+5,
    fixedBreaks:[{id:'r',start:queue.start+10,duration:20,node:'a'}]});
  assert.throws(()=>solveItinerary(p,s,{initialPlan:first}),/進行中/);
});

test('completed fixed rests need not be reconstructed when replanning from the current location',()=>{
  const p=makePark(),s=settings({replanFrom:630,currentNode:'b',fixedBreaks:[{id:'r',start:580,duration:20,node:'c'}]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.equal(result.rows.some(item=>item.fixedBreakId==='r'),false);
  assert.equal(validatePlan(p,s,result).valid,true);
});

test('search method and time range reject invalid settings while supporting a 120-second upper bound',()=>{
  const p=makePark(),s=settings({searchSeconds:120,selections:[]});
  const started=performance.now(),result=solveItinerary(p,s,{deadlineMs:15});
  assert.equal(result.status,'feasible');
  assert.ok(performance.now()-started<500);
  assert.throws(()=>solveItinerary(p,{...s,searchSeconds:121}),/探索時間/);
  assert.throws(()=>solveItinerary(p,{...s,searchMethod:'unknown'}),/探索手法/);
});

test('the beam method agrees with a separate exhaustive oracle including a fixed rest',()=>{
  for(let instance=0;instance<12;instance++) {
    const activities=['a','b','c','d'].map((id,i)=>venue(id,{duration:8+(instance*7+i*11)%23,cost:(i%3)*300}));
    const p=makePark(activities),s=settings({exit:645+instance,budget:1200,
      selections:activities.map((item,i)=>({id:item.id,weight:1+(i+instance)%5})),
      fixedBreaks:[{id:'r',start:590,duration:15,node:instance%2?'c':'gate'}]});
    const restPosition=instance%2?3:0;
    let best=0;
    // Coordinates 0..4 are 100m apart, giving 2 minutes per edge.
    function enumerate(position,remaining,time,cost,score,rested) {
      if(rested&&time+position*2<=s.exit)best=Math.max(best,score);
      if(!rested&&time+Math.abs(position-restPosition)*2<=590)enumerate(restPosition,remaining,605,cost,score,true);
      for(const i of remaining) {
        const end=time+Math.abs(position-(i+1))*2+activities[i].duration,money=cost+activities[i].cost;
        if(money>s.budget||end+(i+1)*2>s.exit)continue;
        if(!rested&&end+Math.abs(i+1-restPosition)*2>590)continue;
        enumerate(i+1,remaining.filter(j=>j!==i),end,money,score+s.selections[i].weight,rested);
      }
    }
    enumerate(0,[0,1,2,3],540,0,0,false);
    const result=solveItinerary(p,s);
    assert.equal(result.totals.score,best,'instance '+instance);
  }
});
