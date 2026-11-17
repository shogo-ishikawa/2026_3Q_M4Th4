import test from 'node:test';
import assert from 'node:assert/strict';
import {normaliseThemeParksLive,fetchRealtimeWaits,prepareLiveForReplan,currentRideStatus,liveWaitFor,snapshotToHistory,buildObservationCsv,prepareWeatherForVisit,updateOperationalHolds} from '../web/wait-data.js';
import {solveItinerary,validatePlan,walkingFactor,walkingMinutes} from '../web/planner.js';

const moment=Date.parse('2026-11-17T01:00:00Z'); // 10:00 JST
const id='3cc919f1-d16d-43e0-8c3f-1dd269bd1a42';
const attraction={id:'land-attraction-153',name:'A',category:'attraction',node:'a',duration:10,baseWait:20,cost:0,windows:[[540,1260]],access:'normal'};
const park={id:'land',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate',x:500,y:900},{id:'a',x:500,y:500},{id:'b',x:250,y:500}],edges:[{from:'gate',to:'a',metres:500},{from:'a',to:'b',metres:500}],activities:[attraction,{...attraction,id:'land-attraction-154',node:'b',name:'B'}],events:[]};
const live=(status='OPERATING',waitTime=7)=>({id,liveData:[{id:'provider-uuid',entityType:'ATTRACTION',externalId:'153',name:'Provider A',status,lastUpdated:'2026-11-17T00:00:00Z',queue:{STANDBY:{waitTime}}}]});
const snapshot=(status='OPERATING',wait=7)=>normaliseThemeParksLive(live(status,wait),park,{now:moment});
const settings=extra=>({date:'2026-11-17',entry:600,exit:1000,speed:50,budget:5000,restEvery:0,restMinutes:0,searchSeconds:.15,crowdMode:'estimate',weather:'sun',selections:[{id:attraction.id,weight:5,required:true}],...extra});
const atFixedTime=fn=>{const original=Date.now;Date.now=()=>moment;try{return fn();}finally{Date.now=original;}};

test('live mapping uses official external IDs, preserves last change, and does not invent open missing entries',()=>{
 const payload=live();payload.liveData.push({...payload.liveData[0],externalId:'154',queue:{}},{...payload.liveData[0],externalId:'999'});
 const result=normaliseThemeParksLive(payload,park,{now:moment});
 assert.equal(result.rides.length,2);assert.equal(result.rides[0].activityId,attraction.id);assert.equal(result.rides[0].name,'A');
 assert.equal(result.rides[0].changedAt,'2026-11-17T00:00:00Z');assert.equal(result.rides[0].updatedAt,new Date(moment).toISOString());
 assert.equal(currentRideStatus(park.activities[1],settings({liveData:result}),{now:moment}).isOpen,true);assert.equal(liveWaitFor(park.activities[1],600,settings({liveData:result}),{now:moment}),null);
 assert.throws(()=>normaliseThemeParksLive({...payload,id:'wrong-park'},park,{now:moment}),/形式/);
});
test('new live REST is preferred and its failure falls back to clearly labelled collected records',async()=>{
 let calls=0;let result=await fetchRealtimeWaits(park,{now:moment,fetchImpl:async url=>{calls++;assert.match(url,/api.themeparks.wiki.*live/);return {ok:true,json:async()=>live()};}});
 assert.equal(calls,1);assert.equal(result.transport,'direct');
 calls=0;result=await fetchRealtimeWaits(park,{now:moment,fetchImpl:async url=>{calls++;return calls===1?{ok:false,status:503}:{ok:true,json:async()=>({parks:[{...snapshot(),provider:'queue-times'}]})};}});
 assert.equal(result.transport,'published');assert.match(result.directFailure,/503/);
});
test('same-day replan fetches a new snapshot and visibly falls back after stale or failed retrieval',async()=>{
 let calls=0;const s=settings({replanFrom:600,liveData:snapshot()});
 let result=await prepareLiveForReplan(s,park,{now:moment,fetchRealtimeWaitsImpl:async()=>{calls++;return snapshot('DOWN');}});
 assert.equal(calls,1);assert.equal(result.liveData.rides[0].isOpen,false);assert.match(result.liveNotice,/停止中の1施設/);assert.equal(s.liveData.rides[0].isOpen,true);
 for(const patch of [{date:'2026-11-18'},{replanFrom:undefined},{liveMode:'off'}])await prepareLiveForReplan({...s,...patch},park,{now:moment,fetchRealtimeWaitsImpl:async()=>{throw Error('must not fetch');}});
 result=await prepareLiveForReplan(s,park,{now:moment,fetchRealtimeWaitsImpl:async()=>({...snapshot(),fetchedAt:new Date(moment-16*60000).toISOString()})});
 assert.equal(result.liveData,null);assert.match(result.liveNotice,/予測の案/);
 result=await prepareLiveForReplan(s,park,{now:moment,fetchRealtimeWaitsImpl:async()=>{throw Error('offline');}});assert.equal(result.liveData,null);assert.match(result.liveNotice,/offline/);
});
test('cancelling live preparation does not silently create a fallback plan',async()=>{
 const controller=new AbortController();const task=prepareLiveForReplan(settings({replanFrom:600}),park,{now:moment,signal:controller.signal,fetchRealtimeWaitsImpl:async(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('abort','AbortError')),{once:true}))});
 controller.abort();await assert.rejects(task,{name:'AbortError'});
});
test('an emergency stop blocks all remaining day visits, including a slot two hours later, until reopening',()=>atFixedTime(()=>{
 const s=settings({replanFrom:600,liveData:snapshot('DOWN'),selections:[{id:attraction.id,weight:5,required:true,earliest:800}]});
 const result=solveItinerary(park,s);assert.equal(result.status,'no-plan');assert.match(result.omissions[0].reason,/運営停止/);
 assert.equal(liveWaitFor(attraction,800,s,{now:moment}),null); // Numeric waits are short-horizon, status exclusion is not.
 assert.equal(currentRideStatus(attraction,s,{now:moment}).isOpen,false);
 const reopened=solveItinerary(park,{...s,liveData:snapshot('OPERATING')});assert.equal(reopened.status,'feasible');
 const future=solveItinerary(park,{...s,date:'2026-11-18'});assert.equal(future.status,'feasible');
 const forged=structuredClone(reopened);assert.equal(validatePlan(park,s,forged).valid,false);
}));
test('completed visits remain preserved when their current operating status changes',()=>atFixedTime(()=>{
 const s=settings({liveData:snapshot(),selections:park.activities.map(a=>({id:a.id,weight:3}))});
 const first=solveItinerary(park,s),completed=first.rows.find(r=>r.kind==='activity');
 const next={...s,replanFrom:completed.end+1,liveData:snapshot('DOWN')};const result=solveItinerary(park,next,{initialPlan:first});
 assert.equal(result.status,'feasible');assert.ok(result.rows.some(r=>r.kind==='activity'&&r.activityId===completed.activityId&&r.preserved));
}));
test('direct provider data is not turned into a redistributable raw CSV',()=>{
 assert.deepEqual(snapshotToHistory(snapshot()),[]);
 const csv=buildObservationCsv([{date:'2026-11-17',activityId:'theme-source',time:600,wait:7,source:'themeparks-wiki'},{date:'2026-11-17',activityId:'own-source',time:600,wait:9,source:'user'}]);
 assert.equal(csv.includes('theme-source'),false);assert.equal(csv.includes('own-source'),true);
});
test('walking estimates respond to crowd, weather and time while off mode keeps the selected speed',()=>{
 const s=settings({walkCrowdMode:'estimate',crowdLevel:'busy',weather:'rain'});
 assert.ok(walkingFactor(600,s)>walkingFactor(800,{...s,crowdLevel:'quiet',weather:'sun'}));
 assert.equal(walkingMinutes(500,600,{...s,walkCrowdMode:'off'}),10);
 assert.ok(walkingMinutes(500,600,s)>10);
});
test('all walking legs and their independent validation include congestion, including fixed rests and exit',()=>{
 const p={...park,events:[{id:'festival',startDate:'2026-11-01',endDate:'2026-11-30'}]};
 const s=settings({walkCrowdMode:'estimate',crowdLevel:'busy',weather:'rain',fixedBreaks:[{id:'r',start:730,duration:10,node:'b',label:'休憩'}]});
 const result=solveItinerary(p,s);assert.equal(result.status,'feasible');
 assert.ok(result.rows.filter(r=>r.kind==='walk').every(r=>r.walkingFactor>1&&r.walkingSource==='congestion-estimate'));
 assert.equal(validatePlan(p,s,result).valid,true);
 const forged=structuredClone(result),walk=forged.rows.find(r=>r.kind==='walk');walk.walkingFactor=1;
 assert.equal(validatePlan(p,s,forged).valid,false);
});
test('automatic rests can be excluded individually and manual rests remain hard reservations',()=>{
 const s=settings({crowdMode:'manual',restEvery:10,restMinutes:10,selections:park.activities.map(a=>({id:a.id,weight:3}))});
 const initial=solveItinerary(park,s),rest=initial.rows.find(r=>r.kind==='rest'&&r.autoBreakId);assert.ok(rest);
 const next={...s,excludedAutoBreaks:[rest.autoBreakId],fixedBreaks:[{id:'fixed',start:850,duration:15,node:'gate'}]};const result=solveItinerary(park,next);
 assert.equal(result.status,'feasible');assert.equal(result.rows.some(r=>r.autoBreakId===rest.autoBreakId),false);assert.ok(result.rows.some(r=>r.fixedBreakId==='fixed'));
 assert.equal(validatePlan(park,next,result).valid,true);
 const forged=structuredClone(result);forged.rows.push({...rest,start:900,end:910});assert.equal(validatePlan(park,next,forged).valid,false);
});
test('explicit weather retrieval uses the same visit-hour preparation as planning, including failure and cancellation',async()=>{
 const forecast={date:'2026-11-17',hours:[{minute:540,weather:'rain',temperature:13,precipitationProbability:90},{minute:1020,weather:'cloud',temperature:16,precipitationProbability:20}]};
 const s=settings({entry:1020,exit:1100,weatherMode:'auto'});let requested;
 const result=await prepareWeatherForVisit(s,park,{fetchWeatherImpl:async(date)=>{requested=date;return forecast;}});
 assert.equal(requested,s.date);assert.equal(result.weather,'cloud');assert.equal(result.weatherForecast.precipitationProbability,20);
 const fallback=await prepareWeatherForVisit(s,park,{fetchWeatherImpl:async()=>{throw Error('HTTP 503');}});assert.equal(fallback.weatherForecast,null);assert.match(fallback.weatherNotice,/503/);
});

test('stopped ride holds survive offline and missing live entries and clear only after explicit reopening',async()=>{
 const original=settings({replanFrom:600,liveData:snapshot('DOWN')});
 const offline=await prepareLiveForReplan(original,park,{now:moment+20*60000,fetchRealtimeWaitsImpl:async()=>{throw Error('offline');}});
 assert.equal(offline.liveData,null);assert.deepEqual(offline.operationalHolds.activityIds,[attraction.id]);assert.match(offline.liveNotice,/除外を保ちます/);
 assert.equal(currentRideStatus(attraction,offline,{now:moment+20*60000}).isOpen,false);
 const missing={...snapshot(),rides:[{...snapshot().rides[0],activityId:'land-attraction-154',updatedAt:new Date(moment+20*60000).toISOString()}],fetchedAt:new Date(moment+20*60000).toISOString()};
 assert.ok(updateOperationalHolds(offline,missing,{now:moment+20*60000}).activityIds.includes(attraction.id));
 const openNoWait=normaliseThemeParksLive(live('OPERATING',null),park,{now:moment+20*60000});
 const reopened=await prepareLiveForReplan(offline,park,{now:moment+20*60000,fetchRealtimeWaitsImpl:async()=>openNoWait});
 assert.equal(reopened.operationalHolds,null);assert.equal(currentRideStatus(attraction,reopened,{now:moment+20*60000}).isOpen,true);
 assert.equal(liveWaitFor(attraction,620,reopened,{now:moment+20*60000}),null);
 assert.equal(currentRideStatus(attraction,{...offline,date:'2026-11-18'},{now:moment+24*3600000}),null);
});

test('slower walking assumptions on replan do not rewrite completed walking provenance',()=>atFixedTime(()=>{
 const s=settings({speed:90,crowdMode:'manual',selections:[{id:attraction.id,weight:5}]});const first=solveItinerary(park,s);
 const visit=first.rows.find(r=>r.kind==='activity');const slower={...s,speed:50,replanFrom:visit.end};
 const next=solveItinerary(park,slower,{initialPlan:first});assert.equal(next.status,'feasible');
 const completedWalk=next.rows.find(r=>r.kind==='walk'&&r.preserved);assert.equal(completedWalk.walkSpeed,90);assert.equal(completedWalk.end-completedWalk.start,6);
 assert.equal(validatePlan(park,slower,next).valid,true);
 const forged=structuredClone(next);forged.rows.find(r=>r.kind==='walk'&&r.preserved).walkSpeed=0;assert.equal(validatePlan(park,slower,forged).valid,false);
}));

test('a recently downloaded collector file with only stale ride values is visibly rejected as current data',async()=>{
 const old={...snapshot(),provider:'queue-times',rides:[{...snapshot().rides[0],updatedAt:new Date(moment-16*60000).toISOString()}]};
 const result=await prepareLiveForReplan(settings({replanFrom:600}),park,{now:moment,fetchRealtimeWaitsImpl:async()=>old});
 assert.equal(result.liveData,null);assert.match(result.liveNotice,/施設ごとの現在情報が古い/);
});
