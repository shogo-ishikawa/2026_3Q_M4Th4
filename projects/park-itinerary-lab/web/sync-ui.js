import {readFirebaseConfig, connectFirebase, syncErrorMessage} from './firebase-sync.js?v=2.5.0';
import {createPlanSync} from './named-sync.js?v=2.5.0';

import {mountCompanionPlans} from './companion-plans.js?v=2.5.0';
import {mountDriveMemories} from './drive-memories.js?v=2.5.0';

function startLogin() {
  const byId = id => document.getElementById(id);
  const gate = byId('loginGate');
  const shell = byId('appShell');
  const login = byId('googleSignIn');
  const retry = byId('retryLogin');
  const status = byId('loginStatus');
  const syncStatus = byId('syncStatus');
  const greeting = byId('accountGreeting');
  const accountName = byId('accountName');
  const adminLabel = byId('adminLabel');
  let adapter, unsubscribe, uid, planner, disposeMemories, companions;
  let starting = false, leaving = false, syncInFlight = null;
  let syncComplete = Promise.resolve();
  let editsDuringSync = false, refreshAfterUpload = false;
  let legacyOptions = '', summaries = '';
  const plans = createPlanSync({onChange: reflectLibrary});

  function lock() {
    companions?.dispose();
    companions = null;
    disposeMemories?.();
    disposeMemories = null;
    for (const dialog of shell.querySelectorAll('dialog[open]')) dialog.close();
    shell.inert = true;
    shell.hidden = true;
    greeting.textContent = '';
    accountName.textContent = '';
    adminLabel.hidden = true;
    gate.hidden = false;
    login.disabled = true;
  }

  function discardSession() {
    if (leaving) return;
    leaving = true;
    lock();
    plans.setAccount(null);
    unsubscribe?.();
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
    // Remove the previous account's editor, share link and open dialogs together.
    shell.replaceChildren();
    location.reload();
  }

  function reflectLegacyPlans() {
    const field = byId('legacyPlans');
    const available = plans.availableGuestPlans();
    const options = JSON.stringify(available);
    byId('legacyImport').hidden = !available.length;
    if (options === legacyOptions) return;
    legacyOptions = options;
    const selected = new Set(Array.from(field.querySelectorAll('input:checked'), input => input.value));
    for (const label of field.querySelectorAll('label')) label.remove();
    for (const plan of available) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = plan.id;
      input.checked = selected.has(plan.id);
      label.append(input, document.createTextNode(plan.name));
      field.append(label);
    }
    byId('importGuestPlans').disabled = !field.querySelector('input:checked');
  }

  function reflectLibrary() {
    if (!uid || leaving) return;
    try {
      reflectLegacyPlans();
      companions?.refresh();
      const next = JSON.stringify(plans.list());
      if (planner && summaries !== next && !byId('savedPlanList').contains(document.activeElement)) {
        planner.renderSavedPlans();
        summaries = next;
      }
    } catch (error) {
      syncStatus.textContent = syncErrorMessage(error);
    }
  }

  function showOffline() {
    const pending = plans.pendingCount();
    syncStatus.textContent = pending ? `同期待ち ${pending}件。オンラインに戻ると同期します。` : 'オフライン · この端末の保存分を表示しています。';
  }

  async function sync({afterEdit = false} = {}) {
    if (!uid || leaving) return;
    if (syncInFlight) {
      if (afterEdit) editsDuringSync = true;
      else if (syncInFlight === 'upload') refreshAfterUpload = true;
      return syncComplete;
    }
    let finish;
    syncComplete = new Promise(resolve => { finish = resolve; });
    syncInFlight = afterEdit ? 'upload' : 'refresh';
    byId('syncNow').disabled = true;
    try {
      if (!navigator.onLine) { showOffline(); return; }
      syncStatus.textContent = 'しおりを同期しています…';
      const result = await plans.syncNow({refresh: !afterEdit});
      if (leaving) return;
      const pending = plans.pendingCount();
      if (result.conflicts) syncStatus.textContent = '同時に変更されたしおりがあります。保存した計画を確認してください。';
      else if (pending) syncStatus.textContent = `同期待ち ${pending}件`;
      else syncStatus.textContent = 'しおりを同期しました。';
      reflectLibrary();
    } catch (error) {
      if (!leaving) syncStatus.textContent = syncErrorMessage(error);
    } finally {
      syncInFlight = null;
      if (!leaving) byId('syncNow').disabled = false;
      if ((editsDuringSync || refreshAfterUpload) && !leaving) {
        const uploadOnly = !refreshAfterUpload;
        editsDuringSync = false;
        refreshAfterUpload = false;
        try { await sync({afterEdit: uploadOnly}); } finally { finish(); }
      } else finish();
    }
  }

  async function onUser(user) {
    if (leaving) return;
    if (uid && user?.uid !== uid) { discardSession(); return; }
    if (!user) {
      lock();
      login.disabled = false;
      status.textContent = '同じGoogleアカウントでほかの端末からも開けます。';
      return;
    }
    const name = user.displayName?.trim();
    greeting.textContent = name ? `${name}さん、良い一日を！` : '良い一日を！';
    accountName.textContent = user.isOwner ? '管理者' : name || 'Google アカウント';
    adminLabel.hidden = !user.isOwner;
    if (uid === user.uid) return;
    uid = user.uid;
    try {
      const {initialiseApp} = await import('./app.js?v=2.5.0');
      if (leaving) return;
      plans.setAccount(uid, adapter);
      status.textContent = '施設情報を読み込んでいます…';
      const app = initialiseApp({plans, syncAfterEdit: () => sync({afterEdit: true}), refreshLibrary: () => sync(), isSharedPlan: id => companions?.shared(id)});
      await app.ready;
      if (leaving) return;
      planner = app;
      companions = mountCompanionPlans({container:byId('companionPlans'),adapter:adapter.companions,
        uid,plans,planner,sync:() => sync({afterEdit:true})});
      disposeMemories = mountDriveMemories({
        getIdToken: () => adapter.albumIdToken(user.uid), isOwner: user.isOwner,
        getState: app.getState, getPark: () => app.getContext().park
      });
      shell.inert = false;
      shell.hidden = false;
      gate.hidden = true;
      window.dispatchEvent(new Event('tdroute:ready'));
      reflectLibrary();
      void sync();
    } catch (error) {
      lock();
      status.textContent = syncErrorMessage(error);
      retry.hidden = false;
    }
  }

  async function connect() {
    if (starting || leaving) return;
    if (uid) { location.reload(); return; }
    starting = true;
    lock();
    retry.hidden = true;
    status.textContent = 'ログイン状態を確認しています…';
    try {
      const config = await readFirebaseConfig();
      if (!config) {
        status.textContent = 'ログインは現在準備中です。';
        retry.hidden = false;
        return;
      }
      adapter = await connectFirebase(config);
      unsubscribe?.();
      unsubscribe = adapter.observeUser(onUser, error => {
        if (uid) { discardSession(); return; }
        lock();
        status.textContent = syncErrorMessage(error);
        retry.hidden = false;
      });
    } catch (error) {
      status.textContent = syncErrorMessage(error);
      retry.hidden = false;
    } finally {
      starting = false;
    }
  }

  login.addEventListener('click', async () => {
    if (!adapter || login.disabled) return;
    login.disabled = true;
    status.textContent = 'Googleの画面でアカウントを選んでください。';
    try { await adapter.signIn(); }
    catch (error) {
      if (!uid) {
        status.textContent = syncErrorMessage(error);
        login.disabled = false;
      }
    }
  });
  retry.addEventListener('click', connect);
  byId('signOut').addEventListener('click', async () => {
    lock();
    status.textContent = 'ログアウトしています…';
    try {
      await adapter.signOut();
      discardSession();
    } catch (error) {
      status.textContent = syncErrorMessage(error);
      retry.hidden = false;
    }
  });
  byId('syncNow').addEventListener('click', () => sync());
  byId('legacyPlans').addEventListener('change', () => {
    byId('importGuestPlans').disabled = !byId('legacyPlans').querySelector('input:checked');
  });
  byId('savedPlanList').addEventListener('focusout', () => queueMicrotask(reflectLibrary));
  byId('importGuestPlans').addEventListener('click', async () => {
    if (!uid || leaving) return;
    try {
      const ids = Array.from(byId('legacyPlans').querySelectorAll('input:checked'), input => input.value);
      if (!ids.length) return;
      byId('importGuestPlans').disabled = true;
      const count = await plans.importGuest(ids);
      if (leaving) return;
      byId('savedPlanStatus').textContent = `${count}件の計画を取り込みました。`;
      reflectLibrary();
      void sync({afterEdit: true});
    } catch (error) {
      if (!leaving) {
        syncStatus.textContent = syncErrorMessage(error);
        byId('importGuestPlans').disabled = !byId('legacyPlans').querySelector('input:checked');
      }
    }
  });
  window.addEventListener('online', () => { if (uid) void sync(); else if (!adapter) void connect(); });
  window.addEventListener('offline', () => { if (uid && !leaving) void sync(); });
  window.addEventListener('storage', event => {
    if (uid && event.key?.startsWith('tdroute:private-plans:v1:')) reflectLibrary();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void sync();
  });
  window.addEventListener('pagehide', lock);
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  void connect();
}

if (typeof document !== 'undefined') startLogin();
