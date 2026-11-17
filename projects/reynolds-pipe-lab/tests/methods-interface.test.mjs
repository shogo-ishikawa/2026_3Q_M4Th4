import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const markup=readFileSync(new URL('../dist/methods.html',import.meta.url),'utf8');
const ctx=new Proxy({measureText:s=>({width:String(s).length*6})},{get:(o,k)=>k in o?o[k]:()=>{}});
class Element{constructor(id){this.id=id;this.value='';this.hidden=false;this.children=[];this.listeners={};this.textContent=''}addEventListener(t,f){this.listeners[t]=f}fire(t){this.listeners[t]?.({target:this})}getContext(){return ctx}getBoundingClientRect(){return{width:500,height:this.id.endsWith('Mesh')?52:222}}replaceChildren(){this.children=[]}append(...x){this.children.push(...x)}click(){this.fire('click')}remove(){}}
const nodes=new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],new Element(m[1])]));
nodes.get('benchResolution').value='32';nodes.get('benchRe').value='1000';nodes.get('benchTime').value='.25';
globalThis.document={getElementById:id=>{assert.ok(nodes.has(id),'Missing element '+id);return nodes.get(id)},createElement:()=>new Element('created'),body:new Element('body')};globalThis.window={addEventListener(){}};globalThis.devicePixelRatio=1;const callbacks=[];globalThis.requestAnimationFrame=f=>callbacks.push(f);
await import('../dist/methods.js');
function finish(){let iterations=0;while(callbacks.length){callbacks.shift()(iterations*16.67);assert.ok(++iterations<20000,'comparison must reach its target')}assert.equal(window.methodLab.running,false)}
finish();assert.ok(Math.abs(window.methodLab.time-.25)<1e-12);for(const model of Object.values(window.methodLab.models)){assert.ok(Math.abs(model.diagnostics().time-.25)<1e-10)}assert.equal(nodes.get('benchError').hidden,true);assert.ok(nodes.get('benchStatus').textContent.includes('比較完了'));assert.ok(window.methodLab.models.amr.diagnostics().count>32);
nodes.get('benchTime').value='2';nodes.get('benchTime').fire('input');assert.equal(nodes.get('benchTimeValue').textContent,'2.00');nodes.get('benchResolution').value='64';nodes.get('benchRun').click();nodes.get('benchPause').click();finish();assert.equal(window.methodLab.time,0);nodes.get('benchPause').click();finish();assert.ok(Math.abs(window.methodLab.time-2)<1e-10);assert.equal(window.methodLab.models.sph.diagnostics().count,64);for(const model of Object.values(window.methodLab.models)){assert.ok(Math.abs(model.diagnostics().fRe-64)<.2,'wall coefficient approaches64')}
nodes.get('benchReset').click();assert.equal(window.methodLab.time,0);assert.equal(nodes.get('benchFriction').textContent,'—');
console.log('Method comparison interface passed: common time, resolution, pause/resume, analytic display, evolving AMR, steady wall coefficient, rest reset.');
