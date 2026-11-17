/**
 * Reduced, axisymmetric pipe-flow benchmark.
 *
 * q=r/R, s=nu*t/R^2, velocity scale U_target. The solved equation is
 *   du/ds = (1/q) d(q du/dq)/dq + 8,
 * with u(1)=0 and zero radial derivative at q=0. Its steady solution is
 * 2(1-q^2). This is a genuine one-dimensional viscous diffusion problem;
 * it cannot resolve axial/azimuthal disturbances or turbulence.
 *
 * Cells store shell-volume averaged axial momentum/velocity. Fixed FV uses
 * radial diffusive face fluxes. AMR bisects selected base cells and may coarsen
 * them later. Moving FV continuously redistributes faces with a gradient
 * monitor. The mesh moves radially but the physical radial velocity is zero:
 * conservative overlap remapping supplies the grid-relative transport term.
 * No reference-profile relaxation or turbulent forcing is present.
 */

const METHODS = new Set(['fixed', 'amr', 'moving']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function cellCount(value) {
  if (!Number.isInteger(value) || value < 8 || value > 256) {
    throw new RangeError('Radial cell count must be an integer in [8, 256].');
  }
  return value;
}

function validateFaces(faces) {
  if (!faces || faces.length < 2 || faces[0] !== 0 || faces[faces.length - 1] !== 1) {
    throw new RangeError('Radial faces must span exactly [0, 1].');
  }
  for (let i = 1; i < faces.length; i++) {
    if (!Number.isFinite(faces[i]) || !(faces[i] > faces[i - 1])) {
      throw new RangeError('Radial faces must be finite and strictly increasing.');
    }
  }
}

function uniformFaces(n) {
  return Float64Array.from({ length: n + 1 }, (_, i) => i / n);
}

function shellGeometry(faces) {
  const n = faces.length - 1;
  const area = Float64Array.from(faces, r => r * r);
  const weights = new Float64Array(n), areaCenters = new Float64Array(n), centers = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    weights[i] = area[i + 1] - area[i];
    areaCenters[i] = (area[i + 1] + area[i]) / 2;
    centers[i] = (faces[i + 1] + faces[i]) / 2;
  }
  return { area, weights, areaCenters, centers };
}

function integral(faces, values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i] * (faces[i + 1] ** 2 - faces[i] ** 2);
  return total;
}

function minmod(a, b, c) {
  if (a > 0 && b > 0 && c > 0) return Math.min(a, b, c);
  if (a < 0 && b < 0 && c < 0) return Math.max(a, b, c);
  return 0;
}

/**
 * Conservatively remap shell averages using exact overlap integrals in a=q^2.
 * A piecewise-linear reconstruction has zero cell-mean correction. The limiter
 * controls new extrema while keeping a linear field exact on a smooth mesh.
 */
export function conservativeRadialRemap(oldFaces, oldValues, newFaces) {
  validateFaces(oldFaces); validateFaces(newFaces);
  if (oldValues.length !== oldFaces.length - 1 || !Array.from(oldValues).every(Number.isFinite)) {
    throw new RangeError('One finite shell average is required per old cell.');
  }
  const { area: oa, areaCenters: ac } = shellGeometry(oldFaces);
  const na = Float64Array.from(newFaces, r => r * r);
  const slopes = new Float64Array(oldValues.length);
  const positive = Array.from(oldValues).every(v => v >= 0);
  for (let i = 0; i < slopes.length; i++) {
    if (slopes.length === 1) break;
    const left = i > 0 ? (oldValues[i] - oldValues[i - 1]) / (ac[i] - ac[i - 1]) : null;
    const right = i + 1 < slopes.length ? (oldValues[i + 1] - oldValues[i]) / (ac[i + 1] - ac[i]) : null;
    let slope = left === null ? right : right === null ? left :
      minmod(2 * left, (oldValues[i + 1] - oldValues[i - 1]) / (ac[i + 1] - ac[i - 1]), 2 * right);
    if (positive) {
      const halfWidth = (oa[i + 1] - oa[i]) / 2;
      slope = clamp(slope, -oldValues[i] / halfWidth, oldValues[i] / halfWidth);
    }
    slopes[i] = slope;
  }
  const result = new Float64Array(newFaces.length - 1);
  let j = 0;
  for (let i = 0; i < result.length; i++) {
    while (j + 1 < oldValues.length && oa[j + 1] <= na[i] + 1e-15) j++;
    let k = j, amount = 0;
    while (k < oldValues.length && oa[k] < na[i + 1] - 1e-15) {
      const lo = Math.max(na[i], oa[k]), hi = Math.min(na[i + 1], oa[k + 1]);
      if (hi > lo) amount += oldValues[k] * (hi - lo) +
        0.5 * slopes[k] * ((hi - ac[k]) ** 2 - (lo - ac[k]) ** 2);
      k++;
    }
    result[i] = amount / (na[i + 1] - na[i]);
  }
  return result;
}

function interpolateRadial(faces, values, r) {
  const n = values.length;
  if (r >= 1) return 0;
  let i = 0;
  while (i + 1 < n && (faces[i + 1] + faces[i + 2]) / 2 < r) i++;
  const c = (faces[i] + faces[i + 1]) / 2;
  if (r <= c) return values[i];
  const rightR = i + 1 < n ? (faces[i + 1] + faces[i + 2]) / 2 : 1;
  const rightU = i + 1 < n ? values[i + 1] : 0;
  return values[i] + (rightU - values[i]) * (r - c) / (rightR - c);
}

export class RadialFV {
  constructor({ method = 'fixed', cells = 24, source = 8 } = {}) {
    if (!METHODS.has(method)) throw new RangeError('Method must be fixed, amr, or moving.');
    if (!Number.isFinite(source) || source < 0) throw new RangeError('Source must be finite and nonnegative.');
    this.method = method;
    this.cells = cellCount(cells);
    this.source = source;
    this.reset();
  }

  reset(initial = 'rest') {
    if (initial !== 'rest' && initial !== 'steady' && typeof initial !== 'function') {
      throw new RangeError('Initial condition must be rest, steady, or a radial function.');
    }
    this.faces = uniformFaces(this.cells);
    this._geometry = shellGeometry(this.faces);
    this.u = new Float64Array(this.cells);
    for (let i = 0; i < this.u.length; i++) {
      const a = this._geometry.areaCenters[i];
      const value = initial === 'rest' ? 0 : initial === 'steady' ? this.source / 4 * (1 - a) : initial(Math.sqrt(a));
      if (!Number.isFinite(value)) throw new RangeError('Initial velocities must be finite.');
      this.u[i] = value;
    }
    this.time = 0;
    this.steps = 0;
    this.adaptations = 0;
    this.meshChanged = false;
    this.remapResidual = 0;
    this.maxRemapResidual = 0;
    this.momentumResidual = 0;
    this.maxMomentumResidual = 0;
    this._lastWallFlux = 0;
    this._lastMeshSpeed = 0;
    return this;
  }

  setResolution(cells) {
    this.cells = cellCount(cells);
    return this.reset();
  }

  _monitor() {
    const dense = Math.max(128, this.cells * 4);
    const q = Float64Array.from({ length: dense + 1 }, (_, i) => i / dense);
    const val = Float64Array.from(q, r => interpolateRadial(this.faces, this.u, r));
    const gradient = new Float64Array(dense);
    let max = 0;
    for (let i = 0; i < dense; i++) {
      gradient[i] = Math.abs(val[i + 1] - val[i]) * dense;
      max = Math.max(max, gradient[i]);
    }
    return { q, gradient, max };
  }

  _remesh(newFaces, ds) {
    let maxDisplacement = 0;
    if (newFaces.length === this.faces.length) {
      for (let i = 0; i < newFaces.length; i++) maxDisplacement = Math.max(maxDisplacement, Math.abs(newFaces[i] - this.faces[i]));
      if (maxDisplacement < 1e-11) return;
    }
    const before = integral(this.faces, this.u);
    const newU = conservativeRadialRemap(this.faces, this.u, newFaces);
    const after = integral(newFaces, newU);
    this.remapResidual += after - before;
    this.maxRemapResidual = Math.max(this.maxRemapResidual, Math.abs(after - before));
    this._lastMeshSpeed = ds > 0 ? maxDisplacement / ds : 0;
    this.faces = Float64Array.from(newFaces);
    this.u = newU;
    this._geometry = shellGeometry(this.faces);
    this.meshChanged = true;
    this.adaptations++;
  }

  _adapt(ds) {
    if (this.method === 'fixed') return;
    const m = this._monitor();
    if (m.max < 1e-10) {
      if (this.method === 'amr' && this.steps % 5 === 0) this._remesh(uniformFaces(this.cells), ds);
      if (this.method === 'moving') {
        const uniform = uniformFaces(this.cells), relaxation = 1 - Math.exp(-6 * ds);
        this._remesh(Float64Array.from(this.faces, (r, i) => r + relaxation * (uniform[i] - r)), ds);
      }
      return;
    }
    if (this.method === 'amr') {
      // True one-level dyadic refinement/coarsening of a fixed base mesh.
      // Rebuilding from base intervals permits a previous refined cell to merge.
      if (this.steps % 5 !== 0) return;
      const newFaces = [0];
      for (let i = 0; i < this.cells; i++) {
        const lo = i / this.cells, hi = (i + 1) / this.cells;
        let peak = 0;
        const first = Math.floor(lo * m.gradient.length), last = Math.min(m.gradient.length - 1, Math.ceil(hi * m.gradient.length) - 1);
        for (let j = first; j <= last; j++) peak = Math.max(peak, m.gradient[j]);
        if (peak >= 0.55 * m.max) newFaces.push((lo + hi) / 2);
        newFaces.push(hi);
      }
      this._remesh(newFaces, ds);
    } else {
      // Equidistribute a gradient monitor. Convex relaxation keeps face order.
      const cumulative = new Float64Array(m.q.length);
      for (let i = 0; i < m.gradient.length; i++) {
        cumulative[i + 1] = cumulative[i] + (1 + 3 * Math.sqrt(m.gradient[i] / m.max)) / m.gradient.length;
      }
      const total = cumulative[cumulative.length - 1];
      const newFaces = Float64Array.from(this.faces);
      const relaxation = 1 - Math.exp(-6 * ds);
      let j = 0;
      for (let i = 1; i < this.cells; i++) {
        const target = total * i / this.cells;
        while (j + 1 < cumulative.length && cumulative[j + 1] < target) j++;
        const fraction = (target - cumulative[j]) / (cumulative[j + 1] - cumulative[j]);
        const desired = m.q[j] + fraction * (m.q[j + 1] - m.q[j]);
        newFaces[i] = this.faces[i] + relaxation * (desired - this.faces[i]);
      }
      this._remesh(newFaces, ds);
    }
  }

  step(ds) {
    if (!Number.isFinite(ds) || ds < 0) throw new RangeError('Time increment must be finite and nonnegative.');
    if (ds === 0) return this;
    if (ds > 20) throw new RangeError('A single advance must not exceed 20 viscous time units.');
    const count = Math.max(1, Math.ceil(ds / 0.025));
    const dt = ds / count;
    this.meshChanged = false;
    this.remapResidual = 0;
    for (let j = 0; j < count; j++) {
      const momentumBefore = integral(this.faces, this.u);
      this._adapt(dt);
      const n = this.u.length, { weights, centers } = this._geometry;
      const lower = new Float64Array(n), diagonal = new Float64Array(n), upper = new Float64Array(n), rhs = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const gl = i > 0 ? 2 * this.faces[i] / (centers[i] - centers[i - 1]) : 0;
        const gr = i + 1 < n ? 2 * this.faces[i + 1] / (centers[i + 1] - centers[i]) : 2 / (1 - centers[i]);
        lower[i] = -dt * gl;
        diagonal[i] = weights[i] + dt * (gl + gr);
        upper[i] = i + 1 < n ? -dt * gr : 0;
        rhs[i] = weights[i] * (this.u[i] + dt * this.source);
      }
      // Thomas solve for the backward-Euler conservative diffusion operator.
      for (let i = 1; i < n; i++) {
        const ratio = lower[i] / diagonal[i - 1];
        diagonal[i] -= ratio * upper[i - 1];
        rhs[i] -= ratio * rhs[i - 1];
      }
      const next = new Float64Array(n);
      next[n - 1] = rhs[n - 1] / diagonal[n - 1];
      for (let i = n - 2; i >= 0; i--) next[i] = (rhs[i] - upper[i] * next[i + 1]) / diagonal[i];
      if (!Array.from(next).every(Number.isFinite)) throw new Error('Radial finite-volume state became non-finite.');
      this.u = next;
      this._lastWallFlux = 2 * this.u[n - 1] / (1 - centers[n - 1]);
      const momentumAfter = integral(this.faces, this.u);
      const residual = momentumAfter - momentumBefore - dt * (this.source - this._lastWallFlux);
      this.momentumResidual = residual;
      this.maxMomentumResidual = Math.max(this.maxMomentumResidual, Math.abs(residual));
      this.time += dt;
      this.steps++;
    }
    return this;
  }

  sample() {
    const { areaCenters, weights } = this._geometry;
    return Array.from(this.u, (u, i) => ({ r: Math.sqrt(areaCenters[i]), u, weight: weights[i] }));
  }

  mesh() {
    return Array.from(this.faces);
  }

  diagnostics() {
    const { weights, areaCenters, centers } = this._geometry, n = this.u.length;
    const meanU = integral(this.faces, this.u);
    const slopeArea = n > 1 ? (this.u[1] - this.u[0]) / (areaCenters[1] - areaCenters[0]) : 0;
    const centerU = this.u[0] - slopeArea * areaCenters[0];
    const wallSlope = -this.u[n - 1] / (1 - centers[n - 1]);
    let error2 = 0, maxError = 0, minWidth = Infinity, maxWidth = 0;
    for (let i = 0; i < n; i++) {
      const exactAverage = this.source / 4 * (1 - areaCenters[i]);
      const err = this.u[i] - exactAverage;
      error2 += weights[i] * err * err;
      maxError = Math.max(maxError, Math.abs(err));
      minWidth = Math.min(minWidth, this.faces[i + 1] - this.faces[i]);
      maxWidth = Math.max(maxWidth, this.faces[i + 1] - this.faces[i]);
    }
    const norm = this.source > 0 ? (this.source / 4) ** 2 / 3 : 1;
    const steadyError = Math.sqrt(error2 / norm);
    return {
      method: this.method, time: this.time, count: n, baseCells: this.cells,
      meanU, centerU, wallSlope,
      fRe: meanU > 1e-10 ? 16 * Math.abs(wallSlope) / meanU : null,
      l2Error: steadyError, steadyError, maxError,
      // The error is relative to the steady exact solution, not an exact
      // transient solution. During startup it includes real transient change.
      errorReference: 'steady shell-average Poiseuille solution',
      remapResidual: this.remapResidual,
      maxRemapResidual: this.maxRemapResidual,
      momentumResidual: this.momentumResidual,
      maxMomentumResidual: this.maxMomentumResidual,
      integratedMomentum: meanU, wallFluxOut: this._lastWallFlux,
      adaptations: this.adaptations, meshChanged: this.meshChanged,
      minWidth, maxWidth, maxMeshSpeed: this._lastMeshSpeed,
      stable: Array.from(this.u).every(Number.isFinite),
      source: this.source,
      geometry: '1-D axisymmetric, fully developed circular pipe',
      isTurbulenceSimulation: false,
    };
  }
}
