'use strict';
// Run from the project directory with: node tests/engine.test.js
// The complete routes use movement input, rather than moving the player
// directly to the crystal, sensors, gate or goal. Geometry unit tests below
// construct isolated contact states separately from those full playthroughs.
const assert = require('node:assert/strict');
const path = require('node:path');
const gameEngine = require(process.argv[2] ? path.resolve(process.argv[2]) : '../engine.js');
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

test('clearing a rule removes only its target and counts as one reversible action', () => {
  const game = createGame();
  apply(game, 'water', ['freeze']); apply(game, 'stone', ['float', 'glow']);
  const beforeStone = JSON.stringify(game.rules.stone), beforeCount = game.ruleCount;
  assert.equal(gameEngine.clearRule(game, 'water').ok, true);
  assert.equal(game.rules.water, null); assert.equal(has(game, 'water', 'freeze'), false);
  assert.equal(JSON.stringify(game.rules.stone), beforeStone); assert.equal(game.ruleCount, beforeCount + 1);
  const state = JSON.stringify(game);
  assert.equal(gameEngine.clearRule(game, 'water').ok, false);
  assert.equal(gameEngine.clearRule(game, 'unknown').ok, false);
  assert.equal(JSON.stringify(game), state, 'An empty or unsupported clear cannot consume an action');
});
test('clearing the water under the player is rejected without changing state', () => {
  const game = createGame(); apply(game, 'water', ['freeze']); walkTo(game, 425, 390);
  const state = JSON.stringify(game);
  assert.equal(gameEngine.clearRule(game, 'water').ok, false);
  assert.equal(JSON.stringify(game), state);
  walkTo(game, 425, 316);
  assert.equal(gameEngine.clearRule(game, 'water').ok, true);
});
test('clearing an occupied floating bridge is rejected but is safe after reaching a bank', () => {
  for (const target of ['stone', 'tree']) {
    const game = makeBridge(target), state = JSON.stringify(game);
    assert.equal(gameEngine.clearRule(game, target).ok, false);
    assert.equal(JSON.stringify(game), state);
    walkTo(game, game.player.x, 316);
    assert.equal(gameEngine.clearRule(game, target).ok, true);
    assert.equal(game.rules[target], null); assert.ok(walkable(game, game.player));
  }
});

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
  const checkpoint = { ...damaged.checkpoint };
  damaged.gateOpen = true;
  damaged.player = { x: 680, y: 260 };
  update(damaged, new Set(), 1 / 120);
  assert.deepEqual(damaged.player, checkpoint);
  assert.equal(gameEngine.bankOf(damaged), 'north');
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


test('the nine practice stages retain separate state and optional shards', () => {
  assert.equal(gameEngine.LEVELS.length, 13);
  const names = new Set();
  for (let index = 0; index < 9; index++) {
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
  assert.equal(names.size, 9);
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

test('shrink reduces objects and decks while rotation swaps the bridge axes', () => {
  for (const target of ['stone', 'tree']) {
    const game = createGame();
    const body = gameEngine.objectGeometry(game, target), deck = gameEngine.bridgeGeometry(game, target);
    apply(game, target, ['float', 'shrink']);
    const small = gameEngine.objectGeometry(game, target), smallDeck = gameEngine.bridgeGeometry(game, target);
    assert.ok(small.scale < body.scale && small.radius < body.radius, target + ' must visibly shrink');
    assert.ok(smallDeck.w < deck.w && smallDeck.h < deck.h, target + ' must also have a smaller supporting deck');
    apply(game, target, ['float', 'rotate']);
    const rotated = gameEngine.bridgeGeometry(game, target);
    close(rotated.w, deck.h); close(rotated.h, deck.w);
    assert.ok(rotated.w > rotated.h, 'Rotation must make the long bridge axis horizontal');
  }
});

test('growth and shrink cannot be applied together or mutate a valid rule', () => {
  for (const target of ['stone', 'tree']) {
    const game = createGame(); apply(game, target, ['float']);
    const before = JSON.stringify(game);
    const result = applyRule(game, target, ['float', 'grow', 'shrink']);
    assert.equal(result.ok, false);
    assert.match(result.message, /同時|組み合|成長|縮小/);
    assert.equal(JSON.stringify(game), before);
  }
});

test('shrinking or rotating an occupied bridge cannot remove player support', () => {
  for (const target of ['stone', 'tree']) {
    const game = makeBridge(target);
    const deck = gameEngine.bridgeGeometry(game, target);
    // This is an isolated support-boundary check, not part of a full journey.
    game.player = { x: game[target].x, y: deck.y + 14 };
    assert.equal(walkable(game, game.player), true);
    for (const effect of ['shrink', 'rotate']) {
      const before = JSON.stringify(game);
      assert.equal(applyRule(game, target, ['float', effect]).ok, false);
      assert.equal(JSON.stringify(game), before);
    }
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

test('the selected nearby floating object is carried and feedback names the same object', () => {
  for (const preferred of ['stone', 'tree']) {
    const game = createGame();
    // Isolated pickup geometry: both objects are within reach of the player.
    game.stone = { x: 475, y: 565 };
    game.tree = { x: 375, y: 565 };
    apply(game, 'stone', ['float']); apply(game, 'tree', ['float']);
    game.preferredCarryTarget = preferred;
    const other = preferred === 'stone' ? 'tree' : 'stone';
    const unchanged = { ...game[other] };
    const previousX = game[preferred].x;
    assert.match(gameEngine.interactionStatus(game), preferred === 'stone' ? /石/ : /木/);
    frames(game, ['e', 'd'], 6);
    assert.ok(game[preferred].x > previousX);
    assert.deepEqual(game[other], unchanged);
  }
});

test('an out-of-range selection does not prevent carrying the nearby object', () => {
  const game = createGame();
  game.stone = { x: 750, y: 565 }; game.tree = { x: 375, y: 565 };
  apply(game, 'stone', ['float']); apply(game, 'tree', ['float']);
  game.preferredCarryTarget = 'stone';
  assert.match(gameEngine.interactionStatus(game), /木/);
  frames(game, ['e', 'd'], 6);
  assert.ok(game.tree.x > 375);
  assert.equal(game.stone.x, 750);
});

test('calling an object back preserves rules, the crystal and latched sensors', () => {
  const game = createGame(4);
  // Separate recovery unit setup; complete routes below collect objectives
  // using movement instead of these isolated sensor positions.
  game.stone = { x: 560, y: 310 }; game.tree = { x: 240, y: 300 };
  apply(game, 'stone', ['float', 'grow']);
  apply(game, 'tree', ['float', 'glow', 'pulse']);
  frames(game, [], 65);
  assert.ok(game.sensorLit.grown && game.sensorLit.signal);
  game.core = true;
  game.collectedShards[0] = true;
  const before = JSON.parse(JSON.stringify({ rules: game.rules, sensorLit: game.sensorLit,
    core: game.core, shards: game.collectedShards, ruleCount: game.ruleCount }));
  for (const target of ['stone', 'tree']) {
    assert.equal(gameEngine.recoverObject(game, target).ok, true);
    assert.deepEqual(game[target], game.level[target]);
    assert.ok(walkable(game, game.player));
  }
  assert.deepEqual({ rules: game.rules, sensorLit: game.sensorLit,
    core: game.core, shards: game.collectedShards, ruleCount: game.ruleCount }, before);
});

test('calling an object back cannot remove river support or strand the opposite bank', () => {
  const onBridge = makeBridge('stone');
  const northBank = collectCrystal('stone');
  for (const game of [onBridge, northBank]) {
    const before = JSON.stringify(game);
    assert.equal(gameEngine.recoverObject(game, 'stone').ok, false);
    assert.equal(JSON.stringify(game), before);
    assert.ok(walkable(game, game.player));
  }
});

test('calling an object back rejects an occupied destination and unsupported targets', () => {
  const game = createGame(1);
  apply(game, 'stone', ['float', 'grow']);
  game.stone = { x: 720, y: 550 }; game.player = { x: 650, y: 530 };
  assert.ok(walkable(game, game.player));
  const before = JSON.stringify(game);
  for (const target of ['stone', 'fire', 'water', 'invalid']) {
    assert.equal(gameEngine.recoverObject(game, target).ok, false);
    assert.equal(JSON.stringify(game), before);
  }
});

test('fire recovery finds a nearby safe point if an object occupies the last checkpoint', () => {
  const game = createGame(1);
  apply(game, 'stone', ['float']);
  game.player = { x: 650, y: 320 }; update(game, new Set(), 1 / 120);
  const blockedCheckpoint = { ...game.checkpoint };
  game.stone = { x: 650, y: 320 + game.floatOffsets.stone };
  assert.equal(walkable(game, blockedCheckpoint), false);
  game.player = { ...fireGeometry(game) };
  update(game, new Set(), 1 / 120);
  assert.notDeepEqual(game.player, blockedCheckpoint);
  assert.equal(gameEngine.bankOf(game), 'north');
  assert.ok(walkable(game, game.player));
  assert.ok(gameEngine.distance(game.player, blockedCheckpoint) <= 144);
  assert.ok(game.damageUntil > game.elapsed);
});

test('hints distinguish a missing float rule, a charging sensor and a return trip', () => {
  const game = createGame(2);
  // Isolated hint states complement the input-only complete routes below.
  game.player = { x: 700, y: 330 }; game.core = true;
  apply(game, 'tree', ['float', 'glow']);
  assert.equal(gameEngine.hintKey(game), 'fetch-sensor-light');
  assert.match(gameEngine.hints(game).join(' '), /南岸/);
  game.tree = { x: 245, y: 365 };
  apply(game, 'tree', ['glow']);
  assert.equal(gameEngine.hintKey(game), 'charge-sensor-light');
  game.tree = { x: 400, y: 365 };
  assert.equal(gameEngine.hintKey(game), 'define-sensor-light');
  apply(game, 'tree', ['float', 'glow']);
  assert.equal(gameEngine.hintKey(game), 'carry-sensor-light');
  game.tree = { x: 245, y: 365 };
  assert.equal(gameEngine.hintKey(game), 'charge-sensor-light');
  frames(game, [], 65);
  assert.ok(game.sensorLit.light);
  assert.equal(gameEngine.hintKey(game), 'define-heat');
});

test('hints offer recovery from the south bank and accept the alternative floating tree', () => {
  const game = createGame(1);
  apply(game, 'stone', ['float']);
  game.stone = { x: 650, y: 350 };
  assert.equal(gameEngine.hintKey(game), 'recover-stone');
  assert.deepEqual(gameEngine.hintTarget(game), { ...game.level.stone, label: '石' });
  assert.equal(gameEngine.recoverObject(game, 'stone').ok, true);
  assert.equal(gameEngine.hintKey(game), 'carry-stone');
  apply(game, 'stone', ['glow']);
  apply(game, 'tree', ['float']);
  assert.equal(gameEngine.hintKey(game), 'approach-tree');
  assert.equal(gameEngine.hintTarget(game).label, '木');
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
  // A natural route uses the middle of the gate, without a hidden edge shortcut.
  const x = gate.x + gate.w / 2;
  const previousDamage = game.damageUntil;
  walkTo(game, x, gate.y + 70);
  apply(game, 'fire', ['heat']);
  frames(game, ['e'], 180);
  assert.ok(game.gateOpen, 'All gate requirements must be completed: ' + JSON.stringify(game.sensorLit));
  walkTo(game, x, game.level.goal.y + game.level.goal.h / 2);
  assert.equal(game.damageUntil, previousDamage, 'The middle of the opened gate must be usable without a respawn or invulnerability shortcut');
  assert.ok(game.complete, 'Movement must reach the goal');
}
function prepareStage(stageIndex, placementOffset = 0, game = E.createGame(stageIndex)) {
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
    carryTo(game, 'tree', 'y', 370 + placementOffset); frames(game, [], 150);
    assert.ok(game.sensorLit.light);
    // A tree left near the south edge of the sensor can block the upper
    // corridor. The open strip beside the river provides a wider detour.
    const corridorY = placementOffset > 0 ? 370 : 350;
    walkTo(game, 180, corridorY); walkTo(game, 700, corridorY); walkTo(game, 700, 330);
  } else if (stageIndex === 3) {
    apply(game, 'stone', ['float', 'glow', 'pulse']);
    walkTo(game, 650, 565); carryTo(game, 'stone', 'y', 390); carryTo(game, 'stone', 'x', 280 + placementOffset); frames(game, [], 2);
    walkTo(game, game.player.x, 334); walkTo(game, 220 + placementOffset, 334);
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
    walkTo(game, 700, 330); carryTo(game, 'stone', 'x', 560 + placementOffset); frames(game, [], 150);
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
  return game;
}
for (let stage = 0; stage < 5; stage++) {
  test('complete all objectives and reach the goal in stage ' + (stage + 1), () => {
    const game = prepareStage(stage);
    finish(game);
    assert.equal(game.core, true);
    assert.equal(game.gateOpen, true);
    assert.equal(game.complete, true);
    assert.equal(game.damageUntil, 0, 'The complete route must not depend on damage or invulnerability');
    assert.ok(game.level.sensors.every(sensor => game.sensorLit[sensor.id]));
  });
}
for (const stage of [2, 3, 4]) {
  for (const offset of [-20, 20]) {
    test('stage ' + (stage + 1) + ' accepts sensor/bridge placement offset ' + offset + 'px', () => {
      const game = prepareStage(stage, offset);
      assert.ok(game.level.sensors.every(sensor => game.sensorLit[sensor.id]));
      finish(game);
      assert.equal(game.damageUntil, 0);
    });
  }
}
for (const seconds of [0.55, 0.65, 0.75, 1, 1.5, 3]) {
  test('stage 2 accepts a normal E+up hold of ' + seconds + ' seconds', () => {
    const game = E.createGame(1);
    apply(game, 'stone', ['float']);
    frames(game, ['e', 'w'], Math.round(seconds / dt));
    frames(game, [], 2);
    assert.ok(E.walkable(game, game.player));
    if (E.bankOf(game) === 'north') {
      // After carrying all the way onto land, step away from the object
      // before heading for the crystal, just as a player can do with arrows.
      walkTo(game, 160, game.player.y);
      walkTo(game, 160, 320);
    } else {
      walkTo(game, 650, 320);
      walkTo(game, 160, 320);
    }
    assert.ok(game.core);
    if (!E.isBridge(game, 'stone')) {
      // The lifted stone can obstruct this narrow bank. Redefining it on
      // dry land lowers it out of the route without resetting progress.
      apply(game, 'stone', ['glow']);
      assert.ok(game.core);
    }
    finish(game);
    assert.equal(game.damageUntil, 0);
  });
}

test('stage 2 long carrying and later fire contact keep the north bank reachable', () => {
  const game = E.createGame(1);
  apply(game, 'stone', ['float']);
  frames(game, ['e', 'w'], 360);
  frames(game, [], 2);
  assert.equal(E.bankOf(game), 'north');
  assert.equal(E.isBridge(game, 'stone'), false, 'Long carrying has removed the fixed bridge');
  walkTo(game, 160, game.player.y); walkTo(game, 160, 320);
  const checkpoint = { ...game.checkpoint };
  // Isolate fire contact after the real input-only crossing and collection.
  // The rest of this recovery route again uses ordinary input.
  game.player = { ...E.fireGeometry(game) };
  E.update(game, new Set(), dt);
  assert.deepEqual(game.player, checkpoint);
  assert.equal(E.bankOf(game), 'north');
  assert.ok(E.walkable(game, game.player));
  assert.ok(game.core);
  assert.ok(E.has(game, 'stone', 'float'));
  apply(game, 'stone', ['glow']);
  frames(game, [], 250);
  finish(game);
});

test('short new-verb decks receive safe correction hints on land and in the river', () => {
  for (let stage = 0; stage < 5; stage++) {
    const target = stage === 2 ? 'tree' : 'stone';
    for (const effect of ['shrink', 'rotate']) {
      const game = E.createGame(stage); apply(game, target, ['float', effect]);
      const key = 'adjust-bridge-' + target;
      assert.equal(E.hintKey(game), key, 'A short deck needs correction before crossing in stage ' + (stage + 1));
      assert.match(E.hints(game).join(' '), /縮小.*回転.*外し/);
      assert.match(E.hints(game).join(' '), stage === 4 ? /浮遊＋成長/ : /浮遊/);
      assert.deepEqual(E.hintTarget(game), { ...game.player, label: '岸で縮小・回転を外す' });
      // An isolated on-deck state checks the recovery instructions separately
      // from the spawn-to-goal journeys below.
      const river = game.level.rivers[0];
      game[target] = { x: game.level[target].x, y: river.y + river.h / 2 };
      game.player = { ...game[target] };
      assert.ok(E.walkable(game, game.player)); assert.equal(E.bankOf(game), 'river');
      const before = JSON.stringify(game);
      assert.equal(E.hintKey(game), key);
      assert.match(E.hints(game).join(' '), /Eを押しながら上か下/);
      assert.match(E.hints(game).join(' '), /今いる足場を失う変更は拒否/);
      assert.notEqual(E.bankOf(game, E.hintTarget(game)), 'river', 'The recovery marker must point to a bank');
      assert.equal(JSON.stringify(game), before, 'Reading recovery hints must not move or redefine the deck');
      frames(game, ['e', 's'], 120);
      assert.equal(E.bankOf(game), 'south', 'The advised ferry action must return to land');
      assert.ok(E.walkable(game, game.player));
      apply(game, target, stage === 4 ? ['float', 'grow'] : ['float']);
      assert.notEqual(E.hintKey(game), key);
    }
  }
  const water = E.createGame(); apply(water, 'stone', ['float', 'shrink']); apply(water, 'water', ['solidify']);
  assert.equal(E.hintKey(water), 'cross-water', 'An already walkable river takes precedence over the short optional object');
  const ferry = E.createGame(4); apply(ferry, 'tree', ['float', 'glow', 'pulse']);
  ferry.tree = { x: 240, y: 415 }; ferry.player = { ...ferry.tree };
  assert.ok(E.walkable(ferry, ferry.player)); assert.equal(E.hintKey(ferry), 'cross-bridge');
  assert.match(E.hints(ferry).join(' '), /E＋上を押し続け/);
  frames(ferry, ['e', 'w'], 100);
  assert.equal(E.bankOf(ferry), 'north', 'The original stage-five tree ferry must remain usable');
});

test('correcting shrink and rotation on land still allows every basic stage to be cleared', () => {
  for (let stage = 0; stage < 5; stage++) {
    const target = stage === 2 ? 'tree' : 'stone';
    for (const effect of ['shrink', 'rotate']) {
      const game = E.createGame(stage); apply(game, target, ['float', effect]);
      assert.equal(E.hintKey(game), 'adjust-bridge-' + target);
      apply(game, target, stage === 4 ? ['float', 'grow'] : ['float']);
      assert.ok(!E.hintKey(game).startsWith('adjust-bridge-'));
      const ready = prepareStage(stage, 0, game);
      assert.equal(ready, game, 'The correction journey must keep the same game from spawn');
      finish(game);
      assert.ok(game.complete); assert.equal(game.damageUntil, 0);
    }
  }
});

test('the five introductory stages provide actionable hints from crossing through the goal', () => {
  function checkHint(game, expectedKey) {
    assert.equal(E.hintKey(game), expectedKey);
    const hints = E.hints(game);
    assert.ok(Array.isArray(hints) && hints.length >= 2);
    assert.ok(hints.every(line => typeof line === 'string' && line.trim().length > 0));
    assert.ok(typeof E.interactionStatus(game) === 'string');
    const target = E.hintTarget(game);
    if (expectedKey === 'complete') assert.equal(target, null);
    else {
      assert.ok(Number.isFinite(target.x) && Number.isFinite(target.y));
      assert.ok(typeof target.label === 'string' && target.label.length);
    }
  }
  for (let stage = 0; stage < 5; stage++) {
    const game = E.createGame(stage);
    const crossing = stage === 2 ? 'tree' : 'stone';
    checkHint(game, 'define-' + crossing);
    if (stage === 0) {
      apply(game, 'water', ['solidify']);
      checkHint(game, 'cross-water');
    } else {
      apply(game, crossing, ['float']);
      assert.ok(['approach-' + crossing, 'carry-' + crossing].includes(E.hintKey(game)));
      assert.doesNotMatch(E.hints(game).join(' '), /水＋(?:凍結|固体化)/);
    }
    const ready = prepareStage(stage);
    checkHint(ready, 'define-heat');
    const heatMarker = E.hintTarget(ready), flame = E.fireGeometry(ready);
    assert.ok(heatMarker.y > ready.level.gate.y + ready.level.gate.h, 'heat guidance stays south of the closed gate');
    assert.ok(E.distance(heatMarker, flame) > flame.radius + 13, 'heat guidance does not lead into the flame');
    apply(ready, 'fire', ['heat']);
    const gate = ready.level.gate;
    walkTo(ready, gate.x + gate.w / 2, gate.y + 70);
    checkHint(ready, 'heat-gate');
    frames(ready, ['e'], 180);
    checkHint(ready, 'goal');
    walkTo(ready, ready.level.goal.x + ready.level.goal.w / 2, ready.level.goal.y + ready.level.goal.h / 2);
    checkHint(ready, 'complete');
  }
});
})();


// The four challenge journeys also start at spawn and use ordinary input only.
(function verifyChallengeRoutes() {
  const E = gameEngine, dt = 1 / 120;
  function frames(game, keys, count) { for (let i = 0; i < count; i++) E.update(game, new Set(keys), dt); }
  function checkSafe(game) {
    assert.ok(E.walkable(game, game.player), 'A challenge move lost player support');
    assert.equal(game.damageUntil, 0, 'A challenge route must not use damage or invulnerability');
    for (const target of ['stone', 'tree']) assert.ok(E.objectPositionValid(game, target), target + ' crossed an obstacle');
  }
  function walk(game, x, y) {
    for (const [axis, destination] of [['x', x], ['y', y]]) {
      let attempts = 0;
      while (Math.abs(game.player[axis] - destination) > 1 && !game.complete) {
        assert.ok(attempts++ < 2500, 'Challenge walk blocked: ' + JSON.stringify({ stage: game.stageIndex + 1, axis, destination, player: game.player, stone: game.stone, tree: game.tree }));
        const key = axis === 'x' ? (game.player.x < destination ? 'd' : 'a') : (game.player.y < destination ? 's' : 'w');
        E.update(game, new Set([key]), dt); checkSafe(game);
      }
    }
  }
  function carry(game, target, axis, destination) {
    game.preferredCarryTarget = target;
    let attempts = 0;
    while (Math.abs(game[target][axis] - destination) > 1) {
      assert.ok(attempts++ < 2500, 'Challenge carry blocked: ' + JSON.stringify({ stage: game.stageIndex + 1, target, axis, destination, player: game.player, stone: game.stone, tree: game.tree }));
      const key = axis === 'x' ? (game[target].x < destination ? 'd' : 'a') : (game[target].y < destination ? 's' : 'w');
      E.update(game, new Set(['e', key]), dt); checkSafe(game);
    }
  }
  function apply(game, target, effects) { const result = E.applyRule(game, target, effects); assert.ok(result.ok, result.message); checkSafe(game); }
  function hint(game) {
    const before = JSON.stringify(game), key = E.hintKey(game), lines = E.hints(game), point = E.hintTarget(game);
    assert.equal(typeof key, 'string');
    assert.ok(lines.length >= 2 && lines.every(line => typeof line === 'string' && line.trim()));
    assert.doesNotMatch(lines.join(' '), /炎に「加熱」を適用|炎.*約2秒/);
    if (!game.complete) assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.equal(JSON.stringify(game), before, 'Reading a hint must not advance the puzzle');
  }
  function prepare(stage, offset = 0) {
    const game = E.createGame(stage - 1); hint(game);
    if (stage === 6) {
      apply(game, 'stone', ['float', 'shrink']);
      carry(game, 'stone', 'y', 450); hint(game);
      apply(game, 'stone', ['float', 'grow']);
      carry(game, 'stone', 'y', 390); frames(game, [], 150);
      walk(game, 650, 310); walk(game, 160, 310);
    } else if (stage === 7) {
      apply(game, 'tree', ['float', 'rotate', 'glow']);
      carry(game, 'tree', 'x', 435); frames(game, [], 2); hint(game);
      walk(game, 500, 550);
      carry(game, 'tree', 'x', 650 + offset); carry(game, 'tree', 'y', 350); frames(game, [], 150);
      // The trunk is above its shadow. Use the open lower bank to go around it.
      walk(game, game.player.x, 390); walk(game, 700, 390); walk(game, 700, 300);
    } else if (stage === 8) {
      apply(game, 'stone', ['float', 'grow', 'glow']);
      walk(game, 650, 600); carry(game, 'stone', 'y', 340); carry(game, 'stone', 'x', 280 + offset); frames(game, [], 150); hint(game);
      assert.ok(game.sensorLit['held-stone']);
      // Return beside the unlifted tree, then approach from its south side.
      walk(game, 200, 600); apply(game, 'tree', ['float', 'glow', 'pulse']); walk(game, 240, 600);
      carry(game, 'tree', 'y', 340); carry(game, 'tree', 'x', 580 + offset); frames(game, [], 150);
      walk(game, 425, 310);
    } else {
      apply(game, 'stone', ['float', 'glow', 'pulse']); apply(game, 'water', ['freeze']);
      // x190 stays clear of the tree while remaining inside the ice receiver.
      walk(game, 190, 600); walk(game, 190, 450); frames(game, [], 150); hint(game);
      assert.ok(game.sensorLit['ice-record']); assert.equal(game.sensorLit['solid-record'], false);
      apply(game, 'water', ['solidify']); walk(game, 650, 450); frames(game, [], 150); hint(game);
      walk(game, 720, 600); walk(game, 650, 600);
      carry(game, 'stone', 'y', 365); carry(game, 'stone', 'x', 290 + offset); frames(game, [], 500); hint(game);
      walk(game, 160, 320);
      // The pulsing stone stays in place; its lower side is a broad return path.
      walk(game, 160, 390); walk(game, 425, 390);
    }
    hint(game); return game;
  }
  function finish(game) {
    frames(game, [], 180);
    assert.ok(game.core && game.gateOpen, 'The crystal and completed devices must open a challenge gate');
    assert.ok(game.level.sensors.every(sensor => game.sensorLit[sensor.id]));
    const gate = game.level.gate, x = gate.x + gate.w / 2;
    // Approach above a receiver's trunk before lining up with the gate centre.
    walk(game, game.player.x, gate.y + 45);
    walk(game, x, gate.y + 45); walk(game, x, game.level.goal.y + game.level.goal.h / 2);
    assert.ok(game.complete); assert.equal(game.damageUntil, 0);
    assert.ok(game.ruleCount <= game.level.parRules, 'The optional definition target must be achievable');
    hint(game);
  }
  for (const stage of [6, 7, 8, 9]) test('complete challenge stage ' + stage + ' through the gate centre without damage', () => finish(prepare(stage)));
  for (const stage of [7, 8, 9]) for (const offset of [-15, 15]) test('challenge stage ' + stage + ' tolerates receiver placement offset ' + offset + 'px', () => finish(prepare(stage, offset)));

  test('the small entrance blocks a normal stone and permits the shrunken stone', () => {
    const game = E.createGame(5); apply(game, 'stone', ['float']);
    frames(game, ['e', 'w'], 500); checkSafe(game);
    assert.ok(game.stone.y > 510, 'The normal body must remain below the entrance wall');
    assert.equal(game.sensorLit.large, false); assert.equal(game.gateOpen, false);
    apply(game, 'stone', ['float', 'shrink']);
    carry(game, 'stone', 'y', 450);
    assert.ok(game.stone.y < 490 && game.player.y < 510, 'The smaller stone and player can pass together');
  });

  test('growth is rejected when the enlarged object would intersect the entrance wall', () => {
    const game = E.createGame(5);
    apply(game, 'stone', ['float', 'shrink']);
    // Isolated collision setup: a small stone inside the doorway is valid.
    game.stone = { x: 650, y: 500 };
    assert.ok(E.objectPositionValid(game, 'stone'));
    const before = JSON.stringify(game);
    assert.equal(E.applyRule(game, 'stone', ['float', 'grow']).ok, false);
    assert.equal(JSON.stringify(game), before);
  });

  test('object recovery rolls back if a grown body would overlap the entrance wall', () => {
    const game = E.createGame(5);
    game.tree = { x: 200, y: 600 }; apply(game, 'tree', ['float', 'grow']);
    assert.ok(E.objectPositionValid(game, 'tree'));
    const before = JSON.stringify(game);
    const result = E.recoverObject(game, 'tree');
    assert.equal(result.ok, false); assert.equal(JSON.stringify(game), before);
    assert.ok(E.objectPositionValid(game, 'tree'));
  });

  test('rotation makes a fixed bridge span the vertical waterway', () => {
    const game = E.createGame(6); apply(game, 'tree', ['float']);
    game.tree = { x: 435, y: 550 }; game.player = { x: 380, y: 550 };
    frames(game, ['d'], 120);
    assert.ok(game.player.x < 395, 'An unrotated fixed bridge leaves a gap at the west bank');
    apply(game, 'tree', ['float', 'rotate']);
    walk(game, 500, 550);
    assert.equal(E.bankOf(game), 'east');
    assert.equal(game.gateOpen, false, 'Crossing alone does not bypass the receiver and crystal');
  });

  test('hold receivers must overlap in time and an opened exit stays safe', () => {
    const game = E.createGame(7), [stoneSensor, treeSensor] = game.level.sensors;
    apply(game, 'stone', ['float', 'grow', 'glow']); apply(game, 'tree', ['float', 'glow', 'pulse']);
    game.stone = { x: stoneSensor.x, y: stoneSensor.y }; frames(game, [], 150);
    assert.ok(game.sensorLit[stoneSensor.id]); assert.equal(game.sensorLit[treeSensor.id], false);
    game.stone = { ...game.level.stone }; game.tree = { x: treeSensor.x, y: treeSensor.y }; frames(game, [], 150);
    game.core = true; frames(game, [], 2);
    assert.equal(game.sensorLit[stoneSensor.id], false); assert.ok(game.sensorLit[treeSensor.id]);
    assert.equal(game.gateOpen, false, 'Sequential visits cannot satisfy a simultaneous puzzle');
    game.stone = { x: stoneSensor.x, y: stoneSensor.y }; frames(game, [], 150);
    assert.ok(game.gateOpen);
    game.tree = { ...game.level.tree }; frames(game, [], 2);
    assert.equal(game.sensorLit[treeSensor.id], false); assert.ok(game.gateOpen, 'The opened exit must not close on the player');
  });

  test('ice and solid receivers require different water definitions at their own positions', () => {
    const game = E.createGame(8), [ice, solid] = game.level.sensors;
    apply(game, 'water', ['solidify']); game.player = { x: ice.x, y: ice.y }; frames(game, [], 150);
    assert.equal(game.sensorLit[ice.id], false); assert.equal(game.sensorLit[solid.id], false);
    apply(game, 'water', ['freeze']); frames(game, [], 150);
    assert.ok(game.sensorLit[ice.id]);
    game.player = { x: solid.x, y: solid.y }; frames(game, [], 150);
    assert.equal(game.sensorLit[solid.id], false);
    apply(game, 'water', ['solidify']); frames(game, [], 150);
    assert.ok(game.sensorLit[solid.id]); assert.ok(game.sensorLit[ice.id]);
  });

  test('the rhythm receiver charges only during bright pulse phases and retains partial charge', () => {
    const game = E.createGame(8), sensor = game.level.sensors.find(item => item.pulsed);
    apply(game, 'stone', ['float', 'glow', 'pulse']); game.stone = { x: sensor.x, y: sensor.y + 40 };
    game.elapsed = Math.PI / 3; frames(game, [], 10);
    assert.equal(game.sensorCharge[sensor.id], 0, 'A dark phase cannot charge the rhythm receiver');
    game.elapsed = Math.PI / 6; frames(game, [], 10);
    const charged = game.sensorCharge[sensor.id]; assert.ok(charged > 0 && charged < 1);
    game.elapsed = Math.PI / 3; frames(game, [], 10);
    close(game.sensorCharge[sensor.id], charged);
    frames(game, [], 600); assert.ok(game.sensorLit[sensor.id]);
  });
})();

test('a valve cannot close the hatch on a floating object and consumes a rejected E press', () => {
  for (const target of ['stone', 'tree']) {
    const game = createGame(12);
    apply(game, 'water', ['solidify']); apply(game, target, ['float']);
    game.puzzle.northValve = false; game.puzzle.southValve = true;
    game[target] = { x: 1350, y: 660 }; game.player = { x: 1400, y: 625 };
    assert.ok(walkable(game, game.player));
    assert.ok(['stone', 'tree'].every(item => gameEngine.objectPositionValid(game, item)));
    assert.equal(gameEngine.nearbyInteraction(game).id, 'south-valve');
    frames(game, ['e'], 1);
    assert.equal(game.puzzle.southValve, true, 'A rejected valve change must restore the previous route');
    assert.equal(gameEngine.physicalState(game).doorStates.hatch, true);
    assert.ok(gameEngine.objectPositionValid(game, target));
    assert.equal(game.puzzle.eHeld, true);
    assert.match(game.notice, /操作できません/);
    game[target] = { x: 1350, y: 800 };
    frames(game, ['e'], 1);
    assert.equal(game.puzzle.southValve, true, 'Holding E after rejection cannot trigger the valve again');
    frames(game, [], 1); frames(game, ['e'], 1);
    assert.equal(game.puzzle.southValve, false, 'A fresh press closes the empty hatch normally');
    assert.equal(gameEngine.physicalState(game).doorStates.hatch, false);
    assert.ok(walkable(game, game.player));
    assert.ok(['stone', 'tree'].every(item => gameEngine.objectPositionValid(game, item)));
  }
});

console.log(checks + ' engine checks passed.');
