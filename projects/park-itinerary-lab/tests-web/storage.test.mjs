import test from 'node:test';
import assert from 'node:assert/strict';
import { renderParkMap } from '../web/map-view.js';
import { validateCatalogue, validateSavedState, parsePlanJson, saveLocal, loadLocal, createShareUrl, readSharedState, parseHistoryCsv, buildPlanJson, buildScheduleCsv, buildCalendar, buildOfflineHtml } from '../web/storage.js';

const state = () => ({parkId:'sea', settings:{date:'2026-11-17', entry:540, exit:1260, speed:65, budget:10000, foodBudget:3000, dpaBudget:4000, souvenirReserve:1000, crowdMode:'estimate', crowdLevel:'normal', weather:'sun', budgetPreference:'balanced', restEvery:90, restMinutes:10, searchSeconds:3, selections:[{id:'test-ride', weight:5, required:true, dpaMode:'owned', dpaStart:600, dpaEnd:660}]}, result:{rows:[{kind:'walk', name:'入口から移動', start:540, end:550, metres:600, cost:0}, {kind:'activity', name:'青い海のアトラクション', start:600, end:610, dpa:true, cost:2000}], totals:{cost:2000}}, history:[{date:'2026-11-10', activityId:'test-ride', time:600, wait:35}]});
const park = () => ({id:'sea', name:'東京ディズニーシー', officialUrl:'https://www.tokyodisneyresort.jp/tds/', mapUrl:'https://www.tokyodisneyresort.jp/tds/map.html', entryNode:'entrance', exitNode:'entrance', nodes:[{id:'entrance',name:'入口',x:500,y:900},{id:'centre',name:'中央',x:500,y:500}], edges:[{from:'entrance',to:'centre',metres:500}], activities:[{id:'test-ride',name:'テスト',node:'centre',area:'港',category:'attraction',duration:10,baseWait:30,cost:0,windows:[[540,1260]],showTimes:[],sourceUrl:'https://www.tokyodisneyresort.jp/tds/',dpa:{price:2000,wait:10,kind:'attraction'},access:'normal'}],events:[]});
const catalogue = () => {const a=park(),b=park();b.id='land';b.name='東京ディズニーランド';return {version:'1.0.0',updatedAt:'2026-11-17',sources:[{label:'公式',url:'https://www.tokyodisneyresort.jp/'}],parks:[b,a]};};

test('日本語の共有リンクは希望のみを往復し結果・履歴は持ち出さない', () => {
  const initial=state();initial.settings.selections[0].note='海をゆっくり楽しむ';
  const url=createShareUrl(initial,'https://example.org/app/?mode=day#old');
  const shared=readSharedState(new URL(url).hash);
  assert.deepEqual(shared.settings,initial.settings);assert.equal(shared.parkId,'sea');
  assert.equal(shared.result,undefined);assert.equal(shared.history,undefined);
  initial.settings.history=initial.history;const portable=readSharedState(new URL(createShareUrl(initial,'https://example.org')).hash);assert.equal(portable.settings.history,undefined);
  assert.equal(readSharedState('#workspace'),null);assert.throws(()=>readSharedState('#plan=%%%'));
  assert.throws(()=>readSharedState('#plan='+ 'A'.repeat(14001)));
});

test('JSONは予定・購入枠・履歴を保ち危険なキーと壊れた時刻を拒む', () => {
  const value=state();value.settings.purchases=[{id:'test-ride',kind:'attraction',purchasedAt:550,start:600,end:660,cost:2000}];
  const restored=parsePlanJson(buildPlanJson(value));assert.deepEqual(restored.settings,value.settings);assert.deepEqual(restored.result,value.result);
  assert.throws(()=>parsePlanJson('{"__proto__":{}}'),/キー/);
  for(const patch of [{entry:1300},{date:'2026-02-30'},{budget:1099},{speed:0},{searchSeconds:NaN},{selections:[{id:'test',weight:6}]}]) {const bad=state();Object.assign(bad.settings,patch);assert.throws(()=>validateSavedState(bad));}
  assert.throws(()=>parsePlanJson('{"format":"other","version":1}'));
  const bad=state();bad.settings.purchases=[{id:'x',kind:'show',purchasedAt:500,start:600,end:590,cost:1000}];assert.throws(()=>validateSavedState(bad));
});

test('端末保存は同じ予定を復元し保存拒否を成功扱いしない', () => {
  const values=new Map();globalThis.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  assert.equal(loadLocal(),null);assert.equal(saveLocal(state()),true);assert.equal(loadLocal().result.rows[1].name,'青い海のアトラクション');
  globalThis.localStorage={getItem:()=>'{bad',setItem:()=>{throw new Error('quota');}};
  assert.throws(()=>saveLocal(state()),/保存できません/);assert.throws(()=>loadLocal(),/開けません/);delete globalThis.localStorage;
});

test('履歴CSVは引用付きの列・BOM・CRLFを読み込んで実際の日付と待ち時間を検証', () => {
  const csv='\uFEFFdate,activityId,time,wait,weather,event\r\n2026-11-10,test-ride,10:30,35,sun,"event, winter"\r\n2026-11-11,test-ride,650,12.5,rain,"a ""quote"""\r\n';
  const rows=parseHistoryCsv(csv);assert.equal(rows.length,2);assert.equal(rows[0].time,630);assert.equal(rows[0].event,'event, winter');assert.equal(rows[1].event,'a "quote"');assert.equal(rows[1].wait,12.5);
  for(const body of ['2026-02-30,test,12:00,20','2026-11-17,test,25:00,20','2026-11-17,test,12:80,20','2026-11-17,test,12:00,-1','2026-11-17,test,12:00,Infinity','2026-11-17,test,12:00,601','2026-11-17,test,12:00,20,extra']) assert.throws(()=>parseHistoryCsv('date,activityId,time,wait\n'+body));
  assert.throws(()=>parseHistoryCsv('date,activityId,time,wait\n"2026-11-17,test,12:00,20'));
  assert.throws(()=>parseHistoryCsv('date,date,time,wait\n2026-11-17,test,600,20'));
});

test('施設更新は入口からの接続・重複ID・料金・時間帯・URLを検証', () => {
  assert.equal(validateCatalogue(catalogue()).parks.length,2);
  const disconnected=catalogue();disconnected.parks[0].edges=[];assert.throws(()=>validateCatalogue(disconnected),/通路/);
  const duplicate=catalogue();duplicate.parks[0].activities.push({...duplicate.parks[0].activities[0]});assert.throws(()=>validateCatalogue(duplicate));
  const badWindow=catalogue();badWindow.parks[1].activities[0].windows=[[700,600]];assert.throws(()=>validateCatalogue(badWindow));
  const badDpa=catalogue();badDpa.parks[1].activities[0].dpa.price=1999;assert.throws(()=>validateCatalogue(badDpa));
  const unsafe=catalogue();unsafe.parks[0].mapUrl='javascript:alert(1)';assert.throws(()=>validateCatalogue(unsafe));
});

test('CSVは数式の注入を防ぎ引用符と改行を保存する', () => {
  const value=state();value.result.rows[1].name='=HYPERLINK("https://example.org")\n次の行';
  const output=buildScheduleCsv(value.result);assert.ok(output.startsWith('\uFEFF'));assert.match(output,/"'=HYPERLINK\(""https:\/\/example.org""\)\n次の行"/);
});

test('カレンダーは日本時間をUTCへ変換し日をまたぐ時刻と日本語の折り返しを保つ', () => {
  const value=state();value.result.rows=[{kind:'activity',name:'夕食, 予約; 確認\n'+ '海辺の予定'.repeat(20),start:1380,end:1440,cost:1000}];
  const output=buildCalendar(value.result,park(),value.settings);
  assert.match(output,/DTSTART:20261117T140000Z/);assert.match(output,/DTEND:20261117T150000Z/);assert.match(output,/SUMMARY:夕食\\, 予約\\; 確認\\n/);
  for(const line of output.split('\r\n')) assert.ok(new TextEncoder().encode(line).length<=75);
  assert.equal((output.match(/BEGIN:VEVENT/g)||[]).length,1);
});

test('持ち歩くHTMLは外部通信なしで予定を表示し名前のHTMLを無効化する', () => {
  const value=state();value.result.rows[1].name='<script>alert("x")</script><img src=x onerror=alert(1)>';
  const output=buildOfflineHtml(value.result,park(),value.settings);
  assert.ok(output.includes('&lt;script&gt;'));assert.ok(!output.includes('<script>'));assert.ok(!output.includes('<img'));
  assert.ok(output.includes('公式の園内マップを開く'));assert.ok(output.includes('type="checkbox"'));assert.ok(output.includes('2026-11-17'));
  assert.ok(!output.includes('<link '));assert.ok(!output.includes('fetch('));
});


test('地図は通路上の経路と体験順を描き施設名をHTMLとして解釈しない', () => {
  const data=park(); data.activities[0].name='<img src=x onerror=alert(1)>';
  const events={}; const marker={dataset:{activityId:'test-ride'},addEventListener:(name,callback)=>{events[name]=callback;}};
  const container={innerHTML:'',querySelectorAll:()=>[marker]}; let selected=null;
  renderParkMap(container,data,{plan:{rows:[{kind:'walk',path:['entrance','centre'],name:'移動',metres:500}],visits:[{activityId:'test-ride'}]},selectedIds:['test-ride'],onSelect:id=>{selected=id;}});
  assert.ok(container.innerHTML.includes('points="500,900 500,500"'));assert.ok(container.innerHTML.includes('予定1'));assert.ok(container.innerHTML.includes('&lt;img'));assert.ok(!container.innerHTML.includes('<img'));
  events.click();assert.equal(selected,'test-ride');selected=null;let prevented=false;events.keydown({key:' ',preventDefault:()=>{prevented=true;}});assert.equal(selected,'test-ride');assert.equal(prevented,true);
});


test('移動施設の降車地点・鑑賞地点・当日の現在地変更を保存できる', () => {
  const value=state();value.settings.selections[0].nodeOverride='centre';value.settings.selections[0].dpaPurchasedAt=550;value.settings.currentNode='centre';
  value.result.rows.push({kind:'location',name:'現在地を変更',start:700,end:700,node:'centre',from:'entrance',to:'centre'});
  value.result.visits=[{id:'test-ride',node:'entrance',endNode:'centre',start:600,end:610}];
  assert.equal(parsePlanJson(buildPlanJson(value)).result.rows.at(-1).kind,'location');
  const invalid=structuredClone(value);invalid.result.rows.at(-1).node='<script>';assert.throws(()=>validateSavedState(invalid));
  const invalidTime=structuredClone(value);invalidTime.result.rows.at(-1).end=710;assert.throws(()=>validateSavedState(invalidTime));
  const invalidOverride=structuredClone(value);invalidOverride.settings.selections[0].nodeOverride='bad id';assert.throws(()=>validateSavedState(invalidOverride));
  const data=catalogue();data.parks[0].activities[0].endNode='missing';assert.throws(()=>validateCatalogue(data));
});
