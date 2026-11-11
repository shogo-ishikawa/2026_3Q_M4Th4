'use strict';
// Run the real page controller with delayed network/audio services. The small
// DOM stub checks state changes; visual layout is checked in a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
class Element {
  constructor(id = '') {
    this.id = id; this.value = ''; this.hidden = false; this.disabled = false;
    this.textContent = ''; this.children = []; this.attributes = {}; this.listeners = {};
    this.dataset = {};
    const classes = new Set();
    this.classList = {add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name)};
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async click() {
    if (this.disabled) return;
    await Promise.all((this.listeners.click || []).map(callback => callback({target: this})));
  }
}

function createPage() {
  const directory = path.resolve(__dirname, '../web');
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const elements = {};
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = elements[match[1]] = new Element(match[1]);
    element.value = /\bvalue="([^"]+)"/.exec(match[0])?.[1] || '';
    element.hidden = /\bhidden\b/.test(match[0]);
    element.disabled = /\bdisabled\b/.test(match[0]);
  }
  const buttons = [...html.matchAll(/<button\b[^>]*data-demo="([^"]+)"[^>]*>/g)].map(match => {
    const button = new Element(); button.dataset.demo = match[1]; return button;
  });
  const documentListeners = {}, windowListeners = {};
  const document = {
    hidden: false, getElementById: id => elements[id], createElementNS: () => new Element(),
    querySelectorAll: selector => { assert.equal(selector, '[data-demo]'); return buttons; },
    addEventListener: (name, callback) => { (documentListeners[name] ||= []).push(callback); }
  };
  const requests = [], contexts = [];
  class AudioContext {
    constructor() { this.currentTime = 0; this.resumptions = []; this.oscillators = []; contexts.push(this); }
    resume() { const next = deferred(); this.resumptions.push(next); return next.promise; }
    createOscillator() {
      const oscillator = {frequency: {setValueAtTime() {}, setTargetAtTime() {}},
        starts: [], stops: [], connect() {}, disconnect() {},
        start(time) { this.starts.push(time); }, stop(time) { this.stops.push(time); }};
      this.oscillators.push(oscillator); return oscillator;
    }
    createGain() {
      return {gain: {setValueAtTime() {}, linearRampToValueAtTime() {},
        cancelScheduledValues() {}, setTargetAtTime() {}}, connect() {}, disconnect() {}};
    }
  }
  const window = {AudioContext, addEventListener: (name, callback) => { (windowListeners[name] ||= []).push(callback); }};
  const fetch = url => { const request = deferred(); requests.push({...request, url}); return request.promise; };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'app.js'), 'utf8'), {document, window, fetch, console});
  return {elements, buttons, requests, contexts, document,
    hide() { document.hidden = true; documentListeners.visibilitychange.forEach(callback => callback()); },
    pagehide() { (windowListeners.pagehide || []).forEach(callback => callback()); }};
}

async function main() {
  const directory = process.argv[2] || path.join(__dirname, '../web/data');
  const fixtures = Object.fromEntries(['white', 'pink', 'brown'].map(kind => [kind,
    JSON.parse(fs.readFileSync(path.join(directory, `demo-${kind}.json`), 'utf8'))]));
  const page = createPage(), elements = page.elements;
  const respond = (request, kind) => request.resolve({ok: true, json: async () => structuredClone(fixtures[kind])});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let checks = 0;

  assert.equal(page.requests[0].url, 'data/demo-pink.json');
  assert(elements['demo-result'].hidden);
  assert.equal(elements['demo-result'].attributes['aria-busy'], 'true');
  respond(page.requests[0], 'pink'); await flush();
  assert.equal(elements['demo-result'].hidden, false);
  assert.equal(elements['demo-result'].attributes['aria-busy'], 'false');
  assert.equal(elements['metric-r2'].textContent, fixtures.pink.fit.r_squared.toFixed(3));
  assert.equal(elements['demo-band'].textContent,
    `${Math.round(fixtures.pink.fit.band_low_hz * 1000) / 1000}〜${fixtures.pink.fit.band_high_hz}`);
  checks++;

  const white = page.buttons.find(button => button.dataset.demo === 'white');
  const whiteLoad = white.click();
  assert.equal(white.attributes['aria-pressed'], 'true');
  assert(elements['demo-result'].hidden, 'The former graph must hide while another example loads.');
  assert.equal(elements['demo-result'].attributes['aria-busy'], 'true');
  respond(page.requests[1], 'white'); await whiteLoad;
  assert.equal(elements['result-title'].textContent, '白色のゆらぎ');
  assert.equal(elements['demo-result'].hidden, false);
  checks++;

  const pinkLoad = page.buttons.find(button => button.dataset.demo === 'pink').click();
  const brownLoad = page.buttons.find(button => button.dataset.demo === 'brown').click();
  respond(page.requests[2], 'pink'); await pinkLoad;
  assert(elements['demo-result'].hidden, 'An older response must not reveal its graph.');
  assert.equal(elements['demo-result'].attributes['aria-busy'], 'true');
  respond(page.requests[3], 'brown'); await brownLoad;
  assert.equal(elements['result-title'].textContent, '褐色のゆらぎ');
  assert.equal(elements['demo-result'].attributes['aria-busy'], 'false');
  checks++;

  const failed = white.click(); page.requests[4].reject(new Error('offline')); await failed;
  assert(elements['demo-result'].hidden);
  assert.equal(elements['demo-result'].attributes['aria-busy'], 'false');
  assert(elements['viewer-message'].classList.contains('error'));
  assert.match(elements['viewer-message'].textContent, /再試行/);
  const retry = white.click(); respond(page.requests[5], 'white'); await retry;
  assert.equal(elements['demo-result'].hidden, false);
  assert.equal(elements['viewer-message'].classList.contains('error'), false);
  checks++;

  const firstPlay = elements['play-tone'].click();
  assert(elements['play-tone'].disabled);
  const audio = page.contexts[0];
  page.hide();
  assert.equal(elements['play-tone'].disabled, false);
  audio.resumptions[0].resolve(); await firstPlay;
  assert.equal(audio.oscillators.length, 0, 'A cancelled resume must not start sound after the page hides.');
  checks++;

  page.document.hidden = false;
  const secondPlay = elements['play-tone'].click(); audio.resumptions[1].resolve(); await secondPlay;
  assert.equal(audio.oscillators.length, 1);
  assert.deepEqual(audio.oscillators[0].starts, [0]);
  assert.deepEqual(audio.oscillators[0].stops, [3]);
  assert.equal(elements['stop-tone'].disabled, false);
  audio.oscillators[0].onended();
  assert.equal(elements['play-tone'].disabled, false);
  assert(elements['stop-tone'].disabled);
  checks++;

  const thirdPlay = elements['play-tone'].click();
  page.pagehide();
  audio.resumptions[2].reject(new Error('resume interrupted')); await thirdPlay;
  assert.equal(audio.oscillators.length, 1);
  assert.equal(elements['play-tone'].disabled, false);
  assert.doesNotMatch(elements['tone-status'].textContent, /再生できませんでした/);
  checks++;

  // A new visible request can start before a cancelled older resume resolves.
  const stalePlay = elements['play-tone'].click();
  page.hide(); page.document.hidden = false;
  const currentPlay = elements['play-tone'].click();
  audio.resumptions[4].resolve(); await currentPlay;
  const playingStatus = elements['tone-status'].textContent;
  audio.resumptions[3].resolve(); await stalePlay;
  assert.equal(audio.oscillators.length, 2);
  assert(elements['play-tone'].disabled);
  assert.equal(elements['tone-status'].textContent, playingStatus);
  audio.oscillators[1].onended();
  assert.equal(elements['play-tone'].disabled, false);
  checks++;
  console.log(`${checks} interaction-state checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
