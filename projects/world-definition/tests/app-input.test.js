'use strict';
// Input/lifecycle regression checks in a minimal DOM, not a browser layout test.
// Optional app, engine and progress paths let reviewers test uncommitted integration files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../app.js');
const engine = require(process.argv[3] ? path.resolve(process.argv[3]) : path.join(path.dirname(appPath), 'engine.js'));
const progress = require(process.argv[4] ? path.resolve(process.argv[4]) : path.join(path.dirname(appPath), 'progress.js'));
const source = fs.readFileSync(appPath, 'utf8');
const STORAGE_KEY = 'world-definition-progress-v1';
function memoryStorage(saved = null) {
  const items = new Map(saved === null ? [] : [[STORAGE_KEY, typeof saved === 'string' ? saved : JSON.stringify(saved)]]);
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
}

function harness(options = {}) {
  const elements = new Map(), all = [], updates = [], requests = [], draws = [];
  let activeGame, frameCallback, timestamp = 0;
  class Element {
    constructor(tag = 'DIV', id = '') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
      this.listeners = new Map(); this.attributes = new Map(); this.textContent = '';
      this.open = false; this.hidden = false; this.checked = false; this.isContentEditable = false;
      const classes = new Set();
      this.classList = {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle: (value, state) => { if (state ?? !classes.has(value)) classes.add(value); else classes.delete(value); }
      };
      Object.defineProperty(this, 'id', { get: () => this.elementId, set: value => { this.elementId = value; if (value) elements.set(value, this); } });
      this.id = id; all.push(this);
    }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
    emit(name, values = {}) {
      if (this.disabled && ['click', 'pointerdown', 'keydown'].includes(name)) return { event: null, results: [] };
      const event = { target: this, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
      const results = (this.listeners.get(name) || []).map(listener => listener(event));
      return { event, results };
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    replaceChildren(...children) { this.children = [...children]; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return name.startsWith('data-') ? Object.hasOwn(this.dataset, name.slice(5)) : this.attributes.has(name); }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => child instanceof Element ? [child, ...child.querySelectorAll('*')] : []);
      return selector === '*' ? descendants : descendants.filter(child => child.tagName === selector.toUpperCase());
    }
    querySelector(selector) {
      const match = selector.match(/^\[data-(target|effect)="([^"]+)"\]$/);
      return match ? this.querySelectorAll('*').find(child => child.dataset[match[1]] === match[2]) : null;
    }
    focus() {
      if (document.activeElement === this) return;
      document.activeElement?.emit('blur'); document.activeElement = this;
      document.emit('focusin', { target: this });
    }
    scrollIntoView() {}
    setPointerCapture() {}
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; this.emit('close'); } }
  }
  const document = new Element();
  document.body = new Element('body', 'body'); document.hidden = false;
  document.getElementById = id => elements.get(id);
  document.createElement = tag => new Element(tag);
  document.createTextNode = value => ({ textContent: value });
  document.querySelectorAll = selector => selector === 'dialog' ? all.filter(item => item.tagName === 'DIALOG') : selector === '[data-key]' ? all.filter(item => item.dataset.key) : [];
  for (const id of ['game', 'objective', 'hudpower', 'progress', 'targets', 'effects', 'queue', 'unlock-message', 'apply', 'active-rules', 'generated-name', 'generated-desc', 'rule-status', 'use-ai', 'local-ai', 'hint-content', 'hint-button', 'hint-panel', 'hint-prev', 'hint-next', 'hint-close', 'hint-step', 'hint-title', 'hint-marker', 'interaction-status', 'recover-stone', 'recover-tree', 'hint-recovery-status', 'reset', 'again', 'close-win', 'lab-focus', 'lab-panel', 'help-button', 'close-help', 'start-button', 'start-intro', 'start-rule-hint', 'stage-select', 'stage-description', 'stage-record', 'stage-number', 'stage-name', 'shard-count', 'effect-summary', 'win-title', 'win-result', 'save-status', 'next-stage', 'change-stage']) new Element(id === 'game' ? 'canvas' : ['use-ai', 'hint-marker'].includes(id) ? 'input' : id === 'stage-select' ? 'select' : 'div', id);
  elements.get('hint-panel').hidden = true;
  elements.get('hint-content').hidden = true;
  for (const id of ['start-dialog', 'help-dialog', 'win-dialog']) new Element('dialog', id);
  for (let index = 0; index < 4; index += 1) elements.get('progress').append(new Element('li'));
  const buttons = {};
  for (const key of ['w', 'a', 's', 'd', 'e']) { buttons[key] = new Element('button'); buttons[key].dataset.key = key; }
  const context = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
    return () => {};
  } });
  elements.get('game').getContext = () => context;
  const window = new Element(); window.devicePixelRatio = 1; window.matchMedia = () => ({ matches: false });
  window.WorldDefinition = { ...engine,
    createGame(index) { activeGame = engine.createGame(index); return activeGame; },
    update(game, keys, dt) { updates.push([...keys].sort()); engine.update(game, keys, dt); }
  };
  const storage = options.storage ?? memoryStorage(options.saved ?? null);
  if (options.storageGetterThrows) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } });
  else window.localStorage = storage;
  window.WorldDefinitionProgress = progress;
  window.WorldDefinitionRenderer = { createRenderer: () => ({
    draw(game, target, marker) { draws.push({ stageIndex: game.stageIndex, target, marker: marker ? JSON.parse(JSON.stringify(marker)) : null }); }
  }) };
  const sandbox = { window, document, HTMLElement: Element, location: { hostname: 'localhost' },
    performance: { now: () => 0 }, requestAnimationFrame(callback) { frameCallback = callback; },
    setTimeout() { return 1; }, clearTimeout() {}, AbortController,
    fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); }
  };
  vm.runInNewContext(source, sandbox, { filename: 'app.js' });
  const frame = () => { const count = updates.length; timestamp += 16; frameCallback(timestamp); return updates.length > count ? updates.at(-1) : null; };
  return { document, window, buttons, requests, draws, frame, storage, get game() { return activeGame; },
    get: id => elements.get(id),
    begin() { elements.get('start-button').emit('click'); },
    key(name, key, target = elements.get('game')) { return window.emit(name, { key, target }); },
    chooseEffect(effect) { elements.get('effects').querySelector('[data-effect="' + effect + '"]').emit('click'); },
    chooseTarget(target) { elements.get('targets').querySelector('[data-target="' + target + '"]').emit('click'); },
    saved() { return JSON.parse(storage.getItem(STORAGE_KEY)); },
    // Simulate the engine's completed-state boundary; route solving is tested in engine.test.js.
    complete(record = {}) {
      activeGame.complete = true;
      activeGame.ruleCount = record.rules ?? 3;
      activeGame.elapsed = record.time ?? 30;
      activeGame.collectedShards = activeGame.level.shards.map((_, index) => index < (record.shards ?? 1));
      frame();
    }

  };
}

let checks = 0;
async function test(name, run) {
  try { await run(); checks += 1; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name); throw error; }
}
(async () => {
  await test('start and help dialogs pause movement and clear held input', () => {
    const app = harness();
    app.key('keydown', 'w');
    assert.equal(app.frame(), null);
    app.begin();
    assert.deepEqual(app.frame(), []);
    app.key('keydown', 'w');
    assert.deepEqual(app.frame(), ['w']);
    app.key('keydown', 'h');
    assert.equal(app.get('help-dialog').open, true);
    assert.equal(app.frame(), null);
    app.get('close-help').emit('click');
    assert.deepEqual(app.frame(), []);
  });
  await test('keyboard release does not release a pointer holding the same key', () => {
    const app = harness(); app.begin();
    app.buttons.e.emit('pointerdown', { pointerId: 1 });
    app.key('keydown', 'e'); app.key('keyup', 'e');
    assert.deepEqual(app.frame(), ['e']);
    app.buttons.e.emit('pointerup', { pointerId: 1 });
    assert.deepEqual(app.frame(), []);
  });
  await test('pointer release does not release a physical key', () => {
    const app = harness(); app.begin();
    app.key('keydown', 'w');
    app.buttons.w.emit('pointerdown', { pointerId: 1 });
    app.buttons.w.emit('pointerup', { pointerId: 1 });
    assert.deepEqual(app.frame(), ['w']);
    app.key('keyup', 'w'); assert.deepEqual(app.frame(), []);
  });
  await test('two fingers can hold E and a direction together', () => {
    const app = harness(); app.begin();
    app.buttons.e.emit('pointerdown', { pointerId: 1 });
    app.buttons.w.emit('pointerdown', { pointerId: 2 });
    assert.deepEqual(app.frame(), ['e', 'w']);
    app.buttons.w.emit('pointercancel', { pointerId: 2 });
    assert.deepEqual(app.frame(), ['e']);
    app.buttons.e.emit('lostpointercapture', { pointerId: 1 });
    assert.deepEqual(app.frame(), []);
  });
  await test('releasing one of two pointers on a button keeps the other active', () => {
    const app = harness(); app.begin();
    app.buttons.w.emit('pointerdown', { pointerId: 1 });
    app.buttons.w.emit('pointerdown', { pointerId: 2 });
    app.buttons.w.emit('pointerup', { pointerId: 1 });
    assert.deepEqual(app.frame(), ['w']);
    app.buttons.w.emit('pointerup', { pointerId: 2 });
    assert.deepEqual(app.frame(), []);
  });
  await test('moving keyboard focus releases a Space-activated direction button', () => {
    const app = harness(); app.begin(); app.buttons.w.focus();
    app.buttons.w.emit('keydown', { key: ' ' });
    assert.deepEqual(app.frame(), ['w']);
    app.buttons.a.focus();
    app.buttons.a.emit('keyup', { key: ' ' });
    assert.deepEqual(app.frame(), []);
  });
  await test('Tab keeps normal focus behaviour and form fields ignore movement shortcuts', () => {
    const app = harness(); app.begin();
    assert.equal(app.key('keydown', 'Tab').event.defaultPrevented, false);
    app.key('keydown', 'w', app.get('use-ai'));
    assert.deepEqual(app.frame(), []);
    const elsewhere = app.get('lab-panel');
    assert.equal(app.key('keydown', 'ArrowDown', elsewhere).event.defaultPrevented, false);
    assert.deepEqual(app.frame(), []);
  });
  await test('window blur and visibility changes release every input source', () => {
    const app = harness(); app.begin();
    app.key('keydown', 'a'); app.buttons.e.emit('pointerdown', { pointerId: 1 });
    app.window.emit('blur'); assert.deepEqual(app.frame(), []);
    app.key('keydown', 's'); app.document.hidden = true; app.document.emit('visibilitychange');
    assert.equal(app.frame(), null);
    app.document.hidden = false; app.document.emit('visibilitychange');
    assert.deepEqual(app.frame(), []);
  });
  await test('hints reveal one step at a time and close with clean input and canvas focus', () => {
    const app = harness(); app.begin();
    assert.equal(app.get('hint-panel').hidden, true);
    assert.equal(app.get('hint-content').hidden, true);
    app.key('keydown', 'w'); app.buttons.e.emit('pointerdown', { pointerId: 1 });
    app.get('hint-button').emit('click');
    assert.equal(app.get('hint-panel').hidden, false);
    assert.equal(app.get('hint-content').hidden, false);
    assert.equal(app.get('hint-button').attributes.get('aria-expanded'), 'true');
    assert.equal(app.document.activeElement, app.get('hint-content'));
    assert.deepEqual(app.frame(), []);
    const hints = engine.hints(app.game);
    assert.equal(app.get('hint-content').textContent, hints[0]);
    assert.match(app.get('hint-step').textContent, /^ヒント 1 \/ /);
    assert.equal(app.get('hint-title').textContent, engine.objective(app.game));
    assert.equal(app.get('hint-prev').disabled, true);
    for (let index = 1; index < hints.length; index += 1) {
      app.get('hint-next').emit('click');
      assert.equal(app.get('hint-content').textContent, hints[index]);
    }
    assert.equal(app.get('hint-next').disabled, true);
    app.get('hint-next').emit('click');
    assert.equal(app.get('hint-content').textContent, hints.at(-1));
    app.get('hint-prev').emit('click');
    assert.equal(app.get('hint-content').textContent, hints.at(-2));
    assert.equal(app.get('hint-next').disabled, false);
    app.key('keydown', 'd'); app.buttons.e.emit('pointerdown', { pointerId: 2 });
    app.get('hint-close').emit('click');
    assert.equal(app.get('hint-panel').hidden, true);
    assert.equal(app.get('hint-content').hidden, true);
    assert.equal(app.get('hint-button').attributes.get('aria-expanded'), 'false');
    assert.equal(app.document.activeElement, app.get('game'));
    assert.deepEqual(app.frame(), []);
  });
  await test('J and question-mark toggle hints without capturing editable or modified shortcuts', () => {
    const app = harness(); app.begin();
    assert.equal(app.key('keydown', 'J').event.defaultPrevented, true);
    assert.equal(app.get('hint-panel').hidden, false);
    assert.equal(app.key('keydown', '?').event.defaultPrevented, true);
    assert.equal(app.get('hint-panel').hidden, true);
    for (const target of [app.get('use-ai'), app.get('stage-select'), app.document.createElement('textarea')]) {
      assert.equal(app.key('keydown', 'j', target).event.defaultPrevented, false);
      assert.equal(app.get('hint-panel').hidden, true);
    }
    const editable = app.document.createElement('div'); editable.isContentEditable = true;
    assert.equal(app.key('keydown', '?', editable).event.defaultPrevented, false);
    for (const values of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      assert.equal(app.window.emit('keydown', { key: 'j', target: app.get('game'), ...values }).event.defaultPrevented, false);
      assert.equal(app.get('hint-panel').hidden, true);
    }
    app.get('hint-button').emit('click'); app.get('hint-button').emit('click');
    assert.equal(app.get('hint-panel').hidden, true);
    assert.deepEqual(app.frame(), []);
  });
  await test('live hints restart at the first step when the game situation changes', () => {
    const app = harness(); app.begin(); app.get('hint-button').emit('click');
    app.get('hint-next').emit('click'); app.get('hint-next').emit('click');
    const previousKey = engine.hintKey(app.game);
    const previousText = app.get('hint-content').textContent;
    app.chooseEffect('solidify'); app.get('apply').emit('click'); app.frame();
    assert.notEqual(engine.hintKey(app.game), previousKey);
    assert.equal(app.get('hint-panel').hidden, false);
    assert.equal(app.get('hint-content').textContent, engine.hints(app.game)[0]);
    assert.notEqual(app.get('hint-content').textContent, previousText);
    assert.match(app.get('hint-step').textContent, /^ヒント 1 \/ /);
    assert.equal(app.get('hint-prev').disabled, true);
    assert.equal(app.get('hint-title').textContent, engine.objective(app.game));
    assert.equal(app.get('interaction-status').textContent, engine.interactionStatus(app.game));
  });
  await test('hint markers are optional, follow the current situation and disappear when hints close', () => {
    const app = harness(); app.begin(); app.frame();
    assert.equal(app.draws.at(-1).marker, null);
    app.get('hint-button').emit('click'); app.frame();
    assert.equal(app.get('hint-marker').checked, false);
    assert.equal(app.draws.at(-1).marker, null);
    app.get('hint-marker').checked = true; app.frame();
    assert.deepEqual(app.draws.at(-1).marker, engine.hintTarget(app.game));
    const previousMarker = app.draws.at(-1).marker;
    // Supply the north-bank state; engine route and collision checks live in engine.test.js.
    app.game.player.y = app.game.level.rivers[0].y - 60; app.frame();
    assert.equal(engine.hintKey(app.game), 'core');
    assert.deepEqual(app.draws.at(-1).marker, engine.hintTarget(app.game));
    assert.notDeepEqual(app.draws.at(-1).marker, previousMarker);
    app.get('hint-marker').checked = false; app.frame();
    assert.equal(app.draws.at(-1).marker, null);
    app.get('hint-marker').checked = true; app.get('hint-close').emit('click'); app.frame();
    assert.equal(app.draws.at(-1).marker, null);
  });
  await test('reset and stage changes clear old hint steps and markers', () => {
    const app = harness({ saved: { unlocked: 1, lastStage: 0, best: {} } }); app.begin();
    function showAdvancedHint() {
      app.get('hint-button').emit('click'); app.get('hint-next').emit('click');
      app.get('hint-marker').checked = true; app.frame();
      assert.notEqual(app.draws.at(-1).marker, null);
      assert.equal(app.get('hint-prev').disabled, false);
    }
    function assertFreshHints(stageIndex) {
      app.frame();
      assert.equal(app.game.stageIndex, stageIndex);
      assert.equal(app.get('hint-panel').hidden, true);
      assert.equal(app.get('hint-content').hidden, true);
      assert.equal(app.get('hint-marker').checked, false);
      assert.equal(app.draws.at(-1).marker, null);
      app.get('hint-button').emit('click');
      assert.equal(app.get('hint-content').textContent, engine.hints(app.game)[0]);
      assert.equal(app.get('hint-prev').disabled, true);
      assert.match(app.get('hint-step').textContent, /^ヒント 1 \/ /);
      app.get('hint-close').emit('click');
    }
    showAdvancedHint();
    app.key('keydown', 'r'); app.get('confirm-reset').emit('click');
    assertFreshHints(0);
    showAdvancedHint();
    app.get('stage-select').value = '1'; app.get('change-stage').emit('click');
    app.get('confirm-reset').emit('click'); assertFreshHints(1);
  });
  await test('the selected stone or tree becomes the preferred carry target and other targets clear it', () => {
    const app = harness(); app.begin();
    assert.equal(app.game.preferredCarryTarget, null);
    for (const target of ['stone', 'tree', 'fire', 'stone', 'water']) {
      app.chooseTarget(target); app.frame();
      assert.equal(app.game.preferredCarryTarget, ['stone', 'tree'].includes(target) ? target : null);
      assert.equal(app.draws.at(-1).target, target);
    }
    const stoneStage = harness({ saved: { unlocked: 2, lastStage: 1, best: {} } });
    assert.equal(stoneStage.game.preferredCarryTarget, 'stone');
    const treeStage = harness({ saved: { unlocked: 2, lastStage: 2, best: {} } });
    assert.equal(treeStage.game.preferredCarryTarget, 'tree');
  });
  await test('object recovery preserves progress, refuses the opposite bank and clears its message on reset', () => {
    const app = harness({ saved: { unlocked: 2, lastStage: 2, best: {} } }); app.begin();
    engine.applyRule(app.game, 'tree', ['float', 'glow']);
    app.game.core = true;
    for (const id of Object.keys(app.game.sensorLit)) app.game.sensorLit[id] = true;
    const lit = { ...app.game.sensorLit }, ruleCount = app.game.ruleCount;
    app.game.tree.y = app.game.level.rivers[0].y - 80;
    app.get('hint-button').emit('click');
    app.key('keydown', 'w'); app.buttons.e.emit('pointerdown', { pointerId: 1 });
    app.get('recover-tree').emit('click');
    assert.deepEqual(app.game.tree, app.game.level.tree);
    assert.equal(engine.has(app.game, 'tree', 'float'), true);
    assert.equal(engine.has(app.game, 'tree', 'glow'), true);
    assert.equal(app.game.core, true);
    assert.deepEqual(app.game.sensorLit, lit);
    assert.equal(app.game.ruleCount, ruleCount);
    assert.match(app.get('hint-recovery-status').textContent, /戻しました/);
    assert.equal(app.get('rule-status').textContent, app.get('hint-recovery-status').textContent);
    assert.equal(app.get('hint-content').textContent, engine.hints(app.game)[0]);
    assert.deepEqual(app.frame(), []);
    app.game.player.y = app.game.level.rivers[0].y - 60;
    const tree = { ...app.game.tree };
    app.get('recover-tree').emit('click');
    assert.deepEqual(app.game.tree, tree);
    assert.match(app.get('hint-recovery-status').textContent, /岸/);
    assert.doesNotMatch(app.get('hint-recovery-status').textContent, /戻しました/);
    app.key('keydown', 'r'); app.get('confirm-reset').emit('click');
    assert.equal(app.get('hint-recovery-status').textContent, '');
  });
  await test('reset confirmation pauses and cancellation does not reset progress', () => {
    const app = harness(); app.begin();
    app.chooseEffect('freeze'); app.get('apply').emit('click');
    const previous = app.game;
    app.key('keydown', 'r');
    assert.equal(app.get('reset-dialog').open, true);
    assert.equal(app.frame(), null);
    app.get('reset-dialog').close();
    assert.equal(app.game, previous);
    assert.equal(engine.has(app.game, 'water', 'freeze'), true);
    assert.deepEqual(app.frame(), []);
  });
  await test('reset discards delayed AI responses and preserves the new game', async () => {
    const app = harness(); app.begin(); app.get('use-ai').checked = true;
    app.chooseEffect('freeze');
    const pending = app.get('apply').emit('click').results[0];
    assert.equal(app.requests.length, 1);
    assert.equal(engine.has(app.game, 'water', 'freeze'), true);
    assert.equal(app.get('apply').disabled, true);
    app.key('keydown', 'r'); app.get('confirm-reset').emit('click');
    assert.equal(app.requests[0].options.signal.aborted, true);
    assert.equal(app.game.rules.water, null);
    app.requests[0].resolve({ ok: true, json: async () => ({ target: 'water', effects: ['freeze'], name: 'OLD RESPONSE', description: 'OLD DESCRIPTION' }) });
    await pending;
    assert.equal(app.game.rules.water, null);
    assert.equal(app.get('generated-name').textContent, 'まだルールを作っていません');
    app.get('use-ai').checked = false;
    app.chooseEffect('solidify'); app.get('apply').emit('click');
    assert.equal(engine.has(app.game, 'water', 'solidify'), true);
    assert.equal(app.get('apply').disabled, false);
  });
  await test('clearing records progress and advances to a fresh next stage', () => {
    const app = harness(); app.begin();
    app.complete({ rules: 4, shards: 2, time: 42 });
    assert.equal(app.get('win-dialog').open, true);
    assert.equal(app.saved().unlocked, 1);
    assert.deepEqual(app.saved().best[0], { rules: 4, shards: 2, time: 42 });
    assert.equal(app.get('next-stage').hidden, false);
    assert.equal(app.get('stage-select').children[1].disabled, false);
    app.get('next-stage').emit('click');
    assert.equal(app.game.stageIndex, 1);
    assert.equal(app.game.complete, false);
    assert.equal(app.game.rules.stone, null);
    assert.equal(app.get('win-dialog').open, false);
    assert.equal(app.saved().lastStage, 1);
    assert.deepEqual(app.frame(), []);
  });
  await test('the final clear hides the next button and keeps the final stage', () => {
    const index = engine.LEVELS.length - 1;
    const app = harness({ saved: { unlocked: index, lastStage: index, best: {} } }); app.begin();
    app.complete();
    assert.equal(app.get('next-stage').hidden, true);
    assert.equal(app.get('win-title').textContent, '全ステージクリア！');
    app.get('next-stage').emit('click');
    assert.equal(app.game.stageIndex, index);
    assert.equal(app.game.complete, true);
    assert.equal(app.saved().unlocked, index);
  });
  await test('locked and tampered stage selections cannot bypass progress', () => {
    const app = harness(); app.begin(); const previous = app.game;
    assert.equal(app.get('stage-select').children.length, engine.LEVELS.length);
    assert.equal(app.get('stage-select').children[0].disabled, false);
    assert.equal(app.get('stage-select').children[1].disabled, true);
    for (const value of ['1', '-1', '900', '1.5', 'NaN']) {
      app.get('stage-select').value = value; app.get('change-stage').emit('click');
      assert.equal(app.game, previous, value);
      assert.equal(app.get('reset-dialog').open, false, value);
    }
  });
  await test('changing stage confirms, can cancel and then resets the selected stage', () => {
    const app = harness({ saved: { unlocked: 2, lastStage: 1, best: {} } }); app.begin();
    app.chooseTarget('water'); app.chooseEffect('glow'); app.get('apply').emit('click');
    const previous = app.game;
    app.get('stage-select').value = '2'; app.get('change-stage').emit('click');
    assert.equal(app.get('reset-dialog').open, true);
    assert.equal(app.frame(), null);
    app.get('reset-dialog').children.find(child => child.textContent === '続ける').emit('click');
    assert.equal(app.game, previous);
    assert.equal(engine.has(app.game, 'water', 'glow'), true);
    app.get('change-stage').emit('click'); app.get('confirm-reset').emit('click');
    assert.equal(app.game.stageIndex, 2);
    assert.match(app.get('start-intro').textContent, /光を運ぶ庭/);
    assert.doesNotMatch(app.get('start-rule-hint').textContent, /固体化/);
    assert.equal(app.game.rules.water, null);
    assert.equal(app.game.elapsed, 0);
    assert.equal(app.saved().lastStage, 2);
  });
  await test('restarting keeps the current stage and its saved best record', () => {
    const best = { rules: 3, shards: 2, time: 44 };
    const app = harness({ saved: { unlocked: 2, lastStage: 2, best: { 2: best } } }); app.begin();
    app.chooseTarget('water'); app.chooseEffect('glow'); app.get('apply').emit('click');
    app.key('keydown', 'r'); app.get('confirm-reset').emit('click');
    assert.equal(app.game.stageIndex, 2);
    assert.match(app.get('start-intro').textContent, /光を運ぶ庭/);
    assert.doesNotMatch(app.get('start-rule-hint').textContent, /固体化/);
    assert.equal(app.game.rules.water, null);
    assert.deepEqual(app.saved().best[2], best);
    assert.match(app.get('stage-record').textContent, /定義 3 回/);
  });
  await test('stage changes discard pending AI responses from the previous world', async () => {
    const app = harness({ saved: { unlocked: 1, lastStage: 0, best: {} } }); app.begin();
    app.get('use-ai').checked = true; app.chooseEffect('freeze');
    const pending = app.get('apply').emit('click').results[0];
    app.get('stage-select').value = '1'; app.get('change-stage').emit('click');
    app.get('confirm-reset').emit('click');
    assert.equal(app.requests[0].options.signal.aborted, true);
    app.requests[0].resolve({ ok: true, json: async () => ({ target: 'water', effects: ['freeze'], name: 'OLD WORLD', description: 'STALE DESCRIPTION' }) });
    await pending;
    assert.equal(app.game.stageIndex, 1);
    assert.equal(app.game.rules.water, null);
    assert.equal(app.get('generated-name').textContent, 'まだルールを作っていません');
    assert.equal(app.get('apply').disabled, true);
  });
  await test('the stage-specific sealed effects stay disabled while other water effects work', () => {
    const app = harness({ saved: { unlocked: 1, lastStage: 1, best: {} } }); app.begin();
    app.chooseTarget('water');
    const freeze = app.get('effects').querySelector('[data-effect="freeze"]');
    assert.equal(freeze.disabled, true);
    assert.match(freeze.children[1].textContent, /封印中/);
    freeze.emit('click'); assert.equal(app.get('apply').disabled, true);
    app.chooseEffect('glow'); app.get('apply').emit('click');
    assert.equal(engine.has(app.game, 'water', 'glow'), true);
    assert.match(app.get('effect-summary').children[0].textContent, /光/);
  });
  await test('saved selection and best records survive loading a new app', () => {
    const storage = memoryStorage({ unlocked: 2, lastStage: 2, best: { 1: { rules: 4, shards: 2, time: 31 } } });
    const app = harness({ storage }); app.begin();
    assert.equal(app.game.stageIndex, 2);
    app.complete({ rules: 6, shards: 1, time: 55 });
    const resumed = harness({ storage });
    assert.equal(resumed.game.stageIndex, 2);
    assert.equal(resumed.get('stage-select').children[3].disabled, false);
    assert.match(resumed.get('stage-record').textContent, /定義 6 回/);
    assert.match(resumed.get('stage-record').textContent, /欠片 1 個/);
  });
  await test('corrupt or unavailable storage leaves play and in-memory progression usable', () => {
    const denied = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } };
    for (const options of [{ saved: '{broken', canSave: true }, { storage: denied }, { storageGetterThrows: true }]) {
      const app = harness(options); app.begin();
      assert.equal(app.game.stageIndex, 0);
      app.complete();
      assert.equal(app.get('win-dialog').open, true);
      assert.match(app.get('save-status').textContent, options.canSave ? /保存しました/ : /保存できません/);
      app.get('next-stage').emit('click');
      assert.equal(app.game.stageIndex, 1);
      assert.deepEqual(app.frame(), []);
    }
  });
  console.log(checks + ' app input checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
