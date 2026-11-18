import test from 'node:test';
import assert from 'node:assert/strict';
import { changeDpaMode, dpaEditor } from '../web/app.js';
import { solveItinerary, validatePlan } from '../web/planner.js';

const ride = {id:'ride', name:'ライド', category:'attraction', node:'gate', duration:10, baseWait:120, windows:[[540,1200]], dpa:{price:2000, wait:5}};
const park = {id:'land', entryNode:'gate', exitNode:'gate', nodes:[{id:'gate',name:'入口',x:100,y:100}], edges:[], activities:[ride]};
const wish = () => ({id:ride.id, weight:4, required:false, dpaMode:'none'});
const purchase = {id:ride.id, kind:'attraction', start:600, end:620, purchasedAt:550, cost:2000};

test('each eligible wish has its own radio group and shows only the fields for its chosen mode', () => {
  for (const mode of ['none','unavailable','consider','owned']) {
    const html = dpaEditor(ride, {...wish(),dpaMode:mode}, park);
    assert.equal((html.match(/name="dpa-ride"/g)||[]).length,4);
    assert.equal((html.match(/<input type="radio"[^>]* checked>/g)||[]).length,1);
    assert.ok(html.includes(`value="${mode}" checked`));
    assert.ok(html.includes('2,000円／人'));
    assert.equal(html.includes('data-field="dpaStart"'),['consider','owned'].includes(mode));
    assert.equal(html.includes('data-field="dpaEnd"'),['consider','owned'].includes(mode));
    assert.equal(html.includes('data-field="dpaPurchasedAt"'),mode==='owned');
    assert.equal(html.includes('data-field="nodeOverride"'),false);
  }
  assert.ok(dpaEditor({...ride,id:'second'},wish(),park).includes('name="dpa-second"'));
  assert.equal(dpaEditor({...ride,dpa:null},wish(),park),'');
});

test('switching to an owned slot requires actual confirmed times and preserves an independent must-visit choice', () => {
  for (const required of [true,false]) {
    const s = {...wish(), required, dpaMode:'consider', dpaStart:800, dpaEnd:830, dpaAvailableWindows:[[800,830]]};
    changeDpaMode(s,'owned');
    const html = dpaEditor(ride,s,park);
    for(const field of ['dpaStart','dpaEnd','dpaPurchasedAt']) {
      assert.match(html,new RegExp(`data-field="${field}" value=""`));
    }
    changeDpaMode(s,'none');
    assert.equal(s.required,required);
    assert.equal(s.dpaAvailableWindows,undefined);
  }
});

test('switching back to a confirmed purchase restores the recorded times and charges it once', () => {
  const record = Object.freeze({...purchase});
  const s = wish();
  for (const mode of ['owned','none','unavailable','owned']) {
    changeDpaMode(s,mode,record);
    const html=dpaEditor(ride,s,park,record);
    assert.equal(html.includes('購入履歴を確認'),mode!=='owned');
  }
  assert.deepEqual([s.dpaStart,s.dpaEnd,s.dpaPurchasedAt],[600,620,550]);
  const settings={date:'2026-11-18',entry:540,exit:650,speed:70,budget:3000,dpaBudget:2000,crowdMode:'manual',restEvery:0,restMinutes:0,selections:[s],purchases:[record]};
  const result=solveItinerary(park,settings);
  assert.equal(result.status,'feasible');
  assert.equal(result.purchases.length,1);
  assert.equal(result.visits[0].method,'dpa');
  assert.equal(result.totals.cost,2000);
  assert.ok(validatePlan(park,settings,result).valid);
});

test('parade venue selection appears only for active slots and excludes routing-only nodes', () => {
  const parade={...ride,category:'parade'};
  const places={nodes:[...park.nodes,{id:'internal',name:'中継点',routingOnly:true},{id:'venue',name:'<広場>'}]};
  for(const mode of ['none','unavailable','consider','owned']){
    const html=dpaEditor(parade,{...wish(),dpaMode:mode,nodeOverride:'venue'},places);
    const active=['consider','owned'].includes(mode);
    assert.equal(html.includes('data-field="nodeOverride"'),active);
    assert.doesNotMatch(html,/<select[^>]*\srequired(?:\s|>)/);
    assert.equal(html.includes('value="venue" selected>&lt;広場&gt;'),active);
    assert.ok(!html.includes('中継点'));
  }
});

test('a restored plan with additional candidate slots shows their times separately', () => {
  const s={...wish(),dpaMode:'consider',dpaStart:600,dpaEnd:630,dpaAvailableWindows:[[600,630],[720,750]]};
  const html=dpaEditor(ride,s,park);
  assert.match(html,/data-field="dpaStart" value="10:00"/);
  assert.match(html,/ほかの購入候補枠　12:00–12:30/);
});

test('an additional candidate for a previously purchased facility is checked against the ticket for that admission', () => {
  const s = {...wish(),required:true,manualWait:180};
  changeDpaMode(s,'consider',purchase);
  Object.assign(s,{dpaStart:660,dpaEnd:680,dpaAvailableWindows:[[660,680]]});
  const settings={date:'2026-11-18',entry:540,exit:690,speed:70,budget:5000,dpaBudget:4000,crowdMode:'manual',restEvery:0,restMinutes:0,selections:[s],purchases:[purchase]};
  const plan=solveItinerary(park,settings);
  assert.equal(plan.status,'feasible');
  assert.deepEqual(plan.purchases.map(p=>p.owned),[true,false]);
  assert.equal(plan.totals.dpaCost,4000);
  assert.ok(validatePlan(park,settings,plan).valid);
  for (const [change,expected] of [
    [(record,ticket)=>{ticket.start+=15;},/利用枠の外/],
    [(record,ticket)=>{ticket.end+=5;},/候補の枠または料金/],
    [(record,ticket)=>{ticket.cost-=100;},/候補の枠または料金/],
    [(record,ticket)=>{ticket.owned=true;},/利用枠の外/],
    [(record,ticket)=>{ticket.purchasedAt=record.end-1;},/次回購入可能時刻/],
    [(record)=>{record.purchasedAt+=1;},/購入履歴と一致/],
    [(record)=>{record.cost+=100;},/購入履歴と一致/],
  ]) {
    const invalid=structuredClone(plan);
    change(...invalid.purchases);
    assert.match(validatePlan(park,settings,invalid).errors.join(' '),expected);
  }
});

test('a previous park or date cannot supply purchases or preserved visits to a new day', () => {
  const previousSettings={date:'2026-11-18',entry:540,exit:720,speed:70,budget:5000,crowdMode:'manual',restEvery:0,restMinutes:0,
    selections:[{...wish(),dpaMode:'owned',dpaStart:600,dpaEnd:620,dpaPurchasedAt:550}]};
  const initialPlan=solveItinerary(park,previousSettings);
  const later={...previousSettings,replanFrom:680,selections:[]};
  for(const [thisPark,thisVisit] of [[park,{...later,date:'2026-11-19'}],[{...park,id:'sea'},later]]) {
    const result=solveItinerary(thisPark,thisVisit,{initialPlan});
    assert.deepEqual(result.purchases,[]);
    assert.equal(result.rows.some(row=>row.preserved),false);
    assert.equal(result.totals.cost,0);
  }
});

test('a zero purchase limit hides candidate slot requirements and keeps owned tickets editable',()=>{
  const parade={...ride,category:'parade'};
  const candidate=dpaEditor(parade,{...wish(),dpaMode:'consider'},park,undefined,0);
  assert.doesNotMatch(candidate,/data-field="(?:nodeOverride|dpaStart|dpaEnd)"/);
  assert.match(candidate,/上限が0件/);
  assert.match(dpaEditor(parade,{...wish(),dpaMode:'owned'},park,undefined,0),/data-field="nodeOverride"/);
});
