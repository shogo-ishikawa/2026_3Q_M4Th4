import test from 'node:test';
import assert from 'node:assert/strict';
import {besselJ0,steadyProfile,startupProfile,referenceMean,referenceWallSlope,referenceFRe,REFERENCE_INFO} from '../dist/radial-reference.js';
const near=(a,b,tol=1e-9)=>assert.ok(Math.abs(a-b)<tol,`${a} versus ${b}`);
const PROFILE_FIXTURES=[[0.0,0.001,0.007999999999999119],[0.15,0.001,0.007999999999999119],[0.5,0.001,0.007999999999999563],[0.9,0.001,0.007952480303178355],[0.99,0.001,0.002450350787545637],[0.0,0.01,0.07999999999991725],[0.15,0.01,0.07999999998097396],[0.5,0.01,0.07999453041049498],[0.9,0.01,0.056378657076840866],[0.99,0.01,0.00826786605333224],[0.0,0.1,0.7703790072827885],[0.15,0.1,0.7633209008731372],[0.5,0.1,0.6651615505156342],[0.9,0.1,0.21558218616602928],[0.99,0.1,0.023955234891510798],[0.0,0.5,1.8770367404288906],[0.15,0.5,1.8360043646652473],[0.5,0.5,1.4176231989696353],[0.9,0.5,0.3639810777364572],[0.99,0.5,0.038257273207206254],[0.0,2.0,1.9999789928576437],[0.15,2.0,1.9549796706912883],[0.5,2.0,1.4999859266906044],[0.9,2.0,0.3799972633180851],[0.99,2.0,0.03979973643967416]];
const INTEGRAL_FIXTURES=[[0.001,0.007623406227987739,-0.2814355548296046],[0.01,0.0683703368518922,-0.8618957527179716],[0.1,0.46175445789379543,-2.423296775866766],[0.5,0.9469099840926978,-3.846485179796561],[2.0,0.9999909300653059,-3.999973773440496]];
const BESSEL_FIXTURES=[[0.0,1.0],[0.1,0.99750156206604],[1.0,0.7651976865579665],[2.4048255576957724,9.586882554916808e-17],[5.0,-0.1775967713143383],[8.0,0.1716508071375539],[13.99,0.17239912634702512],[14.0,0.17107347611045878],[15.0,-0.014224472826780597],[30.0,-0.08636798358104031],[50.0,0.055812327669252086],[100.0,0.01998585030422333],[400.0,-0.038825181530784195]];

test('Bessel J0 agrees with independent SciPy reference values',()=>{
  for(const [x,expected] of BESSEL_FIXTURES){near(besselJ0(x),expected,1e-10);near(besselJ0(-x),expected,1e-10);}
});
test('transient profiles agree with an independent 512-mode SciPy solution',()=>{
  for(const [r,s,expected] of PROFILE_FIXTURES)near(startupProfile(r,s),expected,1e-9);
  for(const [s,mean,slope] of INTEGRAL_FIXTURES){near(referenceMean(s),mean,1e-11);near(referenceWallSlope(s),slope,1e-11);}
});
test('rest, wall, symmetry and steady limits are independent of a flow solver',()=>{
  for(const r of [0,.2,.5,.99,1]){
    near(startupProfile(r,0),0);near(startupProfile(r,-1),0);
    near(startupProfile(r,10),steadyProfile(r),1e-12);
    near(startupProfile(-r,.1),startupProfile(r,.1));
  }
  for(const s of [0,.001,.01,.1,1,10])near(startupProfile(1,s),0);
  near(referenceMean(0),0);near(referenceWallSlope(0),0);assert.equal(referenceFRe(0),null);
  near(referenceMean(10),1,1e-12);near(referenceWallSlope(10),-4,1e-12);near(referenceFRe(10),64,1e-10);
});
test('start-up grows monotonically and stays within the steady solution',()=>{
  for(const r of [0,.1,.5,.8,.99]){
    let previous=0;
    for(const s of [.0001,.001,.01,.05,.1,.2,.5,1,2]){
      const u=startupProfile(r,s);
      assert.ok(u>=previous-1e-10);assert.ok(u<=steadyProfile(r)+1e-10);previous=u;
    }
  }
});
test('area integration and wall derivative agree with their analytic integrals',()=>{
  const n=4000;
  for(const s of [.001,.05,.5]){
    let integral=0;
    for(let i=0;i<n;i++){const r=(i+.5)/n;integral+=2*r*startupProfile(r,s)/n;}
    near(integral,referenceMean(s),1e-6);
    const h=1e-5;
    near(-startupProfile(1-h,s)/h,referenceWallSlope(s),6e-5);
  }
});
test('nonfinite inputs reject rather than corrupt reference comparisons',()=>{
  assert.throws(()=>startupProfile(NaN,.1),RangeError);assert.throws(()=>startupProfile(.5,Infinity),RangeError);
  assert.throws(()=>referenceMean(NaN),RangeError);assert.throws(()=>besselJ0(Infinity),RangeError);
  assert.equal(REFERENCE_INFO.modeCount,128);
});
