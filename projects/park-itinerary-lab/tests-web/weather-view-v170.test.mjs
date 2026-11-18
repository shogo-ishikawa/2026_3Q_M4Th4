import test from 'node:test';
import assert from 'node:assert/strict';
import {compactPeriod,forecastCardHtml,forecastSourcesHtml} from '../web/weather-view.js';
import {buildOfflineHtml,buildScheduleCsv,buildCalendar} from '../web/storage.js';

const hourly = extra => ({minute:600,endMinute:660,weather:'sun',label:'晴れ',temperature:0,precipitationProbability:0,precipitation:0,weatherPeriodLabel:'10:00時点・1時間ごと',temperaturePeriodLabel:'10:00時点',probabilityPeriodLabel:'10:00〜11:00（1時間）',precipitationPeriodLabel:'10:00〜11:00（1時間雨量）',provider:'open-meteo',sourceUrl:'https://open-meteo.com/',issuedAt:'2026-11-17T00:00:00Z',fetchedAt:'2026-11-17T00:30:00Z',...extra});

test('hourly cards show actual zero values and one concise rain interval without per-card links', () => {
  const info = hourly(), original = structuredClone(info), markup = forecastCardHtml(info);
  assert.match(markup,/☀️/); assert.match(markup,/>0℃</); assert.match(markup,/>0%</); assert.match(markup,/>0mm</);
  assert.equal((markup.match(/class="forecast-period">10:00–11:00/g)||[]).length,1);
  assert.doesNotMatch(markup,/<a|時点・1時間ごと|取得から|Open-Meteo/);
  assert.match(markup,/aria-label="降水確率 0% 10:00–11:00"/);
  assert.deepEqual(info,original);
});

test('missing values use a dash and an accessible missing label instead of becoming zero', () => {
  const markup = forecastCardHtml(hourly({temperature:null,precipitationProbability:null,precipitation:null}));
  assert.equal((markup.match(/>—</g)||[]).length,3);
  assert.doesNotMatch(markup,/>0℃|>0%|>0mm/);
  assert.match(markup,/aria-label="降水確率 未提供"/);
  assert.match(forecastCardHtml(null),/天気 予報未取得/);
});

test('JMA card keeps 3-hour weather, 6-hour probability and daily temperatures separate', () => {
  const info = hourly({provider:'jma',minute:600,endMinute:660,weather:'cloud',label:'くもり',temperature:null,temperatureMin:12,temperatureMax:18,precipitationProbability:40,precipitation:null,weatherPeriodLabel:'千葉県北西部・09:00〜12:00（3時間）',temperaturePeriodLabel:'千葉地点・日最低／最高',probabilityPeriodLabel:'06:00〜12:00（6時間）',precipitationPeriodLabel:'未提供'});
  const markup = forecastCardHtml(info);
  assert.match(markup,/☁️/); assert.match(markup,/>12–18℃/); assert.match(markup,/>日最低–最高</);
  assert.match(markup,/>09:00–12:00</); assert.match(markup,/>06:00–12:00</); assert.doesNotMatch(markup,/10:00–11:00/);
  assert.match(markup,/aria-label="降水量 未提供"/);
  assert.equal(compactPeriod('千葉県・日予報'),'日予報');
  assert.equal(compactPeriod('千葉地点・12:00の予報（3時間ごと）'),'12:00時点');
});

test('folded provenance deduplicates a provider and preserves all original periods and timestamps safely', () => {
  const info = hourly(), later = hourly({minute:660,endMinute:720,probabilityPeriodLabel:'11:00〜12:00（1時間）'});
  const markup = forecastSourcesHtml([info,info,later]);
  assert.match(markup,/<details class="forecast-sources">/); assert.doesNotMatch(markup,/<details[^>]* open/);
  assert.equal((markup.match(/<h4>/g)||[]).length,1);
  assert.match(markup,/2026-11-17T00:00:00Z/); assert.match(markup,/2026-11-17T00:30:00Z/);
  assert.match(markup,/10:00時点・1時間ごと/); assert.match(markup,/10:00〜11:00（1時間）/); assert.match(markup,/11:00〜12:00（1時間）/);
  const malicious = hourly({label:'<img onerror=x>',sourceUrl:'javascript:alert(1)',weatherPeriodLabel:'<script>x</script>'});
  const safe = forecastSourcesHtml(malicious) + forecastCardHtml(malicious);
  assert.match(safe,/&lt;img/); assert.match(safe,/&lt;script/); assert.doesNotMatch(safe,/<img|<script|href="javascript:/);
});

test('offline HTML has concise forecast cards and one source section, while CSV and ICS retain full detail', () => {
  const date='2026-11-17', info=hourly(), settings={date,entry:600,exit:800,budget:1000,weatherMode:'auto',weatherForecast:{date,weather:'sun',provider:info.provider,sourceUrl:info.sourceUrl,issuedAt:info.issuedAt,fetchedAt:info.fetchedAt,hours:[info]}};
  const plan={settings,rows:[{kind:'activity',name:'体験',start:600,end:610},{kind:'rest',name:'休憩',start:620,end:630}],totals:{cost:0}};
  const park={id:'land',name:'パーク',nodes:[]}, markup=buildOfflineHtml(plan,park,settings);
  assert.equal((markup.match(/<details class="forecast-sources">/g)||[]).length,1);
  assert.equal((markup.match(/保存時点で取得から/g)||[]).length,1);
  assert.equal((markup.match(/class="forecast-card"/g)||[]).length,2);
  for(const value of [buildScheduleCsv(plan,park,settings),buildCalendar(plan,park,settings).replace(/\r\n /g,'')]) {
    assert.match(value,/10:00時点・1時間ごと/); assert.match(value,/10:00〜11:00（1時間雨量）/);
    assert.match(value,/2026-11-17T00:30:00Z/); assert.match(value,/Open-Meteo/);
  }
});
