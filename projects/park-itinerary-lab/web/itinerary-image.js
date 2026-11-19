import {checkedRows, formatTime} from './storage.js?v=2.6.0';
import {baseVisitId, isRepeatVisit} from './repeat-visits.js';

const WIDTH = 720;
const PAGE_HEIGHT = 1480;
const HEADER = 155;
const FOOTER = 54;
const TEXT_LEFT = 151;
const TEXT_WIDTH = WIDTH - TEXT_LEFT - 34;
const family = 'system-ui, "Hiragino Sans", "Yu Gothic", sans-serif';
const titleFont = '600 29px ' + family;
const detailFont = '22px ' + family;
const categories = {walk:'徒歩', wait:'時間調整', queue:'待ち列', activity:'体験', rest:'休憩', exit:'退園', location:'地点'};

function ticketLabel(plan, row) {
  if (!row.dpa) return '';
  const id = baseVisitId(row.activityId);
  const admission = row.dpaAdmission ?? (row.kind === 'queue' ? row.start :
    plan.visits?.find(v => (v.id || v.activityId) === row.activityId)?.queueStart ?? row.start);
  const ticket = plan.purchases?.find(p => baseVisitId(p.id) === id && p.start <= admission && admission < p.end);
  return ticket?.owned === true ? 'DPA取得済み' : ticket?.owned === false ? 'DPA購入候補' : 'DPAの予定';
}

export function itineraryImageRows(plan, park, settings) {
  const progress = settings.dayProgress;
  const records = progress?.parkId === park.id && progress.date === settings.date ? progress.visits || {} : {};
  const untimed = new Set(Object.entries(records).filter(([,r]) =>
    r.status === 'done' && r.startedAt == null && r.endsAt == null).map(([id])=>id));
  const nodes = new Map((park.nodes || []).map(n => [n.id, n.name]));
  const rows = [];
  for (const row of checkedRows(plan)) {
    const kind = row.kind || row.type;
    if (untimed.has(row.activityId) && (kind === 'activity' || kind === 'queue')) continue;
    const status = row.userProgress === 'done' ? '体験済み' : row.userProgress === 'riding' ? '体験中' :
      row.userProgress === 'queue' ? (kind === 'queue' ? '並んでいる' : '体験終了の見込み') : '';
    const place = nodes.get(row.node || row.to);
    const detail = [status || categories[kind], ticketLabel(plan, row), place].filter(Boolean).join(' · ');
    rows.push({start:formatTime(row.start), end:row.end === row.start ? '' : formatTime(row.end),
      title:row.name || categories[kind], detail, strong:kind === 'activity'});
  }
  // A previous planned time cannot supply a missing actual time.
  for (const id of untimed) {
    const facility = park.activities?.find(a => a.id === baseVisitId(id));
    rows.push({start:'時刻未記録', end:'', title:(facility?.name || baseVisitId(id)) + (isRepeatVisit(id) ? '（2回目）' : ''),
      detail:'体験済み', strong:true});
  }
  return rows;
}

function wrapText(ctx, text) {
  const lines = [];
  let line = '';
  for (const char of text) {
    if (line && ctx.measureText(line + char).width > TEXT_WIDTH) {
      lines.push(line); line = '';
    }
    line += char;
  }
  if (line) lines.push(line);
  return lines;
}

// Measure once, then draw only the page the visitor picked.
export function paginateItinerary(rows, ctx) {
  const pages = [];
  let page = {rows:[], height:HEADER + FOOTER};
  for (const row of rows) {
    ctx.font = titleFont;
    const title = wrapText(ctx, row.title);
    ctx.font = detailFont;
    const detail = wrapText(ctx, row.detail);
    const height = Math.max(84, title.length * 38 + detail.length * 30 + 24);
    if (page.rows.length && page.height + height > PAGE_HEIGHT) {
      pages.push(page); page = {rows:[], height:HEADER + FOOTER};
    }
    page.rows.push({...row, title, detail, height});
    page.height += height;
  }
  if (page.rows.length) pages.push(page);
  return pages;
}

function paintPage(canvas, page, park, settings, index, count) {
  canvas.width = WIDTH;
  canvas.height = page.height;
  const ctx = canvas.getContext('2d');
  const accent = park.id === 'sea' ? '#09627f' : '#5146a4';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, WIDTH, canvas.height);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, WIDTH, HEADER);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#fff'; ctx.font = 'bold 22px ' + family;
  ctx.fillText('TDRoute', 32, 19);
  ctx.font = 'bold 36px ' + family;
  ctx.fillText(park.name, 32, 53, WIDTH - 64);
  ctx.font = '23px ' + family;
  ctx.fillText(settings.date + '　' + formatTime(settings.entry) + '–' + formatTime(settings.exit), 32, 109);
  let y = HEADER;
  for (const row of page.rows) {
    ctx.fillStyle = row.strong ? (park.id === 'sea' ? '#eff7f8' : '#f4f2fa') : '#fff';
    ctx.fillRect(0, y, WIDTH, row.height);
    ctx.fillStyle = accent; ctx.font = (row.start === '時刻未記録' ? '19px ' : 'bold 27px ') + family;
    ctx.fillText(row.start, 30, y + 16);
    ctx.font = detailFont;
    if (row.end) ctx.fillText('–' + row.end, 30, y + 52);
    ctx.fillStyle = '#15263d'; ctx.font = titleFont;
    let lineY = y + 12;
    for (const line of row.title) { ctx.fillText(line, TEXT_LEFT, lineY); lineY += 38; }
    ctx.fillStyle = '#495a6c'; ctx.font = detailFont;
    for (const line of row.detail) { ctx.fillText(line, TEXT_LEFT, lineY); lineY += 30; }
    y += row.height;
    ctx.fillStyle = '#d2dbe5'; ctx.fillRect(28, y - 1, WIDTH - 56, 1);
  }
  ctx.font = '21px ' + family; ctx.fillStyle = '#495a6c';
  ctx.fillText('しおり作成時点の予定', 32, y + 14);
  ctx.textAlign = 'right'; ctx.fillText((index + 1) + ' / ' + count, WIDTH - 32, y + 14);
}

export function attachItineraryImage(root, read, safely, showSchedule) {
  const el = id => root.getElementById(id);
  const panel = el('itineraryImagePanel'), trigger = el('exportPng'), picker = el('imagePage');
  const preview = el('imagePreview'), link = el('downloadImage');
  let displayed = null, pages = [];
  function close() {
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    preview.removeAttribute('src'); link.removeAttribute('href');
    displayed = null; pages = [];
  }
  function showPage() {
    const {plan, park, settings} = read();
    if (!displayed || plan !== displayed) { close(); return; }
    const index = picker.selectedIndex;
    preview.removeAttribute('src'); link.removeAttribute('href');
    const canvas = root.createElement('canvas');
    paintPage(canvas, pages[index], park, settings, index, pages.length);
    const url = canvas.toDataURL('image/png');
    if (!url.startsWith('data:image/png;')) throw Error('画像を作成できませんでした。スマホ用しおりから予定表を保存できます。');
    const filename = 'TDRoute_' + park.id + '_' + settings.date + (pages.length > 1 ? '_' + (index + 1) + '-' + pages.length : '') + '.png';
    preview.src = url; link.href = url; link.download = filename;
  }
  function open() {
    const {plan, park, settings} = read();
    if (trigger.disabled || plan?.status !== 'feasible') return;
    const ctx = root.createElement('canvas').getContext('2d');
    if (!ctx) throw Error('画像を作成できませんでした。スマホ用しおりから予定表を保存できます。');
    pages = paginateItinerary(itineraryImageRows(plan, park, settings), ctx);
    if (!pages.length) throw Error('画像に保存する予定がありません。');
    displayed = plan;
    picker.replaceChildren(...pages.map((p,i) => {
      const option = root.createElement('option');
      option.textContent = (i + 1) + ' / ' + pages.length + '　' + p.rows[0].start;
      return option;
    }));
    el('imagePageLabel').hidden = pages.length === 1;
    showPage(); panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
  }
  trigger.addEventListener('click', safely(() => panel.hidden ? open() : close()));
  el('shareScheduleImage').addEventListener('click', safely(() => {
    showSchedule();
    if (panel.hidden) open();
    if (!panel.hidden) link.focus();
  }));
  picker.addEventListener('change', safely(showPage));
  return {refresh(plan, dirty) {
    trigger.disabled = !!dirty || plan?.status !== 'feasible';
    el('shareScheduleImage').hidden = trigger.disabled;
    if (displayed && (trigger.disabled || displayed !== plan)) close();
  }};
}
