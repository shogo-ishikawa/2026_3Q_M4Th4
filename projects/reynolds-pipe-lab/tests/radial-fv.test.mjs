import assert from 'node:assert/strict';
import test from 'node:test';
import {RadialFV, conservativeRadialRemap} from '../dist/radial-fv.js';

const weighted = (faces, u) => Array.from(u).reduce((sum, v, i) => sum + v * (faces[i + 1] ** 2 - faces[i] ** 2), 0);
const near = (a, b, e = 1e-11) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const faces = [0, 0.12, 0.37, 0.55, 0.83, 1];
const changed = [0, 0.08, 0.2, 0.31, 0.48, 0.67, 0.91, 1];

test('conservative remapping keeps constants and total momentum without rescaling', () => {
  const u = new Float64Array(faces.length - 1).fill(2.5);
  const copy = Array.from(u);
  const remapped = conservativeRadialRemap(faces, u, changed);
  for (const value of remapped) near(value, 2.5);
  near(weighted(faces, u), weighted(changed, remapped));
  assert.deepEqual(Array.from(u), copy);
});

test('remapping exactly integrates a linear shell-area profile on another mesh', () => {
  const u = Float64Array.from({length: faces.length - 1}, (_, i) => 1 + 2 * (faces[i + 1] ** 2 + faces[i] ** 2) / 2);
  const remapped = conservativeRadialRemap(faces, u, changed);
  for (let i = 0; i < remapped.length; i++) near(remapped[i], 1 + changed[i] ** 2 + changed[i + 1] ** 2);
  near(weighted(faces, u), weighted(changed, remapped));
});

test('arbitrary positive data remap conservatively on refinement and coarsening', () => {
  const u = Float64Array.from([0.2, 1.4, 0.1, 2.3, 0.001]);
  const remapped = conservativeRadialRemap(faces, u, changed);
  const returned = conservativeRadialRemap(changed, remapped, faces);
  assert.ok(Array.from(remapped).every(x => x >= -1e-13));
  assert.ok(Array.from(returned).every(x => x >= -1e-13));
  near(weighted(faces, u), weighted(changed, remapped));
  near(weighted(faces, u), weighted(faces, returned));
});

for (const method of ['fixed', 'amr', 'moving']) {
  test(`${method}: steady Poiseuille error converges under refinement`, () => {
    let prior = Infinity;
    for (const cells of [16, 32, 64]) {
      const engine = new RadialFV({method, cells});
      engine.step(3);
      const d = engine.diagnostics();
      assert.equal(d.stable, true);
      assert.ok(d.steadyError < prior * 0.4, `${method} ${cells}: ${d.steadyError} vs ${prior}`);
      prior = d.steadyError;
      assert.ok(Math.abs(d.meanU - 1) < 0.005);
      assert.ok(Math.abs(d.fRe - 64) < 0.3);
      assert.ok(d.maxRemapResidual < 1e-12);
      assert.ok(d.maxMomentumResidual < 1e-11);
      const points = engine.sample();
      near(points.reduce((s, p) => s + p.weight, 0), 1);
      near(points.reduce((s, p) => s + p.u * p.weight, 0), d.meanU);
      assert.ok(points.every(p => p.u >= 0 && p.r >= 0 && p.r <= 1));
      near(engine.mesh()[0], 0); near(engine.mesh().at(-1), 1);
    }
  });

  test(`${method}: zero-source rest stays at rest`, () => {
    const engine = new RadialFV({method, cells: 24, source: 0});
    engine.step(0.3);
    assert.deepEqual(Array.from(engine.u), new Array(engine.u.length).fill(0));
    near(engine.diagnostics().integratedMomentum, 0);
    assert.equal(engine.diagnostics().fRe, null);
  });

  test(`${method}: source-free momentum loss is exactly accounted by wall flux`, () => {
    const engine = new RadialFV({method, cells: 24, source: 0});
    engine.reset(() => 1);
    const initialMomentum = engine.diagnostics().meanU;
    engine.step(0.02);
    const d = engine.diagnostics();
    assert.ok(d.meanU < initialMomentum);
    assert.ok(Array.from(engine.u).every(u => u >= 0));
    near(d.meanU - initialMomentum, -0.02 * d.wallFluxOut, 1e-11);
    assert.ok(d.maxMomentumResidual < 1e-11);
  });
}

test('AMR actually refines and coarsens cell volumes', () => {
  const engine = new RadialFV({method: 'amr', cells: 16});
  engine.step(0.3);
  assert.ok(engine.u.length > 16);
  assert.ok(engine.u.length <= 32);
  assert.ok(engine.diagnostics().minWidth < 1 / 16);
  assert.ok(engine.adaptations > 0);
  engine.u.fill(0);
  engine.steps = 5;
  engine._adapt(0.02);
  assert.equal(engine.u.length, 16);
  near(engine.diagnostics().meanU, 0);
});

test('moving mesh changes physical face positions and remaps momentum', () => {
  const engine = new RadialFV({method: 'moving', cells: 16});
  const initialMesh = engine.mesh();
  engine.step(0.4);
  assert.equal(engine.u.length, 16);
  assert.notDeepEqual(engine.mesh(), initialMesh);
  assert.ok(engine.adaptations > 0);
  assert.ok(engine.mesh().every((r, i, a) => i === 0 || r > a[i - 1]));
  assert.ok(engine.diagnostics().maxRemapResidual < 1e-12);
  assert.equal(engine.diagnostics().isTurbulenceSimulation, false);
});

test('reset and resolution changes are deterministic and validated', () => {
  const engine = new RadialFV({method: 'amr', cells: 16});
  engine.step(0.2);
  const expected = engine.sample();
  engine.reset(); engine.step(0.2);
  assert.deepEqual(engine.sample(), expected);
  engine.setResolution(32);
  assert.equal(engine.u.length, 32);
  assert.equal(engine.time, 0);
  assert.throws(() => engine.setResolution(2), RangeError);
  assert.equal(engine.u.length, 32);
  assert.throws(() => new RadialFV({method: 'pretend'}), RangeError);
  assert.throws(() => new RadialFV({cells: 2}), RangeError);
  assert.throws(() => new RadialFV({source: -1}), RangeError);
  assert.throws(() => engine.step(-1), RangeError);
  assert.throws(() => engine.step(NaN), RangeError);
  assert.throws(() => conservativeRadialRemap([0, 1, 0.5], [1, 2], [0, 1]), RangeError);
});
