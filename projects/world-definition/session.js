/* 途中の状態と「1手戻す」を、クリア記録とは別に扱います。 */
'use strict';
(function (root) {
  const VERSION = 1;
  const MAX_BYTES = 40000;
  const OMIT = new Set(['level', 'events', 'notice', 'heating']);
  const copy = value => JSON.parse(JSON.stringify(value));
  const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const numberBetween = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
  const keysMatch = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

  // createGame() にないフィールドや型は読み込みません。
  function sameShape(value, example) {
    if (example === null) return value === null;
    if (typeof example === 'boolean') return typeof value === 'boolean';
    if (typeof example === 'number') return numberBetween(value, -100000000, 100000000);
    if (typeof example === 'string') return typeof value === 'string' && value.length <= 200;
    if (Array.isArray(example)) return Array.isArray(value) && value.length === example.length && value.every((item, index) => sameShape(item, example[index]));
    return keysMatch(value, Object.keys(example)) && Object.keys(example).every(key => sameShape(value[key], example[key]));
  }
  function validPoint(E, game, point, player) {
    const bounds = E.worldBounds ? E.worldBounds(game) : { x: 55, y: 115, w: 760, h: 545 };
    const margin = player ? 13 : 0;
    return keysMatch(point, ['x', 'y']) && numberBetween(point.x, bounds.x + margin, bounds.x + bounds.w - margin) && numberBetween(point.y, bounds.y + margin, bounds.y + bounds.h - margin);
  }
  function dryCheckpoint(E, game) {
    const point = game.checkpoint;
    const physical = E.physicalState ? E.physicalState(game) : { rivers: game.level.rivers, walls: game.gateOpen ? game.level.walls : [...game.level.walls, game.level.gate] };
    function overlaps(rect, radius) {
      const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.w));
      const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.h));
      return Math.hypot(point.x - nearestX, point.y - nearestY) < radius;
    }
    // Moved objects may occupy an old point; respawning searches nearby in that case.
    return !physical.rivers.some(rect => overlaps(rect, 18)) && !physical.walls.some(rect => overlaps(rect, 13));
  }
  function validRules(E, game, rules) {
    const targets = E.TARGETS.map(target => target.id);
    if (!keysMatch(rules, targets)) return false;
    return targets.every(target => {
      const rule = rules[target];
      if (rule === null) return true;
      if (!keysMatch(rule, ['target', 'effects', 'name', 'description']) || rule.target !== target || !Array.isArray(rule.effects)) return false;
      const effects = rule.effects;
      if (effects.length < 1 || effects.length > 3 || new Set(effects).size !== effects.length || effects.some(effect => typeof effect !== 'string' || !E.supportedEffects(game, target).includes(effect))) return false;
      if ((effects.includes('grow') && effects.includes('shrink')) || (target === 'water' && effects.includes('freeze') && effects.includes('solidify')) || (target === 'fire' && effects.includes('freeze') && effects.includes('heat'))) return false;
      if (effects.includes('heat') && !game.core) return false;
      return typeof rule.name === 'string' && rule.name.trim().length > 0 && rule.name.length <= 60 && typeof rule.description === 'string' && rule.description.trim().length > 0 && rule.description.length <= 180;
    });
  }
  function restore(E, snapshot, unlocked = E.LEVELS.length - 1) {
    try {
      if (!keysMatch(snapshot, ['version', 'stageId', 'state']) || snapshot.version !== VERSION || !isObject(snapshot.state) || !Number.isInteger(unlocked)) return null;
      const state = snapshot.state, index = state.stageIndex;
      if (!Number.isInteger(index) || index < 0 || index > unlocked || !E.LEVELS[index] || snapshot.stageId !== E.LEVELS[index].id) return null;
      const game = E.createGame(index), keys = Object.keys(game).filter(key => !OMIT.has(key));
      if (!keysMatch(state, keys)) return null;
      for (const key of keys) {
        if (key === 'rules' || key === 'preferredCarryTarget') continue;
        if (!sameShape(state[key], game[key])) return null;
        game[key] = copy(state[key]);
      }
      if (!validPoint(E, game, game.player, true) || !validPoint(E, game, game.checkpoint, true) || !validPoint(E, game, game.stone, false) || !validPoint(E, game, game.tree, false)) return null;
      if (game.complete || !numberBetween(game.elapsed, 0, 100000000) || !numberBetween(game.damageUntil, 0, game.elapsed + 2.1) || !numberBetween(game.gateHeat, 0, 1)) return null;
      if (!Number.isInteger(game.ruleCount) || !numberBetween(game.ruleCount, 0, 10000000) || (!game.level.mystery && game.gateOpen && !game.core)) return null;
      if (!Object.values(game.floatOffsets).every(value => numberBetween(value, 0, 80)) || !Object.values(game.sensorCharge).every(value => numberBetween(value, 0, 1))) return null;
      if (![null, 'stone', 'tree'].includes(state.preferredCarryTarget) || !validRules(E, game, state.rules)) return null;
      game.rules = copy(state.rules); game.preferredCarryTarget = state.preferredCarryTarget;
      if (!dryCheckpoint(E, game) || (E.validPuzzleState && !E.validPuzzleState(game))) return null;
      if (!E.walkable(game, game.player)) return null;
      if (E.objectPositionValid && !['stone', 'tree'].every(target => E.objectPositionValid(game, target))) return null;
      // A resumed world must not inherit a held interaction key.
      if (game.puzzle && Object.hasOwn(game.puzzle, 'eHeld')) game.puzzle.eHeld = false;
      return game;
    } catch (_) { return null; }
  }
  function capture(E, game) {
    try {
      if (!game || !Number.isInteger(game.stageIndex) || !E.LEVELS[game.stageIndex] || game.level?.id !== E.LEVELS[game.stageIndex].id) return null;
      const example = E.createGame(game.stageIndex), state = {};
      for (const key of Object.keys(example)) if (!OMIT.has(key)) state[key] = copy(game[key]);
      if (state.puzzle && Object.hasOwn(state.puzzle, 'eHeld')) state.puzzle.eHeld = false;
      const snapshot = { version: VERSION, stageId: example.level.id, state };
      return restore(E, snapshot) ? snapshot : null;
    } catch (_) { return null; }
  }
  function createHistory(E, options = {}) {
    const requested = options.limit ?? 40;
    const limit = Number.isInteger(requested) && requested >= 1 && requested <= 100 ? requested : 40;
    const entries = [];
    function recordSnapshot(snapshot) {
      if (!restore(E, snapshot)) return false;
      const encoded = JSON.stringify(snapshot);
      if (entries.at(-1) === encoded) return false;
      entries.push(encoded);
      if (entries.length > limit) entries.shift();
      return true;
    }
    return {
      record(game) { return recordSnapshot(capture(E, game)); }, recordSnapshot,
      undo() { return entries.length ? restore(E, JSON.parse(entries.pop())) : null; },
      clear() { entries.length = 0; },
      get canUndo() { return entries.length > 0; }, get size() { return entries.length; }
    };
  }
  function createStore(storage, E, key = 'world-definition-session-v1') {
    let saved = null, persistent = Boolean(storage);
    try {
      const raw = storage?.getItem(key);
      if (raw && raw.length <= MAX_BYTES) saved = JSON.parse(raw);
    } catch (_) { persistent = false; }
    function write() {
      if (!storage) return;
      try {
        if (saved === null && storage.removeItem) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify(saved));
        persistent = true;
      } catch (_) { persistent = false; }
    }
    return {
      save(game) {
        const snapshot = capture(E, game);
        if (!snapshot) return false;
        saved = snapshot; write(); return true;
      },
      load(unlocked) { return restore(E, saved, unlocked); },
      clear() { saved = null; write(); },
      get persistent() { return persistent; }
    };
  }
  const api = { capture, restore, createHistory, createStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinitionSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
