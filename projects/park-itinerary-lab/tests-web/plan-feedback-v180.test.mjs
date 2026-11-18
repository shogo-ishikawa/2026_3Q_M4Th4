import test from 'node:test';
import assert from 'node:assert/strict';
import {wishInputProblem,noPlanExplanation,noPlanActions} from '../web/app.js';
import {solveItinerary} from '../web/planner.js';

const ride={id:'ride',name:'テストライド',category:'attraction'};
const parade={id:'parade',name:'パレード',category:'parade'};
const cafe={id:'cafe',name:'テストカフェ',category:'cafe'};

test('a wish outside the current genre can be identified by both facility and editable field',()=>{
  const wish={id:'parade'};
  const missing=wishInputProblem(wish,parade);
  assert.equal(missing.wishId,'parade');
  assert.equal(missing.field,'showTimes');
  assert.match(missing.message,/パレード.*開演時刻/);
  wish.showTimes=[600];
  assert.equal(wishInputProblem(wish,parade).field,'confirmSchedule');
  wish.confirmSchedule=true;
  assert.equal(wishInputProblem(wish,parade),null);
});

test('each acquired DPA field and its ordering have their own correction target',()=>{
  const wish={id:'ride',dpaMode:'owned'};
  for(const [key,value] of [['dpaStart',660],['dpaEnd',720],['dpaPurchasedAt',600]]){
    assert.equal(wishInputProblem(wish,ride).field,key);
    wish[key]=value;
  }
  assert.equal(wishInputProblem(wish,ride),null);
  assert.equal(wishInputProblem({...wish,dpaEnd:650},ride).field,'dpaEnd');
  assert.equal(wishInputProblem({...wish,dpaPurchasedAt:661},ride).field,'dpaPurchasedAt');
  assert.equal(wishInputProblem({...wish,showTimes:[700],confirmSchedule:true},parade).field,'nodeOverride');
});

test('an imported candidate window works and a partially edited candidate names the missing bound',()=>{
  const wish={id:'ride',dpaMode:'consider',dpaAvailableWindows:[[660,720]]};
  assert.equal(wishInputProblem(wish,ride),null);
  assert.equal(wishInputProblem({...wish,dpaStart:700},ride).field,'dpaEnd');
  assert.equal(wishInputProblem({...wish,dpaStart:700,dpaEnd:650,dpaAvailableWindows:[]},ride).field,'dpaEnd');
  assert.equal(wishInputProblem({...wish,dpaMode:'none',dpaStart:700,dpaEnd:650},ride),null);
});

test('wish window endpoints must leave time to visit',()=>{
  const problem=wishInputProblem({id:'cafe',earliest:660,latest:660},cafe);
  assert.equal(problem.wishId,'cafe');
  assert.equal(problem.field,'latest');
});

test('an unsuccessful real solve names the hard food cost and links both the wish and the food cap',()=>{
  const park={id:'land',name:'テスト',entryNode:'gate',exitNode:'gate',nodes:[{id:'gate'}],edges:[],
    activities:[{...cafe,node:'gate',cost:1000,duration:10,windows:[[540,720]],baseWait:0}]};
  const settings={date:'2026-11-18',entry:540,exit:720,budget:2000,foodBudget:500,souvenirReserve:0,
    crowdMode:'manual',searchMethod:'beam',searchSeconds:1,selections:[{id:'cafe',required:true,cost:1000}]};
  const result=solveItinerary(park,settings);
  assert.equal(result.status,'no-plan');
  assert.match(noPlanExplanation(result,park),/必須のフード.*1,000円.*500円/);
  const links=noPlanActions(result,park);
  assert.ok(links.some(item=>item.wishId==='cafe'&&item.field==='earliest'));
  assert.ok(links.some(item=>item.field==='foodBudget'));
  settings.foodBudget=1000;
  const corrected=solveItinerary(park,settings);
  assert.equal(corrected.status,'feasible');
  assert.deepEqual(noPlanActions(corrected,park),[]);
});

test('no-plan guidance includes time limits and fixed rests without treating a timeout as proof',()=>{
  const result={status:'no-plan',settings:{budget:2000,fixedBreaks:[{start:600}]},diagnostics:{timedOut:true}};
  const park={activities:[ride]};
  const links=noPlanActions(result,park);
  assert.ok(links.some(item=>item.field==='breakEditor'));
  assert.ok(links.some(item=>item.field==='searchSeconds'));
  assert.match(noPlanExplanation(result,park),/探索時間内に.*見つかりませんでした/);
  result.settings.spentBudget=3100;
  assert.match(noPlanExplanation(result,park),/3,100円.*2,000円/);
});

test('pasted wish values survive a genre switch with an input event but no change event',async()=>{
  const {bindWishEditors}=await import('../web/app.js');
  const listeners=new Map(),commits=[];
  const root={addEventListener(name,action){listeners.set(name,action);}};
  bindWishEditors(root,e=>commits.push([e.target.dataset.field,e.target.value]),()=>{});
  const input={type:'number',dataset:{field:'cost'},defaultValue:'1500',value:'1555'};
  const fire=(type,target=input)=>listeners.get(type)({type,target});
  fire('input');fire('focusout');
  assert.deepEqual(commits,[['cost','1555']]);
  // The genre rerender creates a new node with the stored invalid draft.
  const restored={...input,value:'1900'};
  fire('input',restored);fire('change',restored);fire('focusout',restored);
  assert.deepEqual(commits,[['cost','1555'],['cost','1900']]);
  const times={type:'text',dataset:{field:'showTimes'},value:'11:30, 12:00',defaultValue:'09:00'};
  fire('focusout',times);
  assert.deepEqual(commits.at(-1),['showTimes','11:30, 12:00']);
});

test('clock parts and DPA radios still commit through their canonical change event',async()=>{
  const {bindWishEditors}=await import('../web/app.js');
  const listeners=new Map(),commits=[];
  bindWishEditors({addEventListener(name,action){listeners.set(name,action);}},e=>commits.push(e.target.dataset.field),()=>{});
  const fire=(type,target)=>listeners.get(type)({type,target});
  const part={type:'number',dataset:{timePart:'hour'},value:'10'};
  const clock={type:'hidden',dataset:{field:'earliest'},value:'10:00'};
  const mode={type:'radio',dataset:{field:'dpaMode'},value:'owned'};
  for(const target of [part,clock,mode]){fire('input',target);fire('focusout',target);}
  fire('change',clock);fire('change',mode);
  assert.deepEqual(commits,['earliest','dpaMode']);
});
