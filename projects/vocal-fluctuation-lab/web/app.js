/* Educational diagrams only. Music-file processing and scientific estimates live in Python. */
(function () {
  'use strict';
  const SCHEMA = 'vocal-fluctuation-result-v1';
  // Both versions share these display fields. Keep the recorded method unchanged;
  // accepting an old result for display does not make it comparable in the DB.
  const METHODS = new Set(['rms-welch-v1', 'rms-welch-v2']);
  const MAX_RESULT_BYTES = 8 * 1024 * 1024;
  const MAX_RESULT_POINTS = 600 * 200;
  const DEMOS = {
    white: { title: '白色のゆらぎ', text: '細かな変化にもパワーが分かれる合成データです。1/fの直線と傾きがどう違うか見てみましょう。' },
    pink: { title: 'ピンクのゆらぎ', text: '1/fのパワースペクトルを目標に作った合成データです。有限の長さなので、傾きは厳密に−1にはなりません。' },
    brown: { title: '褐色のゆらぎ', text: 'ゆっくりした変化にパワーが偏る合成データです。ピンクのゆらぎより急な傾きが現れるか確かめましょう。' }
  };
  function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
  function numericArray(values, name, minimum) {
    if (!Array.isArray(values) || values.length > MAX_RESULT_POINTS || !values.every(value => isNumber(value) && value >= minimum)) {
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
    if (!isObject(result) || result.schema_version !== SCHEMA || !METHODS.has(result.method_id)) {
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
  function spectrumTickValues(low, high) {
    return [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20]
      .filter(value => value >= low / 2 && value <= high * 1.4);
  }
  // 図の数値を作る部分。波形の形と成分のパワーを別々に確かめられます。
  function makeToneWave(amplitude, frequency, durationMs = 12, count = 1201) {
    return Array.from({ length: count }, (_, index) => {
      const timeMs = durationMs * index / (count - 1);
      return [timeMs, amplitude * Math.sin(2 * Math.PI * frequency * timeMs / 1000)];
    });
  }
  function componentPowers(ratio) {
    const first = 0.6 * 0.6 / 2;
    return [first, first * ratio * ratio];
  }
  function makeCombinedWave(ratio) {
    const first = makeToneWave(0.6, 220);
    const second = makeToneWave(0.6 * ratio, 440);
    return first.map((point, index) => [point[0], point[1] + second[index][1]]);
  }
  function envelopeModel(time) {
    return 0.55 + 0.3 * Math.sin(2 * Math.PI * 0.5 * time);
  }
  const API = { validateResult, compactPoints, preprocessingReport, spectrumTickValues, MAX_RESULT_BYTES,
    makeToneWave, componentPowers, makeCombinedWave, envelopeModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  function node(name, attributes, content) {
    const element = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function text(svg, x, y, content, className = 'tick', anchor = 'middle') {
    svg.append(node('text', { x, y, class: className, 'text-anchor': anchor }, content));
  }
  function line(svg, x1, y1, x2, y2, className) {
    svg.append(node('line', { x1, y1, x2, y2, class: className }));
  }
  function path(points, xMap, yMap) {
    return points.map((point, index) => (index ? 'L' : 'M') + xMap(point[0]).toFixed(2) + ',' + yMap(point[1]).toFixed(2)).join(' ');
  }
  function curve(svg, points, xMap, yMap, className) {
    svg.append(node('path', { d: path(points, xMap, yMap), class: className }));
  }
  function frame(svg, options) {
    svg.replaceChildren();
    const { width, height, xMax, yMin, yMax, xTicks, yTicks, xLabel, yLabel } = options;
    const left = 62, right = width - 20, top = 29, bottom = height - 50;
    const xMap = value => left + value / xMax * (right - left);
    const yMap = value => bottom - (value - yMin) / (yMax - yMin) * (bottom - top);
    for (const value of yTicks) {
      line(svg, left, yMap(value), right, yMap(value), value === 0 ? 'zero' : 'grid');
      text(svg, left - 8, yMap(value) + 4, String(value), 'tick', 'end');
    }
    for (const value of xTicks) {
      line(svg, xMap(value), top, xMap(value), bottom, 'grid');
      text(svg, xMap(value), bottom + 21, String(value));
    }
    line(svg, left, top, left, bottom, 'axis');
    line(svg, left, bottom, right, bottom, 'axis');
    text(svg, left, 13, yLabel, 'axis-title', 'start');
    text(svg, (left + right) / 2, height - 6, xLabel, 'axis-title');
    return { xMap, yMap, left, right, top, bottom };
  }

  function drawHero() {
    const svg = $('hero-wave');
    const axes = frame(svg, { width: 560, height: 280, xMax: 12, yMin: -1.1, yMax: 1.1,
      xTicks: [0, 4, 8, 12], yTicks: [-1, 0, 1], xLabel: '時間 [ミリ秒]', yLabel: '圧力の変化（相対値）' });
    curve(svg, makeCombinedWave(0.5), axes.xMap, axes.yMap, 'wave-line');
  }
  function drawSound() {
    const amplitude = Number($('wave-amplitude').value);
    const frequency = Number($('wave-frequency').value);
    $('amplitude-value').textContent = amplitude.toFixed(2);
    $('frequency-value').textContent = frequency + ' Hz';
    const axes = frame($('sound-wave'), { width: 900, height: 285, xMax: 12, yMin: -1.1, yMax: 1.1,
      xTicks: [0, 2, 4, 6, 8, 10, 12], yTicks: [-1, -0.5, 0, 0.5, 1], xLabel: '時間 [ミリ秒]　1ミリ秒 = 0.001秒', yLabel: '圧力の変化（相対値）' });
    curve($('sound-wave'), makeToneWave(amplitude, frequency), axes.xMap, axes.yMap, 'wave-line');
    $('wave-observation').textContent = amplitude === 0 ? '振れ幅が0なので、圧力は変化せず、合成音も無音になります。' : '1回の繰り返しは約' + (1000 / frequency).toFixed(2) + 'ミリ秒。この12ミリ秒の中に、約' + (frequency * 0.012).toFixed(2) + '回の波が入っています。';
    updatePlayingTone(amplitude, frequency);
  }
  function drawComponents() {
    const ratio = Number($('harmonic-ratio').value);
    $('harmonic-value').textContent = '220 Hzの' + ratio.toFixed(2) + '倍';
    const waveSvg = $('combined-wave');
    const waveAxes = frame(waveSvg, { width: 620, height: 295, xMax: 12, yMin: -1.25, yMax: 1.25,
      xTicks: [0, 4, 8, 12], yTicks: [-1, 0, 1], xLabel: '時間 [ミリ秒]', yLabel: '圧力の変化（相対値）' });
    curve(waveSvg, makeToneWave(0.6, 220), waveAxes.xMap, waveAxes.yMap, 'base-line');
    curve(waveSvg, makeToneWave(0.6 * ratio, 440), waveAxes.xMap, waveAxes.yMap, 'harmonic-line');
    curve(waveSvg, makeCombinedWave(ratio), waveAxes.xMap, waveAxes.yMap, 'wave-line');
    const spectrumSvg = $('tone-spectrum');
    const axes = frame(spectrumSvg, { width: 620, height: 295, xMax: 660, yMin: 0, yMax: 0.22,
      xTicks: [0, 220, 440, 660], yTicks: [0, 0.1, 0.2], xLabel: '音の周波数 [Hz]', yLabel: '成分のパワー（相対値）' });
    componentPowers(ratio).forEach((power, index) => {
      const x = axes.xMap((index + 1) * 220), y = axes.yMap(power);
      spectrumSvg.append(node('rect', { x: x - 34, y, width: 68, height: axes.bottom - y, fill: index ? '#b58d60' : '#337f72', rx: 3 }));
      text(spectrumSvg, x, y - 10, power.toFixed(3), 'tick');
    });
    $('spectrum-observation').textContent = '440 Hzの振幅は220 Hzの' + ratio.toFixed(2) + '倍、パワーは' + (ratio * ratio).toFixed(2) + '倍です。220 Hzの成分の棒は変わりません。';
  }
  function drawEnvelopeModel() {
    const svg = $('envelope-example');
    const axes = frame(svg, { width: 700, height: 270, xMax: 10, yMin: -1, yMax: 1,
      xTicks: [0, 2, 4, 6, 8, 10], yTicks: [-1, 0, 1], xLabel: '時間 [秒]', yLabel: '振れ幅の外側（模式図）' });
    const upper = Array.from({ length: 601 }, (_, index) => [index / 60, envelopeModel(index / 60)]);
    const lower = upper.map(point => [point[0], -point[1]]);
    const outline = upper.concat([...lower].reverse());
    svg.append(node('path', { d: path(outline, axes.xMap, axes.yMap) + 'Z', fill: '#dae5d1', opacity: 0.8 }));
    curve(svg, lower, axes.xMap, axes.yMap, 'outline-line');
    curve(svg, upper, axes.xMap, axes.yMap, 'wave-line');
    text(svg, axes.xMap(8), axes.yMap(0.6), '0.5 Hzで振れ幅が変化', 'model-label');
  }

  let audioContext = null, oscillator = null, gain = null, toneEnd = 0;
  function finishTone(announce = true) {
    oscillator = null;
    if (gain) gain.disconnect();
    gain = null;
    $('play-tone').disabled = false;
    $('stop-tone').disabled = true;
    if (announce) $('tone-status').textContent = '再生を停止しました。図の値を変えて、もう一度比べられます。';
  }
  function stopTone() {
    if (!oscillator || !audioContext) return;
    try {
      const now = audioContext.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, 0.005);
      oscillator.stop(now + 0.03);
    } catch (_) { finishTone(); }
  }
  function updatePlayingTone(amplitude, frequency) {
    if (!oscillator || !audioContext) return;
    const now = audioContext.currentTime;
    oscillator.frequency.setTargetAtTime(frequency, now, 0.02);
    if (now < toneEnd - 0.05) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0.06 * amplitude, now, 0.01);
      gain.gain.setValueAtTime(0.06 * amplitude, toneEnd - 0.025);
      gain.gain.linearRampToValueAtTime(0, toneEnd);
    }
    $('tone-status').textContent = '再生中：' + frequency + ' Hz。波形と同じ設定の合成音です。3秒で自動停止します。';
  }
  async function playTone() {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) {
      $('tone-status').textContent = 'このブラウザでは合成音を再生できません。図を動かして違いを確かめられます。';
      return;
    }
    $('play-tone').disabled = true;
    try {
      if (!audioContext) audioContext = new AudioContextType();
      await audioContext.resume();
      oscillator = audioContext.createOscillator();
      gain = audioContext.createGain();
      const now = audioContext.currentTime;
      toneEnd = now + 3;
      const amplitude = Number($('wave-amplitude').value), frequency = Number($('wave-frequency').value);
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06 * amplitude, now + 0.025);
      gain.gain.setValueAtTime(0.06 * amplitude, toneEnd - 0.025);
      gain.gain.linearRampToValueAtTime(0, toneEnd);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.onended = () => { oscillator.disconnect(); finishTone(); };
      oscillator.start(now); oscillator.stop(toneEnd);
      $('stop-tone').disabled = false;
      $('tone-status').textContent = '再生中：' + frequency + ' Hz。波形と同じ設定の合成音です。3秒で自動停止します。';
    } catch (_) {
      if (oscillator) { oscillator.onended = null; try { oscillator.stop(); oscillator.disconnect(); } catch (_) {} }
      finishTone(false);
      $('tone-status').textContent = '合成音を再生できませんでした。図の操作はそのまま使えます。';
    }
  }

  let requestNumber = 0;
  function drawDemoEnvelope(result) {
    const times = result.series.time_seconds, envelope = result.series.envelope;
    const yMax = Math.max(3, envelope.reduce((maximum, value) => Math.max(maximum, value), 0) * 1.05);
    const axes = frame($('envelope-chart'), { width: 650, height: 290, xMax: result.duration_seconds,
      yMin: 0, yMax, xTicks: [0, 30, 60, 90, 120].filter(value => value <= result.duration_seconds),
      yTicks: [0, 1, 2, 3].filter(value => value <= yMax), xLabel: '時間 [秒]', yLabel: '音量の変化（合成値）' });
    curve($('envelope-chart'), compactPoints(times, envelope, 1600), axes.xMap, axes.yMap, 'envelope-line');
  }
  function drawDemoSpectrum(result) {
    const svg = $('spectrum-chart');
    svg.replaceChildren();
    const spectrum = result.spectrum;
    const low = result.fit.band_low_hz, high = result.fit.band_high_hz;
    const raw = spectrum.frequency_hz.map((frequency, index) => [frequency, spectrum.power[index]])
      .filter(point => point[0] >= low / 2 && point[0] <= high * 1.4 && point[1] > 0);
    const bins = spectrum.bin_frequency_hz.map((frequency, index) => [frequency, spectrum.bin_power[index]]);
    if (raw.length < 2 || bins.length < 2) return;
    const left = 69, right = 630, top = 30, bottom = 260;
    const xMin = Math.log10(low / 2), xMax = Math.log10(high * 1.4);
    const powers = raw.map(point => Math.log10(point[1]));
    let yMin = Math.min(...powers), yMax = Math.max(...powers);
    const pad = Math.max((yMax - yMin) * 0.1, 0.15);
    yMin -= pad; yMax += pad;
    const xMap = value => left + (Math.log10(value) - xMin) / (xMax - xMin) * (right - left);
    const yMap = value => bottom - (Math.log10(value) - yMin) / (yMax - yMin) * (bottom - top);
    for (let index = 0; index <= 4; index++) {
      const exponent = yMin + index / 4 * (yMax - yMin), y = yMap(10 ** exponent);
      line(svg, left, y, right, y, 'grid');
      text(svg, left - 8, y + 4, '10^' + exponent.toFixed(1), 'tick', 'end');
    }
    for (const value of spectrumTickValues(low, high)) {
      line(svg, xMap(value), top, xMap(value), bottom, 'grid');
      text(svg, xMap(value), bottom + 22, String(value));
    }
    line(svg, left, top, left, bottom, 'axis'); line(svg, left, bottom, right, bottom, 'axis');
    text(svg, left, 13, '変動のパワー密度（合成値² / Hz）', 'axis-title', 'start');
    text(svg, (left + right) / 2, 309, '音量が変わる速さ・変動周波数 [Hz]', 'axis-title');
    const clipId = 'demo-spectrum-clip';
    const defs = node('defs'), clip = node('clipPath', { id: clipId });
    clip.append(node('rect', { x: left, y: top, width: right - left, height: bottom - top }));
    defs.append(clip); svg.append(defs);
    const plotted = node('g', { 'clip-path': 'url(#' + clipId + ')' }); svg.append(plotted);
    curve(plotted, raw, xMap, yMap, 'raw-line');
    bins.forEach(point => plotted.append(node('circle', { cx: xMap(point[0]), cy: yMap(point[1]), r: 3.4, class: 'bin-dot' })));
    if (isNumber(result.fit.slope) && isNumber(result.fit.intercept)) {
      const fitted = [low, high].map(frequency => [frequency, 10 ** (result.fit.intercept + result.fit.slope * Math.log10(frequency))]);
      curve(plotted, fitted, xMap, yMap, 'fit-line');
    }
  }
  async function loadDemo(kind) {
    if (!Object.hasOwn(DEMOS, kind)) return;
    const currentRequest = ++requestNumber;
    document.querySelectorAll('[data-demo]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.demo === kind)));
    $('viewer-message').textContent = '合成データを読み込んでいます。';
    $('viewer-message').classList.remove('error');
    try {
      const response = await fetch('data/demo-' + kind + '.json');
      if (!response.ok) throw new Error('data');
      const result = validateResult(await response.json());
      if (currentRequest !== requestNumber) return;
      $('result-title').textContent = DEMOS[kind].title;
      $('metric-slope').textContent = result.fit.slope.toFixed(2);
      $('demo-duration').textContent = ' / ' + result.duration_seconds.toFixed(0) + '秒の合成例';
      $('viewer-message').textContent = DEMOS[kind].text;
      drawDemoEnvelope(result); drawDemoSpectrum(result); $('demo-result').hidden = false;
    } catch (_) {
      if (currentRequest !== requestNumber) return;
      $('viewer-message').textContent = '合成例を読み込めませんでした。説明はそのまま読めます。公開ページで開き直すか、Colabで合成例を確かめてください。';
      $('viewer-message').classList.add('error'); $('demo-result').hidden = true;
    }
  }

  drawHero(); drawSound(); drawComponents(); drawEnvelopeModel();
  $('wave-amplitude').addEventListener('input', drawSound);
  $('wave-frequency').addEventListener('input', drawSound);
  $('harmonic-ratio').addEventListener('input', drawComponents);
  $('play-tone').addEventListener('click', playTone);
  $('stop-tone').addEventListener('click', stopTone);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTone(); });
  window.addEventListener('pagehide', stopTone);
  document.querySelectorAll('[data-demo]').forEach(button => button.addEventListener('click', () => loadDemo(button.dataset.demo)));
  loadDemo('pink');
}());
