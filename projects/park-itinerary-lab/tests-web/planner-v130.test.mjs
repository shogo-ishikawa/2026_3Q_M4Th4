import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {estimateWait,solveItinerary,validatePlan} from '../web/planner.js';
import {observationWeather,buildObservationCsv,mergeObservations} from '../web/wait-data.js';
import {parseHistoryCsv,validateSavedState,parsePlanJson,validateCatalogue} from '../web/storage.js';
import {defaultSettings} from '../web/app.js';

const venue={id:'land-a',name:'人気施設',category:'attraction',node:'a',duration:10,baseWait:100,cost:0,windows:[[540,1260]],access:'normal'};
const p={id:'land',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate',x:500,y:900},{id:'a',x:500,y:500},{id:'b',x:300,y:600}],edges:[{from:'gate',to:'a',metres:100},{from:'a',to:'b',metres:100}],activities:[venue,{...venue,id:'land-b',name:'B',node:'b',baseWait:0}],events:[]};
const options=extra=>({...defaultSettings(),date:'2026-11-18',entry:540,exit:1260,restEvery:0,restMinutes:0,searchSeconds:.2,weatherMode:'manual',selections:[{id:'land-a',weight:3},{id:'land-b',weight:3}],...extra});

test('opening trend is continuous and late entry does not reset the quiet opening period',()=>{
 const s=options(),samples=[628,629,630,631,658,659,660,661].map(minute=>estimateWait(venue,minute,s).minutes);
 assert.ok(samples.every((value,i)=>!i||value>=samples[i-1]));
 assert.equal(estimateWait(venue,660,s).minutes,estimateWait(venue,660,{...s,entry:660}).minutes);
 assert.ok(estimateWait(venue,550,s).minutes<estimateWait(venue,660,s).minutes);
});
test('changing smoothing bandwidth cannot create an artificial queue drop',()=>{
 const rows=Array.from({length:26},(_,i)=>({date:'2026-11-17',activityId:venue.id,time:540+i*5,wait:Math.min(400,i*20)}));
 const s=options();const a=estimateWait(venue,629,s,rows),b=estimateWait(venue,630,s,rows);
 assert.equal(a.source,'history');assert.ok(b.minutes>=a.minutes);assert.ok(b.minutes-a.minutes<8);
});
test('replanning preserves completed facts but forged future preservation cannot bypass closures',()=>{
 const s=options({crowdMode:'manual',exit:720}),first=solveItinerary(p,s),a=first.rows.find(row=>row.kind==='activity');
 const changed=structuredClone(p);changed.activities.find(item=>item.id===a.activityId).dailySchedules={'2026-11-18':{closed:true}};
 const next=options({crowdMode:'manual',exit:720,replanFrom:a.end+1}),result=solveItinerary(changed,next,{initialPlan:first});
 assert.equal(result.status,'feasible');assert.ok(result.rows.find(row=>row.activityId===a.activityId&&row.preserved));
 const forged=structuredClone(first);forged.rows.filter(row=>row.activityId===a.activityId).forEach(row=>row.preserved=true);
 assert.equal(validatePlan(changed,s,forged).valid,false);
});
test('date-specific operations and announced closure periods remain hard constraints',()=>{
 const changed=structuredClone(p);changed.activities[0].baseWait=0;changed.activities[0].dailySchedules={'2026-11-18':{closed:false,windows:[[700,720]]}};
 let s=options({exit:740,selections:[{id:venue.id,weight:5,required:true}]}),r=solveItinerary(changed,s);
 assert.equal(r.status,'feasible');assert.ok(r.visits[0].queueStart>=700);
 changed.activities[0].closedPeriods=[{startDate:'2026-11-18',endDate:'2026-11-20'}];
 assert.equal(solveItinerary(changed,s).status,'no-plan');
});
test('observations and CSV use the weather at the observation hour, including negative temperatures',()=>{
 const settings={date:'2026-11-17',weather:'rain',weatherMode:'auto',weatherForecast:{date:'2026-11-17',weather:'rain',hours:[{minute:540,weather:'sun',temperature:-2.5,precipitation:0},{minute:1020,weather:'rain',temperature:4,precipitation:1.5}]}};
 const conditions=observationWeather(settings.date,550,settings);assert.equal(conditions.weather,'sun');assert.equal(conditions.temperature,-2.5);
 const row={date:settings.date,activityId:venue.id,time:550,wait:35,event:'',source:'user',...conditions};
 const restored=parseHistoryCsv(buildObservationCsv([row]));assert.equal(restored[0].temperature,-2.5);assert.equal(restored[0].precipitation,0);assert.equal(restored[0].weatherSource,'forecast');
 assert.equal(observationWeather('2026-11-16',550,settings).weather,'');
});
test('actual bundled derived models and all new settings can be saved and restored',()=>{
 const models=JSON.parse(fs.readFileSync(new URL('../web/data/wait-model.json',import.meta.url)));
 const calendar=JSON.parse(fs.readFileSync(new URL('../web/data/calendar.json',import.meta.url)));
 const catalogue=JSON.parse(fs.readFileSync(new URL('../web/data/parks.json',import.meta.url)));assert.equal(validateCatalogue(catalogue),catalogue);
 for(const model of models.parks){const state={parkId:model.parkId,settings:{...options(),calendarData:calendar,waitModel:model,weatherMode:'auto',weatherNotice:'予報を取得しました。',weatherForecast:{date:'2026-11-18',weather:'cloud',hours:[{minute:540,weather:'cloud',temperature:12,precipitation:0}]}}};assert.equal(validateSavedState(state),state);assert.equal(parsePlanJson(JSON.stringify(state)).settings.waitModel.schemaVersion,2);}
});

test('local early-opening records retain rising waits within the same half hour',()=>{
 const a={date:'2026-11-17',activityId:'land-a',time:543,wait:5,openingMinute:540},b={...a,time:558,wait:40};
 assert.equal(mergeObservations([a],[b]).length,2);
 assert.equal(mergeObservations([{...a,time:695}],[{...b,time:705}]).length,1);
});

test('learned opening-period features use the selected date opening time',()=>{
 const models=JSON.parse(fs.readFileSync(new URL('../web/data/wait-model.json',import.meta.url)));
 const catalogue=JSON.parse(fs.readFileSync(new URL('../web/data/parks.json',import.meta.url)));
 const model=models.parks.find(m=>m.parkId==='land'),base=catalogue.parks[0].activities.find(a=>a.id===model.activityIds[0]);
 const shifted={...base,dailySchedules:{'2026-11-18':{closed:false,windows:[[600,1260]]}}};
 const explicit={...base,windows:[[600,1260]],dailySchedules:undefined};
 const s=options({waitModel:model});assert.deepEqual(estimateWait(shifted,610,s),estimateWait(explicit,610,s));
});
