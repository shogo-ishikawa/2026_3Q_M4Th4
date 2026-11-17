import { initialiseExternalData, fetchPublishedCatalogue, fetchPublishedCalendar, fetchPublishedModel, prepareLiveForReplan, prepareWeatherForVisit } from './wait-data.js';
import { renderParkMap } from './map-view.js';
import { listSavedPlans, saveNamedPlan, loadSavedPlan, renameSavedPlan, deleteSavedPlan, createShareUrl, readSharedState, downloadPlanJson, downloadScheduleCsv, downloadCalendar, downloadOfflineHtml, parseHistoryCsv, validateCatalogue, parsePlanJson } from './storage.js';

const CATEGORY = {attraction:'アトラクション',show:'ショー',parade:'パレード',restaurant:'レストラン',cafe:'カフェ',snack:'スナック',popcorn:'ポップコーン',greeting:'グリーティング',shop:'お土産'};
const FOOD = new Set(['restaurant','cafe','snack','popcorn']);
const ENTERTAINMENT = new Set(['show','parade']);
const GENRES = [{id:'all',label:'すべて'},{id:'attraction',label:'アトラクション'},{id:'entertainment',label:'ショー・パレード'},{id:'dining',label:'レストラン・カフェ'},{id:'snacks',label:'スナック・ポップコーン'},{id:'greeting',label:'グリーティング'},{id:'shop',label:'お土産'}];
export const genreOf = category => ['restaurant','cafe'].includes(category)?'dining':['snack','popcorn'].includes(category)?'snacks':ENTERTAINMENT.has(category)?'entertainment':category;
const WEIGHT_LABELS = {1:'気軽に',2:'できれば',3:'行きたい',4:'かなり行きたい',5:'最優先'};
const WAIT_LABELS = {manual:'手動の待ち時間',live:'当日の公開待ち時間',ml:'学習モデルの予測',history:'履歴からの推定',trend:'傾向モデル',dpa:'DPAの入場準備'};
const SEARCH_LABELS = {beam:'ビーム探索',multistart:'多点スタート探索',portfolio:'組合せ探索'};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => `${Math.round(Number(n) || 0).toLocaleString('ja-JP')}円`;
const minute = text => { if (!/^\d{2}:\d{2}$/.test(text)) throw Error('時刻を入力してください。'); const [h,m] = text.split(':').map(Number); if(h>23||m>59)throw Error('時刻を確認してください。'); return h*60+m; };
const timeText = value => Number.isFinite(Number(value)) ? `${String(Math.floor(Number(value)/60)).padStart(2,'0')}:${String(Math.round(Number(value)%60)).padStart(2,'0')}` : '—';
const menuNames = activity => Array.isArray(activity.menuItems)?activity.menuItems.filter(item=>item&&typeof item.name==='string').map(item=>item.name):[];
const safeLink = url => { try {const u = new URL(url);return ['https:','http:'].includes(u.protocol)?escapeHtml(u.href):'#';}catch{return '#';} };
const $ = id => document.getElementById(id);
const defaultDate = () => { const now = new Date();return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); };
export const defaultSettings = () => ({date:defaultDate(),entry:540,exit:1260,speed:70,budget:12000,foodBudget:5000,dpaBudget:5000,souvenirReserve:2000,souvenirMode:'reserve',budgetPreference:'balanced',crowdMode:'estimate',crowdLevel:'normal',weather:'sun',weatherMode:'auto',walkCrowdMode:'estimate',weatherForecast:null,selections:[],restEvery:90,restMinutes:10,searchSeconds:15,searchMethod:'portfolio',fixedBreaks:[],excludedAutoBreaks:[],spentBudget:0,purchases:[],history:[]});

/** The two planning steps share a location but retain independent panel state. */
export function setWorkflowTab(root,name,{focus=false}={}) {
  if(!['wishlist','schedule'].includes(name))throw new RangeError('表示するタブを確認してください。');
  for(const key of ['wishlist','schedule']){
    const suffix=key==='wishlist'?'Wishlist':'Schedule',tab=root.getElementById(`workflow${suffix}Tab`),panel=root.getElementById(`workflow${suffix}`),active=key===name;
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;panel.hidden=!active;
    if(active&&focus)tab.focus();
  }
  return name;
}

/** A selected facility card is a toggle, including when its conditions have changed. */
export function toggleWantedSelection(settings,selection) {
  const exists=settings.selections.some(item=>item.id===selection.id);
  settings.selections=exists?settings.selections.filter(item=>item.id!==selection.id):[...settings.selections,selection];
  return !exists;
}

/** Deleting one automatic rest keeps the rest of the break policy unchanged. */
export function removePlannedRest(settings,row) {
  if(!row||row.preserved||(row.kind||row.type)!=='rest')return false;
  if(row.fixedBreakId){const before=(settings.fixedBreaks||[]).length;settings.fixedBreaks=(settings.fixedBreaks||[]).filter(item=>item.id!==row.fixedBreakId);return before!==settings.fixedBreaks.length;}
  if(row.autoBreakId){settings.excludedAutoBreaks=[...new Set([...(settings.excludedAutoBreaks||[]),row.autoBreakId])];return true;}
  return false;
}

/** Keep the newest facts while retaining the outcome of the latest refresh attempt. */
export function chooseCatalogue(bundled,published) {
  const usable=published&&published.pipelineVersion>=2;
  const versionParts=value=>/^\d+\.\d+(?:\.\d+)?$/.test(value||'')?value.split('.').map(Number):null;
  const previous=versionParts(bundled.version),next=versionParts(published?.version);
  const compatible=published?.version===bundled.version||!!(previous&&next&&[0,1,2].reduce((comparison,index)=>comparison||((next[index]||0)-(previous[index]||0)),0)>=0);
  const selected=usable&&compatible&&Date.parse(published.fetchedAt)>=Date.parse(bundled.fetchedAt||bundled.updatedAt)?published:bundled;
  const latest=[bundled,...(usable?[published]:[])].filter(item=>Number.isFinite(Date.parse(item.refreshAttempt?.checkedAt))).sort((a,b)=>Date.parse(b.refreshAttempt.checkedAt)-Date.parse(a.refreshAttempt.checkedAt))[0];
  if(latest&&latest!==selected&&Date.parse(latest.refreshAttempt.checkedAt)>=Date.parse(selected.fetchedAt||selected.updatedAt))return {...selected,refreshAttempt:latest.refreshAttempt,updateStatus:latest.updateStatus};
  return selected;
}

export function catalogueRefreshNotice(catalogue) {
  const attempt=catalogue.refreshAttempt;
  if(!attempt||!Number.isFinite(Date.parse(attempt.checkedAt)))return '';
  const checked=new Date(attempt.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
  if(attempt.status==='failed')return ` 更新確認 ${checked}：公式サイトから取得できませんでした。前回確認済みの情報を使用しています。`;
  if(attempt.status==='partial')return ` 更新確認 ${checked}：一部の公式情報を取得できず、その項目は前回の情報を保持しています。`;
  return '';
}

/** A different visit date starts a fresh day; DPA purchases belong to one day. */
export function resetForNewVisitDay(state) {
  state.settings.purchases=[];state.settings.spentBudget=0;state.settings.excludedAutoBreaks=[];
  for(const key of ['replanFrom','currentNode','completedIds','weatherForecast','weatherNotice','liveData','liveNotice','waitAsOf','operationalHolds'])delete state.settings[key];
  for(const selection of state.settings.selections){
    selection.dpaMode='none';
    for(const key of ['dpaStart','dpaEnd','dpaPurchasedAt','dpaAvailableWindows','nodeOverride','viewingNode'])delete selection[key];
  }
  state.result=null;state.resultDirty=false;state.parkStates={};
  return state;
}


/** Fetch the visit day's weather before planning; manual and failure paths cannot reuse an old forecast. */
export async function prepareWeatherForPlan(settings,park,options={}) {
  return prepareWeatherForVisit(settings,park,options);
}


export function activitySchedule(activity,date) {
  const daily=activity.dailySchedules?.[date];
  const confirmed=!!daily||activity.showTimesDate===date;
  const closed=!!daily?.closed||!!activity.closed||(activity.closedDates||[]).includes(date)||(activity.closedPeriods||[]).some(period=>period.startDate<=date&&(!period.endDate||date<=period.endDate));
  return {date:daily?date:activity.showTimesDate,confirmed,closed,windows:daily?.windows||activity.windows||[],showTimes:daily?.showTimes||(activity.showTimesDate===date?activity.showTimes||[]:[])};
}

export function foodLinks(activity) {
  if(!FOOD.has(activity.category))return '';
  const menuUrl=safeLink(activity.menuUrl||activity.sourceUrl);
  const items=menuNames(activity).slice(0,3).map(escapeHtml).filter(Boolean);
  return `<div class="food-information"><p>${items.length?items.join(' / '):'販売メニューと場所は公式ページで確認できます。'}</p><div><a href="${safeLink(activity.sourceUrl)}" target="_blank" rel="noopener noreferrer">店舗・売り場 ↗</a><a href="${menuUrl}" target="_blank" rel="noopener noreferrer">メニューを見る ↗</a></div>${activity.menuCheckedOn?`<small>メニュー確認 ${escapeHtml(activity.menuCheckedOn)}</small>`:''}</div>`;
}

export function initialiseApp() {
  let catalogue, calendarData, externalPanel, preparation = null, worker = null, requestId = 0, searchStarted = 0, progressTimer = null, latestPreview = null, wishlistGenre = 'all', lastBreakSuggestionResult = null, workflowView = 'wishlist', openedPlanId = null;
  const modelCache=new Map();
  let state = {parkId:'land',settings:defaultSettings(),result:null,history:[],parkStates:{}};
  const currentPark = () => catalogue.parks.find(p => p.id === state.parkId) || catalogue.parks[0];
  const activities = () => currentPark().activities;
  const byId = id => activities().find(a => a.id === id);
  const setStatus = (message,error = false) => { $('status').textContent=message; $('status').classList.toggle('is-error',error);if($('workflowStatus')){$('workflowStatus').textContent=message;$('workflowStatus').classList.toggle('is-error',error);} };
  const safely = action => async(...args) => { try {await action(...args);}catch(error){setStatus(error.message || '入力を確認してもう一度試してください。',true);} };
  const numberInput = (id,min,max,step=1) => {const n=Number($(id).value);if(!Number.isFinite(n)||n<min||n>max||!Number.isInteger(n/step))throw Error(`${$(id).closest('label')?.textContent.trim().split('\n')[0] || id}を確認してください。`);return n;};
  const selected = id => state.settings.selections.find(s => s.id === id);

  function showWorkflow(name,{focus=false,scroll=false}={}) {
    workflowView=setWorkflowTab(document,name,{focus});
    if(scroll)$('workflowTabs').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function updateDayOverview(){
    const s=state.settings,speed=s.speed===50?'ゆっくり':s.speed===90?'早め':'普通';
    $('dayOverview').textContent=`予算 ${money(s.budget)} · 歩く速さ ${speed} · ${s.restEvery&&s.restMinutes?`約${s.restEvery}分ごとに休憩`:'自動休憩なし'}`;
    $('livePlanStatus').textContent=s.liveNotice||'';$('livePlanStatus').hidden=!s.liveNotice;
  }
  function renderSavedPlans(){
    let plans;try{plans=listSavedPlans();}catch(error){$('savedPlanCount').textContent='利用できません';$('savedPlanList').textContent='このブラウザの保存領域を利用できません。計画JSONで保存できます。';$('savedPlanStatus').textContent=error.message;return;}$('savedPlanCount').textContent=`${plans.length}件`;
    $('overwritePlan').hidden=!openedPlanId;
    $('savedPlanList').innerHTML=plans.length?plans.map(plan=>`<article class="saved-plan-card${plan.id===openedPlanId?' is-open':''}" data-saved-plan="${escapeHtml(plan.id)}"><div><strong>${escapeHtml(plan.name)}</strong><p>${plan.parkId==='sea'?'シー':'ランド'} · ${escapeHtml(plan.date)} · ${plan.hasSchedule?'しおりあり':'希望の条件'} · ${plan.updatedAt?escapeHtml(new Date(plan.updatedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})):'以前の保存'}</p></div><div class="saved-plan-actions"><button type="button" data-load-saved="${escapeHtml(plan.id)}">開く</button><button type="button" data-rename-saved="${escapeHtml(plan.id)}">名前を変更</button><button type="button" data-delete-saved="${escapeHtml(plan.id)}">削除</button></div><div class="saved-plan-rename" hidden><label>計画の名前<input type="text" maxlength="80" value="${escapeHtml(plan.name)}" data-saved-name="${escapeHtml(plan.id)}"></label><button type="button" data-commit-rename="${escapeHtml(plan.id)}">変更を保存</button></div></article>`).join(''):'<p class="field-note">保存した計画はまだありません。名前を付けて保存するとここに並びます。</p>';
  }
  function showSavedPlans(forSaving=false){
    $('savedPlansPanel').open=true;renderSavedPlans();
    if(forSaving){if(!$('planName').value.trim())$('planName').value=`${state.settings.date} ${state.parkId==='sea'?'シー':'ランド'}`;$('planName').focus();}
    $('savedPlansPanel').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function saveCurrentPlan(overwrite=false){
    readSettings();const summary=saveNamedPlan($('planName').value,state,overwrite&&openedPlanId?{id:openedPlanId}:{});
    openedPlanId=summary.id;renderSavedPlans();$('savedPlanStatus').textContent=`「${summary.name}」を${overwrite?'上書き':'新しく'}保存しました。`;setStatus('名前を付けた計画をこの端末に保存しました。');
  }
  function stopSearch(keepBest = false) {
    requestId++;
    if(preparation){preparation.abort();preparation=null;}
    if(worker){worker.terminate();worker=null;}
    clearInterval(progressTimer);progressTimer=null;
    $('solveButton').disabled=false;$('cancelSearch').hidden=true;$('searchProgress').hidden=true;$('scheduleEmptyText').textContent=state.result?'':'まだ計画は作成されていません。希望を選び、プランを考えてみましょう。';
    if(keepBest && latestPreview){state.result=latestPreview;state.resultDirty=false;renderResult();renderMap();}
  }
  function markResultStale(){if(worker||preparation){stopSearch();setStatus('条件を変更したため探索を止めました。新しい条件でプランを考えてください。');}if(state.result){state.resultDirty=true;renderResult();}}
  function rememberOwnedPurchase(selection){
    if(selection.dpaMode!=='owned'||!Number.isInteger(selection.dpaStart)||!Number.isInteger(selection.dpaEnd)||!Number.isInteger(selection.dpaPurchasedAt)||selection.dpaStart>=selection.dpaEnd||selection.dpaPurchasedAt>selection.dpaStart)return;
    const activity=byId(selection.id);if(!activity?.dpa)return;const purchases=state.settings.purchases||[];const existing=purchases.find(p=>p.id===selection.id);const purchase={id:selection.id,kind:activity.dpa.kind||'attraction',purchasedAt:selection.dpaPurchasedAt,start:selection.dpaStart,end:selection.dpaEnd,cost:existing?.cost ?? activity.dpa.price};
    if(existing)Object.assign(existing,purchase);else purchases.push(purchase);state.settings.purchases=purchases;renderPurchaseHistory();
  }
  function readSettings() {
    for(const selection of state.settings.selections)rememberOwnedPurchase(selection);
    const settings={...state.settings,date:$('visitDate').value,entry:minute($('entryTime').value),exit:minute($('exitTime').value),weather:$('weather').value,weatherMode:$('weatherMode').value,speed:numberInput('walkSpeed',20,150),restEvery:numberInput('restEvery',0,480),restMinutes:numberInput('restMinutes',0,60),searchSeconds:numberInput('searchSeconds',1,120),searchMethod:$('searchMethod').value,budget:numberInput('budget',0,1000000,100),foodBudget:numberInput('foodBudget',0,1000000,100),dpaBudget:numberInput('dpaBudget',0,1000000,100),souvenirReserve:numberInput('souvenirReserve',0,1000000,100),souvenirMode:$('souvenirMode').value,budgetPreference:$('budgetPreference').value,crowdMode:$('crowdMode').value,crowdLevel:$('crowdLevel').value,history:state.history || [],spentBudget:numberInput('spentBudget',0,1000000,100)};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(settings.date))throw Error('訪問日を指定してください。');
    if(settings.entry>=settings.exit)throw Error('退園予定は入園予定より後にしてください。');
    if(settings.souvenirReserve>settings.budget)throw Error('お土産に残す金額が予算を超えています。');
    settings.purchases=Array.isArray(state.settings.purchases)?state.settings.purchases:[];
    if($('replanEnabled').checked){settings.replanFrom=minute($('replanTime').value);settings.currentNode=$('currentNode').value;if(settings.replanFrom<settings.entry||settings.replanFrom>=settings.exit)throw Error('組み替え開始は入園から退園までの間にしてください。');}else{delete settings.replanFrom;delete settings.currentNode;}
    if(settings.weatherMode==='manual'){settings.weatherForecast=null;settings.weatherNotice='天気は手動の設定を使います。';}
    else if(state.settings.weatherMode==='manual'){settings.weatherForecast=null;settings.weatherNotice='プランを考えると訪問日の予報を取得します。';}
    state.settings=settings;return settings;
  }
  function writeSettings() {
    const s=state.settings;
    $('walkSpeed').querySelector('[data-custom-speed]')?.remove();if(![50,70,90].includes(Number(s.speed))){const option=document.createElement('option');option.value=s.speed;option.textContent=`指定した速さ（${s.speed} m/分）`;option.dataset.customSpeed='true';$('walkSpeed').append(option);}
    $('searchSeconds').querySelector('[data-custom-duration]')?.remove();if(![5,15,30,60,120].includes(Number(s.searchSeconds))){const option=document.createElement('option');option.value=s.searchSeconds;option.textContent=`指定した上限（${s.searchSeconds}秒）`;option.dataset.customDuration='true';$('searchSeconds').append(option);}
    for(const [id,key] of Object.entries({visitDate:'date',weather:'weather',weatherMode:'weatherMode',walkSpeed:'speed',restEvery:'restEvery',restMinutes:'restMinutes',searchSeconds:'searchSeconds',searchMethod:'searchMethod',budget:'budget',foodBudget:'foodBudget',dpaBudget:'dpaBudget',souvenirReserve:'souvenirReserve',souvenirMode:'souvenirMode',budgetPreference:'budgetPreference',crowdMode:'crowdMode',crowdLevel:'crowdLevel',spentBudget:'spentBudget'}))$(id).value=String(s[key] ?? defaultSettings()[key]);
    $('weatherStatus').textContent=s.weatherNotice||(s.weatherMode==='manual'?'天気は手動の設定を使います。':'プランを考えると訪問日の予報を取得します。取得できない場合は選択した天気で計画します。');
    $('entryTime').value=timeText(s.entry);$('exitTime').value=timeText(s.exit);$('replanEnabled').checked=Number.isInteger(s.replanFrom);$('replanTime').value=timeText(s.replanFrom ?? 840);renderPurchaseHistory();renderFixedBreaks();updateDayOverview();
  }
  function cleanState(value) {
    if(!value || typeof value!=='object'||!catalogue.parks.some(p=>p.id===value.parkId)||!value.settings || !Array.isArray(value.settings.selections))throw Error('この計画データの形式を確認してください。');
    const park=catalogue.parks.find(p=>p.id===value.parkId),ids=new Set(park.activities.map(a=>a.id));
    const selections=value.settings.selections.filter(s=>s&&typeof s==='object'&&ids.has(s.id));
    return {parkId:value.parkId,settings:{...defaultSettings(),...value.settings,selections},result:value.result||null,resultDirty:!!value.resultDirty,history:Array.isArray(value.history)?value.history:[],parkStates:{}};
  }
  function updateContext() {
    const park=currentPark(),s=state.settings;if(calendarData&&!s.calendarData)s.calendarData=calendarData;if(s.waitModel?.parkId===park.id)modelCache.set(park.id,s.waitModel);else if(modelCache.has(park.id))s.waitModel=modelCache.get(park.id);
    document.body.dataset.park=state.parkId;
    $('landTab').setAttribute('aria-selected',String(state.parkId==='land'));$('seaTab').setAttribute('aria-selected',String(state.parkId==='sea'));
    $('landTab').tabIndex=state.parkId==='land'?0:-1;$('seaTab').tabIndex=state.parkId==='sea'?0:-1;
    $('officialMapLink').href=park.mapUrl || park.officialUrl;$('officialParkLink').href=park.officialUrl;
    const short=state.parkId==='sea'?'tds':'tdl';$('dailyLink').href=`https://www.tokyodisneyresort.jp/${short}/daily/calendar/${s.date.replaceAll('-','')}/`;
    $('currentNode').replaceChildren();
    for(const node of park.nodes){const option=document.createElement('option');option.value=node.id;option.textContent=node.name || node.id;$('currentNode').append(option);}
    $('currentNode').value=s.currentNode || park.entryNode;
    const breakNode=$('breakNode').value;$('breakNode').replaceChildren();
    for(const node of park.nodes){const option=document.createElement('option');option.value=node.id;option.textContent=node.name||node.id;$('breakNode').append(option);}
    $('breakNode').value=park.nodes.some(n=>n.id===breakNode)?breakNode:park.entryNode;renderFixedBreaks();
    const purchaseId=$('purchaseActivity').value;$('purchaseActivity').replaceChildren();for(const a of park.activities.filter(a=>a.dpa)){const option=document.createElement('option');option.value=a.id;option.textContent=a.name;$('purchaseActivity').append(option);}$('purchaseActivity').value=park.activities.some(a=>a.id===purchaseId&&a.dpa)?purchaseId:park.activities.find(a=>a.dpa)?.id||'';if(byId($('purchaseActivity').value)?.dpa)$('purchaseCost').value=byId($('purchaseActivity').value).dpa.price;renderPurchaseHistory();
    $('dataVersion').textContent=`施設・イベントの確認日：${catalogue.updatedAt || park.updatedAt || 'データ内の出典を確認'} / データ版 ${catalogue.version || '—'}。フードの予算は変更できます。施設・休止・イベントは毎朝6:15に更新を確認し、学習モデルは毎日21:55に再学習します。${catalogue.fetchedAt?` 最終取得 ${new Date(catalogue.fetchedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}`:''}${catalogueRefreshNotice(catalogue)}`;
    updateDayOverview();updateCrowd();renderCatalogue();renderWishlist();renderMap();renderResult();
    document.dispatchEvent(new CustomEvent('park-context-change',{detail:{park,settings:state.settings,history:state.history}}));
  }
  function renderPurchaseHistory(){if(!catalogue)return;const purchases=state.settings.purchases||[];$('purchaseHistory').innerHTML=purchases.length?purchases.map((p,index)=>`<div class="purchase-item"><strong>${escapeHtml(byId(p.id)?.name||p.id)}</strong><p>購入 ${timeText(p.purchasedAt)} · 利用 ${timeText(p.start)}–${timeText(p.end)} · ${money(p.cost)}</p><button type="button" data-remove-purchase="${index}">履歴から外す</button></div>`).join(''):'<p class="field-note">購入履歴はまだありません。</p>';}
  function updateCrowd() {
    $('weatherStatus').textContent=state.settings.weatherNotice||(state.settings.weatherMode==='manual'?'天気は手動の設定を使います。':'プランを考えると訪問日の予報を取得します。');updateDayOverview();
    const s=state.settings,events=(currentPark().events||[]).filter(e=>e.startDate<=s.date&&e.endDate>=s.date);
    $('eventBadges').replaceChildren();
    for(const event of events){const span=document.createElement('span');span.textContent=event.name;$('eventBadges').append(span);}
    const manual=s.crowdMode==='manual';
    $('crowdExplanation').textContent=manual?'希望ごとの「待ち時間」を使います。当日の表示に合わせて変更できます。':'当日の新しい公開待ち時間、検証で改善した学習モデル、履歴の順で使います。記録がない部分は曜日・時間帯・天気・開催イベントの傾向モデルで補います。';
    $('historyStatus').textContent=`待ち時間の実績データ：${state.history?.length ? `${state.history.length}件を読込済み` : '未読込'}`;
  }
  function renderCatalogue() {
    const query=$('catalogueSearch').value.trim().toLocaleLowerCase('ja'),category=$('categoryFilter').value;
    const list=activities().filter(a=>`${a.name} ${a.area} ${menuNames(a).join(' ')}`.toLocaleLowerCase('ja').includes(query)&&(category==='all'||category==='food'&&FOOD.has(a.category)||category==='dining'&&['restaurant','cafe'].includes(a.category)||category==='snacks'&&['snack','popcorn'].includes(a.category)||category==='entertainment'&&ENTERTAINMENT.has(a.category)||a.category===category));
    $('catalogue').innerHTML=list.length?list.map(a=>`<article class="place-card genre-${genreOf(a.category)}${selected(a.id)?' selected':''}"><button class="place-select" type="button" data-add="${escapeHtml(a.id)}" aria-pressed="${!!selected(a.id)}" aria-label="${escapeHtml(a.name)}を希望${selected(a.id)?'から外す':'に追加'}"${activitySchedule(a,state.settings.date).closed&&!selected(a.id)?' disabled':''}><span class="place-kind">${escapeHtml(CATEGORY[a.category]||a.category)}${activitySchedule(a,state.settings.date).closed?' · 訪問日は休止予定':''}</span><strong>${escapeHtml(a.name)}</strong><span class="place-meta"><span>${escapeHtml(a.area||'')}${a.dpa?' / DPA':''}</span><span class="place-plus">${selected(a.id)?'✓':'＋'}</span></span></button>${foodLinks(a)}</article>`).join(''):'<p class="empty-message">条件に合う施設がありません。検索条件を変えてみましょう。</p>';
    $('selectionCount').textContent=`${state.settings.selections.length}件の希望`;
  }
  function addSelection(id) {
    const a=byId(id);if(!a)return;if(selected(id)){toggleWantedSelection(state.settings,{id});markResultStale();renderCatalogue();renderWishlist();renderMap();setStatus(`${a.name}を希望から外しました。`);return;}if(activitySchedule(a,state.settings.date).closed){setStatus(`${a.name}は訪問日に休止予定です。別の日や施設を選んでください。`,true);return;}
    if(!selected(id)){
      const s={id,weight:3,required:false,dpaMode:'none',manualWait:Number(a.baseWait)||0,cost:Math.ceil((Number(a.cost)||0)/100)*100,duration:a.duration};
      if(FOOD.has(a.category)){
        const late=state.settings.entry>=900;s.earliest=late?Math.max(1020,state.settings.entry):660;s.latest=late?1200:840;
        if(a.category==='snack'||a.category==='popcorn'||a.category==='cafe'){s.earliest=state.settings.entry;s.latest=state.settings.exit;}
      }
      if(ENTERTAINMENT.has(a.category)){const schedule=activitySchedule(a,state.settings.date);s.showTimes=schedule.showTimes.slice();s.confirmSchedule=schedule.confirmed;}
      toggleWantedSelection(state.settings,s);if(wishlistGenre!=='all')wishlistGenre=genreOf(a.category);markResultStale();renderCatalogue();renderWishlist();renderMap();setStatus(`${a.name}を希望に追加しました。`);
    }
  }
  function suggestedSelection() {
    state.settings.selections=[];
    const presets=state.parkId==='land' ? [
      [['美女と野獣','プーさんのハニーハント','ビッグサンダー・マウンテン','カリブの海賊'],4],
      [['ハングリーベア・レストラン','チャイナボイジャー','トゥモローランド・テラス'],1],
      [['ル・プティポッパー','ビレッジペイストリー','スキッパーズ・ギャレー'],1],
      [['グランドエンポーリアム','ワールドバザール・コンフェクショナリー'],1],
    ] : [
      [['アナとエルサのフローズンジャーニー','ソアリン','トイ・ストーリー・マニア','センター・オブ・ジ・アース'],4],
      [['ヴォルケイニア・レストラン','ユカタン・ベースキャンプ・グリル','カスバ・フードコート'],1],
      [['シーサイドスナック','リフレッシュメント・ステーション','サルタンズ・オアシス'],1],
      [['エンポーリオ','マクダックス・デパートメントストア'],1],
    ];
    const date=state.settings.date;
    const available=activities().filter(a=>(!a.access||a.access==='normal')&&!activitySchedule(a,date).closed&&(!a.startDate||a.startDate<=date)&&(!a.endDate||date<=a.endDate));
    for(const [names,count] of presets){let added=0;for(const name of names){const activity=available.find(a=>a.name.includes(name));if(activity&&!selected(activity.id)){addSelection(activity.id);added++;if(added===count)break;}}}
    wishlistGenre='all';renderWishlist();markResultStale();setStatus('人気のアトラクションと食事、おやつ、お土産を組み合わせました。重要度を調整して一日の計画を試してみましょう。');
  }
  function renderWishlist() {
    const all=state.settings.selections;
    const list=all.filter(s=>wishlistGenre==='all'||genreOf(byId(s.id)?.category)===wishlistGenre);
    $('wishlistTabs').innerHTML=GENRES.map(g=>{const count=all.filter(s=>g.id==='all'||genreOf(byId(s.id)?.category)===g.id).length;return `<button type="button" id="wishTab-${g.id}" class="genre-tab genre-${g.id}" role="tab" aria-controls="wishlist" aria-selected="${wishlistGenre===g.id}" tabindex="${wishlistGenre===g.id?0:-1}" data-wish-genre="${g.id}">${g.label}<span>${count}</span></button>`;}).join('');
    $('wishlist').setAttribute('aria-labelledby',`wishTab-${wishlistGenre}`);
    $('wishlist').innerHTML=list.length?list.map(s=>{
      const a=byId(s.id);if(!a)return '';
      const timed=FOOD.has(a.category),show=ENTERTAINMENT.has(a.category),greeting=a.category==='greeting',paid=FOOD.has(a.category)||a.category==='shop';
      const schedule=activitySchedule(a,state.settings.date),scheduleCurrent=schedule.confirmed;
      const dpa=a.dpa;
      return `<article class="wish-card genre-${genreOf(a.category)}" data-wish-id="${escapeHtml(s.id)}"><div class="wish-heading"><div><p class="wish-category">${escapeHtml(CATEGORY[a.category]||a.category)} / ${escapeHtml(a.area||'')}</p><h4>${escapeHtml(a.name)}</h4></div><button class="remove-wish" data-remove="${escapeHtml(s.id)}" type="button" aria-label="${escapeHtml(a.name)}を希望から外す">×</button></div>${foodLinks(a)}${schedule.closed?'<p class="schedule-note">訪問日は休止予定です。別の日や施設を検討してください。</p>':''}<div class="wish-main-controls"><div class="weight-control"><span>重要度 <strong>${s.weight} · ${escapeHtml(WEIGHT_LABELS[s.weight]||'行きたい')}</strong></span><div class="weight-buttons" role="group" aria-label="${escapeHtml(a.name)}の重要度">${[1,2,3,4,5].map(w=>`<button type="button" class="weight-button${Number(s.weight)===w?' active':''}" data-weight="${w}" data-for="${escapeHtml(s.id)}" aria-pressed="${Number(s.weight)===w}" aria-label="重要度${w}：${WEIGHT_LABELS[w]}" title="${WEIGHT_LABELS[w]}">${w}</button>`).join('')}</div></div><label class="check-field"><input type="checkbox" data-field="required"${s.required?' checked':''}>必ず入れる</label></div><div class="wish-fields">${timed?`<label>この時刻から<input type="time" data-field="earliest" value="${timeText(s.earliest ?? state.settings.entry)}"></label><label>この時刻までに終了<input type="time" data-field="latest" value="${timeText(s.latest ?? state.settings.exit)}"></label>`:''}${paid?`<label>${a.category==='shop'?'使いたい金額':'フードの予算'}<input type="number" min="0" max="1000000" step="100" data-field="cost" value="${escapeHtml(s.cost ?? a.cost ?? 0)}" aria-label="${escapeHtml(a.name)}の予算（円）"></label>`:''}<label>体験・滞在（待ち時間を除く）<input type="number" min="1" max="360" step="1" data-field="duration" value="${escapeHtml(s.duration ?? a.duration)}" aria-label="${escapeHtml(a.name)}の滞在時間（分）"></label><label>待ち時間（手動時）<input type="number" min="0" max="360" step="5" data-field="manualWait" value="${escapeHtml(s.manualWait ?? a.baseWait)}" aria-label="${escapeHtml(a.name)}の待ち時間（分）"></label></div>${show?`<div class="schedule-note">公演時刻：${scheduleCurrent?`${escapeHtml(schedule.date)}の公式時刻を表示しています。`:'訪問日の公式情報を確認して入力してください。'}${a.showTimesDate?` 収録データの確認日 ${escapeHtml(a.showTimesDate)}`:''}${a.scheduleNote?` ${escapeHtml(a.scheduleNote)}`:''}</div><label class="full-field">訪問日の開演時刻（例 11:00, 13:30）<input type="text" data-field="showTimes" value="${escapeHtml((s.showTimes||[]).map(timeText).join(', '))}" placeholder="11:00, 13:30"></label><label class="check-field section-gap"><input type="checkbox" data-field="confirmSchedule"${s.confirmSchedule?' checked':''}>この日の公演時刻を確認した</label>`:''}${a.access&&a.access!=='normal'?`<div class="access-note"><label><input type="checkbox" data-field="confirmedAccess"${s.confirmedAccess?' checked':''}>${a.access==='entry'?'エントリー受付の結果・入場条件を確認した':'予約・利用条件を確認した'}</label></div>`:''}${greeting?'<p class="wish-foot">グリーティングの実施時間や対象キャラクターは公式情報で確認できます。</p>':''}${dpa?`<details class="wish-details"${s.dpaMode&&s.dpaMode!=='none'?' open':''}><summary>DPA・時間指定を設定　${money(dpa.price)}</summary><label class="full-field">DPAをどう使う？<select data-field="dpaMode"><option value="none"${s.dpaMode==='none'?' selected':''}>通常の待ち列で利用</option><option value="consider"${s.dpaMode==='consider'?' selected':''}>購入できる枠を候補にする</option><option value="owned"${s.dpaMode==='owned'?' selected':''}>取得済みの枠を使う</option><option value="unavailable"${s.dpaMode==='unavailable'?' selected':''}>利用しない・売り切れ</option></select></label><div class="wish-fields"><label>利用・入場開始<input type="time" data-field="dpaStart" value="${s.dpaStart==null?'':timeText(s.dpaStart)}"></label><label>利用・入場終了<input type="time" data-field="dpaEnd" value="${s.dpaEnd==null?'':timeText(s.dpaEnd)}"></label><label>取得済み：購入した時刻<input type="time" data-field="dpaPurchasedAt" value="${s.dpaPurchasedAt==null?'':timeText(s.dpaPurchasedAt)}"></label></div>${a.category==='parade'?`<label class="full-field">DPAの集合・鑑賞場所<select data-field="nodeOverride"><option value="">公式アプリの場所を選ぶ</option>${currentPark().nodes.map(n=>`<option value="${escapeHtml(n.id)}"${s.nodeOverride===n.id?' selected':''}>${escapeHtml(n.name||n.id)}</option>`).join('')}</select></label>`:''}<p class="wish-foot">公式アプリで確認した取得済み枠・購入可能な枠を入力します。取得済みの予定は必ず含めます。アトラクションとショーの購入間隔を別々に考慮します。</p></details>`:''}<details class="wish-details"><summary>営業時間を調整する</summary><p class="wish-foot">${escapeHtml(a.dailySchedules?.[state.settings.date]?state.settings.date:a.operatingDate||a.windowsDate||'収録データ')}の営業時間を基準に計算します。訪問日の営業に合わせて変更できます。</p><div class="wish-fields"><label>営業開始<input type="time" data-field="windowStart" value="${timeText(s.windows?.[0]?.[0] ?? schedule.windows?.[0]?.[0] ?? state.settings.entry)}"></label><label>営業終了<input type="time" data-field="windowEnd" value="${timeText(s.windows?.[0]?.[1] ?? schedule.windows?.[0]?.[1] ?? state.settings.exit)}"></label></div></details><p class="wish-foot"><a href="${safeLink(a.sourceUrl)}" target="_blank" rel="noopener noreferrer">施設・時間・利用条件を公式情報で確認 ↗</a>${a.operatingDate?` · 営業時間確認 ${escapeHtml(a.operatingDate)}`:''}</p></article>`;
    }).join(''):all.length?'<p class="empty-message">このジャンルの希望はまだありません。施設カードから追加できます。</p>':'<p class="empty-message">地図や施設カードから行きたい場所を選んでください。</p>';
  }
  function updateSelection(event) {
    const target=event.target,card=target.closest('[data-wish-id]');if(!card||!target.dataset.field)return;
    const s=selected(card.dataset.wishId);if(!s)return;
    const key=target.dataset.field;
    if(target.type==='checkbox')s[key]=target.checked;
    else if(['earliest','latest','dpaStart','dpaEnd','dpaPurchasedAt'].includes(key)){if(!target.value){delete s[key];}else{s[key]=minute(target.value);}}
    else if(['windowStart','windowEnd'].includes(key)){const a=byId(s.id);const window=(s.windows?.[0]||activitySchedule(a,state.settings.date).windows?.[0]||[state.settings.entry,state.settings.exit]).slice();window[key==='windowStart'?0:1]=minute(target.value);if(window[0]>=window[1])throw Error('営業終了を開始より後にしてください。');s.windows=[window];}
    else if(key==='showTimes'){s.showTimes=target.value.split(/[,、\s]+/).filter(Boolean).map(minute);}
    else if(target.type==='number'){const value=Number(target.value);if(!Number.isInteger(value)||value<Number(target.min||0)||value>Number(target.max||1000000)||(key==='cost'&&value%100!==0))throw Error('金額は100円単位、時間は0以上の整数で入力してください。');s[key]=value;}
    else s[key]=target.value;
    if(['dpaStart','dpaEnd','dpaMode'].includes(key))s.dpaAvailableWindows=s.dpaMode==='consider'&&Number.isInteger(s.dpaStart)&&Number.isInteger(s.dpaEnd)?[[s.dpaStart,s.dpaEnd]]:[];
    if(['dpaStart','dpaEnd','dpaMode','dpaPurchasedAt'].includes(key))rememberOwnedPurchase(s);
    if(key==='dpaMode'){if(s.dpaMode==='owned')s.required=true;renderWishlist();}markResultStale();
  }
  function renderMap(){ if(catalogue)renderParkMap($('parkMap'),currentPark(),{plan:state.result,selectedIds:state.settings.selections.map(s=>s.id),onSelect:addSelection}); }
  function renderResult() {
    const result=state.result;$('results').hidden=!result;$('scheduleEmpty').hidden=!!result;if(!result)return;renderFixedBreaks();
    const t=result.totals||{},c=result.coverage||{};
    $('resultState').textContent=state.resultDirty?'前の条件で作った計画':result.status==='feasible'?'見つかった計画':result.status==='no-plan'?'条件を見直そう':'入力を確認';
    const percent=Number(c.percent)||0;
    $('resultSummary').innerHTML=`<div class="metric"><strong>${Math.round(percent)}<small>%</small></strong><span>希望の重要度を反映</span></div><div class="metric"><strong>${escapeHtml(c.count ?? result.visits?.length ?? 0)}<small> / ${escapeHtml(c.totalCount ?? state.settings.selections.length)}</small></strong><span>予定に入った希望</span></div><div class="metric"><strong>${(Number(t.walkingMetres||0)/1000).toFixed(1)}<small> km</small></strong><span>歩く距離の目安</span></div><div class="metric"><strong>${Math.round(Number(t.cost)||0).toLocaleString('ja-JP')}<small>円</small></strong><span>予定の支出合計</span></div>`;
    const planSettings=result.settings||state.settings;
    $('resultExplanation').textContent=result.status==='feasible'?`${state.resultDirty?'条件を変更しています。現在の希望で再探索してください。 ':''}${planSettings.date} ${timeText(planSettings.entry)}–${timeText(planSettings.exit)} の計画。重要度 ${c.weight ?? t.score ?? 0} / ${c.totalWeight ?? 0}。フード ${money(t.foodCost)} · DPA ${money(t.dpaCost)} · お土産 ${money(t.shoppingCost)}。残り ${money(t.budgetRemaining)}（お土産への配分 ${money(t.souvenirAllocation)}）。探索で見つかった実行可能な案です。`:'時間や予算に収まる計画が見つかりませんでした。必須の希望・食事の時間帯・公演枠を見直してください。';
    $('timeline').innerHTML=(result.rows||[]).map((row,index)=>{
      const kind=row.kind||row.type||'activity',a=byId(row.activityId),duration=Number(row.end)-Number(row.start);
      const name=row.name || ({walk:'徒歩で移動',wait:'時間を調整',queue:'待ち列',rest:'ひと休み',exit:'退園へ'}[kind]) || a?.name || '予定';
      const details=[];if(row.fixedBreakId)details.push('指定した休憩');if(row.waitSource)details.push(WAIT_LABELS[row.waitSource]||row.waitSource);if(row.metres)details.push(`${Math.round(row.metres)} m`);if(duration>=0)details.push(`${duration}分`);if(Number(row.cost)>0)details.push(money(row.cost));if(a?.area)details.push(a.area);
      return `<article class="timeline-row kind-${escapeHtml(kind)}"><div class="timeline-time">${timeText(row.start)}<small>– ${timeText(row.end)}</small></div><div class="timeline-body"><h4>${escapeHtml(name)}${row.dpa?'<span class="dpa-pill">DPA</span>':''}</h4><p>${escapeHtml(details.join(' · '))}</p>${kind==='rest'&&!row.preserved&&(row.fixedBreakId||row.autoBreakId)?`<button class="remove-timeline-rest" data-remove-rest-index="${index}" type="button" aria-label="${timeText(row.start)}の休憩を外して再探索">この休憩を外す</button>`:''}${row.walkingFactor>1?'<p class="walking-note">混雑・時間帯・天気を加えた移動時間の目安</p>':''}${a?`<a class="row-link" href="${safeLink(a.sourceUrl)}" target="_blank" rel="noopener noreferrer">公式 ↗</a>`:''}</div></article>`;
    }).join('');
    const omissions=result.omissions||[];$('omissionTitle').textContent=`入らなかった希望 · ${omissions.length}件`;
    $('omissionList').innerHTML=omissions.length?omissions.map(o=>`<div class="omission-item"><span>↗</span><div><strong>${escapeHtml(o.name || byId(o.id)?.name || o.id)}${o.required?' · 必須':''}</strong><p>${escapeHtml(o.reason||'時間・予算・利用枠の条件に合わせて他の希望を優先しました。')}</p></div></div>`).join(''):'<p class="field-note">希望をすべて予定に取り入れられました。</p>';
    const d=result.diagnostics||{};
    const notes=Array.isArray(d.notes)?d.notes:[String(d.notes||'')];
    $('diagnosticList').innerHTML=`<p>${escapeHtml(SEARCH_LABELS[planSettings.searchMethod||'beam'])} · 探索時間 ${(Number(d.elapsedMs||0)/1000).toFixed(2)}秒 · 調べた状態 ${Number(d.expanded||0).toLocaleString('ja-JP')}件。${d.timedOut?'設定した探索時間で打ち切りました。':'設定した範囲の探索を終えました。'}厳密な最適性の証明は行っていません。</p><p>待ち時間：${escapeHtml((d.waitSources?.length?d.waitSources:[d.waitSource||'trend']).map(key=>WAIT_LABELS[key]||key).join('・'))}。移動 ${t.walkMinutes||0}分 · 待ち時間 ${t.waitMinutes||0}分 · 休憩 ${t.restMinutes||0}分。</p><ul>${notes.filter(Boolean).map(n=>`<li>${escapeHtml(typeof n==='object'?JSON.stringify(n):n)}</li>`).join('')}</ul><p>DPAの候補は購入できる枠を入力したものです。購入前に公式アプリの販売状況を確認し、取得後は希望を「取得済み」に更新してください。</p>`;
    for(const id of ['exportCsv','exportIcs','exportHtml','printPlan'])$(id).disabled=result.status!=='feasible';
  }
  function renderFixedBreaks() {
    if(!catalogue)return;
    const breaks=(state.settings.fixedBreaks||[]).slice().sort((a,b)=>a.start-b.start);
    $('fixedBreakList').innerHTML=breaks.length?breaks.map(b=>`<div class="fixed-break-item"><div><strong>${timeText(b.start)}–${timeText(b.start+b.duration)} · ${escapeHtml(b.label||'ひと休み')}</strong><span>${escapeHtml(currentPark().nodes.find(n=>n.id===b.node)?.name||b.node)} · ${b.duration}分</span></div><button type="button" data-remove-break="${escapeHtml(b.id)}" aria-label="${escapeHtml(b.label||'ひと休み')} ${timeText(b.start)}を外す">外す</button></div>`).join(''):'<p class="field-note">時刻を指定した休憩はまだありません。</p>';
    $('reoptimiseBreaks').disabled=!state.settings.selections.length;
  }
  function suggestBreakLocation() {
    if(!state.result?.rows?.length)return;
    const start=minute($('breakStart').value),prior=state.result.rows.filter(row=>row.start<=start).at(-1);
    const node=prior?.to||prior?.endNode||prior?.node;
    if(currentPark().nodes.some(n=>n.id===node))$('breakNode').value=node;
  }
  function addFixedBreak() {
    readSettings();const start=minute($('breakStart').value),duration=numberInput('breakDuration',1,180),node=$('breakNode').value,label=$('breakLabel').value.trim()||'ひと休み';
    if(start<state.settings.entry||start+duration>state.settings.exit)throw Error('休憩は入園から退園までの時間に収めてください。');
    if(!currentPark().nodes.some(n=>n.id===node))throw Error('休憩する場所を選んでください。');
    const breaks=state.settings.fixedBreaks||[];
    if(breaks.some(b=>b.start<start+duration&&start<b.start+b.duration))throw Error('指定した休憩の時間が重なっています。時刻を変えてください。');
    if(breaks.length>=30)throw Error('指定できる休憩は30件までです。');
    breaks.push({id:`break-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,start,duration,node,label});state.settings.fixedBreaks=breaks;
    markResultStale();renderFixedBreaks();setStatus('休憩を追加しました。「休憩を入れて再探索」で移動と希望の順序を考え直します。');
  }
  function applyDataUpdate(patch) {
    stopSearch();const {history,...settings}=patch;
    if(Array.isArray(history)){state.history=history;state.settings.history=history;}
    Object.assign(state.settings,settings);if(settings.waitModel?.parkId===state.parkId)modelCache.set(state.parkId,settings.waitModel);markResultStale();writeSettings();updateCrowd();renderCatalogue();renderMap();externalPanel?.refresh();
  }
  function checkSelectionDetails() {
    const invalid=$('wishlist').querySelector(':invalid');if(invalid){showWorkflow('wishlist');invalid.closest('details')?.setAttribute('open','');invalid.reportValidity();throw Error('希望の入力欄を確認してください。');}
    if(!state.settings.selections.length)throw Error('行きたい場所を一つ以上選んでください。');
    for(const s of state.settings.selections){const a=byId(s.id);if(!a)throw Error('施設情報を読み直してください。');if(ENTERTAINMENT.has(a.category)&&(!s.confirmSchedule||!s.showTimes?.length))throw Error(`${a.name}の訪問日の公演時刻を確認して入力してください。`);if(s.dpaMode==='owned'&&(!Number.isInteger(s.dpaStart)||!Number.isInteger(s.dpaEnd)||!Number.isInteger(s.dpaPurchasedAt)))throw Error(`${a.name}の取得済みDPAの開始・終了・購入時刻を入力してください。`);if(a.category==='parade'&&['owned','consider'].includes(s.dpaMode)&&!s.nodeOverride)throw Error(`${a.name}のDPAの集合・鑑賞場所を指定してください。`);if(s.dpaMode==='consider'&&!s.dpaAvailableWindows?.length)throw Error(`${a.name}の購入可能なDPA枠を入力してください。`);if((s.dpaMode==='owned'||s.dpaMode==='consider')&&s.dpaStart>=s.dpaEnd)throw Error(`${a.name}のDPA終了は開始より後にしてください。`);if(s.earliest!=null&&s.latest!=null&&s.earliest>=s.latest)throw Error(`${a.name}の時間帯を確認してください。`);}
  }
  async function startSearch() {
    if(preparation)return;
    readSettings();checkSelectionDetails();externalPanel?.cancel();stopSearch();latestPreview=null;requestId++;
    const preparingRequest=requestId,park=currentPark(),input=state.settings;
    preparation=new AbortController();showWorkflow('schedule',{focus:true,scroll:true});$('scheduleEmptyText').textContent='天気と当日の情報を確認して、希望をつなぐ順序を探しています。';
    $('solveButton').disabled=true;$('cancelSearch').hidden=false;$('searchProgress').hidden=false;$('progressBar').value=0;
    $('progressText').textContent=input.weatherMode==='manual'?'計画の条件を確認しています…':'訪問日の天気予報を取得しています…';
    setStatus(input.weatherMode==='manual'?'設定した天気で探索を準備しています。':'パーク周辺の天気予報を取得してから計画します。');
    let prepared;
    try{let base=input;if(!base.waitModel||base.waitModel.parkId!==park.id){const model=await fetchPublishedModel(park,{signal:preparation.signal,timeoutMs:5000});if(model)base={...base,waitModel:model};}prepared=await prepareWeatherForPlan(base,park,{signal:preparation.signal});prepared=await prepareLiveForReplan(prepared,park,{signal:preparation.signal});}
    catch(error){if(preparingRequest!==requestId)return;stopSearch();throw error;}
    if(preparingRequest!==requestId)return;
    preparation=null;state.settings=prepared;if(state.result){state.resultDirty=true;renderResult();}writeSettings();externalPanel?.refresh();
    searchStarted=performance.now();
    try{worker=new Worker(new URL('./planner-worker.js',import.meta.url),{type:'module'});}catch(error){stopSearch();throw error;}
    $('solveButton').disabled=true;$('cancelSearch').hidden=false;$('searchProgress').hidden=false;$('progressBar').value=0;$('progressText').textContent='最初の計画を探しています…';
    const thisRequest=requestId;
    worker.onmessage=event=>{
      const message=event.data;if(thisRequest!==requestId||(message.requestId!=null&&message.requestId!==thisRequest))return;
      if(message.type==='progress'){
        const p=message.progress||{};if(message.result)latestPreview=message.result;
        $('progressText').textContent=`組合せを探索中 · 重要度 ${p.bestScore??'—'} · ${p.visits??0}件の希望`;
      }else if(message.type==='result'){
        state.result=message.result;state.resultDirty=false;latestPreview=state.result;stopSearch();renderResult();renderMap();setStatus(state.result.status==='feasible'?'一日の計画ができました。採用された希望と費用を見比べてください。':'条件を満たす計画が見つかりませんでした。必須条件や時間帯を見直してください。',state.result.status!=='feasible');
      }else if(message.type==='error'){stopSearch();setStatus(message.message||message.error||'計画の計算に失敗しました。',true);}
    };
    worker.onerror=error=>{if(thisRequest!==requestId)return;stopSearch();setStatus(error.message||'探索を開始できませんでした。ページを読み直してください。',true);};
    progressTimer=setInterval(()=>{$('progressBar').value=Math.min(98,(performance.now()-searchStarted)/(state.settings.searchSeconds*1000)*100);},120);
    worker.postMessage({type:'solve',requestId:thisRequest,park:currentPark(),settings:state.settings,history:state.history,initialPlan:state.settings.replanFrom!=null?state.result:null});
    setStatus('希望の重要度を保ちながら移動と時間帯の組合せを探しています。');
  }
  async function loadCatalogue(fresh=false) {
    const response=await fetch(`data/parks.json${fresh?`?refresh=${Date.now()}`:''}`,{cache:fresh?'reload':'default'});
    if(!response.ok)throw Error('施設情報を読み込めませんでした。ページを再読み込みしてください。');
    const bundled=validateCatalogue(await response.json());
    let published=null;
    try{published=await fetchPublishedCatalogue({timeoutMs:5000});}catch{}
    catalogue=chooseCatalogue(bundled,published);
    if(!catalogue.parks.some(p=>p.id===state.parkId))state.parkId=catalogue.parks[0].id;
    const known=new Set(currentPark().activities.map(a=>a.id));state.settings.selections=state.settings.selections.filter(item=>known.has(item.id));
  }
  function switchPark(id) {
    if(id===state.parkId)return;stopSearch();readSettings();openedPlanId=null;$('overwritePlan').hidden=true;state.parkStates[state.parkId]={settings:state.settings,result:state.result,resultDirty:!!state.resultDirty};
    const saved=state.parkStates[id];state.parkId=id;state.settings=saved?.settings||{...defaultSettings(),date:state.settings.date};state.result=saved?.result||null;state.resultDirty=!!saved?.resultDirty;
    $('catalogueSearch').value='';wishlistGenre='all';writeSettings();updateContext();showWorkflow(state.result?'schedule':'wishlist');setStatus(`${currentPark().name}の計画へ切り替えました。`);
  }
  function downloadCatalogue(){const blob=new Blob([JSON.stringify(catalogue,null,2)],{type:'application/json;charset=utf-8'}),a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`ParkItinerary_catalogue_${catalogue.updatedAt||'custom'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function attachEvents() {
    $('workflowTabs').addEventListener('click',event=>{const tab=event.target.closest('[data-workflow-tab]');if(tab)showWorkflow(tab.dataset.workflowTab);});
    $('workflowTabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();showWorkflow(event.key==='Home'?'wishlist':event.key==='End'?'schedule':workflowView==='wishlist'?'schedule':'wishlist',{focus:true});});
    $('backToWishlist').addEventListener('click',()=>showWorkflow('wishlist',{focus:true}));
    $('saveNewPlan').addEventListener('click',safely(()=>saveCurrentPlan(false)));$('overwritePlan').addEventListener('click',safely(()=>saveCurrentPlan(true)));
    $('savedPlanList').addEventListener('click',safely(event=>{
      const load=event.target.closest('[data-load-saved]'),rename=event.target.closest('[data-rename-saved]'),commit=event.target.closest('[data-commit-rename]'),remove=event.target.closest('[data-delete-saved]');
      if(load){const id=load.dataset.loadSaved,saved=loadSavedPlan(id);if(!saved)throw Error('この計画は見つかりませんでした。');stopSearch();state=cleanState(saved);openedPlanId=id;const summary=listSavedPlans().find(item=>item.id===id);$('planName').value=summary?.name||'';writeSettings();updateContext();renderSavedPlans();showWorkflow(state.result?'schedule':'wishlist');setStatus(`「${summary?.name||'計画'}」を開きました。`);}
      if(rename){const panel=rename.closest('.saved-plan-card').querySelector('.saved-plan-rename');panel.hidden=!panel.hidden;if(!panel.hidden)panel.querySelector('input').focus();}
      if(commit){const card=commit.closest('.saved-plan-card'),summary=renameSavedPlan(commit.dataset.commitRename,card.querySelector('input[data-saved-name]').value);if(openedPlanId===summary.id)$('planName').value=summary.name;renderSavedPlans();$('savedPlanStatus').textContent='計画の名前を変更しました。';}
      if(remove){const id=remove.dataset.deleteSaved;deleteSavedPlan(id);if(openedPlanId===id)openedPlanId=null;renderSavedPlans();$('savedPlanStatus').textContent='保存した計画を削除しました。編集中の条件としおりはそのまま残っています。';}
    }));

    $('landTab').addEventListener('click',safely(()=>switchPark('land')));$('seaTab').addEventListener('click',safely(()=>switchPark('sea')));
    for(const id of ['landTab','seaTab'])$(id).addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();safely(()=>switchPark(state.parkId==='land'?'sea':'land'))();}});
    $('wishlistTabs').addEventListener('click',event=>{const tab=event.target.closest('[data-wish-genre]');if(!tab)return;wishlistGenre=tab.dataset.wishGenre;renderWishlist();$(`wishTab-${wishlistGenre}`).focus();});
    $('wishlistTabs').addEventListener('keydown',event=>{const tab=event.target.closest('[data-wish-genre]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=GENRES.findIndex(g=>g.id===tab.dataset.wishGenre),next=event.key==='Home'?0:event.key==='End'?GENRES.length-1:(index+(event.key==='ArrowRight'?1:-1)+GENRES.length)%GENRES.length;wishlistGenre=GENRES[next].id;renderWishlist();$(`wishTab-${wishlistGenre}`).focus();});
    $('breakEditor').addEventListener('toggle',()=>{if($('breakEditor').open&&state.result!==lastBreakSuggestionResult){suggestBreakLocation();lastBreakSuggestionResult=state.result;}});
    $('timeline').addEventListener('click',safely(async event=>{const button=event.target.closest('[data-remove-rest-index]');if(!button)return;const row=state.result?.rows?.[Number(button.dataset.removeRestIndex)];if(!removePlannedRest(state.settings,row))return;markResultStale();renderFixedBreaks();setStatus('休憩を外して残りの順序を考え直します。');await startSearch();}));
    $('breakStart').addEventListener('change',()=>suggestBreakLocation());
    $('addBreak').addEventListener('click',safely(addFixedBreak));
    $('reoptimiseBreaks').addEventListener('click',safely(startSearch));
    $('fixedBreakList').addEventListener('click',event=>{const button=event.target.closest('[data-remove-break]');if(!button)return;state.settings.fixedBreaks=(state.settings.fixedBreaks||[]).filter(b=>b.id!==button.dataset.removeBreak);markResultStale();renderFixedBreaks();setStatus('休憩を外しました。再探索すると新しい条件で順序を考え直します。');});
    $('catalogueSearch').addEventListener('input',renderCatalogue);$('categoryFilter').addEventListener('change',renderCatalogue);
    $('catalogue').addEventListener('click',safely(event=>{const button=event.target.closest('[data-add]');if(button)addSelection(button.dataset.add);}));
    $('wishlist').addEventListener('click',safely(event=>{
      const remove=event.target.closest('[data-remove]'),weight=event.target.closest('[data-weight]');
      if(remove){state.settings.selections=state.settings.selections.filter(s=>s.id!==remove.dataset.remove);markResultStale();renderWishlist();renderCatalogue();renderMap();}
      if(weight){selected(weight.dataset.for).weight=Number(weight.dataset.weight);markResultStale();renderWishlist();}
    }));
    $('wishlist').addEventListener('input',()=>markResultStale());
    $('wishlist').addEventListener('change',event=>{event.target.setCustomValidity?.('');try{updateSelection(event);}catch(error){event.target.setCustomValidity?.(error.message);setStatus(error.message,true);}});
    $('purchaseActivity').addEventListener('change',()=>{const a=byId($('purchaseActivity').value);if(a?.dpa)$('purchaseCost').value=a.dpa.price;});
    $('addPurchase').addEventListener('click',safely(()=>{const a=byId($('purchaseActivity').value);if(!a?.dpa)throw Error('購入したDPAを選んでください。');const purchasedAt=minute($('purchaseTime').value),start=minute($('purchaseStart').value),end=minute($('purchaseEnd').value),cost=numberInput('purchaseCost',0,1000000,100);if(start>=end)throw Error('利用・入場終了は開始より後にしてください。');if(purchasedAt>start)throw Error('購入時刻は利用開始より前にしてください。');if(state.settings.purchases.some(p=>p.id===a.id))throw Error('この施設の購入履歴は追加済みです。訂正する場合は一度履歴から外してください。');state.settings.purchases.push({id:a.id,kind:a.dpa.kind||'attraction',purchasedAt,start,end,cost});renderPurchaseHistory();markResultStale();setStatus('購入履歴に追加しました。次の探索で購入間隔と支出へ反映します。');}));
    $('purchaseHistory').addEventListener('click',event=>{const button=event.target.closest('[data-remove-purchase]');if(!button)return;const removed=state.settings.purchases.splice(Number(button.dataset.removePurchase),1)[0];const selection=selected(removed?.id);if(selection?.dpaMode==='owned'){selection.dpaMode='none';renderWishlist();}renderPurchaseHistory();markResultStale();setStatus('購入履歴を外しました。この施設の取得済みDPA指定も通常利用へ戻しています。');});
    $('addSuggested').addEventListener('click',safely(suggestedSelection));$('clearSelection').addEventListener('click',()=>{state.settings.selections=[];markResultStale();renderWishlist();renderCatalogue();renderMap();});
    for(const id of ['visitDate','crowdMode','crowdLevel','weather','weatherMode'])$(id).addEventListener('change',safely(()=>{const previousDate=state.settings.date;readSettings();if(id==='visitDate'&&state.settings.date!==previousDate){stopSearch();openedPlanId=null;$('overwritePlan').hidden=true;resetForNewVisitDay(state);for(const selection of state.settings.selections){const activity=byId(selection.id);if(ENTERTAINMENT.has(activity.category)){const schedule=activitySchedule(activity,state.settings.date);selection.showTimes=schedule.showTimes.slice();selection.confirmSchedule=schedule.confirmed;}}writeSettings();setStatus('訪問日を変更しました。前の日付のDPA枠・購入履歴・支払い済み額・当日の組み替えと計画をリセットしています。新しい日付の条件で探索してください。');}updateContext();}));
    document.querySelector('.settings-panel').addEventListener('input',()=>markResultStale());
    document.querySelector('.settings-panel').addEventListener('change',safely(()=>{readSettings();markResultStale();}));
    $('solveButton').addEventListener('click',safely(startSearch));$('cancelSearch').addEventListener('click',()=>{stopSearch(true);setStatus(latestPreview?'探索を止めて、そこまでで見つかった計画を表示しました。':'探索を止めました。前に作った計画がある場合はそのまま残っています。');});
    $('savePlan').addEventListener('click',safely(()=>{readSettings();showSavedPlans(true);}));
    $('loadPlan').addEventListener('click',safely(()=>showSavedPlans(false)));
    $('sharePlan').addEventListener('click',safely(async()=>{readSettings();$('shareUrl').value=await createShareUrl(state,location.href);$('sharePanel').hidden=false;setStatus('リンクをコピーしてスマホへ送れます。予定表はJSONやスマホ用しおりでも持ち出せます。');}));
    $('copyShare').addEventListener('click',safely(async()=>{try{await navigator.clipboard.writeText($('shareUrl').value);setStatus('共有リンクをコピーしました。');}catch{$('shareUrl').select();setStatus('リンク欄を選択しました。コピーして送ってください。');}}));
    $('importPlan').addEventListener('click',()=>$('planFile').click());$('planFile').addEventListener('change',safely(async()=>{const file=$('planFile').files[0];if(!file)return;if(file.size>5000000)throw Error('計画ファイルは5MB以下で指定してください。');const value=parsePlanJson(await file.text());stopSearch();state=cleanState(value);openedPlanId=null;writeSettings();updateContext();showWorkflow(state.result?'schedule':'wishlist');setStatus('計画ファイルを読み込みました。');$('planFile').value='';}));
    $('importHistory').addEventListener('click',()=>$('historyFile').click());$('historyFile').addEventListener('change',safely(async()=>{const file=$('historyFile').files[0];if(!file)return;if(file.size>10000000)throw Error('待ち時間CSVは10MB以下で指定してください。');state.history=parseHistoryCsv(await file.text());state.settings.history=state.history;updateCrowd();externalPanel?.refresh();markResultStale();setStatus(`${state.history.length}件の待ち時間を読み込みました。再探索すると計画へ反映します。`);$('historyFile').value='';}));
    $('exportCatalogue').addEventListener('click',safely(downloadCatalogue));$('importCatalogue').addEventListener('click',()=>$('catalogueFile').click());$('catalogueFile').addEventListener('change',safely(async()=>{const file=$('catalogueFile').files[0];if(!file)return;if(file.size>5000000)throw Error('施設JSONは5MB以下で指定してください。');const next=validateCatalogue(JSON.parse(await file.text()));stopSearch();catalogue=next;state.result=null;state.settings.selections=state.settings.selections.filter(s=>byId(s.id));updateContext();setStatus('施設情報を更新しました。時間・料金を確認して再探索してください。');$('catalogueFile').value='';}));
    $('refreshCatalogue').addEventListener('click',safely(async()=>{stopSearch();await loadCatalogue(true);stopSearch();state.result=null;updateContext();setStatus('配布中の施設情報を読み直しました。');}));
    $('exportJson').addEventListener('click',safely(()=>{readSettings();downloadPlanJson(state);}));$('exportCsv').addEventListener('click',safely(()=>downloadScheduleCsv(state.result,currentPark())));$('exportIcs').addEventListener('click',safely(()=>downloadCalendar(state.result,currentPark(),state.result.settings||state.settings)));$('exportHtml').addEventListener('click',safely(()=>downloadOfflineHtml(state.result,currentPark(),state.result.settings||state.settings)));$('printPlan').addEventListener('click',()=>window.print());
  }
  async function start() {
    try{$('solveButton').disabled=true;setStatus('最新の施設情報と予測モデルを確認しています。');await loadCatalogue();const shared=await readSharedState(location.hash);if(shared)state=cleanState(shared);const context=await Promise.all([fetchPublishedCalendar({timeoutMs:5000}),fetchPublishedModel(currentPark(),{timeoutMs:5000})]);calendarData=context[0];if(calendarData)state.settings.calendarData=calendarData;if(context[1])state.settings.waitModel=context[1];writeSettings();attachEvents();showWorkflow(state.result?'schedule':'wishlist');renderSavedPlans();$('solveButton').disabled=false;externalPanel=initialiseExternalData({container:$('externalDataPanel'),getContext:()=>({park:currentPark(),settings:state.settings,history:state.history}),onUpdate:applyDataUpdate,beforeAction:readSettings});updateContext();setStatus(shared?'共有された希望を読み込みました。必要に応じて調整し、プランを考えましょう。':'行きたい場所を選び、一日の条件を決めましょう。');}
    catch(error){setStatus(error.message||'起動に失敗しました。ページを再読み込みしてください。',true);$('solveButton').disabled=true;}
  }
  start();
  return {getState:()=>state,showWorkflow,getCatalogue:()=>catalogue,getContext:()=>({park:currentPark(),settings:state.settings,history:state.history}),applyDataUpdate,readSettings,addSelection,renderResult,stopSearch};
}
if(typeof document!=='undefined')initialiseApp();
