'use strict';
// Run from the project directory with: node tests/engine.test.js
// The complete routes use movement input, rather than moving the player
// directly to the crystal, sensors, gate or goal. Geometry unit tests below
// construct isolated contact states separately from those full playthroughs.
const assert = require('node:assert/strict');
const gameEngine = require('../engine.js');
const { createGame, applyRule, update, walkable, has, isBridge, fireGeometry, objective } = gameEngine;
let checks = 0;

function test(name, run) {
  try { run(); checks += 1; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name); throw error; }
}
function frames(game, keys, count, dt = 1 / 60) {
  const input = new Set(keys);
  for (let index = 0; index < count; index += 1) update(game, input, dt);
}
function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' differs from ' + expected);
}
function apply(game, target, effects) {
  const result = applyRule(game, target, effects);
  assert.equal(result.ok, true, result.message);
  return result;
}
function walkTo(game, x, y) {
  for (const [axis, destination] of [['x', x], ['y', y]]) {
    let steps = 0;
    while (Math.abs(game.player[axis] - destination) > 2 && !game.complete) {
      assert.ok(steps++ < 1000, 'Route blocked before ' + axis + '=' + destination + ': ' + JSON.stringify(game.player));
      const positive = destination > game.player[axis];
      const key = axis === 'x' ? (positive ? 'd' : 'a') : (positive ? 's' : 'w');
      update(game, new Set([key]), 1 / 120);
      assert.ok(walkable(game, game.player), 'Movement left the player without support');
    }
  }
}
function makeBridge(target) {
  const game = createGame();
  apply(game, target, ['float']);
  walkTo(game, game[target].x, 565);
  frames(game, ['e', 'w'], 48);
  frames(game, [], 1);
  assert.equal(isBridge(game, target), true);
  assert.equal(game[target].y, 390);
  assert.ok(game.player.y > 350 && game.player.y < 430, 'The player must be on the carried bridge');
  return game;
}
function collectCrystal(route) {
  let game;
  if (route === 'stone' || route === 'tree') {
    game = makeBridge(route);
    walkTo(game, game.player.x, 316);
  } else {
    game = createGame();
    apply(game, 'water', [route]);
    walkTo(game, 425, 316);
  }
  walkTo(game, 245, 316);
  assert.equal(game.core, true, 'The movement route must collect the crystal');
  assert.equal(game.complete, false);
  return game;
}

for (const route of ['freeze', 'solidify', 'stone', 'tree']) {
  test('complete stage via ' + route, () => {
    const game = collectCrystal(route);
    walkTo(game, 425, 316);
    apply(game, 'fire', ['heat']);
    assert.equal(game.gateOpen, false);
    frames(game, ['e'], 80);
    assert.equal(game.gateOpen, true);
    assert.equal(game.gateHeat, 1);
    walkTo(game, 425, 210);
    assert.equal(game.complete, true);
    assert.match(objective(game), /クリア/);
  });
}

test('river cannot be crossed without a supporting rule', () => {
  const game = createGame();
  frames(game, ['w'], 200);
  assert.ok(game.player.y >= 443 && game.player.y < 445);
  assert.equal(game.core, false);
  assert.equal(game.complete, false);
});

test('target rules remain active when another target is changed', () => {
  const game = createGame();
  apply(game, 'water', ['freeze']);
  walkTo(game, 425, 390);
  apply(game, 'stone', ['float', 'grow']);
  apply(game, 'fire', ['glow']);
  assert.equal(has(game, 'water', 'freeze'), true);
  assert.equal(has(game, 'stone', 'float'), true);
  assert.equal(has(game, 'stone', 'grow'), true);
  walkTo(game, 425, 316);
  assert.ok(game.player.y < 337);
});

test('removing water support in the river is rejected without changing state', () => {
  const game = createGame();
  apply(game, 'water', ['solidify']);
  walkTo(game, 425, 390);
  const before = JSON.stringify(game);
  assert.equal(applyRule(game, 'water', ['glow']).ok, false);
  assert.equal(JSON.stringify(game), before);
  walkTo(game, 425, 316);
  apply(game, 'water', ['glow']);
  assert.equal(has(game, 'water', 'solidify'), false);
});

for (const target of ['stone', 'tree']) {
  test('removing ' + target + ' bridge support is rejected', () => {
    const game = makeBridge(target);
    const before = JSON.stringify(game);
    assert.equal(applyRule(game, target, ['glow']).ok, false);
    assert.equal(JSON.stringify(game), before);
    assert.equal(isBridge(game, target), true);
  });
  test('carrying the ' + target + ' bridge never removes the player support', () => {
    const game = makeBridge(target);
    for (const direction of ['d', 'a', 'w', 's']) {
      for (let index = 0; index < 150; index += 1) {
        update(game, new Set(['e', direction]), 1 / 120);
        assert.ok(walkable(game, game.player), 'Carrying ' + target + ' in direction ' + direction + ' removed support');
      }
    }
  });
}

test('invalid rules are rejected without state changes', () => {
  const game = createGame();
  for (const [target, effects] of [
    ['unknown', ['glow']], ['__proto__', ['glow']], ['water', []],
    ['water', 'freeze'], ['water', null], ['water', ['freeze', 'freeze']],
    ['water', ['freeze', 'solidify', 'glow', 'pulse']], ['stone', ['freeze']],
    ['tree', ['move']], ['water', ['heat']], ['fire', [undefined]],
    ['fire', [1]], ['fire', ['unknown']]
  ]) {
    const before = JSON.stringify(game);
    assert.equal(applyRule(game, target, effects).ok, false, JSON.stringify([target, effects]));
    assert.equal(JSON.stringify(game), before);
  }
});

test('heat remains locked until the crystal is collected', () => {
  const game = createGame();
  assert.equal(applyRule(game, 'fire', ['heat']).ok, false);
  frames(game, ['e'], 200);
  assert.equal(game.gateOpen, false);
  assert.equal(game.gateHeat, 0);
  const collected = collectCrystal('freeze');
  apply(collected, 'fire', ['heat']);
  assert.equal(has(collected, 'fire', 'heat'), true);
});

test('the locked gate blocks the goal even after the river is crossed', () => {
  const game = createGame();
  apply(game, 'water', ['freeze']);
  walkTo(game, 425, 316);
  frames(game, ['w'], 100);
  assert.ok(game.player.y >= 305 && game.player.y < 307);
  frames(game, ['e'], 100);
  assert.equal(game.gateOpen, false);
  assert.equal(game.gateHeat, 0);
  assert.equal(game.complete, false);
});

test('gate heating requires the correct rule, range and stationary E input', () => {
  const game = collectCrystal('freeze');
  frames(game, ['e'], 80);
  assert.equal(game.gateHeat, 0);
  apply(game, 'fire', ['heat']);
  frames(game, ['e'], 80); // The crystal is outside the gate activation range.
  assert.equal(game.gateHeat, 0);
  walkTo(game, 425, 316);
  frames(game, ['e', 'd'], 20);
  assert.equal(game.gateHeat, 0);
  walkTo(game, 425, 316);
  frames(game, ['e'], 30);
  assert.ok(game.gateHeat > 0 && game.gateHeat < 1);
  assert.equal(game.gateOpen, false);
  const partial = game.gateHeat;
  frames(game, [], 100);
  close(game.gateHeat, partial);
  frames(game, ['e'], 50);
  assert.equal(game.gateOpen, true);
});

test('movement is normalised and opposing keys cancel', () => {
  const straight = createGame(), diagonal = createGame(), stationary = createGame();
  frames(straight, ['a'], 6);
  frames(diagonal, ['a', 'w'], 6);
  close(Math.hypot(diagonal.player.x - 425, diagonal.player.y - 565), 425 - straight.player.x);
  frames(stationary, ['a', 'd', 'w', 's'], 6);
  assert.deepEqual(stationary.player, { x: 425, y: 565 });
});

test('arrow keys match WASD movement', () => {
  const wasd = createGame(), arrows = createGame();
  frames(wasd, ['a', 's'], 6);
  frames(arrows, ['arrowleft', 'arrowdown'], 6);
  assert.deepEqual(arrows.player, wasd.player);
});

test('the player remains inside the field boundaries', () => {
  const game = createGame();
  frames(game, ['a'], 300);
  assert.ok(game.player.x >= 68 && game.player.x < 70);
  frames(game, ['d'], 600);
  assert.ok(game.player.x <= 802 && game.player.x > 800);
  frames(game, ['s'], 200);
  assert.ok(game.player.y <= 647 && game.player.y > 645);
  assert.equal(walkable(game, { x: 67.99, y: 565 }), false);
  assert.equal(walkable(game, { x: 802.01, y: 565 }), false);
  assert.equal(walkable(game, { x: 425, y: 127.99 }), false);
  assert.equal(walkable(game, { x: 425, y: 647.01 }), false);
});

test('frame delays are capped and subdivided without tunnelling', () => {
  const delayed = createGame(), smallSteps = createGame();
  update(delayed, new Set(['a']), 5);
  frames(smallSteps, ['a'], 12, 1 / 120);
  close(delayed.player.x, smallSteps.player.x);
  close(delayed.elapsed, 0.1);
  const river = createGame();
  for (let index = 0; index < 50; index += 1) update(river, new Set(['w']), 10);
  assert.ok(river.player.y >= 443);
});

test('invalid frame intervals leave the game unchanged', () => {
  const game = createGame();
  const before = JSON.stringify(game);
  for (const dt of [0, -1, NaN, Infinity, -Infinity]) update(game, new Set(['w']), dt);
  assert.equal(JSON.stringify(game), before);
});

test('fire contact uses the same animated geometry returned for drawing', () => {
  const dt = 1 / 120, time = 0.5;
  for (const offset of [-0.01, 0.01]) {
    const game = createGame();
    game.gateOpen = true;
    apply(game, 'fire', ['move', 'float', 'grow']);
    game.elapsed = time;
    const fire = fireGeometry(game);
    close(fire.x, 680 + 52 * Math.sin(time * 2.4));
    close(fire.y, 260 - 40 - 6 * Math.sin(time * 2.6));
    assert.equal(fire.radius, 34);
    game.player = { x: fire.x + fire.radius + 13 + offset, y: fire.y };
    game.elapsed = time - dt;
    update(game, new Set(), dt);
    if (offset < 0) {
      assert.deepEqual(game.player, { x: 425, y: 565 });
      assert.ok(game.damageUntil > game.elapsed);
    } else assert.ok(game.player.x > 700);
  }
});

test('extinguished fire is harmless and damage preserves progress', () => {
  const safe = createGame();
  apply(safe, 'fire', ['freeze']);
  safe.gateOpen = true;
  safe.player = { x: 680, y: 260 };
  update(safe, new Set(), 1 / 120);
  assert.deepEqual(safe.player, { x: 680, y: 260 });
  assert.equal(fireGeometry(safe).extinguished, true);
  const damaged = collectCrystal('freeze');
  damaged.gateOpen = true;
  damaged.player = { x: 680, y: 260 };
  update(damaged, new Set(), 1 / 120);
  assert.deepEqual(damaged.player, { x: 425, y: 565 });
  assert.equal(damaged.core, true);
  assert.equal(has(damaged, 'water', 'freeze'), true);
});

test('applied effects are copied rather than retained by reference', () => {
  const game = createGame(), effects = ['freeze'];
  apply(game, 'water', effects);
  effects[0] = 'glow';
  assert.equal(has(game, 'water', 'freeze'), true);
  assert.equal(has(game, 'water', 'glow'), false);
});

test('a fresh game resets progress and does not share mutable state', () => {
  const previous = collectCrystal('freeze');
  apply(previous, 'stone', ['float']);
  const fresh = createGame();
  assert.deepEqual(fresh.player, { x: 425, y: 565 });
  assert.deepEqual(fresh.stone, { x: 650, y: 520 });
  assert.deepEqual(fresh.rules, { water: null, stone: null, tree: null, fire: null });
  assert.equal(fresh.core, false);
  assert.equal(fresh.gateOpen, false);
  assert.equal(fresh.gateHeat, 0);
  assert.equal(fresh.ruleCount, 0);
  fresh.player.x += 10;
  assert.notEqual(fresh.player.x, previous.player.x);
});

test('a completed stage stops accepting movement and elapsed time', () => {
  const game = collectCrystal('solidify');
  walkTo(game, 425, 316);
  apply(game, 'fire', ['heat']);
  frames(game, ['e'], 80);
  walkTo(game, 425, 210);
  const before = JSON.stringify(game);
  frames(game, ['d', 's', 'e'], 100);
  assert.equal(JSON.stringify(game), before);
});


test('five stages have separate state, distinct layouts and two optional shards', () => {
  assert.equal(gameEngine.LEVELS.length, 5);
  const names = new Set();
  for (let index = 0; index < gameEngine.LEVELS.length; index++) {
    const game = createGame(index), fresh = createGame(index);
    names.add(game.level.name);
    assert.equal(game.stageIndex, index);
    assert.equal(game.level, gameEngine.LEVELS[index]);
    assert.equal(walkable(game, game.player), true);
    assert.equal(game.level.shards.length, 2);
    assert.notEqual(game.collectedShards, fresh.collectedShards);
    assert.notEqual(game.sensorCharge, fresh.sensorCharge);
    assert.notEqual(game.events, fresh.events);
    assert.equal(gameEngine.progressSteps(game).length, 4);
    assert.ok(gameEngine.hints(game).length >= 2);
  }
  assert.equal(names.size, 5);
  assert.equal(createGame(-1).stageIndex, 0);
  assert.equal(createGame(99).stageIndex, 0);
  assert.equal(createGame(NaN).stageIndex, 0);
});

test('sealed water rejects freezing and solidification without changing the game', () => {
  for (let index = 1; index < 5; index++) {
    const game = createGame(index);
    assert.deepEqual(gameEngine.supportedEffects(game, 'water'), ['glow', 'pulse']);
    for (const effect of ['freeze', 'solidify']) {
      const before = JSON.stringify(game);
      const result = applyRule(game, 'water', [effect]);
      assert.equal(result.ok, false);
      assert.match(result.message, /封印/);
      assert.equal(JSON.stringify(game), before);
    }
    apply(game, 'water', ['glow', 'pulse']);
  }
  assert.equal(gameEngine.supportedEffects(createGame(), 'water').includes('freeze'), true);
  assert.deepEqual(gameEngine.supportedEffects(createGame(), '__proto__'), []);
});

test('contradictory temperature and material definitions are explicitly rejected', () => {
  const game = createGame();
  game.core = true;
  for (const [target, effects] of [['fire', ['freeze', 'heat']], ['water', ['freeze', 'solidify']]]) {
    const before = JSON.stringify(game);
    const result = applyRule(game, target, effects);
    assert.equal(result.ok, false);
    assert.match(result.message, /同時/);
    assert.equal(JSON.stringify(game), before);
  }
});

test('float and grow change the geometry exposed to the renderer', () => {
  for (const target of ['stone', 'tree']) {
    const game = createGame();
    const original = gameEngine.objectGeometry(game, target);
    const deck = gameEngine.bridgeGeometry(game, target);
    apply(game, target, ['float', 'grow']);
    const changed = gameEngine.objectGeometry(game, target);
    const largerDeck = gameEngine.bridgeGeometry(game, target);
    assert.ok(changed.y <= original.y - 36);
    assert.ok(changed.radius >= original.radius * 1.6);
    assert.ok(changed.scale > original.scale);
    assert.ok(largerDeck.w > deck.w);
    assert.equal(deck.h, 102);
    assert.equal(largerDeck.h, 174);
    const cast = game.events.at(-1);
    assert.equal(cast.type, 'rule');
    assert.equal(cast.target, target);
    close(cast.x, changed.x);
    close(cast.y, changed.y);
    assert.match(cast.label, /浮遊・成長/);
  }
});

test('floating bob cannot move its collision shape into a stationary player', () => {
  const game = createGame();
  apply(game, 'stone', ['float']);
  game.player = { x: 650, y: 447 };
  assert.equal(walkable(game, game.player), true);
  for (let index = 0; index < 360; index++) {
    update(game, new Set(), 1 / 120);
    assert.equal(walkable(game, game.player), true, 'Bob trapped the player at tick ' + index);
  }
  assert.ok(game.elapsed > 2.9);
  const before = game.player.y;
  frames(game, ['w'], 5);
  assert.ok(game.player.y < before);
});

test('the light sensor requires the right object, position and a sustained glow', () => {
  const game = createGame(2), sensor = game.level.sensors[0];
  apply(game, 'tree', ['glow']);
  frames(game, [], 100);
  assert.equal(game.sensorLit[sensor.id], false, 'A distant glowing tree must not activate the sensor');
  game.tree = { x: sensor.x, y: sensor.y };
  frames(game, [], 30);
  assert.ok(game.sensorCharge[sensor.id] > 0 && game.sensorCharge[sensor.id] < 1);
  apply(game, 'tree', ['pulse']);
  frames(game, [], 1);
  assert.equal(game.sensorCharge[sensor.id], 0);
  apply(game, 'tree', ['glow']);
  frames(game, [], 65);
  assert.equal(game.sensorLit[sensor.id], true);
  assert.equal(game.sensorCharge[sensor.id], 1);
  assert.ok(game.events.some(item => item.type === 'sensor' && item.target === 'tree'));
  game.tree = { ...game.level.tree };
  apply(game, 'tree', ['pulse']);
  frames(game, [], 120);
  assert.equal(game.sensorLit[sensor.id], true, 'A completed sensor remains latched');
});

test('the resonance sensor requires both glow and pulse on the stone', () => {
  const game = createGame(3), sensor = game.level.sensors[0];
  game.stone = { x: sensor.x, y: sensor.y };
  for (const effects of [['glow'], ['pulse']]) {
    apply(game, 'stone', effects);
    frames(game, [], 100);
    assert.equal(game.sensorLit[sensor.id], false);
  }
  apply(game, 'tree', ['glow', 'pulse']);
  game.tree = { x: sensor.x, y: sensor.y };
  frames(game, [], 100);
  assert.equal(game.sensorLit[sensor.id], false, 'The wrong object does not activate the stone sensor');
  apply(game, 'stone', ['glow', 'pulse']);
  frames(game, [], 65);
  assert.equal(game.sensorLit[sensor.id], true);
});

test('the last stage has independent grown-stone and pulsing-tree sensors', () => {
  const game = createGame(4), [grown, signal] = game.level.sensors;
  game.stone = { x: grown.x, y: grown.y };
  apply(game, 'stone', ['glow', 'pulse']);
  frames(game, [], 100);
  assert.equal(game.sensorLit.grown, false);
  apply(game, 'stone', ['grow']);
  frames(game, [], 65);
  assert.equal(game.sensorLit.grown, true);
  assert.equal(game.sensorLit.signal, false);
  game.tree = { x: signal.x, y: signal.y };
  apply(game, 'tree', ['glow', 'pulse']);
  frames(game, [], 65);
  assert.equal(game.sensorLit.signal, true);
});

test('a crystal and heat alone cannot bypass an unfinished sensor', () => {
  const game = createGame(2), gate = game.level.gate;
  game.player = { x: gate.x + gate.w / 2, y: gate.y + 70 };
  game.core = true;
  apply(game, 'fire', ['heat']);
  frames(game, ['e'], 120);
  assert.equal(game.gateHeat, 0);
  assert.equal(game.gateOpen, false);
  assert.equal(game.heating, false);
  const sensor = game.level.sensors[0];
  game.tree = { x: sensor.x, y: sensor.y };
  apply(game, 'tree', ['glow']);
  frames(game, [], 65);
  frames(game, ['e'], 20);
  assert.equal(game.heating, true);
  assert.ok(game.gateHeat > 0 && game.gateHeat < 1);
  frames(game, ['e'], 65);
  assert.equal(game.gateOpen, true);
  assert.equal(game.heating, false);
  assert.ok(game.events.some(item => item.type === 'gate'));
});

test('shards are collected by walking and do not unlock heat or complete a stage', () => {
  const game = createGame();
  walkTo(game, 120, 560);
  assert.equal(game.collectedShards[0], true);
  assert.equal(game.collectedShards[1], false);
  assert.equal(game.core, false);
  assert.equal(game.complete, false);
  assert.equal(applyRule(game, 'fire', ['heat']).ok, false);
  assert.ok(game.events.some(item => item.type === 'shard'));
});

test('effect feedback events expire after three seconds', () => {
  const game = createGame();
  apply(game, 'stone', ['glow', 'pulse']);
  assert.equal(game.events.length, 1);
  assert.equal(game.events[0].type, 'rule');
  assert.match(game.rules.stone.description, /光/);
  frames(game, [], 200);
  assert.equal(game.events.length, 0);
});


// These full routes use ordinary movement/action input only.
(function verifyCompleteStageRoutes() {
const E = gameEngine;
const dt = 1 / 120;
function frames(game, keys, count) {
  for (let i = 0; i < count; i++) E.update(game, new Set(keys), dt);
}
function walkTo(game, x, y) {
  for (const [axis, destination] of [['x', x], ['y', y]]) {
    let steps = 0;
    while (Math.abs(game.player[axis] - destination) > 1 && !game.complete) {
      assert.ok(steps++ < 2500, 'Walk blocked: ' + JSON.stringify({axis,destination,player:game.player,stone:game.stone,tree:game.tree}));
      const key = axis === 'x' ? (game.player.x < destination ? 'd' : 'a') : (game.player.y < destination ? 's' : 'w');
      E.update(game, new Set([key]), dt);
      assert.ok(E.walkable(game, game.player), 'Player lost safe support');
    }
  }
}
function apply(game, target, effects) {
  const result = E.applyRule(game, target, effects);
  assert.ok(result.ok, result.message);
}
function carryTo(game, target, axis, destination) {
  let steps = 0;
  while (Math.abs(game[target][axis] - destination) > 1) {
    assert.ok(steps++ < 2500, 'Carry blocked: ' + JSON.stringify({target,axis,destination,player:game.player,stone:game.stone,tree:game.tree}));
    const key = axis === 'x' ? (game[target].x < destination ? 'd' : 'a') : (game[target].y < destination ? 's' : 'w');
    E.update(game, new Set(['e', key]), dt);
    assert.ok(E.walkable(game, game.player), 'Carrying lost safe support');
  }
}
function finish(game) {
  const gate = game.level.gate;
  const x = game.stageIndex === 1 ? 730 : gate.x + gate.w / 2;
  walkTo(game, x, gate.y + 70);
  apply(game, 'fire', ['heat']);
  frames(game, ['e'], 180);
  assert.ok(game.gateOpen, 'All gate requirements must be completed: ' + JSON.stringify(game.sensorLit));
  walkTo(game, x, game.level.goal.y + game.level.goal.h / 2);
  assert.ok(game.complete, 'Movement must reach the goal');
}
function runStage(stageIndex) {
  const game = E.createGame(stageIndex);
  if (stageIndex === 0) {
    apply(game, 'water', ['solidify']);
    walkTo(game, 425, 316); walkTo(game, 245, 316);
  } else if (stageIndex === 1) {
    apply(game, 'stone', ['float']);
    carryTo(game, 'stone', 'y', 430); frames(game, [], 2);
    walkTo(game, 650, 320); walkTo(game, 160, 320);
  } else if (stageIndex === 2) {
    apply(game, 'tree', ['float', 'glow']);
    walkTo(game, 240, 600); carryTo(game, 'tree', 'y', 430); frames(game, [], 2);
    walkTo(game, 240, 374); walkTo(game, 180, 374);
    carryTo(game, 'tree', 'y', 370); frames(game, [], 150);
    assert.ok(game.sensorLit.light);
    walkTo(game, 180, 350); walkTo(game, 700, 350); walkTo(game, 700, 330);
  } else if (stageIndex === 3) {
    apply(game, 'stone', ['float', 'glow', 'pulse']);
    walkTo(game, 650, 565); carryTo(game, 'stone', 'y', 390); carryTo(game, 'stone', 'x', 280); frames(game, [], 2);
    walkTo(game, game.player.x, 334); walkTo(game, 220, 334);
    carryTo(game, 'stone', 'y', 340); frames(game, [], 150);
    assert.ok(game.sensorLit.resonance);
    // Return the stone to the river after the receiver latches, opening the
    // north-bank corridor so the player can walk past the stone.
    carryTo(game, 'stone', 'y', 390); frames(game, [], 2);
    walkTo(game, game.player.x, 334); walkTo(game, 245, 316); walkTo(game, 245, 334);
  } else {
    apply(game, 'stone', ['float', 'grow']);
    walkTo(game, 650, 600); carryTo(game, 'stone', 'y', 415); frames(game, [], 2);
    walkTo(game, 650, 330); walkTo(game, 590, 330); carryTo(game, 'stone', 'y', 350);
    walkTo(game, 700, 330); carryTo(game, 'stone', 'x', 560); frames(game, [], 150);
    assert.ok(game.sensorLit.grown);
    carryTo(game, 'stone', 'y', 415); frames(game, [], 2);
    walkTo(game, 560, 570); walkTo(game, 240, 600);
    apply(game, 'tree', ['float', 'glow', 'pulse']);
    // Hold E continuously across the wide river: a small deck can be ferried,
    // while the grown stone gives a fixed bridge for the earlier return trip.
    carryTo(game, 'tree', 'y', 340); frames(game, [], 150);
    assert.ok(game.sensorLit.signal);
    walkTo(game, 700, 310);
  }
  finish(game);
  return game;
}
for (let stage = 0; stage < E.LEVELS.length; stage++) {
  test('complete all objectives and reach the goal in stage ' + (stage + 1), () => {
    const game = runStage(stage);
    assert.equal(game.core, true);
    assert.equal(game.gateOpen, true);
    assert.equal(game.complete, true);
    assert.ok(game.level.sensors.every(sensor => game.sensorLit[sensor.id]));
  });
}
})();

console.log(checks + ' engine checks passed.');
