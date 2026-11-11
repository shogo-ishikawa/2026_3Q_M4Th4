'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {validateCatalogue, filterReferences} = require('../web/catalogue.js');
const cataloguePath = process.argv[2] || path.join(__dirname, '../data/reference_catalogue_public.json');
const catalogue = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
let checks = 0;

validateCatalogue(catalogue);
assert(catalogue.references.length > 0);
assert.equal(new Set(catalogue.references.map(row => row.artist + '\0' + row.track)).size, catalogue.references.length);
checks++;

const first = catalogue.references[0];
assert(filterReferences(catalogue.references, first.artist.toUpperCase()).some(row => row.track === first.track));
assert(filterReferences(catalogue.references, '  ' + first.artist + '   ' + first.track + '  ').some(row => row.track === first.track));
assert.equal(filterReferences(catalogue.references, 'この曲名は登録されていません').length, 0);
checks++;

const vocals = filterReferences(catalogue.references, '', 'already-vocals');
const separated = filterReferences(catalogue.references, '', 'demucs:htdemucs');
assert(vocals.length > 0 && separated.length > 0);
assert.equal(vocals.length + separated.length, catalogue.references.length);
assert(vocals.every(row => row.separation_method === 'already-vocals'));
assert(separated.every(row => row.separation_method === 'demucs:htdemucs'));
assert.equal(filterReferences(vocals, '', 'demucs:htdemucs').length, 0);
checks++;

for (const update of [{low_hz: 0.02}, {auto_band: true}, {high_hz: 5}, {segment_seconds: 120}]) {
  const invalid = structuredClone(catalogue);
  Object.assign(invalid.config, update);
  assert.throws(() => validateCatalogue(invalid));
}
for (const update of [{artist: ''}, {slope: NaN}, {r_squared: 1.1}, {duration_seconds: -1}, {separation_method: 'unknown'}]) {
  const invalid = structuredClone(catalogue);
  Object.assign(invalid.references[0], update);
  assert.throws(() => validateCatalogue(invalid));
}
checks++;

// Execute the actual controller with a failed request, retry, and real filtering.
class Element {
  constructor(id = '') {
    this.id = id; this.textContent = ''; this.value = ''; this.children = [];
    this.hidden = false; this.disabled = false; this.listeners = {}; this.attributes = {};
    const classes = new Set();
    this.classList = {add: value => classes.add(value), remove: value => classes.delete(value)};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  set innerHTML(_) { throw new Error('Catalogue must render names as text, never HTML.'); }
}
async function main() {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  const elements = {};
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements[match[1]] = new Element(match[1]);
  elements['catalogue-group'].value = 'all';
  const requests = [];
  const fetch = url => new Promise((resolve, reject) => requests.push({url, resolve, reject}));
  const document = {getElementById: id => elements[id], createElement: () => new Element()};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/catalogue.js'), 'utf8'), {document, fetch, console});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0].url, 'data/reference_catalogue_public.json');
  assert(elements['catalogue-search'].disabled);
  requests[0].reject(new Error('offline')); await flush();
  assert.equal(elements['reference-catalogue'].attributes['aria-busy'], 'false');
  assert.equal(elements['catalogue-retry'].hidden, false);
  assert(elements['catalogue-table-wrap'].hidden);
  assert(elements['catalogue-search'].disabled);
  checks++;

  const retry = elements['catalogue-retry'].listeners.click();
  assert(elements['catalogue-retry'].hidden);
  const fixture = structuredClone(catalogue);
  fixture.references[0].artist = '<img src=x onerror=alert(1)>';
  requests[1].resolve({ok: true, json: async () => fixture}); await retry;
  assert.equal(elements['catalogue-search'].disabled, false);
  assert.equal(elements['catalogue-rows'].children.length, fixture.references.length);
  assert.equal(elements['catalogue-rows'].children[0].children[0].textContent, fixture.references[0].artist);
  assert.equal(elements['catalogue-table-wrap'].hidden, false);
  assert(elements['catalogue-status'].textContent.includes(fixture.references.length + '曲'));
  checks++;

  elements['catalogue-search'].value = 'この曲名は登録されていません';
  elements['catalogue-search'].listeners.input();
  assert(elements['catalogue-table-wrap'].hidden);
  assert.equal(elements['catalogue-empty'].hidden, false);
  assert.equal(elements['catalogue-rows'].children.length, 0);
  elements['catalogue-search'].value = '';
  elements['catalogue-group'].value = 'already-vocals';
  elements['catalogue-group'].listeners.change();
  assert.equal(elements['catalogue-rows'].children.length, vocals.length);
  assert.equal(elements['catalogue-table-wrap'].hidden, false);
  assert(elements['catalogue-empty'].hidden);
  elements['catalogue-group'].value = 'all';
  elements['catalogue-group'].listeners.change();
  assert.equal(elements['catalogue-rows'].children.length, fixture.references.length);
  checks++;
  console.log(`${checks} catalogue checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
