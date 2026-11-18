import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDayProgress, remainingVisitEnd, reviseDayProgress, suggestedReportTime} from '../web/day-progress-ui.js';
import {repeatVisitId} from '../web/repeat-visits.js';
import {changeDpaMode, dpaEditor, noPlanActions, resetForNewVisitDay} from '../web/app.js';

const park = {id:'land',nodes:[{id:'exit',name:'到着駅'}],activities:[{id:'a',category:'attraction',node:'entrance',endNode:'exit',duration:10},
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
  assert.deepEqual(done.dayProgress.visits, {a:{status:'done',reportedAt:660},[second]:{status:'done',reportedAt:660}});
  assert.throws(()=>update(done,{id:'a',status:'pending'}),/2回目/);
  const revised=update(done,{id:second,status:'skipped'});
  const cleared=update(revised,{id:second,status:'clear'});
  assert.deepEqual(cleared.dayProgress.visits,{a:{status:'done',reportedAt:660}});
  assert.equal(settings.dayProgress,undefined);
});
test('progress does not carry to a new day or another park',() => {
  const current=update(settings,{status:'queue',end:690});
  const future=update({...current,date:'2026-11-20'},{id:'b',status:'done'});
  assert.deepEqual(future.dayProgress.visits,{b:{status:'done',reportedAt:660}});
  const another={...current,dayProgress:{...current.dayProgress,parkId:'sea'}};
  assert.deepEqual(update(another,{id:'b',status:'done'}).dayProgress.visits,{b:{status:'done',reportedAt:660}});
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
    querySelectorAll() { return chips; }
    setAttribute(key,value) { this[key]=value; }
    append() {}
    focus() {}
    scrollIntoView() {}
  }
  const chips = [5,10,20,30].map(minutes=>{
    const chip = new Field(); chip.dataset.remaining = String(minutes); return chip;
  });
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
  chips[2].dispatchEvent(new Event('click'));
  assert.equal(field('progressRemaining').value,'20');
  assert.equal(chips[2]['aria-pressed'],'true');
  assert.equal(chips[1]['aria-pressed'],'false');
  assert.match(field('progressEstimate').textContent,/11:30に終了予定。到着駅の降り場/);
  assert.ok(editor.hasDraft());
  editor.resumeDraft();
  assert.equal(field('progressRemaining').value,'20');
  assert.equal(field('progressClock').value,'11:00');
  field('progressReplan').dispatchEvent(new Event('click'));
  assert.equal(replans,1);
  assert.equal(writes,1);
  assert.equal(current.dayProgress.visits.a.endsAt,690);
  assert.equal(editor.hasDraft(),false);
  field('progressClock').value='11:05';
  field('progressClock').dispatchEvent(new Event('input'));
  assert.equal(field('progressRemaining').value,'15');
  assert.match(field('progressEstimate').textContent,/11:30に終了予定/);
  field('progressReplan').dispatchEvent(new Event('click'));
  assert.equal(replans,2);
  assert.equal(writes,1);
  editor.open('a','done');
  field('progressClock').value='11:35';
  field('progressClock').dispatchEvent(new Event('input'));
  assert.equal(field('progressDoneAt').value,'');
  assert.match(field('progressEstimate').textContent,/11:35に体験を終えた/);
  field('progressReset').dispatchEvent(new Event('click'));
  assert.equal(editor.hasDraft(),false);
  assert.equal(field('progressStatus').value,'queue');
  assert.equal(writes,1);
  editor.open('b');
  assert.equal(field('progressStatus').value,'');
  field('progressApply').dispatchEvent(new Event('click'));
  assert.match(field('progressMessage').textContent,/体験状況を選んで/);
  assert.equal(writes,1);
});

test('DPA visit controls reflect the selected ticket, repeat count and confirmed use',() => {
  const attraction = {...park.activities[0],name:'ライド',dpa:{price:2000}};
  const wish={id:attraction.id, repeatCount:2, dpaMode:'owned', dpaVisit:2};
  const render = (selection,category=attraction.category,limit=2) =>
    dpaEditor({...attraction,category},selection,{...park,nodes:[]},null,limit,{min:540,max:1260},2,2);
  assert.match(render(wish), /DPAを使う回/);
  assert.match(render(wish), /value="2" selected>2回目/);
  assert.match(render({...wish,dpaVisit:undefined}), /value="" selected>自動（2回目）/);
  assert.match(render({...wish,dpaVisit:1}), /今回は2回目に使います/);
  assert.doesNotMatch(render({...wish,repeatCount:1}), /data-field="dpaVisit"/);
  assert.doesNotMatch(render({...wish,dpaMode:'none'}), /data-field="dpaVisit"/);
  assert.doesNotMatch(render(wish,'parade'), /data-field="dpaVisit"/);
  changeDpaMode(wish,'consider');
  assert.equal(wish.dpaVisit,2);
  assert.match(render(wish), /data-field="dpaVisit"/);
  assert.doesNotMatch(render(wish,'attraction',0), /data-field="dpaVisit"/);
});

test('confirming completion without a clock keeps the earliest known upper bound over later edits',() => {
  const first=update(settings,{status:'done',at:620});
  const changed=update(first,{status:'done',at:740});
  assert.deepEqual(changed.dayProgress.visits.a,{status:'done',reportedAt:620});
  const timed=update(changed,{status:'done',at:745,doneAt:615});
  assert.deepEqual(timed.dayProgress.visits.a,{status:'done',endsAt:615});
});

test('an unreachable owned DPA for the second ride opens the original facility’s slot editor',() => {
  const ride={...park.activities[0],name:'ライド',dpa:{price:2000,wait:5}};
  const second=repeatVisitId(ride.id);
  const profile={...settings,selections:[{id:ride.id,repeatCount:2,dpaVisit:2,dpaMode:'owned',
    dpaStart:720,dpaEnd:750,dpaPurchasedAt:560}]};
  const actions=noPlanActions({status:'no-plan',settings:profile,omissions:[{id:second,name:'ライド（2回目）',required:true}]},
    {...park,activities:[ride]});
  assert.ok(actions.some(action=>action.wishId===ride.id && action.field==='dpaStart' && action.label.includes('2回目')));
});
