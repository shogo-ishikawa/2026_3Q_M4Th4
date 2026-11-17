import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MAX_SAVED_PLANS,listSavedPlans,saveNamedPlan,loadSavedPlan,renameSavedPlan,deleteSavedPlan,saveLocal,loadLocal,validateSavedState,buildPlanJson,parsePlanJson,createShareUrl,readSharedState} from '../web/storage.js';

const key='park-itinerary-lab:plans:v1';
const legacyKey='park-itinerary-lab:v1';
const state=(parkId='land',date='2026-11-18')=>({parkId,settings:{date,entry:540,exit:1260,speed:70,budget:10000,selections:[{id:parkId+'-ride',weight:4}]},result:{rows:[{kind:'activity',name:'体験',start:600,end:610}]}});
const store=()=>{const values=new Map();return {values,getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,value)};};
const options=(storage,now='2026-11-17T12:00:00Z')=>({storage,now});

test('named plans keep independent states and duplicate names never overwrite another ID',()=>{
 const storage=store();assert.deepEqual(listSavedPlans({storage}),[]);
 const a=saveNamedPlan(' 冬の一日 ',state(),options(storage));
 const b=saveNamedPlan('冬の一日',state('sea','2026-11-20'),options(storage,'2026-11-17T13:00:00Z'));
 assert.notEqual(a.id,b.id);assert.equal(a.name,'冬の一日');assert.equal(a.createdAt,'2026-11-17T12:00:00.000Z');
 assert.deepEqual(listSavedPlans({storage}).map(x=>[x.id,x.parkId,x.date,x.hasSchedule]),[[b.id,'sea','2026-11-20',true],[a.id,'land','2026-11-18',true]]);
 assert.deepEqual(loadSavedPlan(a.id,{storage}),state());assert.deepEqual(loadSavedPlan(b.id,{storage}),state('sea','2026-11-20'));
 const changed=loadSavedPlan(a.id,{storage});changed.settings.date='2026-11-30';assert.equal(loadSavedPlan(a.id,{storage}).settings.date,'2026-11-18');
});
test('overwriting and renaming require stable IDs and preserve creation timestamps',()=>{
 const storage=store(),first=saveNamedPlan('最初の計画',state(),options(storage));
 const changed=state('sea');const updated=saveNamedPlan('更新した計画',changed,{...options(storage,'2026-11-17T14:00:00Z'),id:first.id});
 assert.equal(updated.id,first.id);assert.equal(updated.createdAt,first.createdAt);assert.equal(updated.updatedAt,'2026-11-17T14:00:00.000Z');assert.deepEqual(loadSavedPlan(first.id,{storage}),changed);
 const renamed=renameSavedPlan(first.id,'海で過ごす日',options(storage,'2026-11-17T15:00:00Z'));assert.equal(renamed.name,'海で過ごす日');assert.equal(renamed.createdAt,first.createdAt);assert.deepEqual(loadSavedPlan(first.id,{storage}),changed);
 assert.throws(()=>saveNamedPlan('存在しない',state(),{...options(storage),id:'plan-missing'}),/見つかりません/);
 assert.throws(()=>renameSavedPlan('plan-missing','名前',options(storage)),/見つかりません/);
 assert.throws(()=>loadSavedPlan('plan-missing',{storage}),/見つかりません/);
 assert.equal(listSavedPlans({storage}).length,1);
});
test('delete removes only the selected plan and does not silently recreate it',()=>{
 const storage=store(),a=saveNamedPlan('A',state(),options(storage)),b=saveNamedPlan('B',state('sea'),options(storage));
 assert.equal(deleteSavedPlan(a.id,options(storage)),true);assert.equal(deleteSavedPlan(a.id,options(storage)),false);
 assert.deepEqual(listSavedPlans({storage}).map(x=>x.id),[b.id]);assert.throws(()=>loadSavedPlan(a.id,{storage}),/見つかりません/);
});
test('single-plan legacy storage remains readable and imports once without deleting its original key',()=>{
 const storage=store();storage.setItem(legacyKey,buildPlanJson(state()));const original=storage.values.get(legacyKey);
 const before=new Map(storage.values);const old=listSavedPlans({storage})[0];assert.equal(old.id,'legacy-v1');assert.equal(old.legacy,true);assert.equal(old.createdAt,null);assert.deepEqual(storage.values,before);
 assert.deepEqual(loadSavedPlan(old.id,{storage}).settings,state().settings);
 const newPlan=saveNamedPlan('新しい計画',state('sea'),options(storage));const entries=listSavedPlans({storage});assert.equal(entries.length,2);assert.ok(entries.find(x=>x.id===old.id).createdAt);
 assert.equal(storage.getItem(legacyKey),original);assert.equal(deleteSavedPlan(old.id,options(storage)),true);assert.deepEqual(listSavedPlans({storage}).map(x=>x.id),[newPlan.id]);
 assert.equal(deleteSavedPlan(newPlan.id,options(storage)),true);assert.deepEqual(listSavedPlans({storage}),[]);assert.equal(storage.getItem(legacyKey),original);
 globalThis.localStorage=storage;assert.equal(loadLocal().parkId,'land');delete globalThis.localStorage;
});
test('legacy plan can be renamed or replaced explicitly while preserving its stable ID',()=>{
 const storage=store();storage.setItem(legacyKey,buildPlanJson(state()));
 const renamed=renameSavedPlan('legacy-v1','以前の旅行',options(storage));assert.equal(renamed.id,'legacy-v1');assert.equal(listSavedPlans({storage})[0].name,'以前の旅行');
 saveNamedPlan('次の旅行',state('sea'),{...options(storage,'2026-11-18T12:00:00Z'),id:'legacy-v1'});assert.equal(loadSavedPlan('legacy-v1',{storage}).parkId,'sea');
 assert.equal(JSON.parse(storage.getItem(legacyKey)).parkId,'land');
});
test('invalid names and states cannot alter an existing named library',()=>{
 const storage=store();saveNamedPlan('有効な計画',state(),options(storage));const before=storage.getItem(key);
 for(const name of ['', '   ','x'.repeat(81),'改行\nの名前',null])assert.throws(()=>saveNamedPlan(name,state(),options(storage)),/名前/);
 const invalid=state();invalid.settings.entry=1300;assert.throws(()=>saveNamedPlan('壊れた計画',invalid,options(storage)));
 assert.equal(storage.getItem(key),before);
 const name=saveNamedPlan('<em>名前</em>',state(),options(storage));assert.equal(name.name,'<em>名前</em>');
});
test('malformed stored entries or legacy states remain untouched instead of resetting the library',()=>{
 for(const raw of ['{bad',JSON.stringify({format:'other',version:1,plans:[]}),JSON.stringify({format:'park-itinerary-lab-library',version:1,plans:[{id:'bad',name:'壊れた計画',createdAt:'yesterday',updatedAt:'today',state:state()}]})]){
  const storage=store();storage.setItem(key,raw);assert.throws(()=>listSavedPlans({storage}),/元の保存データを保持/);assert.throws(()=>saveNamedPlan('上書きしない',state(),options(storage)));assert.equal(storage.getItem(key),raw);
 }
 const storage=store();storage.setItem(legacyKey,'{bad');assert.throws(()=>listSavedPlans({storage}),/以前に保存/);assert.equal(storage.getItem(legacyKey),'{bad');assert.equal(storage.getItem(key),null);
});
test('duplicated IDs and invalid nested saved-state fields are rejected without discarding any record',()=>{
 const storage=store();saveNamedPlan('計画',state(),options(storage));const library=JSON.parse(storage.getItem(key));library.plans.push({...library.plans[0]});const duplicate=JSON.stringify(library);storage.setItem(key,duplicate);assert.throws(()=>listSavedPlans({storage}));assert.equal(storage.getItem(key),duplicate);
 library.plans.pop();library.plans[0].state.settings.selections[0].weight=100;const invalid=JSON.stringify(library);storage.setItem(key,invalid);assert.throws(()=>listSavedPlans({storage}));assert.equal(storage.getItem(key),invalid);
});
test('quota refusal preserves previous plans for save, rename, delete and legacy import',()=>{
 const storage=store(),a=saveNamedPlan('変更前',state(),options(storage));const before=new Map(storage.values);storage.setItem=()=>{throw new Error('QuotaExceededError');};
 for(const action of [()=>saveNamedPlan('新規',state(),options(storage)),()=>saveNamedPlan('更新',state('sea'),{...options(storage),id:a.id}),()=>renameSavedPlan(a.id,'新名',options(storage)),()=>deleteSavedPlan(a.id,options(storage))]){assert.throws(action,/前の計画は保持/);assert.deepEqual(storage.values,before);}
 const legacy=store();legacy.setItem(legacyKey,buildPlanJson(state()));legacy.setItem=()=>{throw Error('quota');};assert.throws(()=>saveNamedPlan('新規',state('sea'),options(legacy)),/前の計画は保持/);assert.equal(listSavedPlans({storage:legacy})[0].id,'legacy-v1');
});
test('saved-plan limits require deliberate deletion and never evict an older plan',()=>{
 const storage=store();for(let i=0;i<MAX_SAVED_PLANS;i++)saveNamedPlan('計画'+i,state(),options(storage));const before=storage.getItem(key);
 assert.throws(()=>saveNamedPlan('上限外',state(),options(storage)),new RegExp(MAX_SAVED_PLANS+'件'));assert.equal(storage.getItem(key),before);assert.equal(listSavedPlans({storage}).length,MAX_SAVED_PLANS);
});
test('unavailable browser storage reports an actionable error and clock changes do not reverse update order',()=>{
 assert.throws(()=>listSavedPlans({storage:{getItem(){throw Error('blocked');},setItem(){}}}),/保存設定/);assert.throws(()=>listSavedPlans({storage:null}),/JSON/);
 const storage=store(),a=saveNamedPlan('未来の時刻',state(),options(storage,'2026-11-18T00:00Z'));const b=renameSavedPlan(a.id,'時計を戻した後',options(storage,'2026-11-17T00:00Z'));assert.equal(b.updatedAt,a.updatedAt);
});
test('named plans keep congestion choices and removed rests while reloading current live status',()=>{
 const value=state();value.settings.liveNotice='稼働状況を確認しました。';value.settings.walkCrowdMode='estimate';value.settings.waitAsOf=Date.parse('2026-11-17T12:00Z');value.settings.excludedAutoBreaks=['land-hub:land-ride'];
 value.settings.liveData={schemaVersion:1,provider:'themeparks-wiki',parkId:'land',fetchedAt:'2026-11-17T12:00Z',rides:[{activityId:'land-ride',providerId:100,name:'アトラクション',wait:0,isOpen:false,updatedAt:'2026-11-17T12:00Z',changedAt:'2026-11-17T11:55Z',status:'DOWN'}],unmatched:[]};
 value.result.rows=[{kind:'walk',name:'混雑する通路',start:540,end:560,walkingFactor:1.5,walkingSource:'congestion-estimate'},{kind:'rest',name:'ひと休み',start:560,end:570,autoBreakId:'land-hub:land-ride'}];
 const storage=store(),a=saveNamedPlan('当日プラン',value,options(storage));const restored=loadSavedPlan(a.id,{storage});assert.equal(restored.settings.liveData,undefined);assert.equal(restored.settings.liveNotice,undefined);assert.equal(restored.settings.waitAsOf,undefined);assert.equal(restored.settings.walkCrowdMode,'estimate');assert.deepEqual(restored.settings.excludedAutoBreaks,value.settings.excludedAutoBreaks);assert.deepEqual(restored.result.rows,value.result.rows);assert.equal(value.settings.liveData.provider,'themeparks-wiki');
 for(const patch of [{walkCrowdMode:'bad'},{excludedAutoBreaks:['not a valid key']},{excludedAutoBreaks:['a:b','a:b']},{waitAsOf:Infinity},{liveNotice:'x'.repeat(1501)}]){const bad=structuredClone(value);Object.assign(bad.settings,patch);assert.throws(()=>validateSavedState(bad));}
 const bad=structuredClone(value);bad.result.rows[0].walkingFactor=4;assert.throws(()=>validateSavedState(bad));
});
test('named snapshots remove duplicated training records and model caches throughout nested prior plans',()=>{
 const value=state();const model=JSON.parse(readFileSync(new URL('../web/data/wait-model.json',import.meta.url),'utf8')).parks.find(p=>p.parkId==='land');const calendar=JSON.parse(readFileSync(new URL('../web/data/calendar.json',import.meta.url),'utf8'));
 const source={history:[{date:'2026-11-17',activityId:'land-ride',time:600,wait:25}],waitModel:model,calendarData:calendar,liveSnapshot:{provider:'themeparks-wiki',rides:[{name:'raw source'}]},waitAsOf:Date.parse('2026-11-17T12:00Z'),liveNotice:'取得済み'};
 value.history=source.history;Object.assign(value.settings,source);value.result.settings={...source};value.settings.initialPlan={settings:{...source},rows:[{kind:'activity',name:'済んだ体験',start:600,end:610}]};value.parkStates={sea:{settings:{...source}}};
 value.settings.purchases=[{id:'land-ride',kind:'attraction',purchasedAt:550,start:650,end:710,cost:2000}];value.settings.fixedBreaks=[{id:'rest-1',node:'land-hub',label:'休憩',start:720,duration:10}];
 const before=JSON.stringify(value),storage=store(),saved=saveNamedPlan('持ち歩く計画',value,options(storage));const restored=loadSavedPlan(saved.id,{storage});
 for(const target of [restored,restored.settings,restored.result.settings,restored.settings.initialPlan.settings,restored.parkStates.sea.settings])for(const key of Object.keys(source))assert.equal(target[key],undefined,key);
 assert.deepEqual(restored.settings.purchases,value.settings.purchases);assert.deepEqual(restored.settings.fixedBreaks,value.settings.fixedBreaks);assert.deepEqual(restored.settings.initialPlan.rows,value.settings.initialPlan.rows);assert.equal(JSON.stringify(value),before);assert.equal(storage.getItem(key).includes('raw source'),false);
});
test('a full record cache is not copied into every named plan and the legacy saver omits raw ThemeParks feeds',()=>{
 const value=state();value.history=Array.from({length:50000},()=>({date:'2026-11-17',activityId:'land-ride',time:600,wait:25}));const storage=store();
 saveNamedPlan('学習記録のある日の計画',value,options(storage));assert.ok(storage.getItem(key).length<2000);assert.equal(value.history.length,50000);assert.equal(listSavedPlans({storage}).length,1);
 const live={schemaVersion:1,provider:'themeparks-wiki',parkId:'land',fetchedAt:'2026-11-17T12:00Z',rides:[],unmatched:[]};const legacy=state();legacy.settings.liveData=live;legacy.result.settings={liveData:live};globalThis.localStorage=storage;saveLocal(legacy);const restored=loadLocal();delete globalThis.localStorage;
 assert.equal(restored.settings.liveData,undefined);assert.equal(restored.result.settings.liveData,undefined);assert.deepEqual(restored.result.rows,legacy.result.rows);assert.equal(legacy.settings.liveData,live);
});
test('downloaded plan JSON omits ThemeParks raw live feeds at every nested snapshot while preserving the derived plan',()=>{
 const value=state();const live={schemaVersion:1,provider:'themeparks-wiki',parkId:'land',fetchedAt:'2026-11-17T12:00Z',rides:[{activityId:'land-ride',providerId:100,name:'アトラクション',wait:25,isOpen:true,updatedAt:'2026-11-17T12:00Z'}],unmatched:[]};
 value.settings.liveData=live;value.result.settings={liveData:live};value.parkStates={land:{settings:{liveData:live}}};const decoded=parsePlanJson(buildPlanJson(value));
 assert.equal(decoded.settings.liveData,undefined);assert.equal(decoded.result.settings.liveData,undefined);assert.equal(decoded.parkStates.land.settings.liveData,undefined);assert.deepEqual(decoded.result.rows,value.result.rows);assert.equal(value.settings.liveData,live);
 const queue=structuredClone(value);queue.settings.liveData.provider='queue-times';assert.equal(parsePlanJson(buildPlanJson(queue)).settings.liveData.provider,'queue-times');
});

test('private saved stops survive offline reopening while shared and exported snapshots omit dynamic operating holds',()=>{
 const value=state('land','2026-11-17');const holds={date:'2026-11-17',activityIds:['land-ride'],observedAt:'2026-11-17T12:00Z'};value.settings.operationalHolds=holds;value.result.settings={operationalHolds:holds};value.result.rows=[{kind:'walk',name:'入園後の移動',start:540,end:550,walkSpeed:50,walkingFactor:1.3,walkingSource:'congestion-estimate'}];
 const storage=store(),saved=saveNamedPlan('当日の計画',value,options(storage));const restored=loadSavedPlan(saved.id,{storage});assert.deepEqual(restored.settings.operationalHolds,holds);assert.equal(restored.result.rows[0].walkSpeed,50);assert.equal(restored.settings.liveData,undefined);
 const exported=parsePlanJson(buildPlanJson(value));assert.equal(exported.settings.operationalHolds,undefined);assert.equal(exported.result.settings.operationalHolds,undefined);assert.deepEqual(exported.result.rows,value.result.rows);
 const shared=readSharedState(new URL(createShareUrl(value,'https://example.org/app/')).hash);assert.equal(shared.settings.operationalHolds,undefined);
 for(const patch of [{date:'2026-11-18'},{activityIds:['sea-ride']},{activityIds:['land-ride','land-ride']},{observedAt:'2030-01-01T00:00Z'},{observedAt:'2026-11-16T12:00Z'},{activityIds:Array.from({length:401},(_,i)=>'land-'+i)}]){const bad=structuredClone(value);Object.assign(bad.settings.operationalHolds,patch);assert.throws(()=>validateSavedState(bad),/運営停止/);}
 for(const walkSpeed of [0,151,'50']){const bad=structuredClone(value);bad.result.rows[0].walkSpeed=walkSpeed;assert.throws(()=>validateSavedState(bad),/速さ/);}
 globalThis.localStorage=storage;saveLocal(value);assert.deepEqual(loadLocal().settings.operationalHolds,holds);delete globalThis.localStorage;
});
test('unknown ThemeParks wait values remain distinct from zero and queue-times still requires numeric waits',()=>{
 const value=state('land','2026-11-17');value.settings.liveData={schemaVersion:1,provider:'themeparks-wiki',parkId:'land',fetchedAt:'2026-11-17T12:00Z',rides:[{activityId:'land-ride',providerId:100,name:'稼働中',wait:null,isOpen:true,status:'OPERATING',updatedAt:'2026-11-17T12:00Z'}],unmatched:[]};
 assert.equal(validateSavedState(value),value);const invalid=structuredClone(value);invalid.settings.liveData.provider='queue-times';assert.throws(()=>validateSavedState(invalid),/待ち時間/);
});
test('long-history model sample metadata can exceed 50000 without expanding stored named plans',()=>{
 const value=state();const original=JSON.parse(readFileSync(new URL('../web/data/wait-model.json',import.meta.url),'utf8')).parks.find(p=>p.parkId==='land');value.settings.waitModel={...original,schemaVersion:1,coefficients:Array(original.activityIds.length+7).fill(0),samples:125000,availableSamples:130000};assert.equal(validateSavedState(value),value);
 const storage=store(),saved=saveNamedPlan('長期モデルを使った計画',value,options(storage));assert.equal(loadSavedPlan(saved.id,{storage}).settings.waitModel,undefined);
 for(const availableSamples of [100,NaN,Number.MAX_SAFE_INTEGER+1]){const bad=structuredClone(value);bad.settings.waitModel.availableSamples=availableSamples;assert.throws(()=>validateSavedState(bad),/学習期間|有限/);}
});
