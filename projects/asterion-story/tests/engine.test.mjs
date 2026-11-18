import test from 'node:test';
import assert from 'node:assert/strict';
import {CLASSES,SCENES,APPROACHES,ENDINGS,CLUES,STAT_INFO} from '../data.js';
import {createGame,getScene,getChoices,previewChoice,resolveChoice,rollOutcome,recover,canRecover,continueInvestigation,canContinueInvestigation,advanceScene,canAdvanceScene,finishGame,validateState,serialiseState,getStatusEffects,trueEndingRequirements} from '../engine.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const path=[0,1,1,3,2,0,2];
/** A legal witness: one investigation per chapter, with two planned rests. */
function reachFinal(classId='math',seed=1){
 let s=createGame(classId,seed);
 while(s.scene<7){
  if([3,6].includes(s.scene)&&canRecover(s))s=continueInvestigation(recover(s));
  s=resolveChoice(s,`s${s.scene}-c${path[s.scene]}`,{approach:'balanced'});
  s=validateState(serialiseState(s));s=advanceScene(s);
 }
 return s;
}
function complete(classId,seed,pathName){
 let s=reachFinal(classId,seed);const c=getChoices(s).find(item=>item.ending===pathName);
 assert.ok(c.available,`${classId} ${pathName}: ${c.disabledReason}`);
 s=resolveChoice(s,c.id,{approach:'careful',useSkill:previewChoice(s,c.id,{approach:'careful'}).skillAvailable});
 return finishGame(s);
}

test('all original chapters, nine departments and five endings remain with usable final prose',()=>{
 assert.equal(CLASSES.length,9);assert.equal(SCENES.length,8);assert.equal(ENDINGS.length,5);assert.equal(STAT_INFO.length,3);assert.equal(APPROACHES.length,3);
 const ids=SCENES.flatMap(scene=>scene.choices.map(c=>c.id));assert.equal(new Set(ids).size,ids.length);
 for(const scene of SCENES)for(const c of scene.choices){for(const key of ['name','desc','s','p','f'])assert.ok(typeof c[key]==='string'&&c[key].length>0);assert.ok(c.minutes>=2);if(c.clueId)assert.ok(CLUES[c.clueId]);}
});
test('chapter prose uses only the access and observation clues actually discovered',()=>{
 const s=createGame('civil',10);s.scene=4;
 const originalCardText=SCENES[4].text[0];assert.match(originalCardText,/認証カード/);
 assert.doesNotMatch(getScene(s).text[0],/認証カードを使う/);assert.match(getScene(s).text[0],/案内をたどり/);assert.equal(SCENES[4].text[0],originalCardText);
 s.clues.push('s2-c1-record');assert.deepEqual(getScene(s),SCENES[4]);
 s.scene=6;assert.match(getScene(s).text[0],/断片を手掛かり/);assert.match(SCENES[6].text[0],/統合すると/);
 s.clues.push('nine-records');assert.deepEqual(getScene(s),SCENES[6]);
});
test('D20 natural 1 and 20 override totals; other rolls obey both boundaries',()=>{
 assert.equal(rollOutcome(1,100,10),'critical');assert.equal(rollOutcome(20,-20,50),'big');
 for(const [total,result]of [[24,'success'],[25,'big'],[20,'success'],[19,'partial'],[17,'partial'],[16,'fail']])assert.equal(rollOutcome(10,total,20),result);
 for(const die of [0,21,NaN,1.5])assert.throws(()=>rollOutcome(die,10,12));
});
test('scene monitors reflect the current clock and observation findings',()=>{
 const s=createGame('math',1);s.scene=1;s.timeLeft=26;
 assert.match(getScene(s).dialogue,/00:26:00/);assert.doesNotMatch(SCENES[1].dialogue,/00:26:00/);
 s.scene=5;assert.doesNotMatch(getScene(s).dialogue,/0 \/ 9/);assert.doesNotMatch(getScene(s).dialogue,/照合済み/);
 s.clues.push('nine-records');assert.match(getScene(s).dialogue,/照合済み/);
});
test('chance preview exactly counts all twenty outcomes for actual action modifiers',()=>{
 for(const c of CLASSES)for(const approach of APPROACHES){
  const s=createGame(c.id,100);const p=previewChoice(s,'s0-c0',{approach:approach.id});
  const counts={big:0,success:0,partial:0,fail:0,critical:0};for(let die=1;die<=20;die++)counts[rollOutcome(die,die+p.modifier,p.difficulty)]+=5;
  assert.deepEqual(p.probabilities,counts);assert.equal(p.successChance,counts.big+counts.success);assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),100);assert.equal(counts.critical,5);
 }
});
test('approaches genuinely trade time, success probability and consequences',()=>{
 const s=createGame('electric',24),care=previewChoice(s,'s0-c0',{approach:'careful'}),bold=previewChoice(s,'s0-c0',{approach:'bold'});
 assert.equal(care.timeCost-bold.timeCost,2);assert.equal(care.modifier-bold.modifier,4);assert.ok(care.successChance>bold.successChance);assert.ok(care.costs.focus<bold.costs.focus);
 const a=resolveChoice(s,'s0-c0',{approach:'careful'}),b=resolveChoice(s,'s0-c0',{approach:'bold'});assert.equal(a.lastResult.die,b.lastResult.die);assert.equal(a.timeLeft,b.timeLeft-2);assert.equal(s.timeLeft,31);assert.equal(s.history.length,0);
});
test('health, concentration and knowledge affect relevant checks and unlock advanced investigations',()=>{
 const s=createGame('machine',1),weak=clone(s);weak.stats={hp:15,knowledge:20,focus:20};
 assert.ok(previewChoice(s,'s0-c2').modifier>previewChoice(weak,'s0-c2').modifier);assert.ok(previewChoice(s,'s0-c0').modifier>previewChoice(weak,'s0-c0').modifier);
 assert.ok(getStatusEffects(weak).some(effect=>effect.stat==='hp'&&effect.tone==='danger'));
 let a=reachFinal('math',1);a.scene=2;a.phase='choose';a.sceneActions=0;a.usedChoices=[];a.skillUsed=false;
 const unlocked=previewChoice(a,'s2-advanced');assert.ok(unlocked.available);a.stats.knowledge=67;assert.equal(previewChoice(a,'s2-advanced').available,false);assert.match(previewChoice(a,'s2-advanced').disabledReason,/68/);
});
test('a specialist ability is usable only on matching work and once in the chapter',()=>{
 let s=createGame('electric',1);
 assert.equal(previewChoice(s,'s0-c1').skillAvailable,false);assert.throws(()=>resolveChoice(s,'s0-c1',{useSkill:true}));
 const p=previewChoice(s,'s0-c0',{useSkill:true});assert.equal(p.bonuses.class,5);assert.equal(p.bonuses.skill,3);assert.equal(p.costs.focus,7);
 s=resolveChoice(s,'s0-c0',{useSkill:true});assert.equal(s.skillUsed,true);s=continueInvestigation(s);
 assert.equal(previewChoice(s,'s0-c0',{useSkill:true}).available,false);s=resolveChoice(s,'s0-c1');s=advanceScene(s);assert.equal(s.skillUsed,false);assert.equal(previewChoice(s,'s1-c1').skillAvailable,true);
});
test('results are atomic and repeated or already completed investigations cannot farm rewards',()=>{
 let s=createGame('design',1);s=resolveChoice(s,'s0-c0');const snapshot=serialiseState(s);
 assert.throws(()=>resolveChoice(s,'s0-c0'));assert.equal(serialiseState(s),snapshot);
 assert.equal(canAdvanceScene(s),true);assert.equal(canContinueInvestigation(s),true);s=continueInvestigation(s);assert.equal(previewChoice(s,'s0-c0').available,false);assert.throws(()=>resolveChoice(s,'s0-c0'));
 s=resolveChoice(s,'s0-c1');assert.equal(s.sceneActions,2);assert.equal(canContinueInvestigation(s),false);assert.throws(()=>continueInvestigation(s));assert.equal(advanceScene(s).scene,1);
});
test('reviewing a second investigation never commits the player to spending more time',()=>{
 let s=createGame('civil',1);assert.equal(canAdvanceScene(s),false);assert.throws(()=>advanceScene(s));
 s=resolveChoice(s,'s0-c0');s=continueInvestigation(s);const before=clone(s);
 assert.equal(s.phase,'choose');assert.equal(canAdvanceScene(s),true);const next=advanceScene(s);
 assert.equal(next.scene,1);assert.equal(next.timeLeft,before.timeLeft);assert.equal(next.evidence,before.evidence);assert.equal(next.history.length,before.history.length);assert.deepEqual(s,before);
});
test('restoration consumes two minutes, recovers real values and is limited to once per chapter',()=>{
 let s=createGame('safety',1);s.stats.hp=40;s.stats.focus=20;assert.ok(canRecover(s));
 const recovered=recover(s);assert.equal(recovered.stats.hp,50);assert.equal(recovered.stats.focus,38);assert.equal(recovered.timeLeft,29);assert.equal(recovered.sceneActions,0);assert.equal(recovered.lastResult.delta.focus,18);assert.equal(canAdvanceScene(recovered),false);
 s=continueInvestigation(recovered);assert.equal(canRecover(s),false);assert.throws(()=>recover(s));s=resolveChoice(s,'s0-c2');s=advanceScene(s);assert.equal(canRecover(s),true);
});
test('even zero resources and an expired clock lead to a playable emergency ending',()=>{
 let s=createGame('chemistry',81);s.stats={hp:0,knowledge:0,focus:0};s.timeLeft=1;
 const p=previewChoice(s,'s0-c0');assert.ok(p.available);assert.ok(p.warnings.some(value=>value.includes('0')));s=resolveChoice(s,'s0-c0');
 assert.equal(s.timeLeft,0);assert.equal(s.stats.focus,0);assert.equal(canContinueInvestigation(s),false);s=advanceScene(s);assert.equal(s.scene,7);
 assert.equal(getChoices(s).find(c=>c.ending==='integrate').available,false);assert.ok(getChoices(s).find(c=>c.ending==='stop').available);
 s=finishGame(resolveChoice(s,'s7-c0'));assert.equal(s.phase,'ending');assert.equal(s.ending.id,'end01');assert.ok(!s.ending.body.includes('undefined'));
});
test('a rest at the deadline can advance to the final operation before an investigation',()=>{
 let s=createGame('civil',7);s.timeLeft=2;s=recover(s);assert.equal(canAdvanceScene(s),true);assert.equal(advanceScene(s).scene,7);
});
test('all nine departments have legal witness routes to all five endings',()=>{
 for(const c of CLASSES){
  const runs=[complete(c.id,0,'stop'),complete(c.id,0,'integrate'),complete(c.id,1,'restore'),complete(c.id,0,'continue'),complete(c.id,1,'continue')];
  assert.deepEqual(runs.map(s=>s.ending.id),['end01','end02','end03','end04','end05'],c.id);
  for(const s of runs){assert.equal(s.done,true);assert.equal(s.phase,'ending');assert.equal(s.history.filter(r=>r.scene===7).length,1);assert.deepEqual(validateState(serialiseState(s)),s);}
 }
});
test('final requirements distinguish optional true ending from always available risky continuation',()=>{
 const s=reachFinal('math',1);assert.ok(trueEndingRequirements(s).every(item=>item.met));
 const weak=clone(s);weak.clues=weak.clues.filter(id=>id!=='feedback-loop');weak.stats.focus=0;
 const choices=getChoices(weak);assert.equal(choices.find(c=>c.ending==='integrate').available,false);assert.equal(choices.find(c=>c.ending==='restore').available,false);assert.equal(choices.find(c=>c.ending==='continue').available,true);assert.equal(choices.find(c=>c.ending==='stop').available,true);
 assert.ok(previewChoice(weak,'s7-c3').optionalRequirements.some(item=>!item.met));
});
test('saved result reloads retain the same next die and never repeat costs or rewards',()=>{
 let s=resolveChoice(createGame('architecture',8),'s0-c0');let loaded=validateState(serialiseState(s));
 assert.deepEqual(s,loaded);assert.throws(()=>resolveChoice(loaded,'s0-c0'));
 s=advanceScene(s);loaded=advanceScene(loaded);assert.deepEqual(resolveChoice(s,'s1-c0'),resolveChoice(loaded,'s1-c0'));
 const end=complete('design',1,'continue');assert.deepEqual(validateState(serialiseState(end)),end);assert.throws(()=>finishGame(end));
});
test('malformed saves, impossible phases, duplicated counters and altered rolls are rejected',()=>{
 const fresh=createGame('machine',1),result=resolveChoice(fresh,'s0-c0'),end=complete('machine',1,'continue');
 const mutations=[
  s=>s.version=2,s=>s.scene=999,s=>s.classId='unknown',s=>s.seed=-1,s=>s.rngState=Infinity,s=>s.stats.focus=NaN,s=>s.stats.extra=0,s=>s.stats.hp=-1,s=>s.timeLeft=32,s=>s.phase='evil',s=>s.done=true,s=>s.sceneActions=2,s=>s.timeLeft=0,s=>s.__proto__={bad:true},s=>s.extra='x',s=>s.clues=['nonexistent'],s=>s.usedChoices=['s0-c0'],s=>s.history=Array(23).fill({})
 ];
 for(const mutation of mutations){const s=clone(fresh);mutation(s);assert.throws(()=>validateState(s));}
 const bad=clone(result);bad.lastResult.total++;assert.throws(()=>validateState(bad));
 const duplicate=clone(result);duplicate.usedChoices.push('s0-c0');assert.throws(()=>validateState(duplicate));
 const altered=clone(end);altered.ending.id='end01';assert.throws(()=>validateState(altered));
 for(const raw of ['',null,[],{},'{bad','x'.repeat(100001)])assert.throws(()=>validateState(raw));
});
test('many seed routes and second-action/rest decisions stay within bounded valid states',()=>{
 for(const cl of CLASSES)for(let seed=2;seed<18;seed++){
  let s=createGame(cl.id,seed),guard=0;
  while(s.scene<7){
   if(seed%3===0&&canRecover(s))s=continueInvestigation(recover(s));
   if(s.scene===7)break;
   const available=getChoices(s).filter(c=>c.available);assert.ok(available.length);
   s=resolveChoice(s,available[seed%available.length].id,{approach:APPROACHES[seed%3].id});validateState(serialiseState(s));
   if(seed%2===0&&canContinueInvestigation(s)){s=continueInvestigation(s);const next=getChoices(s).find(c=>c.available);s=resolveChoice(s,next.id,{approach:'bold'});validateState(serialiseState(s));}
   s=advanceScene(s);assert.ok(++guard<=7);
  }
  s=finishGame(resolveChoice(s,'s7-c0'));validateState(serialiseState(s));assert.ok(s.stats.hp>=0&&s.stats.focus>=0&&s.timeLeft>=0);
 }
});
