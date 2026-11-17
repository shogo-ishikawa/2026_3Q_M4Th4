import test from 'node:test';
import assert from 'node:assert/strict';
import {buildScheduleCsv,buildCalendar,buildOfflineHtml,validateSavedState,buildPlanJson,parsePlanJson} from '../web/storage.js';
const park={id:'sea',name:'海のパーク',mapUrl:'https://www.tokyodisneyresort.jp/tds/map.html',nodes:[{id:'a',name:'港'}]};
const settings=()=>({date:'2026-11-17',entry:540,exit:1260,speed:65,budget:5000,weatherMode:'auto',weather:'cloud',selections:[{id:'sea-attraction-230',weight:5,timeWindowLinked:false,pauseWindows:[[600,630]]}],gondolaAvoidHarbourShows:true,
 weatherForecast:{date:'2026-11-17',weather:'cloud',provider:'jma',sourceUrl:'https://www.jma.go.jp/',fetchedAt:'2026-11-17T00:00:00Z',issuedAt:'2026-11-16T20:00:00Z',temperatureMin:12,temperatureMax:18,precipitationProbability:40,hours:[
  {minute:540,endMinute:720,weather:'cloud',label:'くもり',temperature:null,temperatureMin:12,temperatureMax:18,precipitationProbability:40,precipitation:null,weatherPeriodLabel:'09:00〜12:00（3時間）',temperaturePeriodLabel:'千葉地点・日最低〜最高',probabilityPeriodLabel:'06:00〜12:00（6時間）',precipitationPeriodLabel:'未提供'},
  {minute:720,endMinute:1080,weather:'rain',label:'雨',temperature:16,precipitationProbability:80,precipitation:0,weatherPeriodLabel:'12:00〜18:00（6時間）',temperaturePeriodLabel:'12:00の予報',probabilityPeriodLabel:'12:00〜18:00（6時間）',precipitationPeriodLabel:'1時間雨量'}]}});
const plan=()=>({rows:[{kind:'activity',name:'ゴンドラ',node:'a',start:600,end:610,cost:0},{kind:'rest',name:'休憩',node:'a',start:750,end:760,cost:0}],totals:{cost:0}});
const unfold=text=>text.replace(/\r\n /g,'');
test('all schedule exports carry per-time forecast periods, unknown rain, actual zero, and source age',()=>{
 const original=Date.now;Date.now=()=>Date.parse('2026-11-17T01:00:00Z');
 try{
 const s=settings(),p=plan();p.settings=s;
 const csv=buildScheduleCsv(p,park),ics=unfold(buildCalendar(p,park,s)),html=buildOfflineHtml(p,park,s);
 assert.match(csv,/"最低気温℃"/);assert.match(csv,/"12","18","40","未提供"/);assert.match(csv,/"16","未提供","未提供","80","0"/);assert.match(csv,/"60"/);
 for(const output of [csv,ics,html]){assert.match(output,/気象庁/);assert.match(output,/2026-11-17T00:00:00Z/);assert.match(output,/2026-11-16T20:00:00Z/);assert.match(output,/日最低〜最高/);assert.match(output,/06:00〜12:00（6時間）/);}
 assert.match(ics,/降水量 未提供/);assert.match(ics,/降水量 0mm/);assert.match(html,/保存時点で取得から 60分/);
 }finally{Date.now=original;}
});
test('out-of-range, manually chosen, or missing forecasts never create artificial numeric weather',()=>{
 const s=settings(),p=plan();p.rows=p.rows.slice(0,1);
 for(const patch of [{weatherMode:'manual'},{weatherForecast:null},{weatherForecast:{...s.weatherForecast,date:'2026-11-18'}}]){
  const output=buildScheduleCsv(p,park,{...s,...patch});assert.match(output,/"予報未取得","未提供","未提供","未提供","未提供","未提供"/);
 }
 p.rows[0].start=1250;p.rows[0].end=1260;assert.match(buildOfflineHtml(p,park,s),/天気 予報未取得/);
});
test('forecast metadata and pause options survive validated JSON without weakening missing-data checks',()=>{
 const state={parkId:'sea',settings:settings(),result:plan()};assert.equal(validateSavedState(state),state);assert.deepEqual(parsePlanJson(buildPlanJson(state)).settings,state.settings);
 for(const mutation of [s=>s.selections[0].timeWindowLinked='false',s=>s.selections[0].pauseWindows=[[630,600]],s=>s.gondolaAvoidHarbourShows=1,s=>s.weatherForecast.hours[0].endMinute=500,s=>s.weatherForecast.hours[0].temperatureMin=90,s=>s.weatherForecast.sourceUrl='javascript:alert(1)',s=>s.weatherForecast.fetchedAt='yesterday']){
  const s=settings();mutation(s);assert.throws(()=>validateSavedState({parkId:'sea',settings:s}));
 }
 const s=settings();s.weatherForecast.temperatureMin=null;s.weatherForecast.temperatureMax=null;s.weatherForecast.hours[0].temperatureMin=null;s.weatherForecast.hours[0].temperatureMax=null;assert.doesNotThrow(()=>validateSavedState({parkId:'sea',settings:s}));
});
test('HTML escapes forecast labels and calendars retain safe folding and escaping',()=>{
 const s=settings();s.weatherForecast.hours[0].label='<img src=x onerror=alert(1)>,;';const p=plan();p.settings=s;
 const html=buildOfflineHtml(p,park,s);assert.equal(html.includes('<img'),false);assert.match(html,/&lt;img/);
 const ics=buildCalendar(p,park,s);for(const line of ics.split('\r\n'))assert.ok(new TextEncoder().encode(line).length<=75);assert.match(unfold(ics),/\\,\\;/);
});
