/** D20の判定と物語の進行。画面や保存領域には依存しません。 */
import {CLASSES, CLASS_LINES, SCENES, APPROACHES, ENDINGS, CLUES, FALLBACK_ENDING_BODY} from './data.js';
export {CLASSES, SCENES, APPROACHES, ENDINGS, CLUES};
const FINAL=SCENES.length-1;
const STATS=['hp','knowledge','focus'];
const PHYSICAL=new Set(['機械','構造','安全']);
const copy=value=>JSON.parse(JSON.stringify(value));
const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,value));
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const outcomeLabels={big:'大成功',success:'成功',partial:'部分成功',fail:'失敗',critical:'重大な失敗'};
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const currentClass=state=>CLASSES.find(item=>item.id===state.classId);
const chosen= (state,id)=>SCENES[state.scene].choices.find(item=>item.id===id);

export function createGame(classId,seed=Date.now()>>>0){
  assert(CLASSES.some(item=>item.id===classId),'所属学科を選んでください。');
  assert(integer(seed,0,0xffffffff),'試験番号は0〜4294967295の整数で指定してください。');
  return {schemaVersion:1,version:1,classId,seed,rngState:seed,scene:0,phase:'choose',stats:{hp:80,knowledge:60,focus:75},timeLeft:31,evidence:0,anomaly:0,clues:[],history:[],usedChoices:[],sceneActions:0,recovered:false,skillUsed:false,lastResult:null,ending:null,done:false};
}
export function getScene(state){
  const scene=SCENES[state.scene];
  let first=scene.text[0];
  if(state.scene===4&&!state.clues.includes('s2-c1-record'))first='廊下に残った案内をたどり、建物の奥にある扉を開いた。その先には、大学のどの図面にも載っていない空間が広がっている。壁には「第四実験棟」と刻まれていた。';
  if(state.scene===6&&!state.clues.includes('nine-records'))first='観測装置から回収した断片を手掛かりに、最終記録を開いた。中央モニターに17年前の研究映像が再生される。';
  let dialogue=scene.dialogue;
  if(state.scene===1)dialogue=dialogue.replace(/残り時間 00:31:00|残り時間は画面のカウントに表示されている。/,`残り時間 00:${String(state.timeLeft).padStart(2,'0')}:00`);
  if(state.scene===5)dialogue=dialogue.replace(/OBSERVATION DATA : (?:0 \/ 9|九分野の記録)/,state.clues.includes('nine-records')?'OBSERVATION DATA : 九分野を照合済み':'OBSERVATION DATA : 九分野の記録を照合');
  return first===scene.text[0]&&dialogue===scene.dialogue?scene:{...scene,text:[first,...scene.text.slice(1)],dialogue};
}

export function getStatusEffects(state){
  const effects=[];
  if(state.stats.focus>=70)effects.push({label:'集中している',description:'すべての判定＋2。',tone:'good',stat:'focus'});
  else if(state.stats.focus<=30)effects.push({label:'集中力が低下',description:'すべての判定−3。休息で回復できます。',tone:'warning',stat:'focus'});
  if(state.stats.hp>=75)effects.push({label:'足取りが軽い',description:'機械・構造・安全の調査で判定＋2。',tone:'good',stat:'hp'});
  else if(state.stats.hp<=30)effects.push({label:'体力を消耗',description:'機械・構造・安全の調査で判定−3。',tone:'warning',stat:'hp'});
  if(state.stats.hp<=15)effects.push({label:'非常行動',description:'さらにすべての判定−1。0でも調査・非常遮断は続けられます。',tone:'danger',stat:'hp'});
  if(state.stats.knowledge>=75)effects.push({label:'仮説がつながる',description:'解析の判定＋3。体を使う調査でも＋1。',tone:'good',stat:'knowledge'});
  else if(state.stats.knowledge>=55)effects.push({label:'知識を活かす',description:'解析の判定＋1。',tone:'good',stat:'knowledge'});
  else if(state.stats.knowledge<=30)effects.push({label:'知識が不足',description:'解析の判定−2。体を使う調査でも−1。',tone:'warning',stat:'knowledge'});
  if(state.timeLeft<=5)effects.push({label:'起動が迫る',description:'残り時間を使い切ると、最後の操作へ移ります。',tone:'danger'});
  return effects;
}
function statusBonus(state,choice,costs){
  const s=state.stats,physical=PHYSICAL.has(choice.cat);
  let bonus=s.focus>=70?2:s.focus<=30?-3:0;
  if(physical)bonus+=s.hp>=75?2:s.hp<=30?-3:0;
  bonus+=s.knowledge>=75?(physical?1:3):s.knowledge>=55&&!physical?1:s.knowledge<=30?(physical?-1:-2):0;
  if(s.hp<=15)bonus--;
  if(s.focus<costs.focus||s.hp<costs.hp)bonus-=2;
  return bonus;
}
function requirements(state,choice){
  const result=[];
  const add=(label,met)=>result.push({label,met:Boolean(met)});
  if(choice.minKnowledge)add(`専門知識 ${choice.minKnowledge}以上`,state.stats.knowledge>=choice.minKnowledge);
  if(choice.minEvidence)add(`証拠 ${choice.minEvidence}以上`,state.evidence>=choice.minEvidence);
  if(choice.ending==='integrate'){
    add('九分野の対応表',state.clues.includes('nine-records'));add('未来情報の自己入力',state.clues.includes('feedback-loop'));
    add('証拠 5以上',state.evidence>=5);add('異常理解度 35以上',state.anomaly>=35);add('専門知識 55以上',state.stats.knowledge>=55);add('集中力 30以上',state.stats.focus>=30);add('残り時間 1分以上',state.timeLeft>=1);
  }
  if(choice.ending==='restore'){
    add('篠宮澪の観測記録',state.clues.includes('mio-record'));add('証拠 3以上',state.evidence>=3);add('専門知識 45以上',state.stats.knowledge>=45);add('集中力 25以上',state.stats.focus>=25);add('残り時間 1分以上',state.timeLeft>=1);
  }
  return result;
}
export function trueEndingRequirements(state){
  return [{label:'未来情報の自己入力',met:state.clues.includes('feedback-loop')},{label:'篠宮澪の観測記録',met:state.clues.includes('mio-record')},{label:'九分野の対応表',met:state.clues.includes('nine-records')},{label:'証拠 7以上',met:state.evidence>=7},{label:'異常理解度 65以上',met:state.anomaly>=65},{label:'専門知識 65以上',met:state.stats.knowledge>=65},{label:'集中力 30以上',met:state.stats.focus>=30},{label:'残り時間 3分以上',met:state.timeLeft>=3}];
}
export function rollOutcome(die,total,difficulty){
  assert(integer(die,1,20)&&Number.isFinite(total)&&Number.isFinite(difficulty),'判定の値を確認してください。');
  if(die===1)return 'critical';if(die===20||total>=difficulty+5)return 'big';
  if(total>=difficulty)return 'success';if(total>=difficulty-3)return 'partial';return 'fail';
}
export function previewChoice(state,choiceId,{approach='balanced',useSkill=false}={}){
  const choice=chosen(state,choiceId),method=APPROACHES.find(item=>item.id===approach);
  assert(choice&&method,'調査内容と進め方を確認してください。');
  assert(typeof useSkill==='boolean','専門能力の指定を確認してください。');
  const match=choice.cat==='専門'||choice.cat===currentClass(state).category;
  const skillAvailable=match&&!state.skillUsed&&state.stats.focus>=4;
  const skill=useSkill&&skillAvailable;
  const costs={hp:Number(choice.cost?.hp)||0,knowledge:Number(choice.cost?.knowledge)||0,focus:Math.max(0,(Number(choice.cost?.focus)||0)-(approach==='careful'?1:0))+(skill?4:0)};
  const bonuses={class:match?5:0,status:statusBonus(state,choice,costs),approach:method.bonus,skill:skill?3:0};
  const modifier=Object.values(bonuses).reduce((sum,value)=>sum+value,0);
  const needed=requirements(state,choice),warnings=[];
  let disabledReason='';
  if(state.done||state.phase==='ending')disabledReason='この試験は終了しています。';
  else if(state.phase!=='choose')disabledReason='結果を確認してから次の行動を選んでください。';
  else if(state.usedChoices.includes(choice.id))disabledReason='この調査は実施済みです。';
  else if(state.scene!==FINAL&&state.sceneActions>=2)disabledReason='この章での調査は2回までです。';
  else if(state.scene!==FINAL&&state.timeLeft===0)disabledReason='起動時刻です。最後の操作へ進んでください。';
  else if(needed.some(item=>!item.met))disabledReason=needed.filter(item=>!item.met).map(item=>item.label).join('・')+'が必要です。';
  else if(useSkill&&!skillAvailable)disabledReason='この調査では専門能力を使えません。';
  const timeCost=state.scene===FINAL?Math.min(state.timeLeft,Math.max(1,choice.minutes+method.timeDelta)):Math.max(1,choice.minutes+method.timeDelta);
  if(state.stats.focus<costs.focus||state.stats.hp<costs.hp)warnings.push('不足した資源は0で止まります。負担による判定−2が加わります。');
  if(state.scene!==FINAL&&timeCost>=state.timeLeft)warnings.push('この行動で起動時刻に達します。結果確認後に最後の操作へ移ります。');
  if(approach==='bold')warnings.push('失敗・重大な失敗では体力と集中力を追加で3消耗します。');
  const probabilities={big:0,success:0,partial:0,fail:0,critical:0};
  for(let die=1;die<=20;die++)probabilities[rollOutcome(die,die+modifier,choice.difficulty)]+=5;
  return {available:!disabledReason,disabledReason,choiceId,approach,useSkill:skill,skillAvailable,bonuses,modifier,difficulty:choice.difficulty,timeCost,costs,successChance:probabilities.big+probabilities.success,probabilities,requirements:needed,optionalRequirements:choice.ending==='continue'?trueEndingRequirements(state):[],warnings};
}
export function getChoices(state){
  return getScene(state).choices.map(choice=>{const p=previewChoice(state,choice.id);return {...choice,used:state.usedChoices.includes(choice.id),available:p.available,disabledReason:p.disabledReason};});
}
function nextDie(state){
  state.rngState=(state.rngState+0x6d2b79f5)>>>0;
  let t=state.rngState;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);
  return 1+Math.floor(((t^(t>>>14))>>>0)/4294967296*20);
}
function addClue(state,id,added){if(id&&!state.clues.includes(id)){state.clues.push(id);added.push(id);}}
function deltas(before,after){return {...Object.fromEntries(STATS.map(id=>[id,after.stats[id]-before.stats[id]])),evidence:after.evidence-before.evidence,anomaly:after.anomaly-before.anomaly,timeLeft:after.timeLeft-before.timeLeft};}
export function resolveChoice(state,choiceId,options={}){
  const preview=previewChoice(state,choiceId,options);assert(preview.available,preview.disabledReason);
  const next=copy(state),choice=chosen(state,choiceId),die=nextDie(next),total=die+preview.modifier,outcome=rollOutcome(die,total,choice.difficulty);
  for(const id of STATS)next.stats[id]=clamp(next.stats[id]-preview.costs[id]);
  next.timeLeft=Math.max(0,next.timeLeft-preview.timeCost);next.usedChoices.push(choice.id);next.sceneActions++;if(preview.useSkill)next.skillUsed=true;
  const reward={...(choice.reward||{})};
  const gains={big:{evidence:2,anomaly:10,knowledge:4},success:{evidence:1,anomaly:7,knowledge:2},partial:{evidence:1,anomaly:3,knowledge:1,focus:-1},fail:{anomaly:2,hp:-4,focus:-3},critical:{anomaly:1,hp:-8,focus:-5}}[outcome];
  for(const [id,value]of Object.entries(gains))reward[id]=(reward[id]||0)+value;
  if(preview.approach==='bold'&&['fail','critical'].includes(outcome)){reward.hp=(reward.hp||0)-3;reward.focus=(reward.focus||0)-3;}
  if(preview.approach==='bold'&&outcome==='big')reward.evidence=(reward.evidence||0)+1;
  if(preview.useSkill)reward.anomaly=(reward.anomaly||0)+3;
  for(const id of STATS)next.stats[id]=clamp(next.stats[id]+(reward[id]||0));
  next.evidence=clamp(next.evidence+(reward.evidence||0));next.anomaly=clamp(next.anomaly+(reward.anomaly||0));
  const clueIds=[];
  if(['big','success','partial'].includes(outcome)){addClue(next,choice.clueId,clueIds);addClue(next,choice.keyClueId,clueIds);}
  let text=['big','success'].includes(outcome)?choice.s:outcome==='partial'?choice.p:choice.f;
  if(outcome==='critical')text+='\n\n予想外のトラブルで消耗した。非常操作は引き続き使える。';
  if(outcome==='big')text+='\n\n追加の証拠を確保した。';
  if(preview.useSkill)text+=`\n\n【${currentClass(state).skill}】${CLASS_LINES[state.classId]}`;
  if(next.timeLeft===0&&next.scene!==FINAL)text+='\n\n時計が午前0時17分を指した。次は残された記録で最後の操作を行う。';
  next.lastResult={kind:'investigation',scene:state.scene,choiceId,choiceName:choice.name,approach:preview.approach,useSkill:preview.useSkill,die,bonuses:preview.bonuses,total,difficulty:choice.difficulty,outcome,label:outcomeLabels[outcome],text,delta:deltas(state,next),clueIds,timeCost:preview.timeCost,trueEndingReady:state.scene===FINAL&&trueEndingRequirements(state).every(item=>item.met)};
  next.history.push(copy(next.lastResult));next.phase='result';return next;
}
export function canRecover(state){return state.phase==='choose'&&state.scene<FINAL&&!state.recovered&&state.timeLeft>=2&&(state.stats.hp<100||state.stats.focus<100);}
export function recover(state){
  assert(canRecover(state),'この章では休息できません。休息は各章1回、残り時間2分以上で使えます。');
  const next=copy(state);next.stats.hp=clamp(next.stats.hp+10);next.stats.focus=clamp(next.stats.focus+18);next.timeLeft-=2;next.recovered=true;
  next.lastResult={kind:'recovery',scene:state.scene,choiceId:null,choiceName:'呼吸を整えて記録を見直す',approach:'balanced',useSkill:false,die:null,bonuses:{class:0,status:0,approach:0,skill:0},total:null,difficulty:null,outcome:'recovery',label:'休息',text:'壁にもたれて呼吸を整え、調査の記録を確かめた。体力と集中力を回復した。'+(next.timeLeft===0?'\n\n時計が午前0時17分を指す。最後の操作へ向かおう。':''),delta:deltas(state,next),clueIds:[],timeCost:2,trueEndingReady:false};
  next.history.push(copy(next.lastResult));next.phase='result';return next;
}
export function canContinueInvestigation(state){return state.phase==='result'&&state.scene<FINAL&&state.timeLeft>0&&state.sceneActions<2&&getScene(state).choices.some(choice=>!state.usedChoices.includes(choice.id)&&requirements(state,choice).every(item=>item.met));}
export function continueInvestigation(state){assert(canContinueInvestigation(state),'この章で続けられる調査はありません。');const next=copy(state);next.phase='choose';next.lastResult=null;return next;}
export function canAdvanceScene(state){return ['choose','result'].includes(state.phase)&&state.scene<FINAL&&(state.sceneActions>=1||(state.phase==='result'&&state.timeLeft===0));}
export function advanceScene(state){
  assert(canAdvanceScene(state),'調査を一つ行い、結果を確認してから次へ進んでください。');
  const next=copy(state);next.scene=next.timeLeft===0?FINAL:state.scene+1;next.phase='choose';next.sceneActions=0;next.skillUsed=false;next.recovered=false;next.lastResult=null;return next;
}
export function finishGame(state){
  assert(state.scene===FINAL&&state.phase==='result'&&state.lastResult?.kind==='investigation','最後の操作の結果を確認してください。');
  const choice=chosen(state,state.lastResult.choiceId),ok=['big','success'].includes(state.lastResult.outcome);
  let id='end01';
  if(choice.ending==='continue')id=ok&&state.lastResult.trueEndingReady?'end05':'end04';
  else if(choice.ending==='integrate'&&ok)id='end02';else if(choice.ending==='restore'&&ok)id='end03';
  const next=copy(state),ending=ENDINGS.find(item=>item.id===id);
  next.ending={...copy(ending),body:id==='end01'&&!(choice.ending==='stop'&&ok)?FALLBACK_ENDING_BODY:ending.body,summary:`所属：${currentClass(state).name} ／ 証拠 ${state.evidence} ／ 異常理解度 ${state.anomaly} ／ 体力 ${state.stats.hp} ／ 専門知識 ${state.stats.knowledge} ／ 集中力 ${state.stats.focus} ／ 残り ${state.timeLeft}分`,choiceId:choice.id,outcome:state.lastResult.outcome};next.done=true;next.phase='ending';return next;
}

const stateKeys=['schemaVersion','version','classId','seed','rngState','scene','phase','stats','timeLeft','evidence','anomaly','clues','history','usedChoices','sceneActions','recovered','skillUsed','lastResult','ending','done'];
const resultKeys=['kind','scene','choiceId','choiceName','approach','useSkill','die','bonuses','total','difficulty','outcome','label','text','delta','clueIds','timeCost','trueEndingReady'];
const allChoiceIds=new Set(SCENES.flatMap(scene=>scene.choices.map(choice=>choice.id)));
const exactKeys=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const short=(value,max=4000)=>typeof value==='string'&&value.length<=max;
function validateResult(result){
  assert(exactKeys(result,resultKeys),'保存した行動結果の形式を確認してください。');
  assert(['investigation','recovery'].includes(result.kind)&&integer(result.scene,0,FINAL),'保存した行動の章を確認してください。');
  assert(short(result.choiceName,200)&&short(result.text)&&short(result.label,40)&&APPROACHES.some(item=>item.id===result.approach)&&typeof result.useSkill==='boolean'&&typeof result.trueEndingReady==='boolean','保存した行動の内容を確認してください。');
  assert(exactKeys(result.bonuses,['class','status','approach','skill'])&&Object.values(result.bonuses).every(value=>integer(value,-20,20)),'保存した補正値を確認してください。');
  assert(exactKeys(result.delta,[...STATS,'evidence','anomaly','timeLeft'])&&Object.values(result.delta).every(value=>integer(value,-100,100)),'保存した状態の変化を確認してください。');
  assert(Array.isArray(result.clueIds)&&result.clueIds.length<=2&&new Set(result.clueIds).size===result.clueIds.length&&result.clueIds.every(id=>Object.hasOwn(CLUES,id))&&integer(result.timeCost,0,6),'保存した手掛かりを確認してください。');
  if(result.kind==='investigation'){
    assert(SCENES[result.scene].choices.some(item=>item.id===result.choiceId)&&integer(result.die,1,20)&&integer(result.total,-20,60)&&integer(result.difficulty,1,40)&&Object.hasOwn(outcomeLabels,result.outcome),'保存した判定を確認してください。');
    const c=SCENES[result.scene].choices.find(item=>item.id===result.choiceId);assert(c.name===result.choiceName&&c.difficulty===result.difficulty&&result.total===result.die+Object.values(result.bonuses).reduce((sum,value)=>sum+value,0)&&rollOutcome(result.die,result.total,result.difficulty)===result.outcome,'保存した判定結果が一致しません。');
  }else assert(result.scene<FINAL&&result.choiceId===null&&result.die===null&&result.total===null&&result.difficulty===null&&result.outcome==='recovery'&&result.timeCost===2,'保存した休息の内容を確認してください。');
}
export function validateState(raw){
  if(typeof raw==='string'){assert(raw.length<=100000,'セーブデータが大きすぎます。');try{raw=JSON.parse(raw);}catch{throw new Error('セーブデータを読み取れません。');}}
  assert(exactKeys(raw,stateKeys)&&raw.schemaVersion===1&&raw.version===1,'対応するセーブデータではありません。');
  assert(CLASSES.some(item=>item.id===raw.classId)&&integer(raw.seed,0,0xffffffff)&&integer(raw.rngState,0,0xffffffff)&&integer(raw.scene,0,FINAL),'学科・試験番号・章を確認してください。');
  assert(['choose','result','ending'].includes(raw.phase)&&typeof raw.done==='boolean'&&raw.done===(raw.phase==='ending')&&typeof raw.recovered==='boolean'&&typeof raw.skillUsed==='boolean','保存した進行状態を確認してください。');
  assert(exactKeys(raw.stats,STATS)&&STATS.every(id=>integer(raw.stats[id],0,100))&&integer(raw.evidence,0,100)&&integer(raw.anomaly,0,100)&&integer(raw.timeLeft,0,31)&&integer(raw.sceneActions,0,raw.scene===FINAL?1:2),'保存したステータスを確認してください。');
  assert(Array.isArray(raw.clues)&&raw.clues.length<=40&&new Set(raw.clues).size===raw.clues.length&&raw.clues.every(id=>Object.hasOwn(CLUES,id)),'保存した手掛かりを確認してください。');
  assert(Array.isArray(raw.usedChoices)&&raw.usedChoices.length<=15&&new Set(raw.usedChoices).size===raw.usedChoices.length&&raw.usedChoices.every(id=>allChoiceIds.has(id)),'保存した調査履歴を確認してください。');
  assert(Array.isArray(raw.history)&&raw.history.length<=22,'保存した記録が多すぎます。');
  for(const item of raw.history)validateResult(item);
  const investigations=raw.history.filter(item=>item.kind==='investigation');
  assert(investigations.length===raw.usedChoices.length&&investigations.every(item=>raw.usedChoices.includes(item.choiceId))&&new Set(investigations.map(item=>item.choiceId)).size===investigations.length,'調査履歴の重複または不一致があります。');
  assert(investigations.filter(item=>item.scene===raw.scene).length===raw.sceneActions&&raw.history.every(item=>item.scene<=raw.scene),'保存した章と行動回数が一致しません。');
  assert(raw.recovered===raw.history.some(item=>item.scene===raw.scene&&item.kind==='recovery')&&raw.skillUsed===investigations.some(item=>item.scene===raw.scene&&item.useSkill),'保存した章の使用回数が一致しません。');
  for(let scene=0;scene<=FINAL;scene++){assert(investigations.filter(item=>item.scene===scene).length<=(scene===FINAL?1:2)&&raw.history.filter(item=>item.scene===scene&&item.kind==='recovery').length<=1&&investigations.filter(item=>item.scene===scene&&item.useSkill).length<=1,'章ごとの行動回数が上限を超えています。');}
  if(raw.phase==='choose')assert(raw.lastResult===null&&raw.ending===null&&!raw.done&&raw.sceneActions<(raw.scene===FINAL?1:2)&&(raw.scene===FINAL||raw.timeLeft>0),'選択前の保存状態が一致しません。');
  else {validateResult(raw.lastResult);assert(raw.history.length>0&&JSON.stringify(raw.history.at(-1))===JSON.stringify(raw.lastResult)&&raw.lastResult.scene===raw.scene,'最後の行動結果が一致しません。');}
  if(raw.phase==='ending'){
    assert(exactKeys(raw.ending,['id','title','body','summary','choiceId','outcome'])&&raw.scene===FINAL&&ENDINGS.some(item=>item.id===raw.ending.id)&&short(raw.ending.summary,1000),'保存した結末を確認してください。');
    const expected=finishGame({...copy(raw),phase:'result',done:false,ending:null}).ending;
    assert(JSON.stringify(raw.ending)===JSON.stringify(expected),'保存した結末が判定と一致しません。');
  }else assert(raw.ending===null,'結末の保存状態が一致しません。');
  return copy(raw);
}
export function serialiseState(state){return JSON.stringify(validateState(state));}
