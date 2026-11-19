import {validateSavedState} from './storage.js?v=2.6.0';

// Keep private backups, other park drafts, imported observations and purchase histories outside collaboration.
function fields(source, keys) {
  const out = {};
  for (const key of keys.split(' ')) {
    const value = source?.[key];
    if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) out[key] = value;
  }
  return out;
}
function numberFields(source, keys) {
  return Object.fromEntries(keys.split(' ').filter(k=>Number.isFinite(source?.[k])).map(k=>[k,source[k]]));
}
const onlyIds = values => Array.isArray(values) ? values.filter(v=>typeof v === 'string') : undefined;
function jointSettings(settings) {
  const out = fields(settings,'date entry exit speed budget foodBudget dpaBudget souvenirReserve souvenirMode budgetPreference dpaPurchaseLimit crowdMode crowdLevel weather weatherMode walkCrowdMode waitBufferMode waitBufferMinutes queueDelayMinutes gondolaAvoidHarbourShows avoidConsecutiveFood restEvery restMinutes searchSeconds searchMethod visitTimeLinked liveMode replanFrom currentNode');
  out.selections = (settings.selections || []).map(wish => {
    const item = fields(wish,'id weight required duration cost repeatCount earliest latest timeWindowLinked dpaMode dpaStart dpaEnd dpaVisit dpaWindowLinked confirmedAccess nodeOverride viewingNode');
    if (Array.isArray(wish.showTimes)) item.showTimes = wish.showTimes.filter(Number.isInteger);
    for (const k of ['pauseWindows','dpaAvailableWindows']) {
      if (Array.isArray(wish[k])) item[k] = wish[k].filter(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(Number.isInteger));
    }
    return item;
  });
  if (settings.fixedBreaks) out.fixedBreaks = settings.fixedBreaks.map(b=>fields(b,'id node label start duration'));
  for (const k of ['excludedAutoBreaks','skipAutoRestAfter','completedIds']) if (settings[k]) out[k] = onlyIds(settings[k]);
  const record = settings.dayProgress;
  if (record?.visits && record.date === out.date) out.dayProgress = {
    date:record.date,parkId:record.parkId,visits:Object.fromEntries(Object.entries(record.visits)
      .map(([id,r]) => [id,fields(r,'status startedAt endsAt reportedAt')]))
  };
  return out;
}

export function jointState(state) {
  const settings = jointSettings(state.settings);
  const out = {parkId:state.parkId,settings,result:null,resultDirty:!!state.resultDirty};
  const plan = state.result;
  if (plan && ['feasible','no-plan'].includes(plan.status)) {
    out.result = {
      status:plan.status, parkId:state.parkId, settings:jointSettings(plan.settings || state.settings),
      rows:(plan.rows || []).map(row => {
        const data = fields(row,'kind type name start end duration activityId node endNode from to cost dpa dpaAdmission metres estimatedMinutes bufferMinutes delayMinutes preserved userProgress progressAnchor fixedBreakId autoBreakId walkSpeed walkingFactor walkingSource routeSource awaitingPerformance plannedDpaPurchase');
        if (row.path) data.path = onlyIds(row.path);
        return data;
      }),
      visits:(plan.visits || []).map(v=>fields(v,'id activityId name node endNode start end queueStart method cost')),
      coverage:numberFields(plan.coverage,'percent count totalCount score totalWeight'),
      totals:numberFields(plan.totals,'finish cost foodCost dpaCost shoppingCost walkingMetres plannedDpaCount walkMinutes restMinutes waitMinutes bufferMinutes delayMinutes'),
      omissions:(plan.omissions || []).map(o=>fields(o,'id name required reason')),
      purchases:[],
    };
    if (plan.historicalVisitBounds) out.result.historicalVisitBounds=fields(plan.historicalVisitBounds,'date parkId entry exit');
  }
  return validateSavedState(out);
}

export function encodeJoint(state) {
  const draft = JSON.stringify(jointState(state));
  if (new TextEncoder().encode(draft).length > 650000) throw new Error('共同編集できるサイズを超えています。希望や予定の数を減らしてください。');
  return draft;
}

export function decodeJoint(data) {
  if (!Number.isSafeInteger(data?.revision) || data.revision < 1 || typeof data.draft !== 'string' || data.draft.length > 650000)
    throw new Error('共同計画の保存形式を確認できません。');
  return {revision:data.revision, state:jointState(JSON.parse(data.draft))};
}

// Local edits stay in the planner until the participant publishes them. Every save compares its base revision.
export function jointEditor({container,adapter,uid,planner,plans,sync,notice}) {
  const box = document.createElement('section');
  box.id = 'jointEditor'; box.className = 'panel'; box.hidden = true;
  box.innerHTML = `<h3>共同編集 <span id="jointName"></span></h3>
    <p class="field-note">いつもの画面で希望や予定を変更し、「共同計画に反映」を押してください。</p>
    <button type="button" id="jointCommit">共同計画に反映</button> <button type="button" id="jointReload">最新版を開き直す</button>
    <button type="button" id="jointCopy">自分用に保存</button> <button type="button" id="jointLeave">共同編集を終了</button>
    <p id="jointStatus" role="status"></p>`;
  container.append(box);
  const get = id=>box.querySelector('#'+id);
  const status = get('jointStatus'), publish = get('jointCommit'), reload = get('jointReload'), copy = get('jointCopy');
  let session = null, unsubscribe;
  function redraw() {
    box.hidden = !session;
    publish.disabled = !session?.online || session.saving || session.latest?.revision !== session.base;
    reload.disabled = !session?.online || session.saving;
    copy.disabled = !session?.active;
  }
  function changed(s) {
    if (s.pending) return s.pending.dirty;
    try { return s.touched || planner.jointBusy() || encodeJoint(planner.captureJoint()) !== s.baseline; }
    catch { return true; }
  }
  function close(reason) {
    unsubscribe?.(); unsubscribe = null;
    if (session?.active) planner.leaveJoint();
    session = null; redraw(); if (reason) notice(reason);
  }
  function replace(s,record) {
    planner.openJoint(record.state,s.invite.name);
    s.active = true; s.touched = false; s.base = record.revision;
    s.baseline = encodeJoint(planner.captureJoint());
    status.textContent = '最新版を開いています。'; redraw();
  }
  function receive(s,record) {
    if (session !== s) return;
    if (record === false) { close('この共同計画は削除されました。'); return; }
    if (!record) { pause(s); s.online = false; status.textContent='編集権限と最新版を確認しています…'; redraw(); return; }
    s.online = true; s.latest = record;
    if (s.pending) {
      const pending = s.pending; s.pending = null;
      if (pending.dirty) {
        planner.openJoint(pending.state,s.invite.name); s.active = true; s.touched = true;
      } else { replace(s,record); return; }
    }
    if (!s.active) { replace(s,record); return; }
    if (!s.saving && s.base !== record.revision) {
      if (!changed(s)) replace(s,record);
      else status.textContent = '同行者が先に変更しました。手元の変更は残っています。自分用に保存するか、最新版を開き直してください。';
    } else if (!s.saving) status.textContent = '共同編集中です。';
    redraw();
  }
  function subscribe() {
    const s = session;
    if (!s || !navigator.onLine || document.hidden) return;
    unsubscribe?.();
    unsubscribe = adapter.watchWorkspace(uid,s.invite,r=>receive(s,r),error=>{
      if (session !== s) return;
      if (error?.code === 'permission-denied' || error?.code === 'sync/account') {
        close('この計画の編集権限がなくなりました。'); return;
      }
      s.online = false; redraw(); status.textContent = '最新版を確認できません。接続後にもう一度お試しください。';
    });
  }
  function pause(s) {
    s.online = false;
    if (s.active) {
      // Preserve the current editor in memory. Reopening requires a fresh, authorised server snapshot.
      let state;
      try { state = structuredClone(planner.captureJoint()); } catch { state = structuredClone(planner.getState()); }
      s.pending = {dirty:changed(s),state};
      planner.leaveJoint(); s.active = false;
    }
    status.textContent = '接続後に編集権限を確認します。'; redraw();
  }
  function suspend() {
    unsubscribe?.(); unsubscribe = null;
    if (session) pause(session);
  }
  function leave() {
    if (session?.saving) return false;
    if (session && (session.active || session.pending) && changed(session) &&
        !window.confirm('共同計画に反映していない変更を閉じますか？')) return false;
    close(); return true;
  }
  const listeners = new AbortController();
  const on = (el,type,fn)=>el.addEventListener(type,fn,{signal:listeners.signal});
  on(document,'input',e=>{
    if (session?.active && e.target.closest('#appShell') && !container.contains(e.target)) session.touched = true;
  });
  on(get('jointLeave'),'click',leave);
  on(reload,'click',()=>{
    if (session?.online && (!changed(session) || window.confirm('手元の変更を破棄して最新版を開き直しますか？')))
      replace(session,session.latest);
  });
  on(copy,'click',()=>{
    if (!session?.active) return;
    try {
      const name = session.invite.name.slice(0,70) + '（自分用）';
      plans.save(name,planner.captureJoint()); void sync();
      status.textContent='「'+name+'」を自分の計画に保存しました。';
    } catch(error) { status.textContent=error.message; }
  });
  on(publish,'click',async()=>{
    const s = session;
    if (!s?.active || !s.online || s.saving || s.base !== s.latest?.revision) return;
    try {
      if (planner.jointBusy()) throw new Error('プラン探索が終わってから反映してください。');
      const state = jointState(planner.captureJoint()), sent = JSON.stringify(state);
      s.saving = true; s.touched = false; redraw(); status.textContent='共同計画に反映しています…';
      const saved = await adapter.commitWorkspace(uid,s.invite,s.base,state);
      if (session !== s) return;
      if (saved.ok) {
        s.base = saved.revision; s.baseline = sent;
        if (!s.latest || s.latest.revision < saved.revision) s.latest = {revision:saved.revision,state};
        status.textContent='共同計画に反映しました。';
      } else { s.latest = saved.current; status.textContent='同行者が先に変更しました。手元の変更は残っています。'; }
    } catch(error) {
      if (session !== s) return;
      if (error?.code === 'permission-denied') {close('この計画の編集権限がなくなりました。'); return;}
      status.textContent = error?.code ? '共同計画に反映できませんでした。通信状態を確認してください。' : error.message;
    } finally {
      if (session === s) { s.saving = false; redraw(); }
    }
  });
  on(window,'offline',suspend); on(window,'online',subscribe);
  on(document,'visibilitychange',()=>document.hidden ? suspend() : subscribe());
  return {
    open(invite) {
      if (session?.invite.owner === invite.owner && session.invite.planId === invite.planId) {box.scrollIntoView();return;}
      if (session && !leave()) return;
      session = {invite,base:0,baseline:'',active:false,online:false,saving:false,touched:false};
      get('jointName').textContent=invite.name;
      status.textContent='編集権限と最新版を確認しています…'; redraw(); subscribe(); box.scrollIntoView({block:'center'});
    },
    verifyInvites(invites) {
      if (invites && session && session.invite.owner !== uid &&
          !invites.some(i=>i.owner===session.invite.owner&&i.planId===session.invite.planId&&i.role==='editor'))
        close('この計画の編集権限がなくなりました。');
    },
    dispose(){ listeners.abort(); close(); box.remove(); }
  };
}
