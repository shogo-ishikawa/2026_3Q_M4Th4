import test from 'node:test';
import assert from 'node:assert/strict';
import {PipeSPH} from '../dist/sph.js';
import {LaminarPipeSPH} from '../dist/laminar-pipe.js';
import {laminarAccuracy,LAMINAR_LIMITS} from '../dist/accuracy.js';

test('independent laminar reference detects velocity, transverse and density errors separately',()=>{
  const e=new PipeSPH({re:1000,quality:'low',model:false});
  const initial=laminarAccuracy(e);
  assert.equal(initial.exceeded,false);
  assert.equal(initial.relativeL2,0);
  for(const p of e.particles)p.u*=0.7;
  assert.ok(Math.abs(laminarAccuracy(e).relativeL2-.3)<1e-12);
  assert.equal(laminarAccuracy(e).exceeded,true);
  e.reset(1000,false);
  const d=e.diagnostics();
  assert.equal(laminarAccuracy(e,{...d,rmsTransverse:.06}).reasons.length,1);
  assert.equal(laminarAccuracy(e,{...d,densityError:.03}).reasons.length,1);
  assert.equal(laminarAccuracy(e,{...d,rmsTransverse:NaN}).exceeded,true);
  assert.ok(Object.isFrozen(LAMINAR_LIMITS));
});

test('laminar guard is not a turbulent-flow or imposed-model validity claim',()=>{
  for(const config of [{re:1000,model:true},{re:2300,model:false},{re:20000,model:false}]){
    const e=new PipeSPH({quality:'low',...config});
    const result=laminarAccuracy(e);
    assert.equal(result.assessed,false);
    assert.equal(result.exceeded,false);
  }
});

test('axisymmetric accuracy uses computational SPH velocities and does not invent a density error',()=>{
  const e=new LaminarPipeSPH({re:500,quality:'high'});
  e.step(1000);
  const correct=laminarAccuracy(e);
  assert.equal(correct.assessed,true);
  assert.equal(correct.exceeded,false);
  assert.ok(correct.relativeL2<.00015);
  assert.equal(correct.densityError,null);
  for(const p of e.particles)p.u=10; // Display markers do not define the numerical accuracy.
  assert.equal(laminarAccuracy(e).relativeL2,correct.relativeL2);
  for(let i=0;i<e.radial.count;i++)e.radial.u[i]*=.5;
  assert.equal(laminarAccuracy(e).exceeded,true);
  const rest=new LaminarPipeSPH({initial:'rest'});
  assert.equal(laminarAccuracy(rest).assessed,false,'steady theory must not judge a transient initial condition');
});

