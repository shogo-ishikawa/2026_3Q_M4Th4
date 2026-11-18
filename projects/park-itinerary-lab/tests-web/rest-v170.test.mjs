import test from 'node:test';
import assert from 'node:assert/strict';
import {restsBesideFood,solveItinerary,validatePlan} from '../web/planner.js';

const venue=(id,extra={})=>({id,name:id,node:'gate',category:'attraction',duration:15,baseWait:0,cost:0,access:'normal',windows:[[540,900]],...extra});
const park=activities=>({id:'land',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate',x:0,y:0}],edges:[],events:[],activities});
const settings=extra=>({date:'2026-11-18',entry:540,exit:900,speed:70,budget:5000,crowdMode:'manual',weather:'sun',crowdLevel:'normal',restEvery:90,restMinutes:10,searchSeconds:.15,...extra});
const choose=(id,earliest,latest,extra={})=>({id,weight:3,required:true,earliest,latest,...extra});
const autoRests=plan=>plan.rows.filter(row=>row.kind==='rest'&&row.autoBreakId);

for(const searchMethod of ['beam','multistart','portfolio']) {
  test(`${searchMethod}: a long attraction queue is followed by recovery before the next visit`,()=>{
    const p=park([venue('long',{baseWait:45}),venue('next',{duration:20})]);
    const s=settings({searchMethod,selections:[choose('long',540,600),choose('next',600,650)]});
    const result=solveItinerary(p,s),rest=autoRests(result)[0];
    assert.equal(result.status,'feasible');
    assert.deepEqual([rest?.start,rest?.end],[600,610]);
    assert.equal(result.visits[1].start,610);
    assert.equal(validatePlan(p,s,result).valid,true);
  });
}

test('meals replace a due rest and no automatic rest appears immediately around dining',()=>{
  const p=park([venue('long',{baseWait:75}),venue('meal',{category:'restaurant',duration:45}),venue('after',{duration:20})]);
  const s=settings({selections:[choose('long',540,630),choose('meal',630,675),choose('after',675,695)]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.visits.map(v=>[v.id,v.start,v.end]),[['long',615,630],['meal',630,675],['after',675,695]]);
  assert.equal(autoRests(result).length,0);
  assert.equal(validatePlan(p,s,result).valid,true);
});

test('short snacks also suppress adjacent automatic breaks without extending the recovery interval',()=>{
  const p=park([venue('long',{baseWait:75}),venue('snack',{category:'snack',duration:5}),venue('after',{duration:10})]);
  const s=settings({selections:[choose('long',540,630),choose('snack',630,635),choose('after',635,645)]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.equal(autoRests(result).length,0);
});

test('a nearby requested meal suppresses recovery even when a short shop visit comes first',()=>{
  const p=park([venue('long',{baseWait:75}),venue('shop',{category:'shop',duration:5}),venue('meal',{category:'restaurant',duration:30})]);
  const s=settings({selections:[choose('long',540,630),choose('shop',630,650),choose('meal',650,680)]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.visits.map(v=>v.id),['long','shop','meal']);
  assert.equal(autoRests(result).length,0);
});

test('an early recovery rest yields to an imminent fixed show or an owned DPA window',()=>{
  for(const kind of ['show','dpa']) {
    const next=kind==='show'?venue('reserved',{category:'show',showTimes:[605],baseWait:5,duration:10}):venue('reserved',{dpa:{price:1000,wait:5,kind:'attraction'},duration:10});
    const p=park([venue('long',{baseWait:45}),next]);
    const selection=kind==='show'?choose('reserved',600,615):choose('reserved',600,615,{dpaMode:'owned',dpaStart:600,dpaEnd:605,dpaPurchasedAt:540});
    const s=settings({selections:[choose('long',540,600),selection]});
    const result=solveItinerary(p,s);
    assert.equal(result.status,'feasible',kind);
    assert.equal(result.visits[1].start,605,kind);
    assert.ok(autoRests(result).every(rest => rest.start >= result.visits[1].end),kind);
    assert.equal(validatePlan(p,s,result).valid,true,kind);
  }
});

test('recovery also yields when the confirmed show follows an intervening required visit',()=>{
  const p=park([venue('long',{baseWait:45}),venue('next',{duration:10}),venue('show',{category:'show',showTimes:[620],baseWait:5,duration:10})]);
  const s=settings({selections:[choose('long',540,600),choose('next',600,620),choose('show',600,630)]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.visits.map(v=>[v.id,v.start]),[['long',585],['next',600],['show',620]]);
  assert.ok(autoRests(result).every(rest => rest.start >= 630));
  assert.equal(validatePlan(p,s,result).valid,true);
});

test('a later required time window also takes precedence over automatic recovery',()=>{
  const p=park([venue('long',{baseWait:45}),venue('next',{duration:10}),venue('last',{duration:20})]);
  const s=settings({selections:[choose('long',540,600),choose('next',600,620),choose('last',610,630)]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.visits.map(v=>[v.id,v.start]),[['long',585],['next',600],['last',610]]);
  assert.ok(autoRests(result).every(rest => rest.start >= 630));
  assert.equal(validatePlan(p,s,result).valid,true);
});

test('manual rests are kept even next to food and satisfy recovery after a long queue',()=>{
  const p=park([venue('long',{baseWait:45}),venue('meal',{category:'cafe',duration:30})]);
  const s=settings({selections:[choose('long',540,600),choose('meal',610,640)],fixedBreaks:[{id:'chosen',node:'gate',start:600,duration:10,label:'自分で決めた休憩'}]});
  const result=solveItinerary(p,s),rest=result.rows.find(r=>r.fixedBreakId==='chosen');
  assert.equal(result.status,'feasible');
  assert.deepEqual([rest.start,rest.end,rest.name],[600,610,'自分で決めた休憩']);
  assert.equal(autoRests(result).length,0);
  assert.equal(validatePlan(p,s,result).valid,true);
});

test('a preserved in-progress queue and ride still receive recovery after their unchanged end',()=>{
  const p=park([venue('long',{baseWait:45}),venue('next',{duration:20})]);
  const firstSettings=settings({restEvery:0,selections:[choose('long',540,600),choose('next',600,650)]});
  const first=solveItinerary(p,firstSettings),s=settings({...firstSettings,restEvery:90,replanFrom:550});
  const result=solveItinerary(p,s,{initialPlan:first});
  assert.equal(result.status,'feasible');
  for(const original of first.rows.filter(r=>r.activityId==='long')) {
    const preserved=result.rows.find(r=>r.kind===original.kind&&r.activityId==='long');
    assert.equal(preserved.start,original.start);assert.equal(preserved.end,original.end);assert.equal(preserved.preserved,true);
  }
  assert.equal(autoRests(result)[0]?.start,600);
  assert.equal(validatePlan(p,s,result).valid,true);
});

test('removed auto rests and disabled auto mode stay disabled',()=>{
  const p=park([venue('long',{baseWait:45}),venue('next',{duration:20})]);
  const s=settings({selections:[choose('long',540,600),choose('next',600,650)]});
  const first=solveItinerary(p,s),rest=autoRests(first)[0];assert.ok(rest);
  const removed=solveItinerary(p,{...s,excludedAutoBreaks:[rest.autoBreakId]});
  assert.equal(autoRests(removed).length,0);
  assert.equal(autoRests(solveItinerary(p,{...s,restEvery:0})).length,0);
});

test('selected wish scores take precedence over the soft recovery preference',()=>{
  const p=park([venue('long',{baseWait:45}),venue('optional',{duration:20})]);
  const s=settings({exit:620,selections:[choose('long',540,600),choose('optional',600,620,{required:false,weight:5})]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.deepEqual(result.visits.map(v=>v.id),['long','optional']);
  assert.equal(result.coverage.weight,8);
  assert.equal(autoRests(result).length,0);
  assert.equal(validatePlan(p,s,result).valid,true);
});

for(const searchMethod of ['beam','multistart','portfolio']) {
  test(`${searchMethod}: defer recovery through a critical chain, then resume immediately after its show`,()=>{
    const p=park([venue('long',{baseWait:45}),venue('a',{duration:10}),venue('b',{duration:10}),venue('c',{duration:10}),venue('show',{category:'show',showTimes:[635],baseWait:5,duration:10}),venue('after',{duration:10})]);
    const s=settings({searchMethod,selections:[choose('long',540,600),choose('a',600,620),choose('b',610,630),choose('c',620,640),choose('show',600,645),choose('after',645,680)]});
    const result=solveItinerary(p,s);
    assert.equal(result.status,'feasible');
    assert.deepEqual(result.visits.map(v=>[v.id,v.start]),[['long',585],['a',600],['b',610],['c',620],['show',635],['after',655]]);
    assert.deepEqual(autoRests(result).map(r=>[r.start,r.end]),[[645,655]]);
    assert.equal(validatePlan(p,s,result).valid,true);
  });

  test(`${searchMethod}: recovery can resume before exit when the show is the last visit`,()=>{
    const p=park([venue('long',{baseWait:45}),venue('a',{duration:10}),venue('b',{duration:10}),venue('c',{duration:10}),venue('show',{category:'show',showTimes:[635],baseWait:5,duration:10})]);
    const s=settings({searchMethod,selections:[choose('long',540,600),choose('a',600,620),choose('b',610,630),choose('c',620,640),choose('show',600,645)]});
    const result=solveItinerary(p,s);
    assert.equal(result.status,'feasible');
    assert.deepEqual(autoRests(result).map(r=>[r.start,r.end]),[[645,655]]);
    assert.equal(validatePlan(p,s,result).valid,true);
    const tight = {...s,exit:645}, noRoom = solveItinerary(p,tight);
    assert.equal(noRoom.status,'feasible');
    assert.equal(noRoom.totals.finish,645);
    assert.equal(autoRests(noRoom).length,0);
    assert.equal(validatePlan(p,tight,noRoom).valid,true);
  });
}

function parkWithWalk(activities) {
  const p=park(activities);
  p.nodes.push({id:'garden',x:10,y:0});
  p.edges.push({from:'gate',to:'garden',metres:4500});
  return p;
}

for(const searchMethod of ['beam','multistart','portfolio']) {
  test(`${searchMethod}: the last food stop suppresses recovery across a long preserved walk and wait`,()=>{
    for(const category of ['restaurant','cafe','snack','popcorn']){
      const p=parkWithWalk([venue('food',{category,duration:10}),venue('ride',{node:'garden',baseWait:15})]);
      const s=settings({searchMethod,restEvery:0,walkCrowdMode:'off',speed:75,
        selections:[choose('food',540,550,{required:false}),choose('ride',690,800)]});
      const first=solveItinerary(p,s);
      assert.equal(first.coverage.count,2);
      const day={...s,restEvery:60,replanFrom:645};
      const revised=solveItinerary(p,day,{initialPlan:first});
      assert.equal(revised.status,'feasible');
      assert.deepEqual(revised.visits.map(v=>v.id),['food','ride']);
      assert.ok(revised.rows.some(r=>r.preserved&&r.kind==='walk'&&r.duration===60));
      assert.ok(revised.rows.some(r=>r.preserved&&r.kind==='wait'&&r.end===645));
      assert.deepEqual(autoRests(revised),[],category);
      assert.equal(validatePlan(p,day,revised,{initialPlan:first}).valid,true);
    }
  });

  test(`${searchMethod}: equally fulfilled wishes can separate a fixed rest and food`,()=>{
    // Sharing one map node must not collapse orders ending with a ride and a snack.
    const p=park([venue('first'),venue('food',{category:'snack'}),venue('last')]);
    const s=settings({searchMethod,restEvery:0,fixedBreaks:[{id:'chosen',node:'gate',start:600,duration:10,label:'固定休憩'}],
      selections:[choose('first',540,590),choose('food',540,600),choose('last',610,680)]});
    const result=solveItinerary(p,s);
    assert.equal(result.status,'feasible');
    assert.deepEqual(result.rows.filter(row=>['activity','rest'].includes(row.kind)).map(row=>row.name),['food','first','固定休憩','last']);
    assert.deepEqual(result.rows.filter(row=>row.fixedBreakId).map(row=>[row.start,row.end]),[[600,610]]);
    assert.equal(validatePlan(p,s,result).valid,true);
  });
}

test('validation checks both neighbours of an automatic rest across travel, idle time and the queue',()=>{
  for(const categoryPair of [['cafe','attraction'],['attraction','popcorn']]){
    const p=parkWithWalk([venue('first',{duration:10,category:categoryPair[0]}),venue('last',{node:'garden',category:categoryPair[1],baseWait:15})]);
    const s=settings({restEvery:0,walkCrowdMode:'off',speed:75,selections:[choose('first',540,550),choose('last',690,800)]});
    const oldPlan=solveItinerary(p,s);
    const index=oldPlan.rows.findIndex(r=>r.kind==='wait');
    const idle=oldPlan.rows[index];
    const rest={...idle,kind:'rest',type:'rest',end:idle.start+10,duration:10,autoBreakId:'old-break',name:'ひと休み'};
    oldPlan.rows.splice(index,1,rest,{...idle,start:rest.end,duration:idle.end-rest.end});
    const checked=validatePlan(p,{...s,restEvery:60},oldPlan);
    assert.ok(checked.errors.includes('フードと自動休憩が連続しています。'));
    const day={...s,restEvery:60,replanFrom:620};
    const revised=solveItinerary(p,day,{initialPlan:oldPlan});
    assert.equal(revised.status,'feasible');
    assert.ok(revised.rows.some(r=>r.autoBreakId==='old-break'&&r.preserved));
    assert.equal(validatePlan(p,day,revised,{initialPlan:oldPlan}).valid,true);
  }
});

test('a user-selected rest beside a required meal remains visible even across intervening rows',()=>{
  const p=parkWithWalk([venue('meal',{node:'garden',category:'restaurant',baseWait:10})]);
  const s=settings({restEvery:0,speed:75,walkCrowdMode:'off',selections:[choose('meal',680,740)],
    fixedBreaks:[{id:'chosen',node:'gate',start:550,duration:10,label:'指定の休憩'}]});
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  const nearby=restsBesideFood(result.rows,new Map(p.activities.map(a=>[a.id,a])));
  assert.deepEqual([...nearby].map(row=>[row.fixedBreakId,row.start,row.end]),[['chosen',550,560]]);
  assert.ok(result.rows.some(row=>row.kind==='walk'&&row.start===560));
  assert.equal(validatePlan(p,s,result).valid,true);
});
