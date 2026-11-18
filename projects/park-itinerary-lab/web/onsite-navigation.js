import {baseVisitId, isRepeatVisit} from './repeat-visits.js';
import {clockText} from './time-input.js';

const active = status => status === 'queue' || status === 'riding';
const rowKind = row => row.kind || row.type;

function visitName(park, id) {
  const facility = park.activities.find(item => item.id === baseVisitId(id));
  return facility ? facility.name + (isRepeatVisit(id) ? '（2回目）' : '') : '';
}

function describeLeg(row, park, result) {
  const kind = rowKind(row), id = row.activityId, facility = visitName(park, id);
  const visit = id && result.visits?.find(item => (item.id || item.activityId) === id);
  const title = kind === 'walk' && facility ? facility + 'へ移動' :
    kind === 'queue' && facility ? facility + 'の待ち列' :
    kind === 'activity' && facility ? facility : (row.name || '退園');
  const details = [clockText(row.start) + (row.end > row.start ? '–' + clockText(row.end) : '')];
  if (kind === 'walk' && row.metres > 0) details.push(Math.round(row.metres) + ' m');
  if (row.fixedBreakId) details.push('指定した休憩');
  if (visit?.method === 'dpa' || row.dpa) {
    const admission = visit?.queueStart ?? row.dpaAdmission ?? row.start;
    const ticket = result.purchases?.find(item => baseVisitId(item.id) === baseVisitId(id) &&
      item.start <= admission && admission < item.end);
    if (ticket) details.push('DPA' + (ticket.owned ? '取得済み' : '購入候補') +
      ' ' + clockText(ticket.start) + '–' + clockText(ticket.end));
  }
  if (['show','parade'].includes(visit?.category) && Number.isInteger(visit.start)) details.push(clockText(visit.start) + ' 開演');
  let edit;
  if (facility) {
    const status = kind === 'activity' ? 'done' : 'queue';
    edit = {id, status, label:status === 'done' ? '体験済みを記録' : '今並んでいる'};
  }
  return {title, detail:details.join(' · '), edit};
}

/** A timetable remains an estimate until a visitor explicitly reports an activity. */
export function onsiteNavigation(park, settings, result, {dirty = false, now = Date.now()} = {}) {
  const tokyo = new Date(now + 9 * 3600000);
  if (tokyo.toISOString().slice(0,10) !== settings.date) return null;
  const at = tokyo.getUTCHours() * 60 + tokyo.getUTCMinutes();
  if (at < settings.entry || at >= settings.exit) return null;
  const progress = settings.dayProgress;
  const records = progress?.parkId === park.id && progress.date === settings.date ? progress.visits ?? {} : {};
  const current = Object.entries(records).find(([,r]) => active(r.status) && r.startedAt <= at);
  const matching = !!result && (!result.parkId || result.parkId === park.id) &&
    (!result.settings?.date || result.settings.date === settings.date);
  if (!current && !matching) return null;
  const ahead = Number.isInteger(settings.replanFrom) && settings.replanFrom > at;
  const canUseTimetable = matching && result.status === 'feasible' && !dirty && !ahead;
  const legs = canUseTimetable ? (result.rows || []).filter(row =>
    ['walk','wait','queue','activity','rest','exit'].includes(rowKind(row)) &&
    !['done','skipped'].includes(records[row.activityId]?.status)) : [];
  const nextLeg = cutoff => legs.find(row => row.end > cutoff || (rowKind(row) === 'exit' && row.start === cutoff));
  const view = {at, canReplan:!ahead, label:'しおりの予定'};
  if (current) {
    const [id, record] = current, name = visitName(park, id);
    const overdue = record.endsAt <= at;
    const next = !overdue && legs.find(row => row.start >= record.endsAt && row.activityId !== id);
    return {...view, label:record.status === 'queue' ? '記録：並んでいる' : '記録：体験中',
      title:name, detail:clockText(record.endsAt) + (overdue ? 'の終了見込みを過ぎました。現在の状況を確認してください。' : ' 終了見込み'),
      next:next ? clockText(next.start) + ' ' + describeLeg(next,park,result).title : '',
      canReplan:!overdue && !ahead,
      edit:{id, status:record.status, label:'終了見込みを変更'}, finish:{id, status:'done', label:'体験済みを記録'}};
  }
  if (ahead) return {...view, title:'組み替え開始は' + clockText(settings.replanFrom), detail:'設定した時刻から現地の予定を表示します。'};
  if (!canUseTimetable) return {...view, title:dirty ? '条件が変更されています' : '残りの予定を見直す',
    detail:'現在時刻と体験記録を使って残りの予定を探せます。'};
  const row = nextLeg(at);
  if (!row) return {...view, title:'しおりの予定はここまでです', detail:'引き続き園内にいる場合は残りの予定を探せます。'};
  const displayed = describeLeg(row,park,result);
  const following = legs.find(item => item !== row && item.start >= row.end &&
    (rowKind(item) === 'activity' || rowKind(item) === 'rest' || rowKind(item) === 'exit'));
  return {...view, ...displayed, label:row.start <= at ? '今の予定' : '次の予定',
    next:following ? clockText(following.start) + ' ' + describeLeg(following,park,result).title : ''};
}

export function attachOnsiteNavigation({root, context, busy, editor, replan}) {
  const get = id => root.getElementById(id);
  const card = get('onsiteCard'), jump = get('onsiteJump');
  let current;
  function refresh() {
    const {park, settings, result, dirty, visible} = context();
    current = visible && park ? onsiteNavigation(park,settings,result,{dirty}) : null;
    card.hidden = !current;
    if (!current) {jump.hidden = true;return;}
    get('onsiteClock').dateTime = clockText(current.at);
    get('onsiteClock').textContent = clockText(current.at) + ' 現在';
    get('onsiteLabel').textContent = current.label;
    get('onsiteTitle').textContent = current.title;
    get('onsiteDetail').textContent = current.detail;
    const next = get('onsiteNext');
    next.hidden = !current.next;
    next.textContent = current.next ? 'このあと　' + current.next : '';
    for (const [id, action] of [['onsiteEdit',current.edit],['onsiteFinish',current.finish]]) {
      const button = get(id);
      button.hidden = !action;
      button.disabled = busy();
      if (action) button.textContent = action.label;
    }
    get('onsiteReplan').hidden = !current.canReplan;
    get('onsiteReplan').disabled = busy();
  }
  function act(key) {
    refresh(); // Time may have advanced while the phone was locked.
    if (!current || busy()) return;
    if (editor.hasDraft()) {
      const message = get('progressMessage');
      if (!message.classList.contains('is-error')) message.textContent = '入力中の体験状況を確認し、下のボタンで残りを組み替えられます。';
      editor.resumeDraft();
      return;
    }
    if (key === 'replan') {if (current.canReplan) replan(current.at);return;}
    const action = current[key];
    if (action) editor.open(action.id, action.status);
  }
  get('onsiteEdit').addEventListener('click',() => act('edit'));
  get('onsiteFinish').addEventListener('click',() => act('finish'));
  get('onsiteReplan').addEventListener('click',() => act('replan'));
  jump.addEventListener('click',() => {
    card.scrollIntoView({block:'start'});
    get('onsiteTitle').focus({preventScroll:true});
  });
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver(([entry]) => {
      jump.hidden = !current || card.hidden || entry.isIntersecting || entry.boundingClientRect.bottom >= 0;
    }).observe(card);
  }
  root.addEventListener('visibilitychange',() => {if (!root.hidden) refresh();});
  window.addEventListener('pageshow',refresh);
  // There are no timetable changes within a minute; background timers can be throttled.
  window.setInterval(() => {if (!root.hidden) refresh();}, 15000);
  return {refresh};
}
