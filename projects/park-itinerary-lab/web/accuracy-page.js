import {scoreForecastAccuracy} from './forecast-accuracy.js';

const dataRoot = 'https://raw.githubusercontent.com/shogo-ishikawa/2026_3Q_M4Th4/park-wait-data/';
const parks = {land: '東京ディズニーランド', sea: '東京ディズニーシー'};
const levels = {quiet: '比較的すいている', normal: 'ふつう', busy: '混み合う'};
const dayMs = 86400000;
const decimal = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 1});
const timestamp = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
});

const clock = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', hour:'numeric', minute:'2-digit', hourCycle:'h23'});

export function issuanceNote(result) {
  if (!result.issuedAt) return '';
  const time = Date.parse(result.issuedAt);
  if (dayInJapan(time) !== result.date) return '予測保存時刻 ' + timestamp.format(time) + '（日本時間）';
  return '当日' + clock.format(time) + '発行。発行後の予測枠だけを集計します。混雑の判定も照合できた時間帯に限ります。';
}

function dayInJapan(time) {
  return new Date(time + 9 * 3600000).toISOString().slice(0, 10);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
}

async function download(path, fetchImpl, signal) {
  const response = await fetchImpl(dataRoot + path, {signal, cache: 'no-cache'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('公開データの取得に失敗しました。');
  return response.json();
}

function checkedRows(payload) {
  if (payload === null) return [];
  if (!Array.isArray(payload)) throw new Error('観測データの形式を確認できませんでした。');
  return payload;
}

export async function loadAccuracyReport(date, parkId, {fetchImpl = fetch, signal, asOf = Date.now()} = {}) {
  if (!validDate(date) || !Object.hasOwn(parks, parkId)) throw new Error('対象日とパークを選んでください。');
  const today = dayInJapan(asOf);
  const base = {date, parkId, asOf, forecast: null, observations: []};
  if (date > today) return {result: scoreForecastAccuracy(base)};

  const forecast = await download('forecasts/' + date + '.json', fetchImpl, signal);
  if (forecast === null) return {result: scoreForecastAccuracy(base)};
  if (forecast.schemaVersion !== 1 || forecast.slotMinutes !== 30 || forecast.date !== date || !Array.isArray(forecast.parks)) {
    throw new Error('保存された予測の形式を確認できませんでした。');
  }
  base.forecast = forecast;
  const beforeObservations = scoreForecastAccuracy(base);
  if (beforeObservations.status !== 'no-observations') return {result: beforeObservations};

  const paths = ['history/' + date.slice(0, 7) + '.json'];
  if (Date.parse(today) - Date.parse(date) < 60 * dayMs) paths.push('observations.json');
  const records = await Promise.allSettled(paths.map(async path => checkedRows(await download(path, fetchImpl, signal))));
  if (signal?.aborted) throw signal.reason ?? new Error('中断しました。');
  const incompleteDownload = records.some(record => record.status === 'rejected');
  for (const record of records) {
    if (record.status === 'fulfilled') {
      base.observations = base.observations.concat(record.value.filter(row => row?.date === date));
    }
  }
  const result = scoreForecastAccuracy(base);
  if (incompleteDownload && !result.overall.matched) throw new Error('掲示待ち時間の記録を取得できませんでした。');
  return {result, incompleteDownload};
}

function tag(name, content, className) {
  const node = document.createElement(name);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function term(label, value) {
  const entry = tag('div');
  entry.append(tag('dt', label), tag('dd', value));
  return entry;
}

function section(title) {
  const section = tag('section');
  section.append(tag('h3', title));
  return section;
}

const minutes = value => Number.isFinite(value) ? decimal.format(value) + '分' : '—';
const percentage = value => Number.isFinite(value) ? decimal.format(value * 100) + '%' : '—';
const signedMinutes = value => Number.isFinite(value) && value > 0 ? '+' + minutes(value) : minutes(value);

function breakdown(title, firstColumn, rows, rowName) {
  const block = section(title);
  const wrap = tag('div', null, 'table-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', title);
  const table = tag('table');
  const header = table.createTHead().insertRow();
  for (const label of [firstColumn, '照合 / 対象', '平均予測', '平均掲示', '平均絶対誤差']) {
    const cell = tag('th', label);
    cell.scope = 'col';
    header.append(cell);
  }
  const body = table.createTBody();
  for (const metrics of rows) {
    const row = body.insertRow();
    const name = tag('th', rowName(metrics));
    name.scope = 'row';
    row.append(name);
    for (const value of [metrics.matched + ' / ' + metrics.expected, minutes(metrics.meanPredicted),
      minutes(metrics.meanObserved), minutes(metrics.mae)]) row.append(tag('td', value));
  }
  wrap.append(table);
  block.append(wrap);
  return block;
}

function crowdSection(crowd) {
  const block = section('パークの混雑');
  const readings = tag('dl', null, 'crowd-levels');
  readings.append(term('事前の予測', levels[crowd.forecastLevel] || '予測なし'),
    term('掲示待ち時間による判定', levels[crowd.observedLevel] || '記録不足'));
  block.append(readings, tag('p', '同じ施設・時間帯で、当日の掲示待ち時間が普段より長かったかを比べます。', 'note'));
  if (crowd.observedLevel) {
    block.append(tag('p', '判定に使えた施設は' + crowd.facilities + '施設です。', 'note'));
  } else {
    block.append(tag('p', '比較できる施設や時間帯がそろうと判定が出ます。', 'note'));
  }
  return block;
}

function waitSection(metrics) {
  const block = section('待ち時間の誤差');
  const readings = tag('dl', null, 'metrics');
  readings.append(term('平均絶対誤差', minutes(metrics.mae)), term('誤差10分以内', percentage(metrics.within10)),
    term('予測 − 掲示の平均', signedMinutes(metrics.bias)), term('照合できた割合', percentage(metrics.coverage)));
  block.append(readings, tag('p', '施設ごとに30分枠の掲示待ち時間の中央値と、その枠の予測値を比較します。', 'note'), tag('p', '予測と掲示の差がプラスなら、予測が長めです。', 'note'));
  if (metrics.baselineMatched && Number.isFinite(metrics.comparableMae) && Number.isFinite(metrics.baselineMae)) {
    block.append(tag('p', '普段の待ち時間も分かる' + metrics.baselineMatched + '件で比べると、平均絶対誤差はTDRouteの予測で' +
      minutes(metrics.comparableMae) + '、普段の待ち時間をそのまま使うと' + minutes(metrics.baselineMae) + 'です。'));
  }
  return block;
}

const statusText = {
  future: '当日の掲示待ち時間が集まると確認できます。',
  'no-forecast': 'この日の事前予測は保存されていません。精度を算出するには、予測時点の記録が必要です。',
  pending: '保存済みの予測を照合する時間帯がまだ終了していません。',
  'no-observations': '予測は保存されていますが、経過した予測枠と照合できる掲示記録がまだありません。',
  partial: '途中集計です。終了した時間帯までの掲示待ち時間を使っています。',
  complete: '予測の対象時間帯はすべて終了しました。保存された掲示記録の範囲で集計しています。'
};

function showReport(report, {result, incompleteDownload}) {
  report.replaceChildren();
  const top = tag('div', null, 'report-top');
  const heading = tag('div');
  const title = tag('h2', parks[result.parkId]);
  title.id = 'reportTitle';
  heading.append(tag('p', result.date + ' の精度レポート'), title);
  if (result.issuedAt) heading.append(tag('p', issuanceNote(result)));
  const print = tag('button', '印刷・PDF保存', 'print');
  print.type = 'button';
  print.addEventListener('click', () => window.print());
  top.append(heading, print);
  report.append(top, tag('p', statusText[result.status]));
  if (incompleteDownload) report.append(tag('p', '一部の観測データを取得できなかったため、読み込めた記録で集計しています。'));
  if (result.issuedAt) {
    const elapsed = result.hours.length ? '（' + result.hours[0].hour + '時台〜' + result.hours.at(-1).hour + '時台）' : '';
    report.append(tag('p', '事前に保存した施設別の予測枠は' + result.slotsInDay + '件。終了した' +
      result.overall.expected + '枠' + elapsed + 'のうち、掲示記録と照合できたのは' + result.overall.matched + '件です。', 'note'));
  }
  if (result.crowd?.forecastLevel || result.crowd?.observedLevel) report.append(crowdSection(result.crowd));
  if (result.overall.matched) {
    report.append(waitSection(result.overall));
    report.append(breakdown('時間帯別', '日本時間', result.hours, row => row.hour + '時台'));
    report.append(breakdown('施設別', '施設', result.facilities, row => row.name));
  }
  report.hidden = false;
}

function start() {
  const form = document.getElementById('reportForm');
  const date = document.getElementById('reportDate');
  const park = document.getElementById('reportPark');
  const report = document.getElementById('report');
  const status = document.getElementById('reportStatus');
  const params = new URLSearchParams(location.search);
  date.value = validDate(params.get('date')) ? params.get('date') : dayInJapan(Date.now());
  if (Object.hasOwn(parks, params.get('park'))) park.value = params.get('park');
  let current;

  function clear() {
    current?.abort();
    current = null;
    report.hidden = true;
    status.textContent = '';
    report.removeAttribute('aria-busy');
  }

  async function generate() {
    clear();
    if (!form.reportValidity()) return;
    const controller = new AbortController();
    current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    const url = new URL(location.href);
    url.searchParams.set('date', date.value);
    url.searchParams.set('park', park.value);
    history.replaceState(null, '', url);
    report.setAttribute('aria-busy', 'true');
    status.textContent = '公開されている予測と掲示記録を確認しています…';
    try {
      const payload = await loadAccuracyReport(date.value, park.value, {signal: controller.signal});
      if (current === controller) {
        showReport(report, payload);
        status.textContent = 'レポートを表示しました。';
      }
    } catch {
      if (current === controller) status.textContent = 'レポートを読み込めませんでした。通信状況を確認して、もう一度作成してください。';
    } finally {
      clearTimeout(timeout);
      if (current === controller) report.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('input', clear);
  form.addEventListener('submit', event => { event.preventDefault(); generate(); });
  generate();
}

if (typeof document !== 'undefined') start();
