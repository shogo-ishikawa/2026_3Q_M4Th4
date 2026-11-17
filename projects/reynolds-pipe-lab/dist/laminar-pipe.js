/**
 * Symmetry-reduced SPH for fully developed laminar flow in a circular pipe.
 *
 * This is a different physical model from the free 3-D WCSPH experiment:
 * u=u(r,t), v_r=v_theta=0 are assumptions, not a stabilizing force. Density
 * and acoustic pressure are not evolved. A corrected radial SPH operator
 * solves axial viscous diffusion under a constant pressure-gradient source.
 * No analytic-profile relaxation, imposed vortices, or bulk feedback occurs.
 *
 * D=U_target=1, R=.5, nu=1/Re. The radial solver uses q=r/R and viscous time
 * theta=nu*t/R^2=4 t_star/Re. Its numerical velocity is interpolated to visible
 * material tracers, which advect through the periodic displayed pipe. Those
 * tracers are not additional computational SPH particles.
 */

import {RadialSPH} from './radial-sph.js';
import {resolveQuality} from './sph.js';

export const LAMINAR_RESOLUTIONS=Object.freeze({low:16,standard:32,high:64,ultra:128});

function validateRe(value){
  const re=Number(value);
  if(!Number.isFinite(re)||re<100||re>=2300) throw new RangeError('Laminar SPH requires 100 ≤ Re < 2300.');
  return re;
}

function validateInitial(value){
  if(value!=='steady'&&value!=='rest') throw new RangeError('Initial condition must be steady or rest.');
  return value;
}

export class LaminarPipeSPH{
  constructor({re=500,quality='standard',initial='steady',artificialViscosityAlpha=.035}={}){
    resolveQuality(quality);
    this.quality=quality;
    this.initialCondition=validateInitial(initial);
    this.radius=.5;
    this.length=6;
    this.engineKind='axisymmetric-sph';
    this.symmetryReduced=true;
    this.model=false;
    this.setAlpha(artificialViscosityAlpha);
    this.reset(re,false);
  }

  /** Retains the UI setting for switching back to 3-D; it is not used here. */
  setAlpha(alpha){
    if(typeof alpha!=='number'||!Number.isFinite(alpha)||alpha<0||alpha>.2) throw new RangeError('Artificial viscosity alpha must be in [0, 0.2].');
    this.artificialViscosityAlpha=alpha;
    return this;
  }

  setArtificialViscosityAlpha(alpha){return this.setAlpha(alpha)}

  setQuality(quality,re=this.re,model=false){
    resolveQuality(quality);validateRe(re);
    if(model) throw new RangeError('The axisymmetric laminar model has no imposed turbulence option.');
    this.quality=quality;
    return this.reset(re,false);
  }

  reset(re=this.re,model=false){
    re=validateRe(re);
    if(model) throw new RangeError('The axisymmetric laminar model has no imposed turbulence option.');
    this.re=re;
    this.nu=1/re;
    this.time=0;
    this.totalSubsteps=0;
    this._lastSubsteps=0;
    this._lastTimeStep=0;
    this.stable=true;
    this.model=false;
    this.transitionWeight=0;
    this.radial=new RadialSPH({particles:LAMINAR_RESOLUTIONS[this.quality]});
    if(this.initialCondition==='steady'){
      // An explicitly declared initial condition, never a later target force.
      for(let i=0;i<this.radial.count;i++) this.radial.u[i]=2*(1-this.radial.r[i]**2);
    }
    this.h=this.radial.h*this.radius;
    this.spacing=this.radial.dx*this.radius;
    this.soundSpeed=null;
    this._lastMaxStep=this.radial.maxTimeStep*re/4;
    this._integral=new Float64Array(this.radial.count);
    this._before=new Float64Array(this.radial.count);
    this.particles=[];
    const {intervals}=resolveQuality(this.quality),spacing=1/intervals;
    const radialLimit=this.radius-.28*spacing,axialCount=Math.round(this.length/spacing);
    let id=0;
    for(let iy=-intervals;iy<=intervals;iy++) for(let iz=-intervals;iz<=intervals;iz++){
      const y=iy*spacing,z=iz*spacing;
      if(y*y+z*z>radialLimit*radialLimit) continue;
      const q=Math.hypot(y,z)/this.radius;
      const interpolation=this._interpolation(q);
      const u=this._interpolate(this.radial.u,interpolation);
      for(let ix=0;ix<axialCount;ix++) this.particles.push({id:id++,x:(ix+.5)*this.length/axialCount,y,z,u,v:0,w:0,rho:1,p:0,_radialInterpolation:interpolation});
    }
    return this;
  }

  _interpolation(q){
    const n=this.radial.count,r=this.radial.r;
    if(q>=1) return {i:n-1,j:n-1,a:0,b:0};
    if(q<=r[0]){
      // Even quadratic reconstruction gives zero derivative at the axis.
      const b=(q*q-r[0]*r[0])/(r[1]*r[1]-r[0]*r[0]);
      return {i:0,j:1,a:1-b,b};
    }
    if(q>=r[n-1]) return {i:n-1,j:n-1,a:(1-q)/(1-r[n-1]),b:0};
    const i=Math.min(n-2,Math.max(0,Math.floor(q/this.radial.dx-.5)));
    const b=(q-r[i])/(r[i+1]-r[i]);
    return {i,j:i+1,a:1-b,b};
  }

  _interpolate(values,{i,j,a,b}){return a*values[i]+b*values[j]}

  /** q is radius normalized by R; this samples the numerical solution only. */
  velocityAtRadius(q){
    if(!Number.isFinite(q)) throw new RangeError('Radius must be finite.');
    return this._interpolate(this.radial.u,this._interpolation(Math.min(1,Math.abs(q))));
  }

  step(dt){
    if(!Number.isFinite(dt)||dt<0) throw new RangeError('Time step must be finite and non-negative.');
    if(dt===0) return this;
    const ds=4*dt/this.re;
    const steps=Math.ceil(ds/this.radial.maxTimeStep),subds=ds/steps;
    this._integral.fill(0);
    // Integrate radial velocities and their time integral. Visible tracers
    // need only one interpolation each, even for a long requested interval.
    for(let k=0;k<steps;k++){
      this._before.set(this.radial.u);
      this.radial.step(subds);
      for(let i=0;i<this.radial.count;i++) this._integral[i]+=.5*(this._before[i]+this.radial.u[i])*subds;
    }
    const physicalTimeFactor=this.re/4;
    for(const p of this.particles){
      p.u=this._interpolate(this.radial.u,p._radialInterpolation);
      const displacement=this._interpolate(this._integral,p._radialInterpolation)*physicalTimeFactor;
      p.x=((p.x+displacement)%this.length+this.length)%this.length;
      if(!Number.isFinite(p.x+p.u)){this.stable=false;throw new Error('Laminar SPH became non-finite.');}
    }
    this.time+=dt;
    this.totalSubsteps+=steps;
    this._lastSubsteps=steps;
    this._lastTimeStep=dt/steps;
    return this;
  }

  sample(){return this.radial.sample()}

  diagnostics(){
    const radial=this.radial.diagnostics(),n=this.particles.length;
    let meanU=0,maxSpeed=0;
    for(const p of this.particles){meanU+=p.u;maxSpeed=Math.max(maxSpeed,Math.abs(p.u));}
    return {
      engineKind:this.engineKind,symmetryReduced:true,model:false,re:this.re,quality:this.quality,
      time:this.time,viscousTime:this.radial.time,count:n,
      displayParticleCount:n,computationalParticleCount:this.radial.count,
      particleMeanU:meanU/n,meanU:meanU/n,areaMeanU:radial.meanU,
      targetMeanU:1,bulkScale:1,initialMeanRenormalized:false,
      initialCondition:this.initialCondition,rmsTransverse:0,
      transverseVelocityAssumedZero:true,densityError:null,meanDensity:null,
      densitySolved:false,pressureSolved:false,maxSpeed,stable:this.stable&&radial.stable,
      substeps:this._lastSubsteps,totalSubsteps:this.totalSubsteps,
      maxTimeStep:this._lastMaxStep,timeStep:this._lastTimeStep,
      nominalNu:this.nu,h:this.h,spacing:this.spacing,soundSpeed:null,
      artificialViscosityAlpha:0,requestedArtificialViscosityAlpha:this.artificialViscosityAlpha,
      artificialViscosityUsed:false,profileRelaxation:0,transverseDamping:0,
      profileForceRMS:0,vortexForceRMS:0,controlForce:0,
      physicalDrive:32*this.nu,driveAcceleration:32*this.nu,transitionWeight:0,
      radialRelativeL2:radial.l2Error,radialMaxError:radial.steadyError,
      radialCenterU:radial.centerU,radialWallSlope:radial.wallSlope,
      wallFRe:radial.fRe,exactPairMomentumConservation:false,
      geometry:'axisymmetric fully developed laminar pipe; 1-D radial SPH with 3-D tracers',
      frictionIsMeasured:false,
    };
  }
}
