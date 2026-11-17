import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exportExperiment,readExperiment} from '../dist/experiment-state.js';

const markup=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const context=new Proxy({measureText:s=>({width:String(s).length*6}),createLinearGradient:()=>({addColorStop(){}})},
  {get:(o,k)=>k in o?o[k]:()=>{}});
const downloads=[],objects=new Map();let nextURL=0,animation;
class Element{
  constructor(id){this.id=id;this.value='';this.checked=false;this.hidden=false;this.open=false;this.children=[];this.listeners={};this.textContent='';this.files=[];this.classList={toggle(){},contains(){return false}}}
  addEventListener(type,listener){this.listeners[type]=listener}
  fire(type){return this.listeners[type]?.({target:this})}
  getContext(){return context}
  getBoundingClientRect(){return{width:700,height:this.id==='flow'?420:265}}
  setAttribute(key,value){this[key]=value}
  replaceChildren(...children){this.children=children}
  append(...children){this.children.push(...children)}
  remove(){}
  click(){if(this.download)downloads.push({name:this.download,blob:objects.get(this.href)});return this.fire('click')}
  toBlob(callback,type){callback(new Blob([new Uint8Array([137,80,78,71])],{type}))}
}
const nodes=new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],new Element(m[1])]));
for(const id of ['saveExperiment','loadExperiment','experimentFile','saveFigure','experimentStatus'])assert.ok(nodes.has(id),'Missing experiment control '+id);
for(const input of markup.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)){
  const node=nodes.get(input[1]);node.value=input[0].match(/\bvalue="([^"]*)"/)?.[1]??'';node.checked=/\bchecked(?:\s|>)/.test(input[0]);
}
for(const select of markup.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
  const options=[...select[2].matchAll(/<option\b([^>]*)>([^<]*)/g)].map(a=>({value:a[1].match(/\bvalue="([^"]*)"/)?.[1]??'',selected:/\bselected\b/.test(a[1]),textContent:a[2]}));
  const node=nodes.get(select[1]);node.options=options;node.value=(options.find(a=>a.selected)??options[0])?.value??'';
}
const extra=new Map([['.re-number',new Element('re-number')]]),cache=new Map([['reynolds-flow-lab.reference-records.v1','[500,1000]']]);
globalThis.document={hidden:false,getElementById:id=>{assert.ok(nodes.has(id),'Missing '+id);return nodes.get(id)},
  querySelector:s=>s.startsWith('#')?nodes.get(s.slice(1)):extra.get(s),querySelectorAll:()=>[],
  createElement:()=>new Element('created'),createTextNode:s=>s,body:new Element('body'),addEventListener(){}};
globalThis.window={addEventListener(){},localStorage:{getItem:key=>cache.get(key)??null,setItem:(key,value)=>cache.set(key,value)}};
globalThis.innerWidth=1000;globalThis.devicePixelRatio=1;globalThis.matchMedia=()=>({matches:false});
globalThis.requestAnimationFrame=fn=>{animation=fn};
globalThis.setTimeout=fn=>{fn();return 0};
URL.createObjectURL=blob=>{const url='blob:export-'+nextURL++;objects.set(url,blob);return url};URL.revokeObjectURL=()=>{};
await import('../dist/app.js');
const lab=()=>window.flowLab,load=text=>{nodes.get('experimentFile').files=[{size:text.length,text:async()=>text}];return nodes.get('experimentFile').fire('change')};

// Reference records are rebuilt from Re, and only Re numbers are cached.
assert.deepEqual(lab().records.map(row=>row.re),[500,1000]);assert.equal(lab().records[0].f,.128);
nodes.get('saveExperiment').click();assert.match(downloads.at(-1).name,/^flow-experiment-Re500\.json$/);
const initial=readExperiment(await downloads.at(-1).blob.text());assert.equal(initial.settings.re,500);assert.deepEqual(initial.records,[500,1000]);
assert.notEqual(nodes.get('saveExperiment').disabled,true);

// Save the condition that actually ran rather than an unapplied slider value.
nodes.get('reNumber').value='1500';nodes.get('reNumber').fire('change');
nodes.get('saveExperiment').click();assert.equal(readExperiment(await downloads.at(-1).blob.text()).settings.re,500);

const restored={...initial.settings,re:1000,quality:'standard',alpha:0,lesson:2,view:'volume',speed:4,dye:true,trails:false};
await load(exportExperiment(restored,[3000,20000]));
assert.equal(lab().appliedRe,1000);assert.equal(lab().running,false);assert.equal(lab().lesson,2);
assert.equal(lab().engine.time,0);assert.equal(lab().engine.quality,'standard');assert.equal(lab().engine.artificialViscosityAlpha,0);
assert.equal(nodes.get('view').value,'volume');assert.equal(nodes.get('speed').value,'4');assert.equal(nodes.get('dye').checked,true);assert.equal(nodes.get('trails').checked,false);
assert.deepEqual(lab().records.map(row=>row.re),[3000,20000]);assert.deepEqual(JSON.parse(cache.values().next().value),[3000,20000]);
assert.match(nodes.get('experimentStatus').textContent,/読み込みました/);

// A bad file leaves both the active scene and its reference records in place.
const kept=lab().engine,keptRecords=lab().records;
await load('{broken');assert.equal(lab().engine,kept);assert.deepEqual(lab().records,keptRecords);assert.match(nodes.get('experimentStatus').textContent,/JSON/);
assert.equal(nodes.get('loadExperiment').disabled,false);

// A subsequent manual experiment takes precedence over a delayed file read.
let resolveRead;nodes.get('experimentFile').files=[{size:1000,text:()=>new Promise(resolve=>{resolveRead=resolve})}];
const pending=nodes.get('experimentFile').fire('change');assert.equal(nodes.get('loadExperiment').disabled,true);
nodes.get('reNumber').value='1500';nodes.get('reNumber').fire('change');nodes.get('apply').click();const manual=lab().engine;
resolveRead(exportExperiment(initial.settings,[500]));await pending;
assert.equal(lab().engine,manual);assert.equal(lab().appliedRe,1500);assert.equal(nodes.get('loadExperiment').disabled,false);
assert.match(nodes.get('experimentStatus').textContent,/中止/);

nodes.get('saveFigure').click();assert.equal(downloads.at(-1).name,'pipe-flow-laminar-Re1500.png');
assert.equal(downloads.at(-1).blob.type,'image/png');assert.equal((await downloads.at(-1).blob.arrayBuffer()).byteLength,4);
assert.equal(nodes.get('saveFigure').disabled,false);assert.match(nodes.get('experimentStatus').textContent,/PNGに保存/);
nodes.get('clearRecords').click();assert.deepEqual(lab().records,[]);assert.equal(cache.values().next().value,'[]');

// Storage may be unavailable in an embedded or local browser.
Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}});
await import('../dist/app.js?storage-unavailable');assert.deepEqual(lab().records,[]);
nodes.get('record').click();assert.equal(lab().records.length,1);animation(0);
assert.equal(nodes.get('error').hidden,true);
console.log('Experiment controls passed: applied settings, JSON recovery, invalid-file preservation, delayed-read cancellation, reference cache and PNG download.');
