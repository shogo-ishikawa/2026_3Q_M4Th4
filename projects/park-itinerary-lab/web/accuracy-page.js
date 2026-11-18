import {scoreForecastAccuracy} from './forecast-accuracy.js?v=2.2.1';

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
  if (signal?.aborted) throw signal.reason ?? new Error('中断しました。');
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

function historySummary(data, forecast) {
  if (data === null) return null;
  if (data.schemaVersion !== 1 || data.source !== 'themeparks-wiki' ||
      data.method !== 'latest-standby-change-per-slot' || data.date !== forecast.date || !Array.isArray(data.parks)) {
    throw new Error('履歴の集計形式を確認できませんでした。');
  }
  const park = data.parks.find(item => item?.parkId === forecast.parkId);
  if (!park) return null;
  if (park.issuedAt !== forecast.issuedAt || park.expected !== forecast.slotsInDay ||
      !Number.isInteger(park.matched) || park.matched < 5 || park.matched > park.expected ||
      !Number.isFinite(park.mae) || park.mae < 0 || !Number.isFinite(park.bias) ||
      !Number.isFinite(park.within10) || park.within10 < 0 || park.within10 > 1) {
    throw new Error('履歴と事前予測の対応を確認できませんでした。');
  }
  return {...park, coverage:park.matched / park.expected};
}

function savedQueueScore(data, forecast) {
  if (data?.schemaVersion !== 1 || data.source !== 'queue-times' || data.method !== 'median-per-slot' ||
      data.date !== forecast.date || !Array.isArray(data.parks)) return null;
  const park = data.parks.find(item => item?.parkId === forecast.parkId);
  if (park?.date !== forecast.date || park.issuedAt !== forecast.issuedAt ||
      park.slotsInDay !== forecast.slotsInDay || !Array.isArray(park.facilities) ||
      !Array.isArray(park.hours) || !park.crowd || !park.overall) return null;
  const {expected, matched, mae, within10, bias} = park.overall;
  if (expected !== forecast.slotsInDay || !Number.isInteger(matched) || matched < 0 || matched > expected) return null;
  // Earlier daily reports omit the crowd denominator. It comes from the same frozen forecast.
  const scored = {...park, crowd:{expected:forecast.crowd.expected, ...park.crowd}};
  if (!expected) return park.status === 'no-forecast' ? scored : null;
  if (!matched) return park.status === 'no-observations' ? scored : null;
  if (park.status !== 'complete' || !Number.isFinite(mae) || mae < 0 || !Number.isFinite(bias) ||
      !Number.isFinite(within10) || within10 < 0 || within10 > 1) return null;
  return scored;
}

async function queueReport(base, initial, checkSaved, today, fetchImpl, signal) {
  if (checkSaved) {
    try {
      // Leave time for the raw archive if this small per-day file stalls.
      let dailySignal = signal;
      if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
        const deadline = AbortSignal.timeout(5000);
        dailySignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      }
      const daily = await download('accuracy-daily/' + base.date + '.json', fetchImpl, dailySignal);
      const saved = savedQueueScore(daily, initial);
      if (saved) return {queueTimes:saved, savedDaily:true, queueIncomplete:false};
    } catch {
      // The monthly and rolling records can still serve dates without a usable daily score.
    }
  }
  if (initial.status === 'no-forecast') return {queueTimes:initial, savedDaily:false, queueIncomplete:false};
  const paths = ['history/' + base.date.slice(0, 7) + '.json'];
  if (Date.parse(today) - Date.parse(base.date) < 60 * dayMs) paths.push('observations.json');
  const records = await Promise.allSettled(paths.map(async path => checkedRows(await download(path, fetchImpl, signal))));
  for (const record of records) {
    if (record.status === 'fulfilled') {
      base.observations = base.observations.concat(record.value.filter(row => row?.date === base.date));
    }
  }
  return {queueTimes:scoreForecastAccuracy(base), savedDaily:false, queueIncomplete:records.some(record => record.status === 'rejected')};
}

export async function loadAccuracyReport(date, parkId, {fetchImpl = fetch, signal, asOf = Date.now()} = {}) {
  if (!validDate(date) || !Object.hasOwn(parks, parkId)) throw new Error('対象日とパークを選んでください。');
  const today = dayInJapan(asOf);
  const base = {date, parkId, asOf, forecast: null, observations: []};
  if (date > today) return {result: scoreForecastAccuracy(base)};

  const forecast = await download('forecasts/' + date + '.json', fetchImpl, signal);
  if (forecast !== null && (forecast.schemaVersion !== 1 || forecast.slotMinutes !== 30 ||
      forecast.date !== date || !Array.isArray(forecast.parks))) {
    throw new Error('保存された予測の形式を確認できませんでした。');
  }
  base.forecast = forecast;
  const initial = scoreForecastAccuracy(base);
  if (initial.status === 'pending') return {result:initial};
  const dayFinished = initial.slotsInDay > 0 && initial.overall.expected === initial.slotsInDay;
  const checkSaved = dayFinished || initial.status === 'no-forecast';
  const daily = queueReport(base, initial, checkSaved, today, fetchImpl, signal);
  const historical = dayFinished
    ? download('accuracy-history/' + date + '.json', fetchImpl, signal).then(data => historySummary(data, initial))
    : null;
  const [queue, history] = await Promise.allSettled([daily, historical]);
  if (signal?.aborted && signal.reason?.name !== 'TimeoutError') throw signal.reason ?? new Error('中断しました。');
  if (queue.status === 'rejected') throw queue.reason;
  const {queueTimes, savedDaily, queueIncomplete} = queue.value;
  const historyComparison = history.status === 'fulfilled' ? history.value : null;
  const historyUnavailable = history.status === 'rejected';
  if ((queueIncomplete || historyUnavailable) && !savedDaily && !queueTimes.overall.matched && !historyComparison) {
    throw new Error('掲示待ち時間の記録を取得できませんでした。');
  }
  // Keep the two samples separate: the providers can cover the same facility and time.
  const preferHistory = historyComparison && historyComparison.matched > queueTimes.overall.matched;
  const result = preferHistory
    ? {...queueTimes, status:'complete', provider:'themeparks-wiki', overall:historyComparison}
    : {...queueTimes, provider:'queue-times'};
  return {result, queueTimes, savedDaily, historyComparison, queueIncomplete, historyUnavailable,
    incompleteDownload:queueIncomplete || historyUnavailable};
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

export function crowdReading(crowd) {
  if (!crowd) return '記録不足';
  const result = levels[crowd.observedLevel] || '判定保留';
  if (!Number.isInteger(crowd.expected) || !Number.isInteger(crowd.matched)) return result;
  if (!crowd.expected) return '判定保留（比較対象の時間枠なし）';
  return result + '（' + crowd.expected + '基準枠のうち' + crowd.matched + '枠を照合）';
}

function crowdSection(queueCrowd, historyComparison) {
  const block = section('パークの混雑');
  const readings = tag('dl', null, 'crowd-levels');
  readings.append(term('事前の予測', levels[queueCrowd.forecastLevel] || '予測なし'),
    term('Queue-Timesによる判定', crowdReading(queueCrowd)));
  if (historyComparison) {
    readings.append(term('ThemeParks.wikiによる判定', crowdReading(historyComparison.crowd)));
  }
  block.append(readings, tag('p', '同じ施設・時間帯の普段の掲示待ち時間と比べます。3施設以上で各2枠以上、全体で3時間帯以上が判定の目安です。', 'note'));
  return block;
}

function waitSection(metrics, provider) {
  const block = section(provider + 'との待ち時間の比較');
  const readings = tag('dl', null, 'metrics');
  readings.append(term('平均絶対誤差', minutes(metrics.mae)), term('誤差10分以内', percentage(metrics.within10)),
    term('予測 − 掲示の平均', signedMinutes(metrics.bias)), term('照合できた割合', percentage(metrics.coverage)));
  const comparison = provider === 'Queue-Times' ? '枠内に収集した掲示値の中央値' : '枠内で最後に更新された通常列の掲示値';
  block.append(readings, tag('p', '対象' + metrics.expected + '枠のうち' + metrics.matched + '枠で、' +
    comparison + 'と予測を比べました。差がプラスなら予測が長めです。', 'note'));
  if (metrics.baselineMatched && Number.isFinite(metrics.comparableMae) && Number.isFinite(metrics.baselineMae)) {
    block.append(tag('p', '普段の待ち時間も分かる' + metrics.baselineMatched + '件で比べると、平均絶対誤差はTDRouteの予測で' +
      minutes(metrics.comparableMae) + '、普段の待ち時間をそのまま使うと' + minutes(metrics.baselineMae) + 'です。'));
  }
  return block;
}

function intradaySection(comparison) {
  if (comparison?.source !== 'queue-times' || !(comparison.expected > 0) ||
      !Number.isInteger(comparison.matched) || comparison.matched < 0 || comparison.matched > comparison.expected) return null;
  const block = section('当日補正を加えた予測の精度');
  const metrics = tag('dl', null, 'metrics');
  metrics.append(term('当初の予測のMAE', minutes(comparison.originalMae)),
    term('当日補正後のMAE', minutes(comparison.correctedMae)),
    term('照合できた枠', comparison.matched + ' / ' + comparison.expected),
    term('照合率', percentage(comparison.coverage)));
  block.append(metrics, tag('p', '対象は、時間枠の中央まで75分以上105分未満の時点で当日補正を発行できた施設です。' +
    '収集時のQueue-Timesの掲示値とその時間枠の事前予測から補正し、当初の予測と補正後の予測を同じ枠の掲示値の中央値で比べました。', 'note'));
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

function showReport(report, {result, queueTimes = result, savedDaily, historyComparison, queueIncomplete, historyUnavailable}) {
  report.replaceChildren();
  const top = tag('div', null, 'report-top');
  const heading = tag('div');
  const title = tag('h2', parks[result.parkId]);
  title.id = 'reportTitle';
  heading.append(tag('p', result.date + (savedDaily ? ' 閉園後の精度レポート' : ' の精度レポート')), title);
  if (result.issuedAt) heading.append(tag('p', issuanceNote(result)));
  const print = tag('button', '印刷・PDF保存', 'print');
  print.type = 'button';
  print.addEventListener('click', () => window.print());
  top.append(heading, print);
  const message = savedDaily && result.status === 'no-observations'
    ? '閉園後に検証しましたが、予測と照合できるQueue-Timesの掲示記録は0件でした。'
    : statusText[result.status];
  report.append(top, tag('p', message));
  if (savedDaily && !queueTimes.overall.matched && historyComparison) {
    report.append(tag('p', 'Queue-Timesの閉園後集計では対象' + queueTimes.overall.expected + '枠のうち照合できた枠は0件でした。', 'note'));
  }
  if (queueIncomplete) report.append(tag('p', 'Queue-Timesの一部の記録を取得できませんでした。'));
  if (historyUnavailable) report.append(tag('p', 'ThemeParks.wikiの日別集計を読み込めませんでした。'));
  if (result.issuedAt) {
    const elapsed = queueTimes.hours.length ? '（' + queueTimes.hours[0].hour + '時台〜' + queueTimes.hours.at(-1).hour + '時台）' : '';
    const source = result.provider === 'themeparks-wiki' ? 'ThemeParks.wiki' : 'Queue-Times';
    const counts = '保存した' + result.slotsInDay + '枠のうち、終了した枠は' + result.overall.expected + '件' + elapsed + 'です。';
    const matched = result.overall.matched ? source + 'の掲示値と' + result.overall.matched + '枠を照合しました。' : '';
    report.append(tag('p', counts + matched, 'note'));
  }
  const queueMatched = queueTimes.overall.matched;
  if (historyComparison && queueMatched) report.append(tag('p', '同じ枠を両方の情報源が記録することがあります。照合件数と誤差は情報源ごとに集計しています。', 'note'));
  if (result.provider === 'themeparks-wiki') report.append(waitSection(historyComparison, 'ThemeParks.wiki'));
  if (queueMatched) report.append(waitSection(queueTimes.overall, 'Queue-Times'));
  const intraday = intradaySection(queueTimes.intradayComparison);
  if (intraday) report.append(intraday);
  if (historyComparison && result.provider !== 'themeparks-wiki') report.append(waitSection(historyComparison, 'ThemeParks.wiki'));
  if (queueTimes.crowd?.forecastLevel || queueTimes.crowd?.observedLevel || historyComparison?.crowd?.observedLevel) {
    report.append(crowdSection(queueTimes.crowd, historyComparison));
  }
  if (queueMatched) {
    report.append(breakdown('時間帯別（Queue-Times）', '日本時間', queueTimes.hours, row => row.hour + '時台'));
    report.append(breakdown('施設別（Queue-Times）', '施設', queueTimes.facilities, row => row.name));
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
    const timeout = setTimeout(() => controller.abort(new DOMException('取得時間を超えました。', 'TimeoutError')), 20000);
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
