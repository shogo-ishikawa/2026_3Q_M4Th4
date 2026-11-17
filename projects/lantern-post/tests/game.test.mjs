import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const source=process.env.LANTERN_GAME_HTML??fileURLToPath(new URL('../Lantern_Post.html',import.meta.url));
const html=fs.readFileSync(source,'utf8');
const raw=html.match(/<script>([\s\S]*?)<\/script>/)[1];
class Element {
 constructor(tag='DIV'){this.tagName=tag.toUpperCase();this.children=[];this.style={setProperty(k,v){this[k]=v;}};this.dataset={};this.hidden=false;this.disabled=false;this.textContent='';this.innerHTML='';this.classList={toggle(){},add(){},remove(){}};}
 append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=[...nodes];} addEventListener(){} setAttribute(k,v){this[k]=v;} focus(){} setPointerCapture(){} querySelector(){return this.child??(this.child=new Element());}
 getBoundingClientRect(){return {left:0,top:0,width:960,height:540};}
 getContext(){return new Proxy({measureText(s){return {width:String(s).length*7};},createLinearGradient(){return {addColorStop(){}};},createRadialGradient(){return {addColorStop(){}};}},{get(o,k){return o[k]??(()=>{});}});}
}
function context({blocked=false,initial={}}={}){
const ids=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
ids.flow??=new Element('canvas');
const langs=['zh','ja'].map(l=>{const e=new Element('button');e.dataset.lang=l;return e;});
const touch=[...html.matchAll(/data-key="([^"]+)"/g)].map(m=>{const e=new Element('button');e.dataset.key=m[1];return e;});
 const storage=new Map(Object.entries(initial));const listeners={};
 const ctx={console,Date,Math:Object.assign(Object.create(Math),{random:()=>.314159}),Set,Map,JSON,Number,String,Array,Object,RegExp,Boolean,Infinity,Uint8Array,Float32Array,performance:{now:()=>0},navigator:{language:'ja-JP'},matchMedia:()=>({matches:false}),requestAnimationFrame(){},localStorage:{getItem(k){if(blocked)throw Error('blocked');return storage.get(k)??null;},setItem(k,v){if(blocked)throw Error('blocked');storage.set(k,v);}},document:{documentElement:{},hidden:false,getElementById(id){return ids[id]??(ids[id]=new Element());},createElement:t=>new Element(t),querySelectorAll(s){return s==='[data-lang]'?langs:s==='[data-key]'?touch:[];},addEventListener(){}},window:{addEventListener(k,f){listeners[k]=f;}}};
 const exposed=`\nglobalThis.__audit={startRun,startShowcase,update,press,release,openModal,closeModal,advanceDialog,chooseDialog,interact,activateRelay,hitFoe,shoot,stepBolts,buildRun,bindRun,setScene,nextChapter,finishTrip,loadStoredRun,saveGame,mainWorld,makeBoss,weaponKeys,bossDefs,switchWeapon,get state(){return {mode,run,saved,book,world,player,cores,defeated,flags,keys,auto,ext,dialog,deck,nearby,lang,storageOK};},setNearby(e){nearby=e;},setMode(v){mode=v;}};\n`;
 vm.createContext(ctx);vm.runInContext(raw.replace(/\}\)\(\);\s*$/,exposed+'})();'),ctx,{timeout:10000});
 return {api:ctx.__audit,storage,listeners,ctx,ids,langs};
}

function begin(api) {
 api.startRun('regular');
 api.switchWeapon('lantern');
 api.closeModal();
 while(api.state.mode==='dialog')api.advanceDialog();
 assert.equal(api.state.mode,'play');
}

test('日本語のタイトル画面から起動できる',()=>{
 const t=context();
 assert.equal(t.api.state.mode,'title');
 assert.equal(t.api.state.lang,'ja');
 assert.equal(t.ctx.document.documentElement.lang,'ja');
});

test('中国語と日本語を切り替えて選択を保存できる',()=>{
 const t=context();
 t.langs.find(b=>b.dataset.lang==='zh').onclick();
 assert.equal(t.api.state.lang,'zh');
 assert.equal(t.ctx.document.documentElement.lang,'zh-CN');
 assert.equal(JSON.parse(t.storage.get('lantern-post-prefs-v1')).lang,'zh');
 const reload=context({initial:Object.fromEntries(t.storage)});
 assert.equal(reload.api.state.lang,'zh');
 reload.langs.find(b=>b.dataset.lang==='ja').onclick();
 assert.equal(reload.api.state.lang,'ja');
 assert.equal(JSON.parse(reload.storage.get('lantern-post-prefs-v1')).lang,'ja');
});

test('保存を使えない環境でも配達を始められる',()=>{
 const t=context({blocked:true});
 begin(t.api);
 assert.equal(t.api.state.storageOK,false);
 t.api.update(1/60);
 assert.equal(t.api.state.mode,'play');
});

for(const [name,value]of [['壊れたJSON','{'],['不正な進行データ',JSON.stringify({version:3,level:99})]]){
 test(name+'を読み飛ばして起動できる',()=>{
  assert.equal(context({initial:{'lantern-post-save-v1':value}}).api.state.saved,null);
 });
}

for(const [name,value]of [['オブジェクト',{}],['数値',42],['真偽値',true],['文字列','quick']]){
 test('消印帳の不正な'+name+'を読み飛ばせる',()=>{
  const t=context({initial:{'lantern-post-stamps-v2':JSON.stringify({stamps:value,deliveries:[]})}});
  assert.equal(t.api.state.book.stamps.length,0);
  assert.equal(t.api.state.mode,'title');
 });
}

test('左右移動と通常ジャンプが働く',()=>{
 const {api}=context();begin(api);
 const x=api.state.player.x;
 api.press('ArrowRight');
 for(let i=0;i<60;i++)api.update(1/60);
 api.release('ArrowRight');
 assert(api.state.player.x>x+100);
 api.press('Space');api.update(1/60);
 assert(api.state.player.vy<0);
});

test('一時停止中は本編の経過時間が進まない',()=>{
 const {api}=context();begin(api);
 api.update(1/60);api.openModal('pause');
 const elapsed=api.state.run.elapsed;
 for(let i=0;i<120;i++)api.update(1/60);
 assert.equal(api.state.run.elapsed,elapsed);
 api.closeModal();api.update(1/60);
 assert(api.state.run.elapsed>elapsed);
});

test('武器と中継灯の記録を保存して復元できる',()=>{
 const {api}=context();begin(api);
 api.switchWeapon('bow');
 api.activateRelay(api.state.world.entities.find(e=>e.type==='relay'));
 api.saveGame();
 const restored=api.loadStoredRun();
 assert.equal(restored.weapon,'bow');
 assert.equal(restored.level,0);
 assert.equal(restored.relays.length,1);
 assert(Number.isFinite(restored.hp));
});

for(const version of [1,2])test('旧版v'+version+'の記録を読み込める',()=>{
 const t=context();
 const legacy=t.api.buildRun('regular',12345);
 legacy.version=version;
 delete legacy.weapon;delete legacy.charm;delete legacy.relays;
 t.storage.set('lantern-post-save-v1',JSON.stringify(legacy));
 const restored=t.api.loadStoredRun();
 assert.equal(restored.version,3);
 assert.equal(restored.level,0);
 assert.equal(restored.weapon,'lantern');
 assert.equal(restored.charm,'none');
});

test('4分デモが終幕へ到達して本編の保存を保つ',()=>{
 const t=context();begin(t.api);t.api.saveGame();
 const before=t.storage.get('lantern-post-save-v1');
 t.api.startShowcase();
 for(let i=0;i<14402;i++)t.api.update(1/60);
 const s=t.api.state;
 assert.equal(s.mode,'ending');assert.equal(s.run.elapsed,240);
 assert.equal(t.storage.get('lantern-post-save-v1'),before);
 for(const metric of ['weapon-lantern','weapon-bow','weapon-staff','weapon-fan','dodge','guard','parry','reflection','relay','double-jump','stamp','equip'])assert(s.ext.metrics.has(metric),metric);
 assert.equal([...s.ext.metrics].filter(k=>k.startsWith('boss-shown-')).length,3);
});

for(const weapon of ['lantern','bow','staff','fan'])for(let boss=0;boss<6;boss++){
 test(weapon+'の攻撃がボス'+(boss+1)+'へ届く',()=>{
  const {api}=context();begin(api);api.switchWeapon(weapon);
  const s=api.state;
  s.world.foes=[api.makeBoss(boss,300,'audit-boss')];s.world.entities=[];
  s.player.x=weapon==='staff'?220:140;s.player.y=398;s.player.face=1;
  const foe=s.world.foes[0],hp=foe.hp;foe.open=999;
  for(let i=0;i<180;i++){
   if(boss===2)s.player.y=foe.y+foe.h/2-17;
   api.shoot();api.stepBolts(1/60);
   s.player.shotTimer=Math.max(0,s.player.shotTimer-1/60);
  }
  assert(foe.hp<hp);
 });
}

for(let chapter=0;chapter<3;chapter++){
 test('第'+(chapter+1)+'章は芯・中継灯・ボスの条件を満たして進める',()=>{
  const {api}=context();
  const fresh=api.buildRun('regular',123);fresh.level=chapter;fresh.cores=[true,true,true];
  api.bindRun(fresh);api.setScene(fresh.checkpoint);
  const s=api.state,exit=s.world.entities.find(e=>e.type===(chapter===2?'keeper':'exit'));
  assert(exit);api.setNearby(exit);
  api.interact();assert.equal(s.run.level,chapter);assert.equal(api.state.mode,'play');
  for(const foe of s.world.foes)if(foe.kind==='boss')api.hitFoe(foe,999,true);
  api.interact();assert.equal(s.run.level,chapter);assert.equal(api.state.mode,'play');
  for(const relay of s.world.entities.filter(e=>e.type==='relay'))api.activateRelay(relay);
  s.cores[chapter]=false;
  api.interact();assert.equal(s.run.level,chapter);assert.equal(api.state.mode,'dialog');
  while(api.state.mode==='dialog')api.advanceDialog();
  s.cores[chapter]=true;api.setNearby(exit);api.interact();
  if(chapter<2){api.chooseDialog(0);assert.equal(api.state.run.level,chapter+1);}
  else{while(api.state.mode==='dialog')api.advanceDialog();assert.equal(api.state.mode,'ending');}
 });
}
