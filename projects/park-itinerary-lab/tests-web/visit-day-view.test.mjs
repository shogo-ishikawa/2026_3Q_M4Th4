import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {visitDayDetails} from '../web/visit-day-view.js';
import {WAIT_BASE_FEATURE_NAMES} from '../web/calendar-features.js';
import {validateWaitModel} from '../web/wait-model.js';

const data = name => JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url)));
const base={schemaVersion:2,method:'ridge-regression',parkId:'land',status:'trained',usable:true,
  trainedAt:'2026-11-17T13:10:00Z', beforeDate:'2026-11-18',firstDate:'2026-11-11',lastDate:'2026-11-17',days:7,samples:250,
  activityIds:['land-attraction-197'],eventIds:[],featureNames:[...WAIT_BASE_FEATURE_NAMES],
  coefficients:Array(WAIT_BASE_FEATURE_NAMES.length+1).fill(0),
  validation:{method:'later-days-holdout',trainThrough:'2026-11-15',testFrom:'2026-11-16',testThrough:'2026-11-17',testSamples:50,modelMae:4,baselineMae:5}};
const calendarData=data('calendar');
const asOf=Date.parse('2026-11-19T10:00:00+09:00');
function settings(date,extra={}) { return {date,calendarData,waitModel:base,crowdMode:'estimate',...extra}; }
function priceModel() {
  const model=structuredClone(base);
  model.visitFactors=[{name:'adult_ticket_yen',min:8000,max:11000,mean:9500,days:6}];
  model.featureNames.splice(WAIT_BASE_FEATURE_NAMES.length,0,'adult_ticket_yen');
  model.coefficients.splice(WAIT_BASE_FEATURE_NAMES.length,0,1);
  model.visitFactorSupport={adult_ticket_yen:{knownDays:6,levels:2,supportedLevels:2}};
  assert.ok(validateWaitModel(model));
  return model;
}

test('the visitor sees the advertised fare and holiday even when an older model has no fitted factors',()=>{
  const info=visitDayDetails({id:'land'},settings('2026-11-21'),asOf);
  assert.match(info.facts.join(' '),/12,400円.*期間外.*連休の初日/);
  assert.match(info.forecast,/未採用/);
  assert.equal(info.support,'');
  assert.equal(info.report,null);
  assert.equal(info.sources.length,3);
  const campus=visitDayDetails({id:'sea'},settings('2027-01-06'),asOf);
  assert.match(campus.facts.join(' '),/春のキャンパスデーパスポート（2027年）の対象日/);
  assert.match(campus.forecast,/検証済みの待ち時間モデルはまだありません/);
});

test('adopted fare is shown only if that date had a known input; any fitted range limit is explicit',()=>{
  const model=priceModel();
  const day=date=>visitDayDetails({id:'land'},settings(date,{waitModel:model}),asOf);
  assert.match(day('2026-11-21').forecast,/大人料金 11,000円（学習範囲の上限）/);
  assert.match(day('2026-11-20').forecast,/大人料金 10,900円/);
  const firstDay=day('2026-11-19');
  assert.match(firstDay.facts.join(' '),/10,900円/);
  assert.match(firstDay.forecast,/予測に使える値が未確認/);
  assert.equal(firstDay.support,'大人料金 6日');
});

test('manual, missing, unusable and retrospective model states never claim adopted factors affected a forecast',()=>{
  const model=priceModel();
  const details=extra=>visitDayDetails({id:'land'},settings('2026-11-21',extra),asOf);
  assert.match(details({crowdMode:'manual',waitModel:model}).forecast,/入力した値/);
  assert.match(details({waitModel:null}).forecast,/モデルはまだありません/);
  assert.match(details({waitModel:{...model,usable:false}}).forecast,/モデルはまだありません/);
  const past=visitDayDetails({id:'land'},settings(base.lastDate,{waitModel:model}),asOf);
  assert.match(past.forecast,/最終学習日以前/);
  assert.equal(past.report,'accuracy.html?date='+base.lastDate+'&park=land');
});

test('unknown fares and offers are kept distinct from confirmed absences',()=>{
  const unknown=visitDayDetails({id:'sea'},settings('2028-01-15'),asOf);
  assert.match(unknown.facts.join(' '),/料金未確認.*割引は未確認/);
  assert.deepEqual(unknown.sources,[]);
  assert.equal(visitDayDetails({id:'land'},settings(''),asOf),null);
});
