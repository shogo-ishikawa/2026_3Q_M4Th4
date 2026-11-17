import test from 'node:test';
import assert from 'node:assert/strict';
import { RadialSPH } from '../dist/radial-sph.js';

const near = (actual, expected, tolerance = 1e-11) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`
);

test('radial SPH starts at rest with a complete annular quadrature', () => {
  const model = new RadialSPH();
  assert.equal(model.count, 32);
  assert.equal(model.time, 0);
  near(model.sample().reduce((sum, p) => sum + p.weight, 0), 1);
  for (const p of model.sample()) {
    assert.ok(p.r > 0 && p.r < 1);
    assert.equal(p.u, 0);
    assert.ok(p.weight > 0);
  }
  assert.equal(model.diagnostics().fRe, null);
  assert.equal(model.diagnostics().targetRelaxation, false);
  assert.equal(model.diagnostics().syntheticVortices, false);
});

test('kernel moments reproduce the radial Laplacian of a quadratic away from the wall', () => {
  for (const particles of [16, 32, 64]) {
    const model = new RadialSPH({ particles });
    const testProfile = Float64Array.from(model.r, r => 2 * (1 - r * r));
    const derivative = model.diffusion(testProfile);
    // The last two particles see odd no-slip ghosts rather than continuation
    // of this quadratic. That boundary truncation error is deliberately retained.
    for (let i = 0; i < particles - 2; i++) near(derivative[i], -8, 2e-10);
    assert.ok(model.minOffDiagonal >= 0, 'diffusion neighbours have non-negative weights');
  }
});

test('the SPH spatial operator is homogeneous and linear, not a target-profile force', () => {
  const model = new RadialSPH({ particles: 24 });
  const a = Float64Array.from(model.r, r => Math.sin(2 * r) + 0.3);
  const b = Float64Array.from(model.r, r => Math.cos(5 * r) - 0.2);
  const combined = Float64Array.from(a, (value, i) => 1.7 * value - 0.4 * b[i]);
  const da = model.diffusion(a), db = model.diffusion(b), dc = model.diffusion(combined);
  for (let i = 0; i < model.count; i++) near(dc[i], 1.7 * da[i] - 0.4 * db[i], 1e-10);
  assert.deepEqual(model.diffusion(new Float64Array(model.count)), new Float64Array(model.count));
});

test('initial acceleration is the specified pressure-gradient source at every particle', () => {
  const model = new RadialSPH({ particles: 32 });
  const ds = model.maxTimeStep / 2;
  model.step(ds);
  for (const { u } of model.sample()) near(u, 8 * ds);
  near(model.time, ds);
  assert.equal(model.lastSubsteps, 1);
});

test('stable substepping keeps start-up velocities positive and bounded', () => {
  const model = new RadialSPH({ particles: 64 });
  for (let i = 0; i < 25; i++) {
    model.step(0.02);
    for (const { u } of model.sample()) {
      assert.ok(Number.isFinite(u));
      assert.ok(u >= 0);
      assert.ok(u < 2.1);
    }
  }
  near(model.time, 0.5);
  assert.ok(model.lastSubsteps > 1);
  assert.ok(model.diagnostics().meanU > 0.8);
});

test('steady profile and derived Darcy product converge as radial resolution increases', () => {
  const diagnostics = [];
  for (const particles of [16, 32, 64]) {
    const model = new RadialSPH({ particles });
    model.step(3);
    const result = model.diagnostics();
    diagnostics.push(result);
    assert.equal(result.stable, true);
    assert.ok(result.l2Error < 0.003);
    assert.ok(result.wallSlope < 0);
    assert.ok(Math.abs(result.fRe - 64) < 0.4);
  }
  for (let i = 1; i < diagnostics.length; i++) {
    assert.ok(diagnostics[i].l2Error < 0.3 * diagnostics[i - 1].l2Error, 'quadratic spatial convergence');
    assert.ok(Math.abs(diagnostics[i].fRe - 64) < Math.abs(diagnostics[i - 1].fRe - 64));
    assert.ok(diagnostics[i].maxTimeStep < diagnostics[i - 1].maxTimeStep);
  }
  assert.ok(Math.abs(diagnostics.at(-1).centerU - 2) < 0.0003);
  assert.ok(Math.abs(diagnostics.at(-1).meanU - 1) < 0.0003);
  assert.ok(Math.abs(diagnostics.at(-1).fRe - 64) < 0.03);
});

test('reset and resolution changes clear evolved state without accepting invalid input', () => {
  const model = new RadialSPH({ particles: 16 });
  model.step(0.1);
  const time = model.time;
  assert.throws(() => model.setResolution(3), RangeError);
  assert.equal(model.count, 16);
  assert.equal(model.time, time);
  model.reset();
  assert.equal(model.time, 0);
  assert.ok(model.u.every(value => value === 0));
  model.setResolution(64);
  assert.equal(model.count, 64);
  assert.equal(model.sample().length, 64);
  assert.equal(model.mesh().length, 64);
  assert.ok(model.u.every(value => value === 0));
  assert.throws(() => new RadialSPH({ particles: 16.5 }), RangeError);
  assert.throws(() => model.step(-0.1), RangeError);
  assert.throws(() => model.step(NaN), RangeError);
  assert.throws(() => model.diffusion([1, 2]), RangeError);
});

test('start-up mean velocity converges to the independent Fourier-Bessel solution', () => {
  // For the zero-velocity initial condition and constant source 8:
  // <u>(s)=1-32 sum exp(-j_0n^2*s)/j_0n^4, where j_0n are zeros of J0.
  // At s=.1, terms beyond these four contribute less than 2e-13.
  const zeros = [2.404825557695773, 5.520078110286311, 8.653727912911013, 11.791534439014281];
  const time = 0.1;
  const analyticMean = 1 - 32 * zeros.reduce((sum, z) => sum + Math.exp(-z * z * time) / z ** 4, 0);
  const errors = [];
  for (const particles of [32, 64]) {
    const model = new RadialSPH({ particles });
    model.step(time);
    errors.push(Math.abs(model.diagnostics().meanU - analyticMean));
  }
  assert.ok(errors[0] < 0.001);
  assert.ok(errors[1] < 0.00025);
  assert.ok(errors[1] < errors[0] * 0.3);
});
