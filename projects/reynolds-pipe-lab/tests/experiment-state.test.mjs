import assert from 'node:assert/strict';
import test from 'node:test';
import {MAX_JSON_CHARACTERS,normaliseSettings,normaliseRecords,exportExperiment,readExperiment} from '../dist/experiment-state.js';
import {physical} from '../dist/physics.js';

const settings=()=>({re:500,mode:'laminar',quality:'high',alpha:.035,lesson:1,
  view:'slice',speed:2,trails:true,dye:false,guides:true});
const saved=(changes={})=>({kind:'reynolds-flow-experiment',schemaVersion:'1.0.0',settings:settings(),records:[500,1000],...changes});

test('all three calculation modes and display settings round trip without particle state',()=>{
  for(const [mode,re,lesson] of [['laminar',500,1],['sph',100000,0],['teaching',20000,3]]){
    const input={...settings(),mode,re,lesson,quality:'ultra',alpha:0,view:'volume',speed:.25,dye:true};
    const text=exportExperiment(input,[100,3000,100000]);
    assert.deepEqual(readExperiment(text),{settings:input,records:[100,3000,100000]});
    assert.ok(!text.includes('particles'));
  }
});
test('saving uses independent copies of settings and record values',()=>{
  const input=settings(),records=[500];
  const text=exportExperiment(input,records);input.re=1000;records.push(1000);
  assert.equal(readExperiment(text).settings.re,500);assert.deepEqual(readExperiment(text).records,[500]);
});
test('malformed or oversized JSON reports an input error',()=>{
  assert.throws(()=>readExperiment('{bad'),/JSON/);
  assert.throws(()=>readExperiment(' '.repeat(MAX_JSON_CHARACTERS+1)),/JSON/);
  assert.throws(()=>readExperiment(null),/JSON/);
  assert.deepEqual(readExperiment('\uFEFF'+JSON.stringify(saved())).records,[500,1000]);
});
test('a future schema, unrelated file and extra keys are rejected',()=>{
  for(const data of [saved({schemaVersion:'2.0.0'}),saved({kind:'another-app'}),saved({particles:[]}),[],null]){
    assert.throws(()=>readExperiment(JSON.stringify(data)));
  }
  const extra=saved();extra.settings.html='<script>bad()</script>';
  assert.throws(()=>readExperiment(JSON.stringify(extra)));
  assert.equal({}.polluted,undefined);
  assert.throws(()=>readExperiment(JSON.stringify(saved()).replace('"records":','"__proto__":{"polluted":true},"records":')));
  assert.equal({}.polluted,undefined);
});
test('Re, model and guided experiment must describe the same physical setup',()=>{
  for(const re of [99,100001,500.5,Infinity,NaN,'500',true])assert.throws(()=>normaliseSettings({...settings(),re}));
  assert.throws(()=>normaliseSettings({...settings(),re:2300,lesson:0}),/2300/);
  assert.throws(()=>normaliseSettings({...settings(),re:1000}),/組み合わせ/);
  assert.equal(normaliseSettings({...settings(),re:2299,lesson:0}).re,2299);
  assert.equal(normaliseSettings({...settings(),mode:'sph',lesson:0,re:100000}).mode,'sph');
});
test('only controls the interface actually offers can be restored',()=>{
  for(const [key,value] of [['mode','unknown'],['quality','million'],['alpha',.02],['lesson',4],['view','top'],['speed',3],['trails',1],['dye','true'],['guides',null]]){
    assert.throws(()=>normaliseSettings({...settings(),[key]:value}),key);
  }
  const incomplete=settings();delete incomplete.alpha;assert.throws(()=>normaliseSettings(incomplete));
});
test('reference records remain bounded, distinct Re values rather than trusted computed outputs',()=>{
  for(const input of [[500,500],[100,101,102,103,104,105,106],[500,{re:1000,f:-100}],['500'],[0],null])assert.throws(()=>normaliseRecords(input));
  const restored=readExperiment(exportExperiment(settings(),[500,1000]));
  const reference=restored.records.map(re=>physical(re));
  assert.equal(reference[0].f,.128);assert.equal(reference[1].f,.064);
  assert.ok(Math.abs(reference[1].dp/reference[0].dp-2)<1e-12);
  assert.deepEqual(normaliseRecords([]),[]);
});
