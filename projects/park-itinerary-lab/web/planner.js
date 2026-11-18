import {baseVisitId, canStartVisit, compactRepeatSelections, expandRepeatVisits, facilityForVisit} from './repeat-visits.js';
import {clockText, parkTimeBounds} from './time-input.js';
import {applyProgressToPrefix, progressEntries} from './day-progress-plan.js';
import {activityAvailable,operationPauseInfo,normalisePauseWindows,subtractPauseWindows} from './operation-windows.js?v=2.0.0';
import { weatherAtMinute, calendarContext, visitDayContext } from './calendar-features.js?v=2.0.0';
import { predictModelWait, estimateParkCrowd, calendarCrowdLevel } from './wait-model.js?v=2.0.0';
import { liveWaitFor, currentRideStatus } from './wait-data.js?v=2.0.0';
import {deriveIntradayAdjustment, applyIntradayAdjustment, describeIntradayAdjustment} from './intraday-waits.js?v=2.0.0';
/* Browser itinerary search. Every returned plan is checked; the search does not claim global optimality. */
const resolvedCrowd = Symbol('park crowd');
const visitContext = Symbol('dated park factors');
const intradayAdjustment = Symbol('same-day wait adjustment');
const FOOD = new Set(['restaurant', 'cafe', 'snack', 'popcorn']);
const FIXED = new Set(['show', 'parade']);
const DINING_RECOVERY_MINUTES = 20;
const DINING_BREAK_GAP = 30;
const LONG_ATTRACTION_QUEUE = 45;
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const ceil100 = value => Math.ceil(value / 100) * 100;
const copy = value => JSON.parse(JSON.stringify(value));

export function toMinutes(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(String(value));
  if (!match || Number(match[1]) > 23) throw new RangeError('時刻は00:00〜23:59で指定してください。');
  return Number(match[1]) * 60 + Number(match[2]);
}

function numberIn(value, name, min, max, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new RangeError(name + 'の値を確認してください。');
  }
  return parsed;
}

function dateValid(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}

/** All-pairs shortest walking paths on the supplied pedestrian graph. */
export function graphDistances(park) {
  if (!Array.isArray(park?.nodes) || !Array.isArray(park?.edges)) throw new TypeError('歩行経路データがありません。');
  const ids = park.nodes.map(node => node.id);
  if (new Set(ids).size !== ids.length || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 120) || park.edges.length > 5000) throw new RangeError('地図の地点IDを確認してください。');
  const distances = Object.create(null), paths = Object.create(null);
  const adjacency = new Map(ids.map(id => [id, new Map()]));
  for (const edge of park.edges) {
    const from = edge.from ?? edge.a, to = edge.to ?? edge.b, metres = Number(edge.metres);
    if (!adjacency.has(from) || !adjacency.has(to) || !Number.isFinite(metres) || metres < 0 || metres > 20000) throw new RangeError('歩行経路の距離を確認してください。');
    if (metres < (adjacency.get(from).get(to) ?? Infinity)) {
      adjacency.get(from).set(to, metres); adjacency.get(to).set(from, metres);
    }
  }
  // Sources and target paths are lazy: full route arrays would be too large on phones.
  const sources=new Map(),idSet=new Set(ids);
  function source(from) {
    if(sources.has(from))return sources.get(from);
    const distance = Object.fromEntries(ids.map(id => [id, Infinity])), prior = new Map(), heap = [];
    const push = item => { let i = heap.length; heap.push(item); while(i) { const parent=(i-1)>>1; if(heap[parent][0]<=item[0])break; heap[i]=heap[parent]; i=parent; } heap[i]=item; };
    const pop = () => { const first=heap[0], last=heap.pop(); if(heap.length) { let i=0; while(i*2+1<heap.length) { let child=i*2+1; if(child+1<heap.length&&heap[child+1][0]<heap[child][0])child++; if(last[0]<=heap[child][0])break; heap[i]=heap[child];i=child; } heap[i]=last; } return first; };
    distance[from]=0;push([0,from]);
    while(heap.length) {
      const [metres,node]=pop();if(metres>distance[node]+1e-8)continue;
      for(const [next,length] of adjacency.get(node)) { const candidate=metres+length; if(candidate+1e-8<distance[next]) { distance[next]=candidate;prior.set(next,node);push([candidate,next]); } }
    }
    const targetPaths=Object.create(null);
    const path=new Proxy(targetPaths,{get(target,to) {
      if(!idSet.has(to))return undefined;
      if(!(to in target)) { const result=[]; if(Number.isFinite(distance[to])) { let node=to; while(node!==undefined) { result.push(node);if(node===from)break;node=prior.get(node); } result.reverse(); } target[to]=result; }
      return target[to];
    }});
    const result={distance,path};sources.set(from,result);return result;
  }
  for(const from of ids) {
    Object.defineProperty(distances,from,{enumerable:true,get:()=>source(from).distance});
    Object.defineProperty(paths,from,{enumerable:true,get:()=>source(from).path});
  }
  return { distances, paths };
}

/** A labelled estimate of walking slowdown, separate from the measured route length. */
export function walkingFactor(start,settings={}) {
  if(settings.walkCrowdMode!=='estimate')return 1;
  const calendar=calendarContext(settings.date,settings.calendarData);
  const auto = settings.crowdLevel === 'auto';
  const assumption = auto ? settings[resolvedCrowd]?.level ?? calendarCrowdLevel(calendar) : settings.crowdLevel;
  const level={quiet:1,normal:1.08,busy:1.2}[assumption]??1.08;
  const peak=(start>=480&&start<630)||(start>=1200&&start<1320)?1.08:1;
  // The learned index already includes day, events and weather. A calendar fallback includes the day only.
  if (auto && settings[resolvedCrowd]?.source === 'model') return Math.round(level*peak*1000)/1000;
  const holiday=auto?1:calendar?.isHoliday?1.08:[0,6].includes(calendar?.weekday)?1.04:1;
  const weather=weatherAtMinute(settings.date,start,settings).weather==='rain'?1.08:1;
  const event=(settings.activeEvents||[]).length?1.04:1;
  return Math.round(Math.min(1.8,level*peak*holiday*weather*event)*1000)/1000;
}
export function walkingMinutes(metres,start,settings={}) {
  return Math.ceil(metres/Number(settings.speed??65)*walkingFactor(start,settings));
}
function walkingFields(start,settings,park) {
  return {...(park?.routeGraphVersion?{routeSource:park.routeGraphVersion}:{}),walkSpeed:Number(settings.speed??65),...(settings.walkCrowdMode==='estimate'?{walkingFactor:walkingFactor(start,settings),walkingSource:'congestion-estimate'}:{})};
}

function historicalWait(activity, start, settings, history) {
  const targetCalendar = calendarContext(settings.date, settings.calendarData);
  const targetWeather = weatherAtMinute(settings.date, start, settings).weather;
  const targetWeekday = targetCalendar.weekday;
  const targetWeekend = targetWeekday === 0 || targetWeekday === 6;
  const samples = [];
  for (const row of Array.isArray(history) ? history : []) {
    if ((row.activityId ?? row.activity_id ?? row.id) !== activity.id || !dateValid(row.date) || row.date > settings.date) continue;
    const wait = Number(row.wait ?? row.waitMinutes ?? row.wait_minutes);
    let time;
    try { time = toMinutes(row.time ?? row.minute); } catch { continue; }
    if (!Number.isFinite(wait) || wait < 0 || wait > 600 || Math.abs(time - start) > 120 || (row.date === settings.date && time > start)) continue;
    const weekday = new Date(row.date + 'T12:00:00Z').getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const bandwidth = 15; // A fixed clock kernel avoids creating a wait drop at a bandwidth boundary.
    let weight = Math.exp(-0.5 * ((time - start) / bandwidth) ** 2);
    if (weight < 0.001) continue;
    if (weekend === targetWeekend) weight *= 2;
    if (weekday === targetWeekday) weight *= 1.5;
    if (row.weather && row.weather === targetWeather) weight *= 1.5;
    const observedCalendar = calendarContext(row.date, settings.calendarData);
    if (targetCalendar.holidayKnown && observedCalendar.holidayKnown && targetCalendar.isHoliday === observedCalendar.isHoliday) weight *= 1.4;
    const monthDifference = Math.abs(targetCalendar.month - observedCalendar.month);
    weight /= 1 + Math.min(monthDifference, 12 - monthDifference) * 0.2;
    const eventIds = (settings.activeEvents || []).map(event => typeof event === 'string' ? event : event.id);
    if (row.event && String(row.event).split('|').some(value => eventIds.includes(value))) weight *= 1.5;
    samples.push({ wait, weight });
  }
  if (!samples.length) return null;
  return { minutes: Math.round(samples.reduce((sum, row) => sum + row.wait * row.weight, 0) /
    samples.reduce((sum, row) => sum + row.weight, 0)), source: 'history', samples: samples.length };
}

/** User observations take precedence over a labelled trend model. */
export function estimateWait(activity, start, settings, history = []) {
  const selection = (settings.selections || []).find(item => item.id === activity.id) || {};
  if (settings.crowdMode === 'manual') return {
    minutes: Math.round(numberIn(selection.manualWait ?? activity.baseWait ?? 0, '手動の待ち時間', 0, 600)),
    source: 'manual', samples: 0,
  };
  activity = facilityForVisit(activity);
  const live = liveWaitFor(activity, start, settings, { now: settings.waitAsOf ?? Date.now() });
  if (live?.isOpen) return live;
  const predictionActivity = activity.dailySchedules?.[settings.date]?.windows ? {...activity,windows:activity.dailySchedules[settings.date].windows} : activity;
  const prediction = predictModelWait(predictionActivity, start, settings, settings.waitModel, settings[visitContext]);
  if (prediction) return applyIntradayAdjustment(prediction, start, settings[intradayAdjustment], predictionActivity);
  const measured = historicalWait(activity, start, settings, history);
  if (measured) return measured;
  const calendar = calendarContext(settings.date, settings.calendarData);
  const weekday = calendar.weekday;
  const weekend = weekday === 0 || weekday === 6;
  const level = { quiet: 0.7, normal: 1, busy: 1.35 }[settings.crowdLevel] ?? 1;
  const weatherCondition = weatherAtMinute(settings.date, start, settings).weather;
  const weather = weatherCondition === 'rain' ? 0.84 : weatherCondition === 'cloud' ? 0.97 : 1;
  const hour = start / 60;
  const opening = Math.min(...(activity.dailySchedules?.[settings.date]?.windows || activity.windows || [[540,1260]]).map(window => window[0]));
  const sinceOpening = Math.max(0, start - opening);
  const openingFactor = 0.65 - 0.4 * Math.min(1, finite(activity.baseWait) / 60);
  const points = [[0,.82],[8,.82],[10,1],[12,1.2],[15,1.2],[18,1],[21,.75],[24,.75]];
  const right = points.findIndex(point => point[0] >= hour);
  const [x1,y1] = points[Math.max(0,right-1)], [x2,y2] = points[Math.max(0,right)];
  const regularFactor = x1 === x2 ? y2 : y1 + (y2-y1)*(hour-x1)/(x2-x1);
  const openingBlend = Math.min(1, sinceOpening / 120);
  const timeFactor = ['attraction', 'greeting'].includes(activity.category)
    ? openingFactor * (1-openingBlend) + regularFactor * openingBlend : regularFactor;
  const calendarFactor = calendar.isHoliday ? 1.25 : weekend ? 1.18 : calendar.beforeHoliday ? 1.08 : 1;
  const eventFactor = (settings.activeEvents || []).reduce((factor, event) => factor *
    Math.max(0.5, Math.min(1.8, finite(typeof event === 'object' ? event.multiplier : 1, 1))), 1);
  // For unmodelled rides, the park's learned index replaces the day multipliers.
  // Modelled rides, live observations and user history already returned above.
  const crowd = settings[resolvedCrowd];
  const dayFactor = crowd?.source === 'model' ? Math.max(0.7, Math.min(1.35, crowd.ratio))
    : level * calendarFactor * weather * Math.min(1.6, eventFactor);
  return { minutes: Math.max(0, Math.round(finite(activity.baseWait) * timeFactor * dayFactor)), source: 'trend', samples: 0 };
}

/** Prepare a fresh set of settings for the browser planner or the shared daily forecast. */
export function setWaitForecastContext(park, settings, recordReference) {
  settings.activeEvents = (park.events || []).filter(event => event.startDate <= settings.date && settings.date <= event.endDate);
  settings[visitContext] = settings.waitModel?.visitFactors?.length
    ? visitDayContext(settings.date,park,settings.calendarData || settings.waitModel.calendarData,settings.visitForecastAsOf ?? settings.waitAsOf ?? Date.now()) : null;
  settings[intradayAdjustment] = deriveIntradayAdjustment(park, settings, settings[visitContext]);
  if (settings.crowdLevel !== 'auto') return null;
  const crowd = estimateParkCrowd(park, settings, recordReference);
  settings[resolvedCrowd] = crowd;
  return crowd;
}

function normalise(park, settings) {
  if (!park || !Array.isArray(park.activities)) throw new TypeError('施設データを確認してください。');
  if (!dateValid(settings?.date)) throw new RangeError('訪問日を確認してください。');
  const entry = toMinutes(settings.entry), exit = toMinutes(settings.exit);
  if (entry < 0 || exit > 1439 || entry >= exit) throw new RangeError('退園時刻は入園時刻より後にしてください。');
  const result = { ...settings, entry, exit, waitAsOf: Date.now() };
  result.speed = numberIn(settings.speed ?? 65, '歩く速さ', 10, 150);
  result.budget = numberIn(settings.budget ?? 12000, '予算', 0, 10000000, true);
  result.spentBudget = numberIn(settings.spentBudget ?? 0, '支払済みの金額', 0, 10000000, true);
  for (const key of ['budget', 'spentBudget', 'foodBudget', 'dpaBudget', 'souvenirReserve']) {
    if (settings[key] !== undefined && settings[key] !== '' && settings[key] !== null) {
      result[key] = numberIn(settings[key], key, 0, 10000000, true);
      if (result[key] % 100) throw new RangeError('予算は100円単位で指定してください。');
    }
  }
  if (settings.avoidConsecutiveFood !== undefined && typeof settings.avoidConsecutiveFood !== 'boolean') {
    throw new RangeError('フードを連続して入れない設定を確認してください。');
  }
  if (settings.dpaPurchaseLimit !== undefined && (!Number.isInteger(settings.dpaPurchaseLimit) || settings.dpaPurchaseLimit < 0 || settings.dpaPurchaseLimit > 200)) {
    throw new RangeError('DPAの購入件数の上限は0〜200の整数で指定してください。');
  }
  if(settings.gondolaAvoidHarbourShows!==undefined&&typeof settings.gondolaAvoidHarbourShows!=='boolean')throw new RangeError('ゴンドラのショー回避設定を確認してください。');
  result.gondolaAvoidHarbourShows=settings.gondolaAvoidHarbourShows!==false;
  result.restEvery = numberIn(settings.restEvery ?? 0, '休憩の間隔', 0, 600, true);
  result.restMinutes = numberIn(settings.restMinutes ?? 10, '休憩の長さ', 0, 120, true);
  result.waitBufferMode = settings.waitBufferMode ?? 'fixed';
  if (!['fixed', 'auto'].includes(result.waitBufferMode)) throw new RangeError('待ち時間の余裕の設定を確認してください。');
  result.waitBufferMinutes = numberIn(settings.waitBufferMinutes ?? 0, '待ち時間の余裕', 0, 30, true);
  result.queueDelayMinutes = numberIn(settings.queueDelayMinutes ?? 0, '追加の混雑の想定', 0, 60, true);
  result.walkCrowdMode=settings.walkCrowdMode??'off';
  if(!['estimate','off'].includes(result.walkCrowdMode))throw new RangeError('移動時間の計算方法を確認してください。');
  if(!Array.isArray(settings.excludedAutoBreaks||[])||(settings.excludedAutoBreaks||[]).length>60||(settings.excludedAutoBreaks||[]).some(key=>typeof key!=='string'||!key||key.length>220))throw new RangeError('外す自動休憩を確認してください。');
  result.excludedAutoBreaks=[...new Set(settings.excludedAutoBreaks||[])];
  const skippedAfter=settings.skipAutoRestAfter??[];
  if(!Array.isArray(skippedAfter)||skippedAfter.length>400||skippedAfter.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}(?:~2)?$/.test(id)))throw new RangeError('見送った自動休憩の施設を確認してください。');
  result.skipAutoRestAfter=[...new Set(skippedAfter)];
  result.searchSeconds = numberIn(settings.searchSeconds ?? 10, '探索時間', 0.05, 120);
  result.searchMethod = settings.searchMethod ?? 'beam';
  if (!['beam', 'multistart', 'portfolio'].includes(result.searchMethod)) throw new RangeError('探索手法を確認してください。');
  if (!Array.isArray(settings.fixedBreaks || []) || (settings.fixedBreaks || []).length > 30) throw new RangeError('追加する休憩は30件以内にしてください。');
  const breakIds = new Set();
  result.fixedBreaks = (settings.fixedBreaks || []).map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || breakIds.has(item.id)) throw new RangeError('休憩のIDを確認してください。');
    breakIds.add(item.id);
    if (!park.nodes.some(node => node.id === item.node)) throw new RangeError('休憩する地点を確認してください。');
    const start = toMinutes(item.start), duration = numberIn(item.duration, '休憩の長さ', 1, 180, true);
    if (start < entry || start + duration > exit) throw new RangeError('追加する休憩は滞在時間内にしてください。');
    if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 100)) throw new RangeError('休憩の名前を確認してください。');
    return { id: item.id, start, duration, node: item.node, label: item.label || 'ひと休み' };
  }).sort((a, b) => a.start - b.start);
  if (result.fixedBreaks.some((item, index, all) => index && all[index - 1].start + all[index - 1].duration > item.start)) throw new RangeError('追加した休憩の時間が重なっています。');
  result.history = Array.isArray(settings.history) ? settings.history.slice(0, 100000) : [];
  setWaitForecastContext(park, result);
  const activities = new Map(park.activities.map(activity => [activity.id, activity]));
  const input = settings.selections || [];
  if (!Array.isArray(input) || input.length > 400 || input.filter(s=>baseVisitId(s?.id)===s?.id).length>200) throw new RangeError('希望する施設は200件以内にしてください。');
  const ids = new Set();
  result.selections = input.map(item => {
    if (!item || !activities.has(item.id) || ids.has(item.id)) throw new RangeError('施設の選択IDを確認してください。');
    ids.add(item.id);
    const selection = { ...item, confirmedAccess: !!(item.confirmedAccess ?? item.confirmAccess), weight: numberIn(item.weight ?? 3, '重要度', 1, 5, true), required: !!item.required };
    const activity = activities.get(item.id);
    const override = item.nodeOverride || item.viewingNode;
    if (override && !park.nodes.some(node => node.id === override)) throw new RangeError('鑑賞・集合地点を確認してください。');
    if (override) selection.nodeOverride = override;
    selection.duration = numberIn(item.duration ?? activity.duration ?? 10, '滞在時間', 1, 600, true);
    selection.cost = ceil100(numberIn(item.cost ?? activity.cost ?? 0, '費用', 0, 10000000, true));
    if (item.earliest !== undefined && item.earliest !== '') selection.earliest = toMinutes(item.earliest);
    if (item.latest !== undefined && item.latest !== '') selection.latest = toMinutes(item.latest);
    if (selection.earliest !== undefined && selection.latest !== undefined && selection.earliest > selection.latest) throw new RangeError(activity.name + 'の時間帯を確認してください。');
    if (item.manualWait !== undefined) selection.manualWait = numberIn(item.manualWait, '待ち時間', 0, 600, true);
    selection.dpaMode = ['none', 'consider', 'owned', 'unavailable'].includes(item.dpaMode) ? item.dpaMode : 'none';
    if (selection.dpaMode === 'owned') {
      if (!activity.dpa) throw new RangeError(activity.name + 'はDPAの対象ではありません。');
      selection.dpaStart = toMinutes(item.dpaStart); selection.dpaEnd = toMinutes(item.dpaEnd);
      if (item.dpaPurchasedAt === undefined || item.dpaPurchasedAt === '') throw new RangeError('取得済みDPAの購入時刻を入力してください。');
      selection.dpaPurchasedAt = toMinutes(item.dpaPurchasedAt);
      if (selection.dpaStart >= selection.dpaEnd) throw new RangeError('取得済みDPAの時間帯を確認してください。');
      selection.required = true;
    }
    if(['timeWindowLinked','dpaWindowLinked'].some(key=>item[key]!==undefined&&typeof item[key]!=='boolean'))throw new RangeError('時間枠の連動設定を確認してください。');
    selection.pauseWindows=normalisePauseWindows(item.pauseWindows||[]);
    for (const key of ['showTimes', 'normalShowTimes', 'dpaAvailableWindows', 'windows']) {
      if (item[key] !== undefined && !Array.isArray(item[key])) throw new RangeError('施設の時間設定を確認してください。');
    }
    if (item.normalShowTimes && item.normalShowTimes.length > 30) throw new RangeError('通常鑑賞の公演時刻は30件以内にしてください。');
    if (item.normalShowTimes) selection.normalShowTimes = item.normalShowTimes.map(toMinutes).sort((a, b) => a - b);
    if (item.showTimes && item.showTimes.length > 30) throw new RangeError('公演時刻は30件以内にしてください。');
    if (item.dpaAvailableWindows && item.dpaAvailableWindows.length > 50) throw new RangeError('DPAの空き枠は50件以内にしてください。');
    if (item.windows && item.windows.length > 50) throw new RangeError('施設の時間帯は50件以内にしてください。');
    if (item.showTimes) selection.showTimes = item.showTimes.map(toMinutes).sort((a, b) => a - b);
    if (item.dpaAvailableWindows) selection.dpaAvailableWindows = item.dpaAvailableWindows.map(window => {
      if (!Array.isArray(window) || window.length !== 2) throw new RangeError('DPAの空き枠を確認してください。');
      const value = window.map(toMinutes);
      if (value[0] >= value[1]) throw new RangeError('DPAの空き枠を確認してください。');
      return value;
    });
    return selection;
  });
  if (!Array.isArray(settings.purchases || []) || (settings.purchases || []).length > 200) throw new RangeError('DPAの購入履歴を確認してください。');
  result.purchases = (settings.purchases || []).map(purchase => {
    if (baseVisitId(purchase.id)!==purchase.id || !activities.has(purchase.id)) throw new RangeError('取得済みDPAの施設IDを確認してください。');
    const activity = activities.get(purchase.id);
    if (!activity.dpa) throw new RangeError('取得済みDPAの対象を確認してください。');
    if (purchase.kind && purchase.kind !== (activity.dpa.kind || 'attraction')) throw new RangeError('DPA購入履歴の種別が施設と一致しません。');
    return { ...purchase, kind: activity.dpa.kind || 'attraction',
      purchasedAt: toMinutes(purchase.purchasedAt ?? entry), start: toMinutes(purchase.start),
      end: toMinutes(purchase.end), cost: ceil100(numberIn(purchase.cost ?? activity.dpa.price, '支払済みDPAの費用', 0, 10000000, true)), owned: true };
  });
  for (const selection of result.selections.filter(item => item.dpaMode === 'owned')) {
    const facilityId=baseVisitId(selection.id);
    if (!result.purchases.some(purchase => purchase.id === facilityId)) {
      const activity = activities.get(selection.id);
      result.purchases.push({ id: facilityId, kind: activity.dpa.kind || 'attraction', purchasedAt: selection.dpaPurchasedAt,
        start: selection.dpaStart, end: selection.dpaEnd, cost: activity.dpa.price, owned: true });
    }
  }
  const purchaseIds = new Set();
  for (const purchase of result.purchases) {
    if (purchaseIds.has(purchase.id)) throw new RangeError('同じDPAの購入履歴が重複しています。');
    purchaseIds.add(purchase.id);
    const selection = result.selections.find(item => baseVisitId(item.id) === purchase.id && item.dpaMode === 'owned');
    if (selection && (selection.dpaStart !== purchase.start || selection.dpaEnd !== purchase.end || selection.dpaPurchasedAt !== purchase.purchasedAt)) throw new RangeError('取得済みDPAの時刻と購入履歴が一致しません。');
    if (purchase.purchasedAt < entry || purchase.start >= purchase.end || purchase.end > 1439 ||
      purchase.purchasedAt > purchase.start) throw new RangeError('取得済みDPAの購入・利用時刻を確認してください。');
  }
  return result;
}

function row(kind, start, end, name, extra = {}) {
  return { kind, type: kind, start, end, duration: end - start, name, cost: 0, dpa: false, ...extra };
}

// A skipped break starts the next interval at the end of that visit even if a
// subsequent search changes the next destination. It consumes no plan time.
function restIntervalStartsAgain(category,duration,id,settings){
  return (FOOD.has(category)&&duration>=DINING_RECOVERY_MINUTES)||settings.skipAutoRestAfter.includes(id);
}

function recoveryEnds(rows,settings) {
  return rows.filter(item => item.kind === 'rest' ||
    (item.kind === 'activity' && restIntervalStartsAgain(item.category,item.end-item.start,item.activityId,settings))).map(item => item.end);
}

function isFoodVisit(item, activities) {
  return (item?.kind || item?.type) === 'activity' &&
    FOOD.has(activities.get(item.activityId)?.category ?? item.category);
}

/** Only visits and breaks separate stops; travel, queues and idle time do not. */
export function restsBesideFood(rows, activities) {
  const rests = new Set();
  let previous;
  for (const item of rows) {
    const kind = item.kind || item.type;
    if (kind !== 'activity' && kind !== 'rest') continue;
    if (kind === 'rest' && isFoodVisit(previous, activities)) rests.add(item);
    if ((previous?.kind || previous?.type) === 'rest' && isFoodVisit(item, activities)) rests.add(previous);
    previous = item;
  }
  return rests;
}

function autoRestDue(state, activity, context) {
  const settings = context.settings;
  if (!settings.restEvery || !settings.restMinutes || FOOD.has(activity.category)) return false;
  // Eating already provides a pause. Even a short snack should not be followed
  // immediately by another automatic stop.
  if (state.lastVisitWasFood) return false;
  const latestFood = state.rows.findLast(item => isFoodVisit(item, context.map));
  if (latestFood && state.time - latestFood.end < DINING_BREAK_GAP) return false;
  // Leave room for a nearby requested meal, even if a short visit is next.
  const mealSoon = context.selected.some(selection => !state.visited.has(selection.id) &&
    FOOD.has(context.map.get(selection.id)?.category) && Number.isFinite(selection.earliest) &&
    Math.abs(selection.earliest - state.time) < DINING_BREAK_GAP);
  if (mealSoon) return false;
  const fixedRest = settings.fixedBreaks[state.breakIndex];
  if (fixedRest && fixedRest.start - state.time <= DINING_BREAK_GAP) return false;
  const tiringVisits = new Set(state.rows.filter(item => item.kind === 'activity' &&
    item.category === 'attraction' && item.end > state.lastRest).map(item => item.activityId));
  const longQueue = state.rows.some(item => item.kind === 'queue' && tiringVisits.has(item.activityId) && item.end - item.start >= LONG_ATTRACTION_QUEUE);
  const elapsed = state.time - state.lastRest;
  return elapsed >= settings.restEvery || (longQueue && elapsed >= Math.min(settings.restEvery, 60));
}

function prefixSourceRows(initialPlan,settings) {
  const cutoff=toMinutes(settings.replanFrom);
  // A failed replan can carry a previous prefix but cannot supply any new visits.
  const rows=initialPlan?.rows||[];
  const recorded=initialPlan?.status==='no-plan'?rows.filter(row=>row.preserved):rows;
  const priorRows=recorded.map(row=>row.kind||!row.type?row:{...row,kind:row.type});
  const startedVisitIds=new Set(priorRows.filter(item=>item.start<cutoff&&['queue','activity'].includes(item.kind)).map(item=>item.activityId));
  return priorRows.filter(item=>item.kind!=='exit'&&(item.start<cutoff||(startedVisitIds.has(item.activityId)&&(['queue','activity'].includes(item.kind)||item.awaitingPerformance===true))));
}
/** Visits already accounted for when checking the remaining wishes in the editor. */
export function settledReplanWishes(park,settings,previous) {
  if (!Number.isInteger(settings.replanFrom)) return new Set();
  const settled = new Set(settings.completedIds || []);
  const entries=progressEntries(park,settings);
  const reports=new Map(entries);
  for (const [id, value] of entries) {
    if (['done','queue','riding','skipped'].includes(value.status)) settled.add(id);
    else settled.delete(id);
  }
  const source = replanSource(park,settings,previous);
  if (!source || source.settings?.date !== settings.date || !['feasible','no-plan'].includes(source.status)) return settled;
  const expanded = expandRepeatVisits(park,settings,source);
  const rows = entries.length || source.rows?.some(r=>r.userProgress || r.progressAnchor)
    ? preservedPrefix(source,expanded.settings,expanded.park) : prefixSourceRows(source,settings);
  for (const row of rows) {
    if (row.kind === 'activity' && row.activityId && !reports.has(row.activityId)) settled.add(row.activityId);
  }
  return settled;
}
function preservedPrefix(initialPlan,settings,park) {
  const cutoff=toMinutes(settings.replanFrom);
  const original=prefixSourceRows(initialPlan,settings).map(item=>{
    const end=['wait','rest'].includes(item.kind)&&!item.fixedBreakId&&!item.awaitingPerformance?Math.min(item.end,cutoff):item.end;
    // Older plans identify a purchased candidate by its charge or, for a free slot, its ticket.
    const legacyCandidate = item.kind === 'activity' && item.dpa && item.plannedDpaPurchase === undefined &&
      !item.dpaCost && initialPlan?.purchases?.some(ticket => ticket.id === baseVisitId(item.activityId) && ticket.owned === false);
    return {...copy(item),...(legacyCandidate ? {plannedDpaPurchase:true} : {}),end,duration:end-item.start,preserved:true,...(item.kind==='walk'?{walkSpeed:item.walkSpeed??initialPlan?.settings?.speed??settings.speed}:{})};
  });
  return applyProgressToPrefix(park,{...settings,entry:toMinutes(settings.entry),exit:toMinutes(settings.exit)},cutoff,original,initialPlan);
}
const rowSignature=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function historicalBounds(park,settings,source) {
  const current={date:settings.date,parkId:park.id,entry:toMinutes(settings.entry),exit:toMinutes(settings.exit)};
  if(settings.replanFrom===undefined||settings.replanFrom===''||source?.settings?.date!==settings.date||(source.parkId&&source.parkId!==park.id))return current;
  const originalEntry=source.settings.entry,originalExit=source.settings.exit,inherited=source.historicalVisitBounds;
  if(!Number.isInteger(originalEntry)||!Number.isInteger(originalExit))return current;
  const inheritedValid=inherited?.date===settings.date&&inherited.parkId===park.id&&Number.isInteger(inherited.entry)&&Number.isInteger(inherited.exit)&&inherited.entry>=0&&inherited.entry<=originalEntry&&inherited.exit>=originalExit&&inherited.exit<=1440;
  const sourceRows=prefixSourceRows(source,settings);
  if(!sourceRows.every(item=>(item.start>=originalEntry&&item.end<=originalExit)||(item.preserved&&inheritedValid&&item.start>=inherited.entry&&item.end<=inherited.exit)))return current;
  // Bounds come from the exact recorded prefix, never from an arbitrary expanded metadata value.
  const rows=preservedPrefix(source,settings,park);
  return {...current,entry:Math.min(current.entry,...rows.map(item=>item.start)),exit:Math.max(current.exit,...rows.map(item=>item.end))};
}


function contextFor(park, settings, initialPlan) {
  const graph = graphDistances(park);
  const map = new Map(park.activities.map(activity => [activity.id, activity]));
  if (!graph.distances[park.entryNode] || !graph.distances[park.exitNode]) throw new RangeError('入口と出口の地点がありません。');
  let prefix = [], beginning = settings.entry, location = settings.currentNode || park.entryNode;
  const completed = new Set(settings.completedIds || []);
  const reports=new Map(progressEntries(park,settings));
  for(const id of reports.keys()) completed.delete(id);
  const active=[...reports.values()].some(f=>f.status==='queue'||f.status==='riding');
  if (settings.replanFrom !== undefined && settings.replanFrom !== '') {
    const cutoff = toMinutes(settings.replanFrom);
    if (cutoff < settings.entry || cutoff >= settings.exit) throw new RangeError('組み替える時刻は滞在時間内にしてください。');
    prefix=preservedPrefix(initialPlan,settings,park);
    if (prefix.length) {
      beginning = Math.max(cutoff, ...prefix.map(item => item.end));
      const prefixEnd = prefix[prefix.length - 1];
      const prefixNode = prefixEnd.endNode || prefixEnd.node || prefixEnd.to || location;
      if (!active && settings.currentNode && settings.currentNode !== prefixNode && beginning > cutoff) throw new RangeError('進行中の予定の終了地点と現在地が一致しません。組み替える時刻を予定の終了後にしてください。');
      location = active ? prefixNode : (settings.currentNode || prefixNode);
      if (!active && settings.currentNode && settings.currentNode !== prefixNode) prefix.push(row('location', beginning, beginning, '現在地を確認', { node: location, preserved: true }));
    } else beginning = cutoff;
    for(const [id,value] of reports)
      if(value.status==='done' && !prefix.some(item=>item.kind==='activity' && item.activityId===id)) completed.add(id);
    for(const item of prefix.filter(item=>item.kind==='activity')) {
      if (!canStartVisit(item.activityId,completed)) throw new RangeError('2回目の体験を記録する前に1回目の体験を確認してください。');
      completed.add(item.activityId);
    }
    for(const id of completed) {
      if (!canStartVisit(id,completed)) throw new RangeError('2回目の体験には1回目の完了記録が必要です。');
    }
  }
  if (!graph.distances[location]) throw new RangeError('現在地を地図から選んでください。');
  const prefixVisits = prefix.filter(item=>item.kind==='activity').flatMap(item=>{
    const previous=(initialPlan?.visits || []).find(visit=>visit.id===item.activityId);
    if(!item.userProgress) return previous ? [copy(previous)] : [];
    const queue=prefix.find(r=>r.kind==='queue' && r.activityId===item.activityId);
    return [{id:item.activityId, activityId:item.activityId, name:item.name, category:item.category,
      node:item.node, endNode:item.endNode, start:item.start, end:item.end, queueStart:item.dpaAdmission??queue?.start??item.start,
      arrival:queue?.start??item.start, method:item.dpa?'dpa':'normal', userProgress:item.userProgress,
      cost:item.cost, dpaCost:item.dpaCost??0}];
  });
  const replanCutoff = settings.replanFrom === undefined || settings.replanFrom === '' ? settings.entry : toMinutes(settings.replanFrom);
  if (settings.fixedBreaks.some(item => item.start < beginning && item.start + item.duration > replanCutoff && !prefix.some(saved => saved.fixedBreakId === item.id))) throw new RangeError('進行中の予定と追加した休憩が重なっています。休憩時刻を見直してください。');
  const completedSelections = settings.selections.filter(selection => completed.has(selection.id));
  const goalSelections=settings.selections.filter(selection=>reports.get(selection.id)?.status!=='skipped');
  const selected = goalSelections.filter(selection => !completed.has(selection.id));
  const paidDpa = settings.purchases.reduce((sum, purchase) => sum + purchase.cost, 0);
  const sourceRows = prefix.filter(item => item.kind === 'activity');
  const previousDpaEntries=dpaAdmissions(prefix);
  const lastVisit = sourceRows.at(-1);
  const prefixNonDpa = sourceRows.reduce((sum, item) => sum + Math.max(0, finite(item.cost) - finite(item.dpaCost)), 0);
  // A subsequently confirmed ticket can also appear in a completed visit's charge.
  const prefixDpa = sourceRows.reduce((sum, item) => {
    if (!item.dpaCost) return sum;
    const admission = item.dpaAdmission ?? prefix.find(row => row.kind === 'queue' && row.activityId === item.activityId)?.start ?? item.start;
    const recorded = settings.purchases.some(ticket => ticket.id === baseVisitId(item.activityId) && ticket.start <= admission && admission < ticket.end);
    return sum + (recorded ? 0 : item.dpaCost);
  }, 0);
  const spent = Math.max(settings.spentBudget, prefixNonDpa + paidDpa + prefixDpa);
  const initial = {
    time: beginning, node: location, rows: prefix, visits: prefixVisits, visited: new Set(completed),
    lastVisitWasFood: FOOD.has(lastVisit?.category ?? map.get(lastVisit?.activityId)?.category),
    breakIndex: settings.fixedBreaks.filter(item => item.start + item.duration <= beginning).length,
    score: completedSelections.reduce((sum, item) => sum + item.weight, 0),
    cost: spent, foodCost: sourceRows.filter(item => FOOD.has(item.category)).reduce((sum, item) => sum + finite(item.cost), 0),
    plannedDpaCount: sourceRows.filter(item => item.dpa && (item.plannedDpaPurchase || item.dpaCost > 0)).length,
    dpaCost: prefixDpa + paidDpa, shoppingCost: sourceRows.filter(item => item.category === 'shop').reduce((sum, item) => sum + finite(item.cost), 0),
    walk: prefix.filter(item => item.kind === 'walk').reduce((sum, item) => sum + finite(item.metres), 0),
    lastRest: prefix.length ? Math.max(Math.min(settings.entry, ...prefix.map(item => item.start)), ...recoveryEnds(prefix,settings)) : beginning,
    purchases: settings.purchases.map(copy), restDeferred:false, restDeferralMinutes:0,
    required: completedSelections.filter(item => item.required).length,
  };
  for (const item of prefix.filter(item => item.fixedBreakId)) {
    const expected = settings.fixedBreaks.find(candidate => candidate.id === item.fixedBreakId);
    if (expected && (item.start !== expected.start || item.end !== expected.start + expected.duration || item.node !== expected.node)) throw new RangeError('開始済みの休憩は時刻・長さ・地点を変えられません。');
  }
  const pendingBreak = settings.fixedBreaks[initial.breakIndex];
  if (pendingBreak && pendingBreak.start < beginning) throw new RangeError('進行中の予定と追加した休憩が重なっています。休憩時刻を見直してください。');
  const historyById = new Map();
  for (const record of settings.history) {
    const id = record.activityId ?? record.activity_id ?? record.id;
    if (!historyById.has(id)) historyById.set(id, []);
    historyById.get(id).push(record);
  }
  return { park, settings, map, graph, selected, previousDpaEntries, goalSelections, completed, completedSelections, initial, historicalVisitBounds:prefix.length?historicalBounds(park,settings,initialPlan):null, historyById, waitCache: new Map(), rankCache: new WeakMap() };
}

function activityWindows(activity, selection, settings, park) {
  const windows = selection.windows || activity.dailySchedules?.[settings.date]?.windows || activity.windows || [[settings.entry, settings.exit]];
  if (!Array.isArray(windows) || windows.length > 100 || windows.some(window => !Array.isArray(window) || window.length !== 2)) throw new RangeError('施設の営業時間を確認してください。');
  const open=windows.map(window => window.map(toMinutes)).filter(window => window[0] < window[1]);
  return subtractPauseWindows(open,operationPauseInfo(park,activity,selection,settings).windows);
}

function showTimes(activity, selection, settings) {
  if (selection.confirmSchedule===false) return [];
  if (Array.isArray(selection.showTimes)) return selection.showTimes;
  if (activity.dailySchedules?.[settings.date]?.showTimes) return activity.dailySchedules[settings.date].showTimes.map(toMinutes);
  if (activity.showTimesDate && activity.showTimesDate !== settings.date) return [];
  return (activity.showTimes || []).map(toMinutes);
}

function eligiblePurchaseAt(state, activity, window, context) {
  const kind = activity.dpa.kind || 'attraction';
  let at = context.settings.replanFrom !== undefined && context.settings.replanFrom !== '' ? toMinutes(context.settings.replanFrom) : context.settings.entry;
  for (const purchase of state.purchases.filter(item => item.kind === kind)) {
    at = Math.max(at, Math.min(purchase.purchasedAt + 60, purchase.start));
    if (purchase.id === baseVisitId(activity.id)) at = Math.max(at, purchase.end);
  }
  return at <= window[0] ? at : Infinity;
}

function accessAllowed(activity, selection, method) {
  return activity.access === undefined || activity.access === 'normal' || (selection.confirmedAccess || selection.confirmAccess) || method === 'dpa';
}

function budgetAllowed(state, activity, price, dpaPrice, context) {
  const settings = context.settings;
  const cost = state.cost + price + dpaPrice;
  const shopping = state.shoppingCost + (activity.category === 'shop' ? price : 0);
  const reserve = Math.max(0, finite(settings.souvenirReserve) - shopping);
  if (cost + reserve > settings.budget) return false;
  if (settings.foodBudget !== undefined && state.foodCost + (FOOD.has(activity.category) ? price : 0) > settings.foodBudget) return false;
  if (settings.dpaBudget !== undefined && state.dpaCost + dpaPrice > settings.dpaBudget) return false;
  return true;
}

// Receipts are issued for a facility. Visits keep their individual entry time
// so the same receipt cannot be admitted a second time after a replan.
function dpaAdmissions(rows) {
  const result=new Map();
  const queueStarts=new Map(rows.filter(row=>row.kind==='queue' && row.dpa).map(row=>[row.activityId,row.start]));
  for(const row of rows.filter(row=>row.kind==='activity' && row.dpa)) {
    const facility=baseVisitId(row.activityId);
    if(!result.has(facility)) result.set(facility,[]);
    result.get(facility).push(row.dpaAdmission ?? queueStarts.get(row.activityId) ?? row.start);
  }
  return result;
}

function usedDpaWindow(context,id,start,end) {
  return context.previousDpaEntries.get(baseVisitId(id))?.some(time=>time>=start && time<end) ?? false;
}

function dpaAvailable(activity, date) {
  return !!activity.dpa && (!activity.dpa.startDate || activity.dpa.startDate <= date) &&
    (!activity.dpa.endDate || date <= activity.dpa.endDate);
}

/** A planning allowance, never a confidence interval or a change to the forecast. */
export function queueAllowance(activity, estimate, method, settings) {
  const eligible = method === 'normal' && !FIXED.has(activity.category) && activity.category !== 'shop' && estimate.minutes > 0;
  let buffer = eligible ? Number(settings.waitBufferMinutes ?? 0) : 0;
  const mae = settings.waitModel?.validation?.modelMae;
  if (eligible && settings.waitBufferMode === 'auto' && estimate.source === 'ml' && Number.isFinite(mae) && mae >= 0) buffer = Math.min(30, Math.ceil(mae / 5) * 5);
  const delay = eligible ? Number(settings.queueDelayMinutes ?? 0) : 0;
  return {estimatedMinutes:estimate.minutes, bufferMinutes:buffer, delayMinutes:delay, totalMinutes:estimate.minutes + buffer + delay};
}

function requiredVisitsStillReachable(state, context) {
  // This optimistic look-ahead only decides whether an automatic rest should
  // wait. Actual fixed rests and all reservation conditions are checked again
  // by the normal search and the independent validator.
  const after = {...state, breakIndex:context.settings.fixedBreaks.length};
  return context.selected.filter(selection => selection.required && !state.visited.has(selection.id))
    .every(selection => scheduledOptions(after, context.map.get(selection.id), selection, context, false).length > 0);
}

function scheduledOptions(state, baseActivity, selection, context, allowAutoRest = true, deferRest = false) {
  if (!activityAvailable(baseActivity, context.settings.date)||currentRideStatus(facilityForVisit(baseActivity),context.settings,{now:context.settings.waitAsOf})?.isOpen===false) return [];
  const settings = context.settings, graph = context.graph;
  if (settings.avoidConsecutiveFood && state.lastVisitWasFood && FOOD.has(baseActivity.category)) return [];
  const methods = [];
  if (selection.dpaMode !== 'owned') methods.push({ method: 'normal', windows: activityWindows(baseActivity, selection, settings, context.park), price: 0 });
  if (dpaAvailable(baseActivity, settings.date) && selection.dpaMode === 'owned' &&
    !usedDpaWindow(context, selection.id, selection.dpaStart, selection.dpaEnd) &&
    (baseActivity.category !== 'parade' || (selection.nodeOverride && selection.showTimes?.length))) methods.push({
    method: 'dpa', windows: [[selection.dpaStart, selection.dpaEnd]], price: 0, owned: true,
  });
  if (dpaAvailable(baseActivity, settings.date) && selection.dpaMode === 'consider' &&
    (settings.dpaPurchaseLimit === undefined || state.plannedDpaCount < settings.dpaPurchaseLimit) &&
    (baseActivity.category !== 'parade' || (selection.nodeOverride && selection.showTimes?.length))) {
    for (const window of selection.dpaAvailableWindows || []) {
      if (usedDpaWindow(context, selection.id, window[0], window[1])) continue;
      const purchaseAt = eligiblePurchaseAt(state, baseActivity, window, context);
      if (Number.isFinite(purchaseAt)) methods.push({
        method: 'dpa', windows: [window], price: ceil100(baseActivity.dpa.price), purchaseAt,
      });
    }
  }
  const options = [];
  let triedRest = false;
  for (const method of methods) {
    const activity = { ...baseActivity, node: method.method === 'dpa' ? (selection.nodeOverride || baseActivity.node) : baseActivity.node };
  const metres = graph.distances[state.node]?.[activity.node] ?? Infinity;
  if (!Number.isFinite(metres)) continue;
  const rows = [];
  let departure = state.time, lastRest = state.lastRest;
  const autoBreakId=`${state.node}:${activity.id}`;
  if (allowAutoRest && autoRestDue(state, activity, context) && !settings.excludedAutoBreaks.includes(autoBreakId)) {
    rows.push(row('rest', departure, departure + settings.restMinutes, 'ひと休み', { node: state.node,autoBreakId }));
    departure += settings.restMinutes; lastRest = departure;
    triedRest = true;
  }
  const walkMinutes=walkingMinutes(metres,departure,settings);
  const arrival = departure + walkMinutes;
  if (walkMinutes) rows.push(row('walk', departure, arrival, activity.name + 'へ移動', {
    from: state.node, to: activity.node, node: activity.node, metres,
    path: graph.paths[state.node][activity.node], activityId: activity.id,...walkingFields(departure,settings,context.park),
  }));
    if (!accessAllowed(activity, selection, method.method) || !budgetAllowed(state, activity, selection.cost, method.price, context)) continue;
    const windows = method.windows;
    const earliest = Math.max(arrival, selection.earliest ?? 0);
    const latest = Math.min(settings.exit, selection.latest ?? settings.exit);
    const fixed = FIXED.has(activity.category);
    const timeSelection = activity.category === 'parade' && method.method !== 'dpa' && selection.nodeOverride ? { ...selection, showTimes: selection.normalShowTimes } : selection;
    const starts = fixed ? showTimes(activity, timeSelection, settings) : [earliest,...activityWindows(activity,selection,settings,context.park).map(window=>window[0])];
    if (!fixed && method.method === 'normal' && settings.crowdMode !== 'manual' && finite(activity.baseWait) > 15) {
      for (let minute = Math.ceil(earliest / 60) * 60; minute <= Math.min(earliest + 120, latest); minute += 60) starts.push(minute);
    }
    if (!fixed && method.method === 'normal' && settings.crowdMode !== 'manual') {
      for (let minute = Math.ceil(earliest / 15) * 15; minute <= Math.min(earliest + 90, latest); minute += 15) starts.push(minute);
    }
    for (const window of windows) for (const proposed of [...new Set(starts)]) {
      if (context.deadline && now() >= context.deadline) return options;
      let queueStart = Math.max(earliest, window[0], proposed);
      if (liveWaitFor(facilityForVisit(activity), fixed ? proposed : queueStart, settings, { now: settings.waitAsOf })?.isOpen === false) continue;
      const cacheKey = activity.id + ':' + queueStart;
      if (!context.waitCache.has(cacheKey)) context.waitCache.set(cacheKey, estimateWait(activity, queueStart, settings, context.historyById.get(baseVisitId(activity.id)) || []));
      const waitEstimate = context.waitCache.get(cacheKey);
      const waitSource = method.method === 'dpa' ? 'dpa' : waitEstimate.source;
      const allowance = queueAllowance(activity, method.method === 'dpa' ? {minutes:Math.round(finite(activity.dpa.wait, 10)), source:'dpa'} : waitEstimate, method.method, settings);
      const wait = allowance.totalMinutes;
      let start = queueStart + wait;
      if (fixed) {
        start = proposed;
        queueStart = start - wait;
        if (method.method === 'dpa') {
          // Each admission belongs to the next confirmed performance at this viewing location.
          if (starts.some(time => time >= window[0] && time < start)) continue;
          // When the ticket closes earlier, enter during its window and wait inside.
          if (queueStart >= window[1]) {
            const operating = activityWindows(activity, selection, settings, context.park)
              .find(([open,close]) => Math.max(open,earliest,window[0]) < window[1] && start + selection.duration <= close);
            if (!operating) continue;
            queueStart = Math.max(earliest, window[0], operating[0]);
          }
        }
        if (queueStart < earliest || queueStart < window[0]) continue;
      }
      if (method.method === 'dpa' && queueStart >= window[1]) continue;
      const end = start + selection.duration;
      if (end > latest || (method.method === 'normal' && end > window[1])) continue;
      if (!activityWindows(activity, selection, settings, context.park).some(open => queueStart >= open[0] && end <= open[1])) continue;
      const endNode = activity.endNode || activity.node;
      const exitMetres = graph.distances[endNode]?.[context.park.exitNode] ?? Infinity;
      if (end + walkingMinutes(exitMetres,end,settings) > settings.exit) continue;
      const nextBreak = settings.fixedBreaks[state.breakIndex];
      if (nextBreak && end + walkingMinutes(graph.distances[endNode][nextBreak.node],end,settings) > nextBreak.start) continue;
      const key = method.method + ':' + queueStart + ':' + end;
      if (options.some(option => option.key === key)) continue;
      const extra = rows.slice();
      if (queueStart > arrival) extra.push(row('wait', arrival, queueStart, fixed ? '開演前の時間' : '時間帯まで待機', { node: activity.node, activityId: activity.id }));
      const queueEnd = queueStart + wait;
      if (wait || queueEnd < start) extra.push(row('queue', queueStart, queueEnd, fixed ? '鑑賞場所へ・入場待ち' : '待ち時間', { node: activity.node, activityId: activity.id, dpa: method.method === 'dpa', waitSource,
        estimatedMinutes:allowance.estimatedMinutes, bufferMinutes:allowance.bufferMinutes, delayMinutes:allowance.delayMinutes }));
      if (queueEnd < start) extra.push(row('wait', queueEnd, start, '鑑賞エリアで開演待ち', {
        node:activity.node, activityId:activity.id, dpa:true, awaitingPerformance:true,
      }));
      const activityCost = selection.cost + method.price;
      extra.push(row('activity', start, end, activity.name, {
        activityId: activity.id, node: activity.node, endNode, category: activity.category,
        cost: activityCost, dpaCost: method.price, dpa: method.method === 'dpa', method: method.method, waitSource,
        ...(method.method === 'dpa' && !method.owned ? {plannedDpaPurchase:true} : {}),
        sourceUrl: activity.sourceUrl,
      }));
      const purchases = state.purchases.slice();
      if (method.method === 'dpa' && !method.owned) purchases.push({
        id: baseVisitId(activity.id), kind: activity.dpa.kind || 'attraction', purchasedAt: method.purchaseAt,
        start: window[0], end: window[1], cost: method.price, owned: false,
      });
      const visited = new Set(state.visited); visited.add(activity.id);
      const intervalRestarts=restIntervalStartsAgain(activity.category,selection.duration,activity.id,settings);
      const child = {
        key, time: end, node: endNode, rows: state.rows.concat(extra), breakIndex: state.breakIndex,
        visits: state.visits.concat({ id: activity.id, activityId: activity.id, name: activity.name,
          node: activity.node, endNode, category: activity.category, start, end, queueStart, arrival,
          method: method.method, waitSource, weight: selection.weight, cost: activityCost, dpaCost: method.price }),
        lastVisitWasFood: FOOD.has(activity.category),
        visited, score: state.score + selection.weight, cost: state.cost + activityCost,
        foodCost: state.foodCost + (FOOD.has(activity.category) ? selection.cost : 0),
        shoppingCost: state.shoppingCost + (activity.category === 'shop' ? selection.cost : 0),
        plannedDpaCount: state.plannedDpaCount + Number(method.method === 'dpa' && !method.owned),
        dpaCost: state.dpaCost + method.price, walk: state.walk + metres,
        lastRest: intervalRestarts ? end : lastRest,
        restDeferred: intervalRestarts ? false :
          (rows.some(item => item.autoBreakId) ? false : (state.restDeferred || deferRest)),
        restDeferralMinutes: (state.restDeferralMinutes || 0) +
          (!rows.some(item => item.autoBreakId) && (state.restDeferred || deferRest) ?
            (FOOD.has(activity.category) && selection.duration >= DINING_RECOVERY_MINUTES ? start : end) - state.time : 0),
        purchases, required: state.required + (selection.required ? 1 : 0),
      };
      if (allowAutoRest && rows.some(item => item.autoBreakId) && !requiredVisitsStillReachable(child, context)) continue;
      options.push(child);
    }
  }
  // Keep the deferred branch as well: individually reachable reservations may
  // still form a tight chain. Preference for recovery is a soft ranking below
  // wish scores, never a restriction on an otherwise feasible visit.
  return triedRest ? options.concat(scheduledOptions(state, baseActivity, selection, context, false, true)) : options;
}

function tieValue(state, context) {
  if (context.rankCache.has(state)) return context.rankCache.get(state);
  const preference = context.settings.budgetPreference;
  const preferenceScore = preference === 'food' ? state.visits.filter(visit => FOOD.has(visit.category)).length :
    preference === 'dpa' ? state.visits.filter(visit => visit.method === 'dpa').length : 0;
  const exitMetres = context.graph.distances[state.node]?.[context.park.exitNode] ?? Infinity;
  const exitMinutes = walkingMinutes(exitMetres,state.time,context.settings);
  const burden = state.rows.filter(item => ['walk', 'queue', 'wait'].includes(item.kind))
    .reduce((sum, item) => sum + item.end - item.start, 0) + exitMinutes;
  // Time spent queueing, walking and waiting comes before distance alone.
  // Keep a manually timed break. Among otherwise equally scored wishes, prefer
  // an order that puts an activity between the fixed break and a food stop.
  const fixedBesideFood = context.settings.fixedBreaks.length
    ? [...restsBesideFood(state.rows, context.map)].filter(rest => rest.fixedBreakId).length : 0;
  const value = [state.score, preferenceScore, -fixedBesideFood, -(state.restDeferralMinutes || 0), -Number(!!state.restDeferred),
    -burden, -(state.time + exitMinutes), -state.cost, -(state.walk + exitMetres)];
  context.rankCache.set(state, value);
  return value;
}

function compare(a, b, context) {
  const av = tieValue(a, context), bv = tieValue(b, context);
  for (let index = 0; index < av.length; index++) if (av[index] !== bv[index]) return bv[index] - av[index];
  return 0;
}

function requiredMet(state, context) {
  return context.goalSelections.filter(item => item.required).every(item => state.visited.has(item.id));
}

/** A fixed rest is a zero-score reservation. Walking and any idle time are explicit. */
function nextFixedBreak(state, context) {
  const reservation = context.settings.fixedBreaks[state.breakIndex];
  if (!reservation) return null;
  const metres = context.graph.distances[state.node]?.[reservation.node] ?? Infinity;
  const arrival = state.time + walkingMinutes(metres,state.time,context.settings);
  if (!Number.isFinite(metres) || arrival > reservation.start) return null;
  const rows = state.rows.slice();
  if (arrival > state.time) rows.push(row('walk', state.time, arrival, reservation.label + 'の場所へ移動', {
    from: state.node, to: reservation.node, node: reservation.node, metres,
    path: context.graph.paths[state.node][reservation.node],...walkingFields(state.time,context.settings,context.park),
  }));
  if (arrival < reservation.start) rows.push(row('wait', arrival, reservation.start, '休憩までの自由時間', { node: reservation.node }));
  const end = reservation.start + reservation.duration;
  rows.push(row('rest', reservation.start, end, reservation.label, { node: reservation.node, fixedBreakId: reservation.id }));
  return { ...state, rows, time: end, node: reservation.node, lastRest: end,
    restDeferred:false, restDeferralMinutes:(state.restDeferralMinutes || 0) + (state.restDeferred ? reservation.start - state.time : 0),
    walk: state.walk + metres, breakIndex: state.breakIndex + 1 };
}

function canFinish(state, context) {
  const metres = context.graph.distances[state.node]?.[context.park.exitNode] ?? Infinity;
  return state.breakIndex === context.settings.fixedBreaks.length && Number.isFinite(metres) && state.time + walkingMinutes(metres,state.time,context.settings) <= context.settings.exit &&
    (context.settings.dpaBudget === undefined || state.dpaCost <= context.settings.dpaBudget) &&
    state.cost + Math.max(0, finite(context.settings.souvenirReserve) - state.shoppingCost) <= context.settings.budget;
}

function recoveryBeforeExit(state, context) {
  const activity = {id:'exit',category:'exit'}, autoBreakId = `${state.node}:exit`;
  if (!state.restDeferred || !autoRestDue(state, activity, context) || context.settings.excludedAutoBreaks.includes(autoBreakId)) return state;
  const end = state.time + context.settings.restMinutes;
  const rested = {...state, time:end, lastRest:end, restDeferred:false,
    rows:state.rows.concat(row('rest',state.time,end,'ひと休み',{node:state.node,autoBreakId}))};
  return canFinish(rested, context) ? rested : state;
}

function finishRows(state, context) {
  const rows = state.rows.slice(), metres = context.graph.distances[state.node][context.park.exitNode];
  const minutes = walkingMinutes(metres,state.time,context.settings), end = state.time + minutes;
  if (minutes) rows.push(row('walk', state.time, end, '出口へ移動', {
    from: state.node, to: context.park.exitNode, node: context.park.exitNode, metres,
    path: context.graph.paths[state.node][context.park.exitNode],...walkingFields(state.time,context.settings,context.park),
  }));
  rows.push(row('exit', end, end, '退園', { node: context.park.exitNode }));
  return rows;
}

// Try appending one wish after the existing visits, keeping their times and tickets.
// Each trial changes one limit. A found option must still allow a walk back to the exit.
function appendWithOneChange(selection, activity, context, best) {
  if (!best || !canStartVisit(selection.id, best.visited)) return null;
  const settings=context.settings;
  function fits(change, needsDpa=false) {
    const trial={...context,settings:{...settings,...change}};
    return scheduledOptions(best,activity,selection,trial).some(child =>
      (!needsDpa || child.visits.at(-1).method==='dpa') && canFinish(recoveryBeforeExit(child,trial),trial));
  }
  const priceText=n => n.toLocaleString('ja-JP')+'円';
  const foodExtra=best.foodCost+selection.cost-settings.foodBudget;
  if (FOOD.has(activity.category) && foodExtra>0 && fits({foodBudget:settings.foodBudget+foodExtra}))
    return {field:'foodBudget',reason:`フードの上限をあと${priceText(foodExtra)}増やすと、今の予定のあとに追加できる組合せがあります。`};
  if (selection.dpaMode==='consider' && activity.dpa && selection.dpaAvailableWindows?.length) {
    const dpaExtra=best.dpaCost+ceil100(activity.dpa.price)-settings.dpaBudget;
    if (dpaExtra>0 && fits({dpaBudget:settings.dpaBudget+dpaExtra},true) && !fits({}))
      return {field:'dpaBudget',reason:`入力済みのDPA候補枠を使うと、DPA予算をあと${priceText(dpaExtra)}増やして今の予定のあとに追加できます。購入前に空きをご確認ください。`};
  }
  const shopCost=best.shoppingCost+(activity.category==='shop'?selection.cost:0);
  const reserve=Math.max(0,finite(settings.souvenirReserve)-shopCost);
  const totalExtra=best.cost+selection.cost+reserve-settings.budget;
  if (totalExtra>0 && fits({budget:settings.budget+totalExtra}))
    return {field:'budget',reason:`総予算をあと${priceText(totalExtra)}増やすと、今の予定のあとに追加できる組合せがあります。`};
  const hours=context.park.operatingCalendar?.[settings.date]?.windows;
  const open=Array.isArray(hours) && hours.find(pair => Array.isArray(pair) && pair.length===2 &&
    pair.every(Number.isInteger) && pair[0]<=settings.exit && settings.exit<pair[1]);
  if (!open) return null;
  const latestExit=Math.min(open[1],parkTimeBounds(context.park,settings.date).max);
  // Two inexpensive trials; the displayed extension is sufficient for this order, not a minimum.
  for (const exit of new Set([Math.min(settings.exit+15,latestExit),Math.min(settings.exit+30,latestExit)])) {
    if (exit>settings.exit && fits({exit}) && !fits({}))
      return {field:'exitTime',reason:`退園予定を${clockText(exit)}にすると（${exit-settings.exit}分延長）、今の予定のあとに追加して出口まで戻れます。`};
  }
  return null;
}

function omissionFor(selection, context, best) {
  const activity = context.map.get(selection.id);
  const conflict=(conflictField,reason)=>({id:selection.id,name:activity.name,weight:selection.weight,required:selection.required,conflictField,reason});
  const date=context.settings.date;
  if (!activityAvailable(activity,date)) return conflict('visitDate','訪問日は休止・開催期間外です。別の営業日を選ぶときは訪問日を変更できます。');
  if (currentRideStatus(facilityForVisit(activity),context.settings,{now:context.settings.waitAsOf})?.isOpen===false)
    return conflict('refreshLiveWaits','運営停止の再開を確認できていません。最新の掲示を取得してから、もう一度予定を組めます。');
  if (selection.dpaMode==='owned' && usedDpaWindow(context, selection.id, selection.dpaStart, selection.dpaEnd))
    return conflict('dpaStart','このDPAの利用枠は体験履歴で使用済みです。2回目の待ち列か、当日の体験記録を確認してください。');
  if (selection.dpaMode==='owned' && context.initial.time>=selection.dpaEnd)
    return conflict('dpaStart','取得済みDPAの受付終了を過ぎています。実際の利用状況と残りの希望を確認してください。');
  if (activity.category === 'parade' && selection.dpaMode === 'owned' && (!selection.nodeOverride || !selection.showTimes?.length))
    return conflict(selection.nodeOverride?'showTimes':'nodeOverride','DPAの鑑賞地点と、その場所の公演時刻を入力してください。');
  if (FIXED.has(activity.category) && !showTimes(activity, selection, context.settings).length)
    return conflict('showTimes','訪問日の公演時刻が未入力です。公式時刻を確認して入力してください。');
  if (!accessAllowed(activity, selection, selection.dpaMode === 'owned' ? 'dpa' : 'normal') && selection.dpaMode !== 'consider')
    return conflict('confirmedAccess','訪問日の予約・エントリーなどの利用条件を確認してください。');
  const addition=appendWithOneChange(selection,activity,context,best);
  if (addition) return conflict(addition.field,addition.reason);
  const earliest=Math.max(context.initial.time,selection.earliest??0);
  const latest=Math.min(context.settings.exit,selection.latest??context.settings.exit);
  const windows=activityWindows(activity,selection,context.settings,context.park);
  const available=Math.max(0,...windows.map(([open,close])=>Math.min(close,latest)-Math.max(open,earliest)));
  if (available<selection.duration)
    return conflict('earliest',`営業時間と希望時間帯が重なるのは最大${available}分です。滞在${selection.duration}分を確保できるように希望時間帯を見直してください。`);
  if (context.settings.crowdMode==='manual'&&!['consider','owned'].includes(selection.dpaMode)){
    const wait=selection.manualWait??activity.baseWait??0;
    if (wait+selection.duration>available)
      return conflict('earliest',`待ち時間${wait}分と滞在${selection.duration}分に対して、営業時間と希望時間帯が重なるのは最大${available}分です。希望時間帯か待ち時間を見直してください。`);
  }
  if (context.settings.avoidConsecutiveFood && FOOD.has(activity.category)) {
    const remainingFood = context.selected.filter(wish => FOOD.has(context.map.get(wish.id).category));
    // Even with every other selected activity used as a separator, only this many food visits can fit.
    const maxFood = context.selected.length - remainingFood.length + Number(!context.initial.lastVisitWasFood);
    const foodCount = best ? remainingFood.filter(wish => best.visited.has(wish.id)).length + 1
                           : remainingFood.filter(wish => wish.required).length;
    if (foodCount > maxFood) return conflict('avoidConsecutiveFood','フードの間に入れる体験が足りません。食事以外の希望を追加するか「フードを連続して入れない」をオフにしてください。');
  }
  // This lower bound still holds if all optional future visits change order.
  if (FOOD.has(activity.category) && context.initial.foodCost+selection.cost>context.settings.foodBudget) {
    const extra=context.initial.foodCost+selection.cost-context.settings.foodBudget;
    return conflict('foodBudget',`この希望に指定した金額を含めると、フードの上限を少なくとも${extra.toLocaleString('ja-JP')}円超えます。`);
  }
  if (selection.cost+context.initial.cost>context.settings.budget) {
    const extra=selection.cost+context.initial.cost-context.settings.budget;
    return conflict('budget',`この希望に指定した金額を含めると、総予算を少なくとも${extra.toLocaleString('ja-JP')}円超えます。`);
  }
  if (!Number.isFinite(context.graph.distances[context.initial.node]?.[activity.node])) return conflict('catalogueSearch','現在地からつながる歩行経路がありません。ほかの施設を候補にできます。');
  if (!scheduledOptions(context.initial, activity, selection, context).length) return conflict('earliest','現在の出発時刻・場所から、この希望を次に入れられる時間帯が見つかりませんでした。');
  if (selection.dpaMode === 'consider' && !(selection.dpaAvailableWindows || []).length) return conflict('dpaStart','DPAの空き枠が未入力のため通常待機だけで検討しました。');
  if (selection.required) return conflict('required','指定した条件ですべての必須の希望を含む案が見つかりませんでした。');
  if (selection.weight>=5) return conflict('required','この施設の重要度はすでに最高です。優先して計画するには「必ず入れる」を選べます。');
  return conflict('weight','今の条件では他の希望が優先されました。この施設を優先したい場合は重要度を見直せます。');
}

function resultFrom(state, context, diagnostics, quick = false) {
  const selections = context.goalSelections;
  const rows = state ? finishRows(state, context) : context.initial.rows;
  const visited = state?.visited || context.initial.visited;
  const weight = selections.filter(item => visited.has(item.id)).reduce((sum, item) => sum + item.weight, 0);
  const totalWeight = selections.reduce((sum, item) => sum + item.weight, 0);
  const money = state?.cost ?? context.initial.cost;
  const walk = rows.filter(item => item.kind === 'walk').reduce((sum, item) => sum + finite(item.metres), 0);
  const sumMinutes = kind => rows.filter(item => item.kind === kind).reduce((sum, item) => sum + item.end - item.start, 0);
  const waitSources = [...new Set(rows.filter(item => item.kind === 'activity').map(item => item.waitSource).filter(Boolean))];
  diagnostics = { ...diagnostics, ...(context.settings[resolvedCrowd] ? {crowdEstimate:context.settings[resolvedCrowd]} : {}), waitSources, waitSource: waitSources.length ? waitSources.join(',') : diagnostics.waitSource };
  const omissions = selections.filter(item => !visited.has(item.id)).map(selection => quick ? {
    id: selection.id, name: context.map.get(selection.id).name, weight: selection.weight, required: selection.required, reason: '探索中のため、まだ採用されていません。',
  } : omissionFor(selection, context, state));
  return {
    status: state ? 'feasible' : 'no-plan', parkId: context.park.id, settings: copy({ ...context.settings, selections:context.portableSelections, history: [], historySampleCount: context.settings.history.length }),
    ...(context.historicalVisitBounds?{historicalVisitBounds:copy(context.historicalVisitBounds)}:{}),
    rows, visits: state?.visits || context.initial.visits, purchases: state?.purchases || context.initial.purchases,
    totals: {
      cost: money, foodCost: state?.foodCost ?? context.initial.foodCost,
      plannedDpaCount: state?.plannedDpaCount ?? context.initial.plannedDpaCount,
      dpaCost: state?.dpaCost ?? context.initial.dpaCost, shoppingCost: state?.shoppingCost ?? context.initial.shoppingCost,
      walkingMetres: walk, walkMinutes: sumMinutes('walk'), queueMinutes: sumMinutes('queue'),
      waitMinutes: sumMinutes('queue') + sumMinutes('wait'), restMinutes: sumMinutes('rest'),
      bufferMinutes: rows.filter(item => item.kind === 'queue').reduce((sum, item) => sum + finite(item.bufferMinutes), 0),
      delayMinutes: rows.filter(item => item.kind === 'queue').reduce((sum, item) => sum + finite(item.delayMinutes), 0),
      burdenMinutes: sumMinutes('walk') + sumMinutes('queue') + sumMinutes('wait'),
      score: weight, finish: rows.length ? rows[rows.length - 1].end : context.initial.time,
      visitCount: selections.filter(item => visited.has(item.id)).length,
      budgetRemaining: Math.max(0, context.settings.budget - money),
      souvenirAllocation: context.settings.souvenirMode === 'remainder' ? Math.max(0, context.settings.budget - money) :
        Math.max(0, finite(context.settings.souvenirReserve) - (state?.shoppingCost ?? context.initial.shoppingCost)),
    },
    coverage: {
      weight, totalWeight, percent: totalWeight ? Math.round(weight / totalWeight * 100) : 100,
      count: selections.length - omissions.length, totalCount: selections.length,
      requiredCount: selections.filter(item => item.required && visited.has(item.id)).length,
      requiredTotal: selections.filter(item => item.required).length,
    },
    omissions, diagnostics,
  };
}

/** Keep the strongest feasible incumbent across independent search strategies. */
function searchTracker(context, options, started) {
  let best = requiredMet(context.initial, context) && canFinish(context.initial, context) ? context.initial : null;
  let expanded = 0, lastProgress = started;
  const method = { beam: 'beam-search', multistart: 'multistart-local-search', portfolio: 'portfolio-search' }[context.settings.searchMethod];
  const diagnostics = running => ({ elapsedMs: Math.round(now() - started), expanded, method,
    optimal: false, timedOut: now() >= context.deadline, running,
    waitSource: context.settings.crowdMode === 'manual' ? 'manual' : context.settings.history.length ? 'history-or-trend' : 'trend' });
  return {
    accept(state) {
      expanded++;
      let complete = state;
      while (complete.breakIndex < context.settings.fixedBreaks.length) {
        const next = nextFixedBreak(complete, context);
        if (!next) break;
        complete = next;
      }
      complete = recoveryBeforeExit(complete, context);
      if (requiredMet(complete, context) && canFinish(complete, context) && (!best || compare(complete, best, context) < 0)) best = complete;
      if (now() - lastProgress >= 150) {
        const details = diagnostics(true), preview = best ? resultFrom(best, context, { ...details,
          notes: ['探索中に得られた実行可能な案です。探索を続けると採用内容が変わる場合があります。'] }, true) : null;
        options.onProgress?.({ elapsedMs: details.elapsedMs, bestScore: best?.score ?? 0, visits: best?.visits.length ?? 0, expanded, preview });
        lastProgress = now();
      }
    },
    get best() { return best; },
    diagnostics,
  };
}

/** Breadth-first search retains alternatives with different locations and purchases. */
function beamSearch(context, tracker, deadline) {
  let beam = [context.initial];
  const count = context.selected.length;
  const width = count <= 7 ? 12000 : count <= 15 ? 320 : 180;
  for (let depth = 0; depth < count + context.settings.fixedBreaks.length && beam.length; depth++) {
    const next = [];
    for (const state of beam) {
      if (now() >= deadline) return;
      const rest = nextFixedBreak(state, context);
      if (rest) { tracker.accept(rest); next.push(rest); }
      for (const selection of context.selected) {
        if (state.visited.has(selection.id) || !canStartVisit(selection.id,state.visited)) continue;
        if (now() >= deadline) return;
        for (const child of scheduledOptions(state, context.map.get(selection.id), selection, context)) {
          tracker.accept(child); next.push(child);
        }
      }
    }
    const grouped = new Map();
    for (const state of next) {
      const key = [...state.visited].sort().join('|') + ';' + state.node + ';' + state.breakIndex + ';' +
        state.purchases.map(purchase => purchase.id + ':' + purchase.start).join(',') + ';' + Number(!!state.restDeferred)
        + ';' + Number(state.lastVisitWasFood);
      const previous = grouped.get(key);
      const deferral = (state.restDeferralMinutes || 0) - (previous?.restDeferralMinutes || 0);
      if (!previous || deferral < 0 || (deferral === 0 &&
        (state.time < previous.time || (state.time === previous.time && compare(state, previous, context) < 0)))) grouped.set(key, state);
    }
    beam = [...grouped.values()].sort((a, b) => {
      const remaining = state => context.selected.filter(item => item.required && !state.visited.has(item.id)).length;
      return remaining(a) - remaining(b) || compare(a, b, context);
    }).slice(0, width);
  }
}

/** Fixed-seed pseudo-random choices make repeated comparisons reproducible. */
function randomGenerator() {
  let seed = 17012026;
  return () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
}

/** Replay a priority order; defer activities that fit only after the next fixed rest. */
function replayOrder(order, context, tracker, random, diversify = false) {
  let frontier = [context.initial], best = context.initial;
  for (let depth = 0; depth < order.length + context.settings.fixedBreaks.length && frontier.length; depth++) {
    if (now() >= context.deadline) break;
    const next = [];
    for (const state of frontier) {
      if (now() >= context.deadline) break;
      let choices = [];
      for (const selection of order) {
        if (state.visited.has(selection.id) || !canStartVisit(selection.id,state.visited)) continue;
        choices = scheduledOptions(state, context.map.get(selection.id), selection, context);
        if (choices.length) break;
      }
      if (!choices.length) { const fixed = nextFixedBreak(state, context); if (fixed) choices = [fixed]; }
      choices.sort((a, b) => a.time - b.time || compare(a, b, context));
      // Retain a bounded recovery and deferred alternative for this order.
      for (const deferred of [false,true]) {
        const group = choices.filter(choice => !!choice.restDeferred === deferred);
        if (!group.length) continue;
        const chosen = group[diversify && group.length > 1 && random() < .25 ? Math.floor(random() * Math.min(3,group.length)) : 0];
        tracker.accept(chosen); next.push(chosen);
        if (compare(chosen, best, context) < 0) best = chosen;
      }
    }
    frontier = [false,true].flatMap(deferred => next.filter(state => !!state.restDeferred === deferred)
      .sort((a,b) => (!deferred ? (a.restDeferralMinutes || 0) - (b.restDeferralMinutes || 0) : 0) ||
        a.time - b.time || compare(a,b,context)).slice(0,2));
  }
  return best;
}

/** Multiple greedy starts followed by order insertion and swap neighbourhoods. */
function multiStartSearch(context, tracker, deadline) {
  const random = randomGenerator(), count = context.selected.length;
  let order = context.selected.slice().sort((a, b) => Number(b.required) - Number(a.required) || b.weight - a.weight);
  const limit = Math.min(1600, Math.max(80, count * 60));
  let accepted = replayOrder(order, context, tracker, random);
  for (let attempt = 0; attempt < limit && now() < deadline; attempt++) {
    let candidate;
    if (attempt % 5 === 0) {
      candidate = context.selected.map(item => ({ item, value: random() + (item.required ? 2 : 0) + item.weight / 8 }))
        .sort((a, b) => b.value - a.value).map(row => row.item);
    } else {
      candidate = order.slice();
      const from = Math.floor(random() * count), to = Math.floor(random() * count);
      if (count && attempt % 2) [candidate[from], candidate[to]] = [candidate[to], candidate[from]];
      else if (count) candidate.splice(to, 0, candidate.splice(from, 1)[0]);
    }
    const result = replayOrder(candidate, context, tracker, random, attempt % 5 === 0);
    if (compare(result, accepted, context) <= 0 || attempt % 17 === 0) { order = candidate; accepted = result; }
  }
}

function replanSource(park, settings, previous) {
  if ((previous?.parkId && previous.parkId !== park.id) ||
      (previous?.settings?.date && previous.settings.date !== settings.date)) return null;
  return previous;
}

/** Time-bounded search over visits, admission methods, breaks and time windows. */
export function solveItinerary(park, rawSettings, options = {}) {
  const started = now();
  const replan = rawSettings?.replanFrom !== undefined && rawSettings.replanFrom !== '';
  const initialPlan = replanSource(park, rawSettings, options.initialPlan);
  let input = rawSettings;
  if (replan && rawSettings.purchases === undefined && initialPlan?.parkId === park.id &&
      initialPlan.settings?.date === rawSettings.date && initialPlan.purchases?.length) {
    const priorOwned = initialPlan.purchases.filter(purchase => purchase.owned);
    input = { ...rawSettings, purchases: priorOwned };
  }
  ({park, settings:input} = expandRepeatVisits(park,input,initialPlan));
  const settings = normalise(park, input), context = contextFor(park, settings, initialPlan);
  context.portableSelections=compactRepeatSelections(settings.selections,rawSettings.selections || []);
  const milliseconds = Math.min(settings.searchSeconds * 1000,
    options.deadlineMs === undefined ? Infinity : Math.max(1, Number(options.deadlineMs)));
  context.deadline = started + milliseconds;
  const tracker = searchTracker(context, options, started);
  tracker.accept(context.initial);
  if (settings.searchMethod === 'beam') beamSearch(context, tracker, context.deadline);
  else if (settings.searchMethod === 'multistart') multiStartSearch(context, tracker, context.deadline);
  else {
    // Both algorithms share a verified incumbent, with a reserved time slice for each.
    beamSearch(context, tracker, started + milliseconds * 0.55);
    multiStartSearch(context, tracker, context.deadline);
  }
  const diagnostics = tracker.diagnostics(false);
  delete diagnostics.running;
  diagnostics.notes = [
    ...(settings[intradayAdjustment] ? [describeIntradayAdjustment(settings[intradayAdjustment])] : []),
    '重要度の合計を優先し、同点では待ち時間・移動・待機の合計を短くする案を比べます。予算上限を守り、徒歩距離だけで訪問順を決めません。最適性の証明は行いません。',
    '待ち時間は手動指定、当日の新しい外部データ、検証で改善した学習モデル、履歴、傾向モデルの順に使います。施設ごとの出典は予定表に表示します。',
    '通常の待ち時間に計画用の余裕を加えます。自動設定は採用された学習モデルの検証MAEを5分単位に切り上げ、最大30分を目安にします。MAEは遅れを防ぐ保証ではありません。公演・DPAの集合時間は変えません。',
    ...(settings[resolvedCrowd] ? [settings[resolvedCrowd].source === 'model'
      ? `パーク全体の混雑は、${settings[resolvedCrowd].rides}施設の予測待ち時間を同じ施設・時間帯の過去平均と比べた目安です。`
      : 'パーク全体の混雑は、比較できる学習記録が足りないため曜日・祝日を目安にしています。'] : []),
    settings.walkCrowdMode==='estimate'?'移動時間は歩く速さに混雑の想定・時間帯・休日・天気・イベントの影響を加えた目安です。通路の距離は変えません。':'移動時間は設定した歩く速さと通路の距離から計算しています。',
    ...(settings.selections.some(item=>item.id==='sea-attraction-230')?[settings.gondolaAvoidHarbourShows?'ゴンドラは指定した休止枠と、日付を確認できたハーバーショーの上演中を避けます。前後の準備・再開時刻は当日の稼働状況で確認します。':'ゴンドラは指定した休止枠を避けます。ショー上演中を避ける目安は使用していません。']:[]),
    'DPAの購入案は入力した空き枠と購入履歴から計算しています。在庫は公式アプリで確認してください。',
  ];
  if (replan) for (const ticket of settings.purchases) {
    if (toMinutes(settings.replanFrom)>=ticket.end && !usedDpaWindow(context,ticket.id,ticket.start,ticket.end)) {
      const endTime=String(Math.floor(ticket.end/60)).padStart(2,'0')+':'+String(ticket.end%60).padStart(2,'0');
      diagnostics.notes.push(context.map.get(ticket.id).name+'の取得済みDPAは'+endTime+'で受付終了です。しおりにこの枠の利用記録はなく、購入額は支払済みとして保持します。');
    }
  }
  if (!tracker.best) diagnostics.notes.unshift('必須条件と追加した休憩をすべて満たす案は見つかりませんでした。指定した時刻・場所・予算を見直してください。実行不可能と証明した結果ではありません。');
  context.deadline = null;
  const result = resultFrom(tracker.best, context, diagnostics);
  if (tracker.best) {
    const verification = validatePlan(park, settings, result, {initialPlan});
    if (!verification.valid) throw new Error('予定の検証で問題が見つかりました：' + verification.errors.join(' / '));
  }
  options.onProgress?.({ elapsedMs: diagnostics.elapsedMs, bestScore: result.totals.score, visits: result.visits.length, expanded: diagnostics.expanded });
  return result;
}

/** Independently recompute chronological, geometric, window and money checks. */
export function validatePlan(park, settings, result, options = {}) {
  ({park,settings}=expandRepeatVisits(park,settings,options.initialPlan));
  const errors = [], graph = graphDistances(park), activities = new Map(park.activities.map(activity => [activity.id, activity]));
  const edgeLengths=new Map();
  for(const edge of park.edges){const from=edge.from??edge.a,to=edge.to??edge.b,metres=Number(edge.metres);for(const key of [from+'\0'+to,to+'\0'+from])edgeLengths.set(key,Math.min(edgeLengths.get(key)??Infinity,metres));}
  const selectionMap = new Map((settings.selections || []).map(item => [item.id, item]));
  const entry = toMinutes(settings.entry), exit = toMinutes(settings.exit), speed = Number(settings.speed ?? 65);
  const walkingSettings = {...settings};
  setWaitForecastContext(park, walkingSettings);
  const rows = result.rows || [];
  const cutoff=settings.replanFrom===undefined||settings.replanFrom===''?null:toMinutes(settings.replanFrom);
  const sourcePlan=replanSource(park,settings,options.initialPlan);
  const datedSource=sourcePlan?.settings?.date===settings.date&&(!sourcePlan.parkId||sourcePlan.parkId===park.id);
  const sourceRows=cutoff===null?[]:preservedPrefix(sourcePlan,settings,park);
  const sourceSignatures=new Set(sourceRows.map(rowSignature));
  if(sourcePlan || sourceRows.some(item=>item.userProgress)){
    // Every protected row appears once, in order, even when an optional visit
    // would otherwise be convenient for the remaining route to drop.
    const observed=rows.filter(r=>r.preserved && sourceSignatures.has(rowSignature(r)));
    if(rowSignature(observed)!==rowSignature(sourceRows)) errors.push('保持する予定が記録と一致しません。');
  }
  const reports=new Map(progressEntries(park,settings));
  const reportedDone=new Set(settings.completedIds||[]);
  for(const [id,f] of reports) {
    if(['done','riding','queue'].includes(f.status)) reportedDone.add(id);
    else reportedDone.delete(id);
  }
  const activityRowsSeen=new Set();
  const expectedBounds=historicalBounds(park,settings,sourcePlan);
  const originalEntry=expectedBounds.entry,originalExit=expectedBounds.exit;
  if(result.historicalVisitBounds!==undefined&&rowSignature(result.historicalVisitBounds)!==rowSignature(expectedBounds))errors.push('保持した予定の元の滞在時間が一致しません。');
  let previous = Math.min(entry,originalEntry), node = settings.replanFrom !== undefined && rows.some(item => item.preserved) ? park.entryNode : (settings.currentNode || park.entryNode);
  const visited = new Set(settings.completedIds || []);
  for(const [id,value] of reports){
    visited.delete(id);
    if(value.status==='done' && !sourceRows.some(item=>item.kind==='activity' && item.activityId===id)) visited.add(id);
  }
  let previousRow=null;
  let previousVisitWasFood=false;
  for (const item of rows) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < previous || item.end < item.start) errors.push('予定の時刻が前後しています。');
    const verifiedPreserved=item.preserved&&sourceSignatures.has(rowSignature(item));
    const historicalBoundary=verifiedPreserved&&datedSource;
    if (item.start < (historicalBoundary?originalEntry:entry) || item.end > (historicalBoundary?originalExit:exit)) errors.push('滞在時間の外に予定があります。');
    if (!item.preserved && cutoff!==null && item.start<cutoff) errors.push('再計画する時刻より前に新しい予定があります。');
    if(item.preserved && sourcePlan && !verifiedPreserved && item.kind!=='location')errors.push('保持した予定が元の記録と一致しません。');
    if(item.userProgress && !verifiedPreserved) errors.push('確認した体験と予定の内容が一致しません。');
    if (item.preserved) {
      const cutoff=settings.replanFrom === undefined || settings.replanFrom === '' ? null : toMinutes(settings.replanFrom);
      const ongoing=cutoff!==null&&(item.kind==='activity'||item.awaitingPerformance===true)&&rows.some(prior=>prior.preserved&&prior.kind==='queue'&&prior.activityId===item.activityId&&prior.start<cutoff);
      if(cutoff===null||(item.kind!=='location'&&item.start>=cutoff&&!ongoing&&!(verifiedPreserved&&item.userProgress)))errors.push('保持した予定が組み替え開始より前につながっていません。');
    }
    if (item.kind === 'walk') {
      if (item.from !== node) errors.push('移動の出発地点がつながっていません。');
      let distance = graph.distances[item.from]?.[item.to];
      const reference = verifiedPreserved;
      // Completed legs belong to the source plan's graph, never to a newly inferred route.
      if(reference)distance=Number(item.metres);
      if (!Number.isFinite(distance) || Math.abs(distance - Number(item.metres)) > 0.01) errors.push('移動距離が歩行経路と一致しません。');
      if(!item.preserved&&park.routeGraphVersion&&item.routeSource!==park.routeGraphVersion)errors.push('移動経路の版が地図と一致しません。');
      if(!item.preserved){
        const path=item.path;
        let pathLength=0;
        if(Array.isArray(path))for(let i=1;i<path.length;i++)pathLength+=edgeLengths.get(path[i-1]+'\0'+path[i])??Infinity;
        if(!Array.isArray(path)||path[0]!==item.from||path.at(-1)!==item.to||Math.abs(pathLength-distance)>.01)errors.push('徒歩ルートが通路上の最短経路と一致しません。');
      }
      const recordedSpeed=Number(item.walkSpeed);
      if(item.preserved&&(!Number.isFinite(recordedSpeed)||recordedSpeed<10||recordedSpeed>150))errors.push('保持した移動の元の歩く速さがありません。');
      const minimum=item.preserved?Math.ceil(distance/recordedSpeed*(item.walkingFactor??1)):walkingMinutes(distance,item.start,walkingSettings);
      if (item.end - item.start < minimum) errors.push('移動時間が不足しています。');
      if(!item.preserved&&item.walkingFactor!==undefined&&Math.abs(item.walkingFactor-walkingFactor(item.start,walkingSettings))>.001)errors.push('移動の混雑係数が設定と一致しません。');
      node = item.to;
    }
    if (item.kind === 'location') {
      if (!(verifiedPreserved && (item.progressAnchor || item.kind==='location')) && (!settings.currentNode || item.node !== settings.currentNode || settings.replanFrom === undefined || item.start < toMinutes(settings.replanFrom))) errors.push('現在地の確認地点が不正です。');
      node = item.node;
    }
    if (item.kind === 'rest' && item.node !== node) errors.push('休憩の場所までの移動がありません。');
    if(item.kind==='rest'&&!item.preserved&&item.autoBreakId){
      const afterSkipped=previousRow?.kind==='activity'&&previousRow.end===item.start&&(settings.skipAutoRestAfter||[]).includes(previousRow.activityId);
      if(afterSkipped||(settings.excludedAutoBreaks||[]).includes(item.autoBreakId))errors.push('外した自動休憩が予定に残っています。');
    }
    if (item.kind === 'activity') {
      if (!Number.isFinite(item.cost) || item.cost < 0 || item.cost % 100) errors.push('体験費用が不正です。');
      const activity = activities.get(item.activityId), selection = selectionMap.get(item.activityId);
      if (!activity) { errors.push('施設が見つかりません。'); continue; }
      if (!selection && !item.preserved) errors.push('希望していない体験が新しく予定されています。');
      const isFood = FOOD.has(verifiedPreserved ? (item.category ?? activity.category) : activity.category);
      if (settings.avoidConsecutiveFood && !verifiedPreserved && previousVisitWasFood && isFood) {
        errors.push('フードが連続しています。間に別の体験を入れてください。');
      }
      previousVisitWasFood = isFood;
      if (activityRowsSeen.has(activity.id) || (!item.preserved && reportedDone.has(activity.id))) errors.push('同じ体験が重複しています。');
      if (!canStartVisit(activity.id,visited)) errors.push('2回目の体験より前に1回目が必要です。');
      if(reports.get(activity.id)?.status==='skipped')errors.push('見送った体験が予定に残っています。');
      activityRowsSeen.add(activity.id);
      visited.add(activity.id);
      if (item.node !== (item.dpa ? (selection?.nodeOverride || activity.node) : activity.node)) errors.push('体験地点が施設の地点と一致しません。');
      if (item.node !== node) errors.push('施設までの移動がありません。');
      if (!item.preserved && !activityAvailable(activity, settings.date)) errors.push('休止日の施設が含まれています。');
      if(!item.preserved&&currentRideStatus(facilityForVisit(activity),settings,{now:settings.waitAsOf??Date.now()})?.isOpen===false)errors.push('現在停止中の施設が残りの予定に含まれています。');
      if (selection && !item.preserved) {
        if (selection.dpaMode==='owned' && !item.dpa) errors.push('取得済みDPAを指定した回の利用方法が違います。');
        if (item.end - item.start !== Number(selection.duration ?? activity.duration ?? 10)) errors.push('体験の所要時間が設定と一致しません。');
        if (selection.earliest !== undefined && item.start < toMinutes(selection.earliest)) errors.push('希望時間帯より前です。');
        if (selection.latest !== undefined && item.end > toMinutes(selection.latest)) errors.push('希望時間帯より後です。');
        const fixed = FIXED.has(activity.category);
        const timeSelection = activity.category === 'parade' && !item.dpa && selection.nodeOverride ? { ...selection, showTimes: selection.normalShowTimes } : selection;
        if (fixed && !showTimes(activity, timeSelection, settings).includes(item.start)) errors.push('開演時刻と一致しません。');
        const queue = rows.find(candidate => candidate.kind === 'queue' && candidate.activityId === item.activityId);
        const admission = queue?.start ?? item.start;
        // Fixed entertainment is forecast at its show time before its queue is placed backwards.
        const estimateAt = fixed ? item.start : admission;
        const estimate = item.dpa ? {minutes:Math.round(finite(activity.dpa.wait, 10)), source:'dpa'} : estimateWait(activity, estimateAt, walkingSettings, (settings.history || []).filter(record => (record.activityId || record.activity_id) === baseVisitId(activity.id)));
        const allowance = queueAllowance(activity, estimate, item.dpa ? 'dpa' : 'normal', settings);
        const venueWait=previousRow?.awaitingPerformance ? previousRow : null;
        if (venueWait && (!fixed || !item.dpa || venueWait.kind!=='wait' || venueWait.activityId!==activity.id ||
            venueWait.node!==item.node || venueWait.end!==item.start || venueWait.start!==queue?.end)) errors.push('DPA入場から開演までの待機が正しくありません。');
        if (queue?.bufferMinutes !== undefined || queue?.delayMinutes !== undefined || allowance.bufferMinutes || allowance.delayMinutes || venueWait) {
          if (!queue || queue.end !== (venueWait?.start ?? item.start) || queue.end - queue.start !== allowance.totalMinutes || queue.estimatedMinutes !== allowance.estimatedMinutes || queue.bufferMinutes !== allowance.bufferMinutes || queue.delayMinutes !== allowance.delayMinutes) errors.push('待ち時間と計画用の余裕が設定と一致しません。');
        }
        if (!activityWindows(activity, selection, settings, park).some(window => admission >= window[0] && item.end <= window[1])) errors.push('施設の営業時間の外です。');
        if (item.dpa) {
          if (!dpaAvailable(activity, settings.date)) errors.push('この日にはDPAを利用できません。');
          if (activity.category === 'parade' && (!selection.nodeOverride || !selection.showTimes?.length)) errors.push('パレードDPAの鑑賞地点・時刻が未確認です。');
          const owned = selection.dpaMode === 'owned';
          const ticket = (result.purchases || []).find(purchase => purchase.id === baseVisitId(item.activityId) &&
            purchase.owned === owned && purchase.start <= admission && admission < purchase.end);
          if (ticket && fixed && showTimes(activity,timeSelection,settings).some(time=>time>=ticket.start && time<item.start))
            errors.push('DPAの入場枠に対応する公演回と一致しません。');
          if (!ticket) errors.push('DPAの利用枠の外です。');
          else if (owned) {
            if (ticket.start !== toMinutes(selection.dpaStart) || ticket.end !== toMinutes(selection.dpaEnd) ||
                ticket.purchasedAt !== toMinutes(selection.dpaPurchasedAt)) errors.push('取得済みDPAの購入・利用時刻が設定と一致しません。');
          } else if (selection.dpaMode !== 'consider' || ticket.cost !== item.dpaCost ||
              !(selection.dpaAvailableWindows || []).some(([start, end]) => ticket.start === toMinutes(start) && ticket.end === toMinutes(end))) {
            errors.push('DPAの購入候補の枠または料金が設定と一致しません。');
          }
        } else if (!activityWindows(activity, selection, settings, park).some(window => admission >= window[0] && item.end <= window[1])) errors.push('施設の営業時間の外です。');
      }
      node = activity.endNode || item.node;
      if ((item.endNode || item.node) !== node) errors.push('体験後の地点が一致しません。');
    }
    if (item.kind === 'exit' && (item.node !== park.exitNode || node !== park.exitNode)) errors.push('出口に到着していません。');
    previous = item.end;previousRow=item;
  }
  if ([...visited].some(id=>!canStartVisit(id,visited))) errors.push('2回目の体験には1回目の完了記録が必要です。');
  for (const rest of restsBesideFood(rows, activities)) {
    if (rest.autoBreakId && !rest.preserved) errors.push('フードと自動休憩が連続しています。');
  }
  for (const reservation of settings.fixedBreaks || []) {
    const expectedStart = toMinutes(reservation.start), expectedEnd = expectedStart + Number(reservation.duration);
    const cutoff = settings.replanFrom === undefined || settings.replanFrom === '' ? entry : toMinutes(settings.replanFrom);
    const matches = rows.filter(item => item.fixedBreakId === reservation.id);
    if (expectedEnd <= cutoff && !matches.length) continue; // A past reservation need not be recreated.
    if (matches.length !== 1 || matches[0].kind !== 'rest' || matches[0].start !== expectedStart || matches[0].end !== expectedEnd || matches[0].node !== reservation.node) errors.push('追加した休憩の時刻・長さ・地点が一致しません。');
  }
  for (const item of rows.filter(item => item.fixedBreakId && !item.preserved)) if (!(settings.fixedBreaks || []).some(reservation => reservation.id === item.fixedBreakId)) errors.push('設定にない休憩が含まれています。');
  for (const selection of settings.selections || []) if ((selection.required || selection.dpaMode==='owned') && reports.get(selection.id)?.status!=='skipped' && !visited.has(selection.id)) errors.push('必須の希望がありません。');
  const purchased = result.purchases || [];
  for (const recorded of settings.purchases || []) {
    const recordedCost = recorded.cost ?? activities.get(recorded.id)?.dpa?.price;
    if (!purchased.some(ticket => ticket.id === recorded.id && ticket.owned && ticket.cost === recordedCost &&
        ticket.purchasedAt === toMinutes(recorded.purchasedAt ?? entry) &&
        ticket.start === toMinutes(recorded.start) && ticket.end === toMinutes(recorded.end))) {
      errors.push('支払済みDPAの時刻・料金が購入履歴と一致しません。');
    }
  }
  const admissions=dpaAdmissions(rows);
  for(const ticket of purchased) {
    if (ticket.id!==baseVisitId(ticket.id)) errors.push('DPA購入履歴の施設IDが不正です。');
    if ((admissions.get(ticket.id)||[]).filter(at=>at>=ticket.start && at<ticket.end).length>1)
      errors.push('同じDPAの利用枠を複数の体験に使用しています。');
  }
  const ownedCosts = purchased.filter(item => item.owned).reduce((sum, item) => sum + item.cost, 0);
  const prefix = rows.filter(item => item.kind === 'activity' && item.preserved);
  const prefixNonDpa = prefix.reduce((sum, item) => sum + Math.max(0, item.cost - finite(item.dpaCost)), 0);
  let prefixDpa = 0;
  for (const item of prefix.filter(row => row.dpa && row.dpaCost > 0)) {
    const admission = item.dpaAdmission ?? rows.find(row => row.kind === 'queue' && row.activityId === item.activityId)?.start ?? item.start;
    if (!purchased.some(ticket => ticket.owned && ticket.id === baseVisitId(item.activityId) && ticket.start <= admission && admission < ticket.end)) prefixDpa += item.dpaCost;
  }
  const baseSpent = Math.max(finite(settings.spentBudget), prefixNonDpa + prefixDpa + ownedCosts);
  const newCosts = rows.filter(item => item.kind === 'activity' && !item.preserved).reduce((sum, item) => sum + item.cost, 0);
  if (Math.abs(Number(result.totals?.cost) - baseSpent - newCosts) > 0.01) errors.push('合計費用が明細と一致しません。');
  if (Number(result.totals?.cost) > Number(settings.budget)) errors.push('予算を超えています。');
  for (const item of rows.filter(item => item.kind === 'activity' && !item.preserved)) {
    const selection = selectionMap.get(item.activityId), activity = activities.get(item.activityId);
    if (selection && activity) {
      const cost = ceil100(finite(selection.cost, activity.cost || 0));
      const dpaCost = item.dpa && selection.dpaMode !== 'owned' ? ceil100(activity.dpa?.price || 0) : 0;
      if (item.cost !== cost + dpaCost || finite(item.dpaCost) !== dpaCost) errors.push('体験費用と設定価格が一致しません。');
      if (!accessAllowed(activity, selection, item.dpa ? 'dpa' : 'normal')) errors.push('利用条件の確認がありません。');
    }
  }
  const foodCost = rows.filter(item => item.kind === 'activity' && FOOD.has(item.category)).reduce((sum, item) => sum + item.cost - finite(item.dpaCost), 0);
  const proposed = purchased.filter(ticket => !ticket.owned);
  const dpaCost = prefixDpa + ownedCosts + proposed.reduce((sum, item) => sum + item.cost, 0);
  const previousCount = sourceRows.filter(row => row.kind === 'activity' && row.dpa && (row.dpaCost > 0 || row.plannedDpaPurchase)).length;
  const newVisits = rows.filter(row => row.kind === 'activity' && !row.preserved && row.dpa && selectionMap.get(row.activityId)?.dpaMode === 'consider');
  if (newVisits.length !== proposed.length || proposed.some(ticket => !newVisits.some(row => baseVisitId(row.activityId) === ticket.id))) errors.push('DPA購入候補の件数が明細と一致しません。');
  const plannedCount = previousCount + newVisits.length;
  if (result.totals?.plannedDpaCount !== undefined && result.totals.plannedDpaCount !== plannedCount) errors.push('DPA購入候補の合計件数が明細と一致しません。');
  if (settings.dpaPurchaseLimit !== undefined && newVisits.length > Math.max(0, settings.dpaPurchaseLimit - previousCount)) errors.push('DPAの購入件数の上限を超えています。');
  if (settings.foodBudget !== undefined && foodCost > settings.foodBudget) errors.push('食費の上限を超えています。');
  if (settings.dpaBudget !== undefined && dpaCost > settings.dpaBudget) errors.push('DPA予算の上限を超えています。');
  const shopCost = rows.filter(item => item.kind === 'activity' && item.category === 'shop').reduce((sum, item) => sum + item.cost, 0);
  if (result.totals.cost + Math.max(0, finite(settings.souvenirReserve) - shopCost) > settings.budget) errors.push('お土産の確保額を含めると予算を超えます。');
  for (const kind of ['attraction', 'show']) {
    const purchases = (result.purchases || []).filter(item => item.kind === kind).sort((a, b) => a.purchasedAt - b.purchasedAt);
    for (let i = 0; i < purchases.length; i++) {
      const purchase = purchases[i];
      if (!Number.isFinite(purchase.cost) || purchase.cost < 0 || purchase.cost % 100) errors.push('DPAの費用が不正です。');
      if (purchase.kind !== (activities.get(purchase.id)?.dpa?.kind || 'attraction')) errors.push('DPA購入の種別が不正です。');
      if (!purchase.owned && settings.replanFrom !== undefined && purchase.purchasedAt < toMinutes(settings.replanFrom)) errors.push('組み替える時刻より前に新規購入しています。');
      if (purchase.purchasedAt < entry || purchase.purchasedAt > purchase.start) errors.push('DPAの購入時刻が不正です。');
      if (i) {
        const prior = purchases[i - 1], threshold = prior.id === purchase.id ? prior.end : Math.min(prior.purchasedAt + 60, prior.start);
        if (purchase.purchasedAt < threshold) errors.push('DPAの次回購入可能時刻より前です。');
      }
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
