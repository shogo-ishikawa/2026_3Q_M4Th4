'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {validateResult, compactPoints} = require('../web/app.js');
const directory = process.argv[2];
if (!directory) throw new Error('Pass the generated public data directory.');
let checks = 0;
const originals = {};
for (const kind of ['white', 'pink', 'brown']) {
  const result = JSON.parse(fs.readFileSync(path.join(directory, `demo-${kind}.json`), 'utf8'));
  assert.equal(validateResult(result), result);
  assert.equal(result.status, kind === 'pink' ? 'near' : 'not_near');
  originals[kind] = result;
  checks++;
}
for (const mutate of [
  result => { result.schema_version = 'student-waveform-fft'; },
  result => { result.fit.slope = NaN; },
  result => { result.series.envelope.pop(); },
  result => { result.spectrum.power[0] = -1; },
  result => { result.fit.r_squared = 2; },
  result => { result.quality.reasons = ['x'.repeat(2100)]; },
  result => { result.series.time_seconds = [2, 1]; result.series.envelope = [1, 1]; }
]) {
  const result = structuredClone(originals.pink);
  mutate(result);
  assert.throws(() => validateResult(result));
  checks++;
}
const x = Array.from({length: 12000}, (_, index) => index / 100);
const y = x.map(() => 0);
y[4567] = 100;
const points = compactPoints(x, y, 1600);
assert(points.length <= 1600);
assert(points.some(point => point[1] === 100));
assert(points.every((point, index) => index === 0 || point[0] >= points[index - 1][0]));
checks++;
console.log(`${checks} viewer checks passed.`);
