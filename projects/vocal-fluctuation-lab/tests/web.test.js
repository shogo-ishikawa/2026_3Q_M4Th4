'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {validateResult, compactPoints, preprocessingReport, MAX_RESULT_BYTES} = require('../web/app.js');
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
// A ten-minute result and the recorded silence edits must remain viewable.
const fullTrack = structuredClone(originals.pink);
fullTrack.duration_seconds = 600;
fullTrack.series.time_seconds = Array.from({length: 60000}, (_, index) => index / 100);
fullTrack.series.envelope = fullTrack.series.time_seconds.map(value => .1 + Math.abs(Math.sin(value)) / 10);
assert(Buffer.byteLength(JSON.stringify(fullTrack, null, 2)) < MAX_RESULT_BYTES);
assert.equal(validateResult(fullTrack), fullTrack);
checks++;
const trimmed = structuredClone(originals.pink);
trimmed.duration_seconds = 117;
trimmed.metadata = {preprocessing: {
  method_id: 'rms-silence-v1', input_duration_seconds: 130, output_duration_seconds: 117,
  leading_removed_seconds: 5, trailing_removed_seconds: 5, internal_removed_seconds: 3,
  kept_segments_seconds: [[5, 60], [63, 125]], timeline_modified: true
}};
assert.equal(validateResult(trimmed), trimmed);
assert.equal(preprocessingReport(originals.pink), null);
checks++;
for (const mutate of [
  report => { report.output_duration_seconds = 115; },
  report => { report.kept_segments_seconds[1] = [59, 125]; },
  report => { report.kept_segments_seconds = []; },
  report => { report.timeline_modified = false; },
  report => { report.leading_removed_seconds = -1; },
  report => { report.kept_segments_seconds[0] = [4, 59]; },
  report => { report.internal_removed_seconds = Infinity; }
]) {
  const result = structuredClone(trimmed);
  mutate(result.metadata.preprocessing);
  assert.throws(() => validateResult(result));
  checks++;
}
console.log(`${checks} viewer checks passed.`);
