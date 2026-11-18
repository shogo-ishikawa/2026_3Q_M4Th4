import test from 'node:test';
import assert from 'node:assert/strict';
import {dpaEditor, dpaExampleWindow, updateWishClock, wishInputProblem} from '../web/app.js';
import {validateSavedState} from '../web/storage.js';

const bounds = {min: 540, max: 1110};
const ride = {id: 'land-ride', name: 'ライド', category: 'attraction', dpa: {price: 2000}};
function editSlot(wish, key, value) {
  updateWishClock(wish, {dataset:{field:key},value});
}

for (const mode of ['consider', 'owned']) {
  test(mode + ': changing a ticket endpoint preserves its partner and the independent wish times', () => {
    for (const wasLinked of [undefined,false,true]) {
      const wish = {dpaMode:mode, earliest:600, latest:650, dpaWindowLinked:wasLinked, timeWindowLinked:wasLinked};
      editSlot(wish, 'dpaEnd', '13:15');
      assert.equal(wish.dpaStart, undefined);
      editSlot(wish, 'dpaStart', '12:30');
      assert.deepEqual([wish.dpaStart, wish.dpaEnd], [750, 795]);
      editSlot(wish, 'dpaEnd', '13:00');
      assert.deepEqual([wish.dpaStart, wish.dpaEnd], [750, 780]);
      editSlot(wish, 'earliest', '09:30');
      assert.deepEqual([wish.earliest, wish.latest], [570, 650]);
      assert.equal(wish.dpaPurchasedAt, undefined);
      const startFirst={dpaMode:mode};
      editSlot(startFirst, 'dpaStart', '11:30');
      assert.equal(startFirst.dpaEnd, undefined);
    }
  });
}

test('the documented attraction example completes only a checked candidate and accepts either endpoint first', () => {
  const beast={...ride,id:'land-attraction-197'},wish={id:beast.id,dpaMode:'consider'};
  assert.equal(dpaExampleWindow(wish,bounds),null);
  editSlot(wish,'dpaStart','12:30');
  assert.deepEqual(dpaExampleWindow(wish,bounds),{start:750,end:780,field:'dpaEnd'});
  assert.match(dpaEditor(beast,wish,{nodes:[]},undefined,1,bounds),/12:30–13:00を確認して入力/);
  assert.equal(wishInputProblem(wish,beast).field,'dpaEnd');
  assert.deepEqual(wish.dpaAvailableWindows,[]);
  editSlot(wish,'dpaEnd','13:00');
  assert.equal(wishInputProblem(wish,beast),null);
  assert.deepEqual(wish.dpaAvailableWindows,[[750,780]]);
  assert.equal(dpaExampleWindow(wish,bounds),null);
  editSlot(wish,'dpaStart','');
  assert.deepEqual(dpaExampleWindow(wish,bounds),{start:750,end:780,field:'dpaStart'});
  for(const change of [{id:ride.id},{dpaMode:'owned'},{dpaEnd:550},{dpaStart:1090,dpaEnd:undefined}])
    assert.equal(dpaExampleWindow({...wish,...change},bounds),null);
});

test('an exact ticket can be adjusted independently, saved and displayed with its recorded width', () => {
  const wish = {id: ride.id, weight: 4, dpaMode: 'owned', dpaWindowLinked: false};
  editSlot(wish, 'dpaEnd', '12:25');
  assert.equal(wish.dpaStart, undefined);
  editSlot(wish, 'dpaStart', '12:05');
  editSlot(wish, 'dpaPurchasedAt', '08:45');
  const state = {parkId: 'land', settings: {date: '2026-11-18', entry: 540, exit: 1110, speed: 70, budget: 5000, selections: [wish]}};
  validateSavedState(state);
  const saved = JSON.parse(JSON.stringify(wish));
  const html = dpaEditor(ride, saved, {nodes: []});
  assert.doesNotMatch(html, /dpaWindowLinked|2時間差/);
  assert.match(html, /data-field="dpaStart" value="12:05"/);
  assert.match(html, /data-field="dpaEnd" value="12:25"/);
  assert.deepEqual([saved.dpaStart, saved.dpaEnd, saved.dpaPurchasedAt], [725, 745, 525]);
  wish.dpaWindowLinked = 'false';
  assert.throws(() => validateSavedState(state), /確認欄/);
});

test('editing or clearing one candidate preserves additional confirmed offers', () => {
  const wish = {dpaMode: 'consider', dpaStart: 600, dpaEnd: 625, dpaAvailableWindows: [[600,625], [720,750]]};
  editSlot(wish, 'dpaEnd', '11:30');
  assert.deepEqual(wish.dpaAvailableWindows, [[600,690], [720,750]]);
  editSlot(wish, 'dpaStart', '');
  assert.deepEqual(wish.dpaAvailableWindows, [[720,750]]);
  assert.equal(wish.dpaEnd, 690);
});
