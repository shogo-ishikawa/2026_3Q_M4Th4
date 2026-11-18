import {baseVisitId, repeatVisitId, isRepeatVisit} from './repeat-visits.js';
import {clockMinute, clockText} from './time-input.js';

const labels = {
  pending:'まだ体験していない', queue:'並んでいる', riding:'体験中',
  done:'体験済み', skipped:'今日は見送る',
};
const active = status => status === 'queue' || status === 'riding';
const ownVisits = (settings, park) => settings.dayProgress?.parkId === park.id &&
  settings.dayProgress.date === settings.date ? settings.dayProgress.visits : {};

export function suggestedReportTime(settings, now = Date.now()) {
  const local = new Date(now + 9 * 3600000);
  const today = local.toISOString().slice(0,10);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const previous = settings.replanFrom ?? settings.entry;
  const time = today === settings.date ? Math.max(previous, minute) : previous;
  return Math.max(settings.entry, Math.min(settings.exit - 1, time));
}

export function remainingVisitEnd({status, at, mode, duration, remaining, finish}) {
  if (!active(status)) return undefined;
  if (mode === 'finish') {
    if (!Number.isInteger(finish)) throw Error('体験が終わる予定時刻を入力してください。');
    return finish;
  }
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > 600)
    throw Error('残り時間は0〜600分で入力してください。');
  return at + remaining + (status === 'queue' ? duration : 0);
}

export function reviseDayProgress(park, settings, {id, status, at, end, doneAt, confirmFirst, here}) {
  const base = baseVisitId(id), facility = park.activities.find(a => a.id === base);
  if (!facility || (isRepeatVisit(id) && facility.category !== 'attraction'))
    throw Error('記録する施設と回数を選んでください。');
  if (!Number.isInteger(at) || at < settings.entry || at >= settings.exit)
    throw Error('組み替え開始は入園から退園前までの時刻にしてください。');
  if (!Object.hasOwn(labels, status) && status !== 'clear') throw Error('体験状況を選んでください。');
  const visits = {...ownVisits(settings, park)}, old = visits[id];
  const priorStart = active(old?.status) && Number.isInteger(old.startedAt) && old.startedAt <= at
    ? old.startedAt : at;
  if (status === 'clear') {
    delete visits[id];
  } else if (active(status)) {
    if (Object.entries(visits).some(([other, value]) => other !== id && active(value.status)))
      throw Error('進行中の施設がほかにあります。先にその体験を完了するか、列を離れたことを記録してください。');
    if (!Number.isInteger(end) || end <= at || end > settings.exit)
      throw Error('体験終了は組み替え開始より後、退園までにしてください。');
    visits[id] = {status, startedAt:old?.status === status ? priorStart : at, endsAt:end};
  } else if (status === 'done') {
    if (doneAt == null && active(old?.status)) doneAt = at;
    if (doneAt != null && (!Number.isInteger(doneAt) || doneAt < settings.entry || doneAt > at || (active(old?.status) && doneAt < priorStart)))
      throw Error('体験した時刻は入園・記録した開始時刻以降、組み替え開始までにしてください。');
    const observedStart = active(old?.status) ? priorStart : old?.status === 'done' ? old.startedAt : undefined;
    visits[id] = {status, ...(doneAt == null ? {} : {endsAt:doneAt}),
      ...(doneAt != null && Number.isInteger(observedStart) && observedStart <= doneAt ? {startedAt:observedStart} : {})};
  } else {
    visits[id] = {status};
  }
  if (isRepeatVisit(id) && (active(status) || status === 'done') && visits[base]?.status !== 'done') {
    if (!confirmFirst) throw Error('2回目を記録するには、先に1回目を体験したことを確認してください。');
    visits[base] = {status:'done'};
  }
  if (!isRepeatVisit(id) && (status === 'pending' || status === 'skipped' || status === 'clear') &&
      (active(visits[repeatVisitId(base)]?.status) || visits[repeatVisitId(base)]?.status === 'done'))
    throw Error('先に2回目の記録を訂正してください。');
  const patch = {dayProgress:{parkId:park.id,date:settings.date,visits},replanFrom:at};
  if (active(status) || here) patch.currentNode = facility.endNode || facility.node;
  else if (old?.status === 'queue' && (status === 'pending' || status === 'skipped'))
    patch.currentNode = facility.node;
  return patch;
}

export function attachDayProgress({root, context, apply, replan, syncClocks}) {
  const get = id => root.querySelector('#' + id);
  const editor = get('dayProgressEditor'), facilitySelect = get('progressFacility');
  const occurrence = get('progressOccurrence'), status = get('progressStatus');
  const clock = get('progressClock'), remaining = get('progressRemaining'), finish = get('progressFinish');
  const message = get('progressMessage'), list = get('progressList');
  let parkRef, lastDay, evidenceRef, savedSettings, sessionRef, dirty = false;
  const activity = () => context().park.activities.find(a => a.id === facilitySelect.value);
  const occurrenceId = () => occurrence.value === '2' ? repeatVisitId(facilitySelect.value) : facilitySelect.value;
  const readMinute = input => clockMinute(input.value);
  const duration = () => context().settings.selections.find(s => s.id === facilitySelect.value)?.duration ?? activity()?.duration ?? 10;
  function fillStatus() {
    const {park, settings} = context(), record = ownVisits(settings, park)[occurrenceId()];
    const at = readMinute(clock) ?? suggestedReportTime(settings);
    get('progressDoneAt').value = record?.status === 'done' && Number.isInteger(record.endsAt) ? clockText(record.endsAt) :
      active(record?.status) && status.value === 'done' ? clockText(at) : '';
    get('progressHere').checked = false;
    get('progressFirstConfirmed').checked = false;
    get('progressEstimateMode').value = active(record?.status) && record.status === status.value ? 'finish' : 'remaining';
    remaining.value = '';
    finish.value = active(record?.status) ? clockText(record.endsAt) : '';
    // Choosing a saved visit shouldn't silently reuse an obsolete remaining-time estimate.
    if (record?.status === 'riding' && record.endsAt > at) remaining.value = record.endsAt - at;
    toggleFields();
    syncClocks();
  }
  function toggleFields() {
    const {park, settings} = context(), record = ownVisits(settings, park)[occurrenceId()];
    const ongoing = active(status.value), mode = get('progressEstimateMode').value;
    get('progressActiveFields').hidden = !ongoing;
    get('progressRemainingField').hidden = mode === 'finish';
    get('progressFinishField').hidden = mode !== 'finish';
    get('progressRemainingLabel').textContent = status.value === 'queue' ? (activity()?.category === 'attraction' ? '乗るまであと何分？' : '利用開始まであと何分？') : '体験終了まであと何分？';
    get('progressDoneField').hidden = status.value !== 'done';
    get('progressHereField').hidden = status.value !== 'done';
    get('progressFirstField').hidden = occurrence.value !== '2' ||
      (!ongoing && status.value !== 'done') || ownVisits(settings,park)[facilitySelect.value]?.status === 'done';
    get('progressRelease').hidden = !active(record?.status);
    get('progressClear').hidden = !record;
    const at = readMinute(clock);
    let summary = '';
    if (ongoing && Number.isInteger(at) && (remaining.value !== '' || mode === 'finish')) {
      try {
        const end = remainingVisitEnd({status:status.value,at,mode,duration:duration(),remaining:Number(remaining.value),finish:readMinute(finish)});
        if (end > at && end <= settings.exit)
          summary = (status.value === 'queue' && mode === 'remaining' ? '体験時間' + duration() + '分を含めて' : '') + clockText(end) + 'から次の予定を組みます。';
      } catch { /* Keep the form editable until the user confirms the estimate. */ }
    }
    get('progressEstimate').textContent = summary;
  }
  function chooseFacility(id, state) {
    const {settings,park} = context();
    const facility = park.activities.find(a => a.id === baseVisitId(id));
    if (!facility) return;
    facilitySelect.value = facility.id;
    occurrence.value = isRepeatVisit(id) ? '2' : '1';
    get('progressOccurrenceField').hidden = facility.category !== 'attraction';
    const record = ownVisits(settings,park)[id];
    status.value = state || record?.status || 'done';
    fillStatus();
  }
  function refresh() {
    const {park,settings,session} = context();
    if (park !== parkRef || lastDay !== settings.date || session !== sessionRef) {
      parkRef = park; lastDay = settings.date; sessionRef = session; dirty = false;
      facilitySelect.replaceChildren();
      const groups = new Map();
      const wanted = new Set(settings.selections.map(s => s.id));
      for (const a of park.activities) {
        const groupName = wanted.has(a.id) ? '希望の施設' : 'その他の施設';
        if (!groups.has(groupName)) {
          const group = document.createElement('optgroup');group.label = groupName;groups.set(groupName, group);
        }
        groups.get(groupName).append(new Option(a.name, a.id));
      }
      for (const name of ['希望の施設', 'その他の施設']) if (groups.has(name)) facilitySelect.append(groups.get(name));
      clock.value = clockText(suggestedReportTime(settings));
      chooseFacility(facilitySelect.value);
      message.textContent = '';
    }
    const progress = settings.dayProgress;
    if (progress === evidenceRef && savedSettings === settings) return;
    evidenceRef = progress; savedSettings = settings;
    get('progressDate').textContent = settings.date + 'のしおり';
    list.replaceChildren();
    for (const [id, record] of Object.entries(ownVisits(settings,park))) {
      const a = park.activities.find(item => item.id === baseVisitId(id));
      if (!a) continue;
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button';button.dataset.editProgress = id;
      button.textContent = a.name + (isRepeatVisit(id) ? '（2回目）' : '') + ' · ' + labels[record.status] +
        (Number.isInteger(record.endsAt) ? ' ' + clockText(record.endsAt) : '') + '　訂正';
      item.append(button);list.append(item);
    }
    toggleFields();
  }
  function open(id, state) {
    refresh();
    const {settings} = context();
    if (id || !dirty) {
      clock.value = clockText(suggestedReportTime(settings));
      if (id) chooseFacility(id,state);
      else fillStatus();
      dirty = !!state;
    }
    editor.open = true;
    editor.scrollIntoView({block:'nearest'});
    status.focus({preventScroll:true});
  }
  function commit(override) {
    try {
      const {park,settings} = context(), id = occurrenceId();
      const requested = override || status.value, at = readMinute(clock);
      const end = remainingVisitEnd({status:requested, at, mode:get('progressEstimateMode').value, duration:duration(),
        remaining:remaining.value.trim() === '' ? null : Number(remaining.value), finish:readMinute(finish)});
      const patch = reviseDayProgress(park,settings,{id,status:requested,at,end,doneAt:readMinute(get('progressDoneAt')),
        confirmFirst:get('progressFirstConfirmed').checked,here:requested === 'done' && get('progressHere').checked});
      apply(patch, id, requested);
      chooseFacility(id,requested === 'clear' ? 'done' : requested);
      refresh();
      message.textContent = requested === 'clear' ? 'この体験記録を取り消しました。' : '体験状況を記録しました。';
      message.classList.remove('is-error');
      dirty = false;
      if (!override) get('progressReplan').focus({preventScroll:true});
      return true;
    } catch (error) {
      message.classList.add('is-error');
      message.textContent = error.message;
      return false;
    }
  }
  editor.addEventListener('toggle', () => {
    if (!editor.open) return;
    refresh();
    if (!dirty) {
      clock.value = clockText(suggestedReportTime(context().settings));
      toggleFields();syncClocks();
    }
  });
  function markDraft(event) {
    // Changing only the replan clock must not record a visit to the selected facility.
    if (!/^progressClock(?:-hour|-minute)?$/.test(event.target.id || '')) dirty = true;
  }
  editor.addEventListener('input', markDraft);
  editor.addEventListener('change', markDraft);
  facilitySelect.addEventListener('change', () => chooseFacility(facilitySelect.value));
  occurrence.addEventListener('change', () => chooseFacility(occurrenceId()));
  status.addEventListener('change', fillStatus);
  get('progressEstimateMode').addEventListener('change', toggleFields);
  for (const input of [clock, remaining, finish]) input.addEventListener('input', toggleFields);
  get('progressApply').addEventListener('click', () => commit());
  get('progressRelease').addEventListener('click', () => commit('pending'));
  get('progressClear').addEventListener('click', () => commit('clear'));
  get('progressReplan').addEventListener('click', () => {
    if (dirty && !commit()) return;
    const at = readMinute(clock), {settings} = context();
    if (!Number.isInteger(at) || at < settings.entry || at >= settings.exit) {
      message.classList.add('is-error');
      message.textContent = '組み替え開始は入園から退園前までの時刻にしてください。';
      return;
    }
    replan(at);
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-edit-progress]');
    if (button) open(button.dataset.editProgress);
  });
  return {open,refresh};
}
