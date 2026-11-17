/**
 * Wall stress inferred from the numerical radial velocity gradient.
 *
 * q = r / R, u* = u / U_target. The SPH diagnostic supplies d(u*)/dq at
 * q=1 and the annular-area-weighted mean u*. No analytic profile enters
 * the measured value. The separate 64/Re comparison is a steady circular-
 * pipe reference, not a model for instantaneous startup flow or turbulence.
 */
import {PIPE} from './physics.js';

const MEAN_EPSILON=1e-9;

function unavailable(reason){
  return {available:false,reason,meanRatio:null,actualRe:null,meanSpeed:null,
    wallSlope:null,shearStress:null,friction:null,referenceF:null,
    relativeDifference:null,referenceApplicable:false,accuracyWarning:false};
}

/**
 * Only the axisymmetric, fully developed numerical model has the wall
 * derivative needed here. Visible tracers and the optional 3-D models
 * cannot supply a substitute for that derivative.
 */
export function wallMeasurement(d){
  if(!d||d.engineKind!=='axisymmetric-sph'||d.symmetryReduced!==true||d.model!==false){
    return unavailable('壁付近の速度変化から求める摩擦係数は実験1・2の軸対称SPHで表示します。');
  }
  if(d.stable===false){
    return unavailable('計算が不安定なため壁の摩擦を推定できません。');
  }
  const re=d.re,meanRatio=d.areaMeanU,wallSlope=d.radialWallSlope;
  if(!Number.isFinite(re)||re<=0||!Number.isFinite(meanRatio)||
      meanRatio<=MEAN_EPSILON||!Number.isFinite(wallSlope)){
    return unavailable('平均流速や壁付近の速度変化をまだ求められません。推定値は表示できません。');
  }
  const actualRe=re*meanRatio;
  if(!Number.isFinite(actualRe)||actualRe>=2300){
    return unavailable('この欄は層流を仮定した計算の範囲で表示します。');
  }
  const targetSpeed=re*PIPE.nu/PIPE.D;
  const meanSpeed=meanRatio*targetSpeed;
  const shearStress=PIPE.rho*PIPE.nu*targetSpeed/(PIPE.D/2)*Math.abs(wallSlope);
  const friction=8*shearStress/(PIPE.rho*meanSpeed*meanSpeed);
  if(!Number.isFinite(meanSpeed)||!Number.isFinite(shearStress)||!Number.isFinite(friction)){
    return unavailable('壁の摩擦の計算値が有限の値になりませんでした。');
  }
  // An explicitly unsteady initial condition must not be presented as an
  // error against the steady solution. The wall-stress estimate still exists.
  const referenceApplicable=d.initialCondition!=='rest';
  const referenceF=referenceApplicable?64/actualRe:null;
  const relativeDifference=referenceApplicable?(friction-referenceF)/referenceF:null;
  return {available:true,reason:referenceApplicable?
    '壁付近の数値速度の変化から摩擦係数を求めます。同じ平均流速の層流理論値と比較します。':
    '水が流れ始めてまだ速さが変わっている状態です。時間がたって落ち着いた層流の式との誤差は表示しません。',
    meanRatio,actualRe,meanSpeed,wallSlope,shearStress,friction,referenceF,
    relativeDifference,referenceApplicable,
    accuracyWarning:Number.isFinite(d.radialRelativeL2)&&d.radialRelativeL2>.1};
}
