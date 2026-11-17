import assert from 'node:assert/strict';
import test from 'node:test';
import {LaminarPipeSPH} from '../dist/laminar-pipe.js';
import {PipeSPH} from '../dist/sph.js';
import {createLearningTools} from '../dist/learning-tools.js';
import {PREDICTIONS,LESSON_NOTES} from '../dist/learning-content.js';

class Element{
  constructor(){this.value='';this.children=[];this.listeners={};this.hidden=false;this.textContent='';this.attrs={};this.classList={values:new Set(),toggle(name,on){if(on)this.values.add(name);else this.values.delete(name)},contains(name){return this.values.has(name)}};}
  addEventListener(type,fn){this.listeners[type]=fn;}
  setAttribute(key,value){this.attrs[key]=value;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  click(){this.listeners.click?.();}
}

test('learning controls preserve each experiment prediction while switching experiments',()=>{
  const nodes=new Map();
  const prior=globalThis.document;
  globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)},createElement(){return new Element()}};
  try{
    const tools=createLearningTools();
    const node=id=>nodes.get(id);
    tools.showLesson(1,'laminar');
    assert.equal(node('lessonReason').textContent,LESSON_NOTES[1].reason);
    assert.equal(node('predictionPanel').hidden,false);
    const firstChoices=node('predictionChoices').children;
    firstChoices[1].click();
    assert.equal(node('predictionFeedback').textContent,PREDICTIONS[1].choices[1].feedback);
    assert.deepEqual(firstChoices.map(a=>a.attrs['aria-pressed']),['false','true','false']);
    tools.showLesson(2,'laminar');
    assert.equal(node('lessonReason').textContent,LESSON_NOTES[2].reason);
    node('predictionChoices').children[0].click();
    tools.showLesson(1,'laminar');
    assert.equal(node('predictionFeedback').textContent,PREDICTIONS[1].choices[1].feedback);
    assert.equal(node('predictionChoices').children[1].attrs['aria-pressed'],'true');
    tools.showLesson(0,'laminar');
    assert.equal(node('predictionPanel').hidden,true);
    assert.equal(node('predictionChoices').children.length,0);
    tools.showLesson(2,'laminar');
    assert.equal(node('predictionFeedback').textContent,PREDICTIONS[2].choices[0].feedback);
    assert.equal(node('predictionChoices').children[0].attrs['aria-pressed'],'true');
  }finally{globalThis.document=prior;}
});

test('the wall panel distinguishes a valid estimate, a known inaccurate state, reset, and unavailable 3-D data',()=>{
  const nodes=new Map();
  const prior=globalThis.document;
  globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)},createElement(){return new Element()}};
  try{
    const engine=new LaminarPipeSPH({re:500,quality:'low'});
    const tools=createLearningTools();
    const node=id=>nodes.get(id);
    tools.updateWall(engine.diagnostics(),{exceeded:false});
    assert.equal(node('wallResult').hidden,false);
    assert.equal(node('wallUnavailable').hidden,true);
    assert.ok(Number(node('wallMeasuredF').textContent)>0);
    assert.ok(node('wallStatus').textContent.includes('初期状態'));
    tools.updateWall(engine.diagnostics(),{exceeded:true});
    assert.ok(node('wallStatus').textContent.includes('物理的な結論'));
    assert.equal(node('wallMeasurement').classList.contains('measurement-alert'),true);
    engine.reset(500);
    tools.updateWall(engine.diagnostics(),{exceeded:false});
    assert.equal(node('wallMeasurement').classList.contains('measurement-alert'),false);
    const teaching=new PipeSPH({re:20000,quality:'low',model:true});
    tools.updateWall(engine.diagnostics(),{exceeded:true});
    tools.updateWall(teaching.diagnostics(),{exceeded:false});
    assert.equal(node('wallResult').hidden,true);
    assert.equal(node('wallUnavailable').hidden,false);
    assert.ok(node('wallStatus').textContent.includes('推定しません'));
    assert.equal(node('wallMeasurement').classList.contains('measurement-alert'),false);
  }finally{globalThis.document=prior;}
});
