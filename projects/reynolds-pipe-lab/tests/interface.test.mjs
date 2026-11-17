import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PREDICTIONS} from '../dist/learning-content.js';

const markup=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const ctx=new Proxy({measureText:s=>({width:String(s).length*6}),createLinearGradient:()=>({addColorStop(){}})}, {get:(o,k)=>k in o?o[k]:(()=>{})});
const downloads=[];
class Element {
 constructor(id){this.id=id;this.value='';this.checked=false;this.hidden=false;this.open=false;this.listeners={};this.children=[];this.textContent='';this.classList={values:new Set(),toggle(name,force){const on=force??!this.values.has(name);if(on)this.values.add(name);else this.values.delete(name);return on},contains(name){return this.values.has(name)}}}
 addEventListener(type,fn){this.listeners[type]=fn}
 fire(type,key='Enter'){this.listeners[type]?.({target:this,key})}
 getContext(){return ctx}
 getBoundingClientRect(){return {width:750,height:this.id==='flow'?420:265}}
 setAttribute(k,v){this[k]=v}
 replaceChildren(...a){this.children=a}
 append(...a){this.children.push(...a)}
 click(){if(this.download)downloads.push({href:this.href,name:this.download});this.fire('click')}
 remove(){}
}
const nodes=new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],new Element(m[1])]));
for(const tag of markup.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g))nodes.get(tag[1]).hidden=/\bhidden(?:\s|>)/.test(tag[0]);
// Read the actual HTML defaults so an obsolete control value cannot be hidden by this harness.
for(const input of markup.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)){
 const node=nodes.get(input[1]);node.value=input[0].match(/\bvalue="([^"]*)"/)?.[1]??'';node.checked=/\bchecked(?:\s|>)/.test(input[0]);
}
for(const select of markup.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
 const options=[...select[2].matchAll(/<option\b([^>]*)>([^<]*)/g)].map(a=>({value:a[1].match(/\bvalue="([^"]*)"/)?.[1]??'',selected:/\bselected\b/.test(a[1]),textContent:a[2]}));
 const node=nodes.get(select[1]);node.options=options;node.value=(options.find(a=>a.selected)??options[0])?.value??'';
}
const presets=[500,3000,20000].map(re=>Object.assign(new Element('preset'+re),{dataset:{re:String(re)}}));
const extra=new Map([['.re-number',new Element('re-number')]]);
globalThis.document={hidden:false,getElementById:id=>{assert.ok(nodes.has(id),'Missing element '+id);return nodes.get(id)},querySelector:s=>extra.get(s),querySelectorAll:s=>s==='[data-re]'?presets:[],createElement:()=>new Element('created'),createTextNode:text=>text,body:new Element('body'),addEventListener(){}};
globalThis.window={addEventListener(){}};globalThis.innerWidth=1000;globalThis.devicePixelRatio=1;globalThis.matchMedia=()=>({matches:false});
let animation,now=0,savedBlob;
globalThis.requestAnimationFrame=fn=>animation=fn;
URL.createObjectURL=blob=>{savedBlob=blob;return 'blob:test-export'};
URL.revokeObjectURL=()=>{};
globalThis.setTimeout=fn=>{fn();return 0};
const tick=(count=1)=>{for(let i=0;i<count;i++)animation(now+=16.67)};
const text=id=>nodes.get(id).textContent;
const assertNoError=()=>assert.equal(nodes.get('error').hidden,true,text('error'));
const lab=()=>window.flowLab;
const enterRe=re=>{nodes.get('reNumber').value=re;nodes.get('reNumber').fire('change')};
const chooseMode=mode=>{nodes.get('mode').value=mode;nodes.get('mode').fire('change')};
const chooseQuality=quality=>{nodes.get('quality').value=quality;nodes.get('quality').fire('change')};
const assertLaminar=(count=64)=>{
 assert.equal(lab().mode,'laminar');assert.equal(lab().engine.engineKind,'axisymmetric-sph');assert.equal(lab().engine.radial.count,count);
 assert.equal(lab().engine.model,false);assert.equal(nodes.get('alpha').disabled,true);
 assert.equal(lab().accuracy.assessed,true);assert.equal(lab().accuracy.exceeded,false);assertNoError();
};
await import('../dist/app.js');

// The initial diagram is a paused, explicitly steady laminar calculation. The
// radial computation and the many visual tracers must not be conflated.
assert.equal(lab().appliedRe,500);assert.equal(lab().running,false);assert.equal(lab().lesson,1);
assert.equal(lab().engine.quality,'high');assert.equal(lab().engine.particles.length,5874);assertLaminar();
assert.equal(nodes.get('mode').value,'laminar');assert.equal(nodes.get('speed').value,'2');
assert.equal(text('statF'),'0.1280');assert.equal(lab().engine.initialCondition,'steady');
assert.equal(lab().accuracy.relativeL2,0);assert.equal(lab().diagnostics.radialRelativeL2,0);
assert.ok(text('calculationLabel').includes('64'));assert.ok(text('calculationLabel').includes('5,874'));
assert.ok(text('calculationLabel').includes('計算'));assert.ok(text('calculationLabel').includes('表示'));
assert.ok(text('modeNote').includes('半径'));assert.ok(markup.includes('u/U'));
assert.equal(nodes.get('wallResult').hidden,false);assert.ok(Number(text('wallMeasuredF'))>0);
assert.equal(nodes.get('wallUnavailable').hidden,true);assert.ok(text('wallStatus').includes('初期状態'));
assert.ok(text('lessonObservation').length>30);assert.ok(text('lessonReason').length>30);assert.ok(text('lessonLimit').length>30);
tick(3);assert.equal(lab().engine.time,0);
assert.ok(Number(text('centerSpeed'))>Number(text('wallSpeed')));assert.ok(Number(text('wallSpeed'))>0);assert.equal(text('sideSpeed'),'0.000');
const markerInterpolationError=Math.max(...lab().engine.particles.map(p=>Math.abs(p.u-2*(1-(Math.hypot(p.y,p.z)/lab().engine.radius)**2))));
assert.ok(markerInterpolationError>0,'tracer interpolation has its own error even when radial values are exact');
for(const p of lab().engine.particles)p.u=1;
tick(12);
assert.equal(lab().accuracy.relativeL2,0,'changing display tracers must not change the computational accuracy metric');
assert.equal(lab().accuracy.exceeded,false);assert.equal(nodes.get('accuracyContinue').hidden,true);

// Both guided laminar experiments must continue far beyond the prior 3-D
// breakdown time without invoking a profile-relaxation force or the guard.
nodes.get('lesson1').click();assert.equal(lab().running,true);assert.equal(lab().engine.re,500);assertLaminar();
lab().engine.step(1000);tick(12);assert.ok(lab().engine.time>=1000);assert.equal(lab().running,true);assertLaminar();
assert.ok(lab().accuracy.relativeL2<0.1);assert.equal(lab().diagnostics.profileRelaxation,0);assert.equal(lab().diagnostics.vortexForceRMS,0);
nodes.get('lessonAnswer').open=true;nodes.get('lessonNext').click();
assert.equal(lab().lesson,2);assert.equal(lab().appliedRe,1000);assert.equal(nodes.get('lessonAnswer').open,false);assert.equal(nodes.get('lesson2')['aria-current'],'step');
assertLaminar();assert.equal(lab().engine.time,0);assert.equal(lab().accuracy.relativeL2,0);
assert.equal(text('statF'),'0.0640');assert.equal(text('ratioU'),'2.00 倍');assert.equal(text('ratioF'),'0.50 倍');assert.equal(text('ratioDP'),'2.00 倍');
assert.ok(text('lessonAnswerText').includes('0.5×2²=2倍'));assert.ok(text('ratioExplanation').includes('圧力差'));
lab().engine.step(1000);tick(12);assert.ok(lab().engine.time>=1000);assert.equal(lab().running,true);assertLaminar();

// Deliberately corrupt the computational radial values, not the tracers. The
// next diagnostics must stop the calculation and retain a visible explanation.
const flattenRadial=()=>lab().engine.radial.u.fill(1);
const flattenLegacy=()=>{for(const p of lab().engine.particles)p.u=1};
const assertAccuracyStop=()=>{
 assert.equal(lab().accuracy.assessed,true);assert.equal(lab().accuracy.exceeded,true);assert.ok(lab().accuracy.relativeL2>0.1);
 assert.ok(lab().accuracy.reasons.length>0);assert.equal(lab().running,false);
 assert.equal(nodes.get('accuracyContinue').hidden,false);assert.equal(nodes.get('accuracyNote').classList.contains('accuracy-alert'),true);
 assert.ok(text('accuracyDetails').includes('乱流'));assert.ok(text('accuracyDetails').includes('判定'));assertNoError();
};
flattenRadial();tick(12);assertAccuracyStop();
const stoppedTime=lab().engine.time;tick(2);assert.equal(lab().engine.time,stoppedTime);
nodes.get('accuracyContinue').click();assert.equal(lab().accuracyOverride,true);assert.equal(lab().running,true);assert.equal(lab().accuracy.exceeded,true);
assert.equal(nodes.get('accuracyContinue').hidden,true);assert.equal(nodes.get('accuracyNote').classList.contains('accuracy-alert'),true);
assert.ok(text('accuracyState').includes('続け'));tick(12);assert.ok(lab().engine.time>stoppedTime);assert.equal(lab().running,true);
nodes.get('reset').click();assert.equal(lab().accuracyOverride,false);assert.equal(lab().accuracy.relativeL2,0);assertLaminar();
assert.equal(nodes.get('accuracyContinue').hidden,true);assert.equal(nodes.get('accuracyNote').classList.contains('accuracy-alert'),false);
flattenRadial();tick(12);assertAccuracyStop();nodes.get('accuracyContinue').click();nodes.get('apply').click();
assert.equal(lab().accuracyOverride,false);assert.equal(lab().accuracy.relativeL2,0);assert.equal(lab().running,true);assertLaminar();

// The optional original 3-D solver still uses its own checks. Explicitly
// selecting that mode must not be mistaken for the symmetry-reduced solver.
chooseQuality('standard');chooseMode('sph');
assert.equal(lab().mode,'sph');assert.notEqual(lab().engine.engineKind,'axisymmetric-sph');assert.equal(lab().engine.particles.length,1554);
assert.equal(nodes.get('alpha').disabled,false);assert.equal(lab().accuracy.assessed,true);
assert.ok(text('calculationLabel').includes('3次元'));assert.ok(text('calculationLabel').includes('1,554'));
flattenLegacy();tick(12);assertAccuracyStop();nodes.get('reset').click();assert.equal(lab().accuracy.relativeL2,0);

// A low-Re teaching model is not an independent laminar accuracy check.
chooseMode('teaching');assert.equal(lab().appliedRe,1000);assert.equal(lab().accuracy.assessed,false);
flattenLegacy();tick(12);assert.equal(lab().running,true);assert.equal(lab().accuracy.exceeded,false);assert.equal(nodes.get('accuracyContinue').hidden,true);
// Out-of-domain selection automatically uses the illustrative model and tells
// the learner why; this must not fail with a radial solver validation error.
enterRe(2300);chooseMode('laminar');
assert.equal(lab().appliedRe,2300);assert.equal(lab().mode,'teaching');assert.equal(nodes.get('mode').value,'teaching');assert.equal(lab().engine.model,true);
assert.equal(lab().accuracy.assessed,false);assert.equal(nodes.get('alpha').disabled,false);
assert.ok(text('applyStatus').includes('切り替'));assert.ok(text('modeNote').includes('切り替'));assertNoError();
chooseMode('sph');flattenLegacy();tick(12);assert.equal(lab().accuracy.assessed,false);assert.equal(lab().running,true);

// The mixing lesson chooses the 3-D illustrative model; its friction reference
// remains unchanged when the extra forcing is removed.
nodes.get('lesson3').click();assert.equal(lab().lesson,3);assert.equal(lab().appliedRe,20000);assert.equal(lab().mode,'teaching');assert.equal(lab().engine.model,true);
assert.equal(nodes.get('dye').checked,true);assert.equal(nodes.get('guides').checked,false);assert.ok(nodes.get('colorLegend').innerHTML.includes('色'));
assert.ok(text('lessonModeStatus').includes('外力'));assert.ok(text('lessonAnswerText').includes('自然'));
const teachingF=text('statF');chooseMode('sph');assert.equal(lab().engine.model,false);assert.equal(lab().lesson,0);assert.equal(text('statF'),teachingF);
assert.ok(text('regimeBadge').includes('指定Re'));assert.equal(lab().mode,'sph');
nodes.get('lesson1').click();assert.equal(lab().lesson,1);assertLaminar(32);
nodes.get('lesson2').click();assert.equal(lab().lesson,2);assertLaminar(32);

// Manual presets remain pending until apply, then leave the guided lesson.
presets[1].click();assert.equal(lab().pendingRe,3000);assert.equal(lab().appliedRe,1000);
nodes.get('apply').click();assert.equal(lab().appliedRe,3000);assert.equal(lab().lesson,0);assert.equal(lab().mode,'teaching');
assert.ok(text('lessonLabel').includes('自由'));assert.ok(text('statRegime').includes('遷移'));assert.ok(text('fFormula').includes('教材'));
nodes.get('record').click();nodes.get('record').click();assert.equal(lab().records.length,1);nodes.get('csv').click();
assert.equal(downloads.at(-1).name,'pipe-flow-comparison.csv');const csv=await savedBlob.text();assert.ok(csv.includes('Darcy_f_reference'));assert.ok(csv.includes('illustrative interpolation; not SPH measurement'));
nodes.get('pause').click();assert.equal(lab().running,false);const before=lab().engine.time;tick();assert.equal(lab().engine.time,before);nodes.get('pause').click();assert.equal(lab().running,true);
nodes.get('view').value='volume';nodes.get('view').fire('change');nodes.get('dye').checked=false;nodes.get('dye').fire('change');assert.ok(nodes.get('colorLegend').innerHTML.includes('u/U'));
nodes.get('guides').checked=true;nodes.get('guides').fire('change');tick();assertNoError();

// Quality is still pending until applied in the 3-D mode, while a return to the
// laminar lesson maps it to independent radial and display resolutions.
enterRe(1000000);assert.equal(lab().pendingRe,100000);enterRe('');assert.equal(nodes.get('reNumber').value,100000);
chooseQuality('high');assert.equal(lab().engine.quality,'standard');nodes.get('apply').click();assert.equal(lab().engine.quality,'high');assert.equal(lab().engine.particles.length,5874);assert.equal(lab().appliedRe,100000);
tick();assert.ok(text('particleCount').includes('5,874'));assertNoError();
chooseQuality('low');nodes.get('apply').click();assert.equal(lab().engine.particles.length,390);
nodes.get('lesson1').click();assert.equal(lab().engine.quality,'low');assert.equal(lab().engine.time,0);assertLaminar(16);
assert.equal(lab().engine.particles.length,390);assert.ok(text('calculationLabel').includes('16'));assert.ok(text('calculationLabel').includes('390'));
for(const id of ['centerSpeed','wallSpeed','sideSpeed'])assert.ok(Number.isFinite(Number(text(id))),`${id} must be populated at 390 display points`);
assert.ok(Number(text('wallSpeed'))>0,'the coarse outermost tracers at r/R=0.8 must be included');assert.ok(Number(text('centerSpeed'))>Number(text('wallSpeed')));
nodes.get('reset').click();assert.equal(lab().engine.quality,'low');assert.equal(lab().engine.time,0);assertLaminar(16);
nodes.get('clearRecords').click();assert.equal(lab().records.length,0);nodes.get('download').click();assert.equal(downloads.at(-1).name,'ReynoldsFlowLab_v3.2.0.zip');assertNoError();

// Prediction feedback survives experiment switches independently of the
// removed free-text worksheet. Wall diagnostics still clear an old warning
// when moving directly from an inaccurate laminar profile to the teaching model.
if(lab().running)nodes.get('pause').click();
nodes.get('predictionChoices').children[1].click();
assert.equal(nodes.get('predictionChoices').children[1]['aria-pressed'],'true');
assert.equal(text('predictionFeedback'),PREDICTIONS[1].choices[1].feedback);
nodes.get('lesson2').click();
nodes.get('lesson1').click();
assert.equal(nodes.get('predictionChoices').children[1]['aria-pressed'],'true');
assert.equal(text('predictionFeedback'),PREDICTIONS[1].choices[1].feedback);
if(lab().running)nodes.get('pause').click();
lab().engine.radial.u.fill(1);tick(12);assertAccuracyStop();
assert.equal(nodes.get('wallMeasurement').classList.contains('measurement-alert'),true);
nodes.get('lesson3').click();
assert.equal(nodes.get('wallResult').hidden,true);assert.equal(nodes.get('wallUnavailable').hidden,false);
assert.equal(nodes.get('wallMeasurement').classList.contains('measurement-alert'),false);
nodes.get('lesson1').click();assert.equal(nodes.get('wallResult').hidden,false);assertNoError();
// A fresh mobile page chooses the 32-point radial calculation independently
// of the desktop default and of the previous page's quality selection.
globalThis.innerWidth=390;
await import('../dist/app.js?mobile-interface-check');
assert.equal(lab().engine.quality,'standard');assert.equal(lab().engine.particles.length,1554);assertLaminar(32);
assert.equal(lab().running,false);assert.equal(lab().accuracy.relativeL2,0);
assert.ok(text('calculationLabel').includes('32'));assert.ok(text('calculationLabel').includes('1,554'));

console.log('Interface checked with real solvers and DOM/canvas stubs: long-time laminar lessons, distinct computational/display particles, accuracy guards and continuation, optional 3-D modes, high-Re automatic switching, reference ratios, CSV/source downloads and resolutions. This is not browser rendering QA.');
