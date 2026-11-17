'use strict';
// App integration with a small fake DOM. This is not a browser/rendering test.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const web = path.resolve(__dirname, '../web');
const tick = () => new Promise(resolve => setImmediate(resolve));

function boot() {
  const ids = new Map(), pointButtons = [], requests = [];
  const drawing = { shapes: 0, saved: 0, restored: 0, demoFrames: 0, nonFinite: [] };
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(target, name) {
      if (name === 'createLinearGradient') return (...args) => { check(args, name); return gradient; };
      if (name === 'measureText') return text => ({ width: String(text).length * 8 });
      if (name === 'save') return () => drawing.saved++;
      if (name === 'restore') return () => drawing.restored++;
      if (name in target) return target[name];
      return (...args) => { check(args, name); if (name === 'fill' || name === 'fillRect') drawing.shapes++; };
    },
    set(target, name, value) { target[name] = value; return true; }
  });
  function check(args, name) {
    for (const arg of args) if (typeof arg === 'number' && !Number.isFinite(arg)) drawing.nonFinite.push(name);
  }
  class Element extends EventTarget {
    constructor(tag = 'div') {
      super(); this.tag = tag; this.style = {}; this.dataset = {}; this.children = []; this.attributes = {};
      this.hidden = false; this.disabled = false; this.readOnly = false; this.checked = false; this.files = [];
      this.classes = new Set();
      this.classList = {
        add: (...values) => values.forEach(value => this.classes.add(value)),
        remove: (...values) => values.forEach(value => this.classes.delete(value)),
        contains: value => this.classes.has(value),
        toggle: (value, enabled) => { const on = enabled === undefined ? !this.classes.has(value) : enabled; if (on) this.classes.add(value); else this.classes.delete(value); return on; }
      };
    }
    set value(value) { this._value = String(value); }
    get value() { return this._value || ''; }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    get options() { return this.children.filter(child => child.tag === 'option'); }
    setAttribute(name, value) {
      value = String(value); this.attributes[name] = value;
      if (name === 'id') this.id = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
      if (name === 'max' || name === 'min' || name === 'step') this[name] = value;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'max') this.max = ''; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    focus() { document.activeElement = this; }
    scrollIntoView() { this.scrolled = true; }
    getContext() { return context; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...(child.querySelectorAll?.('*') || [])]);
      if (selector === '*') return all;
      if (selector === '[data-imported]') return all.filter(child => child.dataset?.imported);
      return [];
    }
    querySelector(selector) {
      return this.querySelectorAll('*').find(child => selector === 'svg' ? child.tag === 'svg' : selector === '[data-cursor]' ? child.attributes?.['data-cursor'] : false) || null;
    }
    fire(name, properties = {}) {
      const event = new Event(name, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
      this.dispatchEvent(event); return event;
    }
    click() { if (!this.disabled) this.fire('click'); }
  }
  class Video extends Element {
    constructor() { super('video'); this.currentTime = 0; this.readyState = 0; this.duration = NaN; this.videoWidth = 0; this.videoHeight = 0; this.seeking = false; this._src = ''; }
    get src() { return this._src; }
    set src(value) { this._src = value; }
    removeAttribute(name) { super.removeAttribute(name); if (name === 'src') this._src = ''; }
    load() { this.readyState = 0; this.duration = NaN; this.currentTime = 0; }
    pause() {}
    play() { return Promise.resolve(); }
  }
  const document = {
    getElementById: id => ids.get(id),
    querySelectorAll: selector => selector === '[data-point]' ? pointButtons : [],
    createElement: tag => own(new Element(tag)),
    createElementNS: (_namespace, tag) => own(new Element(tag)),
    createTextNode: text => ({ textContent: text })
  };
  function own(element) { element.ownerDocument = document; return element; }
  document.body = own(new Element('body')); document.head = own(new Element('head'));
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const element = own(match[1] === 'video' ? new Video() : new Element(match[1]));
    for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    if (/\bvalue="/.test(match[0])) element.value = element.getAttribute('value');
    if (/\bhidden(?:\s|>)/.test(match[0])) element.hidden = true;
    if (/\bchecked(?:\s|>)/.test(match[0])) element.checked = true;
  }
  for (const match of html.matchAll(/data-point="([^"]+)"/g)) { const element = own(new Element('button')); element.dataset.point = match[1]; pointButtons.push(element); }
  const $ = id => ids.get(id);
  for (const [id, value] of Object.entries({ 'demo-select': 'swing', 'metric-group': 'axes', 'sample-rate': '15', 'slow-factor': '1', 'confidence-threshold': '0.5', 'min-span': '12', smoothing: '3', 'video-fps': '30' })) $(id).value = value;
  for (const value of ['1', '2', '4', '8']) { const option = document.createElement('option'); option.value = value; $('slow-factor').append(option); }
  const sourceVideo = $('source-video');
  const scope = {
    document, console, structuredClone, URL, AbortController, Event, EventTarget,
    setTimeout, clearTimeout, performance,
    location: { href: 'https://app.example.test/' },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {}
  };
  scope.window = scope; document.defaultView = scope;
  vm.createContext(scope);
  for (const filename of ['motion-core.js', 'demo-data.js', 'demo-renderer.js', 'video-input.js', 'time-input.js'])
    vm.runInContext(fs.readFileSync(path.join(web, filename), 'utf8'), scope, { filename });
  const drawDemo = scope.MotionDemoRenderer.draw;
  scope.MotionDemoRenderer = { draw(...args) { const rendered = drawDemo(...args); if (rendered) drawing.demoFrames++; return rendered; } };
  const videoAPI = scope.MotionVideoInput;
  scope.MotionVideoInput = { ...videoAPI, loadVideoSource(video, options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = {
        video, options, aborted: false, ignoreAbort: false,
        progress(phase) { options.onProgress?.(phase); },
        complete(metadata = { duration: 2.345678901, width: 640, height: 360 }) {
          if (settled) return; settled = true;
          video.readyState = 2; video.duration = metadata.duration; video.videoWidth = metadata.width; video.videoHeight = metadata.height; video.currentTime = 0;
          resolve(metadata);
        },
        fail(message = '配信元へ接続できませんでした。') { if (settled) return; settled = true; reject(new Error(message)); }
      };
      options.signal.addEventListener('abort', () => {
        request.aborted = true;
        if (request.ignoreAbort || settled) return;
        settled = true; reject(Object.assign(new Error('中止'), { name: 'AbortError' }));
      });
      requests.push(request); options.onProgress?.('connecting');
    });
  } };
  const original = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  const ending = '  loadDemo();\n})();';
  assert.ok(original.endsWith(ending + '\n') || original.endsWith(ending), 'test hooks attach to expected app ending');
  const app = original.replace(ending, '  loadDemo();\n  window.appTestAccess = { state, loadResult, loadVideo, loadDemo, showTime };\n})();');
  vm.runInContext(app, scope, { filename: 'app.js' });
  const feedback = () => ({ state: $('source-feedback').dataset.state, busy: $('video-stage').getAttribute('aria-busy'), progress: !$('source-progress').hidden, cancel: !$('cancel-source').hidden, message: $('source-message').textContent });
  const submit = url => { $('video-url').value = url; $('url-form').fire('submit'); };
  function expectFeedback(kind) {
    const info = feedback(); assert.equal(info.state, kind); assert.equal(info.busy, String(kind === 'loading')); assert.equal(info.progress, kind === 'loading'); assert.equal(info.cancel, kind === 'loading'); assert.ok(info.message); return info;
  }
  return { $, scope, requests, feedback, submit, expectFeedback, drawing, access: scope.appTestAccess, sourceVideo };
}

(async () => {
  let checks = 0;
  {
    const app = boot();
    app.expectFeedback('idle'); assert.equal(app.access.state.frames.length, 121); assert.ok(app.access.state.result);
    assert.ok(app.drawing.shapes > 0); assert.ok(app.drawing.demoFrames > 0); assert.equal(app.drawing.saved, app.drawing.restored); assert.deepEqual(app.drawing.nonFinite, []);
    for (const id of ['swing', 'squat', 'arm']) { app.access.loadDemo(id); app.expectFeedback('idle'); assert.equal(app.access.state.demoId, id); assert.equal(app.access.state.frames.length, 121); }
    app.$('open-url').click(); app.expectFeedback('input'); assert.equal(app.$('url-panel').hidden, false); assert.equal(app.$('open-url').getAttribute('aria-expanded'), 'true'); assert.equal(app.$('video-url'), app.scope.document.activeElement); assert.ok(app.$('url-panel').scrolled);
    assert.match(app.$('video-url').getAttribute('aria-describedby'), /source-message/); assert.match(app.$('source-message').getAttribute('role'), /status/);
    for (const invalid of ['', 'bad-url', 'https://www.youtube.com/watch?v=x']) { app.submit(invalid); app.expectFeedback('error'); assert.equal(app.$('video-url').getAttribute('aria-invalid'), 'true'); assert.equal(app.requests.length, 0); }
    checks++;
  }
  {
    const app = boot(); app.$('open-url').click(); app.submit('https://media.example.test/clip.mp4');
    app.expectFeedback('loading'); assert.equal(app.requests.length, 1); assert.equal(app.$('start-time').disabled, true); assert.equal(app.$('start-up').disabled, true); assert.equal(app.$('load-url').disabled, false); assert.equal(app.$('analysis-progress').hidden, true);
    for (const phase of ['metadata', 'buffering', 'stalled']) { app.requests[0].progress(phase); app.expectFeedback('loading'); }
    assert.match(app.feedback().message, /応答を待って/);
    app.requests[0].complete(); await tick(); app.expectFeedback('ready');
    assert.equal(app.$('url-panel').hidden, false); assert.equal(app.$('start-time').disabled, false); assert.equal(app.$('start-up').disabled, false); assert.equal(app.$('analyse-video').disabled, false); assert.equal(app.$('cancel-analysis').hidden, true);
    assert.equal(Number(app.$('end-time').value), 2.345678901);
    app.$('start-time').value = '0.26'; app.$('start-time').fire('input'); app.$('start-time').fire('change'); assert.equal(app.$('start-time').value, '0.3');
    app.$('start-up').click(); assert.equal(app.$('start-time').value, '1.3');
    assert.equal(app.$('start-time').fire('keydown', { key: 'ArrowDown' }).defaultPrevented, true); assert.equal(app.$('start-time').value, '0.3');
    app.$('end-time').value = '1.26'; app.$('end-time').fire('input'); app.$('range-reset').click(); assert.equal(app.$('end-time').value, '2.345678901');
    app.$('end-down').click(); assert.equal(Number(app.$('end-time').value), 1.345678901); app.$('end-up').click(); assert.equal(Number(app.$('end-time').value), 2.345678901);
    app.$('start-down').click(); assert.equal(app.$('start-time').value, '0');
    checks++;
  }
  {
    const app = boot(); app.$('open-url').click(); app.submit('https://media.example.test/fail.mp4'); app.requests[0].fail(); await tick();
    app.expectFeedback('error'); assert.equal(app.$('url-panel').hidden, false); assert.equal(app.$('start-time').disabled, false); assert.equal(app.$('analyse-video').disabled, true); assert.equal(app.$('load-url').disabled, false);
    app.submit('https://media.example.test/retry.mp4'); app.expectFeedback('loading'); app.requests[1].complete(); await tick(); app.expectFeedback('ready');
    assert.equal(app.$('video-url').getAttribute('aria-invalid'), null);
    checks++;
  }
  for (const action of ['cancel-source', 'cancel-analysis', 'clear-results', 'demo-top', 'invalid-url', 'empty-video', 'bad-json']) {
    const app = boot(); app.$('open-url').click(); app.submit('https://media.example.test/slow.mp4');
    const old = app.requests[0]; old.ignoreAbort = true;
    if (action === 'invalid-url') app.submit('not-a-url');
    else if (action === 'empty-video') await app.access.loadVideo({ size: 0 });
    else if (action === 'bad-json') await app.access.loadResult({ size: 1, text: async () => '{invalid' });
    else app.$(action).click();
    assert.equal(old.aborted, true, `${action} aborts old load`); assert.equal(app.$('start-time').disabled, false, `${action} releases busy controls`);
    const expected = action === 'demo-top' ? 'idle' : action === 'invalid-url' || action === 'empty-video' ? 'error' : 'cancelled';
    app.expectFeedback(expected); const message = app.feedback().message;
    // Emulate an external loader that still sends a queued callback/settles after abort.
    old.progress('buffering'); old.complete({ duration: 9, width: 800, height: 600 }); await tick();
    app.expectFeedback(expected); assert.equal(app.feedback().message, message, `${action} ignores stale load completion`);
    assert.equal(app.access.state.videoReady, false);
    if (action === 'demo-top') { assert.equal(app.access.state.demoId, 'swing'); assert.equal(app.access.state.frames.length, 121); }
    checks++;
  }
  {
    const app = boot(); app.$('open-url').click(); app.submit('https://media.example.test/old.mp4'); const old = app.requests[0]; old.ignoreAbort = true;
    app.submit('https://media.example.test/new.mp4'); const current = app.requests[1]; assert.equal(old.aborted, true); app.expectFeedback('loading');
    current.complete({ duration: 1.23456789, width: 400, height: 300 }); await tick(); app.expectFeedback('ready');
    const message = app.feedback().message; old.progress('stalled'); old.complete({ duration: 10, width: 800, height: 600 }); await tick();
    app.expectFeedback('ready'); assert.equal(app.feedback().message, message); assert.equal(app.access.state.width, 400); assert.equal(app.$('end-time').value, '1.23456789');
    checks++;
  }
  {
    const app = boot(); app.$('open-url').click(); app.submit('https://media.example.test/old.mp4'); const old = app.requests[0]; old.ignoreAbort = true;
    const core = app.scope.SwingMotionCore;
    const demo = app.scope.MOTION_DEMOS.arm;
    const json = core.exportJSON(core.analyse(demo.frames, demo.options), { sourceKind: 'demo', metricGroup: 'elbows', label: demo.label, width: demo.width, height: demo.height });
    await app.access.loadResult({ size: json.length, text: async () => json }); app.expectFeedback('results');
    assert.equal(app.access.state.demoId, null); assert.equal(app.access.state.videoReady, false); assert.equal(app.access.state.metricGroup, 'elbows'); assert.equal(app.access.state.frames.length, 121);
    old.complete(); await tick(); app.expectFeedback('results');
    // Import should keep precise source times, even after an unfinished edit.
    app.$('end-time').value = '0.26'; app.$('end-time').fire('input');
    const imported = JSON.parse(json); imported.frames[imported.frames.length - 1].time = 4.23456789;
    await app.access.loadResult({ size: 2000, text: async () => JSON.stringify(imported) });
    assert.equal(app.$('end-time').value, '4.23456789'); app.$('end-down').click(); assert.equal(Number(app.$('end-time').value), 3.23456789);
    checks++;
  }
  {
    const app = boot(); let finishRead;
    const json = app.scope.SwingMotionCore.exportJSON(app.scope.SwingMotionCore.analyse(app.scope.MOTION_DEMOS.arm.frames), { sourceKind: 'demo', metricGroup: 'elbows' });
    const importing = app.access.loadResult({ size: 1000, text: () => new Promise(resolve => { finishRead = resolve; }) });
    app.access.loadDemo('squat'); finishRead(json); await importing;
    app.expectFeedback('idle'); assert.equal(app.access.state.demoId, 'squat'); assert.equal(app.access.state.metricGroup, 'knees');
    checks++;
  }
  console.log(`PASS: ${checks} app UI integration scenarios (VM/Fake DOM; actual classic modules; controllable loader).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
