import test from 'node:test';
import assert from 'node:assert/strict';
import {normaliseOpenMeteo} from '../web/weather.js';
import {visitWeatherSummary} from '../web/weather-view.js';

const date = '2026-11-19';
const now = new Date('2026-11-18T15:05:00Z'); // 00:05 on the selected date in Japan.
const fetchedAt = now.toISOString();
const settings = {date, entry:540, exit:780, weatherMode:'auto', weather:'sun'};

function hourly(samples) {
  return normaliseOpenMeteo({hourly:{
    time:samples.map(([hour]) => date + 'T' + hour + ':00'),
    temperature_2m:samples.map(([,temp]) => temp),
    weather_code:samples.map(([,,code]) => code)
  }}, date, {fetchedAt});
}
function summary(forecast, overrides = {}, options = {}) {
  return visitWeatherSummary({...settings, weatherForecast:forecast, ...overrides}, {now, ...options});
}
const changing = hourly([['08',-3,71],['09',0,0],['10',8,0],['11',12,0],['12',9,61],['13',20,95]]);

test('visit summary shows weather changes at the hour and only the temperatures inside the visit', () => {
  assert.deepEqual(summary(changing), {label:'晴れのち雨', detail:'12:00から雨 · 予報気温 0〜12℃'});
  assert.deepEqual(summary(changing, {entry:735, exit:765}), {label:'雨', detail:''});
  const evening = summary(changing, {entry:720, exit:840});
  assert.equal(evening.label, '雨のち雷雨');
  assert.equal(summary(changing, {entry:480, exit:540}).label, '雪');
  assert.equal(summary(hourly([['09',10,1]]), {exit:600}).label, 'おおむね晴れ');
});

test('incomplete hourly coverage identifies gaps without inventing the time of a change', () => {
  const partial = hourly([['09',4,0],['12',8,61]]);
  assert.deepEqual(summary(partial), {label:'晴れ・雨', detail:'一部時間帯のみ · 予報気温 4〜8℃'});
  assert.equal(summary(partial, {entry:625,exit:710}).label, '滞在中の予報なし');
  const one = summary(partial, {entry:720,exit:780});
  assert.deepEqual(one, {label:'雨', detail:'12:00 8℃'});
});

test('JMA daily forecasts retain the bulletin and daily extrema even when 3h samples are available', () => {
  const hours = [9, 10, 11, 12].map(hour => ({
    minute:hour*60, weather:'cloud', label:hour < 12 ? '晴れ' : 'くもり　後　雨',
    weatherFromMinute:hour < 12 ? 540 : 0, weatherToMinute:hour < 12 ? 720 : 1440,
    weatherPeriodLabel:hour < 12 ? '千葉県北西部・09:00〜12:00（3時間）' : '千葉県北西部・日予報',
    temperature:14, temperatureAtMinute:540, temperatureMin:null, temperatureMax:20
  }));
  const jma = {date, provider:'jma', fetchedAt, issuedAt:fetchedAt, hours};
  assert.deepEqual(summary(jma), {label:'くもり 後 雨', detail:'日予報 · 日最高20℃'});
  assert.deepEqual(summary(jma, {exit:720}), {label:'晴れ', detail:'日最高20℃'});
  const eveningOnly = {...jma, hours:hours.map(row => ({...row,weatherFromMinute:720}))};
  assert.match(summary(eveningOnly).detail, /一部時間帯のみ/);
  assert.equal(summary(eveningOnly, {exit:720}).label, '滞在中の予報なし');
});

test('manual, pending, unavailable and stale forecasts stay distinguishable across JST date changes', () => {
  assert.deepEqual(summary(changing, {weatherMode:'manual',weather:'rain'}, {pending:true}), {label:'雨',detail:'手動設定'});
  assert.deepEqual(summary(changing, {}, {pending:true}), {label:'確認中…',detail:''});
  assert.equal(summary(null).label, '予報未取得');
  assert.equal(summary({...changing,date:'2026-11-20'}).label, '予報未取得');
  assert.equal(summary({...changing,fetchedAt:'2026-11-18T02:00:00Z'}).label, '予報未取得');
  assert.match(summary({...changing,stale:true}).detail, /前回取得の予報/);
  for (const outside of ['2026-11-18', '2026-12-05', '2026-99-99']) {
    assert.equal(summary(changing, {date:outside}, {pending:true}).label, '予報の対象外');
  }
  assert.equal(summary(null, {date:'2026-12-04'}, {pending:true}).label, '確認中…');
});
