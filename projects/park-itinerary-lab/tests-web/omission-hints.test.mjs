import test from 'node:test';
import assert from 'node:assert/strict';
import {solveItinerary,validatePlan} from '../web/planner.js';
import {omissionAction} from '../web/app.js';

const date='2026-11-19';
const ride=(id,features={})=>({id,name:id,category:'attraction',node:'gate',baseWait:0,duration:20,windows:[[540,660]],...features});
function park(activities,close=660) {
  return {id:'land',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate'},{id:'far'}],
    edges:[{from:'gate',to:'far',metres:200}],activities,operatingCalendar:{[date]:{windows:[[540,close]]}}};
}
function settings(extra={}) {
  return {date,entry:540,exit:580,speed:50,budget:3000,foodBudget:1500,dpaBudget:0,
    crowdMode:'manual',restEvery:0,searchSeconds:0.2,
    selections:[{id:'a',required:true},{id:'b',weight:1}],...extra};
}
function verified(p,s,ids) {
  const result=solveItinerary(p,s);
  assert.equal(result.status,'feasible');
  assert.equal(validatePlan(p,s,result).valid,true);
  assert.deepEqual(result.visits.map(v=>v.id).sort(),ids);
  return result.omissions[0];
}

test('a verified exit extension keeps the first ride and includes the walk to the gate',()=>{
  const p=park([ride('a'),ride('b',{node:'far'})]);
  const s=settings();
  const missing=verified(p,s,['a']);
  assert.equal(missing.conflictField,'exitTime');
  assert.match(missing.reason,/09:55.*15分延長/);
  assert.equal(omissionAction(missing).wishId,undefined);
  verified(p,{...s,exit:595},['a','b']);
});

test('an extension never crosses closing, an unconfirmed park day, or a fixed wish deadline',()=>{
  const activities=[ride('a'),ride('b',{node:'far'})];
  const p=park(activities,584),s=settings();
  assert.notEqual(verified(p,s,['a']).conflictField,'exitTime');
  p.operatingCalendar={};
  assert.notEqual(verified(p,s,['a']).conflictField,'exitTime');
  const bounded=settings({selections:[{id:'a',required:true,latest:560},{id:'b',latest:565}]});
  assert.notEqual(verified(park(activities),bounded,['a']).conflictField,'exitTime');
});

test('food cap and total-budget suggestions preserve existing spending and check both caps',()=>{
  const p=park([ride('a',{category:'restaurant',cost:1000}),ride('b',{category:'snack',cost:800})]);
  const s=settings({exit:640});
  const food=verified(p,s,['a']);
  assert.equal(food.conflictField,'foodBudget');
  assert.match(food.reason,/あと300円/);
  verified(p,{...s,foodBudget:1800},['a','b']);
  const total=verified(p,{...s,foodBudget:2000,budget:1200},['a']);
  assert.equal(total.conflictField,'budget');
  assert.match(total.reason,/あと600円/);
  assert.doesNotMatch(verified(p,{...s,budget:1200},['a']).reason,/追加でき/);
});

test('DPA budget suggestions require a feasible purchase window and include the price once',()=>{
  const p=park([ride('a'),ride('b',{baseWait:120,dpa:{price:2000,wait:5,kind:'attraction'}})]);
  const candidate={id:'b',dpaMode:'consider',dpaAvailableWindows:[[565,585]]};
  const s=settings({exit:610,selections:[{id:'a',required:true},candidate]});
  const missing=verified(p,s,['a']);
  assert.equal(missing.conflictField,'dpaBudget');
  assert.match(missing.reason,/あと2,000円/);
  verified(p,{...s,dpaBudget:2000},['a','b']);
  assert.notEqual(verified(p,{...s,dpaPurchaseLimit:0},['a']).conflictField,'dpaBudget');
  assert.notEqual(verified(p,{...s,budget:1000},['a']).conflictField,'dpaBudget');
});

test('row actions open global settings or the shared facility editor for a second ride',()=>{
  assert.deepEqual(omissionAction({id:'ride~2',conflictField:'earliest'}),{field:'earliest',wishId:'ride',label:'希望の時間帯を見直す'});
  assert.deepEqual(omissionAction({id:'ride~2',conflictField:'foodBudget'}),{field:'foodBudget',label:'フードの上限を見直す'});
  assert.equal(omissionAction({id:'ride',required:false}).field,'weight');
});
