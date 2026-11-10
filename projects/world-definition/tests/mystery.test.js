'use strict';
// Full mystery journeys use only normal movement, rule changes and E input.
// Contact-state unit tests are kept separately from these journeys.
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require(process.argv[2] ? path.resolve(process.argv[2]) : '../engine.js');
const dt = 1 / 120;
let checks = 0;
function test(name, run) {
  try { run(); checks++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name); throw error; }
}
function frames(game, keys = [], seconds = .05) {
  for (let i = 0; i < Math.ceil(seconds / dt); i++) {
    E.update(game, new Set(keys), dt);
    assert.ok(E.walkable(game, game.player), 'Movement lost support');
    assert.equal(game.damageUntil, 0, 'A journey must not use damage recovery');
  }
}
function apply(game, target, effects) {
  const result = E.applyRule(game, target, effects);
  assert.ok(result.ok, result.message);
}
function clear(game, target) {
  const result = E.clearRule(game, target);
  assert.ok(result.ok, result.message);
}
function walk(game, x, y) {
  for (const [axis, goal] of [['x', x], ['y', y]]) {
    let attempts = 0;
    while (!game.complete && Math.abs(game.player[axis] - goal) > 1.5) {
      assert.ok(attempts++ < 4000, 'Walk blocked: ' + JSON.stringify({ stage: game.stageIndex, axis, goal, player: game.player, stone: game.stone, tree: game.tree, puzzle: game.puzzle }));
      const key = axis === 'x' ? (game.player.x < goal ? 'd' : 'a') : (game.player.y < goal ? 's' : 'w');
      frames(game, [key], dt);
    }
  }
}
function tap(game) { frames(game, [], dt); frames(game, ['e'], dt); frames(game, [], dt); }
function carry(game, target, axis, goal) {
  game.preferredCarryTarget = target;
  let attempts = 0;
  while (Math.abs(game[target][axis] - goal) > 1.5) {
    assert.ok(attempts++ < 4000, 'Carry blocked: ' + JSON.stringify({ stage: game.stageIndex, target, axis, goal, player: game.player, object: game[target], puzzle: game.puzzle }));
    const key = axis === 'x' ? (game[target].x < goal ? 'd' : 'a') : (game[target].y < goal ? 's' : 'w');
    frames(game, ['e', key], dt);
  }
  frames(game, [], dt);
}
function hint(game) {
  const before = JSON.stringify(game);
  const lines = E.hints(game);
  assert.ok(typeof E.hintKey(game) === 'string');
  assert.ok(lines.length >= 2 && lines.every(line => typeof line === 'string' && line.trim()));
  assert.ok(typeof E.objective(game) === 'string');
  assert.ok(typeof E.interactionStatus(game) === 'string');
  const target = E.hintTarget(game);
  if (target) assert.ok(Number.isFinite(target.x) && Number.isFinite(target.y));
  assert.equal(JSON.stringify(game), before, 'Reading clues or hints must not advance the world');
}

function solveWaterwheel(game, withNegatives = false) {
  hint(game);
  walk(game, 250, 900); tap(game);
  assert.ok(game.puzzle.seenClues['wheel-sign']);
  apply(game, 'water', ['freeze']);
  walk(game, 250, 390); walk(game, 850, 390);
  if (withNegatives) {
    frames(game, [], 2);
    assert.equal(game.puzzle.intakeOpen, false, 'Standing by a lever must not operate it');
  }
  if (withNegatives) {
    frames(game, ['e'], 2);
    assert.ok(game.puzzle.intakeOpen, 'Holding E must not repeatedly toggle the lever');
    frames(game, [], dt);
  } else tap(game);
  assert.ok(game.puzzle.intakeOpen);
  walk(game, 1000, 350); assert.ok(game.core); hint(game);
  frames(game, [], 2);
  assert.equal(E.physicalState(game).activeMechanisms.wheel, false);
  assert.equal(game.gateOpen, false, 'Frozen water cannot power the exit');
  clear(game, 'water');
  assert.equal(E.physicalState(game).activeMechanisms.wheel, true);
  frames(game, [], 1.6); assert.ok(game.gateOpen); hint(game);
  walk(game, 1530, 350); walk(game, 1530, 250);
  assert.ok(game.complete);
}
function solveLibrary(game, withNegatives = false) {
  walk(game, 200, 950); tap(game); hint(game);
  walk(game, 350, 450);
  tap(game); assert.equal(game.puzzle.seenClues['hidden-poem'], false, 'The dark stone does not reveal its inscription');
  apply(game, 'tree', ['glow']);
  assert.equal(E.physicalState(game).doorStates.dark, false);
  assert.equal(game.puzzle.seenClues['hidden-poem'], false, 'Light alone does not examine a clue');
  tap(game); assert.ok(game.puzzle.seenClues['hidden-poem']);
  assert.ok(E.notebook(game).some(note => note.id === 'hidden-poem')); hint(game);
  clear(game, 'tree');
  assert.ok(E.notebook(game).some(note => note.id === 'hidden-poem'), 'The clue survives extinguishing its light');
  walk(game, 350, 870); walk(game, 862, 870);
  if (withNegatives) {
    const before = JSON.stringify(game);
    assert.equal(E.applyRule(game, 'tree', ['glow']).ok, false, 'Lighting cannot close a door on the player');
    assert.equal(JSON.stringify(game), before);
  }
  walk(game, 950, 870);
  if (withNegatives) {
    walk(game, 1050, 680); tap(game);
    assert.equal(game.puzzle.codeProgress, 0, 'Moon cannot start the poem');
    walk(game, 1300, 900); tap(game); assert.equal(game.puzzle.codeProgress, 1);
    walk(game, 1450, 580); tap(game); assert.equal(game.puzzle.codeProgress, 0, 'A wrong second rune restarts the order');
    assert.equal(game.gateOpen, false);
  }
  walk(game, 1300, 900); tap(game); assert.equal(game.puzzle.codeProgress, 1); hint(game);
  walk(game, 1050, 680); tap(game); assert.equal(game.puzzle.codeProgress, 2);
  walk(game, 1450, 580); tap(game); assert.equal(game.puzzle.codeProgress, 3);
  walk(game, 1120, 520); assert.ok(game.core);
  frames(game, [], 1.6); assert.ok(game.gateOpen); hint(game);
  walk(game, 1500, 520); walk(game, 1500, 260);
  assert.ok(game.complete);
}

function solveWeight(game, withNegatives = false) {
  walk(game, 280, 1000); tap(game); hint(game);
  apply(game, 'stone', ['float']);
  walk(game, 650, 1060); carry(game, 'stone', 'x', 520); carry(game, 'stone', 'y', 950);
  assert.equal(E.physicalState(game).doorStates.weight, false, 'A floating stone cannot exert weight');
  if (withNegatives) { frames(game, [], 2); assert.equal(E.physicalState(game).doorStates.weight, false); }
  clear(game, 'stone'); assert.equal(E.physicalState(game).doorStates.weight, true);
  apply(game, 'water', ['freeze']);
  walk(game, 450, 1000); walk(game, 450, 760); walk(game, 450, 580);
  walk(game, 500, 580); tap(game); assert.ok(game.puzzle.seenClues['root-sign']);
  assert.equal(E.physicalState(game).doorStates.roots, false);
  apply(game, 'tree', ['grow']); assert.equal(E.physicalState(game).doorStates.roots, true); hint(game);
  walk(game, 500, 450); walk(game, 762, 450);
  if (withNegatives) {
    const before = JSON.stringify(game);
    assert.equal(E.clearRule(game, 'tree').ok, false, 'Roots cannot lower a gate onto the player');
    assert.equal(JSON.stringify(game), before);
  }
  walk(game, 950, 450); tap(game); assert.ok(game.puzzle.intakeOpen);
  walk(game, 1000, 300); assert.ok(game.core);
  frames(game, [], 2); assert.equal(game.gateOpen, false); assert.equal(E.physicalState(game).activeMechanisms.wheel, false);
  clear(game, 'water'); assert.equal(E.physicalState(game).activeMechanisms.wheel, true);
  frames(game, [], 1.6); assert.ok(game.gateOpen); hint(game);
  walk(game, 1000, 380); walk(game, 1530, 380); walk(game, 1530, 240);
  assert.ok(game.complete);
}
function solveMaze(game, withNegatives = false) {
  walk(game, 250, 950); tap(game);
  apply(game, 'tree', ['glow']);
  walk(game, 350, 950); walk(game, 350, 820); walk(game, 420, 820); tap(game);
  assert.ok(game.puzzle.seenClues['flow-plan']); hint(game);
  if (withNegatives) {
    apply(game, 'water', ['freeze']);
    walk(game, 700, 820); walk(game, 700, 545); frames(game, ['d'], .5);
    assert.ok(game.player.x < 768, 'Freezing must not open the water-level door');
    assert.equal(E.physicalState(game).doorStates.drain, false);
    assert.ok(E.physicalState(game).rivers.some(river => river.id === 'tail'));
  }
  apply(game, 'water', ['solidify']);
  if (!withNegatives) { walk(game, 700, 820); walk(game, 700, 545); }
  assert.equal(E.physicalState(game).doorStates.drain, true);
  assert.ok(!E.physicalState(game).rivers.some(river => river.id === 'tail'), 'A solid source must drain its downstream bed');
  walk(game, 850, 545);
  if (withNegatives) {
    const before = JSON.stringify(game);
    assert.equal(E.clearRule(game, 'water').ok, false, 'Water cannot be restored under an occupied dry bed');
    assert.equal(JSON.stringify(game), before);
  }
  walk(game, 1100, 550); assert.ok(game.core);
  walk(game, 1200, 500); tap(game); assert.equal(game.puzzle.northValve, false);
  assert.equal(E.physicalState(game).doorStates.hatch, false, 'Closing only the north branch is insufficient');
  walk(game, 1350, 590); tap(game); assert.equal(game.puzzle.southValve, true);
  assert.equal(E.physicalState(game).doorStates.hatch, true); hint(game);
  frames(game, [], 2); assert.equal(game.gateOpen, false, 'A solid dam still prevents the waterwheel from running');
  if (withNegatives) {
    clear(game, 'water');
    assert.equal(E.physicalState(game).activeMechanisms.wheel, true);
    tap(game);
    assert.equal(game.puzzle.southValve, true, 'Closing the south branch while occupying the drained bed must be rejected');
    assert.ok(E.walkable(game, game.player));
    apply(game, 'water', ['solidify']);
    walk(game, 1350, 662); tap(game);
    assert.equal(game.puzzle.southValve, true, 'A valve cannot close the hatch around its occupant');
  }
  walk(game, 1350, 760); walk(game, 1350, 915);
  assert.equal(E.physicalState(game).doorStates.dark, false);
  clear(game, 'tree'); assert.equal(E.physicalState(game).doorStates.dark, true);
  assert.ok(E.notebook(game).some(note => note.id === 'flow-plan'));
  walk(game, 1530, 915); clear(game, 'water');
  assert.equal(E.physicalState(game).flowRoute, 'south'); assert.equal(E.physicalState(game).activeMechanisms.wheel, true);
  frames(game, [], 1.6); assert.ok(game.gateOpen); hint(game);
  walk(game, 1530, 200); assert.ok(game.complete);
}

test('the expanded mystery maps expose immutable clues and safe initial geometry', () => {
  assert.equal(E.LEVELS.length, 13);
  for (let stage = 9; stage < 13; stage++) {
    const game = E.createGame(stage), bounds = E.worldBounds(game);
    assert.ok(game.level.mystery); assert.ok(bounds.w >= 1500 && bounds.h >= 1000);
    assert.ok(E.walkable(game, game.player));
    assert.ok(E.validPuzzleState(game)); hint(game);
    assert.ok(game.level.clues.length && game.level.mechanisms.length);
    assert.deepEqual(E.notebook(game), []);
  }
});
test('the waterwheel journey restores flow after freezing a crossing and operating the intake', () => solveWaterwheel(E.createGame(9), true));
test('the library journey reads light-revealed clues, extinguishes the tree and recovers from wrong rune order', () => solveLibrary(E.createGame(10), true));

test('the weight journey lowers a carried stone, raises roots and restores a water-powered exit', () => solveWeight(E.createGame(11), true));
test('the source maze uses a physical dam, valve routing, a dry-bed escape and restored flow', () => solveMaze(E.createGame(12), true));

test('definitions at the entrance cannot remotely operate devices or solve a mystery', () => {
  for (let stage = 9; stage < 13; stage++) {
    const game = E.createGame(stage);
    for (const [target, effects] of [['water', ['freeze']], ['stone', ['float', 'grow']], ['tree', ['grow', 'glow', 'pulse']]]) {
      E.applyRule(game, target, effects);
    }
    frames(game, [], 3);
    assert.equal(game.puzzle.intakeOpen, false); assert.equal(game.puzzle.codeProgress, 0);
    assert.equal(game.core, false); assert.equal(game.puzzle.exitOpen, false); assert.equal(game.complete, false);
    hint(game);
  }
});
test('the first mystery requires a water crossing rather than another carried bridge', () => {
  const game = E.createGame(9), initial = JSON.stringify(game);
  assert.equal(E.applyRule(game, 'stone', ['float']).ok, false);
  assert.equal(E.applyRule(game, 'tree', ['float']).ok, false);
  assert.equal(JSON.stringify(game), initial);
  frames(game, ['w'], 3);
  assert.ok(game.player.y > 710, 'Without changing the water, the river blocks the player');
  assert.equal(game.puzzle.intakeOpen, false);
});

assert.ok(checks > 0, 'This suite must execute real mystery checks');
console.log(checks + ' mystery checks passed.');
