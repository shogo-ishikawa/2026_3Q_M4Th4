import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDayProgress, remainingVisitEnd, reviseDayProgress, suggestedReportTime} from '../web/day-progress-ui.js';
import {repeatVisitId} from '../web/repeat-visits.js';
import {resetForNewVisitDay} from '../web/app.js';

const park = {id:'land',activities:[{id:'a',category:'attraction',node:'entrance',endNode:'exit',duration:10},
  {id:'b',category:'attraction',node:'b',duration:20}]};
const settings = {date:'2026-11-19',entry:540,exit:1260,selections:[]};
const update = (s, edit) => ({...s,...reviseDayProgress(park,s,{id:'a',at:660,...edit})});

test('the time default uses Japan local time and prior visit settings only for the selected day',() => {
  const now = Date.parse('2026-11-19T02:05:00Z');
  assert.equal(suggestedReportTime(settings,now),665);
  assert.equal(suggestedReportTime({...settings,date:'2026-11-20',replanFrom:800},now),800);
});
test('a reported queue takes only the remaining wait plus ride time and anchors at its exit',() => {
  const end=remainingVisitEnd({status:'queue',at:660,remaining:20,duration:10});
  assert.equal(end,690);
  const current=update(settings,{status:'queue',end});
  assert.equal(current.currentNode,'exit');
  assert.deepEqual(current.dayProgress.visits.a,{status:'queue',startedAt:660,endsAt:690});
  assert.throws(()=>update(current,{id:'b',status:'riding',end:700}),/進行中/);
  assert.throws(()=>remainingVisitEnd({status:'queue',at:660,duration:10,remaining:null}),/残り時間/);
  assert.equal(remainingVisitEnd({status:'riding',at:670,remaining:5,duration:10}),675);
  assert.equal(remainingVisitEnd({status:'queue',at:670,mode:'finish',finish:695,duration:10}),695);
  const leftQueue=update(current,{status:'pending'});
  assert.deepEqual(leftQueue.dayProgress.visits.a,{status:'pending'});
  assert.equal(leftQueue.currentNode,'entrance');
});
test('a second visit is independent and recording it requires acknowledgement of the first',() => {
  const second=repeatVisitId('a');
  assert.throws(()=>update(settings,{id:second,status:'done'}),/1回目/);
  const done=update(settings,{id:second,status:'done',confirmFirst:true});
  assert.deepEqual(done.dayProgress.visits, {a:{status:'done'},[second]:{status:'done'}});
  assert.throws(()=>update(done,{id:'a',status:'pending'}),/2回目/);
  const revised=update(done,{id:second,status:'skipped'});
  const cleared=update(revised,{id:second,status:'clear'});
  assert.deepEqual(cleared.dayProgress.visits,{a:{status:'done'}});
  assert.equal(settings.dayProgress,undefined);
});
test('progress does not carry to a new day or another park',() => {
  const current=update(settings,{status:'queue',end:690});
  const future=update({...current,date:'2026-11-20'},{id:'b',status:'done'});
  assert.deepEqual(future.dayProgress.visits,{b:{status:'done'}});
  const another={...current,dayProgress:{...current.dayProgress,parkId:'sea'}};
  assert.deepEqual(update(another,{id:'b',status:'done'}).dayProgress.visits,{b:{status:'done'}});
  const next={settings:{...current,date:'2026-11-20'}};
  resetForNewVisitDay(next,park);
  assert.equal(next.settings.dayProgress,undefined);
});

test('marking a tracked visit done keeps its actual start and end through a later plain replan',() => {
  const queued = update(settings,{status:'queue',end:700});
  const finished = update(queued,{at:693,status:'done'});
  assert.deepEqual(finished.dayProgress.visits.a,{status:'done',startedAt:660,endsAt:693});
  assert.throws(()=>update(queued,{at:693,status:'done',doneAt:650}),/体験した時刻/);
});

test('the main progress action saves valid edits, rejects incomplete waits, and leaves saved facts intact',t => {
  class Field extends EventTarget {
    value = ''; textContent = ''; checked = false; dataset = {};
    classList = {add(){},remove(){}};
    replaceChildren() {}
    append() {}
    focus() {}
    scrollIntoView() {}
  }
  const elements = new Map();
  const field = id => {
    if (!elements.has(id)) elements.set(id,new Field());
    return elements.get(id);
  };
  const previousDocument = globalThis.document, previousOption = globalThis.Option;
  globalThis.document = {createElement:() => new Field()};
  globalThis.Option = class {constructor(name,id){this.value=id;}};
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document=previousDocument;
    if (previousOption === undefined) delete globalThis.Option; else globalThis.Option=previousOption;
  });
  let current = {...settings}, writes = 0, replans = 0;
  const editor = attachDayProgress({
    root:{querySelector:key=>field(key.slice(1))},context:()=>({park,settings:current}),
    apply:patch=>{current={...current,...patch};writes++;},replan:()=>{replans++;},syncClocks:()=>{},
  });
  editor.open('a','queue');
  field('progressClock').value='11:00';
  field('progressReplan').dispatchEvent(new Event('click'));
  assert.equal(replans,0);
  assert.equal(writes,0);
  assert.match(field('progressMessage').textContent,/残り時間/);
  field('progressRemaining').value='20';
  field('progressReplan').dispatchEvent(new Event('click'));
  assert.equal(replans,1);
  assert.equal(writes,1);
  assert.equal(current.dayProgress.visits.a.endsAt,690);
  field('progressReplan').dispatchEvent(new Event('click'));
  assert.equal(replans,2);
  assert.equal(writes,1);
});
