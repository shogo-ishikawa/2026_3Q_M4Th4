'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(process.argv[2] ? path.resolve(process.argv[2]) : '../engine.js');
const S = require(process.argv[3] ? path.resolve(process.argv[3]) : '../session.js');
const KEY = 'world-definition-session-v1';
const clone = value => JSON.parse(JSON.stringify(value));
function memoryStorage(initial) {
  const items = new Map(initial === undefined ? [] : [[KEY, typeof initial === 'string' ? initial : JSON.stringify(initial)]]);
  return {
    getItem(key) { return items.get(key) ?? null; }, setItem(key, value) { items.set(key, value); }, removeItem(key) { items.delete(key); }
  };
}
function frames(game, keys, count) { for (let index = 0; index < count; index++) E.update(game, new Set(keys), 1 / 120); }
function apply(game, target, effects) { const result = E.applyRule(game, target, effects); assert.ok(result.ok, result.message); }
function crossingGame() {
  const game = E.createGame(); apply(game, 'water', ['freeze']); frames(game, ['w'], 100);
  assert.ok(game.player.y > 350 && game.player.y < 430, 'The fixture is partway across the real river');
  return game;
}
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }

test('a real river crossing resumes with the same position, rules and animation time', () => {
  const storage = memoryStorage(), game = crossingGame();
  assert.equal(S.createStore(storage, E).save(game), true);
  const restored = S.createStore(storage, E).load(0);
  assert.deepEqual(S.capture(E, restored), S.capture(E, game));
  assert.ok(E.walkable(restored, restored.player));
  frames(restored, ['w'], 50);
  assert.ok(restored.player.y < game.player.y, 'The restored player can finish crossing');
});
test('captured data has no level definition, transient notices or drawing events', () => {
  const game = E.createGame(); game.notice = '一時表示'; game.events = [{ type: 'rule', x: 1 }]; game.heating = true;
  const snapshot = S.capture(E, game);
  for (const key of ['level', 'events', 'notice', 'heating']) assert.equal(Object.hasOwn(snapshot.state, key), false);
  const restored = S.restore(E, snapshot);
  assert.equal(restored.level, E.LEVELS[0]); assert.deepEqual(restored.events, []); assert.equal(restored.notice, ''); assert.equal(restored.heating, false);
});
test('sensor charge, collected items and an opened gate survive reloading', () => {
  const game = E.createGame(2); apply(game, 'tree', ['float', 'glow']);
  game.player = { x: 180, y: 374 }; game.tree = { x: 245, y: 365 }; frames(game, [], 60);
  assert.ok(game.sensorCharge.light > 0 && game.sensorCharge.light < 1);
  game.core = true; game.collectedShards[0] = true; game.gateOpen = true; game.gateHeat = 1;
  const restored = S.restore(E, S.capture(E, game));
  assert.ok(restored); assert.equal(restored.sensorCharge.light, game.sensorCharge.light);
  assert.equal(restored.core, true); assert.equal(restored.collectedShards[0], true); assert.equal(restored.gateOpen, true);
  frames(restored, [], 80); assert.ok(restored.sensorLit.light, 'Charging continues after reloading');
});
test('snapshots and restored games cannot mutate their source or each other', () => {
  const original = crossingGame(), snapshot = S.capture(E, original), restored = S.restore(E, snapshot);
  snapshot.state.player.x = 70; snapshot.state.rules.water.effects[0] = 'glow';
  assert.equal(restored.player.x, 425); assert.deepEqual(restored.rules.water.effects, ['freeze']);
  restored.player.y = 330; restored.rules.water.effects.push('glow');
  assert.equal(snapshot.state.rules.water.effects.length, 1);
  assert.equal(original.player.x, 425); assert.equal(original.rules.water.effects.length, 1);
  const again = S.restore(E, S.capture(E, original)); assert.equal(again.rules.water.effects.length, 1);
});
test('locked stages, wrong stage IDs and unknown snapshot formats are rejected', () => {
  const snapshot = S.capture(E, E.createGame(1));
  assert.equal(S.restore(E, snapshot, 0), null);
  assert.ok(S.restore(E, snapshot, 1));
  for (const alter of [x => { x.version = 2; }, x => { x.stageId = 'obsolete'; }, x => { x.state.stageIndex = 99; }, x => { x.state.stageIndex = 0.5; }, x => { x.state.extra = true; }, x => { x.extra = true; }, x => { delete x.state.core; }]) {
    const bad = clone(snapshot); alter(bad); assert.equal(S.restore(E, bad, 8), null);
  }
  assert.equal(S.restore(E, snapshot, NaN), null); assert.equal(S.restore(E, snapshot, 1.5), null);
});
test('invalid coordinates, unsupported footings and inconsistent counters are rejected', () => {
  const snapshot = S.capture(E, E.createGame());
  const changes = [
    x => { x.player.x = NaN; }, x => { x.player.y = -1; }, x => { x.player.y = 380; },
    x => { x.player = { x: 425, y: 280 }; }, x => { x.checkpoint.x = 999; }, x => { x.checkpoint.y = 380; },
    x => { x.tree.y = Infinity; }, x => { x.elapsed = -1; }, x => { x.damageUntil = 100; },
    x => { x.ruleCount = 0.5; }, x => { x.gateHeat = 1.2; }, x => { x.gateOpen = true; },
    x => { x.floatOffsets.stone = 999; }, x => { x.sensorCharge.extra = 0; },
    x => { x.collectedShards.push(false); }, x => { x.preferredCarryTarget = 'fire'; },
    x => { x.complete = true; }
  ];
  for (const alter of changes) { const bad = clone(snapshot); alter(bad.state); assert.equal(S.restore(E, bad), null); }
});
test('rule validation rejects unsupported, repeated, contradictory and oversized definitions', () => {
  const snapshot = S.capture(E, crossingGame());
  const changes = [
    rule => { rule.target = 'tree'; }, rule => { rule.effects = ['float']; }, rule => { rule.effects = []; },
    rule => { rule.effects = ['freeze', 'freeze']; }, rule => { rule.effects = ['freeze', 'solidify']; },
    rule => { rule.name = ''; }, rule => { rule.name = 'x'.repeat(61); }, rule => { rule.description = 'x'.repeat(181); },
    rule => { rule.extra = 'unknown'; }
  ];
  for (const alter of changes) { const bad = clone(snapshot); alter(bad.state.rules.water); assert.equal(S.restore(E, bad), null); }
  const fire = clone(snapshot); fire.state.rules.fire = { target: 'fire', effects: ['heat'], name: '熱', description: '熱を送る' };
  assert.equal(S.restore(E, fire), null, 'Heat cannot be restored before collecting the crystal');
  const sealed = S.capture(E, E.createGame(1)); sealed.state.rules.water = snapshot.state.rules.water;
  assert.equal(S.restore(E, sealed), null, 'A sealed stage cannot restore frozen water');
});
test('malformed, oversized and unavailable storage never prevent a new game', () => {
  for (const raw of ['{broken', 'null', '[]', 'true', '{}', 'x'.repeat(40001)]) assert.equal(S.createStore(memoryStorage(raw), E).load(0), null);
  const broken = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('Denied'); } };
  const store = S.createStore(broken, E); assert.equal(store.persistent, false);
  assert.equal(store.save(E.createGame()), true); assert.equal(store.persistent, false); assert.ok(store.load(0));
  store.clear(); assert.equal(store.load(0), null);
});
test('missing storage keeps a usable session in memory and clearing removes it', () => {
  const store = S.createStore(null, E); assert.equal(store.persistent, false); assert.equal(store.load(0), null);
  assert.equal(store.save(crossingGame()), true); assert.ok(store.load(0)); store.clear(); assert.equal(store.load(0), null);
});
test('storage can recover and custom keys keep sessions separate from clear records', () => {
  const memory = memoryStorage(); let blocked = true;
  const storage = { getItem: key => memory.getItem(key), setItem(key, value) { if (blocked) throw new Error('Quota'); memory.setItem(key, value); }, removeItem: key => memory.removeItem(key) };
  const store = S.createStore(storage, E, 'first'); store.save(crossingGame()); assert.equal(store.persistent, false);
  blocked = false; store.save(crossingGame()); assert.equal(store.persistent, true);
  assert.ok(S.createStore(storage, E, 'first').load(0)); assert.equal(S.createStore(storage, E, 'second').load(0), null);
  assert.equal(memory.getItem('world-definition-progress-v1'), null);
  store.clear(); assert.equal(S.createStore(storage, E, 'first').load(0), null);
});
test('one undo restores a definition and a later undo restores the earlier carried object', () => {
  const game = E.createGame(1), history = S.createHistory(E);
  history.record(game); apply(game, 'stone', ['float']);
  history.record(game); const beforeCarry = S.capture(E, game); frames(game, ['e', 'w'], 84); frames(game, [], 2);
  assert.ok(game.stone.y < 500);
  frames(game, ['w'], 75);
  const placed = S.capture(E, game); apply(game, 'stone', ['glow']); history.recordSnapshot(placed);
  const undoRule = history.undo(); assert.ok(E.has(undoRule, 'stone', 'float')); assert.deepEqual(undoRule.stone, placed.state.stone);
  const undoCarry = history.undo(); assert.deepEqual(S.capture(E, undoCarry), beforeCarry);
  const undoFirst = history.undo(); assert.equal(undoFirst.rules.stone, null); assert.equal(history.canUndo, false); assert.equal(history.undo(), null);
});
test('failed definitions can be omitted from history and entries are independent', () => {
  const game = E.createGame(), history = S.createHistory(E), before = S.capture(E, game);
  assert.equal(E.applyRule(game, 'fire', ['heat']).ok, false); assert.equal(history.canUndo, false);
  apply(game, 'water', ['solidify']); history.recordSnapshot(before);
  before.state.player.x = 75;
  const undone = history.undo(); assert.equal(undone.player.x, 425); assert.equal(undone.rules.water, null);
});
test('history has a bounded size, ignores duplicate snapshots and resets per stage', () => {
  const game = E.createGame(), history = S.createHistory(E, { limit: 2 });
  assert.equal(history.record(game), true); assert.equal(history.record(game), false);
  frames(game, ['a'], 10); history.record(game); const kept = clone(game.player);
  frames(game, ['a'], 10); history.record(game); assert.equal(history.size, 2);
  history.undo(); assert.deepEqual(history.undo().player, kept); assert.equal(history.undo(), null);
  history.record(E.createGame(1)); history.clear(); assert.equal(history.size, 0); assert.equal(history.canUndo, false);
  assert.equal(history.recordSnapshot({}), false);
});
test('saving a completed game does not replace the last resumable session', () => {
  const store = S.createStore(memoryStorage(), E), game = crossingGame(); store.save(game); const before = S.capture(E, store.load(0));
  game.complete = true; assert.equal(store.save(game), false); assert.deepEqual(S.capture(E, store.load(0)), before);
  store.clear(); assert.equal(store.load(0), null);
});
test('an unsupported history limit falls back to a safe bound', () => {
  const history = S.createHistory(E, { limit: -1 });
  assert.equal(history.record(E.createGame()), true); assert.equal(history.size, 1);
});

// 新しいエンジンを引数で渡すと、応用面の状態も同じ保存形式で確認できます。
if (E.LEVELS.some(level => level.id === 'material-rhythm') && E.EFFECTS.some(effect => effect.id === 'rotate')) {
  test('a shrunken object and a horizontal bridge retain their shape after resuming', () => {
    const small = E.createGame(E.LEVELS.findIndex(level => level.id === 'small-door'));
    apply(small, 'stone', ['float', 'shrink']); frames(small, ['e', 'w'], 60);
    const smallAgain = S.restore(E, S.capture(E, small)); assert.ok(smallAgain);
    assert.deepEqual(E.objectGeometry(smallAgain, 'stone'), E.objectGeometry(small, 'stone'));
    const bridge = E.createGame(E.LEVELS.findIndex(level => level.id === 'turning-bridge'));
    apply(bridge, 'tree', ['float', 'rotate', 'glow']);
    bridge.tree = { x: 435, y: 550 }; bridge.player = { x: 435, y: 550 };
    assert.ok(E.walkable(bridge, bridge.player));
    const bridgeAgain = S.restore(E, S.capture(E, bridge)); assert.ok(bridgeAgain);
    assert.deepEqual(E.bridgeGeometry(bridgeAgain, 'tree'), E.bridgeGeometry(bridge, 'tree'));
    assert.ok(E.bridgeGeometry(bridgeAgain, 'tree').w > E.bridgeGeometry(bridgeAgain, 'tree').h);
    const bad = S.capture(E, smallAgain); bad.state.rules.stone.effects.push('grow'); assert.equal(S.restore(E, bad), null);
  });
  test('hold plates still switch off when their object is moved after reloading', () => {
    const game = E.createGame(E.LEVELS.findIndex(level => level.id === 'two-lights'));
    apply(game, 'stone', ['float', 'grow', 'glow']); apply(game, 'tree', ['float', 'glow', 'pulse']);
    game.stone = { x: 280, y: 340 }; game.tree = { x: 580, y: 340 }; frames(game, [], 180);
    assert.ok(Object.values(game.sensorLit).every(Boolean));
    const restored = S.restore(E, S.capture(E, game)); assert.ok(restored);
    restored.tree.x = 720; frames(restored, [], 1);
    assert.equal(restored.sensorLit['held-tree'], false); assert.equal(restored.sensorLit['held-stone'], true);
    assert.equal(game.sensorLit['held-tree'], true);
  });
  test('pulse charge continues from the saved phase and invalid object-wall overlap is refused', () => {
    const game = E.createGame(E.LEVELS.findIndex(level => level.id === 'material-rhythm'));
    apply(game, 'stone', ['float', 'glow', 'pulse']); game.stone = { x: 290, y: 350 }; frames(game, [], 120);
    assert.ok(game.sensorCharge.rhythm > 0 && game.sensorCharge.rhythm < 1);
    const restored = S.restore(E, S.capture(E, game)); assert.ok(restored); frames(restored, [], 600);
    assert.ok(restored.sensorLit.rhythm);
    const small = E.createGame(E.LEVELS.findIndex(level => level.id === 'small-door'));
    const bad = S.capture(E, small); bad.state.stone = { x: 620, y: 500 };
    assert.equal(S.restore(E, bad), null);
  });
}


if (E.LEVELS.some(level => level.mystery)) {
  const mysteryIndex = id => E.LEVELS.findIndex(level => level.id === id);
  function walkTo(game, x, y) {
    for (const [axis, destination] of [['x', x], ['y', y]]) {
      let steps = 0;
      while (Math.abs(game.player[axis] - destination) > 1) {
        assert.ok(steps++ < 3000, 'Session route blocked: ' + JSON.stringify({ axis, destination, player: game.player }));
        const key = axis === 'x' ? (game.player.x < destination ? 'd' : 'a') : (game.player.y < destination ? 's' : 'w');
        E.update(game, new Set([key]), 1 / 120);
        assert.ok(E.walkable(game, game.player));
      }
    }
  }
  function press(game) { frames(game, ['e'], 1); frames(game, [], 1); }
  function restored(game) {
    const snapshot = S.capture(E, game);
    assert.ok(snapshot, 'A legitimate mystery state must be resumable');
    const result = S.restore(E, snapshot);
    assert.ok(result); return result;
  }
  test('all four mystery maps save at their real starting positions', () => {
    for (let index = 0; index < E.LEVELS.length; index++) {
      if (!E.LEVELS[index].mystery) continue;
      const game = E.createGame(index), store = S.createStore(memoryStorage(), E, 'world-definition-session-v2');
      assert.equal(store.save(game), true);
      assert.equal(store.load(index - 1), null, 'Unsolved mysteries cannot be restored through a save');
      assert.deepEqual(S.capture(E, store.load(index)), S.capture(E, game));
      assert.ok(game.player.y > 660, 'Mystery maps extend beyond the old fixed board');
    }
  });
  test('waterwheel flow, a remote checkpoint and partial battery charge continue after reloading', () => {
    const game = E.createGame(mysteryIndex('mystery-waterwheel'));
    walkTo(game, 250, 900); press(game);
    assert.equal(E.notebook(game).length, 1);
    walkTo(game, 250, 1020); apply(game, 'water', ['freeze']); walkTo(game, 1000, 350); walkTo(game, 850, 390); press(game);
    assert.equal(game.core, true); assert.equal(game.puzzle.intakeOpen, true);
    const beforeClear = S.capture(E, game), history = S.createHistory(E); history.recordSnapshot(beforeClear);
    assert.equal(E.clearRule(game, 'water').ok, true); frames(game, [], 45);
    assert.ok(game.puzzle.powerCharge > 0 && game.puzzle.powerCharge < 1);
    const again = restored(game);
    assert.deepEqual(again.player, game.player); assert.ok(again.player.x > 815);
    assert.equal(E.physicalState(again).activeMechanisms.wheel, true);
    assert.equal(again.puzzle.powerCharge, game.puzzle.powerCharge);
    assert.equal(E.notebook(again)[0].id, 'wheel-sign');
    frames(again, [], 200); assert.equal(again.gateOpen, true);
    const undone = history.undo(); assert.equal(E.has(undone, 'water', 'freeze'), true);
    assert.equal(E.physicalState(undone).activeMechanisms.wheel, false);
    assert.equal(E.notebook(undone).length, 1);
  });
  test('library clues, a released light and partial rune order survive without a sticky E key', () => {
    const game = E.createGame(mysteryIndex('mystery-shadow-library'));
    apply(game, 'tree', ['glow']); walkTo(game, 350, 450); press(game);
    assert.equal(game.puzzle.seenClues['hidden-poem'], true);
    const history = S.createHistory(E); history.record(game);
    assert.equal(E.clearRule(game, 'tree').ok, true);
    walkTo(game, 800, 870); walkTo(game, 930, 870); walkTo(game, 1300, 900); press(game);
    walkTo(game, 1050, 680); frames(game, ['e'], 1);
    assert.equal(game.puzzle.codeProgress, 2); assert.equal(game.puzzle.eHeld, true);
    const again = restored(game);
    assert.equal(again.rules.tree, null); assert.equal(again.puzzle.codeProgress, 2);
    assert.equal(again.puzzle.eHeld, false, 'A released browser input is never restored as held');
    assert.deepEqual(E.notebook(again), E.notebook(game));
    frames(again, ['e'], 1); assert.equal(again.puzzle.codeProgress, 0, 'A fresh E press is processed immediately after resuming');
    const undone = history.undo(); assert.equal(E.has(undone, 'tree', 'glow'), true);
    assert.equal(undone.puzzle.seenClues['hidden-poem'], true);
  });
  test('a grounded stone keeps a weight gate open while its release can be undone', () => {
    const game = E.createGame(mysteryIndex('mystery-weight'));
    apply(game, 'stone', ['float']); game.stone = { x: 520, y: 950 }; game.player = { x: 450, y: 950 };
    assert.ok(E.walkable(game, game.player));
    const history = S.createHistory(E); history.record(game);
    assert.equal(E.clearRule(game, 'stone').ok, true);
    apply(game, 'tree', ['grow']);
    const again = restored(game), physical = E.physicalState(again);
    assert.equal(again.rules.stone, null); assert.equal(physical.doorStates.weight, true); assert.equal(physical.doorStates.roots, true);
    const undone = history.undo(); assert.equal(E.has(undone, 'stone', 'float'), true);
    assert.equal(E.physicalState(undone).doorStates.weight, false);
  });
  test('a drained riverbed is resumable and unsafe refilling leaves the saved footing intact', () => {
    const game = E.createGame(mysteryIndex('mystery-source-maze'));
    apply(game, 'tree', ['glow']); walkTo(game, 450, 820); press(game);
    assert.equal(game.puzzle.seenClues['flow-plan'], true);
    apply(game, 'water', ['solidify']); walkTo(game, 700, 550); walkTo(game, 1100, 550);
    assert.equal(game.core, true); assert.ok(game.checkpoint.x > 815);
    assert.equal(E.physicalState(game).rivers.some(item => item.id === 'tail'), false);
    const again = restored(game), before = S.capture(E, again);
    assert.equal(E.clearRule(again, 'water').ok, false, 'The dry riverbed cannot be flooded under the player');
    assert.deepEqual(S.capture(E, again), before);
    assert.equal(E.notebook(again)[0].id, 'flow-plan');
  });
  test('refilling a riverbed repairs a wet checkpoint before saving from a floating platform', () => {
    const game = E.createGame(mysteryIndex('mystery-source-maze'));
    apply(game, 'water', ['solidify']);
    game.player = { x: 1100, y: 550 }; game.checkpoint = { ...game.player }; game.stone = { x: 1135, y: 550 };
    apply(game, 'stone', ['float', 'grow']);
    assert.ok(S.capture(E, game));
    assert.equal(E.clearRule(game, 'water').ok, true);
    assert.equal(E.physicalState(game).rivers.some(item => item.id === 'tail'), true);
    assert.ok(E.walkable(game, game.player), 'The floating platform supports the player after refilling');
    assert.notDeepEqual(game.checkpoint, { x: 1100, y: 550 }, 'The now-wet checkpoint is repaired immediately');
    const again = restored(game);
    assert.deepEqual(again.checkpoint, game.checkpoint);
    assert.ok(E.walkable(again, again.player));
  });
  test('mystery saves reject invalid codes, charge, clue shapes and out-of-world locations', () => {
    const game = E.createGame(mysteryIndex('mystery-shadow-library')), snapshot = S.capture(E, game);
    for (const alter of [x => { x.puzzle.codeProgress = 4; }, x => { x.puzzle.codeProgress = 1.5; }, x => { x.puzzle.powerCharge = -0.1; },
      x => { x.puzzle.powerCharge = 1.1; }, x => { x.puzzle.seenClues.extra = true; }, x => { x.puzzle.eHeld = 'yes'; },
      x => { x.puzzle.exitOpen = true; }, x => { x.gateOpen = true; }, x => { x.player.x = 1700; }, x => { x.checkpoint.y = 1200; }]) {
      const bad = clone(snapshot); alter(bad.state); assert.equal(S.restore(E, bad), null);
    }
    const water = E.createGame(mysteryIndex('mystery-waterwheel')), wet = S.capture(E, water);
    wet.state.checkpoint = { x: 1000, y: 650 };
    assert.equal(S.restore(E, wet), null, 'A wet checkpoint cannot enter a restored world');
    const inWall = clone(snapshot); inWall.state.checkpoint = { x: 862, y: 450 };
    assert.equal(S.restore(E, inWall), null, 'A checkpoint inside a solid wall is invalid');
    apply(game, 'tree', ['glow']);
    const closedDoor = S.capture(E, game); closedDoor.state.checkpoint = { x: 862, y: 870 };
    assert.equal(S.restore(E, closedDoor), null, 'Door state must be evaluated after restoring the light definition');
    const open = clone(snapshot);
    open.state.core = true; open.state.gateOpen = true; open.state.puzzle.exitOpen = true;
    open.state.puzzle.powerCharge = 1; open.state.puzzle.codeProgress = 3;
    assert.ok(S.restore(E, open), 'A consistent completed mechanism can be resumed before entering its exit');
    open.state.gateOpen = false;
    assert.equal(S.restore(E, open), null, 'The engine gate and mystery exit must agree in both directions');
  });
}

console.log(checks + ' session checks passed.');
