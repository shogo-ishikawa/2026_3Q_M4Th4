import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedForecastForDate, fetchWeather, warmCalendarWeather} from '../web/weather.js';

const now = Date.parse('2026-11-19T00:00Z');
const today = '2026-11-19', tomorrow = '2026-11-20';
const response = data => ({ok:true, json:async () => data});
const hourly = dates => ({hourly:{
  time:dates.map(date => date + 'T09:00'),
  temperature_2m:dates.map(() => 15),
  weather_code:dates.map(() => 3)
}});
const bulletin = dates => ({schemaVersion:1, providers:{'open-meteo':{
  fetchedAt:new Date(now).toISOString(), data:hourly(dates)
}}});

test('one public download serves the month and the normal date selection without probing other days', async () => {
  const calls = [];
  let release;
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('weather-forecast.json')) return new Promise(resolve => {release = resolve;});
    throw Error('offline');
  };
  const warming = warmCalendarWeather({fetchImpl,now});
  const secondOpen = warmCalendarWeather({fetchImpl,now});
  const visit = fetchWeather(today,{fetchImpl,now});
  release(response(bulletin([today,tomorrow])));
  const [, , selected] = await Promise.all([warming,secondOpen,visit]);
  assert.equal(selected.provider,'open-meteo');
  assert.equal(cachedForecastForDate(tomorrow,now,fetchImpl).hours.length,1);
  assert.equal(cachedForecastForDate('2026-11-21',now,fetchImpl),null);
  assert.equal(cachedForecastForDate('2026-12-05',now,fetchImpl),null);
  await warmCalendarWeather({fetchImpl,now:now+1000});
  assert.equal(calls.filter(url=>url.endsWith('weather-forecast.json')).length,1);
  assert.equal(calls.filter(url=>url.includes('start_date=')).length,1);
});

test('a selected-date cancellation does not discard the calendar bulletin shared with another caller', async () => {
  let release;
  const fetchImpl = async url => url.endsWith('weather-forecast.json')
    ? new Promise(resolve => {release=resolve;}) : new Promise(()=>{});
  const controller = new AbortController();
  const visit=fetchWeather(today,{fetchImpl,now,signal:controller.signal});
  const warming=warmCalendarWeather({fetchImpl,now});
  controller.abort();
  await assert.rejects(visit,{name:'AbortError'});
  release(response(bulletin([tomorrow])));
  await warming;
  assert.equal(cachedForecastForDate(tomorrow,now,fetchImpl).date,tomorrow);
});

test('previously confirmed weather stays usable during an outage up to its source freshness limit',async () => {
  let calls=0, offline=false;
  const fetchImpl=async url=>{
    if (url.endsWith('weather-forecast.json')) {
      calls++;
      if (!offline) return response(bulletin([tomorrow]));
    }
    if (!offline && url.includes('api.open-meteo.com')) return response(hourly([url.includes(tomorrow) ? tomorrow : today]));
    throw Error('offline');
  };
  await fetchWeather(today,{fetchImpl,now});
  assert.equal(cachedForecastForDate(today,now,fetchImpl).date,today);
  offline=true;
  const later=now+31*60000;
  await warmCalendarWeather({fetchImpl,now:later});
  await warmCalendarWeather({fetchImpl,now:later+1000});
  assert.equal(calls,2);
  assert.equal(cachedForecastForDate(tomorrow,later,fetchImpl).date,tomorrow);
  const saved=await fetchWeather(tomorrow,{fetchImpl,now:later});
  assert.equal(saved.stale,true);
  offline=false;
  const recovered=await fetchWeather(tomorrow,{fetchImpl,now:later+1000});
  assert.equal(recovered.transport,'direct');
  assert.equal(recovered.fetchedAt,new Date(later+1000).toISOString());
  assert.equal(cachedForecastForDate(tomorrow,now+13*3600000,fetchImpl),null);
  assert.equal(cachedForecastForDate(today,now+13*3600000,fetchImpl),null);
});
