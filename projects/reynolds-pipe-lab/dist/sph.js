/**
 * PipeSPH — deliberately coarse, browser-scale 3-D SPH teaching experiment.
 * Lengths use D=1, velocity uses U=1; nu=1/Re. The domain is a cylinder
 * of radius .5 and periodic axial length 6. Pressure is weakly compressible
 * SPH with a cubic B-spline kernel. Molecular viscosity uses the Brookshaw
 * pair Laplacian. Locally reflected ghost neighbours supply a no-slip wall.
 *
 * IMPORTANT: model=true additionally applies a mean-profile relaxation and
 * a time-dependent divergence-free cross-sectional vortex acceleration.
 * These are an imposed educational turbulence model, NOT DNS or a prediction
 * of transition. model=false also removes the bulk-velocity feedback and uses
 * only the constant physical driving acceleration 32*nu. Both modes are coarse;
 * wall layers and turbulent scales are unresolved. No friction coefficient
 * is inferred from this calculation. See diagnostics() for actual numerics.
 */

const PI = Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const blend = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

function countLatticeParticles(intervals) {
  const spacing = 1 / intervals, radialLimit = 0.5 - 0.28 * spacing;
  let crossSection = 0;
  for (let iy = -intervals; iy <= intervals; iy++) {
    for (let iz = -intervals; iz <= intervals; iz++) {
      if ((iy * spacing) ** 2 + (iz * spacing) ** 2 <= radialLimit ** 2) crossSection++;
    }
  }
  return crossSection * Math.round(6 / spacing);
}

const preset = (label, intervals) => Object.freeze({
  label, intervals, count: countLatticeParticles(intervals)
});

/** Resolution choices describe actual SPH particles, not decorative tracers. */
export const QUALITY_PRESETS = Object.freeze({
  low: preset('軽量', 5),
  standard: preset('標準', 7),
  high: preset('高密度', 11),
  ultra: preset('最大', 15),
});

export function resolveQuality(quality) {
  if (typeof quality !== 'string' || !Object.hasOwn(QUALITY_PRESETS, quality)) {
    throw new RangeError(`Unknown SPH quality: ${String(quality)}`);
  }
  return QUALITY_PRESETS[quality];
}

export function countQualityParticles(quality = 'standard') {
  return resolveQuality(quality).count;
}

export class PipeSPH {
  constructor({ re = 1000, quality = 'standard', model = true,
    artificialViscosityAlpha = 0.035 } = {}) {
    resolveQuality(quality);
    this.quality = quality;
    this.length = 6;
    this.radius = 0.5;
    this.soundSpeed = 7;
    this._capacity = 0;
    this.setAlpha(artificialViscosityAlpha);
    this.reset(re, model);
  }

  /** Compression stabilization is independent of the molecular nu=1/Re. */
  setAlpha(alpha) {
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha > 0.2) {
      throw new RangeError('Artificial viscosity alpha must be a finite number in [0, 0.2].');
    }
    this.artificialViscosityAlpha = alpha;
    if (this.particles) this._lastMaxStep = this._stableTimeStep();
    return this;
  }

  setArtificialViscosityAlpha(alpha) {
    return this.setAlpha(alpha);
  }

  setRe(re) {
    if (!Number.isFinite(Number(re))) throw new TypeError('Re must be finite.');
    this.re = clamp(Number(re), 100, 100000);
    this.nu = 1 / this.re;
    this.transitionWeight = blend(Math.log(this.re / 2300) / Math.log(4000 / 2300));
    return this;
  }

  setQuality(quality, re = this.re, model = this.model) {
    resolveQuality(quality);
    // Validate before changing the current experiment, including its quality.
    if (!Number.isFinite(Number(re))) throw new TypeError('Re must be finite.');
    this.quality = quality;
    return this.reset(re, model);
  }

  reset(re = this.re, model = this.model) {
    this.setRe(re);
    this.model = Boolean(model);
    this.time = 0;
    this.totalSubsteps = 0;
    this.stable = true;
    this._lastSubsteps = 0;
    this._lastMaxDensityError = 0;
    this._profileForce = 0;
    this._vortexForce = 0;
    this._controlForce = 0;
    this._drive = 32 * this.nu;
    const { intervals } = resolveQuality(this.quality);
    this.spacing = 1 / intervals;
    this.h = 1.12 * this.spacing;
    this.support = 2 * this.h;
    this.mass = this.spacing ** 3;
    this.kernelNorm = 1 / (PI * this.h ** 3);
    this.nx = Math.floor(this.length / this.support);
    this.cellX = this.length / this.nx;
    this.ny = Math.ceil(1 / this.support);
    this.nz = this.ny;
    this.grid = Array.from({ length: this.nx * this.ny * this.nz }, () => []);
    const axialCount = Math.round(this.length / this.spacing);
    this.particles = [];
    // Cartesian lattice clipped to the cylinder; half a spacing separates
    // the first fluid layer from the mathematical wall.
    const radialLimit = this.radius - 0.28 * this.spacing;
    let id = 0;
    for (let iy = -intervals; iy <= intervals; iy++) {
      for (let iz = -intervals; iz <= intervals; iz++) {
        const y = iy * this.spacing, z = iz * this.spacing;
        if (y * y + z * z > radialLimit * radialLimit) continue;
        for (let ix = 0; ix < axialCount; ix++) {
          const x = (ix + 0.5) * this.length / axialCount;
          const r = Math.hypot(y, z);
          const u = this._targetU(r);
          this.particles.push({ id: id++, x, y, z, u, v: 0, w: 0, rho: 1, p: 0 });
        }
      }
    }
    const count = this.particles.length;
    this.ax = new Float64Array(count);
    this.ay = new Float64Array(count);
    this.az = new Float64Array(count);
    this.rawDensity = new Float64Array(count);
    this.restDensity = new Float64Array(count);
    this._reserve(count * 90);
    this._buildPairs();
    // Per-particle quadrature calibration removes the fixed coarse-lattice
    // boundary density bias. Its values travel with the material particles.
    for (let i = 0; i < count; i++) this.restDensity[i] = this.rawDensity[i];
    // Keep the continuum initial profile exactly. The equal-particle sample
    // mean differs from the true area mean near a coarsely sampled wall; using
    // it to renormalize velocities would distort even the analytic centre u=2.
    this._updateDensity();
    this._lastMaxStep = this._stableTimeStep();
    this._lastTimeStep = 0;
    return this;
  }

  _targetU(r) {
    const q = clamp(r / this.radius, 0, 1);
    const laminar = 2 * (1 - q * q);
    if (!this.model) return laminar;
    const turbulent = (60 / 49) * Math.pow(1 - q, 1 / 7);
    return laminar + this.transitionWeight * (turbulent - laminar);
  }

  _reserve(size) {
    if (size <= this._capacity) return;
    this._capacity = Math.ceil(size * 1.2);
    this.pairI = new Int32Array(this._capacity);
    this.pairJ = new Int32Array(this._capacity);
    this.pairX = new Float32Array(this._capacity);
    this.pairY = new Float32Array(this._capacity);
    this.pairZ = new Float32Array(this._capacity);
    this.pairG = new Float32Array(this._capacity);
    this.pairR2 = new Float32Array(this._capacity);
    this.pairGhost = new Uint8Array(this._capacity);
  }

  _kernel(r) {
    const q = r / this.h;
    return this.kernelNorm * (q < 1 ? 1 - 1.5 * q * q + 0.75 * q ** 3 : 0.25 * (2 - q) ** 3);
  }

  _gradientOverR(r) {
    if (r < 1e-10) return 0;
    const q = r / this.h;
    const dw = q < 1 ? -3 * q + 2.25 * q * q : -0.75 * (2 - q) ** 2;
    return this.kernelNorm * dw / (this.h * r);
  }

  _addPair(i, j, dx, dy, dz, r2, ghost) {
    const k = this.pairCount++;
    if (k >= this._capacity) throw new Error('SPH neighbour capacity exceeded.');
    const r = Math.sqrt(r2);
    this.pairI[k] = i; this.pairJ[k] = j;
    this.pairX[k] = dx; this.pairY[k] = dy; this.pairZ[k] = dz;
    this.pairR2[k] = r2;
    this.pairG[k] = this._gradientOverR(r);
    this.pairGhost[k] = ghost ? 1 : 0;
    const density = this.mass * this._kernel(r);
    this.rawDensity[i] += density;
    if (!ghost) this.rawDensity[j] += density;
  }

  _buildPairs() {
    for (const bucket of this.grid) bucket.length = 0;
    const ps = this.particles, n = ps.length;
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      const cx = Math.min(this.nx - 1, Math.floor(p.x / this.cellX));
      const cy = clamp(Math.floor((p.y + 0.5) / this.support), 0, this.ny - 1);
      const cz = clamp(Math.floor((p.z + 0.5) / this.support), 0, this.nz - 1);
      this.grid[(cx * this.ny + cy) * this.nz + cz].push(i);
    }
    this.pairCount = 0;
    this.rawDensity.fill(this.mass * this.kernelNorm);
    const cut2 = this.support * this.support;
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      const cx = Math.min(this.nx - 1, Math.floor(p.x / this.cellX));
      const cy = clamp(Math.floor((p.y + 0.5) / this.support), 0, this.ny - 1);
      const cz = clamp(Math.floor((p.z + 0.5) / this.support), 0, this.nz - 1);
      const radial = Math.hypot(p.y, p.z);
      const nearWall = radial > this.radius - this.support;
      const normalY = radial > 1e-10 ? p.y / radial : 0;
      const normalZ = radial > 1e-10 ? p.z / radial : 0;
      for (let ox = -1; ox <= 1; ox++) {
        const bx = (cx + ox + this.nx) % this.nx;
        for (let by = Math.max(0, cy - 1); by <= Math.min(this.ny - 1, cy + 1); by++) {
          for (let bz = Math.max(0, cz - 1); bz <= Math.min(this.nz - 1, cz + 1); bz++) {
            const bucket = this.grid[(bx * this.ny + by) * this.nz + bz];
            for (let b = 0; b < bucket.length; b++) {
              const j = bucket[b], q = ps[j];
              let dx = p.x - q.x;
              if (dx > 3) dx -= 6;
              else if (dx < -3) dx += 6;
              const dy = p.y - q.y, dz = p.z - q.z;
              const r2 = dx * dx + dy * dy + dz * dz;
              if (r2 >= cut2) continue;
              if (j > i) this._addPair(i, j, dx, dy, dz, r2, false);
              if (nearWall) {
                // Reflect j across i's local tangent wall plane. A virtual
                // particle has opposite velocity, imposing zero wall velocity.
                const reflection = 2 * (this.radius - normalY * q.y - normalZ * q.z);
                const gy = dy - reflection * normalY;
                const gz = dz - reflection * normalZ;
                const gr2 = dx * dx + gy * gy + gz * gz;
                if (gr2 < cut2) this._addPair(i, j, dx, gy, gz, gr2, true);
              }
            }
          }
        }
      }
    }
  }

  _updateDensity() {
    let maxError = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.rho = this.rawDensity[i] / this.restDensity[i];
      maxError = Math.max(maxError, Math.abs(p.rho - 1));
      // Linear equation of state with a small negative-pressure limit to
      // suppress tensile clumping in this coarse, low-Mach teaching solver.
      p.p = this.soundSpeed ** 2 * clamp(p.rho - 1, -0.015, 0.7);
    }
    this._lastMaxDensityError = maxError;
  }

  step(dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    dt = Math.min(dt, 0.05);
    const maxStep = this._stableTimeStep();
    const steps = Math.ceil(dt / maxStep);
    const subdt = dt / steps;
    this._lastSubsteps = steps;
    this._lastMaxStep = maxStep;
    this._lastTimeStep = subdt;
    for (let s = 0; s < steps; s++) this._substep(subdt);
  }

  _stableTimeStep() {
    let maxSpeed = 0;
    for (const p of this.particles) maxSpeed = Math.max(maxSpeed, Math.hypot(p.u, p.v, p.w));
    const acoustic = 0.2 * this.h / (this.soundSpeed + maxSpeed);
    // Include a conservative estimate of compression-stabilization diffusion
    // as well as molecular viscosity. The acoustic limit scales with h; the
    // viscous limit scales with h², so more particles cannot reuse a coarse dt.
    const numericalNu = 0.1 * this.artificialViscosityAlpha * this.soundSpeed * this.h;
    const viscous = 0.125 * this.h * this.h / (this.nu + numericalNu);
    return Math.min(0.0028, acoustic, viscous);
  }

  _substep(dt) {
    this._buildPairs();
    this._updateDensity();
    const ps = this.particles, n = ps.length;
    let mean = 0;
    for (const p of ps) mean += p.u;
    mean /= n;
    // 32*nu is the prescribed physical pressure-gradient acceleration for the
    // continuum Poiseuille solution with D=U_target=1. SPH-only adds no velocity
    // controller. Education mode retains an explicitly separate sample-mean
    // controller; this equal-particle mean is not an exact cross-sectional mean.
    const nominalDrive = 32 * this.nu;
    this._controlForce = this.model ? 0.9 * (1 - mean) : 0;
    this._drive = nominalDrive + this._controlForce;
    this.ax.fill(this._drive); this.ay.fill(0); this.az.fill(0);
    let profileSquared = 0, vortexSquared = 0;
    const tw = this.model ? this.transitionWeight : 0;
    for (let k = 0; k < this.pairCount; k++) {
      const i = this.pairI[k], j = this.pairJ[k];
      const a = ps[i], b = ps[j], ghost = this.pairGhost[k];
      const grad = this.pairG[k];
      const dx = this.pairX[k], dy = this.pairY[k], dz = this.pairZ[k];
      const ri = Math.max(0.5, a.rho), rj = Math.max(0.5, b.rho);
      const pressure = -this.mass * (a.p / (ri * ri) + b.p / (rj * rj)) * grad;
      const lap = 2 * this.nu * this.mass * grad * this.pairR2[k]
        / (ri * rj * (this.pairR2[k] + 0.01 * this.h * this.h));
      const du = a.u - (ghost ? -b.u : b.u);
      const dv = a.v - (ghost ? -b.v : b.v);
      const dw = a.w - (ghost ? -b.w : b.w);
      // Monaghan approaching-pair artificial viscosity is restricted to
      // compression and explicitly reported, for acoustic stability.
      const approach = du * dx + dv * dy + dw * dz;
      const artificial = approach < 0
        ? this.artificialViscosityAlpha * this.soundSpeed * this.h * approach
          / (this.pairR2[k] + 0.01 * this.h * this.h)
        : 0;
      const stabilise = this.mass * artificial * grad / ((ri + rj) * 0.5);
      const fx = (pressure + stabilise) * dx + lap * du;
      const fy = (pressure + stabilise) * dy + lap * dv;
      const fz = (pressure + stabilise) * dz + lap * dw;
      this.ax[i] += fx; this.ay[i] += fy; this.az[i] += fz;
      if (!ghost) { this.ax[j] -= fx; this.ay[j] -= fy; this.az[j] -= fz; }
    }

    for (let i = 0; i < n; i++) {
      const p = ps[i], r = Math.hypot(p.y, p.z);
      if (this.model) {
        const relax = 1.8 * (this._targetU(r) - p.u);
        this.ax[i] += relax;
        profileSquared += relax * relax;
        // Cross-sectional curl of a smooth streamfunction. The envelope and
        // its derivative vanish at the wall; this is imposed forcing.
        const e = Math.max(0, 1 - 4 * r * r);
        const env = e * e;
        const deY = -16 * p.y * e, deZ = -16 * p.z * e;
        const phase1 = 2 * PI * p.x / 3 - 1.1 * this.time;
        const phase2 = 2 * PI * p.x / 2 + 0.7 * this.time;
        const sy = Math.sin(7 * p.y + 0.6 * this.time);
        const sz = Math.sin(6 * p.z - 0.4 * this.time);
        const cy = Math.cos(7 * p.y + 0.6 * this.time);
        const cz = Math.cos(6 * p.z - 0.4 * this.time);
        const a1 = Math.sin(phase1), a2 = 0.65 * Math.cos(phase2);
        const f = a1 * sy * sz + a2 * Math.cos(5 * p.y - 3 * p.z + this.time * 0.35);
        const dfY = a1 * 7 * cy * sz - a2 * 5 * Math.sin(5 * p.y - 3 * p.z + this.time * 0.35);
        const dfZ = a1 * 6 * sy * cz + a2 * 3 * Math.sin(5 * p.y - 3 * p.z + this.time * 0.35);
        const amp = 0.16 * tw;
        const fy = amp * (deZ * f + env * dfZ);
        const fz = -amp * (deY * f + env * dfY);
        this.ay[i] += fy - 0.65 * p.v;
        this.az[i] += fz - 0.65 * p.w;
        vortexSquared += fy * fy + fz * fz;
      }
      p.u += dt * this.ax[i]; p.v += dt * this.ay[i]; p.w += dt * this.az[i];
      p.x = ((p.x + dt * p.u) % this.length + this.length) % this.length;
      p.y += dt * p.v; p.z += dt * p.w;
      const nextR = Math.hypot(p.y, p.z);
      const safetyRadius = this.radius - 0.025 * this.spacing;
      if (nextR > safetyRadius) {
        const ny = p.y / nextR, nz = p.z / nextR;
        p.y = ny * safetyRadius; p.z = nz * safetyRadius;
        const outward = Math.max(0, p.v * ny + p.w * nz);
        p.v -= 1.25 * outward * ny; p.w -= 1.25 * outward * nz;
        // A fallback confinement collision: tangential velocity is damped.
        p.u *= 0.9;
      }
      if (!Number.isFinite(p.x + p.y + p.z + p.u + p.v + p.w + p.rho)) {
        this.stable = false;
        throw new Error('SPH integration became non-finite; reset the experiment.');
      }
    }
    this._profileForce = Math.sqrt(profileSquared / n);
    this._vortexForce = Math.sqrt(vortexSquared / n);
    this.time += dt;
    this.totalSubsteps++;
  }

  diagnostics() {
    const ps = this.particles, n = ps.length;
    let meanU = 0, transverse2 = 0, maxSpeed = 0, meanRho = 0;
    for (const p of ps) {
      meanU += p.u;
      transverse2 += p.v * p.v + p.w * p.w;
      meanRho += p.rho;
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.u, p.v, p.w));
    }
    return {
      time: this.time, count: n, meanU: meanU / n, quality: this.quality,
      particleMeanU: meanU / n, targetMeanU: 1, bulkScale: 1,
      initialMeanRenormalized: false,
      rmsTransverse: Math.sqrt(transverse2 / n),
      densityError: this._lastMaxDensityError, meanDensity: meanRho / n,
      maxSpeed, stable: this.stable, substeps: this._lastSubsteps,
      totalSubsteps: this.totalSubsteps, model: this.model, re: this.re,
      maxTimeStep: this._lastMaxStep, timeStep: this._lastTimeStep,
      nominalNu: this.nu, h: this.h, spacing: this.spacing,
      soundSpeed: this.soundSpeed, artificialViscosityAlpha: this.artificialViscosityAlpha,
      profileRelaxation: this.model ? 1.8 : 0,
      transverseDamping: this.model ? 0.65 : 0,
      profileForceRMS: this._profileForce, vortexForceRMS: this._vortexForce,
      physicalDrive: 32 * this.nu, controlForce: this._controlForce,
      driveAcceleration: this._drive, transitionWeight: this.transitionWeight,
      geometry: '3-D periodic cylinder, D=1, L=6',
      frictionIsMeasured: false
    };
  }
}
