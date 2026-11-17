/**
 * Circular-pipe reference relations (Darcy friction factor, not Fanning).
 * These are independent of the particle simulation and are not SPH measurements.
 */

export const PIPE = Object.freeze({D: 0.02, L: 1, rho: 998, nu: 1.004e-6});
export const TRANSITION = Object.freeze({start: 2300, end: 4000});

function positiveRe(re) {
  if (!Number.isFinite(re) || re <= 0) throw new RangeError('Re must be finite and positive');
}

function transitionWeight(re) {
  const x = Math.max(0, Math.min(1,
    (Math.log(re) - Math.log(TRANSITION.start)) /
    (Math.log(TRANSITION.end) - Math.log(TRANSITION.start))));
  return x * x * (3 - 2 * x);
}

/** Solve Colebrook–White by bracketing s = 1 / sqrt(f). */
export function colebrook(re, roughness = 0) {
  positiveRe(re);
  if (!Number.isFinite(roughness) || roughness < 0 || roughness >= 1) {
    throw new RangeError('Relative roughness must lie in [0, 1)');
  }
  // g(s) is strictly increasing, so bisection has one unambiguous root.
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 64; i++) {
    const s = (lo + hi) / 2;
    const g = s + 2 * Math.log10(roughness / 3.7 + 2.51 * s / re);
    if (g > 0) hi = s;
    else lo = s;
  }
  const s = (lo + hi) / 2;
  return 1 / (s * s);
}

export function regime(re) {
  positiveRe(re);
  if (re < TRANSITION.start) return 'laminar';
  if (re < TRANSITION.end) return 'transition';
  return 'turbulent';
}

/**
 * Transition is an illustrative interpolation, not a transition prediction.
 * low/high bracket the laminar and extrapolated turbulent reference branches;
 * this band is not a statistical confidence interval or guaranteed bound.
 */
export function friction(re, roughness = 0) {
  const state = regime(re);
  const laminar = 64 / re;
  if (state === 'laminar') {
    return {value: laminar, low: laminar, high: laminar, transition: false};
  }
  const turbulent = colebrook(re, roughness);
  if (state === 'turbulent') {
    return {value: turbulent, low: turbulent, high: turbulent, transition: false};
  }
  const w = transitionWeight(re);
  return {
    value: laminar * (1 - w) + turbulent * w,
    low: Math.min(laminar, turbulent),
    high: Math.max(laminar, turbulent),
    transition: true,
  };
}

/** Fixed water properties/geometry: Re is changed by changing U. SI units. */
export function physical(re) {
  positiveRe(re);
  const {D, L, rho, nu} = PIPE;
  const U = re * nu / D;
  const f = friction(re).value;
  const dp = f * (L / D) * rho * U * U / 2;
  const tau = f * rho * U * U / 8;
  const Q = U * Math.PI * D * D / 4;
  return {U, dp, tau, Q, power: dp * Q, f};
}

/**
 * Area-mean-normalized circular-pipe reference profile u/U.
 * r is |radial position| / R, 0..1. The turbulent 1/7 power law is schematic;
 * it does not resolve the viscous sublayer or provide a wall-stress estimate.
 */
export function normalizedProfile(r, re) {
  positiveRe(re);
  if (!Number.isFinite(r)) throw new RangeError('r must be finite');
  r = Math.max(0, Math.min(1, Math.abs(r)));
  const laminar = 2 * (1 - r * r);
  const n = 7;
  const normalization = (n + 1) * (2 * n + 1) / (2 * n * n);
  const turbulent = normalization * Math.pow(1 - r, 1 / n);
  const w = transitionWeight(re);
  return laminar * (1 - w) + turbulent * w;
}
