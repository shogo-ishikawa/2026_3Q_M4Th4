/**
 * Corrected SPH radial diffusion benchmark — NOT the 3-D PipeSPH solver.
 *
 * Fully developed axisymmetric pipe flow has zero radial velocity. Fixed
 * radial particles therefore carry only the evolving axial velocity:
 *   du/ds = u_rr + u_r/r + 8,  0 < r < 1,
 *   u_r(0)=0, u(1)=0, s=nu*t/R^2, u measured in a target mean velocity.
 *
 * Cubic-spline SPH kernel gradients and a Brookshaw pair Laplacian estimate
 * the two spatial derivatives. A 2-by-2 Taylor-moment correction removes
 * their finite-neighbour consistency error. It contains NO analytic target
 * profile or relaxation force. Symmetric axis ghosts and antisymmetric wall
 * ghosts impose the two boundary conditions. Their boundary truncation error
 * remains visible in the resolution study.
 *
 * This is a kernel-collocation / consistency-corrected SPH diffusion model;
 * it is not an exactly pairwise momentum-conserving 3-D hydrodynamic scheme.
 * The continuum steady parabola is used ONLY in diagnostics and tests.
 */

const MIN_PARTICLES = 8;
const MAX_PARTICLES = 192;

function validateCount(value) {
  if (!Number.isInteger(value) || value < MIN_PARTICLES || value > MAX_PARTICLES) {
    throw new RangeError(`Radial particle count must be an integer from ${MIN_PARTICLES} to ${MAX_PARTICLES}.`);
  }
  return value;
}

function gradientAtI(delta, h) {
  const q = Math.abs(delta) / h;
  if (q >= 2 || q === 0) return 0;
  // d W(r_i-r_j) / d r_i, a positive number for a neighbour to the right.
  const derivative = q < 1 ? -2 * q + 1.5 * q * q : -0.5 * (2 - q) ** 2;
  return -Math.sign(delta) * derivative / (h * h);
}

export class RadialSPH {
  constructor({ particles = 32 } = {}) {
    this.count = validateCount(particles);
    this.method = 'sph';
    this.reset();
  }

  setResolution(particles) {
    const count = validateCount(particles);
    this.count = count;
    return this.reset();
  }

  reset() {
    const n = this.count;
    this.time = 0;
    this.totalSubsteps = 0;
    this.lastSubsteps = 0;
    this.dx = 1 / n;
    this.h = 1.2 * this.dx;
    this.r = Float64Array.from({ length: n }, (_, i) => (i + 0.5) * this.dx);
    this.u = new Float64Array(n); // Initial rest, independent of the steady solution.
    this._next = new Float64Array(n);
    this.weights = Float64Array.from({ length: n }, (_, i) => ((i + 1) ** 2 - i ** 2) * this.dx ** 2);
    this._assembleOperator();
    return this;
  }

  _assembleOperator() {
    const n = this.count, dx = this.dx, h = this.h;
    this._rows = new Array(n);
    let greatestLoss = 0;
    this.minOffDiagonal = Infinity;
    const radius = Math.ceil(2 * h / dx);
    for (let i = 0; i < n; i++) {
      const entries = [];
      let m11 = 0, m12 = 0, m21 = 0, m22 = 0;
      for (let virtual = i - radius; virtual <= i + radius; virtual++) {
        if (virtual === i) continue;
        const delta = (virtual - i) * dx;
        const gradient = gradientAtI(delta, h);
        if (gradient === 0) continue;
        const laplacian = 2 * gradient / delta;
        // All original and ghost particles use the same 1-D quadrature dx.
        m11 += dx * delta * gradient;
        m12 += dx * 0.5 * delta * delta * gradient;
        m21 += dx * delta * laplacian;
        m22 += dx * 0.5 * delta * delta * laplacian;
        let j = virtual, sign = 1;
        if (virtual < 0) j = -virtual - 1; // Even reflection at r=0.
        else if (virtual >= n) { j = 2 * n - 1 - virtual; sign = -1; } // Odd at wall.
        entries.push({ j, sign, gradient, laplacian });
      }
      const determinant = m11 * m22 - m12 * m21;
      if (!(determinant > 0)) throw new Error('Singular SPH consistency moment matrix.');
      const row = new Map();
      for (const { j, sign, gradient, laplacian } of entries) {
        const first = dx * (m22 * gradient - m12 * laplacian) / determinant;
        const second = dx * (-m21 * gradient + m11 * laplacian) / determinant;
        const coefficient = second + first / this.r[i];
        row.set(j, (row.get(j) || 0) + sign * coefficient);
        row.set(i, (row.get(i) || 0) - coefficient);
      }
      // Floating-point cancellation may leave tiny zeros; do not change the operator.
      const indices = Int32Array.from(row.keys());
      const coefficients = Float64Array.from(row.values());
      for (let k = 0; k < indices.length; k++) {
        if (indices[k] !== i) this.minOffDiagonal = Math.min(this.minOffDiagonal, coefficients[k]);
      }
      this._rows[i] = { indices, coefficients };
      greatestLoss = Math.max(greatestLoss, -(row.get(i) || 0));
    }
    if (!(greatestLoss > 0) || this.minOffDiagonal < -1e-9) {
      throw new Error('SPH diffusion stencil failed the non-negative-neighbour check.');
    }
    // Each explicit update is a convex diffusion combination, plus source 8.
    this.maxTimeStep = 0.85 / greatestLoss;
  }

  diffusion(values = this.u) {
    if (!values || values.length !== this.count) throw new RangeError('Velocity array has the wrong particle count.');
    const result = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const { indices, coefficients } = this._rows[i];
      let sum = 0;
      for (let k = 0; k < indices.length; k++) sum += coefficients[k] * values[indices[k]];
      result[i] = sum;
    }
    return result;
  }

  step(ds) {
    if (!Number.isFinite(ds) || ds < 0) throw new RangeError('Viscous time step must be finite and non-negative.');
    if (ds === 0) return this;
    // The UI may request a macroscopic interval. Actual updates stay below CFL.
    const steps = Math.ceil(ds / this.maxTimeStep);
    const dt = ds / steps;
    this.lastSubsteps = steps;
    for (let step = 0; step < steps; step++) {
      for (let i = 0; i < this.count; i++) {
        const { indices, coefficients } = this._rows[i];
        let acceleration = 8;
        for (let k = 0; k < indices.length; k++) acceleration += coefficients[k] * this.u[indices[k]];
        const value = this.u[i] + dt * acceleration;
        if (!Number.isFinite(value)) throw new Error('Radial SPH diffusion became non-finite.');
        this._next[i] = value;
      }
      const old = this.u;
      this.u = this._next;
      this._next = old;
    }
    this.time += ds;
    this.totalSubsteps += steps;
    return this;
  }

  sample() {
    return Array.from(this.r, (r, i) => ({ r, u: this.u[i], weight: this.weights[i] }));
  }

  mesh() {
    return Array.from(this.r);
  }

  _wallSlope() {
    const n = this.count;
    // Quadratic derivative reconstructed from the final three fluid particles.
    // No steady-profile value enters this calculation.
    const xs = [this.r[n - 3], this.r[n - 2], this.r[n - 1]];
    const ys = [this.u[n - 3], this.u[n - 2], this.u[n - 1]];
    let derivative = 0;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3, k = (i + 2) % 3;
      derivative += ys[i] * (2 - xs[j] - xs[k]) / ((xs[i] - xs[j]) * (xs[i] - xs[k]));
    }
    return derivative;
  }

  diagnostics() {
    let meanU = 0, error2 = 0, reference2 = 0, steadyError = 0, maxU = 0;
    const rates = this.diffusion();
    let meanRate = 0;
    for (let i = 0; i < this.count; i++) {
      const reference = 2 * (1 - this.r[i] ** 2);
      const error = this.u[i] - reference, weight = this.weights[i];
      meanU += weight * this.u[i];
      error2 += weight * error * error;
      reference2 += weight * reference * reference;
      steadyError = Math.max(steadyError, Math.abs(error));
      maxU = Math.max(maxU, Math.abs(this.u[i]));
      meanRate += weight * (rates[i] + 8);
    }
    const wallSlope = this._wallSlope();
    const centerU = (9 * this.u[0] - this.u[1]) / 8;
    return {
      method: this.method, time: this.time, count: this.count,
      meanU, centerU, wallSlope, maxU,
      fRe: meanU > 1e-12 ? 16 * Math.abs(wallSlope) / meanU : null,
      l2Error: Math.sqrt(error2 / reference2), steadyError,
      maxTimeStep: this.maxTimeStep, substeps: this.lastSubsteps,
      totalSubsteps: this.totalSubsteps,
      momentumBalanceResidual: meanRate - (8 + 2 * wallSlope),
      stable: Array.from(this.u).every(Number.isFinite),
      kernel: 'cubic B-spline; gradient and Brookshaw Laplacian',
      correction: '2x2 Taylor-moment consistency correction',
      boundary: 'axis-even and wall-odd ghost particles',
      targetRelaxation: false, syntheticVortices: false,
      exactPairMomentumConservation: false,
      geometry: '1-D radial reduction of fully developed axisymmetric pipe flow',
    };
  }
}
