/* 映像の表示・姿勢推定・4点指定を、共通の角度計算へつなぐ。 */
(function () {
  'use strict';
  const core = window.SwingMotionCore;
  const $ = id => document.getElementById(id);
  const canvas = $('motion-canvas');
  const context = canvas.getContext('2d');
  const video = $('source-video');
  const pointKeys = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];
  const pointLabels = { leftShoulder: '左肩', rightShoulder: '右肩', leftHip: '左腰', rightHip: '右腰' };
  const colours = { shoulder: '#5379ff', hip: '#ff907d' };
  const state = { width: 960, height: 540, renderScale: 1, videoReady: false, videoUrl: null, sourceKind: 'demo', label: 'デモ', frames: [], result: null, roi: null, roiMode: false, roiStart: null, currentTime: 0, points: {}, selectedPoint: null, token: 0, seekToken: 0, working: false, playing: false, playbackStart: 0, playbackTime: 0, raf: null, model: null, modelPromise: null };
  const poseSources = {
    module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm',
    model: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    tensorflow: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
    poseDetection: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js'
  };
  const numericSettings = ['start-time', 'end-time', 'video-fps', 'sample-rate', 'slow-factor', 'confidence-threshold', 'min-span', 'smoothing'];

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('is-error', error);
  }
  function finite(value) { return Number.isFinite(value); }
  function format(value, digits = 1) { return finite(value) ? value.toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: digits, signDisplay: 'negative' }) : '—'; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function getNumber(id) {
    const input = $(id), value = Number(input.value);
    if (!input.value.trim() || !finite(value)) throw new Error('数値の設定を確認してください。');
    return value;
  }
  function options() {
    return core.normaliseOptions({ confidenceThreshold: getNumber('confidence-threshold'), minSpanPx: getNumber('min-span'), smoothingWindow: getNumber('smoothing'), timeScale: 1 / getNumber('slow-factor') });
  }
  function applyOptions(value) {
    $('confidence-threshold').value = value.confidenceThreshold;
    $('confidence-value').textContent = Number(value.confidenceThreshold).toFixed(2);
    $('min-span').value = value.minSpanPx;
    $('smoothing').value = value.smoothingWindow;
    const factor = 1 / value.timeScale;
    const select = $('slow-factor');
    select.querySelectorAll('[data-imported]').forEach(element => element.remove());
    if (!Array.from(select.options).some(option => Number(option.value) === factor)) {
      const option = document.createElement('option'); option.value = factor; option.dataset.imported = 'true';
      option.textContent = `時間換算 ${format(value.timeScale, 3)}秒/動画秒`; select.append(option);
    }
    select.value = String(factor);
  }
  function setCanvasSize(width, height) {
    state.width = Math.max(1, Math.round(width)); state.height = Math.max(1, Math.round(height));
    state.renderScale = Math.min(1, 4096 / state.width, 4096 / state.height, Math.sqrt(8000000 / (state.width * state.height)));
    canvas.width = Math.max(1, Math.round(state.width * state.renderScale)); canvas.height = Math.max(1, Math.round(state.height * state.renderScale));
  }
  function setBusy(value) {
    state.working = value;
    for (const id of numericSettings) $(id).disabled = value;
    for (const id of ['range-reset', 'select-roi', 'clear-roi', 'save-points', 'clear-points', 'previous-frame', 'next-frame', 'play-video', 'time-position']) $(id).disabled = value;
    document.querySelectorAll('[data-point]').forEach(button => { button.disabled = value; });
    $('analyse-video').disabled = value || !state.videoReady;
    $('cancel-analysis').hidden = !value;
    $('analysis-progress').hidden = !value;
  }
  function releaseVideo() {
    pause(); state.videoReady = false;
    video.removeAttribute('src'); video.load();
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
  }
  function stopOldWork() {
    ++state.token; ++state.seekToken; setBusy(false); pause();
    state.selectedPoint = null; state.roiMode = false; state.roiStart = null;
    $('select-roi').setAttribute('aria-pressed', 'false');
    $('video-stage').classList.remove('is-drawing', 'is-manual');
  }
  function updatePointButtons() {
    document.querySelectorAll('[data-point]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.point === state.selectedPoint);
      button.classList.toggle('is-set', !!state.points[button.dataset.point]);
      button.setAttribute('aria-pressed', String(button.dataset.point === state.selectedPoint));
    });
  }
  function nearestIndex(time, frames = state.frames) {
    if (!frames.length) return -1;
    let low = 0, high = frames.length - 1;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (frames[mid].time < time) low = mid + 1; else high = mid; }
    if (low > 0 && Math.abs(frames[low - 1].time - time) <= Math.abs(frames[low].time - time)) return low - 1;
    return low;
  }
  function selectionTolerance() {
    if (state.frames.length > 1) {
      const index = nearestIndex(state.currentTime);
      const next = Math.min(index + 1, state.frames.length - 1), previous = Math.max(0, index - 1);
      const spacing = (state.frames[next].time - state.frames[previous].time) / Math.max(1, next - previous);
      return Math.max(0.001, Math.min(0.15, spacing * 0.55));
    }
    return Math.max(0.001, 0.55 / Number($('video-fps').value || 30));
  }
  function measuredIndex() {
    const index = nearestIndex(state.currentTime);
    return index >= 0 && Math.abs(state.frames[index].time - state.currentTime) <= selectionTolerance() ? index : -1;
  }
  function restoreCurrentPoints() {
    const index = measuredIndex();
    state.points = index >= 0 ? structuredClone(state.frames[index].points) : {};
    updatePointButtons();
  }
  function seekVideo(time) {
    return new Promise((resolve, reject) => {
      const target = clamp(time, 0, Math.max(0, video.duration - 0.0001));
      if (Math.abs(video.currentTime - target) < 0.00001 && video.readyState >= 2 && !video.seeking) { resolve(video.currentTime); return; }
      let timer;
      const clean = () => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('loadeddata', done); video.removeEventListener('error', fail); };
      const done = () => { if (video.readyState >= 2 && !video.seeking) { clean(); resolve(video.currentTime); } };
      const fail = () => { clean(); reject(new Error('この時刻の動画を読み込めませんでした。別の時刻か動画形式で試してください。')); };
      video.addEventListener('seeked', done); video.addEventListener('loadeddata', done); video.addEventListener('error', fail);
      timer = setTimeout(fail, 10000);
      try { video.currentTime = target; } catch (_) { fail(); }
    });
  }
  function timeLimits() {
    if (state.videoReady) return [0, video.duration];
    return state.frames.length ? [state.frames[0].time, state.frames[state.frames.length - 1].time] : [0, 1];
  }
  function updateTimeControls() {
    const [min, max] = timeLimits();
    $('time-position').min = min; $('time-position').max = Math.max(min + 0.001, max);
    $('time-position').value = state.currentTime;
    $('current-time').textContent = `${format(state.currentTime, 3)} 秒`;
    $('total-time').textContent = `${format(max, 3)} 秒`;
  }
  async function showTime(time, seek = true) {
    const request = ++state.seekToken;
    const [min, max] = timeLimits(); state.currentTime = clamp(time, min, max);
    state.selectedPoint = null;
    $('video-stage').classList.remove('is-manual');
    updateTimeControls();
    if (state.videoReady && seek) {
      try { await seekVideo(state.currentTime); } catch (error) { if (request === state.seekToken) status(error.message, true); return; }
      if (request !== state.seekToken) return;
    }
    restoreCurrentPoints(); paint(); updateReadout(); updateChartCursors();
  }
  function pause() {
    state.playing = false; video.pause();
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null; $('play-video').textContent = '▶'; $('play-video').setAttribute('aria-label', '再生');
  }
  function playStep(now) {
    if (!state.playing) return;
    const [min, max] = timeLimits();
    const time = state.videoReady ? video.currentTime : state.playbackTime + (now - state.playbackStart) / 1000;
    state.currentTime = clamp(time, min, max); updateTimeControls(); restoreCurrentPoints(); paint(); updateReadout(); updateChartCursors();
    if (time >= max || (state.videoReady && video.ended)) { pause(); return; }
    state.raf = requestAnimationFrame(playStep);
  }
  async function togglePlay() {
    if (state.playing) { pause(); return; }
    const [min, max] = timeLimits();
    if (state.currentTime >= max - 0.02) await showTime(min);
    if (state.videoReady) {
      try { await video.play(); } catch (_) { status('再生できませんでした。コマ送りか時刻のバーで移動してください。', true); return; }
    }
    state.playing = true; state.playbackStart = performance.now(); state.playbackTime = state.currentTime;
    $('play-video').textContent = 'Ⅱ'; $('play-video').setAttribute('aria-label', '一時停止'); state.raf = requestAnimationFrame(playStep);
  }

  function paintBackground() {
    const w = state.width, h = state.height;
    context.fillStyle = '#112438'; context.fillRect(0, 0, w, h);
    if (state.videoReady && video.readyState >= 2) { context.drawImage(video, 0, 0, w, h); return; }
    const gradient = context.createLinearGradient(0, 0, w, h); gradient.addColorStop(0, '#193449'); gradient.addColorStop(1, '#0b1a2a');
    context.fillStyle = gradient; context.fillRect(0, 0, w, h);
    context.strokeStyle = '#ffffff08'; context.lineWidth = 1;
    for (let x = 0; x <= w; x += w / 16) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, h); context.stroke(); }
    for (let y = 0; y <= h; y += h / 9) { context.beginPath(); context.moveTo(0, y); context.lineTo(w, y); context.stroke(); }
    if (state.sourceKind === 'demo') {
      context.save(); context.strokeStyle = '#9cd6c51b'; context.lineWidth = 1.5 * w / 960;
      context.beginPath(); context.moveTo(w * 0.08, h * 0.84); context.lineTo(w * 0.5, h * 0.29); context.lineTo(w * 0.92, h * 0.84); context.stroke();
      context.beginPath(); context.ellipse(w * 0.5, h * 0.92, w * 0.29, h * 0.14, 0, Math.PI, Math.PI * 2); context.stroke();
      context.fillStyle = '#ffffff10'; context.beginPath(); context.moveTo(w * 0.48, h * 0.88); context.lineTo(w * 0.52, h * 0.88); context.lineTo(w * 0.525, h * 0.9); context.lineTo(w * 0.5, h * 0.92); context.lineTo(w * 0.475, h * 0.9); context.closePath(); context.fill();
      context.restore();
    }
  }
  function paint() {
    context.setTransform(state.renderScale, 0, 0, state.renderScale, 0, 0);
    paintBackground();
    const w = state.width, h = state.height, scale = w / 960;
    const points = state.points;
    if (!state.videoReady && points.leftShoulder && points.rightShoulder && points.leftHip && points.rightHip) {
      const shoulder = { x: (points.leftShoulder.x + points.rightShoulder.x) / 2, y: (points.leftShoulder.y + points.rightShoulder.y) / 2 };
      const hip = { x: (points.leftHip.x + points.rightHip.x) / 2, y: (points.leftHip.y + points.rightHip.y) / 2 };
      const headY = shoulder.y - Math.max(30 * scale, Math.abs(shoulder.y - hip.y) * 0.4);
      context.save(); context.strokeStyle = '#c7d7e347'; context.fillStyle = '#8da7ba22'; context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = 9 * scale;
      context.beginPath(); context.moveTo(shoulder.x, shoulder.y); context.lineTo(hip.x, hip.y); context.stroke();
      context.beginPath(); context.moveTo(hip.x, hip.y); context.lineTo(hip.x - 38 * scale, hip.y + 90 * scale); context.lineTo(hip.x - 56 * scale, hip.y + 145 * scale); context.moveTo(hip.x, hip.y); context.lineTo(hip.x + 53 * scale, hip.y + 83 * scale); context.lineTo(hip.x + 73 * scale, hip.y + 145 * scale); context.stroke();
      context.beginPath(); context.arc(shoulder.x, headY, 26 * scale, 0, Math.PI * 2); context.fill(); context.lineWidth = 2 * scale; context.stroke();
      context.strokeStyle = '#cfdeeb25'; context.lineWidth = 5 * scale; context.beginPath(); context.moveTo(points.leftShoulder.x, points.leftShoulder.y); context.lineTo(shoulder.x + 100 * scale, shoulder.y + 45 * scale); context.moveTo(points.rightShoulder.x, points.rightShoulder.y); context.lineTo(shoulder.x + 100 * scale, shoulder.y + 45 * scale); context.stroke();
      context.strokeStyle = '#d3e8d0'; context.lineWidth = 7 * scale; context.beginPath(); context.moveTo(shoulder.x + 100 * scale, shoulder.y + 45 * scale); context.lineTo(shoulder.x + 190 * scale, shoulder.y - 75 * scale); context.stroke(); context.restore();
    }
    for (const [axis, a, b] of [['shoulder', 'leftShoulder', 'rightShoulder'], ['hip', 'leftHip', 'rightHip']]) {
      const first = points[a], second = points[b];
      if (first && second && finite(first.x) && finite(first.y) && finite(second.x) && finite(second.y)) {
        context.save(); context.strokeStyle = colours[axis]; context.lineWidth = 4 * scale; context.shadowColor = colours[axis]; context.shadowBlur = 16 * scale;
        context.beginPath(); context.moveTo(first.x, first.y); context.lineTo(second.x, second.y); context.stroke(); context.restore();
      }
    }
    for (const key of pointKeys) {
      const point = points[key]; if (!point || !finite(point.x) || !finite(point.y)) continue;
      const colour = key.includes('Shoulder') ? colours.shoulder : colours.hip;
      context.save(); context.fillStyle = colour; context.strokeStyle = '#fff'; context.lineWidth = 2 * scale;
      context.beginPath(); context.arc(point.x, point.y, 6.5 * scale, 0, Math.PI * 2); context.fill(); context.stroke();
      context.font = `600 ${12 * scale}px sans-serif`; context.textBaseline = 'middle';
      const text = pointLabels[key], textWidth = context.measureText(text).width;
      const offset = key.startsWith('left') ? -textWidth - 15 * scale : 15 * scale;
      const x = clamp(point.x + offset, 7 * scale, w - textWidth - 7 * scale), y = clamp(point.y - 18 * scale, 16 * scale, h - 15 * scale);
      context.fillStyle = '#112438c9'; context.fillRect(x - 5 * scale, y - 10 * scale, textWidth + 10 * scale, 20 * scale);
      context.fillStyle = '#fff'; context.fillText(text, x, y); context.restore();
    }
    const roi = state.roi;
    if (roi) {
      context.save(); context.fillStyle = '#07162377'; context.fillRect(0, 0, w, roi.y); context.fillRect(0, roi.y + roi.height, w, h - roi.y - roi.height); context.fillRect(0, roi.y, roi.x, roi.height); context.fillRect(roi.x + roi.width, roi.y, w - roi.x - roi.width, roi.height);
      context.strokeStyle = '#a9e6d5'; context.lineWidth = 2 * scale; context.setLineDash([8 * scale, 5 * scale]); context.strokeRect(roi.x, roi.y, roi.width, roi.height); context.restore();
    }
    if (state.roiStart && state.roiMode && state.roiStart.current) {
      const a = state.roiStart, b = a.current; context.save(); context.fillStyle = '#a9e6d51a'; context.strokeStyle = '#a9e6d5'; context.lineWidth = 2 * scale; context.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); context.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); context.restore();
    }
  }
  function updateReadout() {
    const index = measuredIndex(), row = index >= 0 && state.result ? state.result.frames[index] : null;
    $('current-shoulder').textContent = row && finite(row.shoulderAngle) ? `${format(row.shoulderAngle)}°` : '—';
    $('current-hip').textContent = row && finite(row.hipAngle) ? `${format(row.hipAngle)}°` : '—';
    $('current-relative').textContent = row && finite(row.relativeAngle) ? `${format(row.relativeAngle)}°` : '—';
    $('current-shoulder-speed').textContent = row && finite(row.shoulderVelocity) ? `${format(row.shoulderVelocity)} 度/秒` : '—';
    $('current-hip-speed').textContent = row && finite(row.hipVelocity) ? `${format(row.hipVelocity)} 度/秒` : '—';
  }
  function recompute(message) {
    try {
      state.result = state.frames.length ? core.analyse(state.frames, options()) : null;
      renderResults(); restoreCurrentPoints(); paint(); updateReadout();
      if (message) status(message);
    } catch (error) { status(error.message, true); }
  }
  function svgElement(tag, attributes = {}, text) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    if (text != null) element.textContent = text;
    return element;
  }
  function chart(id, shoulderKey, hipKey) {
    const mount = $(id); mount.replaceChildren();
    if (!state.result || !state.result.frames.length) { const p = document.createElement('p'); p.className = 'chart-empty'; p.textContent = '解析するとグラフが表示されます。'; mount.append(p); return; }
    const rows = state.result.frames, xMin = rows[0].timeSeconds, xMax = rows[rows.length - 1].timeSeconds;
    const values = rows.flatMap(row => [row[shoulderKey], row[hipKey]]).filter(finite);
    if (!values.length) { const p = document.createElement('p'); p.className = 'chart-empty'; p.textContent = 'この条件で測れた点がありません。4点の位置と信頼度を確認してください。'; mount.append(p); return; }
    const width = 560, height = 270, left = 57, right = 540, top = 20, bottom = 219;
    let yMin = Math.min(...values), yMax = Math.max(...values);
    if (yMax === yMin) { yMin -= 10; yMax += 10; }
    const padding = (yMax - yMin) * 0.14; yMin -= padding; yMax += padding;
    const x = value => left + (xMax === xMin ? 0.5 : (value - xMin) / (xMax - xMin)) * (right - left);
    const y = value => bottom - (value - yMin) / (yMax - yMin) * (bottom - top);
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': id === 'angle-chart' ? '肩と腰の線の角度を時刻で比較' : '肩と腰の角速度を時刻で比較' });
    for (let i = 0; i <= 4; i++) {
      const value = yMin + i * (yMax - yMin) / 4;
      svg.append(svgElement('line', { x1: left, x2: right, y1: y(value), y2: y(value), stroke: '#e1e7ef', 'stroke-width': 1 }));
      svg.append(svgElement('text', { x: left - 8, y: y(value) + 4, fill: '#788596', 'font-size': 10, 'text-anchor': 'end' }, format(value, Math.abs(value) < 10 ? 1 : 0)));
    }
    if (yMin < 0 && yMax > 0) svg.append(svgElement('line', { x1: left, x2: right, y1: y(0), y2: y(0), stroke: '#aebcca', 'stroke-dasharray': '3 4' }));
    for (let i = 0; i <= 4; i++) {
      const value = xMin + (xMax - xMin) * i / 4;
      svg.append(svgElement('text', { x: x(value), y: bottom + 20, fill: '#788596', 'font-size': 10, 'text-anchor': 'middle' }, format(value, 2)));
    }
    svg.append(svgElement('text', { x: (left + right) / 2, y: height - 6, fill: '#687585', 'font-size': 10, 'text-anchor': 'middle' }, '時刻（秒）'));
    for (const [key, colour, segmentKey] of [[shoulderKey, colours.shoulder, 'shoulderSegment'], [hipKey, colours.hip, 'hipSegment']]) {
      let segment = [], previousSegment = null;
      const finish = () => { if (segment.length > 1) svg.append(svgElement('polyline', { points: segment.join(' '), fill: 'none', stroke: colour, 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })); segment = []; };
      rows.forEach(row => { if (previousSegment !== row[segmentKey]) finish(); previousSegment = row[segmentKey]; if (!finite(row[key])) { finish(); return; } segment.push(`${x(row.timeSeconds)},${y(row[key])}`); }); finish();
      if (rows.length <= 120) rows.filter(row => finite(row[key])).forEach(row => svg.append(svgElement('circle', { cx: x(row.timeSeconds), cy: y(row[key]), r: 2.1, fill: colour })));
    }
    const cursor = svgElement('line', { x1: x(state.currentTime * state.result.options.timeScale), x2: x(state.currentTime * state.result.options.timeScale), y1: top, y2: bottom, stroke: '#11243899', 'stroke-width': 1, 'stroke-dasharray': '4 4', 'data-cursor': id });
    svg.append(cursor); svg.dataset.xMin = xMin; svg.dataset.xMax = xMax; svg.dataset.left = left; svg.dataset.right = right;
    svg.addEventListener('click', event => { const bounds = svg.getBoundingClientRect(), coordinate = clamp((event.clientX - bounds.left) / bounds.width * width, left, right); const scaledTime = xMin + (coordinate - left) / (right - left) * (xMax - xMin); pause(); void showTime(scaledTime / state.result.options.timeScale); });
    mount.append(svg);
  }
  function updateChartCursors() {
    if (!state.result) return;
    for (const id of ['angle-chart', 'velocity-chart']) {
      const svg = $(id).querySelector('svg'), cursor = svg?.querySelector('[data-cursor]'); if (!cursor) continue;
      const min = Number(svg.dataset.xMin), max = Number(svg.dataset.xMax), left = Number(svg.dataset.left), right = Number(svg.dataset.right), time = state.currentTime * state.result.options.timeScale;
      const coordinate = left + (max === min ? 0.5 : clamp((time - min) / (max - min), 0, 1)) * (right - left);
      cursor.setAttribute('x1', coordinate); cursor.setAttribute('x2', coordinate);
    }
  }
  function renderResults() {
    const summary = state.result?.summary;
    $('shoulder-peak').textContent = format(summary?.shoulderPeakAbsVelocity);
    $('hip-peak').textContent = format(summary?.hipPeakAbsVelocity);
    $('relative-peak').textContent = format(summary?.relativePeakAbsAngle);
    $('valid-rate').textContent = summary ? `${format(summary.pairedValidCount / summary.frameCount * 100, 0)}%` : '—';
    $('valid-count').textContent = summary ? `肩 ${summary.shoulderValidCount}/${summary.frameCount} ／ 腰 ${summary.hipValidCount}/${summary.frameCount}` : '肩 — ／ 腰 —';
    $('time-basis').textContent = state.result && state.result.options.timeScale !== 1 ? 'スロー倍率から換算した実時間' : '動画の時間';
    $('download-csv').disabled = !state.result; $('download-json').disabled = !state.result;
    chart('angle-chart', 'shoulderAngle', 'hipAngle'); chart('velocity-chart', 'shoulderVelocity', 'hipVelocity');
    updateReadout(); updatePointButtons();
  }
  function resetROI() {
    state.roi = null; state.roiMode = false; state.roiStart = null; $('select-roi').setAttribute('aria-pressed', 'false'); $('video-stage').classList.remove('is-drawing');
    $('roi-note').textContent = state.videoReady ? '映像全体を解析します。打者を囲むと対象を絞れます。' : '動画を開いたら、解析したい打者を囲みます。'; paint();
  }
  function loadDemo() {
    stopOldWork(); releaseVideo();
    const demo = window.SWING_DEMO;
    if (!demo || !core) { status('必要なファイルを読み込めませんでした。ページを読み直してください。', true); return; }
    state.frames = structuredClone(demo.frames); state.sourceKind = 'demo'; state.label = demo.label || 'デモ';
    setCanvasSize(demo.width || 960, demo.height || 540); applyOptions(demo.options || { confidenceThreshold: 0.5, minSpanPx: 12, smoothingWindow: 3, timeScale: 1 });
    state.currentTime = state.frames[0]?.time || 0;
    $('start-time').removeAttribute('max'); $('end-time').removeAttribute('max');
    $('start-time').value = state.currentTime; $('end-time').value = state.frames.at(-1)?.time || 1;
    $('source-kind').textContent = 'デモ'; $('stage-label').textContent = 'DEMO / 肩と腰の動き'; $('stage-guide').textContent = '肩は青、腰はコーラル';
    resetROI(); updateTimeControls(); recompute('デモの解析結果です。時刻のバーを動かして肩と腰のタイミングを比べてみましょう。'); setBusy(false);
  }
  async function loadVideo(file) {
    if (!file) return;
    if (file.size === 0) { status('空の動画ファイルです。別のファイルを選んでください。', true); return; }
    stopOldWork(); releaseVideo(); const token = state.token;
    state.frames = []; state.result = null; state.points = {}; state.sourceKind = 'video'; state.label = '動画の解析結果'; resetROI(); renderResults();
    $('source-kind').textContent = '動画'; $('stage-label').textContent = 'VIDEO / 読み込み中'; $('stage-guide').textContent = '映像を読み込んでいます'; status('動画を読み込んでいます…');
    state.videoUrl = URL.createObjectURL(file); video.src = state.videoUrl;
    try {
      await new Promise((resolve, reject) => {
        let timer; const clean = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', done); video.removeEventListener('error', fail); };
        const done = () => { clean(); resolve(); }, fail = () => { clean(); reject(new Error('動画を開けませんでした。MP4やWebMなど、ブラウザで再生できる形式を選んでください。')); };
        video.addEventListener('loadedmetadata', done); video.addEventListener('error', fail); timer = setTimeout(fail, 15000); video.load();
      });
      if (token !== state.token) return;
      if (!finite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error('動画の長さや解像度を読み取れませんでした。別の形式で保存して試してください。');
      state.videoReady = true; setCanvasSize(video.videoWidth, video.videoHeight); state.currentTime = 0;
      $('start-time').max = video.duration; $('end-time').max = video.duration;
      $('start-time').value = 0; $('end-time').value = Math.min(video.duration, 3).toFixed(6);
      $('stage-label').textContent = 'VIDEO / 肩と腰をとらえる'; $('stage-guide').textContent = `${state.width} × ${state.height} / ${format(video.duration, 2)} 秒`;
      resetROI(); setBusy(false); await showTime(0);
      if (token === state.token) status('動画を開きました。開始・終了秒と打者の範囲を決めて解析します。4点を手動で指定することもできます。');
    } catch (error) {
      if (token !== state.token) return;
      releaseVideo(); setBusy(false); $('stage-label').textContent = 'VIDEO / 読み込めませんでした'; $('stage-guide').textContent = '別の動画形式で試してください'; paint(); status(error.message, true);
    }
  }
  const scriptPromises = new Map();
  function loadScript(url) {
    if (scriptPromises.has(url)) return scriptPromises.get(url);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = url; script.async = true;
      let timer;
      const clean = () => { clearTimeout(timer); script.onload = null; script.onerror = null; };
      script.onload = () => { clean(); resolve(); };
      script.onerror = () => { clean(); script.remove(); scriptPromises.delete(url); reject(new Error('姿勢推定ライブラリを読み込めませんでした。')); };
      timer = setTimeout(() => { clean(); script.remove(); scriptPromises.delete(url); reject(new Error('姿勢推定ライブラリの読み込みに時間がかかっています。再度お試しください。')); }, 45000);
      document.head.append(script);
    });
    scriptPromises.set(url, promise); return promise;
  }
  function hasWebGL() {
    const probe = document.createElement('canvas');
    try {
      const gl = probe.getContext('webgl2') || probe.getContext('webgl');
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext(); return true;
    } catch (_) { return false; }
  }
  async function createMediaPipe() {
    const vision = await import(poseSources.module);
    const fileset = await vision.FilesetResolver.forVisionTasks(poseSources.wasm);
    const detector = await vision.PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: poseSources.model, delegate: 'CPU' }, runningMode: 'IMAGE', numPoses: 3, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    return { backend: 'MediaPipe', detect: image => detector.detect(image), close: () => detector.close() };
  }
  async function createMoveNet() {
    if (!window.tf || window.tf.version?.tfjs !== '4.22.0') await loadScript(poseSources.tensorflow);
    if (!window.tf || !await window.tf.setBackend('cpu')) throw new Error('CPUでの姿勢推定を準備できませんでした。');
    await window.tf.ready();
    if (!window.poseDetection) await loadScript(poseSources.poseDetection);
    const detection = window.poseDetection;
    if (!detection) throw new Error('姿勢推定ライブラリを読み込めませんでした。');
    const detector = await detection.createDetector(detection.SupportedModels.MoveNet, { modelType: detection.movenet.modelType.SINGLEPOSE_LIGHTNING, enableSmoothing: false, minPoseScore: 0.2 });
    return {
      backend: 'MoveNet CPU', close: () => detector.dispose(),
      async detect(image) {
        detector.reset?.();
        const poses = await detector.estimatePoses(image, { flipHorizontal: false });
        const landmarks = poses.map(pose => {
          const mapped = [];
          for (const [coco, mediaPipe] of [[5, 11], [6, 12], [11, 23], [12, 24]]) {
            const point = pose.keypoints[coco]; if (!point) continue;
            const confidence = finite(point.score) ? clamp(point.score, 0, 1) : 0;
            mapped[mediaPipe] = { x: point.x / image.width, y: point.y / image.height, visibility: confidence, presence: confidence };
          }
          return mapped;
        });
        return { landmarks };
      }
    };
  }
  async function ensureModel(token, forceCPU = false) {
    if (forceCPU && state.model && state.model.backend !== 'MoveNet CPU') {
      try { state.model.close?.(); } catch (_) {}
      state.model = null; state.modelPromise = null;
    }
    if (state.model) return state.model;
    if (!state.modelPromise) {
      state.modelPromise = (async () => {
        if (!forceCPU && hasWebGL()) {
          try { return await createMediaPipe(); } catch (_) {}
        }
        return createMoveNet();
      })();
    }
    if (token === state.token) status('姿勢推定モデルを読み込んでいます。初回は少し時間がかかります…');
    try { state.model = await state.modelPromise; return state.model; }
    catch (_) { state.modelPromise = null; throw new Error('姿勢推定モデルを読み込めませんでした。ネット接続を確認して再度お試しください。4点の手動指定も使えます。'); }
  }
  function choosePose(landmarks, roi, previousCenter) {
    const candidates = [];
    for (const pose of landmarks || []) {
      const points = {};
      for (const [key, index] of [['leftShoulder', 11], ['rightShoulder', 12], ['leftHip', 23], ['rightHip', 24]]) {
        const landmark = pose[index]; if (!landmark || !finite(landmark.x) || !finite(landmark.y)) continue;
        const visibility = finite(landmark.visibility) ? landmark.visibility : 1, presence = finite(landmark.presence) ? landmark.presence : 1;
        const inCrop = landmark.x >= 0 && landmark.x <= 1 && landmark.y >= 0 && landmark.y <= 1;
        points[key] = { x: roi.x + landmark.x * roi.width, y: roi.y + landmark.y * roi.height, confidence: inCrop ? clamp(Math.min(visibility, presence), 0, 1) : 0 };
      }
      const usable = Object.values(points).filter(point => point.confidence >= 0.25);
      if (usable.length < 2) continue;
      const center = { x: usable.reduce((sum, point) => sum + point.x, 0) / usable.length, y: usable.reduce((sum, point) => sum + point.y, 0) / usable.length };
      const target = previousCenter || { x: roi.x + roi.width / 2, y: roi.y + roi.height / 2 };
      const distance = Math.hypot(center.x - target.x, center.y - target.y) / Math.hypot(roi.width, roi.height);
      if (previousCenter && distance > 0.4) continue;
      const confidence = usable.reduce((sum, point) => sum + point.confidence, 0) / usable.length;
      candidates.push({ points, center, score: distance - confidence * 0.15 });
    }
    candidates.sort((a, b) => a.score - b.score); return candidates[0] || null;
  }
  async function analyseVideo() {
    if (!state.videoReady || state.working) return;
    let start, end, rate;
    try {
      start = getNumber('start-time'); end = getNumber('end-time'); rate = getNumber('sample-rate'); options();
      if (start < 0 || end > video.duration + 0.0001 || end <= start) throw new Error('開始は0秒以上、終了は動画の長さ以内にして、開始より後の時刻を指定してください。');
      if (Math.floor((end - start) * rate) + 1 > 600) throw new Error('1回に解析できるのは600時点までです。範囲を短くするか、解析する頻度を下げてください。');
    } catch (error) { status(error.message, true); return; }
    stopOldWork(); const token = state.token; setBusy(true); state.frames = []; state.result = null; state.points = {}; renderResults();
    $('analysis-progress').value = 0;
    const roi = state.roi ? { ...state.roi } : { x: 0, y: 0, width: state.width, height: state.height };
    const crop = document.createElement('canvas'); const cropScale = Math.min(1, 1280 / roi.width, 1280 / roi.height); crop.width = Math.max(1, Math.round(roi.width * cropScale)); crop.height = Math.max(1, Math.round(roi.height * cropScale)); const cropContext = crop.getContext('2d');
    try {
      let model = await ensureModel(token); if (token !== state.token) return;
      const times = []; for (let time = start; time <= end + 0.000001; time += 1 / rate) times.push(Math.min(time, video.duration - 0.0001));
      if (times.at(-1) < Math.min(end, video.duration - 0.0001) - 0.5 / rate) times.push(Math.min(end, video.duration - 0.0001));
      const frames = []; let previousCenter = null;
      for (let i = 0; i < times.length; i++) {
        if (token !== state.token) return;
        const time = await seekVideo(times[i]); if (token !== state.token) return;
        cropContext.drawImage(video, roi.x, roi.y, roi.width, roi.height, 0, 0, crop.width, crop.height);
        let detection;
        try { detection = await model.detect(crop); }
        catch (error) {
          if (token !== state.token) return;
          if (model.backend === 'MoveNet CPU') throw error;
          status('CPUの姿勢推定へ切り替えています…');
          model = await ensureModel(token, true); if (token !== state.token) return;
          detection = await model.detect(crop);
        }
        if (token !== state.token) { detection.close?.(); return; }
        const selected = choosePose(detection.landmarks, roi, previousCenter); detection.close?.();
        if (selected) previousCenter = selected.center;
        if (!frames.length || time > frames.at(-1).time + 0.000001) frames.push({ time, points: selected ? selected.points : {} });
        state.currentTime = time; state.points = selected ? selected.points : {}; updateTimeControls(); paint();
        $('analysis-progress').value = (i + 1) / times.length;
        status(`肩と腰を解析しています… ${i + 1} / ${times.length} 時点`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (token !== state.token) return;
      state.frames = frames; state.sourceKind = 'video'; state.label = '動画の解析結果'; recompute();
      setBusy(false); await showTime(frames[0]?.time ?? start);
      if (token === state.token) status(`${frames.length}時点を解析しました（${model.backend}）。映像の4点を確認し、グラフで肩と腰の動きを見比べましょう。`);
    } catch (error) {
      if (token !== state.token) return;
      setBusy(false); state.points = {}; paint(); status(error.message, true);
    } finally { if (token === state.token) setBusy(false); }
  }
  function canvasPoint(event) {
    const rectangle = canvas.getBoundingClientRect();
    return { x: clamp((event.clientX - rectangle.left) / rectangle.width * state.width, 0, state.width), y: clamp((event.clientY - rectangle.top) / rectangle.height * state.height, 0, state.height) };
  }
  canvas.addEventListener('pointerdown', event => {
    if (state.working) return;
    const point = canvasPoint(event);
    if (state.roiMode && state.videoReady) { pause(); state.roiStart = { ...point, current: point }; canvas.setPointerCapture(event.pointerId); return; }
    if (!state.selectedPoint) return;
    pause(); state.points[state.selectedPoint] = { ...point, confidence: 1 };
    const index = pointKeys.indexOf(state.selectedPoint), next = pointKeys.find((key, offset) => offset > index && !state.points[key]);
    state.selectedPoint = next || null; updatePointButtons(); paint();
    $('manual-note').textContent = next ? `次に${pointLabels[next]}をクリックしてください。` : '4点の位置を確認して「この時刻の4点を保存」を押してください。';
    $('video-stage').classList.toggle('is-manual', !!state.selectedPoint);
  });
  canvas.addEventListener('pointermove', event => { if (!state.roiStart || !state.roiMode) return; state.roiStart.current = canvasPoint(event); paint(); });
  canvas.addEventListener('pointerup', event => {
    if (!state.roiStart || !state.roiMode) return;
    const a = state.roiStart, b = canvasPoint(event), width = Math.abs(a.x - b.x), height = Math.abs(a.y - b.y);
    state.roiStart = null; state.roiMode = false; $('select-roi').setAttribute('aria-pressed', 'false'); $('video-stage').classList.remove('is-drawing');
    if (width < 20 || height < 20) { status('打者の体が入るように、もう少し広く囲んでください。', true); paint(); return; }
    state.roi = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height };
    state.frames = []; state.result = null; state.points = {}; renderResults();
    $('roi-note').textContent = `選択範囲：${Math.round(width)} × ${Math.round(height)} px。肩と腰が動く範囲を含めてください。`; status('打者の範囲を設定しました。「AIで肩・腰を解析」で計算します。'); paint();
  });
  canvas.addEventListener('pointercancel', () => { state.roiStart = null; paint(); });

  function saveCurrentPoints() {
    if (pointKeys.some(key => !state.points[key])) { status('左肩・右肩・左腰・右腰の4点を指定してください。', true); return; }
    const input = { time: state.currentTime, points: structuredClone(state.points) };
    const index = nearestIndex(state.currentTime), epsilon = Math.max(0.000001, 0.45 / Number($('video-fps').value || 30));
    if (index >= 0 && Math.abs(state.frames[index].time - state.currentTime) <= epsilon) state.frames[index] = input;
    else state.frames.push(input);
    state.frames.sort((a, b) => a.time - b.time); state.selectedPoint = null;
    if (!state.videoReady && state.sourceKind !== 'demo') state.sourceKind = 'manual';
    updateTimeControls(); recompute(`${format(state.currentTime, 3)}秒の4点を保存しました。`);
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function loadResult(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { status('結果ファイルは10MB以内のJSONを選んでください。', true); return; }
    stopOldWork(); const token = state.token;
    try {
      const imported = core.readJSON(await file.text()); if (token !== state.token) return;
      releaseVideo(); state.frames = imported.frames; state.sourceKind = imported.sourceKind || 'results'; state.label = imported.label || '読み込んだ解析結果';
      const values = state.frames.flatMap(frame => Object.values(frame.points || {}));
      const width = imported.width || values.reduce((maximum, point) => point && finite(point.x) ? Math.max(maximum, point.x + 60) : maximum, 960);
      const height = imported.height || values.reduce((maximum, point) => point && finite(point.y) ? Math.max(maximum, point.y + 60) : maximum, 540);
      setCanvasSize(width, height); applyOptions(imported.options);
      state.currentTime = state.frames[0]?.time || 0; $('start-time').removeAttribute('max'); $('end-time').removeAttribute('max'); $('start-time').value = state.currentTime; $('end-time').value = state.frames.at(-1)?.time || state.currentTime + 1;
      $('source-kind').textContent = state.sourceKind === 'demo' ? 'デモ' : '保存した座標'; $('stage-label').textContent = state.sourceKind === 'demo' ? 'DEMO / 肩と腰の動き' : 'RESULT / 保存した4点'; $('stage-guide').textContent = '肩は青、腰はコーラル';
      resetROI(); updateTimeControls(); recompute('保存した座標と条件を読み込みました。閾値や平滑化を変えて再解析できます。'); setBusy(false);
    } catch (error) { if (token === state.token) status(error.message, true); }
  }

  $('demo-top').addEventListener('click', loadDemo);
  $('upload-video').addEventListener('click', () => $('video-file').click());
  $('open-result').addEventListener('click', () => $('result-file').click());
  $('video-file').addEventListener('change', () => { const file = $('video-file').files[0]; $('video-file').value = ''; void loadVideo(file); });
  $('result-file').addEventListener('change', () => { const file = $('result-file').files[0]; $('result-file').value = ''; void loadResult(file); });
  $('time-position').addEventListener('input', () => { pause(); void showTime(Number($('time-position').value)); });
  $('previous-frame').addEventListener('click', () => { pause(); void showTime(state.currentTime - 1 / Number($('video-fps').value || 30)); });
  $('next-frame').addEventListener('click', () => { pause(); void showTime(state.currentTime + 1 / Number($('video-fps').value || 30)); });
  $('play-video').addEventListener('click', () => { void togglePlay(); });
  $('range-reset').addEventListener('click', () => { const [start, end] = timeLimits(); $('start-time').value = start; $('end-time').value = end.toFixed(6); status('開始・終了を映像全体の秒数に戻しました。'); });
  $('select-roi').addEventListener('click', () => {
    if (!state.videoReady) { status('「動画を開く」で解析する映像を選んでください。'); return; }
    pause(); state.selectedPoint = null; state.roiMode = !state.roiMode; state.roiStart = null; updatePointButtons();
    $('select-roi').setAttribute('aria-pressed', String(state.roiMode)); $('video-stage').classList.toggle('is-drawing', state.roiMode); $('video-stage').classList.remove('is-manual');
    status(state.roiMode ? '映像の上をドラッグして、打者を囲んでください。' : '範囲の指定を終了しました。');
  });
  $('clear-roi').addEventListener('click', () => { const hadROI = !!state.roi; resetROI(); if (hadROI && state.videoReady) { state.frames = []; state.result = null; state.points = {}; renderResults(); paint(); status('映像全体を解析する範囲に戻しました。再度解析してください。'); } });
  document.querySelectorAll('[data-point]').forEach(button => button.addEventListener('click', () => {
    pause(); state.roiMode = false; state.roiStart = null; state.selectedPoint = button.dataset.point; $('select-roi').setAttribute('aria-pressed', 'false'); $('video-stage').classList.remove('is-drawing'); $('video-stage').classList.add('is-manual'); updatePointButtons();
    $('manual-note').textContent = `${pointLabels[state.selectedPoint]}を映像上でクリックしてください。`;
  }));
  $('save-points').addEventListener('click', saveCurrentPoints);
  $('clear-points').addEventListener('click', () => { state.points = {}; state.selectedPoint = pointKeys[0]; updatePointButtons(); paint(); $('manual-note').textContent = '左肩から4点を指定してください。'; $('video-stage').classList.add('is-manual'); });
  $('analyse-video').addEventListener('click', () => { void analyseVideo(); });
  $('cancel-analysis').addEventListener('click', () => { stopOldWork(); state.points = {}; paint(); status('解析を中止しました。範囲や条件を変えて再度解析できます。'); });
  for (const id of ['confidence-threshold', 'min-span', 'smoothing', 'slow-factor']) $(id).addEventListener('change', () => { $('confidence-value').textContent = Number($('confidence-threshold').value).toFixed(2); recompute('条件を変えてグラフを更新しました。'); });
  $('confidence-threshold').addEventListener('input', () => { $('confidence-value').textContent = Number($('confidence-threshold').value).toFixed(2); });
  $('download-csv').addEventListener('click', () => { if (state.result) download('SwingMotion_values.csv', core.exportCSV(state.result), 'text/csv;charset=utf-8'); });
  $('download-json').addEventListener('click', () => { if (state.result) download('SwingMotion_coordinates.json', core.exportJSON(state.result, { label: state.label, sourceKind: state.sourceKind, width: state.width, height: state.height }), 'application/json;charset=utf-8'); });
  $('clear-results').addEventListener('click', () => { stopOldWork(); state.frames = []; state.result = null; state.points = {}; updatePointButtons(); renderResults(); paint(); updateReadout(); status('結果をリセットしました。動画を解析するか、デモを開いてください。'); });
  window.addEventListener('pagehide', () => { pause(); if (state.videoUrl) URL.revokeObjectURL(state.videoUrl); });

  if (!core) { status('角度の計算ファイルを読み込めませんでした。ページを読み直してください。', true); return; }
  loadDemo();
})();
