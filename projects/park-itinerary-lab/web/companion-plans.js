import {companionEmail, progressLabels} from './companion-view.js?v=2.5.0';
import {formatTime} from './storage.js?v=2.5.0';
import {baseVisitId,isRepeatVisit} from './repeat-visits.js';

const element = (tag, text) => Object.assign(document.createElement(tag), {textContent:text});
const clock = value => Number.isInteger(value) && value >= 0 && value <= 1440 ? formatTime(value) : '';

function renderTimetable(target, view, catalogue) {
  target.replaceChildren();
  if (!view) return;
  const park = catalogue.parks.find(p => p.id === view.park);
  target.append(element('h4',view.name), element('p',view.date + ' · ' + (park?.name || 'パーク')));
  if (view.tooLarge) { target.append(element('p','予定が多いため、このしおりは表示できません。')); return; }
  if (view.records.length) {
    target.append(element('h4','現地での体験状況'));
    const records = document.createElement('ul');
    for (const r of view.records) {
      const name = park?.activities.find(a => a.id === baseVisitId(r.id))?.name || baseVisitId(r.id);
      records.append(element('li',[name + (isRepeatVisit(r.id) ? '（2回目）' : ''), progressLabels[r.status], clock(r.end)].filter(Boolean).join(' · ')));
    }
    target.append(records);
  }
  if (view.dirty && view.rows.length) target.append(element('p','条件を変更中です。直前の予定を表示しています。'));
  if (!view.rows.length) { target.append(element('p','まだ予定がありません。計画ができるとここに表示されます。')); return; }
  const list = document.createElement('ol');
  for (const row of view.rows) {
    const li = document.createElement('li');
    li.append(element('strong',clock(row.start) + (row.end !== row.start ? '–' + clock(row.end) : '')),
      document.createTextNode('　' + row.name));
    list.append(li);
  }
  target.append(list);
}

function options(select, data, placeholder) {
  const values = data.map(([value,label]) => new Option(label,value));
  const old = select.value;
  if (select.options.length !== values.length+1 || values.some((v,i) => {
    const oldOption = select.options[i+1];
    return oldOption?.value !== v.value || oldOption?.text !== v.text;
  })) {
    select.replaceChildren(new Option(placeholder,''),...values);
    select.value = data.some(([id]) => id === old) ? old : '';
  }
}

function message(error) {
  return error?.code === 'permission-denied' ? '共有が解除されたか、ログイン中のアカウントに閲覧権限がありません。' :
    error?.code ? '通信できません。接続してもう一度お試しください。' : error?.message || '共有を確認できませんでした。';
}

export function mountCompanionPlans({container,adapter,uid,plans,planner,sync}) {
  if (!container) return {dispose(){}, refresh(){}, shared(){return false;}};
  container.innerHTML = `<details class="panel" id="companionPanel"><summary>同行者と計画をシェア <span id="tripCount"></span></summary>
    <h3>自分の計画を共有</h3><label>共有する計画<select id="tripOwnPlan"></select></label>
    <div id="tripManage" hidden><label>同行者のGoogleアカウント<input id="tripGuest" type="email" autocomplete="off" maxlength="254" required placeholder="メールアドレス"></label>
    <button type="button" id="tripInvite">この計画に招待</button><ul id="tripGuests" aria-label="この計画の同行者"></ul></div>
    <p class="field-note">名前を付けて保存した計画を選びます。共有中のしおりを開いて予定や体験記録を更新すると、同行者にも反映されます。</p>
    <p role="status" id="tripOwnerStatus"></p>
    <h3>招待された計画</h3><label>同行者の計画<select id="tripInbox"></select></label>
    <p role="status" id="tripReadStatus"></p><section id="tripTimetable" aria-label="共有されたしおり"></section></details>`;
  const get = id => container.querySelector('#'+id);
  const own = get('tripOwnPlan'), inbox = get('tripInbox'), manage = get('tripManage'), panel = get('companionPanel');
  const guest = get('tripGuest'), invite = get('tripInvite'), members = get('tripGuests');
  const status = get('tripOwnerStatus'), readStatus = get('tripReadStatus'), timetable = get('tripTimetable');
  const key = 'tdroute:active-shares:' + encodeURIComponent(uid);
  let sharedIds = new Set();
  try { sharedIds = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch {}
  let preferredInvite = '';
  let audiences = null, invites = [], stopOwn, stopInbox, stopView, opened = '', alive = true, busy = false;
  const listeners = new AbortController();
  const on = (target,type,fn) => target.addEventListener(type,fn,{signal:listeners.signal});
  const setMembers = () => {
    members.replaceChildren();
    manage.hidden = !own.value;
    invite.disabled = own.disabled = guest.disabled = busy || !audiences;
    if (!own.value || !audiences) return;
    const emails = audiences.get(own.value) || [];
    if (!emails.length) { members.append(element('li','招待した同行者はいません。')); return; }
    for (const email of emails) {
      const li = element('li',email + '　'), remove = element('button','共有を解除');
      remove.type = 'button'; remove.disabled = busy;
      remove.setAttribute('aria-label',email + 'との共有を解除');
      remove.onclick = () => change(email,false);
      li.append(remove); members.append(li);
    }
  };
  function refresh() {
    if (!alive) return;
    options(own,plans.list().map(p=>[p.id,p.name]),'保存した計画を選ぶ');
    if (!own.value && planner.getOpenedPlanId()) own.value = planner.getOpenedPlanId();
    setMembers();
  }
  function clearView() {
    stopView?.(); stopView = null; opened = '';
    timetable.replaceChildren(); readStatus.textContent = '';
  }
  function read() {
    const selected = invites.find(i => i.key === inbox.value);
    if (opened && selected?.key === opened && panel.open) return;
    clearView();
    if (!selected || !panel.open) return;
    opened = selected.key;
    readStatus.textContent = '最新の予定を確認しています…';
    stopView = adapter.watchView(uid,selected,view => {
      if (!alive || opened !== selected.key) return;
      renderTimetable(timetable,view,planner.getCatalogue());
      readStatus.textContent = view ? '閲覧専用 · 自動更新' : '最新の予定を確認しています…';
    }, cause => {
      if (!alive || opened !== selected.key) return;
      clearView(); readStatus.textContent = message(cause);
    });
  }
  function updateInbox(items) {
    invites = items || [];
    options(inbox,invites.map(i=>[i.key,i.name]),'招待された計画を選ぶ');
    if (items && !inbox.value) {
      inbox.value = invites.some(i => i.key === preferredInvite) ? preferredInvite : '';
      preferredInvite = inbox.value;
    }
    get('tripCount').textContent = invites.length ? '（招待 ' + invites.length + '件）' : '';
    if (!inbox.value) clearView(); else read();
    if (!invites.length) readStatus.textContent = items ? '招待された計画はまだありません。' : '最新の招待を確認しています…';
  }
  function disconnect() {
    stopOwn?.(); stopInbox?.(); stopOwn = stopInbox = null;
    clearView(); updateInbox(null); audiences = null; setMembers();
  }
  function connect() {
    disconnect();
    if (!alive || !navigator.onLine || document.hidden) {
      readStatus.textContent = 'オンラインになると共有された計画を確認できます。'; return;
    }
    stopOwn = adapter.watchAudiences(uid,data => {
      audiences = data;
      if (data) {
        sharedIds = new Set([...data].filter(([,v])=>v.length).map(([id])=>id));
        try { localStorage.setItem(key,JSON.stringify([...sharedIds])); } catch {}
      }
      refresh();
    }, cause => { audiences = null; setMembers(); status.textContent = message(cause); });
    stopInbox = adapter.watchInbox(uid,updateInbox,cause => {updateInbox(null); readStatus.textContent = message(cause);});
  }
  async function change(input,add) {
    if (busy || !own.value || !audiences) return;
    const id = own.value;
    try {
      const email = companionEmail(input);
      if (add && (audiences.get(id)||[]).includes(email)) { status.textContent = 'この同行者は招待済みです。'; return; }
      busy = true; setMembers();
      // If the local plan was saved offline, send the pending version before creating its first grant.
      if (plans.pendingCount()) {
        await sync();
        if (plans.pendingCount()) throw new Error('保存した計画の同期が終わってから、もう一度お試しください。');
      }
      if (!alive) return;
      await adapter.changeMember(uid,id,email,add);
      if (!alive) return;
      if (add) { sharedIds.add(id); guest.value = ''; }
      status.textContent = add ? '招待しました。同じGoogleアカウントで「招待された計画」を開けます。' : 'この計画の共有を解除しました。';
    } catch (error) { if (alive) status.textContent = message(error); }
    finally { busy = false; if (alive) setMembers(); }
  }
  on(own,'change',()=>{status.textContent = ''; guest.value=''; setMembers();});
  on(invite,'click',()=>{if (guest.reportValidity()) void change(guest.value,true);});
  on(inbox,'change',()=>{ preferredInvite = inbox.value; read(); }); on(panel,'toggle',()=>{ if (panel.open) refresh(); read(); });
  on(window,'offline',connect); on(window,'online',connect); on(document,'visibilitychange',connect);
  refresh(); connect();
  return {refresh,shared:id=>sharedIds.has(id),dispose(){
    alive = false; listeners.abort(); disconnect(); container.replaceChildren();
  }};
}
