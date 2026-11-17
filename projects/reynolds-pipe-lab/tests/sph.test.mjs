import assert from 'node:assert/strict';
import test from 'node:test';
import { PipeSPH, QUALITY_PRESETS, resolveQuality, countQualityParticles } from '../dist/sph.js';

function advance(engine, duration) {
  const steps = Math.round(duration * 120);
  for (let i = 0; i < steps; i++) engine.step(1 / 120);
}

function assertPhysicalBounds(engine, originalCount) {
  assert.equal(engine.particles.length, originalCount, 'periodic flow must conserve particles');
  for (const p of engine.particles) {
    for (const field of ['x', 'y', 'z', 'u', 'v', 'w', 'rho', 'p']) {
      assert.ok(Number.isFinite(p[field]), `${field} must remain finite`);
    }
    assert.ok(p.x >= 0 && p.x < engine.length, 'axial coordinate must remain periodic');
    assert.ok(Math.hypot(p.y, p.z) <= engine.radius + 1e-12, 'particle must stay inside the pipe');
    assert.ok(p.rho > 0, 'density must remain positive');
  }
  const d = engine.diagnostics();
  assert.equal(d.stable, true);
  assert.ok(d.maxSpeed < 5, 'short-run velocity must remain bounded');
  assert.ok(d.densityError < 0.4, 'short-run density must not diverge');
  assert.equal(d.frictionIsMeasured, false, 'particle diagnostics must not claim a Darcy measurement');
}

test('reset and repeated integration are deterministic', () => {
  const engine = new PipeSPH({ re: 3000, quality: 'low', model: true });
  const initial = structuredClone(engine.particles);
  advance(engine, 0.1);
  const evolved = structuredClone(engine.particles);
  assert.notDeepEqual(evolved, initial, 'SPH particles should actually evolve');
  engine.reset(3000, true);
  assert.deepEqual(engine.particles, initial);
  assert.equal(engine.diagnostics().time, 0);
  advance(engine, 0.1);
  assert.deepEqual(engine.particles, evolved);
  engine.reset(1000, false);
  assert.equal(engine.re, 1000);
  assert.equal(engine.model, false);
  assert.equal(engine.diagnostics().vortexForceRMS, 0);
});

for (const re of [100, 3000, 100000]) {
  for (const model of [false, true]) {
    test(`finite, confined, conserved particles at Re=${re}, model=${model}`, () => {
      const engine = new PipeSPH({ re, quality: 'standard', model });
      const count = engine.particles.length;
      assert.ok(count > 0);
      advance(engine, 0.25);
      assertPhysicalBounds(engine, count);
      assert.ok(Math.abs(engine.diagnostics().time - 0.25) < 1e-10);
    });
  }
}

test('imposed high-Re teaching model produces more cross-pipe motion than laminar flow', () => {
  const laminar = new PipeSPH({ re: 1000, quality: 'standard', model: true });
  const modeled = new PipeSPH({ re: 100000, quality: 'standard', model: true });
  advance(laminar, 0.5);
  advance(modeled, 0.5);
  const low = laminar.diagnostics().rmsTransverse;
  const high = modeled.diagnostics().rmsTransverse;
  assert.ok(high > 0.04, 'the imposed vortex model should visibly mix across the pipe');
  assert.ok(high > 3 * low, `modeled transverse RMS ${high} should exceed laminar RMS ${low}`);
});

test('quality choices describe immutable, actual SPH particle counts', () => {
  assert.ok(Object.isFrozen(QUALITY_PRESETS));
  const expected = { low: 390, standard: 1554, high: 5874, ultra: 15210 };
  for (const [quality, count] of Object.entries(expected)) {
    const preset = resolveQuality(quality);
    assert.ok(Object.isFrozen(preset));
    assert.equal(preset.count, count);
    assert.equal(countQualityParticles(quality), count);
    const engine = new PipeSPH({ quality });
    assert.equal(engine.particles.length, count, 'displayed count must match integrated particles');
    assert.equal(engine.diagnostics().quality, quality);
  }
});

test('changing quality resets the experiment and rejects invalid configurations atomically', () => {
  for (const quality of ['missing', '__proto__', 'constructor', '', 7, null]) {
    assert.throws(() => new PipeSPH({ quality }), RangeError);
    assert.throws(() => resolveQuality(quality), RangeError);
  }
  const engine = new PipeSPH({ quality: 'low', re: 3000, model: false });
  advance(engine, 0.025);
  assert.equal(engine.setQuality('high'), engine);
  assert.equal(engine.quality, 'high');
  assert.equal(engine.particles.length, 5874);
  assert.equal(engine.re, 3000);
  assert.equal(engine.model, false);
  assert.equal(engine.time, 0);
  const particles = engine.particles;
  assert.throws(() => engine.setQuality('missing'), RangeError);
  assert.throws(() => engine.setQuality('ultra', NaN), TypeError);
  assert.equal(engine.quality, 'high');
  assert.equal(engine.particles, particles);
  engine.setQuality('standard', 100, true);
  assert.equal(engine.re, 100);
  assert.equal(engine.model, true);
  assert.equal(engine.particles.length, 1554);
});

test('increasing resolution reduces the acoustic integration timestep', () => {
  let previous = Infinity;
  for (const quality of ['standard', 'high', 'ultra']) {
    const engine = new PipeSPH({ quality, re: 100, model: false });
    engine.step(0.01);
    const d = engine.diagnostics();
    assert.ok(d.maxTimeStep < previous);
    assert.ok(d.maxTimeStep <= 0.0028);
    assert.ok(d.timeStep <= d.maxTimeStep);
    previous = d.maxTimeStep;
  }
});

// Short smoke runs supplement the longer standard-resolution regressions.
// They exercise each finer lattice across both model modes and Re extremes
// without making the browser-source package's test suite expensive to run.
for (const quality of ['high', 'ultra']) {
  for (const re of [100, 3000, 100000]) {
    for (const model of [false, true]) {
      test(`${quality} resolution remains finite and confined at Re=${re}, model=${model}`, () => {
        const engine = new PipeSPH({ quality, re, model });
        const count = countQualityParticles(quality);
        advance(engine, 0.025);
        assertPhysicalBounds(engine, count);
        assert.ok(Math.abs(engine.time - 0.025) < 1e-10);
      });
    }
  }
}

test('all resolutions preserve the independent continuum initial profile without sample renormalization', () => {
  for (const quality of Object.keys(QUALITY_PRESETS)) {
    for (const config of [
      { re: 20000, model: false, turbulent: false },
      { re: 1000, model: true, turbulent: false },
      { re: 100000, model: true, turbulent: true },
    ]) {
      const engine = new PipeSPH({ quality, ...config });
      for (const p of engine.particles) {
        const r = Math.hypot(p.y, p.z) / 0.5;
        const exact = config.turbulent
          ? (60 / 49) * (1 - r) ** (1 / 7)
          : 2 * (1 - r * r);
        assert.ok(Math.abs(p.u - exact) < 1e-13, 'initial particle velocity must equal the analytic value at its position');
      }
      const centre = engine.particles.find(p => p.y === 0 && p.z === 0);
      assert.equal(centre.u, config.turbulent ? 60 / 49 : 2);
      const d = engine.diagnostics();
      assert.equal(d.initialMeanRenormalized, false);
      assert.equal(d.targetMeanU, 1);
      assert.equal(d.bulkScale, 1);
      assert.equal(d.particleMeanU, d.meanU);
      assert.ok(d.particleMeanU > 1, 'a clipped equal-particle sample need not have the continuum area mean');
    }
  }
});

test('SPH-only uses constant physical pressure driving and no sample-mean controller', () => {
  for (const re of [100, 1000, 100000]) {
    const engine = new PipeSPH({ re, model: false, quality: 'low' });
    assert.ok(engine.diagnostics().particleMeanU > 1.2);
    advance(engine, 0.025);
    const d = engine.diagnostics();
    assert.equal(d.physicalDrive, 32 / re);
    assert.equal(d.controlForce, 0);
    assert.equal(d.driveAcceleration, d.physicalDrive);
    assert.equal(d.profileForceRMS, 0);
    assert.equal(d.vortexForceRMS, 0);
  }
  const teaching = new PipeSPH({ re: 1000, model: true, quality: 'low' });
  const initialMean = teaching.diagnostics().particleMeanU;
  teaching.step(1e-5);
  const d = teaching.diagnostics();
  assert.equal(d.controlForce, 0.9 * (1 - initialMean));
  assert.equal(d.driveAcceleration, d.physicalDrive + d.controlForce);
});

test('artificial viscosity is configurable, validated, preserved and distinct from molecular viscosity', () => {
  for (const alpha of [-0.01, 0.21, NaN, Infinity, null, '0.1']) {
    assert.throws(() => new PipeSPH({ artificialViscosityAlpha: alpha }), RangeError);
  }
  const engine = new PipeSPH({ quality: 'low', artificialViscosityAlpha: 0.1 });
  const particles = engine.particles;
  assert.throws(() => engine.setAlpha(-1), RangeError);
  assert.equal(engine.artificialViscosityAlpha, 0.1);
  assert.equal(engine.particles, particles, 'an invalid numerical setting must preserve the experiment');
  assert.equal(engine.setAlpha(0), engine);
  assert.equal(engine.diagnostics().artificialViscosityAlpha, 0);
  engine.reset(3000, false);
  assert.equal(engine.artificialViscosityAlpha, 0);
  engine.setQuality('standard');
  assert.equal(engine.artificialViscosityAlpha, 0);
  assert.equal(engine.setArtificialViscosityAlpha(0.2), engine);
  assert.equal(engine.diagnostics().artificialViscosityAlpha, 0.2);
  assert.equal(engine.nu, 1 / 3000);

  const without = new PipeSPH({ re: 1000, model: false, quality: 'low', artificialViscosityAlpha: 0 });
  const withStabilization = new PipeSPH({ re: 1000, model: false, quality: 'low', artificialViscosityAlpha: 0.2 });
  without.step(0.001);
  withStabilization.step(0.001);
  assert.equal(without.nu, withStabilization.nu);
  const kinetic = e => e.particles.reduce((sum, p) => sum + p.u * p.u + p.v * p.v + p.w * p.w, 0);
  assert.ok(kinetic(withStabilization) < kinetic(without), 'compression stabilization must actually dissipate, rather than only change its label');
});
