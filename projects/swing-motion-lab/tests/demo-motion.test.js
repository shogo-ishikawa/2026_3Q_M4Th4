'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../web/demo-data.js');
const core = require('../web/motion-core.js');
const renderer = require('../web/demo-renderer.js');
const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function close(actual, expected, tolerance = 1e-6) { assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`); }

test('all three synthetic motions stay inside the picture and move continuously', () => {
  for (const demo of Object.values(data.demos)) {
    assert.match(demo.description, /合成/); assert.match(demo.description, /実測値ではありません/);
    assert.equal(demo.frames.length, 121);
    for (let index = 0; index < demo.frames.length; index++) {
      const frame = demo.frames[index];
      assert.deepEqual(Object.keys(frame.points).sort(), [...core.POINT_NAMES].sort());
      for (const name of core.POINT_NAMES) {
        const p = frame.points[name];
        assert.ok(p.x > 200 && p.x < 760 && p.y > 50 && p.y < 500, `${demo.id}: ${name} stays in shot`);
        assert.equal(p.confidence, 0.96);
        if (index) assert.ok(length(p, demo.frames[index - 1].points[name]) < 15, `${demo.id}: ${name} has no one-frame jump`);
      }
      assert.deepEqual(data.poseAt(demo.id, frame.time).points, frame.points);
    }
  }
});

test('squats keep both feet planted and thigh and shank lengths fixed', () => {
  const demo = data.demos.squat;
  for (const frame of demo.frames) for (const side of ['left', 'right']) {
    const p = frame.points;
    assert.deepEqual(p[side + 'Ankle'], demo.frames[0].points[side + 'Ankle']);
    close(length(p[side + 'Hip'], p[side + 'Knee']), 95);
    close(length(p[side + 'Knee'], p[side + 'Ankle']), 95);
  }
  const upright = demo.frames[0].points, bottom = demo.frames[30].points;
  assert.ok(bottom.leftHip.y - upright.leftHip.y > 50);
  assert.ok(bottom.leftHip.x < upright.leftHip.x);
  assert.ok(bottom.leftShoulder.x - bottom.leftHip.x > upright.leftShoulder.x - upright.leftHip.x + 25);
});

test('arm curls keep the elbows and feet still and rotate fixed-length forearms', () => {
  const demo = data.demos.arm;
  for (const frame of demo.frames) for (const side of ['left', 'right']) {
    const p = frame.points, initial = demo.frames[0].points;
    assert.deepEqual(p[side + 'Elbow'], initial[side + 'Elbow']);
    assert.deepEqual(p[side + 'Ankle'], initial[side + 'Ankle']);
    close(length(p[side + 'Shoulder'], p[side + 'Elbow']), 80);
    close(length(p[side + 'Elbow'], p[side + 'Wrist']), 78);
  }
});

test('swing shifts weight before the hands accelerate and keeps a common bat grip', () => {
  const demo = data.demos.swing;
  const result = core.analyse(demo.frames, { ...demo.options, smoothingWindow: 1 });
  const hipPeak = result.frames.reduce((best, frame) => Math.abs(frame.hipVelocity || 0) > Math.abs(best.hipVelocity || 0) ? frame : best);
  const shoulderPeak = result.frames.reduce((best, frame) => Math.abs(frame.shoulderVelocity || 0) > Math.abs(best.shoulderVelocity || 0) ? frame : best);
  assert.ok(hipPeak.timeSeconds < shoulderPeak.timeSeconds);
  const centre = (p, joint) => ({ x: (p['left' + joint].x + p['right' + joint].x) / 2, y: (p['left' + joint].y + p['right' + joint].y) / 2 });
  assert.ok(centre(demo.frames[75].points, 'Hip').x > centre(demo.frames[25].points, 'Hip').x + 25);
  for (const frame of demo.frames) {
    const p = frame.points, shoulder = centre(p, 'Shoulder'), hip = centre(p, 'Hip');
    assert.ok(shoulder.y < hip.y - 115);
    assert.ok(Math.abs(shoulder.x - hip.x) < 25);
    assert.ok(length(p.leftWrist, p.rightWrist) < 9);
    assert.ok(length(p.leftWrist, p.rightWrist) > 4);
    for (const side of ['left', 'right']) assert.ok(length(p[side + 'Ankle'], demo.frames[0].points[side + 'Ankle']) <= 5.000001);
  }
});

test('renderer works as an offline classic script and only draws complete poses', () => {
  const sandbox = vm.createContext({});
  for (const filename of ['demo-data.js', 'demo-renderer.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', filename), 'utf8'), sandbox);
  assert.equal(vm.runInContext('typeof MotionDemoRenderer.draw', sandbox), 'function');
  let saved = 0, restored = 0, shapes = 0;
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, { get(_target, key) {
    if (key === 'createLinearGradient') return () => gradient;
    if (key === 'save') return () => saved++;
    if (key === 'restore') return () => restored++;
    if (key === 'fill' || key === 'fillRect') return () => shapes++;
    return () => {};
  }, set() { return true; } });
  assert.equal(renderer.draw(context, { points: {} }), false);
  assert.equal(shapes, 0);
  for (const id of Object.keys(data.demos)) {
    const pose = data.poseAt(id, 1.5);
    assert.equal(renderer.draw(context, { points: pose.points, demoId: id, time: 1.5, width: 960, height: 540 }), true);
  }
  assert.ok(shapes > 0, 'a complete pose produces visible drawing');
  assert.equal(saved, restored, 'canvas state does not leak into measurement overlays');
});
