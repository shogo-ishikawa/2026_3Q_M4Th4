/* Browser itinerary search. Every returned plan is checked; the search does not claim global optimality. */
const FOOD = new Set(['restaurant', 'cafe', 'snack', 'popcorn']);
const FIXED = new Set(['show', 'parade']);
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
  if (new Set(ids).size !== ids.length || !ids.length || ids.length > 400 || ids.some(id => typeof id !== 'string' || !id || id.length > 120) || park.edges.length > 5000) throw new RangeError('地図の地点IDを確認してください。');
  const distances = Object.create(null), paths = Object.create(null);
  for (const from of ids) {
    distances[from] = Object.create(null); paths[from] = Object.create(null);
    for (const to of ids) { distances[from][to] = from === to ? 0 : Infinity; paths[from][to] = from === to ? [from] : []; }
  }
  for (const edge of park.edges) {
    const from = edge.from ?? edge.a, to = edge.to ?? edge.b, metres = Number(edge.metres);
    if (!distances[from] || !distances[to] || !Number.isFinite(metres) || metres < 0 || metres > 20000) throw new RangeError('歩行経路の距離を確認してください。');
    if (metres < distances[from][to]) {
      distances[from][to] = distances[to][from] = metres;
      paths[from][to] = [from, to]; paths[to][from] = [to, from];
    }
  }
  for (const via of ids) for (const from of ids) for (const to of ids) {
    const candidate = distances[from][via] + distances[via][to];
    if (candidate + 1e-8 < distances[from][to]) {
      distances[from][to] = candidate;
      paths[from][to] = paths[from][via].concat(paths[via][to].slice(1));
    }
  }
  return { distances, paths };
}

function historicalWait(activity, start, settings, history) {
  const targetWeekday = new Date(settings.date + 'T12:00:00Z').getUTCDay();
  const targetWeekend = targetWeekday === 0 || targetWeekday === 6;
  const samples = [];
  for (const row of Array.isArray(history) ? history : []) {
    if ((row.activityId ?? row.activity_id ?? row.id) !== activity.id || !dateValid(row.date) || row.date > settings.date) continue;
    const wait = Number(row.wait ?? row.waitMinutes ?? row.wait_minutes);
    let time;
    try { time = toMinutes(row.time ?? row.minute); } catch { continue; }
    if (!Number.isFinite(wait) || wait < 0 || wait > 600 || Math.abs(time - start) > 120) continue;
    const weekday = new Date(row.date + 'T12:00:00Z').getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    let weight = 1 / (1 + Math.abs(time - start) / 30);
    if (weekend === targetWeekend) weight *= 2;
    if (weekday === targetWeekday) weight *= 1.5;
    if (row.weather && row.weather === settings.weather) weight *= 1.5;
    const eventIds = (settings.activeEvents || []).map(event => typeof event === 'string' ? event : event.id);
    if (row.event && eventIds.includes(row.event)) weight *= 1.5;
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
  const measured = historicalWait(activity, start, settings, history);
  if (measured) return measured;
  const weekday = dateValid(settings.date) ? new Date(settings.date + 'T12:00:00Z').getUTCDay() : 2;
  const weekend = weekday === 0 || weekday === 6;
  const level = { quiet: 0.7, normal: 1, busy: 1.35 }[settings.crowdLevel] ?? 1;
  const weather = settings.weather === 'rain' ? 0.84 : settings.weather === 'cloud' ? 0.97 : 1;
  const hour = start / 60;
  const timeFactor = hour < 10 ? 0.8 : hour < 12 ? 1.12 : hour < 16 ? 1.2 : hour < 18 ? 1.03 : 0.82;
  const eventFactor = (settings.activeEvents || []).reduce((factor, event) => factor *
    Math.max(0.5, Math.min(1.8, finite(typeof event === 'object' ? event.multiplier : 1, 1))), 1);
  return { minutes: Math.max(0, Math.round(finite(activity.baseWait) * level * (weekend ? 1.18 : 1) *
    weather * timeFactor * Math.min(1.6, eventFactor))), source: 'trend', samples: 0 };
}

function normalise(park, settings) {
  if (!park || !Array.isArray(park.activities)) throw new TypeError('施設データを確認してください。');
  if (!dateValid(settings?.date)) throw new RangeError('訪問日を確認してください。');
  const entry = toMinutes(settings.entry), exit = toMinutes(settings.exit);
  if (entry < 0 || exit > 1439 || entry >= exit) throw new RangeError('退園時刻は入園時刻より後にしてください。');
  const result = { ...settings, entry, exit };
  result.speed = numberIn(settings.speed ?? 65, '歩く速さ', 10, 150);
  result.budget = numberIn(settings.budget ?? 12000, '予算', 0, 10000000, true);
  result.spentBudget = numberIn(settings.spentBudget ?? 0, '支払済みの金額', 0, 10000000, true);
  for (const key of ['budget', 'spentBudget', 'foodBudget', 'dpaBudget', 'souvenirReserve']) {
    if (settings[key] !== undefined && settings[key] !== '' && settings[key] !== null) {
      result[key] = numberIn(settings[key], key, 0, 10000000, true);
      if (result[key] % 100) throw new RangeError('予算は100円単位で指定してください。');
    }
  }
  result.restEvery = numberIn(settings.restEvery ?? 120, '休憩の間隔', 0, 600, true);
  result.restMinutes = numberIn(settings.restMinutes ?? 10, '休憩の長さ', 0, 120, true);
  result.searchSeconds = numberIn(settings.searchSeconds ?? 3, '探索時間', 0.05, 30);
  result.history = Array.isArray(settings.history) ? settings.history.slice(0, 100000) : [];
  result.activeEvents = (park.events || []).filter(event => event.startDate <= settings.date && settings.date <= event.endDate);
  const activities = new Map(park.activities.map(activity => [activity.id, activity]));
  const input = settings.selections || [];
  if (!Array.isArray(input) || input.length > 200) throw new RangeError('希望する施設は200件以内にしてください。');
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
    if (!activities.has(purchase.id)) throw new RangeError('取得済みDPAの施設IDを確認してください。');
    const activity = activities.get(purchase.id);
    if (!activity.dpa) throw new RangeError('取得済みDPAの対象を確認してください。');
    if (purchase.kind && purchase.kind !== (activity.dpa.kind || 'attraction')) throw new RangeError('DPA購入履歴の種別が施設と一致しません。');
    return { ...purchase, kind: activity.dpa.kind || 'attraction',
      purchasedAt: toMinutes(purchase.purchasedAt ?? entry), start: toMinutes(purchase.start),
      end: toMinutes(purchase.end), cost: ceil100(numberIn(purchase.cost ?? activity.dpa.price, '支払済みDPAの費用', 0, 10000000, true)), owned: true };
  });
  for (const selection of result.selections.filter(item => item.dpaMode === 'owned')) {
    if (!result.purchases.some(purchase => purchase.id === selection.id)) {
      const activity = activities.get(selection.id);
      result.purchases.push({ id: selection.id, kind: activity.dpa.kind || 'attraction', purchasedAt: selection.dpaPurchasedAt,
        start: selection.dpaStart, end: selection.dpaEnd, cost: activity.dpa.price, owned: true });
    }
  }
  const purchaseIds = new Set();
  for (const purchase of result.purchases) {
    if (purchaseIds.has(purchase.id)) throw new RangeError('同じDPAの購入履歴が重複しています。');
    purchaseIds.add(purchase.id);
    const selection = result.selections.find(item => item.id === purchase.id && item.dpaMode === 'owned');
    if (selection && (selection.dpaStart !== purchase.start || selection.dpaEnd !== purchase.end || selection.dpaPurchasedAt !== purchase.purchasedAt)) throw new RangeError('取得済みDPAの時刻と購入履歴が一致しません。');
    if (purchase.purchasedAt < entry || purchase.start >= purchase.end || purchase.end > 1439 ||
      purchase.purchasedAt > purchase.start) throw new RangeError('取得済みDPAの購入・利用時刻を確認してください。');
  }
  return result;
}

function row(kind, start, end, name, extra = {}) {
  return { kind, type: kind, start, end, duration: end - start, name, cost: 0, dpa: false, ...extra };
}

function contextFor(park, settings, initialPlan) {
  const graph = graphDistances(park);
  const map = new Map(park.activities.map(activity => [activity.id, activity]));
  if (!graph.distances[park.entryNode] || !graph.distances[park.exitNode]) throw new RangeError('入口と出口の地点がありません。');
  let prefix = [], beginning = settings.entry, location = settings.currentNode || park.entryNode;
  const completed = new Set(settings.completedIds || []);
  if (settings.replanFrom !== undefined && settings.replanFrom !== '') {
    const cutoff = toMinutes(settings.replanFrom);
    if (cutoff < settings.entry || cutoff >= settings.exit) throw new RangeError('組み替える時刻は滞在時間内にしてください。');
    const priorRows = initialPlan?.rows || [];
    const startedVisitIds = new Set(priorRows.filter(item => item.start < cutoff && ['queue', 'activity'].includes(item.kind)).map(item => item.activityId));
    prefix = priorRows.filter(item => item.kind !== 'exit' &&
      (item.start < cutoff || (startedVisitIds.has(item.activityId) && ['queue', 'activity'].includes(item.kind)))).map(item => {
        const end = ['wait', 'rest'].includes(item.kind) ? Math.min(item.end, cutoff) : item.end;
        return { ...copy(item), end, duration: end - item.start, preserved: true };
      });
    if (prefix.length) {
      beginning = Math.max(cutoff, ...prefix.map(item => item.end));
      const prefixEnd = prefix[prefix.length - 1];
      const prefixNode = prefixEnd.endNode || prefixEnd.node || prefixEnd.to || location;
      if (settings.currentNode && settings.currentNode !== prefixNode && beginning > cutoff) throw new RangeError('進行中の予定の終了地点と現在地が一致しません。組み替える時刻を予定の終了後にしてください。');
      location = settings.currentNode || prefixNode;
      if (settings.currentNode && settings.currentNode !== prefixNode) prefix.push(row('location', beginning, beginning, '現在地を確認', { node: location, preserved: true }));
    } else beginning = cutoff;
    prefix.filter(item => item.kind === 'activity').forEach(item => completed.add(item.activityId));
  }
  if (!graph.distances[location]) throw new RangeError('現在地を地図から選んでください。');
  const prefixVisits = (initialPlan?.visits || []).filter(visit => prefix.some(item => item.kind === 'activity' && item.activityId === visit.id)).map(copy);
  const completedSelections = settings.selections.filter(selection => completed.has(selection.id));
  const selected = settings.selections.filter(selection => !completed.has(selection.id));
  const paidDpa = settings.purchases.reduce((sum, purchase) => sum + purchase.cost, 0);
  const prefixNonDpa = prefix.filter(item => item.kind === 'activity').reduce((sum, item) => sum + Math.max(0, finite(item.cost) - finite(item.dpaCost)), 0);
  const prefixDpa = prefix.filter(item => item.kind === 'activity').reduce((sum, item) => sum + finite(item.dpaCost), 0);
  const spent = Math.max(settings.spentBudget, prefixNonDpa + Math.max(prefixDpa, paidDpa));
  const sourceRows = prefix.filter(item => item.kind === 'activity');
  const initial = {
    time: beginning, node: location, rows: prefix, visits: prefixVisits, visited: new Set(completed),
    score: completedSelections.reduce((sum, item) => sum + item.weight, 0),
    cost: spent, foodCost: sourceRows.filter(item => FOOD.has(item.category)).reduce((sum, item) => sum + finite(item.cost), 0),
    dpaCost: Math.max(prefixDpa, paidDpa), shoppingCost: sourceRows.filter(item => item.category === 'shop').reduce((sum, item) => sum + finite(item.cost), 0),
    walk: prefix.filter(item => item.kind === 'walk').reduce((sum, item) => sum + finite(item.metres), 0),
    lastRest: beginning, purchases: settings.purchases.map(copy),
    required: completedSelections.filter(item => item.required).length,
  };
  const historyById = new Map();
  for (const record of settings.history) {
    const id = record.activityId ?? record.activity_id ?? record.id;
    if (!historyById.has(id)) historyById.set(id, []);
    historyById.get(id).push(record);
  }
  return { park, settings, map, graph, selected, completed, completedSelections, initial, historyById, waitCache: new Map() };
}

function activityWindows(activity, selection, settings) {
  const windows = selection.windows || activity.windows || [[settings.entry, settings.exit]];
  if (!Array.isArray(windows) || windows.length > 100 || windows.some(window => !Array.isArray(window) || window.length !== 2)) throw new RangeError('施設の営業時間を確認してください。');
  return windows.map(window => window.map(toMinutes)).filter(window => window[0] < window[1]);
}

function showTimes(activity, selection, settings) {
  if (selection.showTimes) return selection.showTimes;
  if (activity.showTimesDate && activity.showTimesDate !== settings.date) return [];
  return (activity.showTimes || []).map(toMinutes);
}

function eligiblePurchaseAt(state, activity, window, context) {
  const kind = activity.dpa.kind || 'attraction';
  let at = context.settings.replanFrom !== undefined && context.settings.replanFrom !== '' ? toMinutes(context.settings.replanFrom) : context.settings.entry;
  for (const purchase of state.purchases.filter(item => item.kind === kind)) {
    at = Math.max(at, Math.min(purchase.purchasedAt + 60, purchase.start));
    if (purchase.id === activity.id) at = Math.max(at, purchase.end);
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

function activityAvailable(activity, date) {
  if ((activity.closedDates || []).includes(date)) return false;
  if (activity.startDate && date < activity.startDate) return false;
  if (activity.endDate && date > activity.endDate) return false;
  return activity.closed !== true;
}

function dpaAvailable(activity, date) {
  return !!activity.dpa && (!activity.dpa.startDate || activity.dpa.startDate <= date) &&
    (!activity.dpa.endDate || date <= activity.dpa.endDate);
}

function scheduledOptions(state, baseActivity, selection, context) {
  if (!activityAvailable(baseActivity, context.settings.date)) return [];
  const settings = context.settings, graph = context.graph;
  const methods = [];
  if (selection.dpaMode !== 'owned') methods.push({ method: 'normal', windows: activityWindows(baseActivity, selection, settings), price: 0 });
  if (dpaAvailable(baseActivity, settings.date) && selection.dpaMode === 'owned' &&
    (baseActivity.category !== 'parade' || (selection.nodeOverride && selection.showTimes?.length))) methods.push({
    method: 'dpa', windows: [[selection.dpaStart, selection.dpaEnd]], price: 0, owned: true,
  });
  if (dpaAvailable(baseActivity, settings.date) && selection.dpaMode === 'consider' &&
    (baseActivity.category !== 'parade' || (selection.nodeOverride && selection.showTimes?.length))) {
    for (const window of selection.dpaAvailableWindows || []) {
      const purchaseAt = eligiblePurchaseAt(state, baseActivity, window, context);
      if (Number.isFinite(purchaseAt)) methods.push({
        method: 'dpa', windows: [window], price: ceil100(baseActivity.dpa.price), purchaseAt,
      });
    }
  }
  const options = [];
  for (const method of methods) {
    const activity = { ...baseActivity, node: method.method === 'dpa' ? (selection.nodeOverride || baseActivity.node) : baseActivity.node };
  const metres = graph.distances[state.node]?.[activity.node] ?? Infinity;
  if (!Number.isFinite(metres)) continue;
  const walkMinutes = Math.ceil(metres / settings.speed);
  const rows = [];
  let departure = state.time, lastRest = state.lastRest;
  if (settings.restEvery && settings.restMinutes && departure - lastRest >= settings.restEvery) {
    rows.push(row('rest', departure, departure + settings.restMinutes, 'ひと休み', { node: state.node }));
    departure += settings.restMinutes; lastRest = departure;
  }
  const arrival = departure + walkMinutes;
  if (walkMinutes) rows.push(row('walk', departure, arrival, activity.name + 'へ移動', {
    from: state.node, to: activity.node, node: activity.node, metres,
    path: graph.paths[state.node][activity.node], activityId: activity.id,
  }));
    if (!accessAllowed(activity, selection, method.method) || !budgetAllowed(state, activity, selection.cost, method.price, context)) continue;
    const windows = method.windows;
    const earliest = Math.max(arrival, selection.earliest ?? 0);
    const latest = Math.min(settings.exit, selection.latest ?? settings.exit);
    const fixed = FIXED.has(activity.category);
    const timeSelection = activity.category === 'parade' && method.method !== 'dpa' && selection.nodeOverride ? { ...selection, showTimes: selection.normalShowTimes } : selection;
    const starts = fixed ? showTimes(activity, timeSelection, settings) : [earliest];
    if (!fixed && method.method === 'normal' && settings.crowdMode !== 'manual' && finite(activity.baseWait) > 15) {
      for (let minute = Math.ceil(earliest / 60) * 60; minute <= Math.min(earliest + 120, latest); minute += 60) starts.push(minute);
    }
    for (const window of windows) for (const proposed of starts) {
      if (context.deadline && now() >= context.deadline) return options;
      let queueStart = Math.max(earliest, window[0], proposed);
      const cacheKey = activity.id + ':' + queueStart;
      if (!context.waitCache.has(cacheKey)) context.waitCache.set(cacheKey, estimateWait(activity, queueStart, settings, context.historyById.get(activity.id) || []));
      let wait = method.method === 'dpa' ? Math.round(finite(activity.dpa.wait, 10)) : context.waitCache.get(cacheKey).minutes;
      let start = queueStart + wait;
      if (fixed) {
        start = proposed;
        queueStart = start - wait;
        if (queueStart < earliest || queueStart < window[0]) continue;
      }
      if (method.method === 'dpa' && queueStart >= window[1]) continue;
      const end = start + selection.duration;
      if (end > latest || (method.method === 'normal' && end > window[1])) continue;
      if (!activityWindows(activity, selection, settings).some(open => queueStart >= open[0] && end <= open[1])) continue;
      const endNode = activity.endNode || activity.node;
      const exitMetres = graph.distances[endNode]?.[context.park.exitNode] ?? Infinity;
      if (end + Math.ceil(exitMetres / settings.speed) > settings.exit) continue;
      const key = method.method + ':' + queueStart + ':' + end;
      if (options.some(option => option.key === key)) continue;
      const extra = rows.slice();
      if (queueStart > arrival) extra.push(row('wait', arrival, queueStart, fixed ? '開演前の時間' : '時間帯まで待機', { node: activity.node, activityId: activity.id }));
      if (wait) extra.push(row('queue', queueStart, start, fixed ? '鑑賞場所へ・入場待ち' : '待ち時間', { node: activity.node, activityId: activity.id, dpa: method.method === 'dpa' }));
      const activityCost = selection.cost + method.price;
      extra.push(row('activity', start, end, activity.name, {
        activityId: activity.id, node: activity.node, endNode, category: activity.category,
        cost: activityCost, dpaCost: method.price, dpa: method.method === 'dpa', method: method.method,
        sourceUrl: activity.sourceUrl,
      }));
      const purchases = state.purchases.slice();
      if (method.method === 'dpa' && !method.owned) purchases.push({
        id: activity.id, kind: activity.dpa.kind || 'attraction', purchasedAt: method.purchaseAt,
        start: window[0], end: window[1], cost: method.price, owned: false,
      });
      const visited = new Set(state.visited); visited.add(activity.id);
      options.push({
        key, time: end, node: endNode, rows: state.rows.concat(extra),
        visits: state.visits.concat({ id: activity.id, activityId: activity.id, name: activity.name,
          node: activity.node, endNode, category: activity.category, start, end, queueStart, arrival,
          method: method.method, weight: selection.weight, cost: activityCost, dpaCost: method.price }),
        visited, score: state.score + selection.weight, cost: state.cost + activityCost,
        foodCost: state.foodCost + (FOOD.has(activity.category) ? selection.cost : 0),
        shoppingCost: state.shoppingCost + (activity.category === 'shop' ? selection.cost : 0),
        dpaCost: state.dpaCost + method.price, walk: state.walk + metres, lastRest,
        purchases, required: state.required + (selection.required ? 1 : 0),
      });
    }
  }
  return options;
}

function tieValue(state, context) {
  const preference = context.settings.budgetPreference;
  const preferenceScore = preference === 'food' ? state.visits.filter(visit => FOOD.has(visit.category)).length :
    preference === 'dpa' ? state.visits.filter(visit => visit.method === 'dpa').length : 0;
  return [state.score, preferenceScore, -state.cost, -state.walk, -state.time];
}

function compare(a, b, context) {
  const av = tieValue(a, context), bv = tieValue(b, context);
  for (let index = 0; index < av.length; index++) if (av[index] !== bv[index]) return bv[index] - av[index];
  return 0;
}

function requiredMet(state, context) {
  return context.settings.selections.filter(item => item.required).every(item => state.visited.has(item.id));
}

function canFinish(state, context) {
  const metres = context.graph.distances[state.node]?.[context.park.exitNode] ?? Infinity;
  return Number.isFinite(metres) && state.time + Math.ceil(metres / context.settings.speed) <= context.settings.exit &&
    state.cost + Math.max(0, finite(context.settings.souvenirReserve) - state.shoppingCost) <= context.settings.budget;
}

function finishRows(state, context) {
  const rows = state.rows.slice(), metres = context.graph.distances[state.node][context.park.exitNode];
  const minutes = Math.ceil(metres / context.settings.speed), end = state.time + minutes;
  if (minutes) rows.push(row('walk', state.time, end, '出口へ移動', {
    from: state.node, to: context.park.exitNode, node: context.park.exitNode, metres,
    path: context.graph.paths[state.node][context.park.exitNode],
  }));
  rows.push(row('exit', end, end, '退園', { node: context.park.exitNode }));
  return rows;
}

function omissionFor(selection, context, best) {
  const activity = context.map.get(selection.id);
  let reason = '移動・時間・予算の組合せで今回は採用されませんでした。';
  if (!activityAvailable(activity, context.settings.date)) reason = '訪問日は休止・開催期間外です。';
  else if (activity.category === 'parade' && selection.dpaMode === 'owned' && (!selection.nodeOverride || !selection.showTimes?.length)) reason = 'DPAの鑑賞地点と、その場所の公演時刻を入力してください。';
  else if (FIXED.has(activity.category) && !showTimes(activity, selection, context.settings).length) reason = '訪問日の公演時刻を入力してください。';
  else if (!accessAllowed(activity, selection, selection.dpaMode === 'owned' ? 'dpa' : 'normal') && selection.dpaMode !== 'consider') reason = '予約・エントリーなどの利用条件を確認してください。';
  else if (!Number.isFinite(context.graph.distances[context.initial.node]?.[activity.node])) reason = '現在地からつながる歩行経路がありません。';
  else if (selection.cost > context.settings.budget - context.initial.cost) reason = '残りの予算を超えています。';
  else if (!scheduledOptions(context.initial, activity, selection, context).length) reason = '指定の時間帯・待ち時間・取得済み枠では退園に間に合いません。';
  else if (selection.dpaMode === 'consider' && !(selection.dpaAvailableWindows || []).length) reason += ' DPAの空き枠が未入力のため通常待機だけで検討しました。';
  return { id: selection.id, name: activity.name, weight: selection.weight, required: selection.required, reason };
}

function resultFrom(state, context, diagnostics, quick = false) {
  const selections = context.settings.selections;
  const rows = state ? finishRows(state, context) : context.initial.rows;
  const visited = state?.visited || context.initial.visited;
  const weight = selections.filter(item => visited.has(item.id)).reduce((sum, item) => sum + item.weight, 0);
  const totalWeight = selections.reduce((sum, item) => sum + item.weight, 0);
  const money = state?.cost ?? context.initial.cost;
  const walk = rows.filter(item => item.kind === 'walk').reduce((sum, item) => sum + finite(item.metres), 0);
  const sumMinutes = kind => rows.filter(item => item.kind === kind).reduce((sum, item) => sum + item.end - item.start, 0);
  const omissions = selections.filter(item => !visited.has(item.id)).map(selection => quick ? {
    id: selection.id, name: context.map.get(selection.id).name, weight: selection.weight, required: selection.required, reason: '探索中のため、まだ採用されていません。',
  } : omissionFor(selection, context, state));
  return {
    status: state ? 'feasible' : 'no-plan', parkId: context.park.id, settings: copy({ ...context.settings, history: [], historySampleCount: context.settings.history.length }),
    rows, visits: state?.visits || context.initial.visits, purchases: state?.purchases || context.initial.purchases,
    totals: {
      cost: money, foodCost: state?.foodCost ?? context.initial.foodCost,
      dpaCost: state?.dpaCost ?? context.initial.dpaCost, shoppingCost: state?.shoppingCost ?? context.initial.shoppingCost,
      walkingMetres: walk, walkMinutes: sumMinutes('walk'), queueMinutes: sumMinutes('queue'),
      waitMinutes: sumMinutes('queue') + sumMinutes('wait'), restMinutes: sumMinutes('rest'),
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

/** Anytime beam search over visits, admission methods and time windows. */
export function solveItinerary(park, rawSettings, options = {}) {
  const started = now();
  const replan = rawSettings?.replanFrom !== undefined && rawSettings.replanFrom !== '';
  let input = rawSettings;
  if (replan && rawSettings.purchases === undefined && options.initialPlan?.purchases?.length) {
    const entered = Array.isArray(rawSettings.purchases) ? rawSettings.purchases : [];
    const enteredIds = new Set(entered.map(purchase => purchase.id));
    const priorOwned = options.initialPlan.purchases.filter(purchase => purchase.owned && !enteredIds.has(purchase.id));
    input = { ...rawSettings, purchases: entered.concat(priorOwned) };
  }
  const settings = normalise(park, input), context = contextFor(park, settings, options.initialPlan);
  const milliseconds = Math.min(settings.searchSeconds * 1000,
    options.deadlineMs === undefined ? Infinity : Math.max(1, Number(options.deadlineMs)));
  const deadline = started + milliseconds;
  context.deadline = deadline;
  let best = requiredMet(context.initial, context) && canFinish(context.initial, context) ? context.initial : null;
  let expanded = 0, timedOut = false, lastProgress = started;
  let beam = [context.initial];
  const width = context.selected.length <= 7 ? 12000 : context.selected.length <= 15 ? 320 : 180;
  for (let depth = 0; depth < context.selected.length && beam.length; depth++) {
    const next = [];
    for (const state of beam) {
      if (now() >= deadline) { timedOut = true; break; }
      for (const selection of context.selected) {
        if (state.visited.has(selection.id)) continue;
        const activity = context.map.get(selection.id);
        const children = scheduledOptions(state, activity, selection, context);
        expanded += children.length;
        for (const child of children) {
          if (requiredMet(child, context) && canFinish(child, context) && (!best || compare(child, best, context) < 0)) best = child;
          next.push(child);
        }
      }
      if (now() - lastProgress >= 150) {
        const elapsedMs = Math.round(now() - started);
        const preview = best ? resultFrom(best, context, {
          elapsedMs, expanded, method: 'beam-search', optimal: false, timedOut: false, running: true,
          waitSource: settings.crowdMode === 'manual' ? 'manual' : settings.history.length ? 'history-or-trend' : 'trend',
          notes: ['探索中に得られた実行可能な案です。探索を続けると採用内容が変わる場合があります。'],
        }, true) : null;
        options.onProgress?.({ elapsedMs, bestScore: best?.score ?? 0, visits: best?.visits.length ?? 0, expanded, preview });
        lastProgress = now();
      }
    }
    if (timedOut) break;
    // Preserve alternatives that have different final places and purchased DPA histories.
    const grouped = new Map();
    for (const state of next) {
      const key = [...state.visited].sort().join('|') + ';' + state.node + ';' +
        state.purchases.map(purchase => purchase.id + ':' + purchase.start).join(',');
      const previous = grouped.get(key);
      if (!previous || state.time < previous.time || (state.time === previous.time && compare(state, previous, context) < 0)) grouped.set(key, state);
    }
    beam = [...grouped.values()].sort((a, b) => {
      const requiredRemainingA = context.selected.filter(item => item.required && !a.visited.has(item.id)).length;
      const requiredRemainingB = context.selected.filter(item => item.required && !b.visited.has(item.id)).length;
      const boundA = a.score + context.selected.filter(item => !a.visited.has(item.id)).reduce((sum, item) => sum + item.weight, 0);
      const boundB = b.score + context.selected.filter(item => !b.visited.has(item.id)).reduce((sum, item) => sum + item.weight, 0);
      return requiredRemainingA - requiredRemainingB || boundB - boundA || compare(a, b, context);
    }).slice(0, width);
  }
  const diagnostics = {
    elapsedMs: Math.round(now() - started), expanded, method: 'beam-search', optimal: false, timedOut,
    waitSource: settings.crowdMode === 'manual' ? 'manual' : settings.history.length ? 'history-or-trend' : 'trend',
    notes: [
      '重要度の合計を優先し、同点では支出・歩行距離を比べた探索中の最良案です。最適性の証明は行いません。',
      settings.history.length ? '対応する履歴がある施設・時間帯は類似日の観測値を使用し、ない部分は傾向モデルで補います。' :
        '待ち時間は曜日・天気・時刻・イベントによる傾向モデルです。実測履歴を読み込むと類似日の推定へ切り替わります。',
      'DPAの購入案は入力した空き枠と購入履歴から計算しています。在庫は公式アプリで確認してください。',
    ],
  };
  if (!best) diagnostics.notes.unshift('必須条件をすべて満たす案は見つかりませんでした。必須指定・時刻・予算を見直してください。実行不可能と証明した結果ではありません。');
  context.deadline = null;
  const result = resultFrom(best, context, diagnostics);
  if (best) {
    const verification = validatePlan(park, settings, result);
    if (!verification.valid) throw new Error('予定の検証で問題が見つかりました：' + verification.errors.join(' / '));
  }
  options.onProgress?.({ elapsedMs: diagnostics.elapsedMs, bestScore: result.totals.score, visits: result.visits.length, expanded });
  return result;
}

/** Independently recompute chronological, geometric, window and money checks. */
export function validatePlan(park, settings, result) {
  const errors = [], graph = graphDistances(park), activities = new Map(park.activities.map(activity => [activity.id, activity]));
  const selectionMap = new Map((settings.selections || []).map(item => [item.id, item]));
  const entry = toMinutes(settings.entry), exit = toMinutes(settings.exit), speed = Number(settings.speed ?? 65);
  const rows = result.rows || [];
  let previous = entry, node = settings.replanFrom !== undefined && rows.some(item => item.preserved) ? park.entryNode : (settings.currentNode || park.entryNode);
  const visited = new Set(settings.completedIds || []);
  for (const item of rows) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < previous || item.end < item.start) errors.push('予定の時刻が前後しています。');
    if (item.start < entry || item.end > exit) errors.push('滞在時間の外に予定があります。');
    if (item.kind === 'walk') {
      if (item.from !== node) errors.push('移動の出発地点がつながっていません。');
      const distance = graph.distances[item.from]?.[item.to];
      if (!Number.isFinite(distance) || Math.abs(distance - Number(item.metres)) > 0.01) errors.push('移動距離が歩行経路と一致しません。');
      if (item.end - item.start < Math.ceil(distance / speed)) errors.push('移動時間が不足しています。');
      node = item.to;
    }
    if (item.kind === 'location') {
      if (!settings.currentNode || item.node !== settings.currentNode || settings.replanFrom === undefined || item.start < toMinutes(settings.replanFrom)) errors.push('現在地の確認地点が不正です。');
      node = item.node;
    }
    if (item.kind === 'activity') {
      if (!Number.isFinite(item.cost) || item.cost < 0 || item.cost % 100) errors.push('体験費用が不正です。');
      const activity = activities.get(item.activityId), selection = selectionMap.get(item.activityId);
      if (!activity) { errors.push('施設が見つかりません。'); continue; }
      if (visited.has(activity.id) && !(settings.completedIds || []).includes(activity.id)) errors.push('同じ施設が重複しています。');
      visited.add(activity.id);
      if (item.node !== (item.dpa ? (selection?.nodeOverride || activity.node) : activity.node)) errors.push('体験地点が施設の地点と一致しません。');
      if (item.node !== node) errors.push('施設までの移動がありません。');
      if (!activityAvailable(activity, settings.date)) errors.push('休止日の施設が含まれています。');
      if (selection) {
        if (item.end - item.start !== Number(selection.duration ?? activity.duration ?? 10)) errors.push('体験の所要時間が設定と一致しません。');
        if (selection.earliest !== undefined && item.start < toMinutes(selection.earliest)) errors.push('希望時間帯より前です。');
        if (selection.latest !== undefined && item.end > toMinutes(selection.latest)) errors.push('希望時間帯より後です。');
        const fixed = FIXED.has(activity.category);
        const timeSelection = activity.category === 'parade' && !item.dpa && selection.nodeOverride ? { ...selection, showTimes: selection.normalShowTimes } : selection;
        if (fixed && !showTimes(activity, timeSelection, settings).includes(item.start)) errors.push('開演時刻と一致しません。');
        const queue = rows.find(candidate => candidate.kind === 'queue' && candidate.activityId === item.activityId);
        const admission = queue?.start ?? item.start;
        if (!activityWindows(activity, selection, settings).some(window => admission >= window[0] && item.end <= window[1])) errors.push('施設の営業時間の外です。');
        if (item.dpa) {
          if (!dpaAvailable(activity, settings.date)) errors.push('この日にはDPAを利用できません。');
          if (activity.category === 'parade' && (!selection.nodeOverride || !selection.showTimes?.length)) errors.push('パレードDPAの鑑賞地点・時刻が未確認です。');
          const purchase = (result.purchases || []).find(candidate => candidate.id === item.activityId);
          if (!purchase || admission < purchase.start || admission >= purchase.end) errors.push('DPAの利用枠の外です。');
        } else if (!activityWindows(activity, selection, settings).some(window => admission >= window[0] && item.end <= window[1])) errors.push('施設の営業時間の外です。');
      }
      node = activity.endNode || item.node;
      if ((item.endNode || item.node) !== node) errors.push('体験後の地点が一致しません。');
    }
    if (item.kind === 'exit' && (item.node !== park.exitNode || node !== park.exitNode)) errors.push('出口に到着していません。');
    previous = item.end;
  }
  for (const selection of settings.selections || []) if (selection.required && !visited.has(selection.id)) errors.push('必須の希望がありません。');
  const purchased = result.purchases || [];
  const ownedCosts = purchased.filter(item => item.owned).reduce((sum, item) => sum + item.cost, 0);
  const prefix = rows.filter(item => item.kind === 'activity' && item.preserved);
  const prefixNonDpa = prefix.reduce((sum, item) => sum + Math.max(0, item.cost - finite(item.dpaCost)), 0);
  const prefixDpa = prefix.reduce((sum, item) => sum + finite(item.dpaCost), 0);
  const baseSpent = Math.max(finite(settings.spentBudget), prefixNonDpa + Math.max(prefixDpa, ownedCosts));
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
  const dpaCost = Math.max(prefixDpa, ownedCosts) + purchased.filter(item => !item.owned).reduce((sum, item) => sum + item.cost, 0);
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
