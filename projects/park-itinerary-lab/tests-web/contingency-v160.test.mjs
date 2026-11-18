import test from 'node:test';
import assert from 'node:assert/strict';
import {solveItinerary,validatePlan,queueAllowance} from '../web/planner.js';
import {contingencySettings,compareContingency} from '../web/contingency.js';
import {buildPlanJson,parsePlanJson,buildScheduleCsv,buildCalendar,buildOfflineHtml} from '../web/storage.js';

const activity=(id,extra={})=>({id,name:id,category:'attraction',node:id,duration:10,baseWait:10,cost:0,windows:[[540,720]],sourceUrl:'https://www.tokyodisneyresort.jp/',...extra});
const park=(activities=[activity('land-a'),activity('land-b')])=>({id:'land',name:'テスト',entryNode:'gate',exitNode:'gate',events:[],nodes:[{id:'gate',name:'入口',x:0,y:0},...activities.map(a=>({id:a.node,name:a.name,x:10,y:10}))],edges:activities.map(a=>({from:'gate',to:a.node,metres:1})),activities});
const settings=extra=>({date:'2026-11-18',entry:540,exit:594,speed:70,budget:1000,crowdMode:'manual',restEvery:0,restMinutes:0,searchSeconds:.1,waitBufferMode:'fixed',waitBufferMinutes:5,queueDelayMinutes:0,selections:[{id:'land-a',weight:5,required:true},{id:'land-b',weight:2}],...extra});

test('queue margins distinguish a labelled model error from fixed allowances and DPA',()=>{
 const a=activity('land-a'),s={waitBufferMode:'auto',waitBufferMinutes:5,queueDelayMinutes:15,waitModel:{validation:{modelMae:12.49}}};
 assert.deepEqual(queueAllowance(a,{minutes:20,source:'ml'},'normal',s),{estimatedMinutes:20,bufferMinutes:15,delayMinutes:15,totalMinutes:50});
 assert.equal(queueAllowance(a,{minutes:20,source:'trend'},'normal',s).bufferMinutes,5);
 for(const [category,method] of [['show','normal'],['parade','normal'],['attraction','dpa'],['shop','normal']]) assert.equal(queueAllowance({...a,category},{minutes:10,source:'ml'},method,s).bufferMinutes,0);
 assert.equal(queueAllowance(a,{minutes:0,source:'manual'},'normal',s).totalMinutes,0);
});

test('a delayed alternative can remove optional visits but preserves every hard condition',()=>{
 const p=park(),s=settings(),original=solveItinerary(p,s),scenario=contingencySettings(s,15),alternative=solveItinerary(p,scenario);
 assert.equal(original.coverage.count,2);assert.equal(alternative.coverage.count,1);assert.equal(alternative.status,'feasible');
 assert.equal(alternative.visits[0].activityId,'land-a');assert.equal(s.queueDelayMinutes,0);
 assert.equal(alternative.totals.bufferMinutes,5);assert.equal(alternative.totals.delayMinutes,15);
 assert.deepEqual(compareContingency(original,alternative).removed,['land-b']);
 assert.equal(validatePlan(p,scenario,alternative).valid,true);
 const both=solveItinerary(p,{...scenario,selections:s.selections.map(x=>({...x,required:true}))});
 assert.equal(both.status,'no-plan');assert.equal(both.diagnostics.optimal,false);
});

test('buffer tampering and invalid inputs are caught independently',()=>{
 const p=park(),s=settings(),result=solveItinerary(p,s),changed=structuredClone(result);
 changed.rows.find(row=>row.kind==='queue').bufferMinutes=0;
 assert.equal(validatePlan(p,s,changed).valid,false);
 for(const bad of [-1,1.5,31,NaN])assert.throws(()=>solveItinerary(p,{...s,waitBufferMinutes:bad}));
 assert.throws(()=>contingencySettings({...s,queueDelayMinutes:60},1));
});

test('fixed shows, owned DPA and fixed breaks keep their actual times in a delay scenario',()=>{
 const activities=[activity('land-dpa',{baseWait:10,duration:5,dpa:{price:1000,wait:3,kind:'attraction'}}),activity('land-show',{category:'show',duration:5,showTimes:[600],showTimesDate:'2026-11-18',baseWait:5})];
 const p=park(activities),s=settings({exit:630,budget:1000,waitBufferMinutes:20,queueDelayMinutes:30,fixedBreaks:[{id:'pause',node:'gate',start:580,duration:5}],selections:[{id:'land-dpa',weight:3,dpaMode:'owned',dpaStart:560,dpaEnd:570,dpaPurchasedAt:540},{id:'land-show',weight:3,required:true}]});
 const r=solveItinerary(p,s);assert.equal(r.status,'feasible');
 assert.equal(r.visits.find(v=>v.id==='land-show').start,600);
 assert.ok(r.visits.find(v=>v.id==='land-dpa').queueStart>=560);
 assert.equal(r.rows.find(row=>row.fixedBreakId==='pause').start,580);
 assert.equal(r.totals.bufferMinutes,0);assert.equal(r.totals.delayMinutes,0);assert.equal(r.totals.cost,1000);
 assert.equal(validatePlan(p,s,r).valid,true);
});

test('time-varying estimates for fixed shows and parades are checked at the show time',()=>{
 for(const category of ['show','parade']){
  const activity= {id:'land-show',name:'公演',node:'show',category,duration:5,showTimes:[600],showTimesDate:'2026-11-18',baseWait:30,windows:[[540,1260]]};
  const p=park([activity]),s=settings({exit:650,crowdMode:'estimate',waitBufferMode:'auto',waitBufferMinutes:5,queueDelayMinutes:15,selections:[{id:'land-show',weight:3,required:true}]});
  const result=solveItinerary(p,s),queue=result.rows.find(row=>row.kind==='queue');
  assert.equal(result.status,'feasible');assert.equal(result.visits[0].start,600);
  assert.equal(queue.estimatedMinutes,30);assert.equal(queue.start,570);assert.equal(queue.end,600);
  assert.equal(queue.bufferMinutes,0);assert.equal(queue.delayMinutes,0);
  assert.equal(validatePlan(p,s,result).valid,true);
  const changed=structuredClone(result);changed.rows.find(row=>row.kind==='queue').estimatedMinutes--;
  assert.equal(validatePlan(p,s,changed).valid,false);
 }
});

test('JSON round trips and repeated replans retain an already started buffered queue',()=>{
 const p=park(),s=settings({exit:700}),original=solveItinerary(p,s);
 let prior=original,profile={...s,replanFrom:545,queueDelayMinutes:15};
 for(let i=0;i<3;i++){
  const result=solveItinerary(p,profile,{initialPlan:prior});assert.equal(result.status,'feasible');
  const before=original.rows.find(row=>row.kind==='queue'&&row.start<545);
  const after=result.rows.find(row=>row.kind==='queue'&&row.activityId===before.activityId);
  assert.deepEqual({...after,preserved:undefined},{...before,preserved:undefined});
  assert.equal(validatePlan(p,profile,result,{initialPlan:prior}).valid,true);
  const saved=parsePlanJson(buildPlanJson({parkId:'land',settings:profile,result}));prior=saved.result;
 }
});

test('portable schedules disclose margin and delay separately from the wait estimate',()=>{
 const p=park(),s=settings({queueDelayMinutes:15}),r=solveItinerary(p,s);
 const json=buildPlanJson({parkId:'land',settings:s,result:r});assert.equal(parsePlanJson(json).result.rows.find(row=>row.kind==='queue').delayMinutes,15);
 for(const text of [buildScheduleCsv(r,p,s),buildCalendar(r,p,s),buildOfflineHtml(r,p,s)])assert.match(text,/余裕/);
});
