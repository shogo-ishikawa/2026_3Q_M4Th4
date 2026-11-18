import test from 'node:test';
import assert from 'node:assert/strict';
import {dpaEditor, updateWishClock} from '../web/app.js';
import {validateSavedState} from '../web/storage.js';

const bounds = {min: 540, max: 1110};
const ride = {id: 'land-ride', name: 'ライド', category: 'attraction', dpa: {price: 2000}};
function editSlot(wish, key, value) {
  const fields = {};
  for (const field of ['earliest','latest','dpaStart','dpaEnd','dpaPurchasedAt']) {
    fields[field] = {dataset: {field}, value: ''};
  }
  fields[key].value = value;
  const card = {querySelector: selector => fields[selector.match(/"([^"]+)"/)[1]]};
  updateWishClock(wish, fields[key], card, bounds);
  return fields;
}

for (const mode of ['consider', 'owned']) {
  test(mode + ': editing either DPA endpoint suggests two hours within the open day', () => {
    const wish = {dpaMode: mode, earliest: 600, latest: 650, timeWindowLinked: false};
    const startFirst = editSlot(wish, 'dpaStart', '12:30');
    assert.equal(startFirst.dpaEnd.value, '14:30');
    assert.deepEqual([wish.dpaStart, wish.dpaEnd], [750, 870]);
    editSlot(wish, 'dpaStart', '17:45');
    assert.deepEqual([wish.dpaStart, wish.dpaEnd], [1065, 1110]);
    const endFirst = {dpaMode: mode};
    assert.equal(editSlot(endFirst, 'dpaEnd', '09:45').dpaStart.value, '09:00');
    assert.deepEqual([endFirst.dpaStart, endFirst.dpaEnd], [540, 585]);
    const newStart = editSlot(wish, 'dpaEnd', '12:00');
    assert.equal(newStart.dpaStart.value, '10:00');
    assert.deepEqual([wish.earliest, wish.latest], [600, 650]);
    assert.equal(wish.dpaPurchasedAt, undefined);
  });
}

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
  assert.match(html, /data-field="dpaWindowLinked">/);
  assert.match(html, /data-field="dpaStart" value="12:05"/);
  assert.match(html, /data-field="dpaEnd" value="12:25"/);
  assert.deepEqual([saved.dpaStart, saved.dpaEnd, saved.dpaPurchasedAt], [725, 745, 525]);
  wish.dpaWindowLinked = 'false';
  assert.throws(() => validateSavedState(state), /確認欄/);
});

test('editing or clearing one candidate preserves additional confirmed offers', () => {
  const wish = {dpaMode: 'consider', dpaStart: 600, dpaEnd: 625, dpaAvailableWindows: [[600,625], [720,750]]};
  editSlot(wish, 'dpaEnd', '11:30');
  assert.deepEqual(wish.dpaAvailableWindows, [[570,690], [720,750]]);
  editSlot(wish, 'dpaStart', '');
  assert.deepEqual(wish.dpaAvailableWindows, [[720,750]]);
  assert.equal(wish.dpaEnd, 690);
});
