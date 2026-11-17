/* 映像の表示・姿勢推定・関節の指定を、共通の角度計算へつなぐ。 */
(function () {
  'use strict';
  const core = window.SwingMotionCore;
  const $ = id => document.getElementById(id);
  const canvas = $('motion-canvas');
  const context = canvas.getContext('2d');
  const video = $('source-video');
  const pointKeys = ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];
  const pointLabels = { leftShoulder: '左肩', rightShoulder: '右肩', leftElbow: '左肘', rightElbow: '右肘', leftWrist: '左手首', rightWrist: '右手首', leftHip: '左腰', rightHip: '右腰', leftKnee: '左膝', rightKnee: '右膝', leftAnkle: '左足首', rightAnkle: '右足首' };
  const poseIndices = [['leftShoulder',11],['rightShoulder',12],['leftElbow',13],['rightElbow',14],['leftWrist',15],['rightWrist',16],['leftHip',23],['rightHip',24],['leftKnee',25],['rightKnee',26],['leftAnkle',27],['rightAnkle',28]];
  const skeletonEdges = [['leftShoulder','rightShoulder'],['leftHip','rightHip'],['leftShoulder','leftHip'],['rightShoulder','rightHip'],['leftShoulder','leftElbow'],['leftElbow','leftWrist'],['rightShoulder','rightElbow'],['rightElbow','rightWrist'],['leftHip','leftKnee'],['leftKnee','leftAnkle'],['rightHip','rightKnee'],['rightKnee','rightAnkle']];
  const colours = { shoulder: '#5379ff', hip: '#ff907d' };
  const state = { metricGroup: 'axes', demoId: 'swing', loadController: null, loadingSource: false, width: 960, height: 540, renderScale: 1, videoReady: false, videoUrl: null, sourceKind: 'demo', label: 'デモ', frames: [], result: null, roi: null, roiMode: false, roiStart: null, currentTime: 0, points: {}, selectedPoint: null, token: 0, seekToken: 0, working: false, playing: false, playbackStart: 0, playbackTime: 0, raf: null, model: null, modelPromise: null };
  const poseSources = {
    module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm',
    model: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    tensorflow: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
    poseDetection: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js'
  };
  const numericSettings = ['demo-select', 'open-demo', 'metric-group', 'show-trails', 'start-time', 'end-time', 'video-fps', 'sample-rate', 'slow-factor', 'confidence-threshold', 'min-span', 'smoothing'];
  const timeInputs = ['start', 'end'].map(name => window.MotionTimeInput.bindTimeInput($(name + '-time'), {
    decreaseButton: $(name + '-down'), increaseButton: $(name + '-up'),
    getMaximum: () => timeLimits()[1]
  }));

  function sourceFeedback(kind, message) {
    const labels = { idle: 'デモ', input: 'URLを入力', loading: '読み込み中', ready: '読み込み完了', error: '読み込み失敗', cancelled: '中止', results: '座標データ' };
    $('source-feedback').dataset.state = kind;
    $('video-stage').setAttribute('aria-busy', String(kind === 'loading'));
    $('source-state').textContent = labels[kind];
    $('source-message').textContent = message;
    $('source-progress').hidden = kind !== 'loading';
    $('cancel-source').hidden = kind !== 'loading';
  }

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
    $('cancel-analysis').textContent = state.loadingSource ? '読み込みを中止' : '解析を中止';
    for (const id of numericSettings) $(id).disabled = value;
    timeInputs.forEach(input => input.setDisabled(value));
    $('load-url').disabled = value && !state.loadingSource;
    $('load-url').textContent = state.loadingSource ? 'このURLで読み直す' : '動画URLを読み込む';
    for (const id of ['range-reset', 'select-roi', 'clear-roi', 'save-points', 'clear-points', 'previous-frame', 'next-frame', 'play-video', 'time-position']) $(id).disabled = value;
    document.querySelectorAll('[data-point]').forEach(button => { button.disabled = value; });
    $('analyse-video').disabled = value || !state.videoReady;
    $('cancel-analysis').hidden = !value;
    $('analysis-progress').hidden = !value || state.loadingSource;
  }
  function releaseVideo() {
    pause(); state.videoReady = false;
    video.removeAttribute('src'); video.removeAttribute('crossorigin'); video.load();
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
  }
  function stopOldWork() {
    const wasLoading = state.loadingSource;
    ++state.token; ++state.seekToken;
    state.loadController?.abort(); state.loadController = null; state.loadingSource = false;
    setBusy(false); pause();
    state.selectedPoint = null; state.roiMode = false; state.roiStart = null;
    $('select-roi').setAttribute('aria-pressed', 'false');
    $('video-stage').classList.remove('is-drawing', 'is-manual');
    if (wasLoading) {
      releaseVideo();
      sourceFeedback('cancelled', '動画の読み込みを中止しました。別のURLや動画ファイルで再度お試しください。');
      $('stage-label').textContent='VIDEO / 読み込みを中止';
      $('stage-guide').textContent='動画ファイルかURLを選んでください';
    }
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
    if (state.sourceKind === 'demo' && state.demoId && window.MotionDemoRenderer) {
      const frame = state.frames[nearestIndex(state.currentTime)];
      window.MotionDemoRenderer.draw(context, { width: w, height: h, points: state.points, demoId: state.demoId, time: frame?.time ?? state.currentTime });
      return;
    }
    const gradient = context.createLinearGradient(0, 0, w, h); gradient.addColorStop(0, '#193449'); gradient.addColorStop(1, '#0b1a2a');
    context.fillStyle = gradient; context.fillRect(0, 0, w, h);
    context.strokeStyle = '#ffffff08'; context.lineWidth = 1;
    for (let x = 0; x <= w; x += w / 16) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, h); context.stroke(); }
    for (let y = 0; y <= h; y += h / 9) { context.beginPath(); context.moveTo(0, y); context.lineTo(w, y); context.stroke(); }
  }
  function activeGroup() { return core.METRIC_GROUPS[state.metricGroup] || core.METRIC_GROUPS.axes; }
  function pointColour(key) {
    if (state.metricGroup === 'axes') return key.includes('Shoulder') ? colours.shoulder : key.includes('Hip') ? colours.hip : '#b5c7d9';
    return key.startsWith('left') ? colours.shoulder : colours.hip;
  }
  function drawTrails(scale) {
    if (!$('show-trails').checked) return;
    const threshold = Number($('confidence-threshold').value);
    for (const key of ['leftWrist','rightWrist','leftAnkle','rightAnkle']) {
      context.save(); context.strokeStyle = pointColour(key); context.globalAlpha = 0.6; context.lineWidth = 2 * scale;
      context.beginPath(); let connected = false;
      for (const frame of state.frames) {
        if (frame.time < state.currentTime - 1 || frame.time > state.currentTime + 0.00001) continue;
        const point = frame.points[key];
        if (!point || !finite(point.x) || !finite(point.y) || point.confidence < threshold) { connected = false; continue; }
        if (connected) context.lineTo(point.x,point.y); else context.moveTo(point.x,point.y);
        connected = true;
      }
      context.stroke(); context.restore();
    }
  }
  function paint() {
    context.setTransform(state.renderScale, 0, 0, state.renderScale, 0, 0); paintBackground();
    const w = state.width, h = state.height, scale = w / 960, points = state.points;
    const required = new Set(activeGroup().pointNames);
    drawTrails(scale);
    const visiblePoint = point => point && finite(point.x) && finite(point.y);
    const line = (a,b,colour,width=4) => {
      if (!visiblePoint(a) || !visiblePoint(b)) return;
      context.save(); context.strokeStyle = colour; context.lineWidth = width * scale; context.lineCap = 'round';
      context.beginPath(); context.moveTo(a.x,a.y); context.lineTo(b.x,b.y); context.stroke(); context.restore();
    };
    for (const [a,b] of skeletonEdges) {
      const selected = required.has(a) && required.has(b);
      const colour = selected ? (state.metricGroup === 'axes' ? (a.includes('Shoulder') && b.includes('Shoulder') ? colours.shoulder : a.includes('Hip') && b.includes('Hip') ? colours.hip : '#b5c7d97a') : pointColour(a)) : '#b5c7d95c';
      line(points[a],points[b],colour,selected ? 4 : 2.5);
    }
    if (visiblePoint(points.leftShoulder) && visiblePoint(points.rightShoulder) && visiblePoint(points.leftHip) && visiblePoint(points.rightHip)) {
      const shoulder = {x:(points.leftShoulder.x+points.rightShoulder.x)/2,y:(points.leftShoulder.y+points.rightShoulder.y)/2};
      const hip = {x:(points.leftHip.x+points.rightHip.x)/2,y:(points.leftHip.y+points.rightHip.y)/2};
      if (state.metricGroup === 'trunk') {
        line(hip,shoulder,colours.shoulder,5);
        context.save(); context.strokeStyle = '#ffffff66'; context.lineWidth = 1.5 * scale; context.setLineDash([6 * scale,5 * scale]);
        context.beginPath(); context.moveTo(hip.x,hip.y); context.lineTo(hip.x,hip.y-Math.hypot(shoulder.x-hip.x,shoulder.y-hip.y)); context.stroke(); context.restore();
      }
      if (!state.videoReady && !(state.sourceKind === 'demo' && state.demoId && window.MotionDemoRenderer)) {
        const bodyLength = Math.hypot(shoulder.x-hip.x,shoulder.y-hip.y);
        const norm = bodyLength || 1, head = {x:shoulder.x+(shoulder.x-hip.x)/norm*40*scale,y:shoulder.y+(shoulder.y-hip.y)/norm*40*scale};
        context.save(); context.fillStyle='#9fc2dc2b'; context.strokeStyle='#b5c7d97a';context.lineWidth=2*scale;
        context.beginPath();context.arc(head.x,head.y,22*scale,0,Math.PI*2);context.fill();context.stroke();context.restore();
      }
    }
    for (const key of pointKeys) {
      const point = points[key]; if (!visiblePoint(point)) continue;
      const selected = required.has(key) || state.selectedPoint === key, colour = pointColour(key);
      context.save(); context.fillStyle = selected ? colour : '#a5bacb'; context.strokeStyle = '#fff'; context.lineWidth = 1.8 * scale;
      context.beginPath(); context.arc(point.x,point.y,(selected ? 6 : 3.5)*scale,0,Math.PI*2);context.fill();context.stroke();
      if (selected) {
        context.font=`600 ${12*scale}px sans-serif`;context.textBaseline='middle';
        const text=pointLabels[key],textWidth=context.measureText(text).width,offset=key.startsWith('left')?-textWidth-13*scale:13*scale;
        const x=clamp(point.x+offset,7*scale,w-textWidth-7*scale),y=clamp(point.y-17*scale,16*scale,h-15*scale);
        context.fillStyle='#112438c9';context.fillRect(x-4*scale,y-10*scale,textWidth+8*scale,20*scale);context.fillStyle='#fff';context.fillText(text,x,y);
      }
      context.restore();
    }
    const roi=state.roi;
    if (roi) {
      context.save();context.fillStyle='#07162377';context.fillRect(0,0,w,roi.y);context.fillRect(0,roi.y+roi.height,w,h-roi.y-roi.height);context.fillRect(0,roi.y,roi.x,roi.height);context.fillRect(roi.x+roi.width,roi.y,w-roi.x-roi.width,roi.height);
      context.strokeStyle='#a9e6d5';context.lineWidth=2*scale;context.setLineDash([8*scale,5*scale]);context.strokeRect(roi.x,roi.y,roi.width,roi.height);context.restore();
    }
    if (state.roiStart && state.roiMode && state.roiStart.current) {
      const a=state.roiStart,b=a.current;context.save();context.fillStyle='#a9e6d51a';context.strokeStyle='#a9e6d5';context.lineWidth=2*scale;context.fillRect(a.x,a.y,b.x-a.x,b.y-a.y);context.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);context.restore();
    }
  }
  function renderMetricUI() {
    const group=activeGroup(),mount=$('frame-readout');mount.replaceChildren();$('metric-legend').replaceChildren();
    $('metric-group').value=state.metricGroup; $('metric-description').textContent=group.description;$('measurement-note').textContent=group.description;
    $('angle-chart-title').textContent=state.metricGroup==='axes'?'線の向き':state.metricGroup==='trunk'?'垂直からの傾き':'関節の角度';
    for(const metric of group.metrics){
      const card=document.createElement('div'),label=document.createElement('span'),value=document.createElement('strong'),speed=document.createElement('small');
      label.className='readout-title';label.style.color=metric.colour;label.textContent=metric.label;value.id='current-'+metric.id;value.textContent='—';speed.id='current-'+metric.id+'-speed';speed.textContent='—';card.append(label,value,speed);mount.append(card);
      const legend=document.createElement('span'),swatch=document.createElement('i');swatch.style.background=metric.colour;legend.append(swatch,document.createTextNode(metric.label));$('metric-legend').append(legend);
    }
    if(state.metricGroup==='axes'){
      const card=document.createElement('div'),label=document.createElement('span'),value=document.createElement('strong'),unit=document.createElement('small');label.className='readout-title';label.textContent='肩と腰の向きの差';value.id='current-relative';value.textContent='—';unit.textContent='画像上の角度';card.append(label,value,unit);mount.append(card);
    }
  }

  function updateReadout() {
    const index=measuredIndex(),row=index>=0&&state.result?state.result.frames[index]:null;
    for(const metric of activeGroup().metrics){
      const value=$('current-'+metric.id),speed=$('current-'+metric.id+'-speed');
      if(value)value.textContent=row&&finite(row[metric.angleKey])?`${format(row[metric.angleKey])}°`:'—';
      if(speed)speed.textContent=row&&finite(row[metric.velocityKey])?`${format(row[metric.velocityKey])} 度/秒`:'—';
    }
    if($('current-relative'))$('current-relative').textContent=row&&finite(row.relativeAngle)?`${format(row.relativeAngle)}°`:'—';
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
  function chart(id, velocity) {
    const mount = $(id); mount.replaceChildren();
    if (!state.result || !state.result.frames.length) { const p = document.createElement('p'); p.className = 'chart-empty'; p.textContent = '解析するとグラフが表示されます。'; mount.append(p); return; }
    const rows = state.result.frames, xMin = rows[0].timeSeconds, xMax = rows[rows.length - 1].timeSeconds;
    const metrics=activeGroup().metrics;
    const values=rows.flatMap(row=>metrics.map(metric=>row[velocity?metric.velocityKey:metric.angleKey])).filter(finite);
    if (!values.length) { const p = document.createElement('p'); p.className = 'chart-empty'; p.textContent = 'この条件で測れた点がありません。必要な関節の位置と信頼度を確認してください。'; mount.append(p); return; }
    const width = 560, height = 270, left = 57, right = 540, top = 20, bottom = 219;
    let yMin = Math.min(...values), yMax = Math.max(...values);
    if (yMax === yMin) { yMin -= 10; yMax += 10; }
    const padding = (yMax - yMin) * 0.14; yMin -= padding; yMax += padding;
    const x = value => left + (xMax === xMin ? 0.5 : (value - xMin) / (xMax - xMin)) * (right - left);
    const y = value => bottom - (value - yMin) / (yMax - yMin) * (bottom - top);
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': activeGroup().label + (velocity ? 'の角速度を時刻で比較' : 'の角度を時刻で比較') });
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
    for (const metric of metrics) {
      const key=velocity?metric.velocityKey:metric.angleKey,colour=metric.colour,segmentKey=metric.segmentKey;
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
    renderMetricUI();
    const summary=state.result?.summary,group=activeGroup(),[first,second]=group.metrics;
    const a=summary?.metrics[first.id],b=second?summary?.metrics[second.id]:null;
    $('peak-a-label').textContent=first.label+'の角速度ピーク';$('peak-a').textContent=format(a?.peakAbsVelocity);
    $('peak-b-label').textContent=second?second.label+'の角速度ピーク':first.label+'の最大の傾き';
    $('peak-b').textContent=second?format(b?.peakAbsVelocity):a&&finite(a.minAngle)?format(Math.max(Math.abs(a.minAngle),Math.abs(a.maxAngle))):'—';
    $('peak-b-unit').textContent=second?'度/秒・絶対値':'度・絶対値';
    $('angle-range-label').textContent=state.metricGroup==='axes'?'肩と腰の向きの差':first.label+'の角度の範囲';
    $('angle-range').textContent=state.metricGroup==='axes'?format(summary?.relativePeakAbsAngle):a&&finite(a.minAngle)?`${format(a.minAngle)}〜${format(a.maxAngle)}`:'—';
    $('angle-range-unit').textContent=state.metricGroup==='axes'?'最大の絶対値・度':'最小〜最大・度';
    const valid=state.result?.frames.filter(row=>group.metrics.every(metric=>row[metric.validKey])).length;
    $('valid-rate').textContent=summary?`${format(valid/summary.frameCount*100,0)}%`:'—';
    $('valid-count').textContent=summary?group.metrics.map(metric=>`${metric.label} ${summary.metrics[metric.id].validCount}/${summary.frameCount}`).join(' ／ '):'—';
    $('time-basis').textContent=state.result&&state.result.options.timeScale!==1?'スロー倍率から換算した実時間':'動画の時間';
    $('download-csv').disabled=!state.result;$('download-json').disabled=!state.result;
    chart('angle-chart',false);chart('velocity-chart',true);updateReadout();updatePointButtons();
  }
  function resetROI() {
    state.roi=null;state.roiMode=false;state.roiStart=null;$('select-roi').setAttribute('aria-pressed','false');$('video-stage').classList.remove('is-drawing');
    $('roi-note').textContent=state.videoReady?'映像全体を解析します。人物を囲むと対象を絞れます。':'動画を開いたら、解析したい人物を囲みます。';paint();
  }
  function loadDemo(key=$('demo-select').value) {
    stopOldWork();releaseVideo();
    const demos=window.MOTION_DEMOS||{swing:window.SWING_DEMO},demo=demos[key]||demos.swing;
    if(!demo||!core){status('必要なファイルを読み込めませんでした。ページを読み直してください。',true);return;}
    state.demoId=demo.id||key;$('demo-select').value=state.demoId;
    state.metricGroup=demo.metricGroup||'axes';state.frames=structuredClone(demo.frames);state.sourceKind='demo';state.label=demo.label||'デモ';
    setCanvasSize(demo.width||960,demo.height||540);applyOptions(demo.options||{confidenceThreshold:0.5,minSpanPx:12,smoothingWindow:3,timeScale:1});
    state.currentTime=state.frames[0]?.time||0;$('start-time').removeAttribute('max');$('end-time').removeAttribute('max');timeInputs[0].setValue(state.currentTime);timeInputs[1].setValue(state.frames.at(-1)?.time||1);
    $('source-kind').textContent='デモ';$('stage-label').textContent='DEMO / '+state.label.replace(/^デモ[：:]?/,'');$('stage-guide').textContent='関節の位置と線を確認';
    sourceFeedback('idle', '人体の動きを再現したアニメーションです。実際の撮影・計測データではありません。');
    resetROI();updateTimeControls();recompute('デモの解析結果です。時刻のバーとグラフで動くタイミングを比べてみましょう。');setBusy(false);
  }
  async function openSource(url,objectURL=false) {
    stopOldWork();releaseVideo();const token=state.token,controller=new AbortController();state.loadController=controller;state.loadingSource=true;
    state.frames=[];state.result=null;state.points={};state.sourceKind='video';state.label='動画の解析結果';state.videoUrl=objectURL?url:null;
    resetROI();renderResults();setBusy(true);
    $('source-kind').textContent=objectURL?'動画':'URL動画';$('stage-label').textContent='VIDEO / 読み込み中';$('stage-guide').textContent='映像を読み込んでいます';status('動画を読み込んでいます…');
    sourceFeedback('loading', '動画に接続しています… 最初の映像が表示されるまでお待ちください。');
    try{
      const loaded=await window.MotionVideoInput.loadVideoSource(video,{url,objectURL,signal:controller.signal,timeoutMs:20000,onProgress:phase=>{
        if(token!==state.token)return;
        const messages={connecting:'動画に接続しています…',metadata:'動画の情報を取得しました。最初の映像を読み込んでいます…',buffering:'動画のデータを受信しています…',stalled:'配信元の応答を待っています… 20秒以内に読み込めなければお知らせします。'};
        sourceFeedback('loading',messages[phase]||messages.buffering);
      }});
      if(token!==state.token)return;
      state.videoReady=true;state.loadingSource=false;setCanvasSize(loaded.width,loaded.height);state.currentTime=0;
      $('start-time').max=loaded.duration;$('end-time').max=loaded.duration;timeInputs[0].setValue(0);timeInputs[1].setValue(Math.min(loaded.duration,3));
      $('stage-label').textContent='VIDEO / 動きをとらえる';$('stage-guide').textContent=`${state.width} × ${state.height} / ${format(loaded.duration,2)} 秒`;
      resetROI();setBusy(false);await showTime(0);
      if(token===state.token){
        sourceFeedback('ready', `動画を開きました：${format(loaded.duration,2)}秒 / ${loaded.width} × ${loaded.height}。再生やコマ送りで確認できます。`);
        status('動画を開きました。人物の範囲と開始・終了秒を決めて解析します。関節の位置は手動でも指定できます。');
      }
    }catch(error){
      if(token!==state.token)return;
      state.loadingSource=false;releaseVideo();setBusy(false);$('stage-label').textContent='VIDEO / 読み込めませんでした';$('stage-guide').textContent='動画ファイルか別のURLを選んでください';paint();status(error.message,true);
      sourceFeedback('error',error.message);
    }finally{if(token===state.token)state.loadController=null;}
  }
  async function loadVideo(file) {
    if(!file)return;if(!file.size){if(state.loadingSource)stopOldWork();const message='空の動画ファイルです。別のファイルを選んでください。';sourceFeedback('error',message);status(message,true);return;}
    await openSource(URL.createObjectURL(file),true);
  }
  async function loadURL() {
    try{
      const url=window.MotionVideoInput.normaliseVideoURL($('video-url').value,{pageURL:location.href});
      $('video-url').removeAttribute('aria-invalid');await openSource(url,false);
    }catch(error){
      if(state.loadingSource)stopOldWork();
      $('video-url').setAttribute('aria-invalid','true');sourceFeedback('error',error.message);status(error.message,true);
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
          for (const [coco, mediaPipe] of [[5,11],[6,12],[7,13],[8,14],[9,15],[10,16],[11,23],[12,24],[13,25],[14,26],[15,27],[16,28]]) {
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
    catch (_) { state.modelPromise = null; throw new Error('姿勢推定モデルを読み込めませんでした。ネット接続を確認して再度お試しください。関節の手動指定も使えます。'); }
  }
  function choosePose(landmarks, roi, previousCenter) {
    const candidates = [];
    for (const pose of landmarks || []) {
      const points = {};
      for (const [key, index] of poseIndices) {
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
        status(`関節の動きを解析しています… ${i + 1} / ${times.length} 時点`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (token !== state.token) return;
      state.frames = frames; state.sourceKind = 'video'; state.label = '動画の解析結果'; recompute();
      setBusy(false); await showTime(frames[0]?.time ?? start);
      if (token === state.token) status(`${frames.length}時点を解析しました（${model.backend}）。映像の関節を確認し、見る動きを切り替えてグラフを比べましょう。`);
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
    const required=activeGroup().pointNames,index=required.indexOf(state.selectedPoint),next=required.find((key,offset)=>offset>index&&!state.points[key]);
    state.selectedPoint = next || null; updatePointButtons(); paint();
    $('manual-note').textContent = next ? `次に${pointLabels[next]}をクリックしてください。` : '関節の位置を確認して「指定した点を保存」を押してください。';
    $('video-stage').classList.toggle('is-manual', !!state.selectedPoint);
  });
  canvas.addEventListener('pointermove', event => { if (!state.roiStart || !state.roiMode) return; state.roiStart.current = canvasPoint(event); paint(); });
  canvas.addEventListener('pointerup', event => {
    if (!state.roiStart || !state.roiMode) return;
    const a = state.roiStart, b = canvasPoint(event), width = Math.abs(a.x - b.x), height = Math.abs(a.y - b.y);
    state.roiStart = null; state.roiMode = false; $('select-roi').setAttribute('aria-pressed', 'false'); $('video-stage').classList.remove('is-drawing');
    if (width < 20 || height < 20) { status('人物の全身が入るように、もう少し広く囲んでください。', true); paint(); return; }
    state.roi = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height };
    state.frames = []; state.result = null; state.points = {}; renderResults();
    $('roi-note').textContent = `選択範囲：${Math.round(width)} × ${Math.round(height)} px。観察する関節が動く範囲を含めてください。`; status('人物の範囲を設定しました。「AIで動きを解析」で計算します。'); paint();
  });
  canvas.addEventListener('pointercancel', () => { state.roiStart = null; paint(); });

  function saveCurrentPoints() {
    if (!pointKeys.some(key=>state.points[key])) { status('保存する関節を1つ以上指定してください。',true);return; }
    const input = { time: state.currentTime, points: structuredClone(state.points) };
    const index = nearestIndex(state.currentTime), epsilon = Math.max(0.000001, 0.45 / Number($('video-fps').value || 30));
    if (index >= 0 && Math.abs(state.frames[index].time - state.currentTime) <= epsilon) state.frames[index] = input;
    else state.frames.push(input);
    state.frames.sort((a, b) => a.time - b.time); state.selectedPoint = null;
    if (!state.videoReady && state.sourceKind !== 'demo') state.sourceKind = 'manual';
    updateTimeControls(); recompute(`${format(state.currentTime, 3)}秒の関節座標を保存しました。`);
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function loadResult(file) {
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) { status('結果ファイルは64MB以内のJSONを選んでください。', true); return; }
    stopOldWork(); const token = state.token;
    try {
      const imported = core.readJSON(await file.text()); if (token !== state.token) return;
      releaseVideo(); state.demoId=null; state.metricGroup=imported.metricGroup||'axes'; state.frames = imported.frames; state.sourceKind = imported.sourceKind || 'results'; state.label = imported.label || '読み込んだ解析結果';
      const values = state.frames.flatMap(frame => Object.values(frame.points || {}));
      const width = imported.width || values.reduce((maximum, point) => point && finite(point.x) ? Math.max(maximum, point.x + 60) : maximum, 960);
      const height = imported.height || values.reduce((maximum, point) => point && finite(point.y) ? Math.max(maximum, point.y + 60) : maximum, 540);
      setCanvasSize(width, height); applyOptions(imported.options);
      state.currentTime = state.frames[0]?.time || 0; $('start-time').removeAttribute('max'); $('end-time').removeAttribute('max'); timeInputs[0].setValue(state.currentTime); timeInputs[1].setValue(state.frames.at(-1)?.time || state.currentTime + 1);
      $('source-kind').textContent = state.sourceKind === 'demo' ? 'デモ' : '保存した座標'; $('stage-label').textContent = state.sourceKind === 'demo' ? 'DEMO / 保存した動き' : 'RESULT / 保存した関節'; $('stage-guide').textContent = '関節の位置と線を確認';
      sourceFeedback('results','保存した座標を読み込みました。元の映像は含まれていません。');
      resetROI(); updateTimeControls(); recompute('保存した座標と条件を読み込みました。閾値や平滑化を変えて再解析できます。'); setBusy(false);
    } catch (error) { if (token === state.token) status(error.message, true); }
  }

  $('demo-top').addEventListener('click',()=>loadDemo());
  $('open-demo').addEventListener('click',()=>loadDemo());
  $('metric-group').addEventListener('change',()=>{state.metricGroup=$('metric-group').value;renderResults();paint();status('表示する動きを切り替えました。座標はそのまま使います。');});
  $('show-trails').addEventListener('change',paint);
  $('open-url').addEventListener('click',()=>{
    const panel=$('url-panel');panel.hidden=!panel.hidden;$('open-url').setAttribute('aria-expanded',String(!panel.hidden));
    if(!panel.hidden){
      if(!state.loadingSource)sourceFeedback('input','動画ファイルのURLを入力し、「動画URLを読み込む」を押してください。');
      $('video-url').focus({preventScroll:true});panel.scrollIntoView({block:'nearest',behavior:'smooth'});
    }
  });
  $('url-form').addEventListener('submit',event=>{event.preventDefault();void loadURL();});
  $('upload-video').addEventListener('click', () => $('video-file').click());
  $('open-result').addEventListener('click', () => $('result-file').click());
  $('video-file').addEventListener('change', () => { const file = $('video-file').files[0]; $('video-file').value = ''; void loadVideo(file); });
  $('result-file').addEventListener('change', () => { const file = $('result-file').files[0]; $('result-file').value = ''; void loadResult(file); });
  $('time-position').addEventListener('input', () => { pause(); void showTime(Number($('time-position').value)); });
  $('previous-frame').addEventListener('click', () => { pause(); void showTime(state.currentTime - 1 / Number($('video-fps').value || 30)); });
  $('next-frame').addEventListener('click', () => { pause(); void showTime(state.currentTime + 1 / Number($('video-fps').value || 30)); });
  $('play-video').addEventListener('click', () => { void togglePlay(); });
  $('range-reset').addEventListener('click', () => { const [start, end] = timeLimits(); timeInputs[0].setValue(start); timeInputs[1].setValue(end); status('開始・終了を映像全体の秒数に戻しました。'); });
  $('select-roi').addEventListener('click', () => {
    if (!state.videoReady) { status('「ファイルから開く」か「URLから開く」で映像を選んでください。'); return; }
    pause(); state.selectedPoint = null; state.roiMode = !state.roiMode; state.roiStart = null; updatePointButtons();
    $('select-roi').setAttribute('aria-pressed', String(state.roiMode)); $('video-stage').classList.toggle('is-drawing', state.roiMode); $('video-stage').classList.remove('is-manual');
    status(state.roiMode ? '映像の上をドラッグして、人物を囲んでください。' : '範囲の指定を終了しました。');
  });
  $('clear-roi').addEventListener('click', () => { const hadROI = !!state.roi; resetROI(); if (hadROI && state.videoReady) { state.frames = []; state.result = null; state.points = {}; renderResults(); paint(); status('映像全体を解析する範囲に戻しました。再度解析してください。'); } });
  document.querySelectorAll('[data-point]').forEach(button => button.addEventListener('click', () => {
    pause(); state.roiMode = false; state.roiStart = null; state.selectedPoint = button.dataset.point; $('select-roi').setAttribute('aria-pressed', 'false'); $('video-stage').classList.remove('is-drawing'); $('video-stage').classList.add('is-manual'); updatePointButtons();
    $('manual-note').textContent = `${pointLabels[state.selectedPoint]}を映像上でクリックしてください。`;
  }));
  $('save-points').addEventListener('click', saveCurrentPoints);
  $('clear-points').addEventListener('click', () => { state.points={};state.selectedPoint=activeGroup().pointNames[0];updatePointButtons();paint();$('manual-note').textContent='観察する関節の位置を指定してください。'; $('video-stage').classList.add('is-manual'); });
  $('analyse-video').addEventListener('click', () => { void analyseVideo(); });
  function cancelWork() {
    const loading=state.loadingSource;stopOldWork();state.points={};
    if(loading){releaseVideo();sourceFeedback('cancelled','動画の読み込みを中止しました。別のURLや動画ファイルで再度お試しください。');$('stage-label').textContent='VIDEO / 読み込みを中止';$('stage-guide').textContent='動画ファイルかURLを選んでください';}
    paint();status('処理を中止しました。動画や条件を選んで再度解析できます。');
  }
  $('cancel-analysis').addEventListener('click',cancelWork);
  $('cancel-source').addEventListener('click',cancelWork);
  for (const id of ['confidence-threshold', 'min-span', 'smoothing', 'slow-factor']) $(id).addEventListener('change', () => { $('confidence-value').textContent = Number($('confidence-threshold').value).toFixed(2); recompute('条件を変えてグラフを更新しました。'); });
  $('confidence-threshold').addEventListener('input', () => { $('confidence-value').textContent = Number($('confidence-threshold').value).toFixed(2); });
  $('download-csv').addEventListener('click', () => { if (state.result) download('MotionAnalysis_values.csv', core.exportCSV(state.result), 'text/csv;charset=utf-8'); });
  $('download-json').addEventListener('click', () => { if (state.result) download('MotionAnalysis_coordinates.json', core.exportJSON(state.result, { label: state.label, sourceKind: state.sourceKind, metricGroup: state.metricGroup, width: state.width, height: state.height }), 'application/json;charset=utf-8'); });
  $('clear-results').addEventListener('click', () => { stopOldWork(); state.frames = []; state.result = null; state.points = {}; updatePointButtons(); renderResults(); paint(); updateReadout(); status('結果をリセットしました。動画を解析するか、デモを開いてください。'); });
  window.addEventListener('pagehide', () => { state.loadController?.abort();pause(); if (state.videoUrl) URL.revokeObjectURL(state.videoUrl); });

  if (!core) { status('角度の計算ファイルを読み込めませんでした。ページを読み直してください。', true); return; }
  loadDemo();
})();
