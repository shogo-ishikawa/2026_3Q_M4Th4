import test from 'node:test';
import assert from 'node:assert/strict';
import {onsiteNavigation} from '../web/onsite-navigation.js';

const park = {id:'land', activities:[{id:'ride',name:'鉄道'},{id:'show',name:'昼公演'},{id:'coaster',name:'山の列車'}]};
const settings = {date:'2026-11-19',entry:540,exit:1260};
const rows = [
  {kind:'walk',start:540,end:548,activityId:'ride',metres:160},
  {kind:'queue',start:548,end:560,activityId:'ride'},
  {kind:'activity',start:560,end:570,activityId:'ride'},
  {kind:'rest',start:575,end:585,name:'ショップ前で休憩',fixedBreakId:'r'},
  {kind:'walk',start:585,end:592,activityId:'show'},
  {kind:'wait',start:592,end:600,activityId:'show',name:'開演前の時間'},
  {kind:'activity',start:600,end:625,activityId:'show'},
  {kind:'queue',start:665,end:673,activityId:'ride~2',dpa:true},
  {kind:'activity',start:673,end:690,activityId:'ride~2',dpa:true},
  {kind:'walk',start:690,end:725,name:'出口へ移動',metres:1300},
  {kind:'exit',start:725,end:725,name:'退園'}
];
const result = {parkId:'land',settings,status:'feasible',rows,
  visits:[{id:'show',category:'show',start:600},{id:'ride~2',queueStart:665,method:'dpa'}],
  purchases:[{id:'ride',start:660,end:690,owned:true}]};
function view(at, overrides={}, extra={}, plan=result) {
  const now = Date.parse('2026-11-19T00:00:00+09:00') + at * 60_000;
  return onsiteNavigation(park,{...settings,...overrides},plan,{now,...extra});
}
const records = visits => ({dayProgress:{parkId:'land',date:settings.date,visits}});

test('the live card follows the Tokyo visit date, entry and exit, even on other device timezones',() => {
  for (const at of [539,1260,1440+550]) assert.equal(view(at),null);
  assert.equal(view(560,{date:'2026-11-20'}),null);
  assert.equal(view(540).title,'鉄道へ移動');
  assert.match(view(540).detail,/160 m/);
  assert.equal(view(548).title,'鉄道の待ち列');
  assert.equal(view(560).edit.status,'done');
  assert.equal(view(575).detail,'09:35–09:45 · 指定した休憩');
  assert.equal(view(571).label,'次の予定');
  assert.match(view(598).detail,/10:00 開演/);
  assert.equal(view(700).title,'出口へ移動');
  assert.equal(view(725).title,'退園');
  assert.equal(view(726).title,'しおりの予定はここまでです');
});

test('actual repeated ride overrides previous plan; due confirmation never advances automatically',() => {
  const active = records({'ride~2':{status:'queue',startedAt:560,endsAt:590}});
  let card = view(570,active);
  assert.equal(card.title,'鉄道（2回目）');
  assert.equal(card.edit.id,'ride~2');
  assert.equal(card.finish.status,'done');
  assert.match(card.detail,/09:50/);
  assert.equal(card.canReplan,true);
  card = view(590,active);
  assert.equal(card.canReplan,false);
  assert.match(card.detail,/見込みを過ぎ/);
  assert.equal(card.next,'');
  assert.match(view(665,records({ride:{status:'done'}})).detail,/DPA取得済み 11:00–11:30/);
});

test('omits unconfirmed stale itinerary, other days and future-entered progress',() => {
  assert.equal(view(553,{}, {dirty:true}).edit,undefined);
  assert.equal(view(553,{replanFrom:630}).canReplan,false);
  assert.equal(view(553,{}, {}, {...result,parkId:'sea'}),null);
  assert.equal(view(553,{}, {}, {...result,settings:{date:'2026-11-20'}}),null);
  assert.equal(view(553,records({ride:{status:'riding',startedAt:570,endsAt:580}})).label,'今の予定');
  assert.equal(view(553,records({ride:{status:'skipped'}})).title,'ショップ前で休憩');
  const active=records({coaster:{status:'riding',startedAt:548,endsAt:565}});
  assert.equal(view(553,active,{dirty:true},null).title,'山の列車');
  assert.equal(view(553,{dayProgress:{...active.dayProgress,parkId:'sea'}}).title,'鉄道の待ち列');
});
