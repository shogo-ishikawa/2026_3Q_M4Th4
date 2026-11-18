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
    const reportedAt = Math.min(at, old?.status === 'done' ? (old.reportedAt ?? at) : at);
    visits[id] = {status, ...(doneAt == null ? {reportedAt} : {endsAt:doneAt}),
      ...(doneAt != null && Number.isInteger(observedStart) && observedStart <= doneAt ? {startedAt:observedStart} : {})};
  } else {
    visits[id] = {status};
  }
  if (isRepeatVisit(id) && (active(status) || status === 'done') && visits[base]?.status !== 'done') {
    if (!confirmFirst) throw Error('2回目を記録するには、先に1回目を体験したことを確認してください。');
    visits[base] = {status:'done',reportedAt:status === 'done' ? (doneAt ?? at) : at};
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
  const chips = [...get('progressRemainingField').querySelectorAll('[data-remaining]')];
  let parkRef, lastDay, evidenceRef, savedSettings, sessionRef, wishKey;
  // Changing only the start time must never create a visit record.
  let dirty = false, clockDraft = false, estimateEdited = false;
  const hasDraft = () => dirty || clockDraft;
  const showReset = () => { get('progressReset').hidden = !hasDraft(); };
  const activity = () => context().park.activities.find(a => a.id === facilitySelect.value);
  const occurrenceId = () => occurrence.value === '2' ? repeatVisitId(facilitySelect.value) : facilitySelect.value;
  const readMinute = input => clockMinute(input.value);
  const duration = () => context().settings.selections.find(s => s.id === facilitySelect.value)?.duration ?? activity()?.duration ?? 10;
  // Moving the report clock alone cannot shift an already recorded finish.
  function useRecordedEstimate(record, at) {
    if (estimateEdited || !active(record?.status) || record.status !== status.value || !Number.isInteger(at)) return;
    const left = record.endsAt - at - (record.status === 'queue' ? duration() : 0);
    remaining.value = left >= 0 && record.endsAt > at ? String(left) : '';
    get('progressEstimateMode').value = left < 0 && record.endsAt > at ? 'finish' : 'remaining';
  }
  function fillStatus() {
    const {park, settings} = context(), record = ownVisits(settings, park)[occurrenceId()];
    get('progressDoneAt').value = record?.status === 'done' && Number.isInteger(record.endsAt) ? clockText(record.endsAt) : '';
    get('progressHere').checked = false;
    get('progressFirstConfirmed').checked = false;
    get('progressEstimateMode').value = 'remaining';
    remaining.value = '';
    finish.value = active(record?.status) ? clockText(record.endsAt) : '';
    estimateEdited = false;
    useRecordedEstimate(record, readMinute(clock));
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
    for (const chip of chips) chip.setAttribute('aria-pressed', String(remaining.value === chip.dataset.remaining));
    const at = readMinute(clock);
    let summary = '';
    if (ongoing && Number.isInteger(at) && (remaining.value !== '' || mode === 'finish')) {
      try {
        const end = remainingVisitEnd({status:status.value,at,mode,duration:duration(),remaining:Number(remaining.value),finish:readMinute(finish)});
        if (end > at && end <= settings.exit) {
          const facility = activity();
          const arrival = facility?.endNode && facility.endNode !== facility.node &&
            park.nodes?.find(node => node.id === facility.endNode)?.name;
          const start = arrival ? arrival + 'の降り場から' : 'この施設の出口から';
          summary = (status.value === 'queue' && mode === 'remaining' ? '体験時間' + duration() + '分を含めて' : '') +
            clockText(end) + 'に終了予定。' + start + '次の予定を組みます。';
        } else if (end > settings.exit) summary = '終了見込みが退園予定（' + clockText(settings.exit) + '）を過ぎます。';
        else if (end <= at) summary = '組み替え開始より後の終了時刻を指定してください。';
      } catch { /* Keep the form editable until the user confirms the estimate. */ }
    }
    if (!summary && active(record?.status) && Number.isInteger(at)) {
      if (ongoing && record.endsAt <= at) summary = '前回の終了見込みは' + clockText(record.endsAt) + 'でした。まだ続く場合は残り時間を入力してください。';
      if (status.value === 'done' && !get('progressDoneAt').value)
        summary = '終了時刻を省略すると' + clockText(at) + 'に体験を終えたと記録します。';
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
    status.value = state || record?.status || '';
    fillStatus();
  }
  function refresh() {
    const {park,settings,session} = context();
    const changedDay = park !== parkRef || lastDay !== settings.date || session !== sessionRef;
    const wantedIds = settings.selections.map(s => s.id);
    const key = wantedIds.join('|');
    if (changedDay || key !== wishKey) {
      const priorId = occurrenceId();
      parkRef = park; lastDay = settings.date; sessionRef = session; wishKey = key;
      facilitySelect.replaceChildren();
      const groups = new Map();
      const wanted = new Set(wantedIds);
      for (const a of park.activities) {
        const groupName = wanted.has(a.id) ? '希望の施設' : 'その他の施設';
        if (!groups.has(groupName)) {
          const group = document.createElement('optgroup');group.label = groupName;groups.set(groupName, group);
        }
        groups.get(groupName).append(new Option(a.name, a.id));
      }
      for (const name of ['希望の施設', 'その他の施設']) if (groups.has(name)) facilitySelect.append(groups.get(name));
      if (changedDay) {
        dirty = false; clockDraft = false; showReset();
        clock.value = clockText(suggestedReportTime(settings));
        const current = Object.keys(ownVisits(settings,park)).find(id => active(ownVisits(settings,park)[id].status));
        chooseFacility(current || facilitySelect.value);
        message.textContent = '';
        message.classList.remove('is-error');
      } else {
        // Rebuilding wish groups must not replace an off-plan visit being edited.
        facilitySelect.value = baseVisitId(priorId);
      }
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
    if (id || !hasDraft()) {
      clock.value = clockText(suggestedReportTime(settings));
      if (id) chooseFacility(id,state);
      else fillStatus();
      dirty = !!state; clockDraft = false; showReset();
    }
    resumeDraft();
  }
  function resumeDraft() {
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
      chooseFacility(id,requested === 'clear' ? undefined : requested);
      refresh();
      message.textContent = requested === 'clear' ? 'この体験記録を取り消しました。' : '体験状況を記録しました。後で開き直すには「名前を付けて保存」から新規保存または上書き保存してください。';
      message.classList.remove('is-error');
      dirty = false; clockDraft = false; showReset();
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
    if (!hasDraft()) {
      clock.value = clockText(suggestedReportTime(context().settings));
      fillStatus();
    }
  });
  function markDraft(event) {
    // Changing only the replan clock must not record a visit to the selected facility.
    message.textContent = '';
    message.classList.remove('is-error');
    if (/^progressClock(?:-hour|-minute)?$/.test(event.target.id || '')) clockDraft = true;
    else dirty = true;
    showReset();
  }
  editor.addEventListener('input', markDraft);
  editor.addEventListener('change', markDraft);
  facilitySelect.addEventListener('change', () => chooseFacility(facilitySelect.value));
  occurrence.addEventListener('change', () => chooseFacility(occurrenceId()));
  status.addEventListener('change', fillStatus);
  function editEstimate() { estimateEdited = true; toggleFields(); }
  get('progressEstimateMode').addEventListener('change', editEstimate);
  remaining.addEventListener('input', editEstimate);
  finish.addEventListener('input', editEstimate);
  get('progressDoneAt').addEventListener('input', toggleFields);
  clock.addEventListener('input', () => {
    const {park,settings} = context();
    useRecordedEstimate(ownVisits(settings,park)[occurrenceId()], readMinute(clock));
    toggleFields();
  });
  for (const chip of chips) chip.addEventListener('click', () => {
    remaining.value = chip.dataset.remaining;
    remaining.dispatchEvent(new Event('input', {bubbles:true}));
  });
  get('progressReset').addEventListener('click', () => {
    dirty = false; clockDraft = false; showReset();
    clock.value = clockText(suggestedReportTime(context().settings));
    chooseFacility(occurrenceId());
    message.textContent = '入力を戻しました。';
    message.classList.remove('is-error');
  });
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
    clockDraft = false; showReset();
    replan(at);
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-edit-progress]');
    if (button) open(button.dataset.editProgress);
  });
  return {open,refresh,hasDraft,resumeDraft};
}
