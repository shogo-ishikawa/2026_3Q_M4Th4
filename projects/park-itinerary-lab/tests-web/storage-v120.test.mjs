import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSavedState, buildPlanJson, parsePlanJson, createShareUrl, readSharedState, buildScheduleCsv, buildCalendar, buildOfflineHtml} from '../web/storage.js';

const park = {id:'land', name:'東京ディズニーランド', mapUrl:'https://www.tokyodisneyresort.jp/tdl/map.html', nodes:[{id:'hub',name:'中央広場'}]};
const liveData = () => ({schemaVersion:1,parkId:'land',provider:'queue-times',fetchedAt:'2026-11-17T12:30:00Z',rides:[{activityId:'land-ride-1',providerId:100,name:'アトラクション',wait:40,isOpen:true,updatedAt:'2026-11-17T12:28:00Z'}],unmatched:[]});
const model = () => ({schemaVersion:1,method:'ridge-regression',parkId:'land',status:'insufficient-data',usable:false,trainedAt:'2026-11-17T12:30:00Z',beforeDate:'2026-11-18',samples:0,days:0,activityIds:[],coefficients:[],validation:null});
const state = () => ({parkId:'land', settings:{date:'2026-11-17',entry:540,exit:1260,speed:70,budget:10000,selections:[],searchMethod:'portfolio',searchSeconds:120,fixedBreaks:[{id:'rest-1',start:780,duration:25,node:'hub',label:'おやつの時間'}]}, result:{rows:[{kind:'rest',fixedBreakId:'rest-1',start:780,end:805,node:'hub',name:'おやつの時間'}]}});

test('探索方法と指定休憩はJSON・共有リンクで往復し旧版も開ける', () => {
  const value=state();
  assert.deepEqual(parsePlanJson(buildPlanJson(value)).settings,value.settings);
  const shared=readSharedState(new URL(createShareUrl(value,'https://example.org/park/')).hash);
  assert.deepEqual(shared.settings,value.settings);
  for(const method of ['beam','multistart','portfolio']) {value.settings.searchMethod=method;assert.equal(validateSavedState(value),value);}
  delete value.settings.searchMethod;delete value.settings.fixedBreaks;value.settings.searchSeconds=0.1;
  assert.doesNotThrow(()=>validateSavedState(value));
});

test('指定休憩の壊れた時刻・地点・重複ID・長さ・名前を拒む', () => {
  for(const patch of [{start:780.5},{start:-1},{start:1430,duration:20},{duration:0},{duration:181},{duration:NaN},{node:'unknown node'},{id:''},{label:'a'.repeat(101)}]) {
    const value=state();Object.assign(value.settings.fixedBreaks[0],patch);
    assert.throws(()=>validateSavedState(value));
  }
  const duplicate=state();duplicate.settings.fixedBreaks.push({...duplicate.settings.fixedBreaks[0]});assert.throws(()=>validateSavedState(duplicate),/休憩/);
  const tooMany=state();tooMany.settings.fixedBreaks=Array.from({length:31},(_,index)=>({...tooMany.settings.fixedBreaks[0],id:`rest-${index}`}));assert.throws(()=>validateSavedState(tooMany),/30件/);
  const badRow=state();badRow.result.rows[0].kind='activity';assert.throws(()=>validateSavedState(badRow),/休憩/);
  const noNode=state();delete noNode.result.rows[0].node;assert.throws(()=>validateSavedState(noNode),/休憩/);
  for(const patch of [{searchSeconds:120.1},{searchSeconds:0.09},{searchMethod:'exact'}]) {const value=state();Object.assign(value.settings,patch);assert.throws(()=>validateSavedState(value));}
});

test('共有リンクに観測データ・モデル・当日の取得値を埋め込まない', () => {
  const value=state();
  value.settings.history=[{date:'2026-11-16',activityId:'ride-1',time:600,wait:30}];
  value.settings.waitModel=model();
  value.settings.liveData=liveData();
  value.settings.initialPlan=value.result;
  const shared=readSharedState(new URL(createShareUrl(value,'https://example.org')).hash);
  for(const key of ['history','waitModel','liveData','initialPlan']) assert.equal(shared.settings[key],undefined);
  assert.deepEqual(shared.settings.fixedBreaks,value.settings.fixedBreaks);
});

test('休憩の名前・場所・時刻をCSV・カレンダー・予定表HTMLに残す', () => {
  const value=state();
  const csv=buildScheduleCsv(value.result,park);
  assert.match(csv,/"13:00","13:25","休憩","休憩 · おやつの時間"/);
  assert.match(csv,/"中央広場"/);
  const calendar=buildCalendar(value.result,park,value.settings).replaceAll('\r\n ','');
  assert.match(calendar,/SUMMARY:休憩 · おやつの時間/);
  assert.match(calendar,/LOCATION:東京ディズニーランド · 中央広場/);
  assert.match(calendar,/DTSTART:20261117T040000Z/);
  assert.match(calendar,/DTEND:20261117T042500Z/);
  const page=buildOfflineHtml(value.result,park,value.settings);
  assert.match(page,/<h2>休憩 · おやつの時間<\/h2>/);
  assert.match(page,/中央広場 · 25分/);
  assert.match(page,/class="row rest"/);
});

test('休憩名と地点名のHTML・カレンダー制御文字を安全に書き出す', () => {
  const value=state();value.result.rows[0].name='<img src=x onerror=alert(1)>\nBEGIN:VEVENT';
  const maliciousPark={...park,nodes:[{id:'hub',name:'<script>alert(1)</script>\nBEGIN:VEVENT'}]};
  const page=buildOfflineHtml(value.result,maliciousPark,value.settings);
  assert.ok(!page.includes('<img'));assert.ok(!page.includes('<script>'));assert.ok(page.includes('&lt;script&gt;'));
  const calendar=buildCalendar(value.result,maliciousPark,value.settings).replaceAll('\r\n ','');
  assert.equal((calendar.match(/\r\nBEGIN:VEVENT/g)||[]).length,1);
  assert.ok(calendar.includes('\\nBEGIN:VEVENT'));
});


test('当日データと予測モデルはJSONに保存でき形式が壊れた値を拒む', () => {
  const value=state();value.settings.liveMode='auto';value.settings.liveData=liveData();value.settings.waitModel=model();
  const restored=parsePlanJson(buildPlanJson(value));
  assert.deepEqual(restored.settings.liveData,value.settings.liveData);assert.deepEqual(restored.settings.waitModel,value.settings.waitModel);
  for(const mutate of [
    state=>{state.settings.liveMode='always';},
    state=>{state.settings.liveData.parkId='sea';},
    state=>{state.settings.liveData.fetchedAt='tomorrow';},
    state=>{state.settings.liveData.rides[0].wait=-1;},
    state=>{state.settings.liveData.rides[0].isOpen='false';},
    state=>{state.settings.liveData.rides[0].updatedAt='bad';},
    state=>{state.settings.liveData.rides.push({...state.settings.liveData.rides[0]});},
    state=>{state.settings.waitModel.coefficients=[Infinity];},
    state=>{state.settings.waitModel.activityIds=['bad id'];},
    state=>{state.settings.waitModel.samples=50001;},
    state=>{state.settings.waitModel.parkId='sea';}
  ]) {const bad=structuredClone(value);mutate(bad);assert.throws(()=>validateSavedState(bad));}
  const trained=structuredClone(value);Object.assign(trained.settings.waitModel,{status:'trained',usable:true,samples:1000,days:14,firstDate:'2026-11-01',lastDate:'2026-11-14',activityIds:['land-ride-1'],coefficients:Array(8).fill(0.1),validation:{method:'later-days-holdout',trainThrough:'2026-11-10',testFrom:'2026-11-11',testThrough:'2026-11-14',testSamples:120,modelMae:4,baselineMae:12}});
  assert.doesNotThrow(()=>validateSavedState(trained));
  trained.settings.waitModel.coefficients.pop();assert.throws(()=>validateSavedState(trained));
});
