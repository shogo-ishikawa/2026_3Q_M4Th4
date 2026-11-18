import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {visitDayDetails} from '../web/visit-day-view.js';
const calendarData=JSON.parse(readFileSync(new URL('../web/data/calendar.json', import.meta.url)));
const asOf=Date.parse('2026-11-19T10:00:00+09:00');
const settings=date=>({date,calendarData});

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

test('a past visit includes the accuracy report for that park and date',()=>{
  const date='2026-11-17';
  for (const id of ['land','sea']) {
    const past=visitDayDetails({id},settings(date),asOf);
    assert.equal(past.report,'accuracy.html?date='+date+'&park='+id);
    assert.equal(visitDayDetails({id},settings('2026-11-19'),asOf).report,null);
  }
});

test('unknown fares and offers are kept distinct from confirmed absences',()=>{
  const unknown=visitDayDetails({id:'sea'},settings('2028-01-15'),asOf);
  assert.deepEqual(unknown.facts[1],{label:'大人1デーパスポート 料金未確認',tone:'unknown'});
  assert.deepEqual(unknown.events,[]);
  assert.deepEqual(unknown.sources,[]);
  assert.equal(visitDayDetails({id:'land'},settings(''),asOf),null);
});
