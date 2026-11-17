/** Problem-specific verification, not a turbulence detector or solver repair.
 * For unforced-perturbation, fully-developed laminar experiments initialized
 * at the Poiseuille steady solution, that independent solution should persist.
 * These are deliberately visible teaching thresholds, not convergence proofs.
 */
export const LAMINAR_LIMITS = Object.freeze({relativeL2:0.10, transverseRMS:0.05, densityError:0.02});

export function laminarAccuracy(engine, diagnostics=engine.diagnostics()) {
  if(engine.engineKind==='axisymmetric-sph'){
    if(diagnostics.initialCondition!=='steady')return {assessed:false,exceeded:false,reasons:[]};
    const relativeL2=diagnostics.radialRelativeL2;
    const exceeded=!Number.isFinite(relativeL2)||relativeL2>LAMINAR_LIMITS.relativeL2;
    return {assessed:true,exceeded,relativeL2,transverseRMS:0,densityError:null,
      comparison:'area-weighted computational radial SPH particles',
      reasons:exceeded?['層流の理論式との差が10%を超えました']:[]};
  }
  if(engine.model || engine.re>=2300) return {assessed:false,exceeded:false,reasons:[]};
  let squaredError=0,squaredReference=0;
  for(const p of engine.particles){
    const q=Math.hypot(p.y,p.z)/engine.radius;
    const expected=2*(1-q*q);
    squaredError+=(p.u-expected)**2;
    squaredReference+=expected**2;
  }
  const relativeL2=Math.sqrt(squaredError/squaredReference);
  const transverseRMS=diagnostics.rmsTransverse;
  const densityError=diagnostics.densityError;
  const reasons=[];
  if(!Number.isFinite(relativeL2) || relativeL2>LAMINAR_LIMITS.relativeL2) reasons.push('速度分布の差が10%を超えました');
  if(!Number.isFinite(transverseRMS) || transverseRMS>LAMINAR_LIMITS.transverseRMS) reasons.push('横速度RMSがUの5%を超えました');
  if(!Number.isFinite(densityError) || densityError>LAMINAR_LIMITS.densityError) reasons.push('最大密度偏差が2%を超えました');
  return {assessed:true,exceeded:reasons.length>0,relativeL2,transverseRMS,densityError,reasons};
}
