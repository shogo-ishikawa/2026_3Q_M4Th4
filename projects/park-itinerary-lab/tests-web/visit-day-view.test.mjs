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

test('weekday, weekends, public holidays and the middle of a long weekend have distinct text and colours',()=>{
  const badge=date=>visitDayDetails({id:'land'},settings(date),asOf).facts[0];
  assert.deepEqual(badge('2026-11-20'), {label:'平日', tone:'weekday'});
  assert.deepEqual(badge('2026-11-28'), {label:'休日', tone:'holiday'});
  assert.deepEqual(badge('2026-11-21'), {label:'休日（連休の初日）', tone:'holiday'});
  assert.deepEqual(badge('2026-11-22'), {label:'連休中日', tone:'middle'});
  assert.deepEqual(badge('2026-11-23'), {label:'休日（連休の最終日・勤労感謝の日）', tone:'holiday'});
  assert.deepEqual(badge('2027-02-11'), {label:'休日（建国記念の日）', tone:'holiday'});
  assert.deepEqual(badge('2028-01-17'), {label:'祝日情報未確認', tone:'unknown'});
  assert.deepEqual(badge('2028-01-15'), {label:'休日', tone:'holiday'});
});

test('advertised adult fares have distinct price tiers independent of park, day type and model availability',()=>{
  const day=date=>visitDayDetails({id:'land'},settings(date),asOf);
  const first=day('2026-11-21');
  assert.deepEqual(first.facts[1],{label:'大人1デーパスポート 12,400円（料金帯 6/6）',tone:'fare-6'});
  assert.match(first.forecast,/未採用/);
  assert.equal(first.support,'');
  assert.equal(first.report,null);
  assert.equal(first.sources.length,2);
  assert.equal(day('2026-11-29').facts[1].tone,'fare-5');
  assert.equal(day('2026-11-20').facts[1].tone,'fare-4');
  assert.equal(day('2027-01-04').facts[1].tone,'fare-3');
  assert.equal(day('2027-01-06').facts[1].tone,'fare-1');
  const price=adultOneDayYen=>visitDayDetails({id:'sea', ticketCalendar:{'2026-11-21':{
    adultOneDayYen,adultKnownSince:'2026-11-18T18:30:00Z'}}},settings('2026-11-21'),asOf).facts[1];
  assert.equal(price(9400).tone,'fare-2');
  assert.deepEqual(price(13000),{label:'大人1デーパスポート 13,000円',tone:'unknown'});
});

test('campus tickets appear once alongside running events on eligible dates for either park',()=>{
  for (const id of ['land','sea']) {
    const park={id, events:[
      {name:'冬のイベント',startDate:'2027-01-01',endDate:'2027-03-20'},
      {name:'春の行事',startDate:'2027-04-01',endDate:'2027-05-22'}]};
    const details=date=>visitDayDetails(park,settings(date),asOf);
    assert.deepEqual(details('2027-01-03').events,['冬のイベント']);
    const first=details('2027-01-04');
    assert.deepEqual(first.events,['冬のイベント','キャンパスデーパスポート（対象の大人 8,900円）']);
    assert.ok(first.facts.every(fact=>!fact.label.includes('学生') && !fact.label.includes('キャンパス')));
    assert.ok(first.sources.some(source=>source.url.includes('/spring2027/')));
    assert.ok(details('2027-03-19').events.some(name=>name.includes('キャンパス')));
    const after=details('2027-03-20');
    assert.deepEqual(after.events,['冬のイベント']);
    assert.ok(!after.sources.some(source=>source.url.includes('/spring2027/')));
    park.events.push({name:'キャンパスデーパスポート（期間限定）',startDate:'2027-01-04',endDate:'2027-03-19'});
    assert.deepEqual(details('2027-01-06').events,['冬のイベント','キャンパスデーパスポート（期間限定）（対象の大人 7,900円）']);
    assert.deepEqual(details('2028-01-17').events,[]);
  }
});

test('adopted fare is shown only if that date had a known input; any fitted range limit is explicit',()=>{
  const model=priceModel();
  const day=date=>visitDayDetails({id:'land'},settings(date,{waitModel:model}),asOf);
  assert.match(day('2026-11-21').forecast,/大人料金 11,000円（学習範囲の上限）/);
  assert.match(day('2026-11-20').forecast,/大人料金 10,900円/);
  assert.match(day('2026-11-19').forecast,/大人料金 10,900円/);
  const date='2027-03-24';
  const sameDayFare={adultOneDayYen:10900,adultKnownSince:date+'T09:00:00+09:00'};
  const later=visitDayDetails({id:'land',ticketCalendar:{[date]:sameDayFare}},
    settings(date,{waitModel:model}),Date.parse(date+'T12:00:00+09:00'));
  assert.match(later.facts[1].label,/10,900円/);
  assert.match(later.forecast,/予測に使える値が未確認/);
  assert.equal(later.support,'大人料金 6日');
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
  assert.deepEqual(unknown.facts[1],{label:'大人1デーパスポート 料金未確認',tone:'unknown'});
  assert.deepEqual(unknown.events,[]);
  assert.deepEqual(unknown.sources,[]);
  assert.equal(visitDayDetails({id:'land'},settings(''),asOf),null);
});
