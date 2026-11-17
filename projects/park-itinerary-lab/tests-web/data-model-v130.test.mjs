import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarContext,weatherAtMinute,waitFeatures,WAIT_BASE_FEATURE_NAMES} from '../web/calendar-features.js';
import {trainWaitModel,predictModelWait,validateWaitModel} from '../web/wait-model.js';
const calendar={schemaVersion:1,coverage:{startDate:'2026-01-01',endDate:'2027-12-31'},holidays:[{date:'2026-11-23',name:'勤労感謝の日'}],sourceUrl:'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html'};
const park={id:'land',activities:[{id:'land-a',baseWait:40,windows:[[540,1260]]},{id:'land-b',baseWait:40,windows:[[540,1260]]}],events:[{id:'fest-a',name:'A',startDate:'2026-11-01',endDate:'2026-11-15'},{id:'fest-b',name:'B',startDate:'2026-11-16',endDate:'2026-11-30'}]};
function rows(){const result=[];for(let day=1;day<=28;day++)for(const activity of park.activities)for(let hour=9;hour<=20;hour++)result.push({date:`2026-11-${String(day).padStart(2,'0')}`,activityId:activity.id,time:hour*60,wait:(activity.id==='land-a'?(hour===9?10:50):(hour===9?45:15))+(day<=15?25:0),weather:day%2?'sun':'rain',temperature:day%2?22:14,precipitation:day%2?0:2,event:day<=15?'fest-a':'fest-b'});return result;}

test('official holiday coverage distinguishes holidays, adjacent days and unknown years',()=>{
 assert.equal(calendarContext('2026-11-23',calendar).isHoliday,true);assert.equal(calendarContext('2026-11-22',calendar).beforeHoliday,true);assert.equal(calendarContext('2026-11-24',calendar).afterHoliday,true);
 assert.equal(calendarContext('2030-11-23',calendar).holidayKnown,false);assert.equal(calendarContext('2030-11-23',calendar).isHoliday,false);assert.equal(calendarContext('2026-02-30',calendar),null);
});
test('queue-time weather uses that hour without borrowing a later forecast or daily worst weather',()=>{
 const settings={weather:'cloud',weatherForecast:{date:'2026-11-17',hours:[{minute:540,weather:'sun',temperature:16,precipitation:0},{minute:1080,weather:'rain',temperature:10,precipitation:4}]}};
 assert.equal(weatherAtMinute('2026-11-17',570,settings).weather,'sun');assert.equal(weatherAtMinute('2026-11-17',1100,settings).weather,'rain');assert.equal(weatherAtMinute('2026-11-17',500,settings).weather,'cloud');assert.equal(weatherAtMinute('2026-11-18',570,settings).weather,'cloud');
});
test('features encode weekday, seasonal phase, named events and opening ramp independently',()=>{
 const activity=park.activities[0],early=waitFeatures({date:'2026-11-23',minute:540,eventIds:['fest-a'],weather:'sun'},{activity,eventIds:['fest-a','fest-b'],calendarData:calendar}),later=waitFeatures({date:'2026-11-23',minute:630,eventIds:['fest-b'],weather:'rain'},{activity,eventIds:['fest-a','fest-b'],calendarData:calendar});
 assert.equal(early[WAIT_BASE_FEATURE_NAMES.indexOf('holiday')],1);assert.equal(early[WAIT_BASE_FEATURE_NAMES.indexOf('weekday_1')],1);assert.equal(early[WAIT_BASE_FEATURE_NAMES.indexOf('opening_90min')],0);assert.equal(later[WAIT_BASE_FEATURE_NAMES.indexOf('opening_90min')],1);assert.deepEqual(early.slice(-2),[1,0]);assert.deepEqual(later.slice(-2),[0,1]);
});
test('schema2 fits independent event effects and publishes protected multi-day profiles and correlations',()=>{
 const model=trainWaitModel(rows(),park,{beforeDate:'2026-12-01',calendarData:calendar,dataSources:[{name:'Test observations',url:'https://example.com/observations',kind:'fixture',attribution:'Test source'}]});
 assert.equal(model.schemaVersion,2);assert.equal(model.status,'trained');assert.equal(model.coefficients.length,model.featureNames.length+model.activityIds.length);assert.equal(validateWaitModel(model),true);assert.deepEqual(model.eventIds,['fest-a','fest-b']);assert.equal(model.dataSources[0].attribution,'Test source');
 assert.ok(model.validation.trainThrough<model.validation.testFrom);assert.ok(model.activityTimeProfiles.every(profile=>profile.samples>=5&&profile.days>=2));assert.ok(model.correlations.weather.every(group=>group.samples>=5&&group.days>=2));assert.ok(Number.isFinite(model.correlations.temperature.r));assert.equal(model.correlations.holiday.find(group=>group.key==='holiday').meanWait,null);assert.ok(!JSON.stringify(model).includes('observedAt'));
 const base={date:'2026-12-01',weather:'sun',calendarData:calendar},a=predictModelWait(park.activities[0],600,{...base,activeEvents:[{id:'fest-a'}]}, {...model,usable:true}),b=predictModelWait(park.activities[0],600,{...base,activeEvents:[{id:'fest-b'}]}, {...model,usable:true});
 assert.ok(a.minutes>b.minutes+10);assert.equal(predictModelWait(park.activities[0],600,{...base,date:model.lastDate},model),null);
});
test('ten-minute opening samples survive and missing values never become artificial zero waits',()=>{
 const records=[{date:'2026-11-01',activityId:'land-a',time:543,wait:5},{date:'2026-11-01',activityId:'land-a',time:569,wait:40},...[null,'',false].map(wait=>({date:'2026-11-02',activityId:'land-a',time:600,wait}))];
 const model=trainWaitModel(records,park,{beforeDate:'2026-11-17'});assert.equal(model.samples,2);assert.equal(model.status,'insufficient-data');assert.equal(model.correlations.weekday[0].meanWait,null);
});
test('large datasets retain early months instead of discarding all but the newest records',()=>{
 const activities=Array.from({length:40},(_,i)=>({id:'land-'+i,baseWait:40,windows:[[540,1260]]})),p={id:'land',activities,events:[]},records=[];
 for(let day=0;day<100;day++){const date=new Date(Date.UTC(2025,0,1+day)).toISOString().slice(0,10);for(const activity of activities)for(let hour=6;hour<21;hour++)records.push({date,activityId:activity.id,time:hour*60,wait:20,weather:'sun'});}
 const model=trainWaitModel(records,p,{beforeDate:'2025-05-01'});assert.equal(model.availableSamples,60000);assert.equal(model.samples,50000);assert.equal(model.firstDate,'2025-01-01');assert.equal(model.lastDate,'2025-04-10');assert.equal(model.days,100);assert.equal(model.sampling,'calendar-balanced');assert.equal(validateWaitModel(model),true);
});
test('legacy v1 coefficients still predict and malformed schema2 feature order is rejected',()=>{
 const old={schemaVersion:1,method:'ridge-regression',parkId:'land',status:'trained',usable:true,activityIds:['land-a'],coefficients:[.5,0,0,0,0,0,0,0],days:7,samples:120,lastDate:'2026-11-16',validation:{method:'later-days-holdout',trainThrough:'2026-11-14',testFrom:'2026-11-15',testThrough:'2026-11-16',testSamples:20,modelMae:2,baselineMae:8}};
 assert.equal(predictModelWait(park.activities[0],600,{date:'2026-11-17'},old).minutes,20);
 const model=trainWaitModel(rows(),park,{beforeDate:'2026-12-01'});model.featureNames.reverse();assert.equal(validateWaitModel(model),false);
});
test('malformed calendar or forecast fields cannot crash feature calculation',()=>{
 assert.doesNotThrow(()=>calendarContext('2026-11-17',{coverage:calendar.coverage,holidays:'not-an-array'}));
 assert.equal(weatherAtMinute('2026-11-17',600,{weather:'sun',weatherForecast:{date:'2026-11-17',hours:[null,3]}}).weather,'sun');
 const model=trainWaitModel(rows(),park,{beforeDate:'2026-12-01'});assert.equal(validateWaitModel({...model,calendarData:{holidays:'bad'}}),false);
 assert.equal(validateWaitModel({...model,dataSources:[{name:'X',url:'javascript:alert(1)',attribution:'X'}]}),false);
 assert.equal(predictModelWait(park.activities[0],NaN,{date:'2026-12-01'},model),null);
});
test('schema2 metadata cannot claim an impossible target or future validation period',()=>{
 const model=trainWaitModel(rows(),park,{beforeDate:'2026-12-01'});
 assert.equal(validateWaitModel({...model,beforeDate:model.lastDate}),false);
 assert.equal(validateWaitModel({...model,validation:{...model.validation,testThrough:'2026-12-20'}}),false);
 assert.equal(validateWaitModel({...model,firstDate:'2026-12-02'}),false);
});
