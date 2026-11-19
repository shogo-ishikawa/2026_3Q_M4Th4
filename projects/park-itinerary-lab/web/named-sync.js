import {
  compactSavedPlan, listSavedPlans, loadSavedPlan, MAX_SAVED_PLANS,
  newPlanId, parsePlanJson, planName, planSummary,
} from './storage.js?v=2.3.0';

export const PRIVATE_PLAN_PREFIX = 'tdroute:private-plans:v1:';
const LEGACY_IMPORT_PREFIX = 'tdroute:legacy-plan-import:v1:';
const MAX_LOCAL_LENGTH = 4_000_000;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(id);
const newId = () => newPlanId([]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const timestamp = () => new Date().toISOString();

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}

const settingKeys = [
  'date', 'entry', 'exit', 'speed', 'budget', 'foodBudget', 'dpaBudget', 'dpaPurchaseLimit', 'souvenirReserve',
  'souvenirMode', 'budgetPreference', 'crowdMode', 'crowdLevel', 'weather', 'weatherMode', 'weatherForecast',
  'walkCrowdMode', 'waitBufferMode', 'waitBufferMinutes', 'queueDelayMinutes', 'gondolaAvoidHarbourShows',
  'selections', 'avoidConsecutiveFood', 'restEvery', 'restMinutes', 'searchSeconds', 'searchMethod', 'fixedBreaks',
  'excludedAutoBreaks', 'skipAutoRestAfter', 'spentBudget', 'purchases', 'replanFrom', 'currentNode', 'completedIds',
  'dayProgress', 'visitTimeLinked', 'liveMode',
];
const resultKeys = [
  'status', 'parkId', 'historicalVisitBounds', 'rows', 'visits', 'purchases', 'totals', 'coverage', 'omissions',
  'diagnostics', 'validation',
];

// Include only the open itinerary. A CSV, another park's draft, models and live responses stay out of the backup.
function privateState(state) {
  const copy = {parkId:state.parkId, settings:pick(state.settings, settingKeys)};
  if (state.result) {
    copy.result = pick(state.result, resultKeys);
    if (state.result.settings) copy.result.settings = pick(state.result.settings, settingKeys);
  } else copy.result = null;
  copy.resultDirty = !!state.resultDirty;
  return parsePlanJson(JSON.stringify(compactSavedPlan(copy)));
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkedPlan(id, plan) {
  if (plan === null) return null;
  if (!plan || plan.id !== id || typeof plan.createdAt !== 'string' || typeof plan.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(plan.createdAt)) || !Number.isFinite(Date.parse(plan.updatedAt)) ||
      Date.parse(plan.createdAt) > Date.parse(plan.updatedAt)) throw Error('同期するしおりの保存情報を確認してください。');
  return {id, name:planName(plan.name), createdAt:plan.createdAt, updatedAt:plan.updatedAt, state:privateState(plan.state)};
}

function checkedRemote(row) {
  if (!row || !validId(row.id) || !validRevision(row.revision) || row.revision === 0) {
    throw Error('クラウドのしおりの版を確認できませんでした。');
  }
  return {id:row.id, revision:row.revision, plan:checkedPlan(row.id, row.plan)};
}

function newerStamp(plan) {
  return new Date(Math.max(Date.now(), Date.parse(plan.updatedAt) + 1)).toISOString();
}

function conflictCopy(plan, id) {
  const suffix = '（この端末の変更）';
  return {...plan, id, name:plan.name.slice(0, 80 - suffix.length).trimEnd() + suffix};
}

/** One atomic local write saves both the itinerary and its pending cloud mutation. */
export function createPlanSync({storage:providedStorage, onChange = () => {}} = {}) {
  let active = null;
  const storage = () => providedStorage ?? globalThis.localStorage;
  function account() {
    if (!active) throw Error('Googleでログインしてしおりを開いてください。');
    return active;
  }
  function setAccount(uid, remote) {
    if (uid === null) active = null;
    else {
      if (typeof uid !== 'string' || !uid || uid.length > 128) throw Error('アカウントを確認してください。');
      if (active?.uid === uid) { active.remote = remote; return; }
      active = {uid, remote, prefix:PRIVATE_PLAN_PREFIX + encodeURIComponent(uid) + '/', opened:new Map()};
    }
    onChange();
  }
  function read(ctx, id) {
    if (!validId(id)) throw Error('しおりのIDを確認してください。');
    const raw = storage().getItem(ctx.prefix + id);
    if (raw === null) return null;
    try {
      const record = JSON.parse(raw);
      if (!validRevision(record.revision) || !(record.mutation === null || validId(record.mutation))) throw Error();
      return {...record, plan:checkedPlan(id, record.plan)};
    } catch { throw Error('端末に保存されたしおりを開けません。元のデータは保持しています。'); }
  }
  function records(ctx) {
    const result = [];
    const store = storage();
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (!key?.startsWith(ctx.prefix)) continue;
      const id = key.slice(ctx.prefix.length);
      const record = read(ctx, id);
      if (record) result.push([id, record]);
    }
    return result;
  }
  function put(ctx, id, record) {
    const encoded = JSON.stringify(record);
    if (encoded.length > MAX_LOCAL_LENGTH) throw Error('しおりが大きすぎます。計画JSONで保存してください。');
    try { storage().setItem(ctx.prefix + id, encoded); }
    catch { throw Error('端末の保存容量が足りません。しおりを計画JSONで保存してください。'); }
  }
  function commit(ctx, id, previous, plan) {
    put(ctx, id, {...previous, revision:previous?.revision ?? 0, mutation:newId(), plan});
  }
  function list() {
    return records(account()).flatMap(([,value]) => value.plan ? [planSummary(value.plan)] : [])
      .sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  }
  function load(id, {forEdit = true} = {}) {
    const ctx = account(), plan = read(ctx,id)?.plan;
    if (!plan) throw Error('指定されたしおりが見つかりません。');
    if (forEdit) ctx.opened.set(id, plan);
    return structuredClone(plan.state);
  }
  function save(name, state, {id} = {}) {
    const ctx = account(), checkedName = planName(name), clean = privateState(state);
    let previous = id === undefined ? null : read(ctx,id);
    const opened = ctx.opened.get(id);
    const stale = opened && !same(opened, previous?.plan);
    if (id !== undefined && !previous?.plan && !stale) throw Error('上書きするしおりが見つかりません。');
    if (id === undefined && list().length >= MAX_SAVED_PLANS) throw Error('しおりは' + MAX_SAVED_PLANS + '件まで保存できます。');
    if (id === undefined || stale) { id = newId(); previous = null; }
    const stamp = previous?.plan ? newerStamp(previous.plan) : timestamp();
    let plan = {id, name:checkedName, state:clean, createdAt:previous?.plan?.createdAt ?? stamp, updatedAt:stamp};
    plan = checkedPlan(id, stale ? conflictCopy(plan,id) : plan);
    commit(ctx, id, previous, plan);
    ctx.opened.set(id,plan);
    onChange();
    return {...planSummary(plan), conflict:!!stale};
  }
  function rename(id, name) {
    const ctx = account(), previous = read(ctx, id);
    if (!previous?.plan) throw Error('名前を変更するしおりが見つかりません。');
    const plan = {...previous.plan, name:planName(name), updatedAt:newerStamp(previous.plan)};
    commit(ctx, id, previous, plan);
    if (same(ctx.opened.get(id), previous.plan)) ctx.opened.set(id,plan);
    onChange();
    return planSummary(plan);
  }
  function remove(id) {
    const ctx = account(), previous = read(ctx, id);
    if (!previous?.plan) return false;
    commit(ctx, id, previous, null);
    ctx.opened.delete(id);
    onChange();
    return true;
  }
  function legacyClaim(id) {
    return JSON.parse(storage().getItem(LEGACY_IMPORT_PREFIX + id) ?? 'null');
  }
  function availableGuestPlans() {
    const ctx = account();
    return listSavedPlans({storage:storage()}).filter(item => {
      const claim = legacyClaim(item.id);
      return !claim || (claim.uid === ctx.uid && !read(ctx,claim.planId));
    });
  }
  async function importGuest(ids) {
    const ctx = account();
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_SAVED_PLANS || !ids.every(validId)) {
      throw Error('引き継ぐしおりを選んでください。');
    }
    const selected = new Set(ids);
    function importSelected() {
      if (active !== ctx) throw Error('引き継ぎ先のアカウントが変わりました。');
      const chosen = availableGuestPlans().filter(item => selected.has(item.id));
      if (list().length + chosen.length > MAX_SAVED_PLANS) throw Error('取り込むとしおりが' + MAX_SAVED_PLANS + '件を超えます。保存枠を空けてください。');
      for (const item of chosen) {
        // Claim only the selected original. Restarting a partial import reuses the same copy ID.
        const claim = legacyClaim(item.id) ?? {uid:ctx.uid, planId:newId()};
        if (claim.uid !== ctx.uid) continue;
        const {planId} = claim, stamp = timestamp();
        const state = loadSavedPlan(item.id,{storage:storage()});
        const plan = checkedPlan(planId,{
          id:planId, name:item.name, createdAt:item.createdAt ?? stamp, updatedAt:item.updatedAt ?? stamp, state,
        });
        storage().setItem(LEGACY_IMPORT_PREFIX + item.id,JSON.stringify(claim));
        commit(ctx,planId,null,plan);
      }
      onChange();
      return chosen.length;
    }
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request(LEGACY_IMPORT_PREFIX,importSelected) : importSelected();
  }
  function applyRemote(ctx, row) {
    const incoming = checkedRemote(row), previous = read(ctx,incoming.id);
    if (previous?.mutation || (previous?.revision ?? 0) >= incoming.revision) return;
    put(ctx,incoming.id,{revision:incoming.revision, mutation:null, plan:incoming.plan});
  }
  function settle(ctx, id, sent, reply) {
    const latest = read(ctx,id);
    if (!latest?.mutation || latest.revision !== sent.revision) return 0;
    if (!reply || typeof reply.ok !== 'boolean') throw Error('クラウドの保存結果を確認できませんでした。');
    if (reply.ok) {
      if (reply.revision !== sent.revision + 1) throw Error('クラウドの更新版を確認できませんでした。');
      put(ctx,id,{...latest, revision:reply.revision, mutation:latest.mutation === sent.mutation ? null : latest.mutation});
      return 0;
    }
    const current = reply.current === null ? {id,revision:0,plan:null} : checkedRemote(reply.current);
    if (current.id !== id) throw Error('しおりの同期先を確認できませんでした。');
    // The server may have committed the previous request before connectivity was lost.
    if (same(current.plan, sent.plan) || same(current.plan, latest.plan)) {
      put(ctx,id,{...latest, revision:current.revision, mutation:same(current.plan,latest.plan) ? null : latest.mutation});
      return 0;
    }
    if (latest.plan) {
      // Save the local edit first. Its durable mutation ID doubles as the copy ID after a crash/retry.
      const forkId = latest.mutation;
      if (!read(ctx,forkId)) commit(ctx,forkId,null,conflictCopy(latest.plan,forkId));
    }
    put(ctx,id,{revision:current.revision, mutation:null, plan:current.plan});
    return 1;
  }
  async function exchange(ctx, refresh) {
    let conflicts = 0;
    let firstError;
    if (refresh) {
      const remoteRows = await ctx.remote.list(ctx.uid);
      if (active !== ctx) return {conflicts};
      for (const row of remoteRows) {
        try { applyRemote(ctx,row); }
        catch (error) { firstError ??= error; }
      }
    }
    const attempted = new Set();
    while (active === ctx) {
      const batch = records(ctx).filter(([,item]) => item.mutation && !attempted.has(item.mutation));
      if (!batch.length) break;
      for (const [id] of batch) {
        if (active !== ctx) break;
        const sent = read(ctx,id);
        if (!sent?.mutation || attempted.has(sent.mutation)) continue;
        attempted.add(sent.mutation);
        try {
          const reply = await ctx.remote.write(ctx.uid,id,sent.revision,sent.plan);
          if (active !== ctx) break;
          conflicts += settle(ctx,id,sent,reply);
        } catch (error) { firstError ??= error; }
      }
    }
    if (active === ctx) onChange();
    if (firstError) throw firstError;
    return {conflicts};
  }
  function syncNow({refresh = true} = {}) {
    const ctx = account();
    if (!ctx.remote) return Promise.reject(Error('通信復帰後にしおりを同期できます。'));
    if (ctx.running && refresh && !ctx.refreshing) {
      return ctx.running.then(async first => {
        if (active !== ctx) return first;
        const next = await syncNow();
        return {conflicts:first.conflicts + next.conflicts};
      });
    }
    if (!ctx.running) {
      const run = () => active === ctx ? exchange(ctx,refresh) : Promise.resolve({conflicts:0});
      const locks = globalThis.navigator?.locks;
      ctx.refreshing = refresh;
      ctx.running = (locks ? locks.request(ctx.prefix,run) : run()).finally(() => { ctx.running = null; });
    }
    return ctx.running;
  }
  return {
    setAccount, list, load, save, rename, remove, syncNow, availableGuestPlans, importGuest,
    guestCount:() => availableGuestPlans().length,
    pendingCount:() => records(account()).filter(([,item]) => item.mutation).length,
  };
}
