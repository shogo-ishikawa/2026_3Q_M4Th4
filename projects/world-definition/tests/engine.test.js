'use strict';
// Run from the project directory with: node tests/engine.test.js
// The four complete routes below use movement input, rather than moving the
// player directly to the crystal, gate or goal.
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
    close(fire.x, 680 + 28 * Math.sin(time * 2.4));
    close(fire.y, 260 - 27 - 10 * Math.sin(time * 2.6));
    assert.equal(fire.radius, 31);
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

console.log(checks + ' engine checks passed.');
