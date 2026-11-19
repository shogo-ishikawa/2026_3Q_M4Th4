import { initialiseExternalData, fetchPublishedCatalogue, fetchPublishedCalendar, createVisitOutlook, prepareLiveForReplan } from './wait-data.js?v=2.6.0';
export {prepareWeatherForVisit as prepareWeatherForPlan} from './wait-data.js?v=2.6.0';
import {visitDayDetails} from './visit-day-view.js?v=2.6.0';
import {createForecastCalendar} from './forecast-calendar.js?v=2.6.0';
import {calendarDayOutlook, calendarDayPreview, CROWD_LABELS} from './calendar-outlook.js?v=2.6.0';
import {WISH_PRESETS, presetFacilities, presetStartsPlan, addPresetWishes} from './wishlist-presets.js';
import {attachItineraryImage} from './itinerary-image.js';
import {attachOnsiteNavigation} from './onsite-navigation.js';
import {attachDayProgress} from './day-progress-ui.js?v=2.6.0';
import {baseVisitId, repeatVisitId, isRepeatVisit, expandRepeatVisits, resolveDpaVisit} from './repeat-visits.js';
import { restsBesideFood, settledReplanWishes } from './planner.js?v=2.6.0';
import { enhanceTimeInputs, parkTimeBounds, clampClock } from './time-input.js?v=2.6.0';
import { estimateParkCrowd } from './wait-model.js?v=2.6.0';
import { warmCalendarWeather, weatherForMinute } from './weather.js?v=2.6.0';
import { forecastCardHtml, forecastSourcesHtml, visitWeatherSummary } from './weather-view.js?v=2.6.0';
import { activityAvailable, operationPauseInfo } from './operation-windows.js?v=2.6.0';
import { contingencySettings, compareContingency } from './contingency.js';
import { renderParkMap } from './map-view.js?v=2.6.0';
import { createShareUrl, readSharedState, downloadPlanJson, downloadCalendar, downloadOfflineHtml, parseHistoryCsv, validateCatalogue, parsePlanJson } from './storage.js?v=2.6.0';

const CATEGORY = {attraction:'アトラクション',show:'ショー',parade:'パレード',restaurant:'レストラン',cafe:'カフェ',snack:'スナック',popcorn:'ポップコーン',greeting:'グリーティング',shop:'お土産'};
const FOOD = new Set(['restaurant','cafe','snack','popcorn']);
const ENTERTAINMENT = new Set(['show','parade']);
const GENRES = [{id:'all',label:'すべて'},{id:'attraction',label:'アトラクション'},{id:'entertainment',label:'ショー・パレード'},{id:'dining',label:'レストラン・カフェ'},{id:'snacks',label:'スナック・ポップコーン'},{id:'greeting',label:'グリーティング'},{id:'shop',label:'お土産'}];
export const genreOf = category => ['restaurant','cafe'].includes(category)?'dining':['snack','popcorn'].includes(category)?'snacks':ENTERTAINMENT.has(category)?'entertainment':category;
const CATEGORY_ORDER={attraction:0,show:1,parade:1,greeting:2,restaurant:3,cafe:4,snack:5,popcorn:6,shop:7};
export const selectableNodes=park=>park.nodes.filter(node=>!node.routingOnly);
export const orderedFacilities=list=>list.map((item,index)=>({item,index})).sort((a,b)=>(CATEGORY_ORDER[a.item.category]??9)-(CATEGORY_ORDER[b.item.category]??9)||a.index-b.index).map(entry=>entry.item);
export function weightButtons(selection){return [1,2,3,4,5].map(weight=>`<button type="button" class="weight-button${!selection.required&&Number(selection.weight)===weight?' active':''}" data-weight="${weight}" data-for="${escapeHtml(selection.id)}" aria-pressed="${!selection.required&&Number(selection.weight)===weight}" aria-label="重要度${weight}：${WEIGHT_LABELS[weight]}" title="${WEIGHT_LABELS[weight]}"${selection.required?' disabled aria-disabled="true"':''}>${weight}</button>`).join('');}
const WEIGHT_LABELS = {1:'気軽に',2:'できれば',3:'行きたい',4:'かなり行きたい',5:'最優先'};
const WAIT_LABELS = {manual:'手動の待ち時間',live:'当日の公開待ち時間',intraday:'当日の掲示で補正した予測',ml:'学習モデルの予測',history:'履歴からの推定',trend:'傾向モデル',dpa:'DPAの入場準備'};
const SEARCH_LABELS = {beam:'ビーム探索',multistart:'多点スタート探索',portfolio:'組合せ探索'};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => `${Math.round(Number(n) || 0).toLocaleString('ja-JP')}円`;
const minute = text => { if (!/^\d{2}:\d{2}$/.test(text)) throw Error('時刻を入力してください。'); const [h,m] = text.split(':').map(Number); if(h>23||m>59)throw Error('時刻を確認してください。'); return h*60+m; };
const timeText = value => Number.isFinite(Number(value)) ? `${String(Math.floor(Number(value)/60)).padStart(2,'0')}:${String(Math.round(Number(value)%60)).padStart(2,'0')}` : '—';
const pauseWindowSummary = info => '避ける時間帯：'+info.windows.map(([start,end])=>timeText(start)+'–'+timeText(end)).join(' / ');
const menuNames = activity => Array.isArray(activity.menuItems)?activity.menuItems.filter(item=>item&&typeof item.name==='string').map(item=>item.name):[];
const safeLink = url => { try {const u = new URL(url);return ['https:','http:'].includes(u.protocol)?escapeHtml(u.href):'#';}catch{return '#';} };
const $ = id => document.getElementById(id);
const defaultDate = () => { const now = new Date();return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); };
export const defaultSettings = () => ({date:defaultDate(),entry:540,exit:1260,speed:70,budget:12000,foodBudget:5000,dpaBudget:5000,souvenirReserve:2000,souvenirMode:'reserve',budgetPreference:'balanced',crowdMode:'estimate',crowdLevel:'auto',weather:'sun',weatherMode:'auto',walkCrowdMode:'estimate',waitBufferMode:'auto',waitBufferMinutes:5,queueDelayMinutes:0,gondolaAvoidHarbourShows:true,weatherForecast:null,selections:[],avoidConsecutiveFood:true,restEvery:0,restMinutes:10,searchSeconds:15,searchMethod:'portfolio',fixedBreaks:[],excludedAutoBreaks:[],spentBudget:0,purchases:[],history:[]});


export function crowdExplanation(park, settings) {
  const auto = settings.crowdLevel === 'auto';
  const estimate = auto ? estimateParkCrowd(park, settings) : null;
  const label = CROWD_LABELS[estimate?.level || settings.crowdLevel] || CROWD_LABELS.normal;
  let source = '手動';
  if (estimate) source = estimate.source === 'model' ? '学習予測' : '暦の目安';
  return {label, source, summary:`${label}（${source}）`};
}

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
export function removePlannedRest(settings,row,afterId) {
  if(!row||row.preserved||(row.kind||row.type)!=='rest')return false;
  if(row.fixedBreakId){const before=(settings.fixedBreaks||[]).length;settings.fixedBreaks=(settings.fixedBreaks||[]).filter(item=>item.id!==row.fixedBreakId);return before!==settings.fixedBreaks.length;}
  if(row.autoBreakId&&afterId){
    settings.skipAutoRestAfter=[...new Set([...(settings.skipAutoRestAfter||[]),afterId])];
    return true;
  }
  if(row.autoBreakId){settings.excludedAutoBreaks=[...new Set([...(settings.excludedAutoBreaks||[]),row.autoBreakId])];return true;}
  return false;
}

/** Keep the freed minutes open. All later reservations, walks and breaks keep their times. */
export function skipScheduledRest(settings,result,index) {
  const row=result?.rows?.[index];
  if(result?.status!=='feasible'||!row||row.preserved||row.start<settings.replanFrom)return null;
  const prior=result.rows[index-1];
  const afterId=prior?.kind==='activity'&&prior.end===row.start?prior.activityId:undefined;
  const updated={...settings};
  if(!removePlannedRest(updated,row,afterId))return null;
  const planSettings={...(result.settings||settings)};
  removePlannedRest(planSettings,row,afterId);
  const rows=result.rows.filter((_,i)=>i!==index);
  // The route to a manually chosen location still connects the adjacent visits.
  if(row.fixedBreakId){
    let i=index-1;
    if(rows[i]?.kind==='wait'&&!rows[i].preserved&&rows[i].name==='休憩までの自由時間'){
      rows[i]={...rows[i],name:'自由時間'};
      i--;
    }
    if(rows[i]?.kind==='walk'&&!rows[i].preserved&&rows[i].name===row.name+'の場所へ移動'){
      rows[i]={...rows[i],name:'経由地点へ移動'};
    }
  }
  const restMinutes=rows.filter(item=>(item.kind||item.type)==='rest').reduce((sum,item)=>sum+item.end-item.start,0);
  return {settings:updated,result:{...result,settings:planSettings,rows,totals:{...result.totals,restMinutes}}};
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

const visitDayFields = ['dpaStart','dpaEnd','dpaPurchasedAt','dpaAvailableWindows','nodeOverride','viewingNode',
  'windows','pauseWindows','normalShowTimes','showTimes','confirmSchedule','confirmAccess','confirmedAccess'];

function visitDateChangeNotice(state, date) {
  const s=state.settings;
  if(date===s.date)return '';
  const resets=[];
  if(state.result)resets.push('今のしおり');
  if(s.purchases.length || s.selections.some(wish=>Number.isInteger(wish.dpaStart) || Number.isInteger(wish.dpaEnd)))resets.push('入力済みのDPA枠');
  if(s.spentBudget || s.completedIds?.length || Object.keys(s.dayProgress?.visits || {}).length)resets.push('当日の記録');
  const other=state.parkStates?.[state.parkId==='land'?'sea':'land'];
  if(other?.result || other?.settings?.selections?.length)resets.push('もう一方のパークの編集中の計画');
  return resets.length ? '訪問日を変えると、'+resets.join('・')+'がリセットされます。' : '';
}

/** Carry preferences to a new visit day and replace date-specific facts. */
export function resetForNewVisitDay(state, park, drafts) {
  if(state.settings.weatherMode==='auto' && state.settings.weatherForecast)state.settings.weather='sun';
  state.settings.purchases=[];state.settings.spentBudget=0;state.settings.excludedAutoBreaks=[];delete state.settings.skipAutoRestAfter;
  for(const key of ['replanFrom','currentNode','completedIds','dayProgress','weatherForecast','weatherNotice','visitForecastAsOf','liveData','liveNotice','waitAsOf','operationalHolds'])delete state.settings[key];
  for(const selection of state.settings.selections){
    selection.dpaMode=['consider','owned'].includes(selection.dpaMode)?'consider':'none';
    for(const key of visitDayFields)delete selection[key];
    for(const field of [...visitDayFields,'windowStart','windowEnd'])drafts?.get(selection)?.delete(field);
    const activity=park?.activities.find(item=>item.id===selection.id);
    if(activity&&ENTERTAINMENT.has(activity.category)){
      const schedule=activitySchedule(activity,state.settings.date);
      selection.showTimes=schedule.showTimes.slice();
      selection.confirmSchedule=schedule.confirmed;
    }
  }
  state.result=null;state.resultDirty=false;state.parkStates={};
  return state;
}


export function activitySchedule(activity,date) {
  const daily=activity.dailySchedules?.[date];
  const datedTimes=daily?.showTimes??(activity.showTimesDate===date?activity.showTimes:[]);
  return {date:daily?date:activity.showTimesDate,confirmed:!!datedTimes?.length,closed:!activityAvailable(activity,date),
    windows:daily?.windows||activity.windows||[],showTimes:datedTimes||[]};
}

export function foodLinks(activity) {
  if(!FOOD.has(activity.category))return '';
  const menuUrl=safeLink(activity.menuUrl||activity.sourceUrl);
  const items=menuNames(activity).slice(0,3).map(escapeHtml).filter(Boolean);
  return `<div class="food-information">${items.length?`<p>${items.join(' / ')}</p>`:''}<a href="${menuUrl}" target="_blank" rel="noopener noreferrer">メニュー ↗</a></div>`;
}

// A problem identifies an editable field even when its wish is on a different tab.
const inputError = (message,field,wishId) => Object.assign(new Error(message),{field,wishId});

/** Preserve typed and pasted wish values before a genre change replaces the card. */
export function bindWishEditors(root,commit,markEdited) {
  const lastEdits=new WeakMap();
  function handleEdit(event){
    const input=event.target,editable=input.dataset.field&&['text','number'].includes(input.type);
    if(event.type==='input')markEdited();
    if(!editable){
      if(event.type==='change')commit(event);
      return;
    }
    const bad=!!input.validity?.badInput,previous=lastEdits.get(input);
    if(previous&&previous.value===input.value&&previous.bad===bad)return;
    if(event.type==='focusout'&&!previous&&input.value===input.defaultValue&&!bad)return;
    lastEdits.set(input,{value:input.value,bad});
    commit(event);
  }
  for(const event of ['input','change','focusout'])root.addEventListener(event,handleEdit);
}

export function wishInputProblem(wish,activity,date,dpaPurchaseLimit) {
  if(!activity)return inputError('施設情報を読み直してから行きたい場所を選び直してください。','catalogueSearch');
  const problem=(field,message)=>inputError(activity.name+'：'+message,field,wish.id);
  if(date&&!activityAvailable(activity,date)){
    if(wish.required||wish.dpaMode==='owned')return inputError(`${activity.name}は${date}に休止・開催期間外です。訪問日またはこの希望の指定を見直してください。`,'visitDate');
    return null;
  }
  const needsDpaWindow=wish.dpaMode==='owned'||(wish.dpaMode==='consider'&&dpaPurchaseLimit!==0);
  if(ENTERTAINMENT.has(activity.category)){
    if(!wish.showTimes?.length&&(wish.required||needsDpaWindow))
      return problem('showTimes',`${date||'訪問日'}の開演時刻を入力してください。`);
    if(wish.showTimes?.length&&!wish.confirmSchedule)return problem('confirmSchedule','開演時刻を確認して「この日の公演時刻を確認した」にチェックしてください。');
    if(wish.showTimes?.length>30)return problem('showTimes','開演時刻は30件以内にしてください。');
  }
  if(needsDpaWindow){
    const candidate=wish.dpaMode==='consider'?wish.dpaAvailableWindows?.[0]:null;
    const legacy=candidate&&wish.dpaStart==null&&wish.dpaEnd==null;
    const start=legacy?candidate[0]:wish.dpaStart,end=legacy?candidate[1]:wish.dpaEnd;
    if(!Number.isInteger(start))return problem('dpaStart',date?`${date}の公式アプリで確認したDPAの利用枠を入力してください。`:'DPAの利用・入場開始時刻を入力してください。');
    if(!Number.isInteger(end))return problem('dpaEnd','DPAの利用・入場終了時刻を入力してください。');
    if(start>=end)return problem('dpaEnd','DPAの終了時刻は開始時刻より後にしてください。');
    if(wish.dpaMode==='owned'&&!Number.isInteger(wish.dpaPurchasedAt))return problem('dpaPurchasedAt','取得済みDPAの購入時刻を入力してください。');
    if(wish.dpaMode==='owned'&&wish.dpaPurchasedAt>start)return problem('dpaPurchasedAt','DPAの購入時刻は利用開始までの時刻を入力してください。');
    if(wish.dpaMode==='consider'&&!candidate)return problem('dpaStart','購入候補の開始・終了時刻を確認してください。');
    if(activity.category==='parade'&&!wish.nodeOverride)return problem('nodeOverride','DPAの集合・鑑賞場所を選んでください。');
  }
  if(wish.earliest!=null&&wish.latest!=null&&wish.earliest>=wish.latest)return problem('latest','希望時間帯の終了を開始より後にしてください。');
  return null;
}

// Costs for unvisited required stops give a lower bound, including during a replan.
export function noPlanExplanation(result,park) {
  const settings=result.settings||{},missing=new Set((result.omissions||[]).map(item=>item.id));
  const foodIds=new Set(park.activities.filter(a=>FOOD.has(a.category)).map(a=>a.id));
  const requiredFood=(settings.selections||[]).filter(item=>missing.has(item.id)&&foodIds.has(item.id)&&item.required)
    .reduce((sum,item)=>sum+(Number(item.cost)||0),0);
  const paidDpa=(settings.purchases||[]).reduce((sum,item)=>sum+(Number(item.cost)||0),0);
  const spent=Math.max(settings.spentBudget||0,paidDpa);
  if(spent>settings.budget)return `支払い済みの${money(spent)}が予算上限の${money(settings.budget)}を超えています。予算と支払い記録を確認してください。`;
  if(result.totals?.dpaCost>settings.dpaBudget)return `支払い済みと開始済みの予定でDPAに${money(result.totals.dpaCost)}かかります。DPAの予算上限（${money(settings.dpaBudget)}）か購入履歴を確認してください。`;
  if(requiredFood>settings.foodBudget)return `必須のフードだけで${money(requiredFood)}かかります。フードの上限（${money(settings.foodBudget)}）か各施設の予算を見直してください。`;
  const conflict=(result.omissions||[]).find(item=>item.required&&item.conflictField);
  if(conflict)return `${settings.date}の必須の希望「${conflict.name}」：${conflict.reason}`;
  if(result.diagnostics?.timedOut)return '探索時間内にすべての条件を満たす案は見つかりませんでした。探索時間を延ばすか、下の項目から条件を見直してください。';
  return 'すべての条件に収まる案は見つかりませんでした。下の項目から条件を開けます。';
}

const omissionSettingLabels = {
  budget:'総予算を見直す',foodBudget:'フードの上限を見直す',dpaBudget:'DPA予算を見直す',exitTime:'退園予定を見直す',
  visitDate:'訪問日を確認',refreshLiveWaits:'運営状況の更新へ',avoidConsecutiveFood:'フードの間隔を見直す',catalogueSearch:'ほかの施設を探す',
};
const omissionWishLabels = {
  weight:'重要度を見直す',required:'必須の指定を確認',earliest:'希望の時間帯を見直す',confirmedAccess:'利用条件を確認',
  dpaStart:'DPAの利用枠を確認',nodeOverride:'鑑賞場所を確認',showTimes:'開演時刻を確認',
};

export function omissionAction(omitted) {
  const field=omitted.conflictField;
  if (Object.hasOwn(omissionSettingLabels,field)) return {field,label:omissionSettingLabels[field]};
  const wishField=Object.hasOwn(omissionWishLabels,field)?field:omitted.required?'required':'weight';
  return {field:wishField,wishId:baseVisitId(omitted.id),label:omissionWishLabels[wishField]};
}

// A search may time out. Suggest concrete edits without claiming any one wish caused the failure.
export function noPlanActions(result,park) {
  if(result?.status!=='no-plan')return [];
  const settings=result.settings||{},actions=[];
  const activities=new Map(park.activities.map(a=>[a.id,a]));
  const occurrences=expandRepeatVisits(park,settings).settings.selections || [];
  for(const omitted of result.omissions||[]){
    const wish=occurrences.find(item=>item.id===omitted.id);
    if(!wish?.required&&wish?.dpaMode!=='owned')continue;
    if(omitted.conflictField==='avoidConsecutiveFood')continue;
    const activity=activities.get(baseVisitId(wish.id));
    const wishField=Object.hasOwn(omissionWishLabels,omitted.conflictField)?omitted.conflictField:null;
    const field=wishField||(wish.dpaMode==='owned'?'dpaStart':ENTERTAINMENT.has(activity?.category)?'showTimes':FOOD.has(activity?.category)?'earliest':'required');
    actions.push({wishId:baseVisitId(wish.id),field,label:(omitted.name||activity?.name)+'の条件'});
  }
  if((result.omissions||[]).some(item=>item.required&&['required','visitDate'].includes(item.conflictField)))actions.push({field:'visitDate',label:'訪問日'});
  if((result.omissions||[]).some(item=>item.conflictField==='avoidConsecutiveFood'))actions.push({field:'avoidConsecutiveFood',label:'フードを連続して入れない設定'});
  if(settings.fixedBreaks?.length)actions.push({field:'breakEditor',label:'指定した休憩'});
  if((result.omissions||[]).some(item=>item.required&&FOOD.has(activities.get(item.id)?.category)))actions.push({field:'foodBudget',label:'フードの上限'});
  if(result.totals?.dpaCost>settings.dpaBudget)actions.push({field:'dpaBudget',label:'DPAの予算上限'});
  if(settings.dpaPurchaseLimit!==undefined&&settings.selections?.some(wish=>wish.dpaMode==='consider'))actions.push({field:'dpaPurchaseLimit',label:'DPA購入候補から選ぶ上限'});
  actions.push({field:'budget',label:'予算上限'},{field:'exitTime',label:'退園予定'});
  if(result.diagnostics?.timedOut)actions.push({field:'searchSeconds',label:'探索する時間'});
  return actions;
}

const DPA_CHOICES = [
  ['none', '使わない'],
  ['consider', '購入候補'],
  ['owned', '取得済み'],
  ['unavailable', '売り切れ'],
];

// The official purchase guide shows 30-minute slots for this attraction.
// Its example can complete a draft after the visitor checks the actual offer.
export function dpaExampleWindow(wish, bounds) {
  if (wish.id !== 'land-attraction-197' || wish.dpaMode !== 'consider') return null;
  const hasStart = Number.isInteger(wish.dpaStart), hasEnd = Number.isInteger(wish.dpaEnd);
  if (hasStart === hasEnd) return null;
  const start = hasStart ? wish.dpaStart : wish.dpaEnd - 30;
  const end = start + 30;
  if (start < bounds.min || end > bounds.max) return null;
  return {start, end, field: hasStart ? 'dpaEnd' : 'dpaStart'};
}

function dpaExampleHelp(selection, bounds) {
  const example = dpaExampleWindow(selection, bounds);
  if (!example) return '';
  return `<p class="dpa-help">公式の購入画面例では30分枠です。当日表示された時刻と一致しますか？ <button type="button" class="text-button" data-confirm-dpa-example>${timeText(example.start)}–${timeText(example.end)}を確認して入力</button></p>`;
}

export function dpaEditor(activity, selection, park, purchase, purchaseLimit, bounds = parkTimeBounds(park), autoVisit = 1, effectiveVisit = selection.dpaVisit ?? autoVisit) {
  if (!activity.dpa) return '';
  const mode = selection.dpaMode || 'none';
  const owned = mode === 'owned';
  const disabledCandidate = mode === 'consider' && purchaseLimit === 0;
  const showSlot = owned || (mode === 'consider' && !disabledCandidate);
  const id = escapeHtml(activity.id);
  const radios = DPA_CHOICES.map(([value, label]) =>
    `<label><input type="radio" name="dpa-${id}" id="dpa-${id}-${value}" data-field="dpaMode" value="${value}"${mode === value ? ' checked' : ''}><span>${label}</span></label>`
  ).join('');
  const timeField = (key, label) =>
    `<label>${label}<input type="time" data-field="${key}" value="${selection[key] == null ? '' : timeText(selection[key])}" aria-required="true"></label>`;
  const extraSlots = mode === 'consider' && !disabledCandidate ? (selection.dpaAvailableWindows || []).filter(([start, end]) => start !== selection.dpaStart || end !== selection.dpaEnd) : [];
  const slotLabels = owned ? ['取得した枠の開始', '取得した枠の終了'] : ['販売中の枠の開始', '販売中の枠の終了'];
  const note = owned ? '公式アプリの購入内容を入力してください。この枠を必ず予定に入れます。'
    : disabledCandidate ? '購入件数の上限が0件のため通常の待ち列を使います。'
    : mode === 'consider' ? '公式アプリで確認した枠を入力してください。予算と件数の上限内で通常利用と比べます。'
    : mode === 'unavailable' ? 'この施設はDPAを使わずに計画します。' : '';
  const location = showSlot && activity.category === 'parade' ?
    `<label class="full-field">DPAの集合・鑑賞場所<select data-field="nodeOverride" aria-required="true"><option value="">公式アプリの場所を選ぶ</option>${selectableNodes(park).map(n => `<option value="${escapeHtml(n.id)}"${selection.nodeOverride === n.id ? ' selected' : ''}>${escapeHtml(n.name || n.id)}</option>`).join('')}</select></label>` : '';
  return `<fieldset class="dpa-editor" aria-label="${escapeHtml(activity.name)}のディズニー・プレミアアクセス"><legend><abbr title="ディズニー・プレミアアクセス">DPA</abbr> <span>${money(activity.dpa.price)}／人</span></legend>
    <div class="dpa-choices">${radios}</div>
    ${showSlot && activity.category === 'attraction' && selection.repeatCount === 2 ? `<label class="repeat-wish">DPAを使う回<select data-field="dpaVisit"><option value=""${selection.dpaVisit == null ? ' selected' : ''}>自動（${autoVisit === 2 ? '2' : '1'}回目）</option><option value="1"${selection.dpaVisit === 1 ? ' selected' : ''}>1回目</option><option value="2"${selection.dpaVisit === 2 ? ' selected' : ''}>2回目</option></select></label><p class="dpa-help">もう一方の回は通常の待ち列で計画します。${selection.dpaVisit != null && selection.dpaVisit !== effectiveVisit ? ` 記録した体験と取得枠に従い、今回は${effectiveVisit}回目に使います。` : ''}</p>` : ''}
    ${note ? `<p class="dpa-help">${note}</p>` : ''}
    ${showSlot ? `<div class="wish-fields dpa-times">${timeField('dpaStart', slotLabels[0])}${timeField('dpaEnd', slotLabels[1])}${owned ? timeField('dpaPurchasedAt', '購入した時刻') : ''}</div>${!owned && activity.id === 'land-attraction-197' ? `<div data-dpa-example aria-live="polite">${dpaExampleHelp(selection, bounds)}</div>` : ''}${location}` : ''}
    ${extraSlots.length ? `<p class="dpa-help">ほかの購入候補枠　${extraSlots.map(([start, end]) => `${timeText(start)}–${timeText(end)}`).join('、')}</p>` : ''}
    ${purchase && !owned ? `<p class="dpa-help">支払済みに${money(purchase.cost)}を計上しています。<button type="button" class="text-button" data-open-purchase="${id}">購入履歴を確認</button></p>` : ''}
  </fieldset>`;
}

/** Apply the edited clock to its own range. Loading or displaying a ticket never changes its times. */
export function updateWishClock(selection, edited) {
  const key = edited.dataset.field;
  const isDpaSlot = key === 'dpaStart' || key === 'dpaEnd';
  const previousStart = selection.dpaStart, previousEnd = selection.dpaEnd;
  if (edited.value) selection[key] = minute(edited.value);
  else delete selection[key];
  if (isDpaSlot && selection.dpaMode === 'consider') {
    const alternatives = (selection.dpaAvailableWindows || []).filter(([start, end]) => start !== previousStart || end !== previousEnd);
    const {dpaStart, dpaEnd} = selection;
    selection.dpaAvailableWindows = Number.isInteger(dpaStart) && Number.isInteger(dpaEnd) && dpaStart < dpaEnd
      ? [[dpaStart, dpaEnd], ...alternatives.filter(([start, end]) => start !== dpaStart || end !== dpaEnd)] : alternatives;
  }
}

/** Purchased records are facts for the day, separate from a wish's current DPA mode. */
export function changeDpaMode(selection, mode, purchase) {
  selection.dpaMode = mode;
  for (const key of ['dpaStart', 'dpaEnd', 'dpaPurchasedAt', 'dpaAvailableWindows', 'nodeOverride', 'viewingNode']) delete selection[key];
  if (mode === 'owned' && purchase && purchase.id === selection.id) {
    Object.assign(selection, {dpaStart:purchase.start, dpaEnd:purchase.end, dpaPurchasedAt:purchase.purchasedAt});
  }
}

export const PARK_COPY = {
  land:['夢と魔法の1日を、','いちばん輝く順番で。'],
  sea:['イマジネーションの海を巡る、','最高の旅のスケジュール。'],
};

export function initialiseApp({plans, syncAfterEdit, refreshLibrary, isSharedPlan = () => false}) {
  let contingencyWorker = null, contingencyResult = null, contingencyBase = null, contingencyRequest = 0;
  let catalogue, calendarData, externalPanel, preparation = null, worker = null, requestId = 0, searchStarted = 0, progressTimer = null, latestPreview = null, wishlistGenre = 'all', lastBreakSuggestionResult = null, workflowView = 'wishlist', openedPlanId = null;
  let suspendedPrivate = null;
  let purchaseDraft, progressEditor, itineraryImage, onsiteCard;
  const modelCache=new Map();
  const visitOutlook=createVisitOutlook();
  let displayedOutlook, forecastCalendar;
  const restUndo=new WeakMap();
  // An invalid edit stays with its wish when the user switches genre or opens another card.
  const wishDrafts=new WeakMap();
  let state = {parkId:'land',settings:defaultSettings(),result:null,history:[],parkStates:{}};
  const currentPark = () => catalogue.parks.find(p => p.id === state.parkId) || catalogue.parks[0];
  const activities = () => currentPark().activities;
  const byId = id => activities().find(a => a.id === baseVisitId(id || ''));
  const setStatus = (message,error = false) => { $('status').textContent=message; $('status').classList.toggle('is-error',error); };
  const safely = action => async(...args) => { try {await action(...args);}catch(error){setStatus(error.message || '入力を確認してもう一度試してください。',true);} };
  const setSolveDisabled = disabled => {
    for(const button of document.querySelectorAll('[data-start-plan]'))button.disabled=disabled;
    itineraryImage?.refresh(state.result, state.resultDirty || disabled);
    onsiteCard?.refresh();
  };
  const numberInput = (id,min,max,step=1) => {
    const input=$(id),value=Number(input.value);
    if(input.value.trim()!==''&&Number.isFinite(value)&&value>=min&&value<=max&&(step===null||Number.isInteger(value/step)))return value;
    const name=input.labels?.[0]?.firstChild?.textContent.trim()||'数値';
    const unit=step===null?'範囲':step===1?'整数':step+'単位';
    throw inputError(`${name}は${min}〜${max}の${unit}で入力してください。`,id);
  };
  const timeInput = id => {
    try{return minute($(id).value);}
    catch{throw inputError('時刻を時・分まで入力してください。',id);}
  };
  const selected = id => state.settings.selections.find(s => s.id === id);

  function syncTimeEditors(){
    if(!catalogue)return;
    const bounds=parkTimeBounds(currentPark(),$('visitDate').value||state.settings.date);
    state.settings.entry=clampClock(state.settings.entry,bounds);state.settings.exit=clampClock(state.settings.exit,bounds);
    for(const s of state.settings.selections){for(const key of ['earliest','latest'])if(Number.isInteger(s[key]))s[key]=clampClock(s[key],bounds);}
    enhanceTimeInputs(document, {getBounds(input) {
      // Read the date on each edit as the main settings controls survive date changes.
      const day = parkTimeBounds(currentPark(), $('visitDate').value || state.settings.date);
      const key = input.dataset.field;
      const purchaseField = {purchaseTime:'purchasedAt', purchaseStart:'start', purchaseEnd:'end'}[input.id];
      if (purchaseField || ['dpaStart','dpaEnd','dpaPurchasedAt'].includes(key)) {
        // Published hours can change after an actual ticket has been saved.
        const purchase = purchaseField && state.settings.purchases.find(item => item.id === $('purchaseActivity').value);
        const saved = purchaseField ? purchase?.[purchaseField] : selected(input.closest('[data-wish-id]').dataset.wishId)?.[key];
        const bounds = purchaseField === 'purchasedAt' || key === 'dpaPurchasedAt' ? {min:480,max:1319} : day;
        return Number.isInteger(saved) ? {min: Math.min(bounds.min, saved), max: Math.max(bounds.max, saved)} : bounds;
      }
      return ['entryTime','exitTime','breakStart','replanTime','progressClock','progressFinish','progressDoneAt'].includes(input.id) ||
        ['earliest','latest'].includes(key) ? day : {min:480,max:1319};
    }});
    $('entryTime').value=timeText(state.settings.entry);$('exitTime').value=timeText(state.settings.exit);
  }
  function showWorkflow(name,{focus=false,scroll=false}={}) {
    workflowView=setWorkflowTab(document,name,{focus});
    onsiteCard?.refresh();
    if(scroll)$('workflowTabs').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function useOutlook(values) {
    const {waitModel,...weather}=values;
    if (state.settings.weather !== weather.weather) closeSharePanel();
    Object.assign(state.settings,weather);
    if(waitModel && state.settings.waitModel?.parkId!==state.parkId){
      state.settings.waitModel=waitModel;
      modelCache.set(state.parkId,waitModel);
    }
    $('weather').value=weather.weather;
  }
  function prepareVisitOutlook(preparedWeather) {
    const request=visitOutlook.resolve(currentPark(),state.settings,preparedWeather);
    if(request.values)useOutlook(request.values);
    if(request!==displayedOutlook) {
      displayedOutlook=request;
      if(!request.values) {
        state.settings.weatherForecast=null;
        if(state.settings.weatherMode!=='manual')state.settings.weatherNotice='訪問日の予報を確認中…';
        request.promise.then(values=>{
          if(request!==displayedOutlook)return;
          useOutlook(values);
          updateDayOverview();updateCrowd();renderSources();externalPanel?.refresh();
        }).catch(error=>{if(error.name!=='AbortError' && request===displayedOutlook)setStatus('訪問日の情報を確認できませんでした。',true);});
      }
    }
    return request;
  }
  function updateVisitPreferences(){
    const s=state.settings;
    const pace={50:'ゆっくり',70:'普通',90:'早め'}[s.speed] || `${s.speed} m/分`;
    const rest=s.restEvery && s.restMinutes ? `自動休憩 約${s.restEvery}分ごと` : '自動休憩なし';
    $('movementSummary').textContent=`歩く速さ ${pace} · ${rest}`;
  }
  function updateDayOverview(){
    forecastCalendar?.refresh();
    updateVisitPreferences();
    const s=state.settings;
    const pending=Boolean(displayedOutlook && !displayedOutlook.values);
    const autoCrowd=s.crowdLevel==='auto';
    const crowdTitle=autoCrowd?'混雑予想':'混雑の想定';
    const crowd=autoCrowd && pending ? {label:'確認中…',source:''} : crowdExplanation(currentPark(),s);
    const weather=visitWeatherSummary(s,{pending});
    $('dayCrowdTitle').textContent=crowdTitle;
    $('dayCrowdValue').textContent=crowd.label;
    $('dayCrowdSource').textContent=crowd.source;
    $('dayWeatherValue').textContent=weather.label;
    $('dayWeatherDetail').textContent=weather.detail;
    $('crowdOutlookTitle').textContent=crowdTitle;
    $('crowdOutlookValue').textContent=crowd.label;
    $('crowdOutlookSource').textContent=crowd.source;
    const details=visitDayDetails(currentPark(),s);
    $('dayTicketPrice').textContent=details?.adultOneDayYen ? money(details.adultOneDayYen) : '料金未確認';
    $('visitDayFacts').hidden=!details;
    const events = details?.events || [];
    $('visitEvents').hidden = !events.length;
    $('eventBadges').replaceChildren(...events.map(name => {
      const badge=document.createElement('span');
      badge.textContent=name;
      return badge;
    }));
    if(details){
      $('visitDayFactSummary').replaceChildren(...details.facts.map(fact => {
        const badge=document.createElement('span');
        badge.className='visit-fact-badge '+fact.tone;
        badge.textContent=fact.label;
        return badge;
      }));
    }
    const links=(details?.sources || []).filter(source=>safeLink(source.url)!=='#').map(source=>
      `<a href="${safeLink(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)} ↗</a>`);
    if(details?.report)links.push(`<a href="${escapeHtml(details.report)}">この日の予測の精度 →</a>`);
    $('visitDayFactSources').innerHTML=links.join(' ');
    $('livePlanStatus').textContent=s.liveNotice||'';$('livePlanStatus').hidden=!s.liveNotice;
  }
  function renderSavedPlans(){
    let summaries;
    try { summaries=plans.list(); }
    catch(error){$('savedPlanCount').textContent='利用できません';$('savedPlanList').textContent='この端末の保存領域を利用できません。「計画ファイルを使う」から保存できます。';$('savedPlanStatus').textContent=error.message;return;}
    $('savedPlanCount').textContent=`${summaries.length}件`;
    $('overwritePlan').hidden=!openedPlanId;
    $('savedPlanList').innerHTML=summaries.length?summaries.map(plan=>`<article class="saved-plan-card${plan.id===openedPlanId?' is-open':''}" data-saved-plan="${escapeHtml(plan.id)}"><div><strong>${escapeHtml(plan.name)}</strong><p>${plan.parkId==='sea'?'シー':'ランド'} · ${escapeHtml(plan.date)} · ${plan.hasSchedule?'しおりあり':'希望の条件'} · ${plan.updatedAt?escapeHtml(new Date(plan.updatedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})):'以前の保存'}</p></div><div class="saved-plan-actions"><button type="button" data-load-saved="${escapeHtml(plan.id)}">開く</button><button type="button" data-export-saved="${escapeHtml(plan.id)}" aria-label="「${escapeHtml(plan.name)}」をファイルに保存">ファイルに保存</button><button type="button" data-rename-saved="${escapeHtml(plan.id)}">名前を変更</button><button type="button" data-delete-saved="${escapeHtml(plan.id)}">削除</button></div><div class="saved-plan-rename" hidden><label>計画の名前<input type="text" maxlength="80" value="${escapeHtml(plan.name)}" data-saved-name="${escapeHtml(plan.id)}"></label><button type="button" data-commit-rename="${escapeHtml(plan.id)}">変更を保存</button></div></article>`).join(''):'<p class="field-note">保存した計画はまだありません。名前を付けて保存するとここに並びます。</p>';
  }
  function showSavedPlans(forSaving=false){
    refreshLibrary();
    $('savedPlansPanel').hidden=false;$('savedPlansPanel').open=true;renderSavedPlans();
    if(forSaving){if(!$('planName').value.trim())$('planName').value=`${state.settings.date} ${state.parkId==='sea'?'シー':'ランド'}`;$('planName').focus();}
    $('savedPlansPanel').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function personalMode() {
    if (suspendedPrivate) throw Error('先に共同編集を終了してください。共同計画は「自分用に保存」できます。');
  }
  function openJoint(value,name) {
    const next = cleanState(value);
    if (!suspendedPrivate) {
      readSettings();
      suspendedPrivate = {state, openedPlanId, name:$('planName').value, workflowView};
    }
    stopSearch(); closeSharePanel(); openedPlanId = null; state = next;
    $('planName').value = name;
    writeSettings(); updateContext(); renderSavedPlans(); showWorkflow(state.result?'schedule':'wishlist');
  }
  function leaveJoint() {
    if (!suspendedPrivate) return;
    stopSearch(); closeSharePanel();
    const original = suspendedPrivate;
    suspendedPrivate = null; state = original.state; openedPlanId = original.openedPlanId;
    $('planName').value = original.name;
    writeSettings(); updateContext(); renderSavedPlans(); showWorkflow(original.workflowView);
  }
  function saveCurrentPlan(overwrite=false){
    personalMode();
    readSettings();
    const summary=plans.save($('planName').value,state,overwrite && openedPlanId?{id:openedPlanId}:{});
    openedPlanId=summary.id;
    $('planName').value=summary.name;
    renderSavedPlans();
    $('savedPlanStatus').textContent=summary.conflict?'開いている間に元の計画が変更されたため、別のしおりとして保存しました。':`「${summary.name}」を${overwrite?'上書き':'新しく'}保存しました。`;
    setStatus($('savedPlanStatus').textContent);
    syncAfterEdit();
  }
  function saveSharedUpdate() {
    if (!openedPlanId || !isSharedPlan(openedPlanId)) return;
    try {
      const opened = plans.list().find(plan => plan.id === openedPlanId);
      if (!opened || opened.parkId !== state.parkId || opened.date !== state.settings.date) return;
      const saved = plans.save(opened.name,state,{id:openedPlanId});
      openedPlanId = saved.id;
      if (saved.conflict) {
        $('planName').value = saved.name;
        $('savedPlanStatus').textContent = '他の端末の変更と重なったため、別のしおりに保存しました。';
      }
      renderSavedPlans();
      syncAfterEdit();
    } catch (error) { setStatus(error.message || '共有するしおりを保存できませんでした。',true); }
  }
  function stopSearch(keepBest = false) {
    clearContingency();
    requestId++;
    if(preparation){preparation.abort();preparation=null;}
    if(worker){worker.terminate();worker=null;}
    clearInterval(progressTimer);progressTimer=null;
    setSolveDisabled(false);$('cancelSearch').hidden=true;$('searchProgress').hidden=true;$('scheduleEmptyText').textContent=state.result?'':'まだ計画は作成されていません。希望を選び、プランを考えてみましょう。';
    if(keepBest && latestPreview){state.result=latestPreview;state.resultDirty=false;renderResult();renderMap();saveSharedUpdate();}
  }
  function markResultStale(){closeSharePanel();clearPlanFeedback();if(worker||preparation){stopSearch();setStatus('条件を変更したため探索を止めました。新しい条件でプランを考えてください。');}if(state.result){state.resultDirty=true;renderResult();}}
  function rememberOwnedPurchase(selection){
    if(selection.dpaMode!=='owned'||!Number.isInteger(selection.dpaStart)||!Number.isInteger(selection.dpaEnd)||!Number.isInteger(selection.dpaPurchasedAt)||selection.dpaStart>=selection.dpaEnd||selection.dpaPurchasedAt>selection.dpaStart)return;
    const activity=byId(selection.id);if(!activity?.dpa)return;const purchases=state.settings.purchases||[];const existing=purchases.find(p=>p.id===selection.id);const purchase={id:selection.id,kind:activity.dpa.kind||'attraction',purchasedAt:selection.dpaPurchasedAt,start:selection.dpaStart,end:selection.dpaEnd,cost:existing?.cost ?? activity.dpa.price};
    if(existing)Object.assign(existing,purchase);else purchases.push(purchase);state.settings.purchases=purchases;refreshPurchaseEditor();renderPurchaseHistory();
  }
  function readSettings() {
    const settings={...state.settings,date:$('visitDate').value,entry:timeInput('entryTime'),exit:timeInput('exitTime'),weather:$('weather').value,weatherMode:$('weatherMode').value,speed:numberInput('walkSpeed',20,150),restEvery:numberInput('restEvery',0,480),restMinutes:numberInput('restMinutes',0,60),searchSeconds:numberInput('searchSeconds',0.1,120,null),searchMethod:$('searchMethod').value,budget:numberInput('budget',0,1000000,100),foodBudget:numberInput('foodBudget',0,1000000,100),dpaBudget:numberInput('dpaBudget',0,1000000,100),souvenirReserve:numberInput('souvenirReserve',0,1000000,100),souvenirMode:$('souvenirMode').value,budgetPreference:$('budgetPreference').value,crowdMode:$('crowdMode').value,crowdLevel:$('crowdLevel').value,history:state.history || [],spentBudget:numberInput('spentBudget',0,1000000,100)};
    settings.avoidConsecutiveFood=$('avoidConsecutiveFood').checked;
    const limitInput=$('dpaPurchaseLimit');
    if(limitInput.value===''&&!limitInput.validity.badInput)delete settings.dpaPurchaseLimit;
    else settings.dpaPurchaseLimit=numberInput('dpaPurchaseLimit',0,200);
    settings.waitBufferMode = $('waitBuffer').value === 'auto' ? 'auto' : 'fixed';
    settings.waitBufferMinutes = settings.waitBufferMode === 'auto' ? 5 : numberInput('waitBuffer',0,30);
    settings.queueDelayMinutes = numberInput('queueDelay',0,60);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(settings.date))throw inputError('訪問日を指定してください。','visitDate');
    if(settings.entry>=settings.exit)throw inputError('退園予定は入園予定より後にしてください。','exitTime');
    if(settings.souvenirReserve>settings.budget)throw inputError('お土産に残す金額を予算上限以下にしてください。','souvenirReserve');
    settings.purchases=Array.isArray(state.settings.purchases)?state.settings.purchases:[];
    if($('replanEnabled').checked){
      settings.replanFrom=timeInput('replanTime');
      if(settings.replanFrom<settings.entry||settings.replanFrom>=settings.exit)throw inputError('組み替え開始は入園予定から退園予定より前の時刻にしてください。','replanTime');
      if($('currentNode').value)settings.currentNode=$('currentNode').value;
      else delete settings.currentNode;
    }else{delete settings.replanFrom;delete settings.currentNode;}
    if(settings.weatherMode==='manual'){settings.weatherForecast=null;settings.weatherNotice='天気は手動の設定を使います。';}
    else if(state.settings.weatherMode==='manual'){settings.weatherForecast=null;settings.weatherNotice='訪問日の予報を確認中…';}
    state.settings=settings;for(const selection of settings.selections)rememberOwnedPurchase(selection);return settings;
  }
  function syncManualWeather() {
    const manual=$('weatherMode').value==='manual';
    $('manualWeatherField').hidden=!manual;
    $('weather').disabled=!manual;
  }
  function writeSettings() {
    closeSharePanel();
    const s=state.settings;const bounds=parkTimeBounds(currentPark(),s.date);s.entry=clampClock(s.entry,bounds);s.exit=clampClock(s.exit,bounds);
    for (const [id, value] of [['waitBuffer',s.waitBufferMode === 'auto' ? 'auto' : String(s.waitBufferMinutes ?? 0)],['queueDelay',String(s.queueDelayMinutes ?? 0)]]) {
      const control=$(id);control.querySelector('[data-custom-margin]')?.remove();
      if (![...control.options].some(option => option.value === value)) {const option=document.createElement('option');option.value=value;option.textContent=`${value}分`;option.dataset.customMargin='true';control.append(option);}
      control.value=value;
    }
    $('walkSpeed').querySelector('[data-custom-speed]')?.remove();if(![50,70,90].includes(Number(s.speed))){const option=document.createElement('option');option.value=s.speed;option.textContent=`指定した速さ（${s.speed} m/分）`;option.dataset.customSpeed='true';$('walkSpeed').append(option);}
    $('searchSeconds').querySelector('[data-custom-duration]')?.remove();if(![5,15,30,60,120].includes(Number(s.searchSeconds))){const option=document.createElement('option');option.value=s.searchSeconds;option.textContent=`指定した上限（${s.searchSeconds}秒）`;option.dataset.customDuration='true';$('searchSeconds').append(option);}
    for(const [id,key] of Object.entries({visitDate:'date',weather:'weather',weatherMode:'weatherMode',walkSpeed:'speed',restEvery:'restEvery',restMinutes:'restMinutes',searchSeconds:'searchSeconds',searchMethod:'searchMethod',budget:'budget',foodBudget:'foodBudget',dpaBudget:'dpaBudget',souvenirReserve:'souvenirReserve',souvenirMode:'souvenirMode',budgetPreference:'budgetPreference',crowdMode:'crowdMode',crowdLevel:'crowdLevel',spentBudget:'spentBudget'}))$(id).value=String(s[key] ?? defaultSettings()[key]);
    syncManualWeather();
    $('avoidConsecutiveFood').checked=s.avoidConsecutiveFood===true;
    $('dpaPurchaseLimit').value=s.dpaPurchaseLimit??'';
    $('weatherStatus').textContent=s.weatherNotice||(s.weatherMode==='manual'?'天気は手動の設定を使います。':'訪問日の予報を確認中…');
    $('entryTime').value=timeText(s.entry);$('exitTime').value=timeText(s.exit);$('replanEnabled').checked=Number.isInteger(s.replanFrom);$('replanTime').value=timeText(s.replanFrom ?? 840);renderPurchaseHistory();renderFixedBreaks();updateDayOverview();syncTimeEditors();
  }
  function cleanState(value) {
    if(!value || typeof value!=='object'||!catalogue.parks.some(p=>p.id===value.parkId)||!value.settings || !Array.isArray(value.settings.selections))throw Error('この計画データの形式を確認してください。');
    const park=catalogue.parks.find(p=>p.id===value.parkId),ids=new Set(park.activities.map(a=>a.id));
    const selections=value.settings.selections.filter(s=>s&&typeof s==='object'&&ids.has(s.id));
    for(const s of selections){
      if(s.dpaMode==='owned'){
        const record=value.settings.purchases?.find(p=>p.id===s.id);
        if(record && (s.dpaStart==null || s.dpaStart===record.start) && (s.dpaEnd==null || s.dpaEnd===record.end)){
          s.dpaStart??=record.start;s.dpaEnd??=record.end;s.dpaPurchasedAt??=record.purchasedAt;
        }
      }
      const first=s.dpaAvailableWindows?.[0];
      if(s.dpaMode==='consider'&&first&&s.dpaStart==null&&s.dpaEnd==null)[s.dpaStart,s.dpaEnd]=first;
    }
    visitOutlook.cancel();displayedOutlook=null;
    return {parkId:value.parkId,settings:{...defaultSettings(),...value.settings,crowdLevel:value.settings.crowdLevel??'normal',avoidConsecutiveFood:value.settings.avoidConsecutiveFood??false,waitBufferMode:value.settings.waitBufferMode??'fixed',waitBufferMinutes:value.settings.waitBufferMinutes??0,queueDelayMinutes:value.settings.queueDelayMinutes??0,selections},result:value.result||null,resultDirty:!!value.resultDirty,history:Array.isArray(value.history)?value.history:[],parkStates:{}};
  }
  function updateContext() {
    clearPlanFeedback();
    const park=currentPark(),s=state.settings;if(calendarData&&!s.calendarData)s.calendarData=calendarData;if(s.waitModel?.parkId===park.id)modelCache.set(park.id,s.waitModel);else if(modelCache.has(park.id))s.waitModel=modelCache.get(park.id);
    document.body.dataset.park=state.parkId;
    document.title=`TDRoute — ${park.name}`;
    const copy=PARK_COPY[state.parkId]||PARK_COPY.land;
    $('pageTitle').innerHTML=`<span>${copy[0].replace('イマジネーション','<span class="unbroken">イマジネーション</span>')}</span><em>${copy[1]}</em>`;
    $('landTab').setAttribute('aria-selected',String(state.parkId==='land'));$('seaTab').setAttribute('aria-selected',String(state.parkId==='sea'));
    $('landTab').tabIndex=state.parkId==='land'?0:-1;$('seaTab').tabIndex=state.parkId==='sea'?0:-1;
    $('officialMapLink').href=park.mapUrl || park.officialUrl;$('officialParkLink').href=park.officialUrl;
    const short=state.parkId==='sea'?'tds':'tdl';$('dailyLink').href=`https://www.tokyodisneyresort.jp/${short}/daily/calendar/${s.date.replaceAll('-','')}/`;
    $('currentNode').replaceChildren(new Option('しおりの順路から推定',''));
    for(const node of selectableNodes(park)){const option=document.createElement('option');option.value=node.id;option.textContent=node.name || node.id;$('currentNode').append(option);}
    if(s.currentNode&&park.nodes.some(node=>node.id===s.currentNode&&node.routingOnly)){const option=document.createElement('option');option.value=s.currentNode;option.textContent='現在地点（保存した位置）';$('currentNode').append(option);}
    $('currentNode').value=s.currentNode || '';
    const breakNode=$('breakNode').value;$('breakNode').replaceChildren();
    for(const node of selectableNodes(park)){const option=document.createElement('option');option.value=node.id;option.textContent=node.name||node.id;$('breakNode').append(option);}
    $('breakNode').value=selectableNodes(park).some(n=>n.id===breakNode)?breakNode:park.entryNode;renderFixedBreaks();
    const purchaseId=$('purchaseActivity').value;$('purchaseActivity').replaceChildren();for(const a of park.activities.filter(a=>a.dpa)){const option=document.createElement('option');option.value=a.id;option.textContent=a.name;$('purchaseActivity').append(option);}$('purchaseActivity').value=park.activities.some(a=>a.id===purchaseId&&a.dpa)?purchaseId:park.activities.find(a=>a.dpa)?.id||'';refreshPurchaseEditor();renderPurchaseHistory();
    $('dataVersion').textContent=`施設・イベントの確認日：${catalogue.updatedAt || park.updatedAt || 'データ内の出典を確認'} / データ版 ${catalogue.version || '—'}。フードの予算は変更できます。施設・休止・イベントは毎朝6:15に更新を確認し、待ち時間は両園の閉園後に採点し、再学習します。${catalogue.fetchedAt?` 最終取得 ${new Date(catalogue.fetchedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}`:''}${catalogueRefreshNotice(catalogue)}`;
    prepareVisitOutlook();updateDayOverview();updateCrowd();renderCatalogue();renderWishlist();renderMap();renderResult();renderSources();syncTimeEditors();
    document.dispatchEvent(new CustomEvent('park-context-change',{detail:{park,settings:state.settings,history:state.history}}));
  }
  function refreshPurchaseEditor() {
    const id=$('purchaseActivity').value;
    const record=state.settings.purchases.find(p=>p.id===id);
    const signature=record ? [record.purchasedAt,record.start,record.end,record.cost].join('/') : '';
    const scope=[state,state.parkId,state.settings.date,id,signature];
    if(purchaseDraft && scope.every((value,i)=>value===purchaseDraft[i]))return;
    purchaseDraft=scope;
    for(const [field,key] of [['purchaseTime','purchasedAt'],['purchaseStart','start'],['purchaseEnd','end']]){
      const input=$(field);
      input.value=record ? timeText(record[key]) : '';
      input.dispatchEvent(new Event('change')); // Refresh the visible hour/minute controls only.
    }
    $('purchaseCost').value=record?.cost ?? byId(id)?.dpa?.price ?? '';
    $('addPurchase').textContent=record ? '購入内容を更新' : '購入履歴へ追加 ＋';
  }
  function renderPurchaseHistory(){if(!catalogue)return;const purchases=state.settings.purchases||[];$('purchaseHistory').innerHTML=purchases.length?purchases.map((p,index)=>`<div class="purchase-item" id="purchase-record-${escapeHtml(p.id)}" tabindex="-1"><strong>${escapeHtml(byId(p.id)?.name||p.id)}</strong><p>購入 ${timeText(p.purchasedAt)} · 利用 ${timeText(p.start)}–${timeText(p.end)} · ${money(p.cost)}</p><button type="button" data-remove-purchase="${index}">履歴から外す</button></div>`).join(''):'<p class="field-note">購入履歴はまだありません。</p>';}
  function updateCrowd() {
    $('weatherStatus').textContent=state.settings.weatherNotice||(state.settings.weatherMode==='manual'?'天気は手動の設定を使います。':'訪問日の予報を確認中…');
    const s=state.settings;
    $('crowdExplanation').textContent=s.crowdMode==='manual'?'待ち時間：希望欄の手動設定':'待ち時間：当日の情報・学習モデル・履歴から推定';
    $('historyStatus').textContent=`待ち時間の実績データ：${state.history?.length ? `${state.history.length}件を読込済み` : '未読込'}`;
  }
  function renderSources() {
    if(!catalogue)return;
    const park=currentPark(),s=state.result?.settings||state.settings,map=park.geographicMap;
    const stamp=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'未取得';
    const chosen=new Set(state.settings.selections.map(item=>item.id));
    const facilities=chosen.size?park.activities.filter(a=>chosen.has(a.id)):park.activities;
    const warnings=catalogueRefreshNotice(catalogue);
    $('sourceSummary').textContent=warnings?'一部未更新':'';
    $('sourceDetails').innerHTML=`<div class="source-grid"><section><h3>施設・営業予定</h3><p>公式情報の取得 ${escapeHtml(stamp(catalogue.fetchedAt))}</p>${warnings?`<p class="source-warning">${escapeHtml(warnings)}</p>`:''}<p>施設名・営業時間・公演時刻・休止は公式情報を使用します。料金や時間帯は訪問日の条件をご確認ください。</p></section><section><h3>地図・徒歩ルート</h3><p>© OpenStreetMap contributors / ODbL 1.0</p><p>通路・水域・建物の形を保って表示方向と配色を調整しています。施設は付近の公開通路上の参考位置です。待ち列内と建物内の距離は含みません。</p><a href="data/${park.id}-geography-LICENCE.md" target="_blank" rel="noopener noreferrer">地図の出典と利用条件 ↗</a>${map?`<p>地図データ取得 ${escapeHtml(map.asOf||'—')}</p>`:''}</section><section><h3>待ち時間と計画値</h3><p>当日の待ち時間・稼働状況はQueue-TimesとThemeParks.wikiを使用します。来園前は学習モデル・履歴・傾向モデルから予測します。</p><p>待ち時間への余裕は計画用の目安です。自動は検証の平均誤差を使い、遅れを防ぐ保証ではありません。</p><p>徒歩・待ち時間・食事と買い物の費用は計画用の目安です。</p></section></div><details class="source-facilities"><summary>${chosen.size?'選択中の':'収録している'}施設の公式情報</summary><div class="source-facility-list">${facilities.map(a=>`<article><a href="${safeLink(a.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.name)} ↗</a><span>${a.operatingDate?`営業確認 ${escapeHtml(a.operatingDate)}`:''}${a.menuCheckedOn?` · メニュー確認 ${escapeHtml(a.menuCheckedOn)}`:''}</span></article>`).join('')}</div></details>`;
    const infos=(state.result?.rows||[]).filter(row=>['activity','rest'].includes(row.kind||row.type)).map(row=>weatherForMinute(s,Number(row.start)));
    if(!infos.length)infos.push(weatherForMinute(s,s.entry));
    $('forecastSources').innerHTML=forecastSourcesHtml(infos);
  }
  function renderCatalogue() {
    const query=$('catalogueSearch').value.trim().toLocaleLowerCase('ja'),category=$('categoryFilter').value;
    const list=orderedFacilities(activities().filter(a=>`${a.name} ${a.area} ${menuNames(a).join(' ')}`.toLocaleLowerCase('ja').includes(query)&&(category==='all'||category==='food'&&FOOD.has(a.category)||category==='dining'&&['restaurant','cafe'].includes(a.category)||category==='snacks'&&['snack','popcorn'].includes(a.category)||category==='entertainment'&&ENTERTAINMENT.has(a.category)||a.category===category)));
    $('catalogue').innerHTML=list.length?list.map((a,index)=>`${['snack','popcorn'].includes(a.category)&&list[index-1]?.category!==a.category?`<h3 class="catalogue-group-title">${CATEGORY[a.category]}</h3>`:''}<article class="place-card genre-${genreOf(a.category)}${selected(a.id)?' selected':''}"><button class="place-select" type="button" data-add="${escapeHtml(a.id)}" aria-pressed="${!!selected(a.id)}" aria-label="${escapeHtml(a.name)}を希望${selected(a.id)?'から外す':'に追加'}"${activitySchedule(a,state.settings.date).closed&&!selected(a.id)?' disabled':''}><span class="place-kind">${escapeHtml(CATEGORY[a.category]||a.category)}${activitySchedule(a,state.settings.date).closed?' · 訪問日は休止予定':''}</span><strong>${escapeHtml(a.name)}</strong><span class="place-meta"><span>${escapeHtml(a.area||'')}${a.dpa?' / DPA':''}</span><span class="place-plus">${selected(a.id)?'✓':'＋'}</span></span></button>${foodLinks(a)}</article>`).join(''):'<p class="empty-message">条件に合う施設がありません。検索条件を変えてみましょう。</p>';
    $('selectionCount').textContent=`${state.settings.selections.length}件の希望`;
  }
  function newWish(a) {
    const wish={id:a.id,weight:3,required:false,dpaMode:'none',manualWait:Number(a.baseWait)||0,cost:Math.ceil((Number(a.cost)||0)/100)*100,duration:a.duration};
    if(ENTERTAINMENT.has(a.category)) {
      const schedule=activitySchedule(a,state.settings.date);
      wish.showTimes=schedule.showTimes.slice();wish.confirmSchedule=schedule.confirmed;
    }
    return wish;
  }
  function addSelection(id) {
    const a=byId(id);
    if(!a)return;
    if(!selected(id)&&activitySchedule(a,state.settings.date).closed){
      setStatus(`${a.name}は訪問日に休止予定です。別の日や施設を選んでください。`,true);
      return;
    }
    const adding=!selected(id);
    toggleWantedSelection(state.settings,adding?newWish(a):{id});
    if(adding&&wishlistGenre!=='all')wishlistGenre=genreOf(a.category);
    markResultStale();renderCatalogue();renderWishlist();renderMap();setStatus('');
  }
  function renderWishPresets() {
    const fresh=presetStartsPlan(state);
    $('wishPresetHelp').textContent=fresh?'テーマを選ぶと、その希望でしおりを作成します。':'テーマを選ぶと、今の希望に施設を追加します。';
    $('wishPresetFeedback').textContent='';
    $('wishPresetChoices').innerHTML=WISH_PRESETS.map(({id,label})=>{
      const facilities=presetFacilities(currentPark(),state.settings,id);
      const preview=facilities.slice(0,2).map(a=>a.name).join('、');
      return `<button type="button" data-wish-preset="${id}"${facilities.length?'':' disabled'}><strong>${label}</strong><span>${preview?escapeHtml(preview)+(facilities.length>2?' ほか':''):'この日の候補はありません'}</span></button>`;
    }).join('');
  }
  function addWishPreset(presetId) {
    const fresh=presetStartsPlan(state);
    const settings=state.settings, facilities=presetFacilities(currentPark(),settings,presetId);
    if(!facilities.length)return;
    const added=addPresetWishes(settings,facilities,a=>{
      const wish=newWish(a);
      if(a.category==='restaurant'){
        const late=settings.entry>=900;
        const from=Math.max(settings.entry,late?1020:660),until=Math.min(settings.exit,late?1200:840);
        if(until-from>=wish.duration){wish.earliest=from;wish.latest=until;}
      }
      return wish;
    });
    if(added){
      wishlistGenre='all';
      markResultStale();renderCatalogue();renderWishlist();renderMap();
    }
    if(fresh)return startSearch();
    $('wishPresetFeedback').textContent=added?`${added}件を希望に追加しました。`:'このテーマの候補はすべて希望に入っています。';
    $('wishPresetChoices').querySelector(`[data-wish-preset="${presetId}"]`)?.focus({preventScroll:true});
  }
  function wishTimeDefaults() {
    const {date,entry,exit}=state.settings;
    return parkTimeBounds(currentPark(),date,{min:entry,max:exit});
  }
  function renderWishlist() {
    renderWishPresets();
    const all=state.settings.selections,bounds=parkTimeBounds(currentPark(),state.settings.date);
    const wishDefaults=wishTimeDefaults();
    for(const s of all)for(const key of ['earliest','latest'])if(Number.isInteger(s[key]))s[key]=clampClock(s[key],bounds);
    const list=orderedFacilities(all.filter(s=>wishlistGenre==='all'||genreOf(byId(s.id)?.category)===wishlistGenre).map(s=>({selection:s,category:byId(s.id)?.category}))).map(item=>item.selection);
    $('wishlistTabs').innerHTML=GENRES.map(g=>{const count=all.filter(s=>g.id==='all'||genreOf(byId(s.id)?.category)===g.id).length;return `<button type="button" id="wishTab-${g.id}" class="genre-tab genre-${g.id}" role="tab" aria-controls="wishlist" aria-selected="${wishlistGenre===g.id}" tabindex="${wishlistGenre===g.id?0:-1}" data-wish-genre="${g.id}">${g.label}<span>${count}</span></button>`;}).join('');
    $('wishlist').setAttribute('aria-labelledby',`wishTab-${wishlistGenre}`);
    $('wishlist').innerHTML=list.length?list.map((s,index)=>{
      const a=byId(s.id);if(!a)return '';
      const timed=FOOD.has(a.category),show=ENTERTAINMENT.has(a.category),greeting=a.category==='greeting',paid=FOOD.has(a.category)||a.category==='shop';
      const schedule=activitySchedule(a,state.settings.date),scheduleCurrent=schedule.confirmed;
      const wishTimes = `<label>この時刻から<input type="time" data-field="earliest" value="${timeText(s.earliest ?? wishDefaults.min)}"></label>
        <label>この時刻までに終了<input type="time" data-field="latest" value="${timeText(s.latest ?? wishDefaults.max)}"></label>`;
      const ownedDpa=s.dpaMode==='owned',required=ownedDpa||s.required;
      const autoVisit=s.repeatCount===2&&a.dpa?resolveDpaVisit({...s,dpaVisit:undefined},state.settings,state.result):1;
      const effectiveVisit=s.dpaVisit ? resolveDpaVisit(s,state.settings,state.result) : autoVisit;
      const dpa=dpaEditor(a,s,currentPark(),state.settings.purchases.find(p=>p.id===s.id),state.settings.dpaPurchaseLimit,bounds,autoVisit,effectiveVisit);
      const groupTitle=['snack','popcorn'].includes(a.category)&&byId(list[index-1]?.id)?.category!==a.category?`<h3 class="catalogue-group-title">${CATEGORY[a.category]}</h3>`:'';
      const pauseInfo=a.id==='sea-attraction-230'?operationPauseInfo(currentPark(),a,s,state.settings):null;
      return `${groupTitle}<article class="wish-card genre-${genreOf(a.category)}" data-wish-id="${escapeHtml(s.id)}"><div class="wish-heading"><div><p class="wish-category">${escapeHtml(CATEGORY[a.category]||a.category)} / ${escapeHtml(a.area||'')}</p><h4>${escapeHtml(a.name)}</h4></div><button class="remove-wish" data-remove="${escapeHtml(s.id)}" type="button" aria-label="${escapeHtml(a.name)}を希望から外す">×</button></div>${foodLinks(a)}${schedule.closed?'<p class="schedule-note">訪問日は休止予定です。別の日や施設を検討してください。</p>':''}${a.category==='attraction'?`<label class="repeat-wish">乗りたい回数<select data-field="repeatCount"><option value="1"${s.repeatCount===2?'':' selected'}>1回</option><option value="2"${s.repeatCount===2?' selected':''}>2回</option></select></label>`:''}<div class="wish-main-controls"><div class="weight-control${required?' is-required':''}"><span>${required?'必須 <strong>必ず入れる条件</strong>':`重要度 <strong>${s.weight} · ${escapeHtml(WEIGHT_LABELS[s.weight]||'行きたい')}</strong>`}</span><div class="weight-buttons" role="group" aria-label="${escapeHtml(a.name)}の重要度">${weightButtons({...s,required})}</div></div><label class="check-field"><input type="checkbox" data-field="required"${required?' checked':''}${ownedDpa?' disabled':''}>必ず入れる</label></div><div class="wish-fields">${timed ? wishTimes : ''}${paid?`<label>${a.category==='shop'?'使いたい金額':'フードの予算'}<input type="number" min="0" max="1000000" step="100" data-field="cost" value="${escapeHtml(s.cost ?? a.cost ?? 0)}" aria-label="${escapeHtml(a.name)}の予算（円）"></label>`:''}<label>体験・滞在（待ち時間を除く）<input type="number" min="1" max="360" step="1" data-field="duration" value="${escapeHtml(s.duration ?? a.duration)}" aria-label="${escapeHtml(a.name)}の滞在時間（分）"></label><label>待ち時間（手動時）<input type="number" min="0" max="360" step="5" data-field="manualWait" value="${escapeHtml(s.manualWait ?? a.baseWait)}" aria-label="${escapeHtml(a.name)}の待ち時間（分）"></label></div>${timed ? '' : `<details class="wish-details"${s.earliest != null || s.latest != null ? ' open' : ''}><summary>希望の時間帯</summary><div class="wish-fields">${wishTimes}</div></details>`}${show?`<div class="schedule-note">公演時刻：${scheduleCurrent?`${escapeHtml(schedule.date)}の公式時刻を表示しています。`:'訪問日の公式情報を確認して入力してください。必須にしていない公演は時刻が未入力でも他の希望を計画できます。'}${a.showTimesDate?` 収録データの確認日 ${escapeHtml(a.showTimesDate)}`:''}${a.scheduleNote?` ${escapeHtml(a.scheduleNote)}`:''}</div><label class="full-field">訪問日の開演時刻（例 11:00, 13:30）<input type="text" data-field="showTimes" value="${escapeHtml((s.showTimes||[]).map(timeText).join(', '))}" placeholder="11:00, 13:30"></label><label class="check-field section-gap"><input type="checkbox" data-field="confirmSchedule"${s.confirmSchedule?' checked':''}>この日の公演時刻を確認した</label>`:''}${a.access&&a.access!=='normal'?`<div class="access-note"><label><input type="checkbox" data-field="confirmedAccess"${s.confirmedAccess?' checked':''}>${a.access==='entry'?'エントリー受付の結果・入場条件を確認した':'予約・利用条件を確認した'}</label></div>`:''}${pauseInfo?`<div class="gondola-note"><label class="check-field"><input type="checkbox" data-setting="gondolaAvoidHarbourShows"${state.settings.gondolaAvoidHarbourShows!==false?' checked':''}>ショー上演中を避ける目安</label><p>${escapeHtml(pauseInfo.note)}</p><p data-pause-summary${pauseInfo.windows.length?'':' hidden'}>${pauseWindowSummary(pauseInfo)}</p><label class="full-field">確認した休止時間（例 12:00-13:00）<input type="text" data-field="pauseWindows" value="${escapeHtml((s.pauseWindows||[]).map(pair=>pair.map(timeText).join('-')).join(', '))}" placeholder="12:00-13:00, 19:00-20:00"></label></div>`:''}${dpa}<details class="wish-details"><summary>営業時間を調整する</summary><p class="wish-foot">${escapeHtml(a.dailySchedules?.[state.settings.date]?state.settings.date:a.operatingDate||a.windowsDate||'収録データ')}の営業時間を基準に計算します。訪問日の営業に合わせて変更できます。</p><div class="wish-fields"><label>営業開始<input type="time" data-field="windowStart" value="${timeText(s.windows?.[0]?.[0] ?? schedule.windows?.[0]?.[0] ?? state.settings.entry)}"></label><label>営業終了<input type="time" data-field="windowEnd" value="${timeText(s.windows?.[0]?.[1] ?? schedule.windows?.[0]?.[1] ?? state.settings.exit)}"></label></div></details></article>`;
    }).join(''):all.length?'<p class="empty-message">このジャンルの希望はまだありません。施設カードから追加できます。</p>':'<p class="empty-message">地図や施設カードから行きたい場所を選んでください。</p>';
    for(const card of $('wishlist').querySelectorAll('[data-wish-id]')){
      const drafts=wishDrafts.get(selected(card.dataset.wishId));
      if(!drafts?.size)continue;
      for(const input of card.querySelectorAll('[data-field]')){
        const draft=drafts.get(input.dataset.field);
        if(draft)input.value=draft.value;
      }
    }
    syncTimeEditors();
  }
  function updateSelection(event) {
    const target=event.target,card=target.closest('[data-wish-id]');if(!card)return;if(target.dataset.setting==='gondolaAvoidHarbourShows'){state.settings.gondolaAvoidHarbourShows=target.checked;markResultStale();renderWishlist();return;}if(!target.dataset.field)return;
    const s=selected(card.dataset.wishId);if(!s)return;
    const key=target.dataset.field;
    if(key==='repeatCount'){
      const count=Number(target.value), second=state.settings.dayProgress?.visits[repeatVisitId(s.id)];
      if(count===1&&second&&['done','riding','queue'].includes(second.status)){
        target.value='2';throw Error('2回目の体験状況を訂正してから回数を減らしてください。');
      }
      if(count===2)s.repeatCount=2;
      else {delete s.repeatCount;delete s.dpaVisit;}
      markResultStale();renderWishlist();return;
    }
    if(key==='dpaVisit'){
      if(['1','2'].includes(target.value))s.dpaVisit=Number(target.value);else delete s.dpaVisit;
      markResultStale();renderWishlist();
      [...$('wishlist').querySelectorAll('[data-wish-id]')].find(card=>card.dataset.wishId===s.id)?.querySelector('[data-field="dpaVisit"]')?.focus({preventScroll:true});
      return;
    }
    if(key==='dpaMode'){
      changeDpaMode(s,target.value,state.settings.purchases.find(p=>p.id===s.id));
      renderWishlist();
      $(`dpa-${s.id}-${s.dpaMode}`)?.focus({preventScroll:true});
      markResultStale();
      return;
    }
    if(target.type==='checkbox')s[key]=target.checked;
    else if(['earliest','latest','dpaStart','dpaEnd','dpaPurchasedAt'].includes(key)){
      updateWishClock(s, target);
      if(!target.value && (key==='earliest'||key==='latest')){
        const defaults=wishTimeDefaults();
        target.value=timeText(key==='earliest'?defaults.min:defaults.max);
        syncTimeEditors();
      }
      if(key==='dpaStart'||key==='dpaEnd'){
        const help=card.querySelector('[data-dpa-example]');
        if(help)help.innerHTML=dpaExampleHelp(s,parkTimeBounds(currentPark(),state.settings.date));
      }
    }
    else if(['windowStart','windowEnd'].includes(key)){const a=byId(s.id);const window=(s.windows?.[0]||activitySchedule(a,state.settings.date).windows?.[0]||[state.settings.entry,state.settings.exit]).slice();window[key==='windowStart'?0:1]=minute(target.value);if(window[0]>=window[1])throw Error('営業終了を開始より後にしてください。');s.windows=[window];}
    else if(key==='pauseWindows'){s.pauseWindows=target.value.split(/[,、]+/).map(value=>value.trim()).filter(Boolean).map(value=>{const pair=value.split(/[-–〜]/).map(value=>minute(value.trim()));if(pair.length!==2||pair[0]>=pair[1]||pair[0]<480||pair[1]>1319)throw Error('休止時間は08:00〜21:59の開始-終了で入力してください。');return pair;});
      const info=operationPauseInfo(currentPark(),byId(s.id),s,state.settings),note=card.querySelector('[data-pause-summary]');
      note.textContent=pauseWindowSummary(info);note.hidden=!info.windows.length;
    }
    else if(key==='showTimes'){s.showTimes=target.value.split(/[,、\s]+/).filter(Boolean).map(minute);}
    else if(target.type==='number'){const value=Number(target.value);if(target.value===''||!Number.isInteger(value)||value<Number(target.min)||value>Number(target.max)||target.validity?.stepMismatch)throw Error(`${target.min}〜${target.max}の${target.step==='1'?'整数':target.step+'単位'}で入力してください。`);s[key]=value;}
    else s[key]=target.value;
    if(['dpaStart','dpaEnd','dpaPurchasedAt'].includes(key))rememberOwnedPurchase(s);
    if(key==='nodeOverride'&&!s.nodeOverride)delete s.nodeOverride;
    if(key==='required')renderWishlist();if(event.type!=='input')markResultStale();
  }
  function renderMap(){ if(catalogue)renderParkMap($('parkMap'),currentPark(),{plan:state.result,selectedIds:state.settings.selections.map(s=>s.id),onSelect:addSelection}); }
  function renderResult() {
    if (state.resultDirty || (contingencyBase && contingencyBase !== state.result)) clearContingency();
    progressEditor?.refresh();
    itineraryImage?.refresh(state.result, state.resultDirty || !!worker || !!preparation);
    onsiteCard?.refresh();
    const result=state.result;$('results').hidden=!result;$('scheduleEmpty').hidden=!!result;renderSources();if(!result)return;renderFixedBreaks();
    const t=result.totals||{},c=result.coverage||{};
    $('resultState').textContent=state.resultDirty?'前の条件で作った計画':result.status==='feasible'?'見つかった計画':result.status==='no-plan'?'条件を見直そう':'入力を確認';
    const percent=Number(c.percent)||0;
    $('resultSummary').innerHTML=`<div class="metric"><strong>${Math.round(percent)}<small>%</small></strong><span>希望の重要度を反映</span></div><div class="metric"><strong>${escapeHtml(c.count ?? result.visits?.length ?? 0)}<small> / ${escapeHtml(c.totalCount ?? state.settings.selections.length)}</small></strong><span>予定に入った希望</span></div><div class="metric"><strong>${(Number(t.walkingMetres||0)/1000).toFixed(1)}<small> km</small></strong><span>歩く距離の目安</span></div><div class="metric"><strong>${Math.round(Number(t.cost)||0).toLocaleString('ja-JP')}<small>円</small></strong><span>予定の支出合計</span></div>`;
    const planSettings=result.settings||state.settings;
    const dpaLimit=planSettings.dpaPurchaseLimit;
    let dpaCountNote='';
    if(Number.isInteger(t.plannedDpaCount)&&(t.plannedDpaCount||dpaLimit!==undefined)){
      const limitNote=dpaLimit===undefined?'':`・上限${dpaLimit}件`;
      dpaCountNote=t.plannedDpaCount>dpaLimit?`（開始済み${t.plannedDpaCount}件・今後の追加0件）`:`（購入候補から${t.plannedDpaCount}件${limitNote}）`;
    }
    const actions=state.resultDirty?[]:noPlanActions(result,currentPark());
    $('noPlanActions').hidden=!actions.length;
    $('noPlanActions').innerHTML=actions.map(item=>`<button type="button" data-plan-field="${escapeHtml(item.field)}" data-plan-wish="${escapeHtml(item.wishId||'')}">${escapeHtml(item.label)}を確認</button>`).join('');
    $('resultSummary').hidden=result.status==='no-plan';
    $('resultExplanation').textContent=result.status==='feasible'?`${state.resultDirty?'条件を変更しています。現在の希望で再探索してください。 ':''}${planSettings.date} ${timeText(planSettings.entry)}–${timeText(planSettings.exit)} · フード ${money(t.foodCost)} · DPA ${money(t.dpaCost)}${dpaCountNote} · お土産 ${money(t.shoppingCost)}。残り ${money(t.budgetRemaining)}${t.souvenirAllocation?` · お土産へ ${money(t.souvenirAllocation)}`:''}。`:state.resultDirty?'前の条件で探索した結果です。変更した条件でプランを考えてください。':noPlanExplanation(result,currentPark());
    const lastSkip=state.resultDirty?null:restUndo.get(result);
    const canEditRest=!state.resultDirty&&!preparation&&!worker;
    const foodAdjacentRests=restsBesideFood(result.rows||[],new Map(activities().map(activity=>[activity.id,activity])));
    $('timeline').innerHTML=(result.rows||[]).map((row,index)=>{
      const kind=row.kind||row.type||'activity',a=byId(row.activityId),duration=Number(row.end)-Number(row.start);
      const name=row.name || ({walk:'徒歩で移動',wait:'時間を調整',queue:'待ち列',rest:'ひと休み',exit:'退園へ'}[kind]) || a?.name || '予定';
      const details=[];if(row.fixedBreakId)details.push(foodAdjacentRests.has(row)?'フードの前後に指定した休憩':'指定した休憩');if(row.metres)details.push(`${Math.round(row.metres)} m`);if(duration>=0)details.push(`${duration}分`);if(Number(row.cost)>0)details.push(money(row.cost));if(a?.area)details.push(a.area);
      if (kind === 'queue' && (row.bufferMinutes || row.delayMinutes)) details.push(`見込み${row.estimatedMinutes}分＋余裕${row.bufferMinutes || 0}分${row.delayMinutes ? `＋混雑想定${row.delayMinutes}分` : ''}`);
      const admission=row.dpa&&(kind==='queue'?row.start:result.visits?.find(visit=>visit.id===row.activityId)?.queueStart??row.start);
      const purchase=row.dpa&&result.purchases?.find(p=>baseVisitId(p.id)===baseVisitId(row.activityId)&&p.start<=admission&&admission<p.end);
      const dpaLabel=purchase?.owned===true?'DPA 取得済み':purchase?.owned===false?'DPA 購入候補':'DPA';
      const forecast=['activity','rest'].includes(kind)?weatherForMinute(planSettings,Number(row.start)):null;
      const notice=lastSkip?.index===index?`<div class="rest-edit-notice" role="status">${timeText(lastSkip.start)}の休憩を外しました。<button type="button" data-undo-rest>元に戻す</button><button type="button" data-replan-rest>空き時間を使って再探索</button></div>`:'';
      const id=escapeHtml(row.activityId);
      const recorded=state.settings.dayProgress?.visits[row.activityId]?.status;
      const recordLabel=({done:'体験済み',queue:'待ち列にいる',riding:'体験中',pending:'未体験',skipped:'見送り'})[recorded];
      if(recordLabel && (kind==='queue'||kind==='activity'))details.push(recordLabel);
      let visitActions='';
      if(a&&kind==='queue'&&recorded!=='done'){
        visitActions=`<div class="visit-actions"><button type="button" data-report-visit="${id}" data-report-status="queue">${recorded==='queue'?'残り時間を更新':'今並んでいる'}</button></div>`;
      }else if(a&&kind==='activity'){
        const done=recorded==='done'?'':`<button type="button" data-report-visit="${id}" data-report-status="done">体験済みにする</button>`;
        const again=a.category==='attraction'&&!isRepeatVisit(row.activityId)&&selected(a.id)?.repeatCount!==2 ?
          `<button type="button" data-ride-again="${id}">もう一度乗りたい</button>`:'';
        visitActions=`<div class="visit-actions">${done}<button type="button" data-report-visit="${id}">状況を訂正</button>${again}</div>`;
      }
      return `${notice}<article class="timeline-row kind-${escapeHtml(kind)}"><div class="timeline-time">${timeText(row.start)}<small>– ${timeText(row.end)}</small></div><div class="timeline-body${forecast?' has-forecast':''}"><h4>${escapeHtml(name)}${row.dpa?`<span class="dpa-pill">${dpaLabel}</span>`:''}</h4><p>${escapeHtml(details.join(' · '))}</p>${forecast ? forecastCardHtml(forecast) : ''}${visitActions}${kind==='rest'&&canEditRest&&!row.preserved&&!(row.start<state.settings.replanFrom)&&(row.fixedBreakId||row.autoBreakId)?`<button class="remove-timeline-rest" data-remove-rest-index="${index}" type="button" aria-label="${timeText(row.start)}の休憩だけ外す">この休憩だけ外す</button>`:''}</div></article>`;
    }).join('');
    const omissions=result.omissions||[];$('omissionTitle').textContent=`入らなかった希望 · ${omissions.length}件`;
    const showOmissionActions=!state.resultDirty&&!result.diagnostics?.running&&!worker&&!preparation;
    $('omissionList').innerHTML=omissions.length?omissions.map(o=>{
      const name=o.name||byId(o.id)?.name||o.id,action=omissionAction(o);
      const button=showOmissionActions?`<button class="omission-action" type="button" data-plan-field="${escapeHtml(action.field)}" data-plan-wish="${escapeHtml(action.wishId||'')}" aria-label="${escapeHtml(name+'：'+action.label)}">${escapeHtml(action.label)}</button>`:'';
      return `<div class="omission-item"><div><strong>${escapeHtml(name)}${o.required?' · 必須':''}</strong><p>${escapeHtml(o.reason||'時間・予算・利用枠の条件に合わせて他の希望を優先しました。')}</p>${button}</div></div>`;
    }).join(''):'<p class="field-note">希望をすべて予定に取り入れられました。</p>';
    const d=result.diagnostics||{};
    $('delayPlanNotice').textContent=`待ち時間に含めた余裕は合計${t.bufferMinutes || 0}分${t.delayMinutes ? `、追加の混雑想定は合計${t.delayMinutes}分` : ''}です。`;
    $('searchContingency').disabled=state.resultDirty||result.status!=='feasible'||!!worker||!!preparation;
    const notes=Array.isArray(d.notes)?d.notes:[String(d.notes||'')];
    $('diagnosticList').innerHTML=`<p>${escapeHtml(SEARCH_LABELS[planSettings.searchMethod||'beam'])} · 探索時間 ${(Number(d.elapsedMs||0)/1000).toFixed(2)}秒 · 調べた状態 ${Number(d.expanded||0).toLocaleString('ja-JP')}件。${d.timedOut?'設定した探索時間で打ち切りました。':'設定した範囲の探索を終えました。'}厳密な最適性の証明は行っていません。</p><p>待ち時間：${escapeHtml((d.waitSources?.length?d.waitSources:[d.waitSource||'trend']).map(key=>WAIT_LABELS[key]||key).join('・'))}。移動 ${t.walkMinutes||0}分 · 待ち時間 ${t.waitMinutes||0}分 · 休憩 ${t.restMinutes||0}分。</p><ul>${notes.filter(Boolean).map(n=>`<li>${escapeHtml(typeof n==='object'?JSON.stringify(n):n)}</li>`).join('')}</ul><p>DPAの候補は購入できる枠を入力したものです。購入前に公式アプリの販売状況を確認し、取得後は希望を「取得済み」に更新してください。</p>`;
    for(const id of ['exportIcs','exportHtml','printPlan'])$(id).disabled=result.status!=='feasible';
  }
  function skipTimelineRest(index) {
    if(state.resultDirty||worker||preparation)return;
    const change=skipScheduledRest(state.settings,state.result,index);
    if(!change)return;
    restUndo.set(change.result,{index,start:state.result.rows[index].start,previous:state.result,
      fixedBreaks:state.settings.fixedBreaks,excludedAutoBreaks:state.settings.excludedAutoBreaks,skipAutoRestAfter:state.settings.skipAutoRestAfter});
    Object.assign(state,change);
    closeSharePanel();renderResult();saveSharedUpdate();
    $('timeline').querySelector('[data-undo-rest]')?.focus({preventScroll:true});
  }
  function undoTimelineRest() {
    const undo=restUndo.get(state.result);
    if(!undo||state.resultDirty||worker||preparation)return;
    state.result=undo.previous;
    for(const key of ['fixedBreaks','excludedAutoBreaks','skipAutoRestAfter']){
      if(undo[key]===undefined)delete state.settings[key];else state.settings[key]=undo[key];
    }
    closeSharePanel();renderResult();saveSharedUpdate();
    $('timeline').querySelector(`[data-remove-rest-index="${undo.index}"]`)?.focus({preventScroll:true});
  }
  function renderFixedBreaks() {
    if(!catalogue)return;
    const breaks=(state.settings.fixedBreaks||[]).slice().sort((a,b)=>a.start-b.start);
    $('fixedBreakList').innerHTML=breaks.length?breaks.map(b=>`<div class="fixed-break-item"><div><strong>${timeText(b.start)}–${timeText(b.start+b.duration)} · ${escapeHtml(b.label||'ひと休み')}</strong><span>${escapeHtml(currentPark().nodes.find(n=>n.id===b.node)?.name||b.node)} · ${b.duration}分</span></div><button type="button"${b.start<state.settings.replanFrom||state.result?.rows?.some(row=>row.fixedBreakId===b.id&&row.preserved)?' disabled':''} data-remove-break="${escapeHtml(b.id)}" aria-label="${escapeHtml(b.label||'ひと休み')} ${timeText(b.start)}を外す">外す</button></div>`).join(''):'<p class="field-note">時刻を指定した休憩はまだありません。</p>';
    $('clearRestSkips').hidden=!state.settings.skipAutoRestAfter?.length&&!state.settings.excludedAutoBreaks?.length;
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
    markResultStale();renderFixedBreaks();setStatus('休憩を追加しました。「現在の条件で再探索」で移動と希望の順序を考え直します。');
  }
  function applyDataUpdate(patch) {
    stopSearch();const {history,...settings}=patch;
    const preparedWeather=Object.hasOwn(settings,'weatherForecast') ? settings : null;
    if(Array.isArray(history)){state.history=history;state.settings.history=history;}
    Object.assign(state.settings,settings);if(settings.waitModel?.parkId===state.parkId)modelCache.set(state.parkId,settings.waitModel);markResultStale();prepareVisitOutlook(preparedWeather);writeSettings();updateCrowd();renderCatalogue();renderMap();externalPanel?.refresh();syncTimeEditors();
  }
  function checkSelectionDetails() {
    const settled=settledReplanWishes(currentPark(),state.settings,state.result);
    const expanded=expandRepeatVisits(currentPark(),state.settings,state.result);
    const remaining=expanded.settings.selections.filter(wish=>!settled.has(wish.id));
    const hasUnsettledField=(id,field)=>remaining.some(wish=>{
      if(baseVisitId(wish.id)!==id)return false;
      return !['dpaStart','dpaEnd','dpaPurchasedAt','nodeOverride'].includes(field) ||
        wish.dpaMode==='owned' || (wish.dpaMode==='consider'&&state.settings.dpaPurchaseLimit!==0);
    });
    const invalid=[...$('wishlist').querySelectorAll('input:invalid, select:invalid, textarea:invalid')]
      .find(control=>hasUnsettledField(control.closest('[data-wish-id]')?.dataset.wishId,
        (control.closest('.clamped-time')?.previousElementSibling||control).dataset.field));
    if(invalid){
      const field=invalid.closest('.clamped-time')?.previousElementSibling||invalid;
      const id=invalid.closest('[data-wish-id]')?.dataset.wishId;
      const label=invalid.getAttribute('aria-label')||invalid.labels?.[0]?.firstChild?.textContent.trim()||'入力欄';
      const hint=invalid.validity.customError?invalid.validationMessage:invalid.type==='number'?
        `${invalid.min}〜${invalid.max}の${invalid.step==='1'?'整数':invalid.step+'単位'}で入力してください。`:'値を確認してください。';
      throw Object.assign(inputError(`${byId(id)?.name||'希望'}：${label}。 ${hint}`,field.dataset.field,id),{control:invalid});
    }
    if(!state.settings.selections.length&&!Object.keys(state.settings.dayProgress?.visits||{}).length)throw inputError('行きたい場所を一つ以上選んでください。','catalogueSearch');
    for(const wish of remaining){
      const id=baseVisitId(wish.id), activity=byId(id);
      const drafts=wishDrafts.get(selected(id));
      const draft=drafts&&[...drafts].find(([key])=>hasUnsettledField(id,key));
      if(draft)throw inputError(`${activity?.name||'希望'}：${draft[1].label}。 ${draft[1].message}`,draft[0],id);
      const problem=wishInputProblem(wish,activity,state.settings.date,state.settings.dpaPurchaseLimit);
      if(problem)throw problem;
    }
  }

  function checkVisitCommitments() {
    const {entry,exit,purchases=[],fixedBreaks=[]}=state.settings;
    for(const purchase of purchases){
      if(purchase.purchasedAt>=entry)continue;
      const name=byId(purchase.id)?.name||'購入済みDPA',time=timeText(purchase.purchasedAt);
      if(selected(purchase.id)?.dpaMode==='owned')throw inputError(`${name}の購入時刻（${time}）が入園予定より前です。購入時刻か入園予定を確認してください。`,'dpaPurchasedAt',purchase.id);
      throw inputError(`${name}の購入履歴（${time}）が入園予定より前です。入園予定か購入履歴を確認してください。`,'entryTime');
    }
    for(const rest of fixedBreaks){
      const label=rest.label||'指定した休憩',end=rest.start+rest.duration;
      if(rest.start<entry)throw inputError(`${label}の開始（${timeText(rest.start)}）が入園予定より前です。入園予定か休憩の時刻を見直してください。`,'entryTime');
      if(end>exit)throw inputError(`${label}の終了（${timeText(end)}）が退園予定を過ぎます。退園予定か休憩の時刻を見直してください。`,'exitTime');
    }
  }
  function clearPlanFeedback() {
    const invalid=document.querySelector('[data-plan-invalid]');
    if(invalid){
      invalid.removeAttribute('data-plan-invalid');invalid.removeAttribute('aria-invalid');
      const other=(invalid.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!=='planFieldError');
      if(other.length)invalid.setAttribute('aria-describedby',other.join(' '));else invalid.removeAttribute('aria-describedby');
    }
    $('planFieldError')?.remove();
    $('planFeedback').hidden=true;$('planFeedback').textContent='';
  }
  function revealPlanField({field,wishId,control}) {
    let target=control;
    if(wishId){
      wishId=baseVisitId(wishId);
      showWorkflow('wishlist');
      const cards=() => [...$('wishlist').querySelectorAll('[data-wish-id]')];
      let card=cards().find(item=>item.dataset.wishId===wishId);
      if(!card){
        wishlistGenre=genreOf(byId(wishId)?.category)||'all';renderWishlist();
        card=cards().find(item=>item.dataset.wishId===wishId);
      }
      if(field==='weight')target=card?.querySelector('[data-weight][aria-pressed="true"]')||card?.querySelector('[data-weight]');
      if(!target?.isConnected)target=[...(card?.querySelectorAll('[data-field]')||[])].find(item=>item.dataset.field===field)
        ||card?.querySelector('[data-field="required"]');
    }else if(field){
      target=field==='refreshLiveWaits'?$('externalDataPanel').querySelector('[data-external="refresh"]'):$(field);
      if($('workflowWishlist').contains(target))showWorkflow('wishlist');
      if($('workflowSchedule').contains(target))showWorkflow('schedule');
    }
    if(!target)return null;
    for(let node=target;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;
    if(target.type==='hidden')target=target.nextElementSibling?.querySelector('[data-time-part],input,select,button');
    if(target?.tagName==='DETAILS')target=target.querySelector('summary');
    return target;
  }
  function showPlanError(error) {
    clearPlanFeedback();setStatus('');
    const message=error.message||'計画を作成できませんでした。もう一度お試しください。';
    const target=revealPlanField(error);
    if(target){
      const note=document.createElement('p');
      note.id='planFieldError';note.className='plan-field-error';note.setAttribute('role','alert');note.textContent=message;
      const anchor=target.closest('.time-field,label')||target;
      // The search label has a single fixed-height row. Put its note below the filters.
      (target.closest('.catalogue-controls')||anchor).after(note);
      target.dataset.planInvalid='';target.setAttribute('aria-invalid','true');
      target.setAttribute('aria-describedby',[target.getAttribute('aria-describedby'),'planFieldError'].filter(Boolean).join(' '));
      target.focus({preventScroll:true});target.scrollIntoView({block:'center'});
    }else{
      const notice=$('planFeedback');
      notice.textContent=message;notice.hidden=false;notice.focus({preventScroll:true});notice.scrollIntoView({block:'center'});
    }
  }
  function clearContingency() {
    contingencyRequest++;
    contingencyWorker?.terminate();contingencyWorker=null;
    contingencyResult=null;contingencyBase=null;
    $('contingencyStatus').textContent='';$('contingencyComparison').innerHTML='';
    $('adoptContingency').hidden=true;$('cancelContingency').hidden=true;
    $('searchContingency').disabled=!!state.resultDirty||state.result?.status!=='feasible';
  }
  function startContingency() {
    if (worker||preparation||state.resultDirty||state.result?.status!=='feasible') throw Error('現在の条件で計画を作成してから代替案を比べてください。');
    clearContingency();
    const extra=Number($('contingencyDelay').value),profile=contingencySettings(state.result.settings||state.settings,extra);
    contingencyBase=state.result;const request=++contingencyRequest;
    const initialPlan=profile.replanFrom!=null?state.result:null;
    contingencyWorker=new Worker(new URL('./planner-worker.js?v=2.6.0',import.meta.url),{type:'module'});
    $('searchContingency').disabled=true;$('cancelContingency').hidden=false;
    $('contingencyStatus').textContent=`通常の待ち列がさらに${extra}分長い場合を探索しています。`;
    contingencyWorker.onmessage=event=>{
      if(request!==contingencyRequest||contingencyBase!==state.result)return;
      const message=event.data;
      if(message.type==='error'){clearContingency();$('contingencyStatus').textContent=message.message||'代替案を計算できませんでした。';return;}
      if(message.type!=='result')return;
      contingencyResult=message.result;contingencyWorker.terminate();contingencyWorker=null;
      $('searchContingency').disabled=false;$('cancelContingency').hidden=true;
      const comparison=compareContingency(contingencyBase,contingencyResult);
      if(!comparison.feasible){$('contingencyStatus').textContent='必須の希望・取得済み枠・固定休憩をすべて守る代替案は見つかりませんでした。追加の混雑想定を減らすか希望条件を見直してください。';return;}
      $('contingencyStatus').textContent=`待ち列ごとにさらに${extra}分の混雑を想定した代替案です。採用するまで現在のしおりは変わりません。`;
      const summary=plan=>`<td>${plan.coverage?.count??plan.visits.length}件</td><td>${plan.coverage?.percent??0}%</td><td>${money(plan.totals.cost)}</td><td>${timeText(plan.totals.finish)}</td>`;
      $('contingencyComparison').innerHTML=`<div class="table-wrap"><table><thead><tr><th>計画</th><th>希望</th><th>重要度の達成率</th><th>費用</th><th>退園</th></tr></thead><tbody><tr><th>現在の案</th>${summary(contingencyBase)}</tr><tr><th>混雑を見込む案</th>${summary(contingencyResult)}</tr></tbody></table></div><p>外れた希望：${escapeHtml(comparison.removed.join('、')||'なし')}<br>新たに入る希望：${escapeHtml(comparison.added.join('、')||'なし')}</p><p class="field-note">必須の希望・取得済みDPA・固定休憩・予算・退園時刻を守って確認した案です。公演とDPAの集合時刻は動かしません。当日の組み替えでは開始済み・完了済みの予定も保持します。</p>`;
      $('adoptContingency').hidden=false;
    };
    contingencyWorker.onerror=()=>{if(request!==contingencyRequest)return;clearContingency();$('contingencyStatus').textContent='代替案の探索でエラーが発生しました。もう一度お試しください。';};
    contingencyWorker.postMessage({type:'solve',requestId:request,park:currentPark(),settings:profile,history:state.history,initialPlan});
  }
  function adoptContingency() {
    if (!contingencyResult||contingencyResult.status!=='feasible'||contingencyBase!==state.result||state.resultDirty) throw Error('代替案を探索し直してください。');
    const chosen=contingencyResult;
    state.settings={...state.settings,...chosen.settings,history:state.history};state.result=chosen;state.resultDirty=false;
    clearContingency();writeSettings();renderResult();renderMap();saveSharedUpdate();
    setStatus('混雑を見込む代替案を採用しました。必要に応じて名前を付けて保存できます。');
  }
  async function startSearch() {
    if(preparation||worker)return;
    try{await runSearch();}
    catch{stopSearch();showPlanError(new Error('探索を開始できませんでした。ページを再読み込みしてもう一度お試しください。'));}
  }
  async function runSearch() {
    // Commit a clock or number that still has focus before reading its value.
    if(document.activeElement?.matches('input,select,textarea'))document.activeElement.blur();
    clearPlanFeedback();
    try{readSettings();checkSelectionDetails();checkVisitCommitments();}
    catch(error){showPlanError(error);return;}
    closeSharePanel();externalPanel?.cancel();stopSearch();latestPreview=null;requestId++;
    const preparingRequest=requestId,park=currentPark();
    preparation=new AbortController();showWorkflow('schedule',{focus:true,scroll:true});$('scheduleEmptyText').textContent='天気と当日の情報を確認して、希望をつなぐ順序を探しています。';
    setSolveDisabled(true);$('cancelSearch').hidden=false;$('searchProgress').hidden=false;$('progressBar').value=0;
    $('progressText').textContent='訪問日の条件を確認しています…';
    setStatus('計画を準備中…');
    let prepared;
    try{
      const outlook=prepareVisitOutlook();
      updateDayOverview();
      await outlook.promise;
      if(preparingRequest!==requestId)return;
      prepared=await prepareLiveForReplan(state.settings,park,{signal:preparation.signal});
    }
    catch(error){if(preparingRequest!==requestId)return;stopSearch();showPlanError(new Error('計画の準備を完了できませんでした。天気・待ち時間の取得設定を確認してもう一度お試しください。'));return;}
    if(preparingRequest!==requestId)return;
    preparation=null;state.settings=prepared;if(state.result){state.resultDirty=true;renderResult();}writeSettings();externalPanel?.refresh();
    searchStarted=performance.now();
    try{worker=new Worker(new URL('./planner-worker.js?v=2.6.0',import.meta.url),{type:'module'});}catch{stopSearch();showPlanError(new Error('探索を起動できませんでした。ページを再読み込みしてもう一度お試しください。'));return;}
    setSolveDisabled(true);$('cancelSearch').hidden=false;$('searchProgress').hidden=false;$('progressBar').value=0;$('progressText').textContent='最初の計画を探しています…';
    const thisRequest=requestId;
    worker.onmessage=event=>{
      const message=event.data;if(thisRequest!==requestId||(message.requestId!=null&&message.requestId!==thisRequest))return;
      if(message.type==='progress'){
        const p=message.progress||{};if(message.result)latestPreview=message.result;
        $('progressText').textContent=`組合せを探索中 · 重要度 ${p.bestScore??'—'} · ${p.visits??0}件の希望`;
      }else if(message.type==='result'){
        state.result=message.result;state.resultDirty=false;latestPreview=state.result;stopSearch();renderResult();renderMap();setStatus('');saveSharedUpdate();
        if(state.result.status==='no-plan'){
          const heading=$('resultExplanation');heading.tabIndex=-1;heading.focus({preventScroll:true});heading.scrollIntoView({block:'center'});
        }
      }else if(message.type==='error'){stopSearch();showPlanError(new Error(message.message||message.error||'計画を計算できませんでした。もう一度お試しください。'));}
    };
    worker.onmessageerror=worker.onerror=()=>{if(thisRequest!==requestId)return;stopSearch();showPlanError(new Error('探索が中断しました。ページを再読み込みしてもう一度お試しください。'));};
    progressTimer=setInterval(()=>{$('progressBar').value=Math.min(98,(performance.now()-searchStarted)/(state.settings.searchSeconds*1000)*100);},120);
    worker.postMessage({type:'solve',requestId:thisRequest,park:currentPark(),settings:state.settings,history:state.history,initialPlan:state.settings.replanFrom!=null?state.result:null});
    setStatus('計画を探索中…');
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
    $('catalogueSearch').value='';wishlistGenre='all';writeSettings();updateContext();showWorkflow(state.result?'schedule':'wishlist');setStatus('');
  }
  function downloadCatalogue(){const blob=new Blob([JSON.stringify(catalogue,null,2)],{type:'application/json;charset=utf-8'}),a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`ParkItinerary_catalogue_${catalogue.updatedAt||'custom'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function applyVisitProgress(patch,id,status) {
    readSettings();
    const activity=byId(id);
    let wish=selected(activity.id);
    if(status!=='clear' && (isRepeatVisit(id)||status==='pending') && !wish){
      wish=newWish(activity);
      state.settings.selections.push(wish);
    }
    if(wish&&isRepeatVisit(id)&&status!=='clear')wish.repeatCount=2;
    Object.assign(state.settings,patch);
    markResultStale();writeSettings();updateContext();saveSharedUpdate();
  }
  function closeSharePanel() {
    if ($('sharePanel').hidden) return;
    $('sharePanel').hidden=true;
    $('shareUrl').value='';
    $('sharePlan').setAttribute('aria-expanded','false');
  }
  function currentShareUrl() {
    try {
      readSettings();
      for (const wish of state.settings.selections) {
        const draft=wishDrafts.get(wish)?.values().next().value;
        if (draft) throw Error(`${byId(wish.id)?.name || '希望'}：${draft.label}。 ${draft.message}`);
      }
      return createShareUrl(state,location.href);
    } catch (error) {
      closeSharePanel();
      throw error;
    }
  }
  function attachEvents() {
    window.addEventListener('hashchange', safely(() => {
      const shared = readSharedState(location.hash);
      if (!shared) return;
      personalMode();
      const imported = cleanState(shared);
      stopSearch();
      openedPlanId = null;
      state = imported;
      wishlistGenre = 'all';
      $('catalogueSearch').value = $('planName').value = '';
      closeSharePanel();
      writeSettings();
      updateContext();
      renderSavedPlans();
      showWorkflow('wishlist');
      setStatus('共有された希望を読み込みました。');
    }));
    const calendarOptions=()=>({
      pendingModel:Boolean(displayedOutlook && !displayedOutlook.values && state.settings.waitModel?.parkId!==state.parkId)
    });
    forecastCalendar=createForecastCalendar({
      getCoverage:date=>calendarDayOutlook(currentPark(),state.settings,date,calendarOptions()),
      getPreview:date=>calendarDayPreview(currentPark(),state.settings,date,calendarOptions()),
      getChangeNotice:date=>visitDateChangeNotice(state,date),
      onOpen:()=>warmCalendarWeather().then(()=>forecastCalendar.refresh())
    });
    $('jumpToWishes').addEventListener('click',()=>{
      showWorkflow('wishlist');
      const heading=$('selectionTitle');
      heading.focus({preventScroll:true});
      heading.scrollIntoView({block:'start'});
    });
    progressEditor=attachDayProgress({
      root:document, context:()=>({park:currentPark(),settings:state.settings,session:state}),
      apply:applyVisitProgress, syncClocks:syncTimeEditors,
      replan(at) {
        $('replanEnabled').checked=true;$('replanTime').value=timeText(at);syncTimeEditors();
        return startSearch();
      }
    });
    onsiteCard=attachOnsiteNavigation({
      root:document, editor:progressEditor, busy:()=>!!worker||!!preparation,
      context:()=>({park:currentPark(),settings:state.settings,result:state.result,dirty:state.resultDirty,visible:workflowView==='schedule'}),
      replan(at) {
        if(state.settings.replanFrom!==at)$('currentNode').value='';
        $('replanEnabled').checked=true;$('replanTime').value=timeText(at);syncTimeEditors();
        return startSearch();
      }
    });
    $('openDayProgress').addEventListener('click',()=>{
      showWorkflow('schedule');progressEditor.open();
    });
    $('workflowTabs').addEventListener('click',event=>{const tab=event.target.closest('[data-workflow-tab]');if(tab)showWorkflow(tab.dataset.workflowTab);});
    $('workflowTabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();showWorkflow(event.key==='Home'?'wishlist':event.key==='End'?'schedule':workflowView==='wishlist'?'schedule':'wishlist',{focus:true});});
    $('backToWishlist').addEventListener('click',()=>showWorkflow('wishlist',{focus:true}));
    $('saveNewPlan').addEventListener('click',safely(()=>saveCurrentPlan(false)));$('overwritePlan').addEventListener('click',safely(()=>saveCurrentPlan(true)));
    $('savedPlanList').addEventListener('click',safely(event=>{
      const load=event.target.closest('[data-load-saved]'),rename=event.target.closest('[data-rename-saved]'),commit=event.target.closest('[data-commit-rename]'),remove=event.target.closest('[data-delete-saved]');
      if(load){personalMode();const id=load.dataset.loadSaved,saved=plans.load(id);if(!saved)throw Error('この計画は見つかりませんでした。');stopSearch();state=cleanState(saved);openedPlanId=id;const summary=plans.list().find(item=>item.id===id);$('planName').value=summary?.name||'';writeSettings();updateContext();renderSavedPlans();showWorkflow(state.result?'schedule':'wishlist');setStatus(`「${summary?.name||'計画'}」を開きました。`);}
      const exportButton=event.target.closest('[data-export-saved]');
      if (exportButton) {
        const saved=plans.load(exportButton.dataset.exportSaved,{forEdit:false});
        if (!saved) throw Error('この計画は見つかりませんでした。');
        downloadPlanJson(saved);
        return;
      }
      if(rename){const panel=rename.closest('.saved-plan-card').querySelector('.saved-plan-rename');panel.hidden=!panel.hidden;if(!panel.hidden)panel.querySelector('input').focus();}
      if(commit){const card=commit.closest('.saved-plan-card'),summary=plans.rename(commit.dataset.commitRename,card.querySelector('input[data-saved-name]').value);if(openedPlanId===summary.id)$('planName').value=summary.name;renderSavedPlans();$('savedPlanStatus').textContent='計画の名前を変更しました。';syncAfterEdit();}
      if(remove){const id=remove.dataset.deleteSaved;plans.remove(id);if(openedPlanId===id)openedPlanId=null;renderSavedPlans();$('savedPlanStatus').textContent='保存した計画を削除しました。';syncAfterEdit();}
    }));

    $('landTab').addEventListener('click',safely(()=>switchPark('land')));$('seaTab').addEventListener('click',safely(()=>switchPark('sea')));
    for(const id of ['landTab','seaTab'])$(id).addEventListener('keydown',safely(event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();
      const otherPark=state.parkId==='land'?'sea':'land';
      const next={Home:'land',End:'sea'}[event.key] || otherPark;
      switchPark(next);
      $(next+'Tab').focus();
    }));
    $('wishlistTabs').addEventListener('click',event=>{const tab=event.target.closest('[data-wish-genre]');if(!tab)return;wishlistGenre=tab.dataset.wishGenre;renderWishlist();$(`wishTab-${wishlistGenre}`).focus();});
    $('wishlistTabs').addEventListener('keydown',event=>{const tab=event.target.closest('[data-wish-genre]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=GENRES.findIndex(g=>g.id===tab.dataset.wishGenre),next=event.key==='Home'?0:event.key==='End'?GENRES.length-1:(index+(event.key==='ArrowRight'?1:-1)+GENRES.length)%GENRES.length;wishlistGenre=GENRES[next].id;renderWishlist();$(`wishTab-${wishlistGenre}`).focus();});
    $('breakEditor').addEventListener('toggle',()=>{if($('breakEditor').open&&state.result!==lastBreakSuggestionResult){suggestBreakLocation();lastBreakSuggestionResult=state.result;}});
    $('timeline').addEventListener('click',safely(event=>{
      const button=event.target.closest('button');
      if(!button)return;
      if(button.hasAttribute('data-report-visit')){progressEditor.open(button.dataset.reportVisit,button.dataset.reportStatus);return;}
      if(button.hasAttribute('data-ride-again')){
        const a=byId(button.dataset.rideAgain);
        let wish=selected(a.id);
        if(!wish){wish=newWish(a);state.settings.selections.push(wish);}
        wish.repeatCount=2;markResultStale();renderWishlist();renderCatalogue();renderMap();
        progressEditor.open(a.id,'done');
        setStatus('2回目を希望に追加しました。1回目の状況を確認して残りを組み替えられます。');return;
      }
      if(button.hasAttribute('data-remove-rest-index'))skipTimelineRest(Number(button.dataset.removeRestIndex));
      if(button.hasAttribute('data-undo-rest'))undoTimelineRest();
      if(button.hasAttribute('data-replan-rest'))return startSearch();
    }));
    $('clearRestSkips').addEventListener('click',()=>{
      state.settings.skipAutoRestAfter=[];state.settings.excludedAutoBreaks=[];
      markResultStale();renderFixedBreaks();setStatus('次の探索から休憩の候補に戻します。');
    });
    $('breakStart').addEventListener('change',()=>suggestBreakLocation());
    $('addBreak').addEventListener('click',safely(addFixedBreak));
    $('reoptimiseBreaks').addEventListener('click',safely(startSearch));
    $('fixedBreakList').addEventListener('click',event=>{
      const button=event.target.closest('[data-remove-break]');
      if(!button||button.disabled)return;
      const id=button.dataset.removeBreak,index=state.result?.rows?.findIndex(row=>row.fixedBreakId===id)??-1;
      if(index>=0&&!state.resultDirty&&state.result.status==='feasible'){skipTimelineRest(index);return;}
      state.settings.fixedBreaks=(state.settings.fixedBreaks||[]).filter(b=>b.id!==id);
      markResultStale();renderFixedBreaks();setStatus('指定した休憩を外しました。');
    });
    $('catalogueSearch').addEventListener('input',renderCatalogue);$('categoryFilter').addEventListener('change',renderCatalogue);
    $('catalogue').addEventListener('click',safely(event=>{const button=event.target.closest('[data-add]');if(button)addSelection(button.dataset.add);}));
    $('wishlist').addEventListener('click',safely(event=>{
      const remove=event.target.closest('[data-remove]'),weight=event.target.closest('[data-weight]');
      if(event.target.closest('[data-confirm-dpa-example]')){
        const card=event.target.closest('[data-wish-id]'),wish=selected(card.dataset.wishId);
        const example=dpaExampleWindow(wish,parkTimeBounds(currentPark(),state.settings.date));
        if(example){
          const input=card.querySelector(`[data-field="${example.field}"]`);
          input.value=timeText(example.field==='dpaEnd'?example.end:example.start);
          input.dispatchEvent(new Event('change',{bubbles:true}));
          input.nextElementSibling?.querySelector('input')?.focus();
        }
        return;
      }
      const historyLink=event.target.closest('[data-open-purchase]');
      if(historyLink){
        const history=$('purchaseHistory'),record=$(`purchase-record-${historyLink.dataset.openPurchase}`);
        if(record){$('replanSettings').open=true;history.closest('details').open=true;record.focus();}
      }
      if(remove){state.settings.selections=state.settings.selections.filter(s=>s.id!==remove.dataset.remove);markResultStale();renderWishlist();renderCatalogue();renderMap();}
      if(weight&&!weight.disabled){selected(weight.dataset.for).weight=Number(weight.dataset.weight);markResultStale();renderWishlist();}
    }));
    bindWishEditors($('wishlist'),event=>{
      const input=event.target,field=input.dataset.field,wish=selected(input.closest('[data-wish-id]')?.dataset.wishId);
      const editor=input.dataset.clampedTime?input.nextElementSibling?.querySelector('[data-time-part],input,select'):input;
      editor?.setCustomValidity?.('');wishDrafts.get(wish)?.delete(field);
      try{updateSelection(event);}
      catch(error){
        if(field&&wish){
          if(!wishDrafts.has(wish))wishDrafts.set(wish,new Map());
          const label=editor?.getAttribute('aria-label')||input.closest('label,.time-field')?.firstChild?.textContent.trim()||'入力欄';
          wishDrafts.get(wish).set(field,{value:input.value,label,message:error.message});
        }
        editor?.setCustomValidity?.(error.message);
        if(event.type!=='input'){markResultStale();setStatus(error.message,true);}
      }
    },markResultStale);
    $('purchaseActivity').addEventListener('change',refreshPurchaseEditor);
    $('addPurchase').addEventListener('click',safely(()=>{
      const activity=byId($('purchaseActivity').value);
      if(!activity?.dpa)throw Error('購入したDPAを選んでください。');
      const purchasedAt=timeInput('purchaseTime'),start=timeInput('purchaseStart'),end=timeInput('purchaseEnd');
      const cost=numberInput('purchaseCost',0,1000000,100);
      if(start>=end)throw Error('利用・入場終了は開始より後にしてください。');
      if(purchasedAt>start)throw Error('購入時刻は利用開始までの時刻を入力してください。');
      const record={id:activity.id,kind:activity.dpa.kind||'attraction',purchasedAt,start,end,cost};
      const existing=state.settings.purchases.find(p=>p.id===activity.id);
      if(existing)Object.assign(existing,record);else state.settings.purchases.push(record);
      const wish=selected(activity.id);
      if(wish?.dpaMode==='owned')Object.assign(wish,{dpaStart:start,dpaEnd:end,dpaPurchasedAt:purchasedAt});
      refreshPurchaseEditor();renderPurchaseHistory();renderWishlist();markResultStale();
      setStatus(existing?'購入履歴を更新しました。':'購入履歴に追加しました。次の探索で購入間隔と支出へ反映します。');
    }));
    $('purchaseHistory').addEventListener('click',event=>{const button=event.target.closest('[data-remove-purchase]');if(!button)return;const removed=state.settings.purchases.splice(Number(button.dataset.removePurchase),1)[0];const selection=selected(removed?.id);if(selection?.dpaMode==='owned')changeDpaMode(selection,'none');refreshPurchaseEditor();renderWishlist();renderPurchaseHistory();markResultStale();setStatus('購入履歴を外しました。この施設の取得済みDPA指定も通常利用へ戻しています。');});
    $('wishPresetChoices').addEventListener('click',safely(event=>{
      const button=event.target.closest('[data-wish-preset]');
      if(button)return addWishPreset(button.dataset.wishPreset);
    }));
    $('clearSelection').addEventListener('click',()=>{state.settings.selections=[];markResultStale();renderWishlist();renderCatalogue();renderMap();});
    for(const id of ['visitDate','crowdMode','crowdLevel','weather','weatherMode']){
      $(id).addEventListener('change',safely(()=>{
        if(id==='weatherMode')syncManualWeather();
        const previousDate=state.settings.date;
        readSettings();
        if(id==='visitDate'&&state.settings.date!==previousDate){
          stopSearch();openedPlanId=null;$('overwritePlan').hidden=true;
          resetForNewVisitDay(state,currentPark(),wishDrafts);
          writeSettings();
          const names=state.settings.selections.filter(item=>item.dpaMode==='consider').map(item=>byId(item.id).name);
          const dpa=names.length&&state.settings.dpaPurchaseLimit!==0?` DPA購入候補「${names.join('」「')}」は新しい日付の利用枠を入力してください。`:'';
          setStatus('訪問日を変更しました。公演と営業時間は新しい日付の情報を使います。'+dpa);
        }
        updateContext();
      }));
    }
    document.querySelector('.settings-panel').addEventListener('input',()=>markResultStale());
    document.querySelector('.settings-panel').addEventListener('change',safely(event=>{
      readSettings();
      if(['entryTime','exitTime'].includes(event.target.id)){prepareVisitOutlook();updateDayOverview();}
      if(['walkSpeed','restEvery','restMinutes'].includes(event.target.id))updateVisitPreferences();
      if(['dpaPurchaseLimit','entryTime','exitTime'].includes(event.target.id))renderWishlist();
      markResultStale();
    }));
    for(const button of document.querySelectorAll('[data-start-plan]')){
      // Submit on click before an editor blur can move the button under the pointer.
      button.addEventListener('pointerdown',event=>{if(document.activeElement?.matches('input,select,textarea'))event.preventDefault();});
      button.addEventListener('click',startSearch);
    }
    $('results').addEventListener('click',event=>{
      const button=event.target.closest('[data-plan-field]');if(!button)return;
      const target=revealPlanField({field:button.dataset.planField,wishId:button.dataset.planWish});
      target?.focus({preventScroll:true});target?.scrollIntoView({block:'center'});
    });
    $('cancelSearch').addEventListener('click',()=>{stopSearch(true);setStatus(latestPreview?'探索を止めて、そこまでで見つかった計画を表示しました。':'探索を止めました。前に作った計画がある場合はそのまま残っています。');});
    $('searchContingency').addEventListener('click',safely(startContingency));
    $('adoptContingency').addEventListener('click',safely(adoptContingency));
    $('cancelContingency').addEventListener('click',()=>{clearContingency();$('contingencyStatus').textContent='代替案の探索を止めました。現在のしおりを引き続き使えます。';});
    const albumDialog = $('albumDialog'), albumPanel = $('driveMemories');
    for (const opener of document.querySelectorAll('[data-open-album]')) {
      opener.addEventListener('click', () => {
        if (albumPanel.hidden || albumDialog.open) return;
        albumDialog.showModal();
        albumPanel.open = true;
      });
    }
    albumDialog.addEventListener('close', () => { albumPanel.open = false; });
    $('savePlan').addEventListener('click',safely(()=>{readSettings();showSavedPlans(true);}));
    $('loadPlan').addEventListener('click',safely(()=>showSavedPlans(false)));
    $('sharePlan').addEventListener('click',safely(()=>{
      if (!$('sharePanel').hidden) { closeSharePanel(); return; }
      $('shareUrl').value=currentShareUrl();
      $('sharePanel').hidden=false;
      $('sharePlan').setAttribute('aria-expanded','true');
      $('copyShare').focus({preventScroll:true});
    }));
    $('copyShare').addEventListener('click',safely(async()=>{
      const url=currentShareUrl();
      $('shareUrl').value=url;
      try {
        await navigator.clipboard.writeText(url);
        if (!$('sharePanel').hidden && $('shareUrl').value===url) setStatus('共有リンクをコピーしました。');
      } catch {
        if ($('sharePanel').hidden || $('shareUrl').value!==url) return;
        $('shareUrl').select();
        setStatus('リンク欄を選択しました。コピーして送ってください。');
      }
    }));
    $('importPlan').addEventListener('click',()=>$('planFile').click());$('planFile').addEventListener('change',safely(async()=>{personalMode();const file=$('planFile').files[0];if(!file)return;if(file.size>5000000)throw Error('計画ファイルは5MB以下で指定してください。');const value=parsePlanJson(await file.text());stopSearch();state=cleanState(value);openedPlanId=null;writeSettings();updateContext();showWorkflow(state.result?'schedule':'wishlist');setStatus('計画ファイルを読み込みました。');$('planFile').value='';}));
    $('importHistory').addEventListener('click',()=>$('historyFile').click());$('historyFile').addEventListener('change',safely(async()=>{const file=$('historyFile').files[0];if(!file)return;if(file.size>10000000)throw Error('待ち時間CSVは10MB以下で指定してください。');state.history=parseHistoryCsv(await file.text());state.settings.history=state.history;updateCrowd();externalPanel?.refresh();markResultStale();setStatus(`${state.history.length}件の待ち時間を読み込みました。再探索すると計画へ反映します。`);$('historyFile').value='';}));
    $('exportCatalogue').addEventListener('click',safely(downloadCatalogue));$('importCatalogue').addEventListener('click',()=>$('catalogueFile').click());$('catalogueFile').addEventListener('change',safely(async()=>{const file=$('catalogueFile').files[0];if(!file)return;if(file.size>5000000)throw Error('施設JSONは5MB以下で指定してください。');const next=validateCatalogue(JSON.parse(await file.text()));stopSearch();catalogue=next;state.result=null;state.settings.selections=state.settings.selections.filter(s=>byId(s.id));updateContext();setStatus('施設情報を更新しました。時間・料金を確認して再探索してください。');$('catalogueFile').value='';}));
    $('refreshCatalogue').addEventListener('click',safely(async()=>{stopSearch();await loadCatalogue(true);stopSearch();state.result=null;updateContext();setStatus('配布中の施設情報を読み直しました。');}));
    itineraryImage=attachItineraryImage(document,()=>({plan:state.result,park:currentPark(),settings:state.result?.settings||state.settings}),safely,()=>showWorkflow('schedule'));
    $('exportJson').addEventListener('click',safely(()=>{readSettings();downloadPlanJson(state);}));$('exportIcs').addEventListener('click',safely(()=>downloadCalendar(state.result,currentPark(),state.result.settings||state.settings)));$('exportHtml').addEventListener('click',safely(()=>downloadOfflineHtml(state.result,currentPark(),state.result.settings||state.settings)));$('printPlan').addEventListener('click',()=>window.print());
  }
  async function start() {
    try{setSolveDisabled(true);setStatus('施設情報を確認中…');await loadCatalogue();calendarData=await fetchPublishedCalendar({timeoutMs:5000});const shared=readSharedState(location.hash);if(shared)state=cleanState(shared);if(calendarData)state.settings.calendarData=calendarData;writeSettings();attachEvents();showWorkflow(state.result?'schedule':'wishlist');renderSavedPlans();setSolveDisabled(false);externalPanel=initialiseExternalData({container:$('externalDataPanel'),getContext:()=>({park:currentPark(),settings:state.settings,history:state.history}),onUpdate:applyDataUpdate,beforeAction:readSettings});updateContext();setStatus(shared?'共有された希望を読み込みました。':'');}
    catch(error){setStatus(error.message||'起動に失敗しました。ページを再読み込みしてください。',true);setSolveDisabled(true);throw error;}
    finally { window.dispatchEvent(new Event('tdroute:ready')); }
  }
  const ready=start();
  return {ready,openJoint,leaveJoint,jointBusy:()=>!!(preparation || worker),
    captureJoint:()=>{if(!suspendedPrivate)throw Error('共同計画を開いてください。');readSettings();return state;},
    getOpenedPlanId:()=>openedPlanId,getState:()=>state,showWorkflow,renderSavedPlans,getCatalogue:()=>catalogue,getContext:()=>({park:currentPark(),settings:state.settings,history:state.history}),applyDataUpdate,readSettings,addSelection,renderResult,stopSearch};
}
