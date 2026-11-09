'use strict';
// Input/lifecycle regression checks in a minimal DOM, not a browser layout test.
// An optional source path lets a reviewer exercise an uncommitted app.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../engine.js');
const source = fs.readFileSync(process.argv[2] || path.resolve(__dirname, '../app.js'), 'utf8');

function harness() {
  const elements = new Map(), all = [], updates = [], requests = [];
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
  for (const id of ['game', 'objective', 'hudpower', 'progress', 'targets', 'effects', 'queue', 'unlock-message', 'apply', 'active-rules', 'generated-name', 'generated-desc', 'rule-status', 'use-ai', 'local-ai', 'hint-content', 'hint-button', 'reset', 'again', 'close-win', 'lab-focus', 'lab-panel', 'help-button', 'close-help', 'start-button']) new Element(id === 'game' ? 'canvas' : id === 'use-ai' ? 'input' : 'div', id);
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
    createGame() { activeGame = engine.createGame(); return activeGame; },
    update(game, keys, dt) { updates.push([...keys].sort()); engine.update(game, keys, dt); }
  };
  const sandbox = { window, document, HTMLElement: Element, location: { hostname: 'localhost' },
    performance: { now: () => 0 }, requestAnimationFrame(callback) { frameCallback = callback; },
    setTimeout() { return 1; }, clearTimeout() {}, AbortController,
    fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); }
  };
  vm.runInNewContext(source, sandbox, { filename: 'app.js' });
  const frame = () => { const count = updates.length; timestamp += 16; frameCallback(timestamp); return updates.length > count ? updates.at(-1) : null; };
  return { document, window, buttons, requests, frame, get game() { return activeGame; },
    get: id => elements.get(id),
    begin() { elements.get('start-button').emit('click'); },
    key(name, key, target = elements.get('game')) { return window.emit(name, { key, target }); },
    chooseEffect(effect) { elements.get('effects').querySelector('[data-effect="' + effect + '"]').emit('click'); }
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
  console.log(checks + ' app input checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
