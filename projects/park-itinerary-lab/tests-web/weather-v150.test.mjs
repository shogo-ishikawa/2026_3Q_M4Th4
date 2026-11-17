import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchWeather,normaliseOpenMeteo,normaliseJma,prepareWeatherForVisit,weatherForMinute,formatWeatherDetails,forecastCacheLabel} from '../web/weather.js';

const now=Date.parse('2026-11-17T08:00:00Z'),date='2026-11-18';
const response=data=>({ok:true,json:async()=>data});
const openData={hourly:{time:[`${date}T09:00`,`${date}T10:00`],temperature_2m:[14,15],weather_code:[0,3],precipitation:[0,.2],precipitation_probability:[0,20]}};
function jmaData(){return [
  {reportDatetime:'2026-11-17T17:00:00+09:00',timeSeries:[
    {timeDefines:[`${date}T00:00:00+09:00`],areas:[{area:{code:'120010'},weatherCodes:['202'],weathers:['くもり 後 晴れ']}]},
    {timeDefines:[`${date}T00:00:00+09:00`,`${date}T06:00:00+09:00`,`${date}T12:00:00+09:00`,`${date}T18:00:00+09:00`],areas:[{area:{code:'120010'},pops:['80','20','10','10']}]},
    {timeDefines:[`${date}T00:00:00+09:00`,`${date}T09:00:00+09:00`],areas:[{area:{code:'45212'},temps:['10','20']}]}
  ]},
  {reportDatetime:'2026-11-17T11:00:00+09:00',timeSeries:[
    {timeDefines:['2026-11-19T00:00:00+09:00'],areas:[{area:{code:'120000'},weatherCodes:['100'],pops:[''],reliabilities:['A']}]},
    {timeDefines:['2026-11-19T00:00:00+09:00'],areas:[{area:{code:'45148',name:'銚子'},tempsMin:['11'],tempsMax:['19']}]}
  ]}
];}
function seriesData(){return {reportDateTime:'2026-11-17T17:00:00+09:00',areaTimeSeries:{timeDefines:[{dateTime:`${date}T09:00:00+09:00`,duration:'PT3H'},{dateTime:`${date}T12:00:00+09:00`,duration:'PT3H'}],weather:['晴れ','くもり']},pointTimeSeries:{pointNameEN:'Chiba',timeDefines:[{dateTime:`${date}T09:00:00+09:00`},{dateTime:`${date}T12:00:00+09:00`}],temperature:[14,19]}};}

test('requests only the selected date and reuses a date-specific forecast without another network request',async()=>{
  const urls=[],fetchImpl=async url=>{urls.push(url);if(url.includes('api.open-meteo.com'))return response(openData);throw Error('not found');};
  const first=await fetchWeather(date,{fetchImpl,now});
  assert.equal(first.provider,'open-meteo');assert.equal(first.hours[0].precipitation,.2);assert.equal(first.hours[1].precipitation,null);
  assert.match(urls[0],new RegExp(`start_date=${date}&end_date=${date}`));assert.equal(urls[0].includes('forecast_days=16'),false);
  const calls=urls.length;const cached=await fetchWeather(date,{fetchImpl,now:now+60000});assert.equal(urls.length,calls);assert.equal(cached.transport,'session-cache');assert.equal(cached.cacheAgeMinutes,1);
});

test('an unresponsive provider has a bounded timeout and falls back to official JMA data',async()=>{
  const fetchImpl=async url=>{
    if(url.includes('/data/forecast/'))return response(jmaData());
    if(url.includes('/VPFD/'))return response(seriesData());
    return new Promise(()=>{});
  };
  const started=Date.now(),forecast=await fetchWeather(date,{fetchImpl,now,timeoutMs:15});
  assert.ok(Date.now()-started<1000);assert.equal(forecast.provider,'jma');
  const info=weatherForMinute({date,weatherForecast:forecast},630);
  assert.equal(info.temperature,14);assert.match(info.temperaturePeriodLabel,/09:00/);assert.equal(info.precipitationProbability,20);assert.equal(info.precipitation,null);
  assert.match(formatWeatherDetails(info),/3時間/);assert.match(formatWeatherDetails(info),/06:00〜12:00（6時間）/);assert.match(formatWeatherDetails(info),/降水量 未提供/);
});

test('missing JMA fields stay missing and daily temperature extrema are not hourly samples',async()=>{
  const data=jmaData();data[0].timeSeries[1].areas[0].pops[1]='';
  const forecast=normaliseJma(data,null,date,{fetchedAt:new Date(now).toISOString()});
  const row=forecast.hours[9];assert.equal(row.temperature,null);assert.equal(row.temperatureMin,10);assert.equal(row.temperatureMax,20);assert.equal(row.precipitationProbability,null);assert.equal(row.precipitation,null);
  assert.match(formatWeatherDetails(weatherForMinute({date,weatherForecast:forecast},540)),/気温 10〜20℃.*日最低／最高/);
  const prepared=await prepareWeatherForVisit({date,entry:540,exit:1260,weatherMode:'auto',weather:'sun'},{},{fetchWeatherImpl:async()=>forecast});assert.equal(prepared.weatherForecast.provider,'jma');assert.match(prepared.weatherNotice,/降水量は未提供/);
  data[0].timeSeries[2].timeDefines=[`${date}T09:00:00+09:00`];data[0].timeSeries[2].areas[0].temps=['20'];
  const maximumOnly=normaliseJma(data,null,date);assert.equal(maximumOnly.hours[9].temperatureMin,null);assert.match(formatWeatherDetails(weatherForMinute({date,weatherForecast:maximumOnly},540)),/最高20℃/);
});

test('JMA daily/weekly forecast uses its actual issue time and region, and missing PoP is not zero',()=>{
  const forecast=normaliseJma(jmaData(),seriesData(),'2026-11-19');
  assert.equal(forecast.issuedAt,'2026-11-17T11:00:00+09:00');assert.equal(forecast.precipitationProbability,null);assert.equal(forecast.hours[9].temperature,null);assert.match(forecast.hours[9].temperaturePeriodLabel,/銚子/);assert.equal(forecast.hours[9].weatherPeriodLabel,'千葉県・日予報');
});

test('a differently issued three-hour feed does not get combined into a new JMA forecast',()=>{
  const series=seriesData();series.reportDateTime='2026-11-17T11:00:00+09:00';
  const forecast=normaliseJma(jmaData(),series,date);assert.equal(forecast.hours[9].temperature,null);assert.match(forecast.hours[9].weatherPeriodLabel,/日予報/);
});

test('a fast published cache avoids a stalled direct request and preserves collection time',async()=>{
  const fetchedAt=new Date(now-3600000).toISOString();
  const fetchImpl=async url=>url.includes('weather-forecast.json')?response({schemaVersion:1,providers:{'open-meteo':{fetchedAt,data:openData}}}):new Promise(()=>{});
  const forecast=await fetchWeather(date,{fetchImpl,now,timeoutMs:100});assert.equal(forecast.transport,'published-cache');assert.equal(forecast.fetchedAt,fetchedAt);assert.equal(forecast.cacheAgeMinutes,60);
});

test('published JMA cache supplies three-hour details without waiting for direct provider requests',async()=>{
  const urls=[],fetchedAt=new Date(now).toISOString();
  const fetchImpl=async url=>{urls.push(url);if(url.includes('weather-forecast.json'))return response({schemaVersion:1,providers:{jma:{fetchedAt,forecast:jmaData(),series:seriesData()}}});throw Error('primary offline');};
  const forecast=await fetchWeather(date,{fetchImpl,now,timeoutMs:20}),info=weatherForMinute({date,weatherForecast:forecast},630);
  assert.equal(forecast.provider,'jma');assert.equal(info.temperature,14);assert.match(info.temperaturePeriodLabel,/09:00/);assert.match(info.weatherPeriodLabel,/3時間/);assert.equal(urls.some(url=>url.includes('/VPFD/')),false);
});

test('last good cache is explicitly stale after refresh failure and expires after twelve hours',async()=>{
  let fail=false;const fetchImpl=async url=>!fail&&url.includes('api.open-meteo.com')?response(openData):Promise.reject(Error('offline'));
  await fetchWeather(date,{fetchImpl,now});fail=true;
  const cached=await fetchWeather(date,{fetchImpl,now:now+31*60000,timeoutMs:10});assert.equal(cached.transport,'last-good-cache');assert.equal(cached.stale,true);assert.match(forecastCacheLabel(cached),/31分前/);
  await assert.rejects(()=>fetchWeather(date,{fetchImpl,now:now+13*3600000,timeoutMs:10}),/offline/);
});

test('external cancellation stops retrieval and never turns into a weather fallback or cached result',async()=>{
  const controller=new AbortController(),urls=[];
  const pending=fetchWeather(date,{signal:controller.signal,now,fetchImpl:async url=>{urls.push(url);return new Promise(()=>{});},timeoutMs:1000});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(urls.some(url=>url.includes('jma.go.jp')),false);
});

test('hourly values end at their stated interval and manual mode hides remote weather',()=>{
  const forecast=normaliseOpenMeteo(openData,date),settings={date,weatherForecast:forecast};
  assert.equal(weatherForMinute(settings,599).temperature,14);assert.equal(weatherForMinute(settings,600).temperature,15);assert.equal(weatherForMinute(settings,660),null);assert.equal(weatherForMinute({...settings,weatherMode:'manual'},540),null);
  assert.match(formatWeatherDetails(weatherForMinute(settings,540)),/09:00〜10:00（1時間雨量）/);
});

test('a 10:25 activity keeps the 10:00 instant weather and uses the containing 10:00–11:00 rain and probability',async()=>{
  const raw={hourly:{time:[`${date}T09:00`,`${date}T10:00`,`${date}T11:00`],temperature_2m:[13,14,18],weather_code:[3,0,61],precipitation:[9,1,4],precipitation_probability:[95,10,80]}};
  const forecast=normaliseOpenMeteo(raw,date),settings={date,entry:625,exit:640,weatherMode:'auto',weather:'sun',weatherForecast:forecast};
  const info=weatherForMinute(settings,625);
  assert.equal(info.temperature,14);assert.equal(info.weather,'sun');assert.equal(info.precipitation,4);assert.equal(info.precipitationProbability,80);
  assert.match(formatWeatherDetails(info),/10:00〜11:00（1時間雨量）/);
  assert.equal(forecast.precipitationProbability,80);
  const prepared=await prepareWeatherForVisit(settings,{},{fetchWeatherImpl:async()=>forecast});
  assert.equal(prepared.weatherForecast.temperatureMin,14);assert.equal(prepared.weatherForecast.temperatureMax,14);assert.equal(prepared.weatherForecast.precipitationProbability,80);
});

test('missing exact next hour, missing fields and a final 23:00 slot remain unknown without interpolation',()=>{
  const raw={hourly:{time:[`${date}T10:00`,`${date}T12:00`,`${date}T23:00`],temperature_2m:[14,18,12],weather_code:[0,0,0],precipitation:[1,9,3],precipitation_probability:[10,90,30]}};
  let forecast=normaliseOpenMeteo(raw,date);
  for(const row of forecast.hours){assert.equal(row.precipitation,null);assert.equal(row.precipitationProbability,null);}
  raw.hourly.time.push('2026-11-19T00:00');raw.hourly.temperature_2m.push(11);raw.hourly.weather_code.push(0);raw.hourly.precipitation.push(null);raw.hourly.precipitation_probability.push(70);
  forecast=normaliseOpenMeteo(raw,date);const info=weatherForMinute({date,weatherForecast:forecast},1425);
  assert.equal(info.precipitation,null);assert.equal(info.precipitationProbability,70);assert.equal(info.probabilityPeriodLabel,'23:00〜24:00（1時間）');
});

test('an old end-labelled session cache is bypassed after the normalisation changes',async()=>{
  const saved=globalThis.sessionStorage,legacy=normaliseOpenMeteo(openData,date,{fetchedAt:new Date(now).toISOString()});let calls=0;
  legacy.hours[0].precipitation=99;
  const store=new Map([['park-weather-v150',JSON.stringify({[date]:legacy})]]);
  globalThis.sessionStorage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)};
  try{
    const result=await fetchWeather(date,{now,useSessionCache:true,fetchImpl:async url=>{calls++;if(url.includes('api.open-meteo.com'))return response(openData);throw Error('not found');}});
    assert.ok(calls>0);assert.equal(result.hours[0].precipitation,.2);
  }finally{globalThis.sessionStorage=saved;}
});
