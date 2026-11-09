'use strict';
// Persistent records are checked independently of game movement and the browser UI.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStore } = require(process.argv[2] ? path.resolve(process.argv[2]) : '../progress.js');
const KEY = 'world-definition-progress-v1';
function memoryStorage(initial) {
  const items = new Map(initial === undefined ? [] : [[KEY, typeof initial === 'string' ? initial : JSON.stringify(initial)]]);
  let reads = 0, writes = 0;
  return {
    getItem(key) { reads++; return items.get(key) ?? null; },
    setItem(key, value) { writes++; items.set(key, value); },
    get reads() { return reads; }, get writes() { return writes; }
  };
}
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }
const record = (rules = 4, shards = 1, time = 40) => ({ rules, shards, time });

test('an unavailable store starts with one stage and still tracks progress in memory', () => {
  const store = createStore(null, 5);
  assert.deepEqual(store.snapshot(), { unlocked: 0, lastStage: 0, best: {} });
  assert.equal(store.persistent, false);
  assert.equal(store.recordClear(0, record()), true);
  assert.equal(store.snapshot().unlocked, 1);
  assert.equal(store.select(1), true);
  assert.equal(store.snapshot().lastStage, 1);
});
test('valid clear records and the selected stage are restored', () => {
  const saved = { unlocked: 3, lastStage: 2, best: { 0: record(), 2: record(2, 2, 27) } };
  const storage = memoryStorage(saved), store = createStore(storage, 5);
  assert.deepEqual(store.snapshot(), saved);
  assert.equal(store.persistent, true);
  assert.equal(storage.reads, 1);
});
test('malformed JSON is ignored safely', () => {
  const store = createStore(memoryStorage('{invalid'), 5);
  assert.deepEqual(store.snapshot(), { unlocked: 0, lastStage: 0, best: {} });
  assert.equal(store.persistent, false);
});
test('unrecognised saved shapes and noninteger unlocks do not open stages', () => {
  for (const saved of ['null', 'true', '5', '[]', '{}', '{"unlocked":"4","lastStage":4}', '{"unlocked":2.5}', '{"lastStage":4}']) {
    const store = createStore(memoryStorage(saved), 5);
    assert.deepEqual(store.snapshot(), { unlocked: 0, lastStage: 0, best: {} }, saved);
  }
});
test('unlocked and last selected indices are bounded to available stages', () => {
  const high = createStore(memoryStorage({ unlocked: 999, lastStage: 999, best: {} }), 5);
  assert.equal(high.snapshot().unlocked, 4); assert.equal(high.snapshot().lastStage, 4);
  const low = createStore(memoryStorage({ unlocked: -7, lastStage: -1, best: {} }), 5);
  assert.equal(low.snapshot().unlocked, 0); assert.equal(low.snapshot().lastStage, 0);
  const fractional = createStore(memoryStorage({ unlocked: 3, lastStage: 2.5, best: {} }), 5);
  assert.equal(fractional.snapshot().lastStage, 0);
});
test('invalid best records are ignored and bounded count fields are normalised', () => {
  const store = createStore(memoryStorage({ unlocked: 4, best: {
    0: { rules: -1, shards: 1, time: 2 }, 1: { rules: 1, shards: '2', time: 2 },
    2: { rules: 1, shards: 1 }, 3: { rules: 2.9, shards: 99, time: 12.25 }
  } }), 5);
  assert.deepEqual(store.snapshot().best, { 3: { rules: 2, shards: 2, time: 12.25 } });
});
test('locked, out-of-range and invalid selections are rejected without saving', () => {
  const storage = memoryStorage(), store = createStore(storage, 5);
  for (const index of [1, -1, 5, 0.5, NaN, Infinity, '0', true, undefined]) assert.equal(store.select(index), false);
  assert.equal(storage.writes, 0);
  assert.equal(store.select(0), true); assert.equal(storage.writes, 1);
});
test('only completed unlocked stages can unlock the next stage', () => {
  const storage = memoryStorage(), store = createStore(storage, 5);
  for (const index of [1, -1, 5, 0.5, NaN, '0', undefined]) assert.equal(store.recordClear(index, record()), false);
  assert.equal(storage.writes, 0);
  for (let index = 0; index < 5; index++) {
    assert.equal(store.recordClear(index, record()), true);
    assert.equal(store.snapshot().unlocked, Math.min(index + 1, 4));
  }
});
test('record metrics retain the best independent result', () => {
  const store = createStore(memoryStorage(), 5);
  store.recordClear(0, record(6, 1, 70)); store.recordClear(0, record(8, 2, 50)); store.recordClear(0, record(4, 0, 90));
  assert.deepEqual(store.snapshot().best[0], record(4, 2, 50));
  store.recordClear(0, record(3.9, 99.5, 49.5));
  assert.deepEqual(store.snapshot().best[0], record(3, 2, 49.5));
});
test('invalid result metrics do not alter or save existing records', () => {
  const storage = memoryStorage(), store = createStore(storage, 5);
  store.recordClear(0, record()); const before = store.snapshot(), writes = storage.writes;
  for (const result of [null, {}, { rules: 2, shards: 1 }, record(-1), record(2, -1), record(2, 1, -1), record(Infinity), record(2, NaN), record(2, 1, '3')]) {
    assert.equal(store.recordClear(0, result), false);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(storage.writes, writes);
  }
});
test('returned snapshots cannot mutate the stored progress', () => {
  const store = createStore(memoryStorage(), 5); store.recordClear(0, record());
  const result = store.snapshot(); result.unlocked = 4; result.best[0].rules = 0; result.best[4] = record();
  assert.equal(store.snapshot().unlocked, 1); assert.equal(store.snapshot().best[0].rules, 4);
  assert.equal(store.snapshot().best[4], undefined);
});
test('read and write exceptions do not prevent a session from continuing', () => {
  const storage = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota'); } };
  const store = createStore(storage, 5); assert.equal(store.persistent, false);
  assert.equal(store.recordClear(0, record()), true); assert.equal(store.select(1), true);
  assert.equal(store.snapshot().lastStage, 1); assert.equal(store.persistent, false);
});
test('storage can recover and restore records in a later session', () => {
  const memory = memoryStorage(); let blocked = true;
  const storage = { getItem: key => memory.getItem(key), setItem(key, value) { if (blocked) throw new Error('Quota'); memory.setItem(key, value); } };
  const store = createStore(storage, 5); store.recordClear(0, record()); assert.equal(store.persistent, false);
  blocked = false; store.select(1); assert.equal(store.persistent, true);
  assert.deepEqual(createStore(storage, 5).snapshot(), store.snapshot());
});
test('an explicit storage key keeps records separate', () => {
  const storage = memoryStorage(); const first = createStore(storage, 5, 'first'); first.recordClear(0, record());
  assert.equal(createStore(storage, 5, 'second').snapshot().unlocked, 0);
  assert.equal(createStore(storage, 5, 'first').snapshot().unlocked, 1);
});
test('a previous five-stage final clear opens the first new challenge', () => {
  const storage = memoryStorage();
  storage.setItem('world-definition-progress-v1', JSON.stringify({ unlocked: 4, lastStage: 4, best: { 4: record() } }));
  const expanded = createStore(storage, 9);
  assert.equal(expanded.snapshot().unlocked, 5);
  assert.equal(expanded.snapshot().lastStage, 4);
  assert.deepEqual(expanded.snapshot().best[4], record());
  assert.equal(createStore(storage, 5).snapshot().unlocked, 4);
  storage.setItem('world-definition-progress-v1', JSON.stringify({ unlocked: 4, lastStage: 4, best: {} }));
  assert.equal(createStore(storage, 9).snapshot().unlocked, 4);
});
console.log(checks + ' progress checks passed.');
