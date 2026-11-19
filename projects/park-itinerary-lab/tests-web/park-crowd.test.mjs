import test from 'node:test';
import assert from 'node:assert/strict';
import {WAIT_BASE_FEATURE_NAMES} from '../web/calendar-features.js';
import {calendarDayOutlook, calendarDayPreview, CROWD_LABELS} from '../web/calendar-outlook.js';
import {cachedForecastForDate, prepareWeatherForVisit, warmCalendarWeather} from '../web/weather.js?v=2.6.1';
import {estimateParkCrowd} from '../web/wait-model.js';
import {solveItinerary,validatePlan} from '../web/planner.js';

const ride = id => ({id, name:id, node:'ride', category:'attraction', baseWait:30, duration:10, cost:0, windows:[[540,1080]]});
const activities = ['land-a','land-b','land-c','land-unseen'].map(ride);
const park = {id:'land', entryNode:'gate', exitNode:'gate', nodes:[{id:'gate'},{id:'ride'}],
  edges:[{from:'gate',to:'ride',metres:1000}], activities, events:[{id:'event',startDate:'2026-11-01',endDate:'2026-11-30',multiplier:1.5}]};
function testModel(multiplier=1.2) {
  const activityIds=activities.slice(0,3).map(a=>a.id), features=[...WAIT_BASE_FEATURE_NAMES];
  return {schemaVersion:2,parkId:'land',status:'trained',usable:true,method:'ridge-regression',
    trainedAt:'2026-11-18T00:00:00Z',beforeDate:'2026-11-18',firstDate:'2026-11-01',lastDate:'2026-11-17',days:17,samples:600,
    eventIds:[],featureNames:features,activityIds,coefficients:[multiplier,...Array(features.length+activityIds.length-1).fill(0)],
    validation:{method:'later-days-holdout',trainThrough:'2026-11-14',testFrom:'2026-11-15',testThrough:'2026-11-17',testSamples:100,modelMae:5,baselineMae:9},
    correlations:{weekday:Array.from({length:7},(_,day)=>({key:String(day),days:2})),month:[{key:'11',days:17}],holiday:[{key:'holiday',days:1}]},
    activityTimeProfiles:activityIds.flatMap(activityId=>[10,12,14].map(hour=>({activityId,hour,days:5,samples:15,meanWait:30,correctionMinutes:0})))};
}
const settings = extra => ({date:'2026-11-21',entry:660,exit:1020,speed:100,budget:10000,restEvery:0,restMinutes:0,searchSeconds:1,
  searchMethod:'beam',walkCrowdMode:'estimate',crowdLevel:'auto',weather:'rain',selections:[{id:'land-a',required:true}],waitModel:testModel(),...extra});

test('the park index compares the same ride and hours even when the visitor chooses different rides or arrives late',()=>{
  const normal=settings(), a=estimateParkCrowd(park,normal);
  assert.equal(calendarDayOutlook(park, {...normal,crowdLevel:'quiet'}, normal.date).crowd, 'model');
  assert.deepEqual(a,{level:'busy',source:'model',ratio:1.2,rides:3,slots:9,days:17,samples:600});
  assert.deepEqual(estimateParkCrowd(park,{...normal,entry:990,selections:[]}),a);
  assert.equal(estimateParkCrowd(park,settings({waitModel:testModel(0.8)})).level,'quiet');
  assert.equal(estimateParkCrowd(park,settings({waitModel:testModel(1.1)})).level,'normal');
  const skewed=testModel();
  for (const p of skewed.activityTimeProfiles.filter(p=>p.activityId==='land-a')) { p.meanWait=300; p.samples=300; }
  assert.equal(estimateParkCrowd(park,settings({waitModel:skewed})).ratio,1.2); // One popular ride gets one vote.
});

test('unsupported facility coverage, clock coverage, dates or validation fall back to the calendar',()=>{
  const s=settings();
  const fallback=(p, st) => {
    const estimate=estimateParkCrowd(p,st);
    assert.deepEqual([estimate.source,estimate.ratio],['calendar',null]);
    assert.equal(calendarDayOutlook(p, st, st.date).crowd, estimate.source);
  };
  const short=testModel();short.activityTimeProfiles=short.activityTimeProfiles.filter(p=>p.hour!==14);
  fallback(park,{...s,waitModel:short});
  const low=testModel();low.activityTimeProfiles.forEach(p=>{p.days=2;});
  fallback(park,{...s,waitModel:low});
  fallback({...park,activities:[{...activities[0],closedDates:[s.date]},...activities.slice(1)]},s);
  fallback({...park,operatingCalendar:{[s.date]:{windows:[[1020,1200]]}}},s);
  const unseenDay=testModel();unseenDay.correlations.weekday=[];fallback(park,{...s,waitModel:unseenDay});
  fallback(park,{...s,date:'2026-12-03'});
  fallback(park,{...s,date:'2026-11-15'});
  fallback({...park,id:'sea'},s);
  fallback(park,{...s,waitModel:{...s.waitModel,usable:false}});
  fallback(park,{...s,waitModel:{...s.waitModel,validation:{...s.waitModel.validation,modelMae:15}}});
  const h={...s,date:'2026-11-23',calendarData:{holidays:[{date:'2026-11-23',name:'Holiday'}],coverage:{startDate:'2026-01-01',endDate:'2026-12-31'}}};
  fallback(park,h); assert.equal(estimateParkCrowd(park,h).level,'busy');
  assert.equal(estimateParkCrowd(park,{...s,date:'2026-12-03'}).level,'normal');
});

test('walking and unmodelled queues apply the park index once, and forecast or manual ride waits are unchanged',()=>{
  const s=settings(), p=solveItinerary(park,s);
  assert.equal(p.status,'feasible');assert.equal(p.settings.crowdLevel,'auto');
  assert.equal(p.diagnostics.crowdEstimate.level,'busy');
  assert.equal(p.rows.find(r=>r.kind==='walk').walkingFactor,1.2);
  const queue = plan => plan.rows.find(r=>r.kind==='queue');
  assert.equal(queue(p).estimatedMinutes,36); // 30 * 1.2 irrespective of the park-wide walking assumption
  assert.equal(validatePlan(park,s,p).valid,true);
  const manual=solveItinerary(park,{...s,crowdMode:'manual',selections:[{id:'land-a',manualWait:7,required:true}]});
  assert.equal(queue(manual).estimatedMinutes,7);
  const noWalk={...s,walkCrowdMode:'off',selections:[{id:'land-unseen',required:true}]};
  const typical=solveItinerary(park,{...noWalk,waitModel:testModel(1)});
  const busier=solveItinerary(park,noWalk);
  assert.equal(queue(typical).estimatedMinutes,34);
  assert.equal(queue(busier).estimatedMinutes,40);
  assert.equal(validatePlan(park,noWalk,busier).valid,true);
  const old=solveItinerary(park,{...s,crowdLevel:'quiet'});
  assert.equal(old.diagnostics.crowdEstimate,undefined);
  assert.equal(queue(old).estimatedMinutes,36);
});

test('a highlighted date uses its cached visit weather and matches the confirmed plan without new requests', async () => {
  const now=Date.parse('2026-11-19T01:00Z'), date='2026-11-22', fetchedAt=new Date(now).toISOString();
  const model=testModel(1);
  model.coefficients[model.featureNames.indexOf('rain')]=1;
  const original=settings({weatherMode:'auto',weather:'sun',waitModel:model,
    weatherForecast:{date:'2026-11-21',weather:'sun'},entry:780,exit:840});
  const unchanged=structuredClone(original);
  // Rain covers the chosen visit. The crowd estimator also samples hours before and after it.
  const hourly={time:[date+'T01:00',date+'T13:00'],temperature_2m:[19,10],weather_code:[0,61]};
  const fetch=globalThis.fetch;
  let calls=0;
  try {
    globalThis.fetch=async()=>{
      calls++;
      return {ok:true,json:async()=>({schemaVersion:1,providers:{'open-meteo':{fetchedAt,data:{hourly}}}})};
    };
    await warmCalendarWeather({now});
    const preview=calendarDayPreview(park,original,date,{now});
    assert.equal(preview.weather.label,'雨');
    assert.match(preview.weather.detail,/10℃/);
    const confirmed=await prepareWeatherForVisit({...original,date},park,{fetchWeatherImpl:async()=>cachedForecastForDate(date,now)});
    assert.equal(preview.crowd.label,CROWD_LABELS[estimateParkCrowd(park,confirmed).level]);
    assert.equal(preview.crowd.label,'混み合う');
    assert.match(preview.crowd.detail,/過去の待ち時間/);
    const uncovered=calendarDayPreview(park,{...original,entry:660,exit:720},date,{now});
    assert.equal(uncovered.weather.label,'予報未取得');
    assert.equal(uncovered.crowd.label,'ふつう');
    assert.equal(calls,1);
    assert.deepEqual(original,unchanged);
  } finally { globalThis.fetch=fetch; }
});
