import test from 'node:test';
import assert from 'node:assert/strict';
import {LaminarPipeSPH,LAMINAR_RESOLUTIONS} from '../dist/laminar-pipe.js';
import {startupProfile,referenceMean} from '../dist/radial-reference.js';

const close=(actual,expected,tolerance=1e-11)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected} within ${tolerance}`);

function relativeError(samples,reference){
  let error=0,norm=0;
  for(const p of samples){const exact=reference(p.r);error+=p.weight*(p.u-exact)**2;norm+=p.weight*exact*exact;}
  return Math.sqrt(error/norm);
}

test('laminar engine distinguishes numerical radial particles from displayed tracers',()=>{
  assert.ok(Object.isFrozen(LAMINAR_RESOLUTIONS));
  const counts={low:390,standard:1554,high:5874,ultra:15210};
  for(const quality of Object.keys(counts)){
    const e=new LaminarPipeSPH({re:500,quality}),d=e.diagnostics();
    assert.equal(e.engineKind,'axisymmetric-sph');
    assert.equal(d.computationalParticleCount,LAMINAR_RESOLUTIONS[quality]);
    assert.equal(d.displayParticleCount,counts[quality]);
    assert.equal(e.particles.length,counts[quality]);
    assert.equal(d.symmetryReduced,true);
    assert.equal(d.transverseVelocityAssumedZero,true);
    assert.equal(d.densityError,null);
    assert.equal(d.meanDensity,null);
    assert.equal(d.densitySolved,false);
    assert.equal(d.pressureSolved,false);
    assert.equal(d.frictionIsMeasured,false);
    assert.equal(d.exactPairMomentumConservation,false);
    assert.equal(d.controlForce,0);
    assert.equal(d.profileForceRMS,0);
    assert.equal(d.vortexForceRMS,0);
  }
});

test('initial profile is declared once and boundary reconstruction respects axis symmetry and no slip',()=>{
  const e=new LaminarPipeSPH({re:1000,quality:'standard'});
  for(const p of e.sample()) close(p.u,2*(1-p.r*p.r));
  close(e.velocityAtRadius(0),2);
  close(e.velocityAtRadius(1),0);
  close(e.velocityAtRadius(2),0);
  close(e.velocityAtRadius(-.25),e.velocityAtRadius(.25));
  close(e.velocityAtRadius(1e-5),e.velocityAtRadius(0),1e-8);
  const rest=new LaminarPipeSPH({initial:'rest'});
  assert.ok(rest.sample().every(p=>p.u===0));
  assert.equal(rest.velocityAtRadius(0),0);
  assert.equal(rest.diagnostics().wallFRe,null);
});

test('stationary laminar flow remains accurate for t*=1000 at Re500 and Re1000',()=>{
  for(const re of [500,1000]){
    const e=new LaminarPipeSPH({re,quality:'high'});
    const initialYZ=e.particles.map(p=>[p.y,p.z]);
    for(const target of [1,5,20,100,1000]){
      e.step(target-e.time);
      const d=e.diagnostics();
      close(e.time,target);
      close(d.viscousTime,4*target/re,1e-8);
      assert.ok(d.radialRelativeL2<.00015,'spatial error must stay far below the old 10% stopping threshold');
      assert.ok(d.radialMaxError<.0003);
      assert.equal(d.rmsTransverse,0);
      assert.equal(d.stable,true);
      assert.ok(Math.abs(d.wallFRe-64)<.05,'wall-derivative diagnostic should stay within 0.08% of 64');
      close(e.velocityAtRadius(1),0);
    }
    for(let i=0;i<e.particles.length;i++){
      const p=e.particles[i];
      assert.deepEqual([p.y,p.z],initialYZ[i],'no radial motion is the explicit fully-developed-flow assumption');
      assert.equal(p.v,0);assert.equal(p.w,0);
      assert.ok(p.x>=0&&p.x<e.length);
    }
  }
});

test('the actual radial solution converges as computational resolution increases',()=>{
  let previous=Infinity;
  for(const quality of ['low','standard','high','ultra']){
    const e=new LaminarPipeSPH({re:500,quality});
    e.step(1000);
    const error=relativeError(e.sample(),q=>2*(1-q*q));
    assert.ok(error<.0023);
    if(Number.isFinite(previous)) assert.ok(error<previous*.3,'successive spatial refinement should reduce the error by about four');
    previous=error;
  }
});

test('start-up is computed from rest and agrees with an independent transient solution',()=>{
  const e=new LaminarPipeSPH({re:1000,quality:'high',initial:'rest'});
  e.step(25); // theta=.1, substantially below the steady flow.
  close(e.time,25);
  close(e.radial.time,.1,1e-11);
  const error=relativeError(e.sample(),q=>startupProfile(q,.1));
  assert.ok(error<.0006,`transient profile relative L2 ${error}`);
  const d=e.diagnostics();
  assert.ok(Math.abs(d.areaMeanU-referenceMean(.1))<.0003);
  assert.ok(d.areaMeanU>.45&&d.areaMeanU<.48,'velocities must not have been replaced by the steady profile');
  assert.equal(d.profileRelaxation,0);
  assert.equal(d.controlForce,0);
});

test('Re changes the viscous time scale while the imposed physical drive is 32/Re',()=>{
  const faster=new LaminarPipeSPH({re:500,quality:'standard',initial:'rest'});
  const slower=new LaminarPipeSPH({re:1000,quality:'standard',initial:'rest'});
  faster.step(10);slower.step(20);
  close(faster.radial.time,slower.radial.time,1e-12);
  for(let i=0;i<faster.radial.count;i++) close(faster.radial.u[i],slower.radial.u[i],1e-12);
  close(faster.diagnostics().physicalDrive,32/500);
  close(slower.diagnostics().physicalDrive,32/1000);
  const first=new LaminarPipeSPH({re:1000,initial:'rest'});
  first.step(1e-4);
  for(const p of first.sample()) close(p.u,32/1000*1e-4,1e-14);
});

test('initial disturbances evolve through the diffusion operator without target-profile feedback',()=>{
  const e=new LaminarPipeSPH({re:500,quality:'standard'});
  for(let i=0;i<e.radial.count;i++) e.radial.u[i]*=.6;
  const initial=relativeError(e.sample(),q=>2*(1-q*q));
  close(initial,.4,1e-12);
  e.step(20);
  const middle=relativeError(e.sample(),q=>2*(1-q*q));
  assert.ok(middle>0.02&&middle<initial);
  e.step(980);
  assert.ok(relativeError(e.sample(),q=>2*(1-q*q))<.0006);
  const d=e.diagnostics();
  assert.equal(d.profileForceRMS,0);assert.equal(d.vortexForceRMS,0);
  assert.equal(d.controlForce,0);assert.equal(d.profileRelaxation,0);
});

test('material tracers follow numerical velocity and preserve radius and periodic position',()=>{
  const e=new LaminarPipeSPH({re:1000,quality:'low'});
  const before=e.particles.map(p=>({x:p.x,y:p.y,z:p.z,u:p.u}));
  const dt=.002;
  e.step(dt);
  for(let i=0;i<e.particles.length;i++){
    const p=e.particles[i],old=before[i];
    const expected=((old.x+.5*(old.u+p.u)*dt)%e.length+e.length)%e.length;
    close(p.x,expected,1e-12);
    close(p.u,e.velocityAtRadius(Math.hypot(p.y,p.z)/e.radius));
    assert.equal(p.y,old.y);assert.equal(p.z,old.z);
  }
});

test('invalid configurations are rejected atomically and reset restores the declared initial condition',()=>{
  for(const re of [99,2300,NaN,Infinity]) assert.throws(()=>new LaminarPipeSPH({re}),RangeError);
  assert.throws(()=>new LaminarPipeSPH({quality:'unknown'}),RangeError);
  assert.throws(()=>new LaminarPipeSPH({initial:'analytic-every-frame'}),RangeError);
  const e=new LaminarPipeSPH({re:500,quality:'low',initial:'rest'});
  e.step(10);
  const original=e.particles;
  assert.throws(()=>e.setQuality('high',3000),RangeError);
  assert.throws(()=>e.setQuality('high',500,true),RangeError);
  assert.equal(e.quality,'low');assert.equal(e.particles,original);
  assert.throws(()=>e.step(-1),RangeError);
  assert.throws(()=>e.step(NaN),RangeError);
  assert.equal(e.time,10);
  e.reset();assert.equal(e.time,0);assert.ok(e.sample().every(p=>p.u===0));
  e.setQuality('standard',1000,false);
  assert.equal(e.radial.count,32);assert.equal(e.particles.length,1554);assert.equal(e.re,1000);
  e.setAlpha(0);e.step(1);
  const without=Float64Array.from(e.radial.u);
  e.reset();e.setAlpha(.2);e.step(1);
  assert.deepEqual(e.radial.u,without,'artificial viscosity is deliberately inactive in this incompressible radial model');
  assert.equal(e.diagnostics().artificialViscosityUsed,false);
  assert.equal(e.diagnostics().requestedArtificialViscosityAlpha,.2);
  assert.equal(e.diagnostics().artificialViscosityAlpha,0);
});
