import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWeatherForPlan,foodLinks,genreOf,defaultSettings,activitySchedule,chooseCatalogue,catalogueRefreshNotice} from '../web/app.js';
import {fetchWeather,forecastForSettings,fetchPublishedModel,fetchPublishedCatalogue,fetchPublishedCalendar,validateCalendarData,renderCorrelations,correlationNumbers,describeWaitModel} from '../web/wait-data.js';

const settings={date:'2026-11-20',entry:1020,exit:1260,weather:'sun',weatherMode:'auto',weatherForecast:{date:'2026-11-19',weather:'rain',hours:[]}};
const park={id:'sea'};
test('failed remote refresh retains newer bundled facts and visibly reports the failed attempt',()=>{
 const bundled={pipelineVersion:2,fetchedAt:'2026-11-17T12:00:00Z',parks:[{name:'new facts'}]};
 const remote={pipelineVersion:2,fetchedAt:'2026-11-16T12:00:00Z',parks:[{name:'old facts'}],updateStatus:'failed',refreshAttempt:{checkedAt:'2026-11-17T13:00:00Z',status:'failed'}};
 const chosen=chooseCatalogue(bundled,remote);
 assert.equal(chosen.parks,bundled.parks);assert.equal(chosen.fetchedAt,bundled.fetchedAt);assert.match(catalogueRefreshNotice(chosen),/公式サイトから取得できませんでした/);assert.equal(bundled.refreshAttempt,undefined);
 const tied={...remote,fetchedAt:bundled.fetchedAt};assert.equal(chooseCatalogue(bundled,tied),tied);
 assert.equal(chooseCatalogue(bundled,{...remote,pipelineVersion:1}),bundled);
 assert.match(catalogueRefreshNotice({...chosen,refreshAttempt:{...remote.refreshAttempt,status:'partial'}}),/一部/);
 const laterBundledAttempt={...bundled,updateStatus:'failed',refreshAttempt:{checkedAt:'2026-11-17T15:00:00Z',status:'failed'}};
 const newerFacts={...bundled,fetchedAt:'2026-11-17T14:00:00Z',parks:[{name:'newer facts'}],updateStatus:'complete',refreshAttempt:{checkedAt:'2026-11-17T14:00:00Z',status:'complete'}};
 const combined=chooseCatalogue(laterBundledAttempt,newerFacts);assert.equal(combined.parks,newerFacts.parks);assert.match(catalogueRefreshNotice(combined),/取得できませんでした/);
 assert.equal(catalogueRefreshNotice(chooseCatalogue(laterBundledAttempt,{...newerFacts,fetchedAt:'2026-11-17T16:00:00Z',refreshAttempt:{checkedAt:'2026-11-17T16:00:00Z',status:'complete'}})),'');
});
const forecast={date:'2026-11-20',weather:'rain',provider:'open-meteo',sourceUrl:'https://open-meteo.com/',fetchedAt:'2026-11-17T12:00:00Z',hours:[{minute:540,weather:'rain',temperature:18,precipitation:5,precipitationProbability:90},{minute:1020,weather:'cloud',temperature:16,precipitation:0,precipitationProbability:10},{minute:1080,weather:'sun',temperature:15,precipitation:0,precipitationProbability:0}]};
test('planning defaults to automatic weather and manual mode does not contact a provider',async()=>{
 assert.equal(defaultSettings().weatherMode,'auto');let calls=0;
 const result=await prepareWeatherForPlan({...settings,weatherMode:'manual'},park,{fetchWeatherImpl:async()=>{calls++;throw Error('must not fetch');}});
 assert.equal(calls,0);assert.equal(result.weather,'sun');assert.equal(result.weatherForecast,null);
});
test('forecast request uses the visit date and only the visit hours determine summary weather',async()=>{
 let requested;
 const result=await prepareWeatherForPlan(settings,park,{fetchWeatherImpl:async(date,options)=>{requested={date,park:options.park};return forecast;}});
 assert.equal(requested.date,'2026-11-20');assert.equal(requested.park.id,'sea');assert.equal(result.weather,'cloud');
 assert.equal(result.weatherForecast.temperatureMax,16);assert.equal(result.weatherForecast.precipitationProbability,10);
 assert.deepEqual(result.weatherForecast.hours,forecast.hours);assert.equal(settings.weather,'sun');
});
test('weather failures visibly fall back to selected weather and clear stale hourly profiles',async()=>{
 const result=await prepareWeatherForPlan(settings,park,{fetchWeatherImpl:async()=>{throw Error('HTTP 503');}});
 assert.equal(result.weather,'sun');assert.equal(result.weatherForecast,null);assert.match(result.weatherNotice,/HTTP 503/);assert.match(result.weatherNotice,/晴れ.*計画/);
});
test('cancelling weather retrieval never becomes a silent fallback plan',async()=>{
 const controller=new AbortController();const task=prepareWeatherForPlan(settings,park,{signal:controller.signal,fetchWeatherImpl:async(date,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))});
 controller.abort();await assert.rejects(task,{name:'AbortError'});
});
test('missing forecast values are not converted into an apparently valid weather profile',async()=>{
 const result=await prepareWeatherForPlan(settings,park,{fetchWeatherImpl:async()=>({...forecast,hours:[{minute:1020,weather:'sun',temperature:null}]})});
 assert.equal(result.weatherForecast,null);assert.match(result.weatherNotice,/取得できません/);
});
test('weather includes measured precipitation and ignores hours with missing weather codes',async()=>{
 const result=await fetchWeather('2026-11-17',{now:Date.parse('2026-11-17T00:00Z'),fetchImpl:async(url)=>{
  assert.ok(url.includes('precipitation,'));return {ok:true,json:async()=>({hourly:{time:['2026-11-17T09:00','2026-11-17T10:00'],temperature_2m:[15,16],weather_code:[61,null],precipitation:[3,0],precipitation_probability:[75,0]}})};
 }});
 assert.equal(result.hours.length,1);assert.equal(result.hours[0].precipitation,3);assert.equal(result.weather,'rain');
});
test('restaurant and cafe selection is separated from quick snacks and popcorn',()=>{
 assert.equal(genreOf('restaurant'),'dining');assert.equal(genreOf('cafe'),'dining');assert.equal(genreOf('snack'),'snacks');assert.equal(genreOf('popcorn'),'snacks');
 const html=foodLinks({category:'snack',sourceUrl:'https://www.tokyodisneyresort.jp/tds/restaurant/1/',menuUrl:'https://www.tokyodisneyresort.jp/tds/restaurant/1/menu.html',menuItems:[{name:'<script>test</script>'}],menuCheckedOn:'2026-11-17'});
 assert.ok(html.includes('/1/menu.html'));assert.match(html,/店舗・売り場/);assert.match(html,/メニューを見る/);assert.ok(html.includes('&lt;script&gt;'));assert.equal(html.includes('<script>'),false);assert.equal(html.includes('<button'),false);
 assert.equal(foodLinks({category:'attraction'}),'');
});
test('calendar downloads validate coverage and use the packaged fallback after provider failure',async()=>{
 const calendar={schemaVersion:1,updatedAt:'2026-11-17T12:00:00Z',sourceUrl:'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv',coverage:{startDate:'2026-01-01',endDate:'2027-12-31'},holidays:[{date:'2026-11-23',name:'勤労感謝の日'}]};
 assert.equal(validateCalendarData(calendar),true);assert.equal(validateCalendarData({...calendar,sourceUrl:'javascript:bad'}),false);assert.equal(validateCalendarData({...calendar,holidays:[{date:'2028-01-01',name:'範囲外'}]}),false);
 let calls=0;const result=await fetchPublishedCalendar({fetchImpl:async()=>++calls===1?{ok:false,status:404}:{ok:true,json:async()=>calendar}});assert.deepEqual(result,calendar);assert.equal(calls,2);
 await assert.rejects(()=>fetchPublishedCatalogue({fetchImpl:async()=>({ok:true,json:async()=>({parks:[]})})}),/カタログ/);
});
test('correlation summaries respect sample gates and escape data labels',()=>{
 const model={correlations:{weather:[{label:'雨<script>',samples:4,days:2,meanWait:45,meanRatio:1.3},{label:'晴れ',samples:10,days:3,meanWait:20,meanRatio:.8}],temperature:{r:.45,samples:30,days:4},precipitation:{r:.9,samples:3,days:1}}};
 const html=renderCorrelations(model,'weather');assert.ok(html.includes('雨&lt;script&gt;'));assert.ok(html.includes('記録不足'));assert.ok(html.includes('20.0分'));assert.equal(html.includes('45.0分'),false);
 const numeric=correlationNumbers(model);assert.ok(numeric.includes('r=0.45'));assert.equal(numeric.includes('0.90'),false);
});
test('a model fitted through the visit date is visibly excluded from prediction',()=>{
 const model={status:'trained',samples:100,days:7,lastDate:'2026-11-17',usable:true,validation:{modelMae:5,baselineMae:12}};
 const today=describeWaitModel(model,{date:'2026-11-17'});assert.match(today,/2026-11-18以降/);assert.match(today,/選択日は対象外/);assert.equal(today.includes('改善した学習モデルを使います'),false);
 assert.match(describeWaitModel(model,{date:'2026-11-18'}),/改善した学習モデルを使います/);
 assert.match(describeWaitModel(model,{date:'2026-11-18',crowdMode:'manual'}),/手動の待ち時間/);
});

test('verified daily schedules and future closure intervals are reflected in the selected visit date',()=>{
 const a={windows:[[540,1260]],showTimesDate:'2026-11-17',showTimes:[600],dailySchedules:{'2026-11-20':{windows:[[600,1200]],showTimes:[660,780],closed:false}},closedPeriods:[{startDate:'2026-11-22',endDate:null}]};
 const daily=activitySchedule(a,'2026-11-20');assert.deepEqual(daily.showTimes,[660,780]);assert.deepEqual(daily.windows,[[600,1200]]);assert.equal(daily.confirmed,true);
 assert.equal(activitySchedule(a,'2026-11-21').confirmed,false);assert.equal(activitySchedule(a,'2026-11-23').closed,true);
});
test('a cold remote model cannot hide a usable model packaged with the app',async()=>{
 const trained={schemaVersion:1,method:'ridge-regression',parkId:'land',status:'trained',usable:true,trainedAt:'2026-11-17T01:00Z',beforeDate:'2026-11-17',firstDate:'2026-11-10',lastDate:'2026-11-16',days:7,samples:120,activityIds:['land-a'],coefficients:Array(8).fill(.1),validation:{method:'later-days-holdout',trainThrough:'2026-11-14',testFrom:'2026-11-15',testThrough:'2026-11-16',testSamples:20,modelMae:5,baselineMae:20}};
 const cold={...trained,status:'insufficient-data',usable:false,trainedAt:'2026-11-17T12:00Z',samples:0,days:0,activityIds:[],coefficients:[],validation:null};
 let calls=0;const chosen=await fetchPublishedModel({id:'land'},{fetchImpl:async url=>{calls++;return {ok:true,json:async()=>({parks:[url.startsWith('https:')?cold:trained]})};}});
 assert.equal(calls,2);assert.equal(chosen.status,'trained');assert.equal(chosen.usable,true);assert.equal(chosen.samples,120);
});

test('failed or manual weather never leaves an old forecast visible as the active source',()=>{
 assert.equal(forecastForSettings({...settings,weatherForecast:null}),null);
 assert.equal(forecastForSettings({...settings,weatherForecast:forecast,weatherMode:'manual'}),null);
 assert.equal(forecastForSettings({...settings,weatherForecast:{...forecast,date:'2026-11-19'}}),null);
 assert.equal(forecastForSettings({...settings,weatherForecast:forecast}),forecast);
});
