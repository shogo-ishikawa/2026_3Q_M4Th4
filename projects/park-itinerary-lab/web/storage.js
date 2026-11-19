import {validateWaitModel} from './wait-model.js?v=2.5.0';
import {weatherForMinute,formatWeatherDetails} from './weather.js?v=2.5.0';
import {baseVisitId, isRepeatVisit} from './repeat-visits.js';
import {forecastCardHtml,forecastSourcesHtml} from './weather-view.js?v=2.5.0';
/** Portable schedules: the shared link contains preferences, never a browser's saved history. */
const STORAGE_KEY = 'park-itinerary-lab:v1';
const PLANS_KEY = 'park-itinerary-lab:plans:v1';
const LEGACY_PLAN_ID = 'legacy-v1';
export const MAX_SAVED_PLANS = 20;
const MAX_SHARED_LENGTH = 14000;
const MAX_FILE_LENGTH = 4_000_000;
const MAX_ACTIVITIES = 400;
const MAX_VISITS = MAX_ACTIVITIES * 2;
const CATEGORIES = new Set(['attraction', 'show', 'parade', 'restaurant', 'cafe', 'snack', 'popcorn', 'greeting', 'shop']);
const ROW_TYPES = new Set(['walk', 'wait', 'queue', 'activity', 'rest', 'exit', 'location']);

const fail = message => { throw new TypeError(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const integer = (value, min, max) => Number.isInteger(value) && finite(value, min, max);
const text = (value, max = 300) => typeof value === 'string' && value.length <= max;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(value);
// A second visit is an itinerary occurrence; the catalogue and provider IDs remain unchanged.
const visitId = value => id(baseVisitId(value));
const optionalNumber = (object, key, min, max, whole = false) => object[key] === undefined || (whole ? integer : finite)(object[key], min, max);
const validTime = value => integer(value, 0, 1440);
const validWindow = pair => Array.isArray(pair) && pair.length === 2 && validTime(pair[0]) && validTime(pair[1]) && pair[0] < pair[1];
const autoBreakId = value => typeof value==='string' && value.length<=222 && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*:[a-zA-Z0-9_.:-]+(?:~2)?$/.test(value);

function safeTree(value, depth = 0) {
  if (depth > 16) fail('データの入れ子が深すぎます。');
  if (Array.isArray(value)) {
    if (value.length > 50000) fail('データの件数が多すぎます。');
    value.forEach(item => safeTree(item, depth + 1));
  } else if (value && typeof value === 'object') {
    if (!plain(value)) fail('データの形式を確認してください。');
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('このキーはデータに使えません。');
      safeTree(item, depth + 1);
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) fail('数値は有限の値で指定してください。');
  else if (!['string', 'number', 'boolean', 'undefined'].includes(typeof value) && value !== null) fail('保存できない値があります。');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const validTimestamp = value => text(value, 80) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
function webUrl(value) {
  if (!text(value, 2000)) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

/** Validate an imported catalogue before it can replace the current park data. */
export function validateCatalogue(data) {
  safeTree(data);
  if (!plain(data) || !text(data.version, 40) || !validDate(data.updatedAt) || !Array.isArray(data.parks) || data.parks.length !== 2) fail('カタログの版・確認日・2パークの情報を確認してください。');
  if (data.sources !== undefined && (!Array.isArray(data.sources) || data.sources.some(source => !plain(source) || !text(source.label) || !webUrl(source.url)))) fail('出典の名前とURLを確認してください。');
  const parkIds = new Set();
  for (const park of data.parks) {
    if (!plain(park) || !['land', 'sea'].includes(park.id) || parkIds.has(park.id) || !text(park.name) || !webUrl(park.officialUrl) || !webUrl(park.mapUrl)) fail('パーク名または公式ページのURLを確認してください。');
    parkIds.add(park.id);
    if(park.routeGraphVersion!==undefined&&!id(park.routeGraphVersion))fail('歩行地図の版を確認してください。');
    if (!Array.isArray(park.nodes) || park.nodes.length < 2 || park.nodes.length > 1000 || !Array.isArray(park.edges) || park.edges.length > 4000 || !Array.isArray(park.activities) || park.activities.length > MAX_ACTIVITIES) fail('地点・通路・施設の件数を確認してください。');
    const nodes = new Set();
    for (const node of park.nodes) {
      if (!plain(node) || !id(node.id) || nodes.has(node.id) || !finite(node.x, 0, 1000) || !finite(node.y, 0, 1000) || (node.lat !== null && !optionalNumber(node, 'lat', -90, 90)) || (node.lon !== null && !optionalNumber(node, 'lon', -180, 180))) fail('地図の地点IDと座標を確認してください。');
      nodes.add(node.id);
    }
    if (!nodes.has(park.entryNode) || !nodes.has(park.exitNode)) fail('入園・退園地点を通路の地点として登録してください。');
    const adjacency = new Map([...nodes].map(key => [key, []]));
    for (const edge of park.edges) {
      if (!plain(edge) || !nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to || !finite(edge.metres, 0.01, 10000)) fail('通路の地点と徒歩距離を確認してください。');
      if(edge.geometry!==undefined&&(!Array.isArray(edge.geometry)||edge.geometry.length<2||edge.geometry.length>10000||edge.geometry.some(point=>!Array.isArray(point)||point.length!==2||!finite(point[0],0,1000)||!finite(point[1],0,1000))))fail('通路の形状を確認してください。');
      adjacency.get(edge.from).push(edge.to); adjacency.get(edge.to).push(edge.from);
    }
    const reachable = new Set([park.entryNode]), queue = [park.entryNode];
    for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i])) if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
    if (reachable.size !== nodes.size) fail('すべての地点を入口からつながる通路で結んでください。');
    const activities = new Set();
    for (const activity of park.activities) {
      if (!plain(activity) || !id(activity.id) || activities.has(activity.id) || !text(activity.name) || !CATEGORIES.has(activity.category) || !nodes.has(activity.node) || !integer(activity.duration, 1, 600) || !finite(activity.baseWait, 0, 600) || !integer(activity.cost, 0, 1000000) || !webUrl(activity.sourceUrl)) fail('施設のID・種類・地点・時間・費用・出典を確認してください。');
      activities.add(activity.id);
      for (const key of ['menuUrl','menuSourceUrl']) if (activity[key] !== undefined && !webUrl(activity[key])) fail('店舗・メニューのリンクを確認してください。');
      if (activity.menuItems !== undefined && (!Array.isArray(activity.menuItems) || activity.menuItems.length > 20 || activity.menuItems.some(item => !plain(item) || !text(item.name,300) || (item.url !== undefined && !webUrl(item.url))))) fail('メニューの名前とリンクを確認してください。');
      if (activity.dailySchedules !== undefined) {
        if (!plain(activity.dailySchedules) || Object.keys(activity.dailySchedules).length > 400) fail('施設の日付別営業時間を確認してください。');
        for (const [date,schedule] of Object.entries(activity.dailySchedules)) {
          if (!validDate(date) || !plain(schedule) || typeof schedule.closed !== 'boolean' || (schedule.sourceUrl !== undefined && !webUrl(schedule.sourceUrl))) fail('施設の日付別の運営情報を確認してください。');
          if (schedule.windows !== undefined && (!Array.isArray(schedule.windows) || schedule.windows.length > 30 || schedule.windows.some(pair=>!validWindow(pair)))) fail('日付別の営業時間を確認してください。');
          if (schedule.pauseWindows!==undefined&&(!Array.isArray(schedule.pauseWindows)||schedule.pauseWindows.length>50||schedule.pauseWindows.some(pair=>!validWindow(pair))))fail('日付別の休止時間を確認してください。');
          if (schedule.showTimes !== undefined && (!Array.isArray(schedule.showTimes) || schedule.showTimes.length > 30 || schedule.showTimes.some(value=>!validTime(value)))) fail('日付別の公演時刻を確認してください。');
        }
      }
      if (activity.closedPeriods !== undefined && (!Array.isArray(activity.closedPeriods) || activity.closedPeriods.length > 100 || activity.closedPeriods.some(period => !plain(period) || !validDate(period.startDate) || (period.endDate !== null && period.endDate !== undefined && (!validDate(period.endDate) || period.endDate < period.startDate)) || (period.sourceUrl !== undefined && !webUrl(period.sourceUrl))))) fail('施設の休止期間を確認してください。');
      if (activity.endNode !== undefined && !nodes.has(activity.endNode)) fail('移動施設の降車地点を確認してください。');
      if (!Array.isArray(activity.windows) || activity.windows.length === 0 || activity.windows.length > 30 || activity.windows.some(pair => !validWindow(pair))) fail('施設の利用時間帯を確認してください。');
      if (activity.showTimes !== undefined && (!Array.isArray(activity.showTimes) || activity.showTimes.length > 30 || activity.showTimes.some(value => !validTime(value)))) fail('公演時刻を0時からの整数分で指定してください。');
      if (activity.showTimesDate !== undefined && !validDate(activity.showTimesDate)) fail('公演時刻の確認日を確認してください。');
      if (activity.dpa !== undefined && activity.dpa !== null) {
        const dpa = activity.dpa;
        if (!plain(dpa) || !integer(dpa.price, 0, 100000) || dpa.price % 100 !== 0 || !integer(dpa.wait, 0, 180) || !['attraction', 'show'].includes(dpa.kind)) fail('DPAの料金・待ち時間・種類を確認してください。');
      }
      if (activity.access !== undefined && !['normal', 'entry', 'reservation'].includes(activity.access)) fail('施設の受付方法を確認してください。');
    }
    if (park.events !== undefined && (!Array.isArray(park.events) || park.events.some(event => !plain(event) || !id(event.id) || !text(event.name) || !validDate(event.startDate) || !validDate(event.endDate) || event.startDate > event.endDate || !finite(event.multiplier, 0.1, 5) || !webUrl(event.sourceUrl)))) fail('イベントの期間と出典を確認してください。');
  }
  return data;
}

function validateDayProgress(progress, parkId, date) {
  if (progress === undefined) return;
  if (!plain(progress) || progress.parkId !== parkId || progress.date !== date ||
      !plain(progress.visits) || Object.keys(progress.visits).length > MAX_VISITS) {
    fail('当日の体験記録のパーク・日付・件数を確認してください。');
  }
  let activeVisits = 0;
  const otherPark = parkId === 'land' ? 'sea-' : 'land-';
  for (const [key, visit] of Object.entries(progress.visits)) {
    if (!visitId(key) || key.startsWith(otherPark) || !plain(visit) ||
        !['pending', 'queue', 'riding', 'done', 'skipped'].includes(visit.status)) {
      fail('当日の施設と体験状況を確認してください。');
    }
    if (!optionalNumber(visit, 'startedAt', 0, 1440, true) || !optionalNumber(visit, 'endsAt', 0, 1440, true) ||
        (visit.startedAt !== undefined && visit.endsAt !== undefined && visit.endsAt < visit.startedAt)) {
      fail('当日の体験記録の時刻を確認してください。');
    }
    if (visit.reportedAt !== undefined && (visit.status !== 'done' || !validTime(visit.reportedAt) ||
        (visit.endsAt ?? visit.startedAt ?? 0) > visit.reportedAt)) {
      fail('体験済みを確認した時刻を確認してください。');
    }
    if (visit.status === 'queue' || visit.status === 'riding') {
      activeVisits++;
      if (!validTime(visit.endsAt) || visit.endsAt <= (visit.startedAt ?? -1)) fail('進行中の体験の終了見込みを確認してください。');
    }
  }
  if (activeVisits > 1) fail('同時に進行中にできる体験は1回です。');
}

/** Check portable settings independently of the optimiser. */
export function validateSavedState(state) {
  safeTree(state);
  if (!plain(state) || !['land', 'sea'].includes(state.parkId) || !plain(state.settings)) fail('保存データのパークと条件を確認してください。');
  const settings = state.settings;
  if (!validDate(settings.date) || !validTime(settings.entry) || !validTime(settings.exit) || settings.entry >= settings.exit || !finite(settings.speed, 10, 150) || !integer(settings.budget, 0, 10000000) || settings.budget % 100 !== 0) fail('日付・入退園時刻・歩く速さ・100円単位の予算を確認してください。');
  if (settings.avoidConsecutiveFood !== undefined && typeof settings.avoidConsecutiveFood !== 'boolean') fail('フードを連続して入れない設定を確認してください。');
  if (!optionalNumber(settings, 'dpaPurchaseLimit', 0, 200, true)) fail('DPAの購入件数の上限は0〜200の整数で指定してください。');
  for (const key of ['foodBudget', 'dpaBudget', 'souvenirReserve', 'spentBudget']) if (!optionalNumber(settings, key, 0, 10000000, true) || (settings[key] !== undefined && settings[key] % 100 !== 0)) fail('費用は100円単位の整数で指定してください。');
  for (const key of ['restEvery', 'restMinutes']) if (!optionalNumber(settings, key, 0, 600, true)) fail('休憩の間隔と長さを確認してください。');
  if (!optionalNumber(settings, 'waitBufferMinutes', 0, 30, true) || !optionalNumber(settings, 'queueDelayMinutes', 0, 60, true) || (settings.waitBufferMode !== undefined && !['fixed','auto'].includes(settings.waitBufferMode))) fail('待ち時間の余裕と混雑の想定を確認してください。');
  if (!optionalNumber(settings, 'searchSeconds', 0.1, 120) || !optionalNumber(settings, 'replanFrom', settings.entry, settings.exit, true)) fail('探索時間と組み替え開始時刻を確認してください。');
  if (settings.searchMethod !== undefined && !['beam', 'multistart', 'portfolio'].includes(settings.searchMethod)) fail('探索方法を選び直してください。');
  if (settings.weatherMode !== undefined && !['auto', 'manual'].includes(settings.weatherMode)) fail('天気の取得方法を選び直してください。');
  if (settings.weatherNotice !== undefined && !text(settings.weatherNotice, 1000)) fail('天気の取得結果を確認してください。');
  if (settings.liveNotice !== undefined && !text(settings.liveNotice,1500)) fail('当日の情報の取得結果を確認してください。');
  if (settings.visitTimeLinked !== undefined && typeof settings.visitTimeLinked !== 'boolean') fail('入退園時刻の連動設定を確認してください。');
  if(settings.gondolaAvoidHarbourShows!==undefined&&typeof settings.gondolaAvoidHarbourShows!=='boolean')fail('ゴンドラのショー時間の設定を確認してください。');
  if (settings.walkCrowdMode !== undefined && !['estimate','off'].includes(settings.walkCrowdMode)) fail('混雑による移動時間の設定を確認してください。');
  if (settings.waitAsOf !== undefined && !integer(settings.waitAsOf,0,253402300799999)) fail('待ち時間を確認した時刻を確認してください。');
  if (settings.excludedAutoBreaks !== undefined && (!Array.isArray(settings.excludedAutoBreaks)||settings.excludedAutoBreaks.length>60||new Set(settings.excludedAutoBreaks).size!==settings.excludedAutoBreaks.length||settings.excludedAutoBreaks.some(value=>!autoBreakId(value)))) fail('取り除いた自動休憩の一覧を確認してください。');
  if(settings.skipAutoRestAfter!==undefined&&(!Array.isArray(settings.skipAutoRestAfter)||settings.skipAutoRestAfter.length>MAX_VISITS||new Set(settings.skipAutoRestAfter).size!==settings.skipAutoRestAfter.length||settings.skipAutoRestAfter.some(value=>!visitId(value))))fail('見送った自動休憩の施設を確認してください。');
  if (settings.operationalHolds!==undefined&&settings.operationalHolds!==null) {
    const holds=settings.operationalHolds,today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
    if(!plain(holds)||!validDate(holds.date)||holds.date!==settings.date||holds.date>today||!validTimestamp(holds.observedAt)||Date.parse(holds.observedAt)>Date.now()+60000||new Date(Date.parse(holds.observedAt)+9*3600000).toISOString().slice(0,10)!==holds.date||!Array.isArray(holds.activityIds)||holds.activityIds.length>MAX_ACTIVITIES||new Set(holds.activityIds).size!==holds.activityIds.length||holds.activityIds.some(value=>!id(value)||!value.startsWith(state.parkId+'-')))fail('運営停止の記録の日付・パーク・確認時刻を確認してください。');
  }
  if (settings.weatherForecast !== undefined && settings.weatherForecast !== null) {
    const forecast = settings.weatherForecast;
    if (!plain(forecast) || !validDate(forecast.date) || !['sun','cloud','rain'].includes(forecast.weather) || !Array.isArray(forecast.hours) || forecast.hours.length > 400) fail('天気予報の日付と時間帯を確認してください。');
    for(const key of ['temperatureMin','temperatureMax'])if(forecast[key]!==undefined&&forecast[key]!==null&&!finite(forecast[key],-90,70))fail('日別の気温を確認してください。');
    if(Number.isFinite(forecast.temperatureMin)&&Number.isFinite(forecast.temperatureMax)&&forecast.temperatureMin>forecast.temperatureMax)fail('日別の気温の範囲を確認してください。');
    if(forecast.precipitationProbability!==undefined&&forecast.precipitationProbability!==null&&!finite(forecast.precipitationProbability,0,100))fail('日別の降水確率を確認してください。');
    if(forecast.provider!==undefined&&!['open-meteo','jma'].includes(forecast.provider))fail('天気予報の出典を確認してください。');
    if(forecast.sourceUrl!==undefined&&!webUrl(forecast.sourceUrl))fail('天気予報の出典URLを確認してください。');
    for(const key of ['issuedAt','fetchedAt'])if(forecast[key]!==undefined&&!validTimestamp(forecast[key]))fail('天気予報の日時を確認してください。');
    for (const hour of forecast.hours) {
      if (!plain(hour) || !integer(hour.minute,0,1439) || !['sun','cloud','rain'].includes(hour.weather)) fail('時間帯別の天気を確認してください。');
      if(hour.endMinute!==undefined&&(!integer(hour.endMinute,1,1440)||hour.endMinute<=hour.minute))fail('天気予報の対象時間を確認してください。');
      for(const key of ['label','weatherPeriodLabel','temperaturePeriodLabel','probabilityPeriodLabel','precipitationPeriodLabel'])if(hour[key]!==undefined&&!text(hour[key],300))fail('天気予報の説明を確認してください。');
      if(Number.isFinite(hour.temperatureMin)&&Number.isFinite(hour.temperatureMax)&&hour.temperatureMin>hour.temperatureMax)fail('時間帯別の気温の範囲を確認してください。');
      for (const [key,min,max] of [['temperature',-90,70],['temperatureMin',-90,70],['temperatureMax',-90,70],['precipitation',0,500],['precipitationProbability',0,100]]) if (hour[key] !== undefined && hour[key] !== null && !finite(hour[key],min,max)) fail('気温と雨の予報値を確認してください。');
    }
  }
  if (settings.calendarData !== undefined && settings.calendarData !== null) {
    const calendar = settings.calendarData;
    if (!plain(calendar) || calendar.schemaVersion !== 1 || !webUrl(calendar.sourceUrl) || !plain(calendar.coverage) || !validDate(calendar.coverage.startDate) || !validDate(calendar.coverage.endDate) || calendar.coverage.startDate > calendar.coverage.endDate || !Array.isArray(calendar.holidays) || calendar.holidays.length > 3000) fail('祝日カレンダーの期間と出典を確認してください。');
    const dates = new Set();
    for (const holiday of calendar.holidays) {
      if (!plain(holiday) || !validDate(holiday.date) || !text(holiday.name,100) || dates.has(holiday.date)) fail('祝日の日付と名前を確認してください。');
      dates.add(holiday.date);
    }
  }
  if (settings.liveMode !== undefined && !['auto', 'off'].includes(settings.liveMode)) fail('当日の待ち時間の利用方法を選び直してください。');
  if (settings.liveData !== undefined && settings.liveData !== null) {
    const live = settings.liveData;
    if (!plain(live) || live.schemaVersion !== 1 || live.parkId !== state.parkId || !['queue-times','themeparks-wiki'].includes(live.provider) || !validTimestamp(live.fetchedAt) || !Array.isArray(live.rides) || live.rides.length > MAX_ACTIVITIES || !Array.isArray(live.unmatched) || live.unmatched.length > MAX_ACTIVITIES) fail('当日の待ち時間データの形式と取得時刻を確認してください。');
    const rideIds = new Set();
    for (const ride of live.rides) {
      if (!plain(ride) || !id(ride.activityId) || rideIds.has(ride.activityId) || !integer(ride.providerId, 0, 2147483647) || !text(ride.name) || !(finite(ride.wait, 0, 600)||(live.provider==='themeparks-wiki'&&ride.wait===null)) || typeof ride.isOpen !== 'boolean' || !validTimestamp(ride.updatedAt)) fail('取得した施設名・待ち時間・更新時刻を確認してください。');
      if ((ride.changedAt!==undefined&&!validTimestamp(ride.changedAt))||(ride.status!==undefined&&!['OPERATING','DOWN','CLOSED','REFURBISHMENT'].includes(ride.status))) fail('取得した施設の稼働状況と変更時刻を確認してください。');
      rideIds.add(ride.activityId);
    }
    if (live.unmatched.some(ride => !plain(ride) || !integer(ride.providerId, 0, 2147483647) || !text(ride.name))) fail('施設を対応付けられなかった待ち時間データを確認してください。');
  }
  if (settings.waitModel !== undefined && settings.waitModel !== null) {
    const model = settings.waitModel;
    if (!validateWaitModel(model) || !plain(model) || ![1, 2].includes(model.schemaVersion) || model.method !== 'ridge-regression' || model.parkId !== state.parkId || !['trained', 'insufficient-data'].includes(model.status) || typeof model.usable !== 'boolean' || !Array.isArray(model.activityIds) || model.activityIds.length > MAX_ACTIVITIES || new Set(model.activityIds).size !== model.activityIds.length || model.activityIds.some(value => !id(value)) || !Array.isArray(model.coefficients) || model.coefficients.length > MAX_ACTIVITIES + 100 || model.coefficients.some(value => !finite(value, -Number.MAX_VALUE, Number.MAX_VALUE))) fail('待ち時間の予測モデルの形式を確認してください。');
    if (!integer(model.samples, 0, Number.MAX_SAFE_INTEGER) || !optionalNumber(model,'availableSamples',model.samples,Number.MAX_SAFE_INTEGER,true) || !integer(model.days, 0, 100000) || !validTimestamp(model.trainedAt) || !validDate(model.beforeDate)) fail('予測モデルの学習期間と件数を確認してください。');
    if (model.status === 'trained' && (model.coefficients.length !== model.activityIds.length + (model.schemaVersion === 2 ? model.featureNames.length : 7) || !validDate(model.firstDate) || !validDate(model.lastDate))) fail('学習済みモデルの係数と対象期間を確認してください。');
  }
  if (settings.fixedBreaks !== undefined) {
    if (!Array.isArray(settings.fixedBreaks) || settings.fixedBreaks.length > 30) fail('指定する休憩は30件までにしてください。');
    const breakIds = new Set();
    for (const rest of settings.fixedBreaks) {
      if (!plain(rest) || !id(rest.id) || breakIds.has(rest.id) || !id(rest.node) || !text(rest.label, 100) || !validTime(rest.start) || !integer(rest.duration, 1, 180) || rest.start + rest.duration > 1440) fail('休憩のID・地点・名前・開始時刻・長さを確認してください。');
      breakIds.add(rest.id);
    }
  }
  for (const [key, options] of Object.entries({crowdMode:['estimate', 'manual'], crowdLevel:['auto', 'quiet', 'normal', 'busy'], weather:['sun', 'cloud', 'rain'], budgetPreference:['balanced', 'food', 'dpa']})) if (settings[key] !== undefined && !options.includes(settings[key])) fail('混雑や予算の条件を選び直してください。');
  if (!Array.isArray(settings.selections) || settings.selections.length > MAX_ACTIVITIES) fail('希望の一覧を確認してください。');
  const ids = new Set();
  for (const selection of settings.selections) {
    if (!plain(selection) || !id(selection.id) || ids.has(selection.id) || !integer(selection.weight, 1, 5)) fail('希望のIDと重要度1〜5を確認してください。');
    if (!optionalNumber(selection, 'repeatCount', 1, 2, true)) fail('希望する体験回数は1回または2回で指定してください。');
    if (!optionalNumber(selection, 'dpaVisit', 1, selection.repeatCount ?? 1, true)) fail('DPAを使う回は希望する体験回数の中から選んでください。');
    ids.add(selection.id);
    if (selection.nodeOverride !== undefined && !id(selection.nodeOverride)) fail('鑑賞・集合地点のIDを確認してください。');
    for (const key of ['earliest', 'latest', 'dpaStart', 'dpaEnd', 'dpaPurchasedAt']) if (!optionalNumber(selection, key, 0, 1440, true)) fail('希望する時間帯を確認してください。');
    if (selection.earliest !== undefined && selection.latest !== undefined && selection.earliest >= selection.latest) fail('希望時間帯の終了を開始より後にしてください。');
    if (selection.dpaStart !== undefined && selection.dpaEnd !== undefined && selection.dpaStart >= selection.dpaEnd) fail('DPA枠の終了を開始より後にしてください。');
    for (const key of ['duration', 'manualWait']) if (!optionalNumber(selection, key, key === 'duration' ? 1 : 0, 600, true)) fail('所要時間と待ち時間を確認してください。');
    if (!optionalNumber(selection, 'cost', 0, 1000000, true) || (selection.cost !== undefined && selection.cost % 100 !== 0)) fail('施設の予算は100円単位で指定してください。');
    for (const key of ['required', 'confirmedAccess', 'timeWindowLinked', 'dpaWindowLinked']) if (selection[key] !== undefined && typeof selection[key] !== 'boolean') fail('希望の確認欄の形式を確認してください。');
    if (selection.dpaMode !== undefined && !['none', 'consider', 'owned', 'unavailable'].includes(selection.dpaMode)) fail('DPAの希望を選び直してください。');
    if (selection.showTimes !== undefined && (!Array.isArray(selection.showTimes) || selection.showTimes.length > 30 || selection.showTimes.some(value => !validTime(value)))) fail('公演時刻を確認してください。');
    if(selection.pauseWindows!==undefined&&(!Array.isArray(selection.pauseWindows)||selection.pauseWindows.length>50||selection.pauseWindows.some(pair=>!validWindow(pair))))fail('指定した休止時間を確認してください。');
    if (selection.dpaAvailableWindows !== undefined && (!Array.isArray(selection.dpaAvailableWindows) || selection.dpaAvailableWindows.length > 30 || selection.dpaAvailableWindows.some(value => !validWindow(value)))) fail('DPAの販売枠を確認してください。');
  }
  if (settings.currentNode !== undefined && !id(settings.currentNode)) fail('現在地の地点を確認してください。');
  if (settings.completedIds !== undefined && (!Array.isArray(settings.completedIds) || settings.completedIds.length > MAX_VISITS || settings.completedIds.some(value => !visitId(value)))) fail('体験済みの施設を確認してください。');
  validateDayProgress(settings.dayProgress, state.parkId, settings.date);
  if (settings.purchases !== undefined) {
    if (!Array.isArray(settings.purchases) || settings.purchases.length > MAX_ACTIVITIES || settings.purchases.some(item => !plain(item) || !id(item.id) || !['attraction', 'show'].includes(item.kind) || !validTime(item.purchasedAt) || !validTime(item.start) || !validTime(item.end) || item.start >= item.end || !integer(item.cost, 0, 1000000) || item.cost % 100 !== 0)) fail('購入済みDPAの時刻と費用を確認してください。');
    if (new Set(settings.purchases.map(ticket=>ticket.id)).size !== settings.purchases.length) fail('同じ施設の購入済みDPAが重複しています。');
  }
  if (state.result !== undefined && state.result !== null) {
    if (!plain(state.result) || !Array.isArray(state.result.rows) || state.result.rows.length > 5000) fail('予定表の行を確認してください。');
    if (state.result.settings?.dayProgress !== undefined) validateDayProgress(state.result.settings.dayProgress, state.parkId, state.result.settings.date);
    if(state.result.historicalVisitBounds!==undefined){const bounds=state.result.historicalVisitBounds;if(!plain(bounds)||bounds.parkId!==state.parkId||!validDate(bounds.date)||!validTime(bounds.entry)||!validTime(bounds.exit)||bounds.entry>=bounds.exit||(state.result.settings?.date!==undefined&&bounds.date!==state.result.settings.date))fail('保持した予定の元の滞在時間を確認してください。');}

    for (const row of state.result.rows) {
      if (!plain(row) || !ROW_TYPES.has(row.kind || row.type) || !validTime(row.start) || !validTime(row.end) || row.start > row.end || !text(row.name, 500) || !optionalNumber(row, 'cost', 0, 10000000)) fail('予定表の時刻と内容を確認してください。');
      for (const key of ['node', 'endNode', 'from', 'to']) if (row[key] !== undefined && !id(row[key])) fail('予定表の地点IDを確認してください。');
      if (row.path !== undefined && (!Array.isArray(row.path) || row.path.length > 1000 || row.path.some(value => !id(value)))) fail('予定表の徒歩ルートを確認してください。');
      if ((row.kind || row.type) === 'location' && (row.start !== row.end || !id(row.node))) fail('現在地の変更は同じ時刻の地点として指定してください。');
      if (row.fixedBreakId !== undefined && (!id(row.fixedBreakId) || (row.kind || row.type) !== 'rest' || !id(row.node))) fail('指定した休憩のIDと地点を確認してください。');
      if (row.activityId !== undefined && !visitId(row.activityId)) fail('予定表の施設IDと体験回数を確認してください。');
      if (row.awaitingPerformance !== undefined && (row.awaitingPerformance !== true || (row.kind || row.type) !== 'wait' || row.dpa !== true || !visitId(row.activityId) || !id(row.node))) fail('DPA入場から開演までの待機を確認してください。');
      if (row.plannedDpaPurchase!==undefined && (typeof row.plannedDpaPurchase!=='boolean' || !row.dpa || (row.kind||row.type)!=='activity')) fail('DPA購入候補の利用記録を確認してください。');
      if (row.autoBreakId!==undefined&&(!autoBreakId(row.autoBreakId)||(row.kind||row.type)!=='rest')) fail('自動休憩のIDを確認してください。');
      if ((row.walkingFactor!==undefined&&(!finite(row.walkingFactor,1,3)||(row.kind||row.type)!=='walk'))||(row.walkingSource!==undefined&&(row.walkingSource!=='congestion-estimate'||(row.kind||row.type)!=='walk'))) fail('混雑を考慮した徒歩時間を確認してください。');
      if(row.routeSource!==undefined&&(!id(row.routeSource)||(row.kind||row.type)!=='walk'))fail('徒歩移動の経路の版を確認してください。');
      if (row.walkSpeed!==undefined&&(!finite(row.walkSpeed,10,150)||(row.kind||row.type)!=='walk')) fail('徒歩移動を計画したときの速さを確認してください。');
      if (['estimatedMinutes','bufferMinutes','delayMinutes'].some(key => row[key] !== undefined)) {
        if ((row.kind || row.type) !== 'queue' || !integer(row.estimatedMinutes,0,600) || !integer(row.bufferMinutes,0,30) || !integer(row.delayMinutes,0,60) || row.end-row.start !== row.estimatedMinutes+row.bufferMinutes+row.delayMinutes) fail('待ち時間と余裕の内訳を確認してください。');
      }
    }
    if (state.result.visits !== undefined && (!Array.isArray(state.result.visits) || state.result.visits.length > MAX_VISITS || state.result.visits.some(visit => !plain(visit) || !visitId(visit.activityId || visit.id) || !id(visit.node) || (visit.endNode !== undefined && !id(visit.endNode)) || !validTime(visit.start) || !validTime(visit.end) || visit.start > visit.end))) fail('体験した施設と地点を確認してください。');
  }
  if (state.history !== undefined && (!Array.isArray(state.history) || state.history.length > 50000 || state.history.some(row => !validDate(row.date) || !id(row.activityId) || !integer(row.time, 0, 1439) || !finite(row.wait, 0, 600)))) fail('待ち時間の履歴を確認してください。');
  return state;
}

export function saveLocal(state) {
  validateSavedState(state);
  const encoded = JSON.stringify({format:'park-itinerary-lab', version:1, ...exportablePlan(state,false)});
  if (encoded.length > MAX_FILE_LENGTH) fail('保存するデータが大きすぎます。履歴の期間を短くしてください。');
  try { localStorage.setItem(STORAGE_KEY, encoded); } catch { throw new Error('この端末へ保存できません。JSONか予定表HTMLで保存してください。'); }
  return true;
}
export function loadLocal() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { throw new Error('このブラウザでは端末への保存を利用できません。JSONを読み込んでください。'); }
  if (!raw) return null;
  try { return parsePlanJson(raw); } catch { throw new Error('端末に保存されたデータを開けません。保存済みのJSONを読み込んでください。'); }
}

function planStore(options) {
  try {
    const storage=options.storage===undefined?globalThis.localStorage:options.storage;
    if(!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function')throw new Error();
    return storage;
  } catch {throw new Error('このブラウザでは端末への保存を利用できません。JSONで保存してください。');}
}
export function planName(value) {
  if(typeof value!=='string')fail('計画の名前を入力してください。');
  const name=value.trim().normalize('NFC');
  if(!name||name.length>80||/[\u0000-\u001f\u007f]/.test(name))fail('計画の名前は改行を含めず1〜80文字で入力してください。');
  return name;
}
function planStamp(now) {
  const date=new Date(now===undefined?Date.now():now);
  if(!Number.isFinite(date.getTime()))fail('保存日時を確認してください。');
  return date.toISOString();
}
export function planSummary(plan) {
  return {id:plan.id,name:plan.name,createdAt:plan.createdAt,updatedAt:plan.updatedAt,parkId:plan.state.parkId,date:plan.state.settings.date,hasSchedule:!!plan.state.result?.rows?.length,legacy:plan.legacy===true};
}
const TRANSIENT_PLAN_FIELDS=new Set(['liveData','liveSnapshot','liveNotice','waitAsOf','history','waitModel','calendarData']);
export function compactSavedPlan(value) {
  if(Array.isArray(value))return value.map(compactSavedPlan);
  if(plain(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!TRANSIENT_PLAN_FIELDS.has(key)).map(([key,item])=>[key,compactSavedPlan(item)]));
  return value;
}
function readPlanLibrary(storage) {
  let raw,legacy;
  try {raw=storage.getItem(PLANS_KEY);if(raw===null||raw===undefined)legacy=storage.getItem(STORAGE_KEY);}
  catch {throw new Error('保存した計画を読み込めません。このブラウザの保存設定を確認してください。');}
  if(raw===null||raw===undefined) {
    if(!legacy)return {format:'park-itinerary-lab-library',version:1,plans:[]};
    try {return {format:'park-itinerary-lab-library',version:1,plans:[{id:LEGACY_PLAN_ID,name:'以前の計画',createdAt:null,updatedAt:null,legacy:true,state:parsePlanJson(legacy)}]};}
    catch {throw new Error('以前に保存した計画を開けません。保存済みのJSONを読み込んでください。');}
  }
  try {
    if(!text(raw,MAX_FILE_LENGTH))throw new Error();
    const library=JSON.parse(raw);safeTree(library,-3);
    if(!plain(library)||library.format!=='park-itinerary-lab-library'||library.version!==1||!Array.isArray(library.plans)||library.plans.length>MAX_SAVED_PLANS)throw new Error();
    const ids=new Set();
    for(const plan of library.plans) {
      if(!plain(plan)||!id(plan.id)||ids.has(plan.id)||planName(plan.name)!==plan.name||!validTimestamp(plan.createdAt)||!validTimestamp(plan.updatedAt)||Date.parse(plan.createdAt)>Date.parse(plan.updatedAt)||(plan.legacy!==undefined&&typeof plan.legacy!=='boolean')||(plan.legacy===true&&plan.id!==LEGACY_PLAN_ID))throw new Error();
      ids.add(plan.id);validateSavedState(plan.state);
    }
    return library;
  } catch {throw new Error('保存した計画の一覧を開けません。元の保存データを保持しています。JSONの控えを読み込んでください。');}
}
function writePlanLibrary(storage,library,stamp) {
  // The legacy key remains untouched. A library, including an empty one, records its import once.
  for(const plan of library.plans) {
    if(plan.createdAt===null){plan.createdAt=stamp;plan.updatedAt=stamp;}
    plan.state=compactSavedPlan(plan.state);
  }
  const encoded=JSON.stringify(library);
  if(encoded.length>MAX_FILE_LENGTH)throw new Error('計画の保存容量を超えています。不要な計画を削除するかJSONで保存してください。');
  // One atomic setItem keeps every previous plan intact if the browser refuses the write.
  try {storage.setItem(PLANS_KEY,encoded);}
  catch {throw new Error('この端末へ保存できません。前の計画は保持しています。不要な計画を削除するかJSONで保存してください。');}
}
export function newPlanId(plans) {
  const used=new Set(plans.map(plan=>plan.id));
  for(let attempt=0;attempt<100;attempt++) {
    const token=globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${attempt}`;
    const next=`plan-${token}`;if(!used.has(next))return next;
  }
  throw new Error('新しい計画のIDを作れませんでした。もう一度保存してください。');
}

/** List named plans without rewriting stored data or deleting a previous single-plan save. */
export function listSavedPlans(options={}) {
  return readPlanLibrary(planStore(options)).plans.map(planSummary).sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)||a.id.localeCompare(b.id));
}

/** A name never selects an existing plan: overwriting requires its explicit stable ID. */
export function saveNamedPlan(name,state,options={}) {
  validateSavedState(state);
  const cleanName=planName(name),copy=parsePlanJson(JSON.stringify(compactSavedPlan(state)));
  const storage=planStore(options),library=readPlanLibrary(storage),stamp=planStamp(options.now);
  let plan;
  if(options.id!==undefined) {
    if(!id(options.id))fail('保存する計画のIDを確認してください。');
    plan=library.plans.find(item=>item.id===options.id);
    if(!plan)throw new Error('更新する計画が見つかりません。新しい計画として保存してください。');
    plan.name=cleanName;plan.state=copy;plan.updatedAt=new Date(Math.max(Date.parse(stamp),Date.parse(plan.updatedAt)||0)).toISOString();
  } else {
    if(library.plans.length>=MAX_SAVED_PLANS)throw new Error(`計画は${MAX_SAVED_PLANS}件まで保存できます。不要な計画を削除してから保存してください。`);
    plan={id:newPlanId(library.plans),name:cleanName,createdAt:stamp,updatedAt:stamp,state:copy};library.plans.push(plan);
  }
  writePlanLibrary(storage,library,stamp);return planSummary(plan);
}
export function loadSavedPlan(planId,options={}) {
  if(!id(planId))fail('開く計画のIDを確認してください。');
  const plan=readPlanLibrary(planStore(options)).plans.find(item=>item.id===planId);
  if(!plan)throw new Error('指定された計画が見つかりません。保存した計画の一覧を開き直してください。');
  return compactSavedPlan(plan.state);
}
export function renameSavedPlan(planId,name,options={}) {
  if(!id(planId))fail('名前を変更する計画のIDを確認してください。');
  const cleanName=planName(name),storage=planStore(options),library=readPlanLibrary(storage),stamp=planStamp(options.now);
  const plan=library.plans.find(item=>item.id===planId);
  if(!plan)throw new Error('名前を変更する計画が見つかりません。');
  plan.name=cleanName;plan.updatedAt=new Date(Math.max(Date.parse(stamp),Date.parse(plan.updatedAt)||0)).toISOString();
  writePlanLibrary(storage,library,stamp);return planSummary(plan);
}
export function deleteSavedPlan(planId,options={}) {
  if(!id(planId))fail('削除する計画のIDを確認してください。');
  const storage=planStore(options),library=readPlanLibrary(storage),index=library.plans.findIndex(item=>item.id===planId);
  if(index<0)return false;
  library.plans.splice(index,1);writePlanLibrary(storage,library,planStamp(options.now));return true;
}
export function parsePlanJson(raw) {
  if (!text(raw, MAX_FILE_LENGTH)) fail('JSONファイルが大きすぎます。');
  let value;
  try { value = JSON.parse(raw); } catch { fail('JSONの書式を確認してください。'); }
  if (value.format !== undefined && (value.format !== 'park-itinerary-lab' || value.version !== 1)) fail('この版では開けない保存データです。');
  return validateSavedState(value);
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeBase64(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('共有リンクの書式を確認してください。');
  let binary;
  try { binary = atob(value.replaceAll('-', '+').replaceAll('_', '/')); } catch { fail('共有リンクを最後までコピーしてください。'); }
  try { return new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(binary, character => character.charCodeAt(0))); } catch { fail('共有リンクの文字コードを確認してください。'); }
}
export function createShareUrl(state, baseUrl = location.href) {
  validateSavedState(state);
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol)) fail('共有用のWebページを開いてください。');
  const {history, initialPlan, waitModel, liveData, liveSnapshot, liveNotice, waitAsOf, operationalHolds, calendarData, weatherForecast, weatherNotice, visitForecastAsOf, dayProgress, completedIds, ...portableSettings} = state.settings;
  if (dayProgress) {
    delete portableSettings.replanFrom;
    delete portableSettings.currentNode;
  }
  const encoded = encodeBase64(JSON.stringify({v:1, parkId:state.parkId, settings:portableSettings}));
  if (encoded.length > MAX_SHARED_LENGTH) fail('希望が多く、リンクに収まりません。計画ファイルを保存して送ってください。');
  url.hash = `plan=${encoded}`;
  return url.href;
}
export function readSharedState(hash = location.hash) {
  if (!hash || !hash.startsWith('#plan=')) return null;
  const encoded = hash.slice(6);
  if (encoded.length > MAX_SHARED_LENGTH) fail('共有リンクが長すぎます。送った人から計画ファイルを受け取り、「保存した計画」から読み込んでください。');
  const value = JSON.parse(decodeBase64(encoded));
  if (value.v !== 1) fail('共有リンクの版を確認してください。');
  return validateSavedState({parkId:value.parkId, settings:value.settings});
}

function csvRecords(raw) {
  if (!text(raw, MAX_FILE_LENGTH)) fail('CSVが大きすぎます。期間を分けて読み込んでください。');
  const records = []; let row = [], field = '', quoted = false, afterQuote = false;
  raw = raw.replace(/^\uFEFF/, '');
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      if (char === '"' && raw[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === '"') {
      if (field || afterQuote) fail('CSVの引用符の位置を確認してください。');
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; afterQuote = false;
      if (char !== ',') {
        if (char === '\r' && raw[i + 1] === '\n') i++;
        if (row.some(value => value.trim() !== '')) records.push(row);
        row = [];
      }
    } else {
      if (afterQuote) fail('CSVの引用符の後にはカンマか改行を置いてください。');
      field += char;
    }
  }
  if (quoted) fail('CSVの引用符が閉じられていません。');
  if (field || row.length) { row.push(field); if (row.some(value => value.trim() !== '')) records.push(row); }
  return records;
}
export function parseHistoryCsv(raw) {
  const records = csvRecords(raw);
  if (records.length < 2 || records.length > 50001) fail('CSVには見出しと1〜50000件の履歴を入れてください。');
  const headers = records.shift().map(value => value.trim());
  if (new Set(headers).size !== headers.length || !['date', 'activityId', 'time', 'wait'].every(key => headers.includes(key))) fail('CSVの見出しにはdate,activityId,time,waitが必要です。');
  return records.map((cells, index) => {
    if (cells.length !== headers.length) fail(`CSVの${index + 2}行目の列数を確認してください。`);
    const row = Object.fromEntries(headers.map((key, column) => [key, cells[column].trim()]));
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(row.time);
    const time = timeMatch && Number(timeMatch[1]) <= 23 && Number(timeMatch[2]) < 60 ? Number(timeMatch[1]) * 60 + Number(timeMatch[2]) : /^\d{1,4}$/.test(row.time) ? Number(row.time) : NaN;
    const wait = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(row.wait) ? Number(row.wait) : NaN;
    if (!validDate(row.date) || !id(row.activityId) || !integer(time, 0, 1439) || !finite(wait, 0, 600) || (row.weather && !['sun', 'cloud', 'rain'].includes(row.weather)) || !text(row.event || '', 300)) fail(`CSVの${index + 2}行目の日付・時刻・待ち時間を確認してください。`);
    const extra={};
    for(const [key,min,max] of [['temperature',-90,70],['precipitation',0,500]])if(row[key]!==undefined&&row[key]!==''){
      if(!/^[-+]?\d+(?:\.\d+)?$/.test(row[key])||!finite(Number(row[key]),min,max))fail(`CSVの${index+2}行目の気温・降水量を確認してください。`);
      extra[key]=Number(row[key]);
    }
    if(row.openingMinute!==undefined&&row.openingMinute!==''){if(!/^\d{1,4}$/.test(row.openingMinute)||!integer(Number(row.openingMinute),0,1439))fail('CSVの開園時刻を確認してください。');extra.openingMinute=Number(row.openingMinute);}
    for(const key of ['weatherSource','source'])if(row[key]){if(!text(row[key],100))fail('CSVの出典を確認してください。');extra[key]=row[key];}
    return {date:row.date, activityId:row.activityId, time, wait, weather:row.weather || '', event:row.event || '',...extra};
  });
}

export const formatTime = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const yen = value => `${Math.round(Number(value) || 0).toLocaleString('ja-JP')}円`;
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const rowKind = row => row.kind || row.type || '';
function rowTitle(row) {
  let label = row.name;
  if (rowKind(row) === 'rest' && !label.includes('休憩')) label = `休憩 · ${label}`;
  if (rowKind(row) === 'queue' && (row.bufferMinutes || row.delayMinutes)) {
    label += `（見込み${row.estimatedMinutes}分${row.bufferMinutes ? `＋余裕${row.bufferMinutes}分` : ''}${row.delayMinutes ? `＋混雑想定${row.delayMinutes}分` : ''}）`;
  }
  if (row.userProgress === 'done') return `${label}（体験済み）`;
  if (row.userProgress === 'riding') return `${label}（体験中）`;
  if (row.userProgress === 'queue') return label + (rowKind(row) === 'queue' ? '（並んでいる）' : '（体験終了の見込み）');
  return label;
}
const rowLocation = (row, park) => park?.nodes?.find(node => node.id === (row.node || row.to))?.name || '';
const rowCategory = row => ({walk:'徒歩', wait:'時間調整', queue:'待ち時間', activity:'体験', rest:'休憩', exit:'退園', location:'現在地'})[rowKind(row)] || rowKind(row);
const csvCell = value => {
  let string = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(string)) string = "'" + string;
  return '"' + string.replaceAll('"', '""') + '"';
};
export function checkedRows(plan) {
  if (!plan || !Array.isArray(plan.rows) || plan.rows.length > 5000) fail('保存する予定表を先に作成してください。');
  for (const row of plan.rows) if (!validTime(row.start) || !validTime(row.end) || row.start > row.end || !text(row.name, 500)) fail('予定表の時刻と名前を確認してください。');
  return plan.rows;
}
function downloadBlob(contents, type, filename) {
  const blob = new Blob([contents], {type});
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportablePlan(value,stripHolds=true) {
  if(Array.isArray(value))return value.map(item=>exportablePlan(item,stripHolds));
  if(plain(value))return Object.fromEntries(Object.entries(value).filter(([key,item])=>!(stripHolds&&key==='operationalHolds')&&!(['liveData','liveSnapshot'].includes(key)&&item?.provider==='themeparks-wiki')).map(([key,item])=>[key,exportablePlan(item,stripHolds)]));
  return value;
}
export function buildPlanJson(state) { validateSavedState(state); return JSON.stringify({format:'park-itinerary-lab', version:1, ...exportablePlan(state)}, null, 2); }
export function downloadPlanJson(state) { downloadBlob(buildPlanJson(state), 'application/json;charset=utf-8', `TDRoute_${state.parkId}_${state.settings.date}.json`); }
function exportedWeather(plan,settings,minute) {
  const profile=plan.settings||settings||{},info=weatherForMinute(profile,minute);
  if(!info)return {info:null,details:`天気 ${profile.weatherMode==='manual'?'手動設定': '予報未取得'} · 気温 未提供 · 降水確率 未提供 · 降水量 未提供`,source:'予報未取得',age:'未提供'};
  const source=({'jma':'気象庁','open-meteo':'Open-Meteo'}[info.provider]||'出典未提供')+(info.sourceUrl?` ${info.sourceUrl}`:'');
  const age=validTimestamp(info.fetchedAt)?Math.max(0,Math.floor((Date.now()-Date.parse(info.fetchedAt))/60000)):'未提供';
  return {info,details:formatWeatherDetails(info),source,age};
}
function weatherDescription(weather) {
  return `${weather.details}。気象情報の出典 ${weather.source}。発表 ${weather.info?.issuedAt||'未提供'}。取得 ${weather.info?.fetchedAt||'未提供'}。保存時点で取得から ${weather.age}${typeof weather.age==='number'?'分':''}`;
}
export function buildScheduleCsv(plan, park, settings) {
  const rows = checkedRows(plan),value=n=>Number.isFinite(n)?n:'未提供';
  const headers=['開始', '終了', '種類', '予定', '所要分', '徒歩m', '費用円', 'DPA', '地点','天気','気温℃','最低気温℃','最高気温℃','降水確率%','降水量mm','天気の対象時間','気温の対象時間','降水確率の対象時間','降水量の対象時間','気象情報の出典','予報発表日時','予報取得日時','保存時点の取得から経過分'];
  return '\uFEFF' + [headers, ...rows.map(row => {
    const weather=exportedWeather(plan,settings,row.start),info=weather.info;
    return [formatTime(row.start), formatTime(row.end), rowCategory(row), rowTitle(row), row.end - row.start, row.metres || 0, row.cost || 0, row.dpa ? '利用' : '', rowLocation(row, park),info?.label||'予報未取得',value(info?.temperature),value(info?.temperatureMin),value(info?.temperatureMax),value(info?.precipitationProbability),value(info?.precipitation),...['weatherPeriodLabel','temperaturePeriodLabel','probabilityPeriodLabel','precipitationPeriodLabel'].map(key=>info?.[key]||'未提供'),weather.source,info?.issuedAt||'未提供',info?.fetchedAt||'未提供',weather.age];
  })].map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function downloadScheduleCsv(plan, park, settings) { downloadBlob(buildScheduleCsv(plan, park, settings), 'text/csv;charset=utf-8', `TDRoute_${park.id}.csv`); }
function icalText(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,'); }
function foldIcal(line) {
  const chunks = []; let chunk = '', bytes = 0;
  for (const char of line) {
    const width = new TextEncoder().encode(char).length;
    if (bytes + width > 73) { chunks.push(chunk); chunk = ' '; bytes = 1; }
    chunk += char; bytes += width;
  }
  chunks.push(chunk); return chunks.join('\r\n');
}
function calendarStamp(date, minutes) {
  const moment = new Date(`${date}T00:00:00+09:00`);
  moment.setTime(moment.getTime() + minutes * 60_000);
  return moment.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '');
}
export function buildCalendar(plan, park, settings) {
  const rows = checkedRows(plan); if (!validDate(settings.date)) fail('訪問日を確認してください。');
  const stamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TDRoute//Day Plan//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icalText(park.name)}`];
  rows.forEach((row, index) => {
    const instant = row.start === row.end;
    if (instant && !(rowKind(row) === 'activity' && row.userProgress === 'done')) return;
    const place = rowLocation(row, park),weather=exportedWeather(plan,settings,row.start);
    lines.push('BEGIN:VEVENT', `UID:${settings.date}-${park.id}-${index}-${row.start}@park-itinerary-lab`, `DTSTAMP:${stamp}`, `DTSTART:${calendarStamp(settings.date, row.start)}`);
    if (!instant) lines.push(`DTEND:${calendarStamp(settings.date, row.end)}`);
    lines.push(`SUMMARY:${icalText(rowTitle(row))}`, `DESCRIPTION:${icalText(`${row.fixedBreakId ? '指定した時刻と地点で休憩。' : ''}${row.dpa ? 'DPA利用。' : ''}費用 ${yen(row.cost)}${row.metres ? `。徒歩 約${Math.round(row.metres)}m` : ''}。${weatherDescription(weather)}`)}`, `LOCATION:${icalText(place ? `${park.name} · ${place}` : park.name)}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR'); return lines.map(foldIcal).join('\r\n') + '\r\n';
}
export function downloadCalendar(plan, park, settings) { downloadBlob(buildCalendar(plan, park, settings), 'text/calendar;charset=utf-8', `TDRoute_${park.id}_${settings.date}.ics`); }
export function buildOfflineHtml(plan, park, settings) {
  const rows = checkedRows(plan); if (!validDate(settings.date)) fail('訪問日を確認してください。');
  const total = plan.totals || {};
  const breakdown = [['フード', total.foodCost], ['DPA', total.dpaCost], ['お買い物', total.shoppingCost], ['残り予算', total.budgetRemaining], ['お土産に使える額', total.souvenirAllocation]].filter(([, value]) => finite(value, 0, 10000000)).map(([label, value]) => `<span>${html(label)} ${html(yen(value))}</span>`).join(' · ');
  const paidNote = settings.spentBudget > 0 || (settings.purchases || []).length > 0 ? '（支払済みを含む）' : '';
  const progress = (plan.settings || settings).dayProgress;
  const confirmed = progress?.parkId === park.id && progress.date === settings.date ? progress.visits : {};
  const timedVisits = new Set(rows.filter(row=>rowKind(row) === 'activity').map(row=>row.activityId));
  const otherVisits = Object.entries(confirmed).filter(([id, visit])=>visit.status === 'done' && !timedVisits.has(id));
  const untimed = otherVisits.map(([id])=>{
    const facility = park.activities?.find(activity=>activity.id === baseVisitId(id));
    return `<li>${html(facility?.name || baseVisitId(id))}${isRepeatVisit(id) ? '（2回目）' : ''}</li>`;
  });
  const untimedSection = untimed.length ? `<section><h2>体験済み（時刻の記録なし）</h2><ul>${untimed.join('')}</ul></section>` : '';
  const cards = rows.map((row, index) => `<article class="row ${rowKind(row) === 'activity' ? 'visit' : rowKind(row) === 'rest' ? 'rest' : ''}"><div class="time">${html(formatTime(row.start))}<small>${html(formatTime(row.end))}</small></div><div><h2>${html(rowTitle(row))}</h2><p>${rowLocation(row, park) ? `${html(rowLocation(row, park))} · ` : ''}${html(row.end - row.start)}分${row.metres ? ` · 徒歩 約${html(Math.round(row.metres))}m` : ''}${row.dpa ? ' · DPA利用' : ''}${row.cost ? ` · ${html(yen(row.cost))}` : ''}</p>${forecastCardHtml(exportedWeather(plan,settings,row.start).info,{missingLabel:`天気 ${(plan.settings||settings).weatherMode==='manual'?'手動設定':'予報未取得'}`})}<label><input type="checkbox" data-row="${index}"${row.userProgress === 'done' || (rowKind(row) === 'activity' && confirmed[row.activityId]?.status === 'done') ? ' checked' : ''}>済み</label></div></article>`).join('');
  const sources = forecastSourcesHtml(rows.map(row => exportedWeather(plan,settings,row.start).info),{snapshot:true});
  const safeMap = webUrl(park.mapUrl) ? `<a href="${html(park.mapUrl)}" target="_blank" rel="noopener noreferrer">公式の園内マップを開く ↗</a>` : '';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${html(park.name)} · ${html(settings.date)} の予定</title><style>*{box-sizing:border-box}body{margin:0;background:${park.id === 'sea' ? '#e8f5ff' : '#f4f6ff'};color:#183047;font-family:system-ui,"Yu Gothic",sans-serif;line-height:1.7}.wrap{max-width:720px;margin:auto;padding:26px 18px}header{margin-bottom:24px}h1{font-size:25px;margin:8px 0}h2{font-size:16px;margin:0}p{margin:5px 0;color:#536579;font-size:13px}.kicker{letter-spacing:.13em;font-size:10px;font-weight:800}.row{display:grid;grid-template-columns:68px 1fr;gap:14px;background:#ffffffad;border:1px solid #d2dde6;border-radius:14px;padding:17px;margin:9px 0}.visit{border-left:4px solid #308bc9;background:white}.rest{border-left:4px solid #99701c;background:#fff9e9}.time{font-weight:800;font-size:17px}.time small{display:block;font-size:12px;font-weight:500;color:#64758b}label{font-size:12px;display:inline-flex;align-items:center;gap:5px}input:checked{accent-color:#268769}a{color:#22689e}footer{margin:25px 0;font-size:12px}button{padding:9px 15px;border-radius:9px;border:1px solid #bdd0df;background:white;color:#183047;font:inherit}.forecast-card{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:8px 0;padding:10px 12px;background:#eef5fb;border-radius:10px}.forecast-main,.forecast-rain{display:flex;align-items:center;gap:12px}.forecast-icon{font-size:26px}.forecast-temperature{font-size:17px;font-weight:700}.forecast-period{display:block;font-size:11px;font-weight:500;color:#64758b}.forecast-main>.forecast-period{align-self:center}.forecast-value{display:flex;flex-direction:column;line-height:1.35}.forecast-value strong{font-size:14px}.forecast-metric-label{font-size:10px}.forecast-missing{color:#64758b}.forecast-sources{margin-top:20px}.forecast-sources h4{margin:12px 0 4px}.table-wrap{overflow:auto}table{border-collapse:collapse;font-size:11px}th,td{padding:5px;border:1px solid #d2dde6;text-align:left}summary{cursor:pointer}@media print{body{background:white}.wrap{max-width:none}.row{break-inside:avoid}button,label{display:none}}</style><div class="wrap"><header><div class="kicker">TDRoute / MY DAY</div><h1>${html(park.name)}</h1><p>${html(settings.date)} · ${html(formatTime(settings.entry))}〜${html(formatTime(settings.exit))}</p><p>合計 ${html(yen(total.cost ?? total.spend ?? rows.reduce((sum,row)=>sum+(Number(row.cost)||0),0)))}${paidNote} · 予算 ${html(yen(settings.budget))}</p><p>${breakdown}</p><button onclick="window.print()">印刷・PDFに保存</button></header><main>${untimedSection}${cards}</main><footer>${safeMap}${sources}<p>この予定表は通信がない場所でも開けます。チェックはこの画面を開いている間だけ保持されます。</p></footer></div></html>`;
}
export function downloadOfflineHtml(plan, park, settings) { downloadBlob(buildOfflineHtml(plan, park, settings), 'text/html;charset=utf-8', `TDRoute_${park.id}_${settings.date}.html`); }
