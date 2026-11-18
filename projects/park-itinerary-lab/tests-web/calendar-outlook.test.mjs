import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarDayOutlook} from '../web/calendar-outlook.js';
import {forecastDateRange} from '../web/weather.js';

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

test('only usable forecasts with actual coverage inside the visit get the confirmed mark', () => {
  const hours = [{time:date+'T10:00', minute:600, weather:'rain', weatherFromMinute:630, weatherToMinute:660}];
  const forecast = {date, provider:'jma', fetchedAt:new Date(now).toISOString(), issuedAt:new Date(now).toISOString(), hours};
  const state = {weatherForecast:forecast};
  assert.equal(weatherFor(date,state), 'confirmed');
  assert.equal(weatherFor(date,{...state,entry:600,exit:630}), 'eligible');
  assert.equal(weatherFor(date,{...state,entry:660,exit:720}), 'eligible');
  assert.equal(weatherFor('2027-01-02',state), 'eligible');
  assert.equal(weatherFor(date,{weatherForecast:{...forecast, hours:[{...hours[0],time:'2026-12-31T10:00'}]}}), 'eligible');
  assert.equal(weatherFor(date,{weatherForecast:{...forecast, fetchedAt:new Date(now-13*3600000).toISOString()}}), 'eligible');
  assert.equal(weatherFor(date,{weatherForecast:{...forecast, issuedAt:new Date(now-37*3600000).toISOString()}}), 'eligible');
});

test('model loading does not block the independent weather status', () => {
  assert.deepEqual(calendarDayOutlook(park, settings, date, {now, pendingModel:true}), {weather:'eligible',crowd:'pending'});
  assert.deepEqual(calendarDayOutlook(park, settings, date, {now}), {weather:'eligible',crowd:'calendar'});
});
