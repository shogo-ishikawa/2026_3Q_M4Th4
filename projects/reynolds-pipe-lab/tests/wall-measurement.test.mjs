import test from 'node:test';
import assert from 'node:assert/strict';
import {wallMeasurement} from '../dist/wall-measurement.js';
import {LaminarPipeSPH} from '../dist/laminar-pipe.js';
import {PIPE} from '../dist/physics.js';

const diagnostic=(overrides={})=>({engineKind:'axisymmetric-sph',symmetryReduced:true,
  model:false,stable:true,re:1000,areaMeanU:1,radialWallSlope:-4,
  initialCondition:'steady',radialRelativeL2:0,...overrides});
const close=(a,b,tolerance=1e-12)=>assert.ok(Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(b)),`${a} != ${b}`);

test('numerical wall gradient gives stress and Darcy factor in consistent SI units',()=>{
  const m=wallMeasurement(diagnostic());
  assert.equal(m.available,true);assert.equal(m.referenceApplicable,true);
  close(m.actualRe,1000);close(m.meanSpeed,.0502);
  const dimensionalSlope=4*.0502/.01;
  close(m.shearStress,PIPE.rho*PIPE.nu*dimensionalSlope);
  close(m.friction,.064);close(m.referenceF,.064);close(m.relativeDifference,0);
  // The stress also balances the fully developed pressure gradient, but this
  // independent algebra is not used by wallMeasurement itself.
  close(4*m.shearStress*PIPE.L/PIPE.D,
    m.friction*PIPE.L/PIPE.D*PIPE.rho*m.meanSpeed**2/2);
});

test('scaled manufactured parabolas use the computed mean rather than target mean',()=>{
  const reference=wallMeasurement(diagnostic());
  for(const amplitude of [.2,.5,1,1.5,2]){
    const m=wallMeasurement(diagnostic({areaMeanU:amplitude,radialWallSlope:-4*amplitude}));
    assert.equal(m.available,true);close(m.actualRe,1000*amplitude);
    close(m.shearStress,reference.shearStress*amplitude);
    close(m.friction,reference.friction/amplitude);
    close(m.friction,64/m.actualRe);close(m.relativeDifference,0);
  }
});

test('a changed numerical wall derivative changes measured friction without changing reference',()=>{
  const a=wallMeasurement(diagnostic()),b=wallMeasurement(diagnostic({radialWallSlope:-5}));
  close(b.friction/a.friction,1.25);close(b.shearStress/a.shearStress,1.25);
  assert.equal(b.referenceF,a.referenceF);close(b.relativeDifference,.25);
  const c=wallMeasurement(diagnostic({radialWallSlope:0}));
  close(c.friction,0);close(c.relativeDifference,-1);
});

test('real SPH wall estimate converges with radial resolution without analytic replacement',()=>{
  const errors=[];
  for(const quality of ['low','standard','high','ultra']){
    const engine=new LaminarPipeSPH({re:500,quality});
    engine.step(100);
    const d=engine.diagnostics(),m=wallMeasurement(d);
    assert.equal(m.available,true);assert.equal(m.referenceApplicable,true);
    close(m.actualRe,d.re*d.areaMeanU);
    close(m.friction,16*Math.abs(d.radialWallSlope)/(d.re*d.areaMeanU**2));
    errors.push(Math.abs(m.relativeDifference));
    // Corrupt only near-wall computational values. The resulting estimate
    // must respond, while an implementation returning 64/Re would not.
    engine.radial.u[engine.radial.count-1]*=1.01;
    assert.notEqual(wallMeasurement(engine.diagnostics()).friction,m.friction);
  }
  assert.ok(errors[1]<errors[0]/2);assert.ok(errors[2]<errors[1]/2);
  assert.ok(errors[3]<errors[2]/2);assert.ok(errors[2]<.001);
});

test('unavailable states never acquire a friction estimate from another mode or invalid data',()=>{
  for(const d of [null,{},diagnostic({engineKind:'3d-sph'}),diagnostic({model:true}),
    diagnostic({symmetryReduced:false}),diagnostic({stable:false}),diagnostic({re:0}),
    diagnostic({re:NaN}),diagnostic({areaMeanU:0}),diagnostic({areaMeanU:-1}),
    diagnostic({areaMeanU:1e-12}),diagnostic({areaMeanU:Infinity}),
    diagnostic({radialWallSlope:null}),diagnostic({radialWallSlope:NaN}),
    diagnostic({re:2000,areaMeanU:1.2})]){
    const m=wallMeasurement(d);assert.equal(m.available,false);
    assert.equal(m.friction,null);assert.equal(m.referenceF,null);assert.equal(m.relativeDifference,null);
    assert.ok(m.reason.length>0);
  }
});

test('startup and excessive numerical error cannot masquerade as steady accuracy',()=>{
  const startup=wallMeasurement(diagnostic({initialCondition:'rest',areaMeanU:.1,radialWallSlope:-1}));
  assert.equal(startup.available,true);assert.equal(startup.referenceApplicable,false);
  assert.equal(startup.referenceF,null);assert.equal(startup.relativeDifference,null);
  assert.ok(startup.friction>0);
  const bad=wallMeasurement(diagnostic({radialRelativeL2:.11}));
  assert.equal(bad.available,true);assert.equal(bad.accuracyWarning,true);
  assert.equal(wallMeasurement(diagnostic()).accuracyWarning,false);
});
