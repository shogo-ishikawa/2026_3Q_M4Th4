import test from 'node:test';
import assert from 'node:assert/strict';
import {itineraryImageRows, paginateItinerary} from '../web/itinerary-image.js';

const park = {id:'sea', name:'東京ディズニーシー', nodes:[{id:'harbour',name:'ハーバー'}],
  activities:[{id:'soaring',name:'ソアリン'}]};
const settings = {date:'2026-11-18', entry:540, exit:1260};
const row = (kind, start, end, name, extra={}) => ({kind,start,end,name,...extra});

test('PNG distinguishes paid and proposed tickets, both visits and reported progress', () => {
  const plan = {purchases:[{id:'soaring',owned:true,start:720,end:750},{id:'toy',owned:false,start:800,end:840}],
    visits:[{id:'soaring~2',queueStart:741}], rows:[
      row('activity',620,626,'ソアリン',{activityId:'soaring',userProgress:'done'}),
      row('queue',741,748,'ソアリン（2回目）の待ち列',{activityId:'soaring~2',userProgress:'queue',dpa:true,node:'harbour'}),
      row('activity',748,755,'ソアリン（2回目）',{activityId:'soaring~2',userProgress:'queue',dpa:true}),
      row('activity',832,837,'トイ',{activityId:'toy',dpa:true})]};
  const rows = itineraryImageRows(plan,park,settings);
  assert.deepEqual(rows.map(r=>r.start),['10:20','12:21','12:28','13:52']);
  assert.deepEqual(rows.map(r=>r.detail),['体験済み','並んでいる · DPA取得済み · ハーバー','体験終了の見込み · DPA取得済み','体験 · DPA購入候補']);
  assert.match(rows[2].title,/2回目/);
});

test('a reported completion without an actual time is listed once, with no inferred time from the old itinerary', () => {
  const plan = {rows:[row('queue',565,600,'ソアリンの待ち列',{activityId:'soaring'}),
    row('activity',600,606,'ソアリン',{activityId:'soaring'}),row('rest',631,641,'ひと休み')]};
  const here = {...settings, dayProgress:{date:settings.date,parkId:'sea',
    visits:{soaring:{status:'done',reportedAt:625},'soaring~2':{status:'done'}}}};
  const rows = itineraryImageRows(plan,park,here);
  assert.deepEqual(rows.map(r=>[r.title,r.start]),[['ひと休み','10:31'],['ソアリン','時刻未記録'],['ソアリン（2回目）','時刻未記録']]);
  assert.equal(itineraryImageRows(plan,park,{...here,date:'2026-11-19'}).length,3);
  assert.equal(itineraryImageRows(plan,{...park,id:'land'},here)[0].title,'ソアリンの待ち列');
});

test('long itineraries are measured and split into readable numbered pages without dropping rows or long labels', () => {
  const rows = Array.from({length:80},(_,i)=>({start:'09:00',title:i===5?'海'.repeat(500):'予定'+i,detail:'地点'}));
  const context = {measureText(t){return {width:[...t].length * (this.font.includes('29px') ? 29 : 22)};}};
  const pages = paginateItinerary(rows,context);
  assert.ok(pages.length>1);
  assert.deepEqual(pages.flatMap(p=>p.rows.map(r=>r.title.join(''))),rows.map(r=>r.title));
  assert.ok(pages.every(p=>p.height<=1480));
});
