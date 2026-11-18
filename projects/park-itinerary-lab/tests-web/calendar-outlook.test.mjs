import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarDayOutlook, calendarDayPreview} from '../web/calendar-outlook.js';
import {forecastDateRange, prepareWeatherForVisit} from '../web/weather.js';

const now = Date.parse('2026-12-31T15:00:00Z'); // January 1, midnight in Japan
const date = '2027-01-01';
const park = {id:'land', activities:[]};
const settings = {entry:600, exit:720, weatherMode:'manual', weather:'sun'};
const weatherFor = (day, extra={}) => calendarDayOutlook(park, {...settings, ...extra}, day, {now}).weather;

test('weather request window includes today and day 15 in Japan, across the new year', () => {
  assert.deepEqual(forecastDateRange(now-1), {startDate:'2026-12-31',endDate:'2027-01-15'});
  assert.deepEqual(forecastDateRange(now), {startDate:date,endDate:'2027-01-16'});
  assert.equal(weatherFor('2026-12-31'), 'outside');
  assert.equal(weatherFor(date), 'eligible');
  assert.equal(weatherFor('2027-01-16'), 'eligible');
  assert.equal(weatherFor('2027-01-17'), 'outside');
  assert.equal(weatherFor('2027-02-29'), 'outside');
});

test('only usable forecasts with actual coverage inside the visit get the confirmed mark', async () => {
  const hours = [{time:date+'T10:00', minute:600, weather:'rain', weatherFromMinute:630, weatherToMinute:660}];
  const forecast = {date, provider:'jma', fetchedAt:new Date(now).toISOString(), issuedAt:new Date(now).toISOString(), hours};
  const state = {weatherForecast:forecast};
  assert.equal(weatherFor(date,state), 'confirmed');
  const lateOpening = {...park,operatingCalendar:{[date]:{windows:[[660,1200]]}}};
  assert.equal(calendarDayOutlook(lateOpening,{...settings,...state},date,{now}).weather,'eligible');
  assert.equal(calendarDayPreview(lateOpening,{...settings,...state,weatherMode:'auto'},date,{now}).weather.label,'予報未取得');
  assert.equal(weatherFor(date,{...state,entry:600,exit:630}), 'eligible');
  assert.equal(weatherFor(date,{...state,entry:660,exit:720}), 'eligible');
  const prepare = exit => prepareWeatherForVisit({...settings,date,weatherMode:'auto',exit},park,{fetchWeatherImpl:async()=>forecast});
  assert.equal((await prepare(630)).weatherForecast, null);
  assert.equal((await prepare(660)).weather, 'rain');
  assert.equal(weatherFor('2027-01-02',state), 'eligible');
  assert.equal(weatherFor(date,{weatherForecast:{...forecast, hours:[{...hours[0],time:'2026-12-31T10:00'}]}}), 'eligible');
  assert.equal(weatherFor(date,{weatherForecast:{...forecast, fetchedAt:new Date(now-13*3600000).toISOString()}}), 'eligible');
  assert.equal(weatherFor(date,{weatherForecast:{...forecast, issuedAt:new Date(now-37*3600000).toISOString()}}), 'eligible');
});

test('model loading does not block the independent weather status', () => {
  assert.deepEqual(calendarDayOutlook(park, settings, date, {now, pendingModel:true}), {weather:'eligible',crowd:'pending'});
  assert.deepEqual(calendarDayOutlook(park, settings, date, {now}), {weather:'eligible',crowd:'calendar'});
});

test('browsing preserves manual choices, shows only known fares, and distinguishes missing forecasts', () => {
  const next = {...settings,date,weather:'rain',crowdLevel:'quiet'};
  const ticketPark = {...park,ticketCalendar:{[date]:{adultOneDayYen:10900,adultKnownSince:new Date(now).toISOString()}}};
  const manual = calendarDayPreview(ticketPark,next,date,{now,pendingModel:true});
  assert.deepEqual(manual,{ticket:'10,900円', weather:{label:'雨',detail:'手動設定'},crowd:{label:'比較的すいている',detail:'手動設定'}});
  const out = calendarDayPreview(ticketPark,{...next,weatherMode:'auto',crowdLevel:'auto',weatherForecast:{date}},'2028-02-12',{now});
  assert.equal(out.ticket,null);
  assert.equal(out.weather.label,'予報の対象外');
  assert.match(out.weather.detail,/晴れ/);
  assert.equal(out.crowd.label,'混み合う');
  assert.match(out.crowd.detail,/曜日・祝日/);
  const pending = calendarDayPreview(park,{...next,weatherMode:'auto',crowdLevel:'auto'},date,{now,pendingModel:true});
  assert.equal(pending.weather.label,'予報未取得');
  assert.equal(pending.crowd.label,'確認中…');
});
