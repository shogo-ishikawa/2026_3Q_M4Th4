import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateWait, solveItinerary, validatePlan} from '../web/planner.js';

const moment=Date.parse('2026-11-17T01:00:00Z'); // 10:00 JST
const activity={id:'land-a',name:'A',category:'attraction',node:'a',duration:12,baseWait:20,cost:0,windows:[[540,1260]],access:'normal'};
const park={id:'land',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate',x:500,y:900},{id:'a',x:500,y:500}],edges:[{from:'gate',to:'a',metres:100}],activities:[activity],events:[]};
const snapshot=(extra={})=>({schemaVersion:1,provider:'queue-times',parkId:'land',fetchedAt:new Date(moment).toISOString(),rides:[{activityId:'land-a',providerId:123,name:'A',wait:7,isOpen:true,updatedAt:new Date(moment).toISOString(),...extra}],unmatched:[]});
const settings=(extra={})=>({date:'2026-11-17',entry:600,exit:670,speed:50,budget:5000,restEvery:0,restMinutes:0,searchSeconds:.2,crowdMode:'estimate',weather:'sun',selections:[{id:'land-a',weight:5,required:true}],liveData:snapshot(),waitAsOf:moment,...extra});
const atFixedTime=fn=>{const original=Date.now;Date.now=()=>moment;try{return fn();}finally{Date.now=original;}};

test('fresh day-of waits affect queueing while official ride duration stays unchanged',()=>atFixedTime(()=>{
 const s=settings(),result=solveItinerary(park,s);
 assert.equal(result.status,'feasible');assert.equal(result.totals.queueMinutes,7);
 const visit=result.visits[0];assert.equal(visit.end-visit.start,12);assert.equal(visit.waitSource,'live');
 assert.deepEqual(result.diagnostics.waitSources,['live']);assert.equal(validatePlan(park,s,result).valid,true);
}));
test('manual waits override live data and future-day plans never use today live waits',()=>{
 const manual=estimateWait(activity,602,settings({crowdMode:'manual',selections:[{id:'land-a',manualWait:43}]}));
 assert.equal(manual.minutes,43);assert.equal(manual.source,'manual');
 const future=estimateWait(activity,602,settings({date:'2026-11-18'}));assert.equal(future.source,'trend');
 const stale=settings({liveData:snapshot({updatedAt:new Date(moment-16*60000).toISOString()})});
 assert.equal(estimateWait(activity,602,stale).source,'trend');
});
test('temporarily closed facilities are not scheduled as zero-wait near-term rides',()=>atFixedTime(()=>{
 const result=solveItinerary(park,settings({exit:650,liveData:snapshot({isOpen:false,wait:0})}));
 assert.equal(result.status,'no-plan');assert.equal(result.visits.length,0);
}));
test('usable regression wins over historical similarity and future-trained models are ignored',()=>{
 const model={schemaVersion:1,method:'ridge-regression',parkId:'land',status:'trained',usable:true,lastDate:'2026-11-16',days:7,samples:120,activityIds:['land-a'],coefficients:[2,0,0,0,0,0,0,0],validation:{method:'later-days-holdout',trainThrough:'2026-11-14',testFrom:'2026-11-15',testThrough:'2026-11-16',testSamples:20,modelMae:3,baselineMae:10}};
 const rows=[{date:'2026-11-16',activityId:'land-a',time:600,wait:88}];
 assert.equal(estimateWait(activity,602,settings({liveMode:'off',waitModel:model}),rows).minutes,40);
 assert.equal(estimateWait(activity,602,settings({liveMode:'off',waitModel:{...model,lastDate:'2026-11-17'}}),rows).source,'history');
});
test('same-day history never uses observations from a later clock time',()=>{
 const wait=estimateWait(activity,600,settings({liveMode:'off'}),[{date:'2026-11-17',activityId:'land-a',time:650,wait:111}]);
 assert.equal(wait.source,'trend');
});

test('owned DPA does not bypass a current closed status',()=>atFixedTime(()=>{
 const a={...activity,dpa:{kind:'attraction',price:2000,wait:5}};const p={...park,activities:[a]};
 const s=settings({exit:650,liveData:snapshot({isOpen:false,wait:0}),selections:[{id:a.id,weight:5,dpaMode:'owned',dpaStart:610,dpaEnd:630,dpaPurchasedAt:600}]});
 assert.equal(solveItinerary(p,s).status,'no-plan');
}));
