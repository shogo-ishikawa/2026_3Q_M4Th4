import {companionEmail, progressLabels} from './companion-view.js?v=2.6.1';
import {jointEditor} from './joint-planning.js?v=2.6.1';
import {formatTime} from './storage.js?v=2.6.1';
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

// Ordinals only distinguish identical names. Account identifiers stay out of the displayed names.
export function planOptions(entries) {
  const groups = new Map();
  for (const [id,name] of entries) {
    if (!groups.has(name)) groups.set(name,[]);
    groups.get(name).push(id);
  }
  for (const ids of groups.values()) ids.sort();
  return entries.map(([id,name]) => {
    const ids = groups.get(name);
    return [id,ids.length === 1 ? name : name+'（'+(ids.indexOf(id)+1)+'）'];
  });
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
    <label>同行者の権限<select id="tripRole"><option value="viewer">閲覧のみ</option><option value="editor">共同編集</option></select></label>
    <button type="button" id="tripInvite">この計画に招待</button><button id="tripEditOwn" type="button" hidden>共同編集を開く</button><ul id="tripGuests" aria-label="この計画の同行者"></ul></div>
    <p class="field-note">名前を付けて保存した計画を選びます。「共同編集」では、希望・来園条件・計画予算・旅程を一緒に編集できます。</p>
    <p role="status" id="tripOwnerStatus"></p>
    <h3>招待された計画</h3><label>同行者の計画<select id="tripInbox"></select></label>
    <button type="button" id="tripEditReceived" hidden>共同編集を開く</button><p role="status" id="tripReadStatus"></p><section id="tripTimetable" aria-label="共有されたしおり"></section></details>`;
  const get = id => container.querySelector('#'+id);
  const own = get('tripOwnPlan'), inbox = get('tripInbox'), manage = get('tripManage'), panel = get('companionPanel');
  const guest = get('tripGuest'), invite = get('tripInvite'), members = get('tripGuests');
  const status = get('tripOwnerStatus'), readStatus = get('tripReadStatus'), timetable = get('tripTimetable');
  const key = 'tdroute:active-shares:' + encodeURIComponent(uid);
  let sharedIds = new Set();
  try { sharedIds = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch {}
  let preferredInvite = '', selectedOwn = '';
  let roles = null, stopRoles;
  let audiences = null, invites = [], stopOwn, stopInbox, stopView, opened = '', alive = true, busy = false;
  const listeners = new AbortController();
  const on = (target,type,fn) => target.addEventListener(type,fn,{signal:listeners.signal});
  const joint = jointEditor({container,adapter,uid,planner,plans,sync,notice:text=>{
    status.textContent = readStatus.textContent = text;
    panel.open = true;
  }});
  const setMembers = () => {
    members.replaceChildren();
    manage.hidden = !own.value;
    invite.disabled = own.disabled = guest.disabled = get('tripRole').disabled = busy || !audiences || !roles;
    get('tripEditOwn').hidden = !roles?.has(own.value);
    if (!own.value || !audiences) return;
    const emails = audiences.get(own.value) || [];
    if (!emails.length) { members.append(element('li','招待した同行者はいません。')); return; }
    for (const email of emails) {
      const li = element('li',email + '　'), remove = element('button','共有を解除');
      remove.type = 'button'; remove.disabled = busy;
      remove.setAttribute('aria-label',email + 'との共有を解除');
      remove.onclick = () => {
        const name = own.selectedOptions[0]?.text;
        if (name && window.confirm('「'+name+'」の共有を '+email+' と解除しますか？')) void change(email,false);
      };
      const role = document.createElement('select');
      role.setAttribute('aria-label',email + 'の権限');
      role.append(new Option('閲覧のみ','viewer'),new Option('共同編集','editor'));
      role.value = roles?.get(own.value)?.includes(email) ? 'editor' : 'viewer';
      role.disabled = busy || !roles;
      role.onchange = () => { const next=role.value; setMembers(); void change(email,true,next); };
      li.append(role,remove); members.append(li);
    }
  };
  function refresh() {
    if (!alive) return;
    options(own,planOptions(plans.list().map(p=>[p.id,p.name])),'保存した計画を選ぶ');
    if (!own.value && planner.getOpenedPlanId()) own.value = planner.getOpenedPlanId();
    selectedOwn = own.value; setMembers();
  }
  function clearView() {
    stopView?.(); stopView = null; opened = '';
    timetable.replaceChildren(); readStatus.textContent = '';
  }
  function read() {
    const selected = invites.find(i => i.key === inbox.value);
    get('tripEditReceived').hidden = selected?.role !== 'editor';
    if (opened && selected?.key === opened && panel.open) return;
    clearView();
    if (!selected || !panel.open) return;
    opened = selected.key;
    readStatus.textContent = '最新の予定を確認しています…';
    stopView = adapter.watchView(uid,selected,view => {
      if (!alive || opened !== selected.key) return;
      renderTimetable(timetable,view && {...view,name:selected.name},planner.getCatalogue());
      readStatus.textContent = view ? '閲覧専用 · 自動更新' : '最新の予定を確認しています…';
    }, cause => {
      if (!alive || opened !== selected.key) return;
      clearView(); readStatus.textContent = message(cause);
    });
  }
  function updateInbox(items) {
    joint.verifyInvites(items);
    invites = items || [];
    options(inbox,planOptions(invites.map(i=>[i.key,i.name])),'招待された計画を選ぶ');
    if (items && !inbox.value) {
      inbox.value = invites.some(i => i.key === preferredInvite) ? preferredInvite : '';
      preferredInvite = inbox.value;
    }
    get('tripCount').textContent = invites.length ? '（招待 ' + invites.length + '件）' : '';
    read();
    if (!invites.length) readStatus.textContent = items ? '招待された計画はまだありません。' : '最新の招待を確認しています…';
  }
  function disconnect() {
    stopOwn?.(); stopRoles?.(); stopInbox?.(); stopOwn = stopRoles = stopInbox = null; roles = null;
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
    stopRoles = adapter.watchEditors(uid,data => { roles=data; setMembers(); },
      cause=>{roles=null; setMembers(); status.textContent=message(cause);});
    stopInbox = adapter.watchInbox(uid,updateInbox,cause => {updateInbox(null); readStatus.textContent = message(cause);});
  }
  async function change(input,add,role='viewer') {
    if (busy || !own.value || !audiences) return;
    const id = own.value;
    try {
      const email = companionEmail(input);
      if (add && (audiences.get(id)||[]).includes(email) && (roles?.get(id)?.includes(email) ? 'editor' : 'viewer') === role) { status.textContent = 'この同行者は招待済みです。'; return; }
      busy = true; setMembers();
      // If the local plan was saved offline, send the pending version before creating its first grant.
      if (plans.pendingCount()) {
        await sync();
        if (plans.pendingCount()) throw new Error('保存した計画の同期が終わってから、もう一度お試しください。');
      }
      if (!alive) return;
      await adapter.changeMember(uid,id,email,add,role);
      if (!alive) return;
      if (add) { sharedIds.add(id); guest.value = ''; }
      status.textContent = add ? (role==='editor'?'共同編集を許可しました。':'閲覧を許可しました。')+'同行者は「招待された計画」から開けます。' : 'この計画の共有を解除しました。';
    } catch (error) { if (alive) status.textContent = message(error); }
    finally { busy = false; if (alive) setMembers(); }
  }
  on(own,'change',()=>{
    if (!joint.select(uid,own.value)) {own.value = selectedOwn; return;}
    selectedOwn = own.value; status.textContent = ''; guest.value=''; setMembers();
  });
  on(invite,'click',()=>{if (guest.reportValidity()) void change(guest.value,true,get('tripRole').value);});
  on(get('tripEditOwn'),'click',()=>{
    const selected=plans.list().find(p=>p.id===own.value);
    if (selected && roles?.has(selected.id)) joint.open({owner:uid,planId:selected.id,name:selected.name,label:own.selectedOptions[0]?.text});
  });
  on(get('tripEditReceived'),'click',()=>{
    const invite=invites.find(i=>i.key===inbox.value && i.role==='editor');
    if (invite) joint.open({...invite,label:inbox.selectedOptions[0]?.text});
  });
  on(inbox,'change',()=>{
    const selected = invites.find(i=>i.key === inbox.value);
    if (!joint.select(selected?.owner,selected?.planId)) {inbox.value = preferredInvite; return;}
    preferredInvite = inbox.value; read();
  }); on(panel,'toggle',()=>{ if (panel.open) refresh(); read(); });
  on(window,'offline',connect); on(window,'online',connect); on(document,'visibilitychange',connect);
  refresh(); connect();
  return {refresh,shared:id=>sharedIds.has(id)&&!roles?.has(id),dispose(){
    alive = false; listeners.abort(); joint.dispose(); disconnect(); container.replaceChildren();
  }};
}
