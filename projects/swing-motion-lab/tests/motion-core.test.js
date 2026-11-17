'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../web/motion-core.js');

function close(actual, expected, tolerance = 1e-7) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function points(angle, cx, cy, span = 100, confidence = 1) {
  const dx = Math.cos(angle * Math.PI / 180) * span / 2;
  const dy = Math.sin(angle * Math.PI / 180) * span / 2;
  return [{ x: cx - dx, y: cy + dy, confidence }, { x: cx + dx, y: cy - dy, confidence }];
}
function frame(time, shoulder = 0, hip = 0) {
  const [leftShoulder, rightShoulder] = points(shoulder, 200, 100);
  const [leftHip, rightHip] = points(hip, 200, 230);
  return { time, points: { leftShoulder, rightShoulder, leftHip, rightHip } };
}
const noSmoothing = { smoothingWindow: 1 };

test('image coordinates give counterclockwise positive angles with y upwards', () => {
  const result = core.analyse([frame(0, 30, -25)], noSmoothing).frames[0];
  close(result.shoulderAngle, 30); close(result.hipAngle, -25); close(result.relativeAngle, 55);
  const row = frame(0); row.points.rightShoulder.y += 100;
  close(core.analyse([row], noSmoothing).frames[0].shoulderAngle, -45);
});

test('a line has the same orientation when left and right endpoint labels swap', () => {
  const a = frame(0, 20, -20), b = frame(0.1, 20, -20);
  [b.points.leftShoulder, b.points.rightShoulder] = [b.points.rightShoulder, b.points.leftShoulder];
  const r = core.analyse([a, b], noSmoothing);
  close(r.frames[1].shoulderAngle, 20); close(r.frames[1].shoulderVelocity, 0);
});

test('crossing the axis boundary from 89 to 91 degrees is a two-degree turn', () => {
  const r = core.analyse([frame(0, 89), frame(0.1, 91)], noSmoothing);
  close(r.frames[1].shoulderAngleRaw, -89);
  close(r.frames[1].shoulderAngleUnwrapped, 91);
  close(r.frames[1].shoulderVelocity, 20);
});

test('a sequence crossing vertical is continuous without a 180-degree spike', () => {
  const r = core.analyse([80, 85, 90, 95, 100].map((a, i) => frame(i / 10, a)), noSmoothing);
  r.frames.slice(1).forEach(row => close(row.shoulderVelocity, 50));
  close(r.frames.at(-1).shoulderAngle, 100);
});

test('exactly ninety degrees starts a new segment instead of choosing a rotation sign', () => {
  const r = core.analyse([frame(0, 0), frame(0.1, 90), frame(0.2, 95)], noSmoothing);
  assert.equal(r.frames[1].shoulderValid, true);
  assert.equal(r.frames[1].shoulderAmbiguous, true);
  assert.equal(r.frames[1].shoulderVelocity, null);
  assert.notEqual(r.frames[0].shoulderSegment, r.frames[1].shoulderSegment);
  close(r.frames[2].shoulderVelocity, 50);
});

test('axis differences select the shorter turn when observations do not determine full rotation', () => {
  const r = core.analyse([frame(0, 0), frame(0.1, 100)], noSmoothing);
  close(r.frames[1].shoulderVelocity, -800);
  close(core.wrapAxisAngle(180), 0);
  close(core.wrapAxisAngle(-181), -1);
  assert.equal(core.wrapAxisAngle(NaN), null);
});

test('missing shoulders preserve time and hips and restart shoulder differentiation', () => {
  const input = [0, 10, 20, 30, 40].map((a, i) => frame(i / 10, a, 5));
  input[2].points.leftShoulder = null;
  const r = core.analyse(input, noSmoothing);
  assert.equal(r.frames.length, 5);
  assert.equal(r.frames[2].frame, 2); close(r.frames[2].time, 0.2);
  assert.equal(r.frames[2].shoulderAngle, null);
  assert.equal(r.frames[2].shoulderVelocity, null);
  assert.equal(r.frames[3].shoulderVelocity, null);
  close(r.frames[4].shoulderVelocity, 100);
  close(r.frames[2].hipAngle, 5); close(r.frames[2].hipVelocity, 0);
  assert.equal(r.summary.shoulderValidCount, 4); assert.equal(r.summary.hipValidCount, 5);
});

test('low confidence invalidates only its own axis and the threshold is inclusive', () => {
  const a = frame(0); a.points.leftShoulder.confidence = 0.49;
  let row = core.analyse([a]).frames[0];
  assert.equal(row.shoulderValid, false); assert.equal(row.shoulderReason, 'confidence');
  assert.equal(row.shoulderConfidence, 0.49); assert.equal(row.hipValid, true);
  a.points.leftShoulder.confidence = 0.5;
  row = core.analyse([a]).frames[0]; assert.equal(row.shoulderValid, true);
  a.points.leftShoulder.confidence = 0;
  assert.equal(core.analyse([a], { confidenceThreshold: 0 }).frames[0].shoulderValid, true);
});

test('very short and coincident axes do not become a zero-degree measurement', () => {
  const a = frame(0);
  a.points.leftShoulder = { x: 10, y: 10 }; a.points.rightShoulder = { x: 10, y: 10 };
  let row = core.analyse([a]).frames[0];
  assert.equal(row.shoulderAngle, null); assert.equal(row.shoulderReason, 'short-axis');
  a.points.rightShoulder.x = 22;
  row = core.analyse([a]).frames[0]; close(row.shoulderAngle, 0);
});

test('non-finite coordinates and confidence are missing measurements', () => {
  for (const value of [NaN, Infinity, -Infinity, null]) {
    const a = frame(0); a.points.leftShoulder.x = value;
    assert.equal(core.analyse([a]).frames[0].shoulderAngle, null);
  }
  for (const value of [NaN, Infinity, null]) {
    const a = frame(0); a.points.leftShoulder.confidence = value;
    assert.equal(core.analyse([a]).frames[0].shoulderAngle, null);
  }
});

test('empty point records retain all rows and do not report zero-speed performance', () => {
  const r = core.analyse([{ time: 0, points: {} }, { time: 1 }]);
  assert.equal(r.summary.shoulderValidCount, 0);
  assert.equal(r.summary.pairedValidCount, 0);
  assert.equal(r.summary.shoulderPeakAbsVelocity, null);
  assert.equal(r.summary.hipPeakAbsVelocity, null);
  assert.equal(r.summary.relativePeakAbsAngle, null);
});

test('local linear smoothing preserves a constant angular velocity with irregular timestamps', () => {
  const times = [0, 0.1, 0.4, 0.41, 0.9, 1.3, 1.8];
  for (const smoothingWindow of [1, 3, 5, 7]) {
    const r = core.analyse(times.map(t => frame(t, 5 + 30 * t, 2 - 10 * t)), { smoothingWindow });
    r.frames.slice(1).forEach(row => { close(row.shoulderVelocity, 30); close(row.hipVelocity, -10); });
  }
});

test('time conversion changes duration and speed by reciprocal factors', () => {
  const input = [frame(4, 0), frame(4.1, 10), frame(4.2, 20)];
  const normal = core.analyse(input, noSmoothing);
  const slow = core.analyse(input, { smoothingWindow: 1, timeScale: 0.25 });
  close(slow.frames[1].shoulderVelocity, 400);
  close(normal.frames[1].shoulderVelocity, 100);
  close(slow.summary.durationSeconds, 0.05);
  close(slow.summary.videoDurationSeconds, 0.2);
  close(slow.frames[0].timeSeconds, 1);
  close(slow.frames[0].elapsedSeconds, 0);
  assert.equal(input[0].time, 4);
});

test('smoothing never sees values on the other side of a missing measurement', () => {
  const input = [frame(0, 0), frame(0.1, 5), frame(0.2, 10), frame(0.3, 0), frame(0.4, -80), frame(0.5, -75)];
  input[3].points.leftShoulder = null;
  const r = core.analyse(input, { smoothingWindow: 7 });
  close(r.frames[2].shoulderAngle, 10);
  close(r.frames[4].shoulderAngle, -80);
  assert.equal(r.frames[4].shoulderVelocity, null);
  close(r.frames[5].shoulderVelocity, 50);
});

test('relative angle uses half-turn line orientation and requires both axes', () => {
  const input = [frame(0, 89, -89), frame(0.1, 20, 10)];
  const r = core.analyse(input, noSmoothing);
  close(r.frames[0].relativeAngle, -2); close(r.frames[1].relativeAngle, 10);
  input[1].points.leftHip = null;
  assert.equal(core.analyse(input, noSmoothing).frames[1].relativeAngle, null);
});

test('one frame has an angle and no velocity', () => {
  const r = core.analyse([frame(0, 15, 5)]);
  close(r.frames[0].shoulderAngle, 15);
  assert.equal(r.frames[0].shoulderVelocity, null);
  assert.equal(r.summary.shoulderPeakAbsVelocity, null);
  assert.equal(r.summary.shoulderVelocityCount, 0);
  assert.equal(r.summary.durationSeconds, 0);
});

test('timestamps must be finite, non-negative and strictly increasing', () => {
  for (const bad of [NaN, Infinity, -1, '0', 86401])
    assert.throws(() => core.analyse([frame(bad)]));
  assert.throws(() => core.analyse([frame(0), frame(0)]), /時刻/);
  assert.throws(() => core.analyse([frame(1), frame(0)]), /時刻/);
  assert.throws(() => core.analyse([frame(0), frame(1e-12)]), /時刻/);
});

test('malformed frame IDs, point shapes, numbers and confidence are rejected', () => {
  for (const value of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => core.analyse([{ ...frame(0), frame: value }]));
  assert.throws(() => core.analyse([{ time: 0, points: [] }]));
  for (const value of ['100', [100], {}]) {
    const a = frame(0); a.points.leftShoulder.x = value;
    assert.throws(() => core.analyse([a]));
  }
  for (const value of [-0.1, 1.1, '0.8']) {
    const a = frame(0); a.points.leftShoulder.confidence = value;
    assert.throws(() => core.analyse([a]));
  }
  const a = frame(0); a.points.leftShoulder.x = 1000001;
  assert.throws(() => core.analyse([a]), /座標/);
});

test('options use bounded numeric values and a supported smoothing window', () => {
  for (const options of [{ confidenceThreshold: -1 }, { confidenceThreshold: NaN },
    { minSpanPx: 0 }, { minSpanPx: '12' }, { smoothingWindow: 2 }, { smoothingWindow: '3' },
    { timeScale: 0 }, { timeScale: Infinity }, { timeScale: 1001 }])
    assert.throws(() => core.analyse([frame(0)], options));
  const r = core.analyse([frame(0)], { model: 'unused' });
  assert.deepEqual(r.options, core.DEFAULT_OPTIONS);
});

test('frame and JSON limits are checked before analysis', () => {
  assert.throws(() => core.analyse([]));
  assert.throws(() => core.analyse(Array(core.LIMITS.maxFrames + 1).fill(frame(0))), /時点以内/);
  assert.throws(() => core.readJSON(' '.repeat(core.LIMITS.maxJSONCharacters + 1)), /大きさ/);
});

test('JSON round trips coordinates, confidence, dimensions and the exact analysis options', () => {
  const input = [frame(0, 80), frame(0.1, 85), frame(0.2, 92)];
  input[1].points.leftHip = null;
  const result = core.analyse(input, { timeScale: 0.5, smoothingWindow: 5 });
  const text = core.exportJSON(result, { label: '一つ目のスイング', sourceKind: 'manual', width: 960, height: 540 });
  const loaded = core.readJSON('\uFEFF' + text);
  assert.equal(loaded.label, '一つ目のスイング'); assert.equal(loaded.sourceKind, 'manual');
  assert.equal(loaded.width, 960); assert.equal(loaded.height, 540);
  assert.deepEqual(loaded.frames, result.inputFrames); assert.deepEqual(loaded.options, result.options);
  assert.deepEqual(core.analyse(loaded.frames, loaded.options).frames, result.frames);
});

test('JSON rejects another schema, another file kind, bad labels and bad dimensions', () => {
  const document = JSON.parse(core.exportJSON(core.analyse([frame(0)])));
  for (const patch of [{ schemaVersion: '3.0.0' }, { schemaVersion: null }, { kind: 'weather' },
    { sourceKind: 'unrecognised' }, { label: [] }, { width: -10 }, { height: 2.5 }, { frames: [] }])
    assert.throws(() => core.readJSON(JSON.stringify({ ...document, ...patch })));
  assert.throws(() => core.readJSON('{not JSON}'), /JSON/);
  assert.throws(() => core.readJSON('[]'));
});

test('unknown and missing measurements remain empty CSV cells with finite numeric values', () => {
  const input = [frame(0), frame(0.1, 10), frame(0.2)]; input[2].points = {};
  const result = core.analyse(input, noSmoothing), text = core.exportCSV(result);
  assert.ok(text.startsWith('\uFEFFframe,video_time_s'));
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/NaN|Infinity|undefined|null/.test(text));
  const lines = text.trim().replace(/^\uFEFF/, '').split('\r\n');
  const headers = lines[0].split(','), index = headers.indexOf('shoulder_velocity_smoothed_deg_s');
  assert.equal(lines[1].split(',')[index], '');
  assert.equal(lines[3].split(',')[index], '');
  close(Number(lines[2].split(',')[index]), 100);
});

test('exports rebuild values from recorded input instead of accepting injected output cells', () => {
  const result = core.analyse([frame(0), frame(1, 10)], noSmoothing);
  result.frames[0].frame = '=1+1'; result.frames[1].shoulderVelocity = 'malicious';
  const csv = core.exportCSV(result);
  assert.ok(!csv.includes('=1+1')); assert.ok(!csv.includes('malicious'));
  const text = core.exportJSON(result, { label: '=SUM(1,2)', sourceKind: 'results' });
  const loaded = core.readJSON(text); assert.equal(loaded.label, '=SUM(1,2)');
  assert.ok(!core.exportCSV(result).includes('SUM'));
});

test('normalisation copies only coordinate fields and does not keep arbitrary input properties', () => {
  const input = [frame(0)]; input[0].extra = 'discard'; input[0].points.leftShoulder.extra = 'discard';
  const result = core.analyse(input);
  input[0].points.leftShoulder.x = 1;
  assert.notEqual(result.inputFrames[0].points.leftShoulder.x, 1);
  const text = core.exportJSON(result, { label: 'ABC\u0000DEF' });
  assert.ok(!text.includes('discard')); assert.equal(core.readJSON(text).label, 'ABCDEF');
});

test('a JSON prototype key cannot affect result options or JavaScript prototypes', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"time":0,"points":{}}');
  const options = JSON.parse('{"__proto__":{"polluted":true},"timeScale":1}');
  const result = core.analyse([input], options);
  assert.equal({}.polluted, undefined);
  assert.equal(result.options.polluted, undefined);
  assert.deepEqual(result.inputFrames[0].points, Object.fromEntries(core.POINT_NAMES.map(name => [name, null])));
});

test('the synthetic demo has finite projected measurements with upright body rotation', () => {
  const demo = require('../web/demo-data.js');
  assert.equal(demo.sourceKind, 'demo'); assert.match(demo.label, /デモ/);
  assert.equal(demo.width, 960); assert.equal(demo.height, 540);
  const r = core.analyse(demo.frames, demo.options);
  assert.equal(r.summary.frameCount, 121); assert.equal(r.summary.pairedValidCount, 121);
  close(r.summary.durationSeconds, 4);
  assert.match(demo.description, /合成/);
  assert.ok(Math.abs(r.frames.at(-1).shoulderAngle - r.frames[0].shoulderAngle) > 15);
  assert.ok(Math.abs(r.frames.at(-1).hipAngle - r.frames[0].hipAngle) > 8);
  assert.ok(r.frames.every(row => Math.abs(row.shoulderAngle) < 35 && Math.abs(row.hipAngle) < 25));
  assert.ok(r.summary.shoulderPeakAbsVelocity > 20);
  assert.ok(r.summary.shoulderPeakAbsVelocity < 100);
  const saved = core.readJSON(core.exportJSON(r, demo));
  assert.equal(saved.sourceKind, 'demo'); assert.match(saved.label, /デモ/);
});

test('CSV records measured points including genuine zero coordinates and empty missing points', () => {
  const a = frame(0); a.points.leftShoulder = { x: 0, y: 0, confidence: 1 }; a.points.leftHip = null;
  const csv = core.exportCSV(core.analyse([a]));
  const lines = csv.trim().replace(/^\uFEFF/, '').split('\r\n');
  const headers = lines[0].split(','), cells = lines[1].split(',');
  assert.equal(cells[headers.indexOf('left_shoulder_x_px')], '0');
  assert.equal(cells[headers.indexOf('left_shoulder_y_px')], '0');
  assert.equal(cells[headers.indexOf('left_hip_x_px')], '');
  assert.equal(cells[headers.indexOf('left_hip_confidence')], '');
});

test('classic browser scripts expose their APIs without a module loader or network access', () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/motion-core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/demo-data.js'), 'utf8'), context);
  const summary = vm.runInContext('SwingMotionCore.analyse(SWING_DEMO.frames, SWING_DEMO.options).summary', context);
  assert.equal(summary.frameCount, 121); assert.equal(summary.pairedValidCount, 121);
});

function jointFrame(time, leftAngle, rightAngle = leftAngle) {
  const positions = {};
  for (const [side, angle, offset] of [['left', leftAngle, 0], ['right', rightAngle, 600]]) {
    const radians = angle * Math.PI / 180;
    for (const [a, b, c, x] of [['Shoulder', 'Elbow', 'Wrist', offset], ['Hip', 'Knee', 'Ankle', offset + 300]]) {
      positions[side + a] = { x, y: -100, confidence: 1 };
      positions[side + b] = { x, y: 0, confidence: 1 };
      positions[side + c] = { x: x + 100 * Math.sin(radians), y: -100 * Math.cos(radians), confidence: 1 };
    }
  }
  return { time, points: positions };
}
function trunkFrame(time, angle) {
  const radians = angle * Math.PI / 180, x = 100 * Math.sin(radians), y = -100 * Math.cos(radians);
  return { time, points: { leftShoulder: { x: x - 40, y }, rightShoulder: { x: x + 40, y },
    leftHip: { x: -40, y: 0 }, rightHip: { x: 40, y: 0 } } };
}

test('interior elbow and knee angles are 0..180 degrees with a straight limb at 180', () => {
  for (const angle of [0, 30, 90, 150, 180]) {
    const r = core.analyse([jointFrame(0, angle)], noSmoothing);
    for (const name of ['leftElbow', 'rightElbow', 'leftKnee', 'rightKnee']) {
      close(r.frames[0][name + 'AngleRaw'], angle);
      assert.equal(r.frames[0][name + 'Valid'], true);
      assert.equal(r.summary.metrics[name].validCount, 1);
    }
  }
});

test('joint angles do not use half-turn axis wrapping when a limb extends rapidly', () => {
  const r = core.analyse([jointFrame(0, 30, 150), jointFrame(0.1, 150, 30)], noSmoothing);
  for (const name of ['leftElbow', 'leftKnee']) close(r.frames[1][name + 'Velocity'], 1200);
  for (const name of ['rightElbow', 'rightKnee']) close(r.frames[1][name + 'Velocity'], -1200);
  assert.equal(r.frames[1].leftKneeAmbiguous, false);
  assert.equal(r.frames[0].leftKneeSegment, r.frames[1].leftKneeSegment);
});

test('a missing hand splits only the affected elbow series and preserves the knees', () => {
  const input = [0, 1, 2, 3, 4].map(i => jointFrame(i / 10, 30 + i * 10));
  input[2].points.leftWrist = null;
  const r = core.analyse(input, { smoothingWindow: 7 });
  assert.equal(r.frames[2].leftElbowAngle, null);
  assert.equal(r.frames[3].leftElbowVelocity, null);
  close(r.frames[4].leftElbowVelocity, 100);
  close(r.frames[2].leftKneeVelocity, 100);
  close(r.frames[2].rightElbowVelocity, 100);
  assert.notEqual(r.frames[1].leftElbowSegment, r.frames[3].leftElbowSegment);
});

test('all three joint points need confidence and both limb segments need length', () => {
  const a = jointFrame(0, 90); a.points.leftWrist.confidence = 0.2;
  let r = core.analyse([a]).frames[0];
  assert.equal(r.leftElbowReason, 'confidence'); assert.equal(r.leftElbowConfidence, 0.2);
  assert.equal(r.leftKneeValid, true);
  a.points.leftWrist = { ...a.points.leftElbow, x: a.points.leftElbow.x + 11 };
  r = core.analyse([a]).frames[0]; assert.equal(r.leftElbowReason, 'short-axis');
  a.points.leftWrist.x += 1;
  assert.equal(core.analyse([a]).frames[0].leftElbowValid, true);
});

test('smoothing interior angles stays inside the geometric range even at abrupt endpoints', () => {
  for (const angles of [[0, 0, 180], [180, 180, 0], [0, 180, 180, 0, 0]]) {
    const r = core.analyse(angles.map((a, i) => jointFrame(i / 10, a)), { smoothingWindow: 5 });
    for (const row of r.frames) for (const name of ['leftElbow', 'rightElbow', 'leftKnee', 'rightKnee'])
      assert.ok(row[name + 'Angle'] >= 0 && row[name + 'Angle'] <= 180);
  }
});

test('trunk is zero upright and positive towards image right', () => {
  for (const angle of [-90, -30, 0, 30, 90])
    close(core.analyse([trunkFrame(0, angle)], noSmoothing).frames[0].trunkTiltAngle, angle);
  const a = trunkFrame(0, 30); a.points.leftShoulder.confidence = 0.4;
  assert.equal(core.analyse([a]).frames[0].trunkTiltReason, 'confidence');
  a.points.leftShoulder = a.points.rightShoulder = { x: 0, y: 0 };
  assert.equal(core.analyse([a]).frames[0].trunkTiltReason, 'short-axis');
});

test('trunk uses a full-turn period and splits an exactly half-turn step', () => {
  const r = core.analyse([trunkFrame(0, 179), trunkFrame(0.1, -179)], noSmoothing);
  close(r.frames[1].trunkTiltAngleUnwrapped, 181); close(r.frames[1].trunkTiltVelocity, 20);
  const ambiguous = core.analyse([trunkFrame(0, 0), trunkFrame(0.1, 180), trunkFrame(0.2, 175)], noSmoothing);
  assert.equal(ambiguous.frames[1].trunkTiltAmbiguous, true);
  assert.equal(ambiguous.frames[1].trunkTiltVelocity, null);
  close(ambiguous.frames[2].trunkTiltVelocity, -50);
});

test('joint angular velocities preserve irregular timestamps and use the slow-motion time scale', () => {
  const times = [2, 2.05, 2.2, 2.4, 2.7];
  const input = times.map(t => jointFrame(t, 30 + (t - 2) * 60));
  const r = core.analyse(input, { smoothingWindow: 5, timeScale: 0.25 });
  for (const row of r.frames.slice(1)) close(row.leftElbowVelocity, 240);
  close(r.summary.metrics.leftElbow.peakAbsVelocity, 240);
  close(r.summary.metrics.leftKnee.minAngle, 30);
});

test('legacy four-point JSON imports as axes and keeps its original measurements', () => {
  const old = { schemaVersion: '1.0.0', kind: 'swing-motion-points', sourceKind: 'video',
    label: '肩と腰', options: noSmoothing, frames: [frame(0, 30), frame(0.1, 40)] };
  const loaded = core.readJSON(JSON.stringify(old));
  assert.equal(loaded.metricGroup, 'axes'); assert.equal(loaded.schemaVersion, '2.0.0');
  assert.equal(loaded.frames[0].points.leftElbow, null);
  const result = core.analyse(loaded.frames, loaded.options);
  close(result.frames[1].shoulderVelocity, 100);
  assert.equal(result.frames[1].leftElbowAngle, null);
});

test('schema2 preserves all twelve points and the selected metric group', () => {
  const r = core.analyse([jointFrame(0, 30), jointFrame(0.1, 50)], noSmoothing);
  assert.equal(core.POINT_NAMES.length, 12);
  for (const metricGroup of Object.keys(core.METRIC_GROUPS)) {
    const text = core.exportJSON(r, { metricGroup, label: '動作の座標', sourceKind: 'manual' });
    const saved = core.readJSON(text), document = JSON.parse(text);
    assert.equal(document.schemaVersion, '2.0.0'); assert.equal(document.kind, 'motion-analysis-points');
    assert.equal(saved.metricGroup, metricGroup); assert.deepEqual(saved.frames, r.inputFrames);
    assert.deepEqual(core.analyse(saved.frames, saved.options).frames, r.frames);
  }
  for (const metricGroup of ['__proto__', 'toString', null, 'other', 12]) {
    assert.throws(() => core.exportJSON(r, { metricGroup }));
    const document = JSON.parse(core.exportJSON(r)); document.metricGroup = metricGroup;
    assert.throws(() => core.readJSON(JSON.stringify(document)));
  }
});

test('CSV includes all joint results and original wrist and ankle coordinates', () => {
  const input = jointFrame(0, 90), text = core.exportCSV(core.analyse([input], noSmoothing));
  const [header, row] = text.replace(/^\uFEFF/, '').trim().split('\r\n').map(line => line.split(','));
  close(Number(row[header.indexOf('left_knee_angle_raw_deg')]), 90);
  close(Number(row[header.indexOf('left_wrist_x_px')]), input.points.leftWrist.x);
  close(Number(row[header.indexOf('right_ankle_y_px')]), input.points.rightAnkle.y);
});

test('all demos supply twelve finite points and their stated analytic joint angles', () => {
  const { demos } = require('../web/demo-data.js');
  assert.deepEqual(Object.keys(demos), ['swing', 'squat', 'arm']);
  for (const demo of Object.values(demos)) {
    assert.equal(demo.sourceKind, 'demo'); assert.match(demo.label, /デモ/);
    assert.ok(core.METRIC_GROUPS[demo.metricGroup]);
    for (const f of demo.frames) for (const name of core.POINT_NAMES) {
      assert.ok(f.points[name]); assert.ok(Number.isFinite(f.points[name].x)); assert.ok(Number.isFinite(f.points[name].y));
    }
  }
  const squat = core.analyse(demos.squat.frames, noSmoothing);
  close(squat.frames[0].leftKneeAngle, 180); close(squat.frames[30].leftKneeAngle, 90);
  close(squat.frames[60].leftKneeAngle, 180); close(squat.frames[90].leftKneeAngle, 90);
  const arm = core.analyse(demos.arm.frames, noSmoothing);
  close(arm.frames[0].leftElbowAngle, 180); close(arm.frames[60].leftElbowAngle, 45);
  close(arm.frames[60].rightElbowAngle, 80);
});

test('the maximum supported full-body sequence can be exported and loaded again', () => {
  const points = jointFrame(0, 45).points;
  for (const p of Object.values(points)) {
    p.x = -0.0000010000000000000002;
    p.y = -0.0000010000000000000002;
    p.confidence = 0.0000010000000000000002;
  }
  const frames = Array.from({ length: core.LIMITS.maxFrames }, (_, i) => ({ time: i / 30, points }));
  const result = core.analyse(frames, noSmoothing), text = core.exportJSON(result);
  assert.ok(text.length <= core.LIMITS.maxJSONCharacters);
  const saved = core.readJSON(text); assert.equal(saved.frames.length, core.LIMITS.maxFrames);
  close(saved.frames.at(-1).points.rightAnkle.x, points.rightAnkle.x);
});
