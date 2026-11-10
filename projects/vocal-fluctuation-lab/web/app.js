/* Result viewer only. Audio processing and scientific estimates live in Python. */
(function () {
  'use strict';
  const SCHEMA = 'vocal-fluctuation-result-v1';
  const METHOD = 'rms-welch-v1';
  const MAX_RESULT_BYTES = 8 * 1024 * 1024;
  const DEMOS = {
    white: { title: '白色のゆらぎ', text: '細かな変化にもパワーが分かれる合成データです。1/fの直線と傾きがどう違うか見てみましょう。' },
    pink: { title: 'ピンクのゆらぎ', text: '1/fのパワースペクトルを目標に作った合成データです。有限の長さなので、傾きは厳密に−1にはなりません。' },
    brown: { title: '褐色のゆらぎ', text: 'ゆっくりした変化にパワーが偏る合成データです。ピンクのゆらぎより急な傾きが現れるか確かめましょう。' }
  };
  function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
  function numericArray(values, name, minimum) {
    if (!Array.isArray(values) || values.length > 100000 || !values.every(value => isNumber(value) && value >= minimum)) {
      throw new Error(name + 'の数値を読み取れません。Colabで保存したresult.jsonを選んでください。');
    }
    return values;
  }
  function pairedArrays(owner, xName, yName, name, positiveX) {
    if (!isObject(owner)) throw new Error(name + 'が見つかりません。');
    const x = numericArray(owner[xName], name + 'の横軸', 0);
    const y = numericArray(owner[yName], name + 'の縦軸', 0);
    if (x.length !== y.length || x.some((value, index) => (positiveX && value <= 0) || (index > 0 && value < x[index - 1]))) {
      throw new Error(name + 'の横軸と縦軸が対応していません。');
    }
  }
  function preprocessingReport(result) {
    const report = isObject(result.metadata) ? result.metadata.preprocessing : undefined;
    if (report === undefined) return null;
    if (!isObject(report) || report.method_id !== 'rms-silence-v1' || typeof report.timeline_modified !== 'boolean') {
      throw new Error('無音の調整に関する記録を確認できません。');
    }
    for (const key of ['input_duration_seconds', 'output_duration_seconds', 'leading_removed_seconds', 'trailing_removed_seconds', 'internal_removed_seconds']) {
      if (!isNumber(report[key]) || report[key] < 0) throw new Error('無音の調整に関する時間を読み取れません。');
    }
    if (report.output_duration_seconds > report.input_duration_seconds + .001 || !Array.isArray(report.kept_segments_seconds) || report.kept_segments_seconds.length > 10000) {
      throw new Error('無音の調整前後の時間が対応していません。');
    }
    let previousEnd = 0, keptDuration = 0;
    for (const segment of report.kept_segments_seconds) {
      if (!Array.isArray(segment) || segment.length !== 2 || !segment.every(isNumber) || segment[0] < previousEnd - .000001 || segment[1] <= segment[0] || segment[1] > report.input_duration_seconds + .001) {
        throw new Error('残した歌声の区間を確認できません。');
      }
      previousEnd = segment[1];
      keptDuration += segment[1] - segment[0];
    }
    const removedDuration = report.leading_removed_seconds + report.trailing_removed_seconds + report.internal_removed_seconds;
    const segments = report.kept_segments_seconds;
    if (!segments.length || Math.abs(keptDuration - report.output_duration_seconds) > .002 ||
        Math.abs(removedDuration + report.output_duration_seconds - report.input_duration_seconds) > .002 ||
        Math.abs(result.duration_seconds - report.output_duration_seconds) > .002 ||
        Math.abs(segments[0][0] - report.leading_removed_seconds) > .002 ||
        Math.abs(report.input_duration_seconds - segments[segments.length - 1][1] - report.trailing_removed_seconds) > .002 ||
        report.timeline_modified !== (report.internal_removed_seconds > 0)) {
      throw new Error('無音の除去秒数と残した区間が対応していません。');
    }
    return report;
  }
  function validateResult(result) {
    if (!isObject(result) || result.schema_version !== SCHEMA || result.method_id !== METHOD) {
      throw new Error('対応する解析結果ではありません。このツールで保存したresult.jsonを選んでください。');
    }
    if (!['near', 'not_near', 'inconclusive'].includes(result.status) || !isNumber(result.duration_seconds) || result.duration_seconds < 0 || !isObject(result.fit) || !isObject(result.quality)) {
      throw new Error('解析結果の形式を確認できません。result.jsonを保存し直してください。');
    }
    for (const key of ['slope', 'intercept', 'r_squared', 'band_low_hz', 'band_high_hz']) {
      if (result.fit[key] !== null && !isNumber(result.fit[key])) throw new Error('推定値に読み取れない数値があります。');
    }
    if (isNumber(result.fit.r_squared) && (result.fit.r_squared < 0 || result.fit.r_squared > 1.000001)) throw new Error('R²の値が範囲外です。');
    if (isNumber(result.fit.band_low_hz) && (result.fit.band_low_hz <= 0 || (!(result.fit.band_high_hz > result.fit.band_low_hz) && result.status !== 'inconclusive'))) throw new Error('解析した周波数範囲を確認できません。');
    pairedArrays(result.series, 'time_seconds', 'envelope', '音量の時間変化', false);
    pairedArrays(result.spectrum, 'frequency_hz', 'power', 'パワースペクトル', false);
    pairedArrays(result.spectrum, 'bin_frequency_hz', 'bin_power', 'まとめたパワースペクトル', true);
    if (typeof result.summary !== 'string' || result.summary.length > 3000) throw new Error('結果の説明を確認できません。');
    if (!Array.isArray(result.quality.reasons) || result.quality.reasons.length > 100 || result.quality.reasons.some(reason => typeof reason !== 'string' || reason.length > 2000)) throw new Error('解析条件の説明を確認できません。');
    preprocessingReport(result);
    return result;
  }
  function compactPoints(x, y, limit) {
    if (x.length <= limit) return x.map((value, index) => [value, y[index]]);
    // Keep both extremes in each interval, so brief volume changes remain visible.
    const points = [], bucket = Math.ceil(x.length / Math.floor(limit / 2));
    for (let start = 0; start < x.length; start += bucket) {
      const end = Math.min(x.length, start + bucket);
      let low = start, high = start;
      for (let index = start + 1; index < end; index++) {
        if (y[index] < y[low]) low = index;
        if (y[index] > y[high]) high = index;
      }
      for (const index of low === high ? [low] : [Math.min(low, high), Math.max(low, high)]) points.push([x[index], y[index]]);
    }
    return points;
  }
  const API = { validateResult, compactPoints, preprocessingReport, MAX_RESULT_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  let requestNumber = 0;
  function node(name, attributes, content) {
    const element = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function message(text, error) { $('viewer-message').textContent = text; $('viewer-message').classList.toggle('error', Boolean(error)); }
  function format(value, digits) { return isNumber(value) ? (Math.abs(value) >= 10000 ? value.toExponential(2) : value.toFixed(digits)) : '—'; }
  function text(svg, x, y, content, className, anchor) {
    svg.append(node('text', { x, y, class: className || 'tick', 'text-anchor': anchor || 'middle' }, content));
  }
  function path(points, xMap, yMap) {
    return points.map((point, index) => (index ? 'L' : 'M') + xMap(point[0]).toFixed(2) + ',' + yMap(point[1]).toFixed(2)).join(' ');
  }
  function emptyChart(svg, messageText) { svg.replaceChildren(); text(svg, 325, 130, messageText, 'empty-text'); }
  function drawEnvelope(result) {
    const svg = $('envelope-chart');
    const times = result.series.time_seconds, envelope = result.series.envelope;
    if (times.length < 2) return emptyChart(svg, '表示できる音量データがありません。');
    svg.replaceChildren();
    const left = 65, right = 628, top = 20, bottom = 214;
    const xEnd = Math.max(times[times.length - 1], .001);
    let yMax = envelope.reduce((maximum, value) => Math.max(maximum, value), 0);
    if (yMax <= 0) yMax = 1;
    yMax = Math.min(yMax, Number.MAX_VALUE / 1.08) * 1.08;
    const xMap = x => left + x / xEnd * (right - left);
    const yMap = y => bottom - y / yMax * (bottom - top);
    for (let index = 0; index <= 4; index++) {
      const x = left + index / 4 * (right - left);
      const y = top + index / 4 * (bottom - top);
      svg.append(node('line', { x1: left, y1: y, x2: right, y2: y, class: 'grid' }));
      text(svg, x, bottom + 21, format(xEnd * index / 4, 0));
    }
    svg.append(node('path', { d: `M${left},${top}V${bottom}H${right}`, class: 'axis', fill: 'none' }));
    const report = preprocessingReport(result);
    text(svg, 346, 255, report && report.timeline_modified ? '時間短縮後の経過時間 [秒]' : '解析開始からの経過時間 [秒]', 'axis-title');
    svg.append(node('text', { x: 17, y: 118, transform: 'rotate(-90 17 118)', class: 'axis-title', 'text-anchor': 'middle' }, '音の大きさ（RMS振幅）'));
    svg.append(node('path', { d: path(compactPoints(times, envelope, 1600), xMap, yMap), class: 'envelope-line' }));
    text(svg, left - 8, bottom + 4, '0', 'tick', 'end');
    text(svg, left - 8, top + 5, yMax.toPrecision(2), 'tick', 'end');
  }
  function drawSpectrum(result) {
    const svg = $('spectrum-chart');
    const spec = result.spectrum;
    const raw = spec.frequency_hz.map((f, index) => [f, spec.power[index]]).filter(point => point[0] > 0 && point[1] > 0);
    const bins = spec.bin_frequency_hz.map((f, index) => [f, spec.bin_power[index]]).filter(point => point[1] > 0);
    if (raw.length < 2 || bins.length < 2) return emptyChart(svg, 'スペクトルを推定できませんでした。');
    svg.replaceChildren();
    const left = 65, right = 628, top = 20, bottom = 247;
    const lower = Math.max(raw[0][0], isNumber(result.fit.band_low_hz) ? result.fit.band_low_hz / 2 : bins[0][0] / 2);
    const upper = Math.min(raw[raw.length - 1][0], isNumber(result.fit.band_high_hz) ? result.fit.band_high_hz * 1.4 : bins[bins.length - 1][0] * 1.4);
    const visible = raw.filter(point => point[0] >= lower && point[0] <= upper);
    if (visible.length < 2 || upper <= lower) return emptyChart(svg, '表示できる周波数範囲がありません。');
    const xMin = Math.log10(lower), xMax = Math.log10(upper);
    const powers = visible.map(point => Math.log10(point[1]));
    let yMin = powers.reduce((minimum, value) => Math.min(minimum, value), Infinity);
    let yMax = powers.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
    const padding = Math.max((yMax - yMin) * .08, .1);
    yMin -= padding; yMax += padding;
    const xMap = x => left + (Math.log10(x) - xMin) / (xMax - xMin) * (right - left);
    const yMap = y => bottom - (Math.log10(y) - yMin) / (yMax - yMin) * (bottom - top);
    for (let index = 0; index <= 4; index++) {
      const y = top + index / 4 * (bottom - top);
      const exponent = yMax - index / 4 * (yMax - yMin);
      svg.append(node('line', { x1: left, y1: y, x2: right, y2: y, class: 'grid' }));
      text(svg, left - 8, y + 4, '10^' + exponent.toFixed(1), 'tick', 'end');
    }
    for (const frequency of [.01, .02, .05, .1, .2, .5, 1, 2, 5, 10, 20, 50]) {
      if (frequency < lower || frequency > upper) continue;
      const x = xMap(frequency);
      svg.append(node('line', { x1: x, y1: top, x2: x, y2: bottom, class: 'grid' }));
      text(svg, x, bottom + 21, String(frequency));
    }
    svg.append(node('path', { d: `M${left},${top}V${bottom}H${right}`, class: 'axis', fill: 'none' }));
    text(svg, 346, 290, '変動周波数 [Hz]', 'axis-title');
    text(svg, left, 11, 'パワースペクトル密度（RMS振幅² / Hz）', 'axis-title', 'start');
    const defs = node('defs');
    const clip = node('clipPath', { id: 'spectrum-clip' });
    clip.append(node('rect', { x: left, y: top, width: right - left, height: bottom - top }));
    defs.append(clip); svg.append(defs);
    const lines = node('g', { 'clip-path': 'url(#spectrum-clip)' });
    svg.append(lines);
    lines.append(node('path', { d: path(compactPoints(visible.map(point => point[0]), visible.map(point => point[1]), 1600), xMap, yMap), class: 'raw-line' }));
    for (const point of bins) {
      if (point[0] >= lower && point[0] <= upper) lines.append(node('circle', { cx: xMap(point[0]), cy: yMap(point[1]), r: 3.4, class: 'bin-dot' }));
    }
    const fit = result.fit;
    if ([fit.slope, fit.intercept, fit.band_low_hz, fit.band_high_hz].every(isNumber)) {
      const ends = [fit.band_low_hz, fit.band_high_hz].map(frequency => [frequency, 10 ** (fit.intercept + fit.slope * Math.log10(frequency))]);
      if (ends.every(point => point[1] > 0 && Number.isFinite(point[1]))) lines.append(node('path', { d: path(ends, xMap, yMap), class: 'fit-line' }));
    }
  }
  function renderPreprocessing(result) {
    const report = preprocessingReport(result);
    const panel = $('preprocessing-report');
    panel.hidden = !report;
    if (!report) return;
    $('preprocessing-summary').textContent = '歌声の長さは調整前' + format(report.input_duration_seconds, 2) + '秒、調整後' + format(report.output_duration_seconds, 2) + '秒です。調整後の歌声を解析に使っています。';
    const settings = isObject(report.settings) ? report.settings : {};
    const labels = [];
    if (typeof settings.trim_edges === 'boolean') labels.push('前後の除去：' + (settings.trim_edges ? 'オン' : 'オフ'));
    if (typeof settings.remove_internal === 'boolean') labels.push('途中の除去：' + (settings.remove_internal ? 'オン' : 'オフ'));
    if (isNumber(settings.threshold_db)) labels.push('しきい値：' + format(settings.threshold_db, 0) + ' dB');
    if (isNumber(settings.min_silence_seconds)) labels.push('途中の最短無音：' + format(settings.min_silence_seconds, 2) + ' 秒');
    $('trim-settings').textContent = labels.join(' ／ ');
    $('trim-leading').textContent = format(report.leading_removed_seconds, 2) + ' 秒';
    $('trim-trailing').textContent = format(report.trailing_removed_seconds, 2) + ' 秒';
    $('trim-internal').textContent = format(report.internal_removed_seconds, 2) + ' 秒';
    $('trim-timeline').textContent = report.timeline_modified ? '途中の無音を除き、時間軸を短縮しています。加工後の歌声に対する参考値で、元の曲のリズムや時間的な相関をそのまま表す結果ではありません。' : '途中の時間をつなぎ直す処理はしていません。グラフは解析に使った歌声の開始からの経過時間です。';
    $('trim-timeline').classList.toggle('timeline-warning', report.timeline_modified);
    const segments = $('trim-segments');
    segments.replaceChildren();
    let elapsed = 0;
    report.kept_segments_seconds.slice(0, 20).forEach(segment => {
      const duration = segment[1] - segment[0];
      const item = document.createElement('li');
      item.textContent = '加工後 ' + format(elapsed, 2) + '〜' + format(elapsed + duration, 2) + '秒 ← 元の区間内 ' + format(segment[0], 2) + '〜' + format(segment[1], 2) + '秒';
      segments.append(item); elapsed += duration;
    });
    if (report.kept_segments_seconds.length > 20) {
      const item = document.createElement('li'); item.textContent = 'このほか' + (report.kept_segments_seconds.length - 20) + '区間。すべての対応は結果JSONに保存されています。'; segments.append(item);
    }
  }
  function render(result, title, source) {
    $('result-title').textContent = title;
    $('result-source').textContent = source;
    const badge = $('result-status');
    badge.textContent = { near: '指定条件で1/fに近い', not_near: '1/fに近いとは言えない', inconclusive: '判定保留' }[result.status];
    badge.classList.toggle('inconclusive', result.status === 'inconclusive');
    $('metric-slope').textContent = format(result.fit.slope, 2);
    $('metric-r2').textContent = format(result.fit.r_squared, 2);
    $('metric-band').textContent = isNumber(result.fit.band_low_hz) && result.fit.band_high_hz > result.fit.band_low_hz ? format(result.fit.band_low_hz, 2) + ' – ' + format(result.fit.band_high_hz, 2) + ' Hz' : '推定範囲なし';
    $('result-summary').textContent = result.summary;
    $('result-reasons').replaceChildren();
    for (const reason of result.quality.reasons) {
      const li = document.createElement('li'); li.textContent = reason; $('result-reasons').append(li);
    }
    renderPreprocessing(result); drawEnvelope(result); drawSpectrum(result); $('result-view').hidden = false;
  }
  function selectDemoButtons(name) {
    document.querySelectorAll('[data-demo]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.demo === name)));
  }
  async function loadDemo(name) {
    if (!Object.hasOwn(DEMOS, name)) return;
    const currentRequest = ++requestNumber;
    selectDemoButtons(name); message('計算済みの合成データを読み込んでいます。');
    try {
      const response = await fetch('data/demo-' + name + '.json');
      if (!response.ok) throw new Error('デモのデータを取得できませんでした。');
      const result = validateResult(await response.json());
      if (currentRequest !== requestNumber) return;
      render(result, DEMOS[name].title, 'SYNTHETIC DATA · 合成データ');
      message(DEMOS[name].text);
    } catch (error) {
      if (currentRequest === requestNumber) message('デモを読み込めませんでした。公開サイトで開くか、Colabで保存した結果JSONを選んでください。', true);
    }
  }
  $('result-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const currentRequest = ++requestNumber;
    if (file.size > MAX_RESULT_BYTES) { message('8MB以下の結果JSONを選んでください。音源ではなくresult.jsonを読み込みます。', true); return; }
    try {
      const result = validateResult(JSON.parse(await file.text()));
      if (currentRequest !== requestNumber) return;
      selectDemoButtons(''); render(result, '読み込んだ解析結果', 'YOUR RESULT · ' + file.name.slice(0, 120));
      message('結果JSONを読み込みました。このページからファイルを送信することはありません。');
    } catch (error) {
      if (currentRequest === requestNumber) message(error instanceof SyntaxError ? 'JSONを読み取れません。Colabで保存したresult.jsonを選んでください。' : error.message, true);
    }
  });
  document.querySelectorAll('[data-demo]').forEach(button => button.addEventListener('click', () => loadDemo(button.dataset.demo)));
  loadDemo('pink');
}());
