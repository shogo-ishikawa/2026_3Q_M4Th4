import assert from 'node:assert/strict';
import {colebrook, friction, regime, physical, normalizedProfile, PIPE} from '../dist/physics.js';

const near = (actual, expected, tolerance = 1e-10) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

// Analytic laminar law and the two standard Colebrook benchmarks.
near(friction(1000).value, 0.064);
near(colebrook(1e5), 0.01798977308427384, 1e-12);
near(colebrook(1e5, 0.001), 0.022174535944515076, 1e-12);
for (const re of [2300, 4000, 10000, 100000]) {
  for (const roughness of [0, 0.001, 0.05]) {
    const f = colebrook(re, roughness);
    const residual = 1 / Math.sqrt(f) + 2 * Math.log10(roughness / 3.7 + 2.51 / (re * Math.sqrt(f)));
    near(residual, 0, 1e-12);
  }
}

assert.equal(regime(2299), 'laminar');
assert.equal(regime(2300), 'transition');
assert.equal(regime(3999), 'transition');
assert.equal(regime(4000), 'turbulent');
for (const re of [2300, 2500, 3000, 3999]) {
  const f = friction(re);
  assert.ok(f.transition);
  assert.ok(f.low <= f.value && f.value <= f.high);
}
near(friction(2300 - 1e-6).value, friction(2300 + 1e-6).value, 1e-8);
near(friction(4000 - 1e-6).value, friction(4000 + 1e-6).value, 1e-8);

// Pressure balance and the different meanings of f and pressure loss.
for (const re of [100, 1000, 3000, 10000, 100000]) {
  const p = physical(re);
  near(p.U * PIPE.D / PIPE.nu, re, 1e-9);
  near(p.tau * 4 * PIPE.L / PIPE.D, p.dp, 1e-8);
  near(p.power, p.dp * p.Q);
}
assert.ok(friction(10000).value < friction(1000).value);
assert.ok(physical(10000).dp > physical(1000).dp);
near(physical(1000).dp / physical(500).dp, 2);

// Both profiles (and their blend) integrate to the specified area mean U.
const n = 200000;
for (const re of [1000, 3000, 10000]) {
  let areaMean = 0;
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) / n;
    areaMean += 2 * r * normalizedProfile(r, re) / n;
  }
  near(areaMean, 1, 1e-6);
  near(normalizedProfile(1, re), 0);
  assert.ok(normalizedProfile(0, re) > normalizedProfile(0.8, re));
}
assert.throws(() => colebrook(0), RangeError);
assert.throws(() => colebrook(10000, -0.1), RangeError);
assert.throws(() => physical(NaN), RangeError);
console.log('Physics checks passed: correlations, transition continuity, pressure balance, profile normalization.');
