/* 画像上の線の向き、関節の内角、体幹の傾きと時間変化を計算する。 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.SwingMotionCore = api; root.MotionAnalysisCore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = '2.0.0';
  const DEFAULT_OPTIONS = Object.freeze({
    confidenceThreshold: 0.5, minSpanPx: 12, smoothingWindow: 3, timeScale: 1
  });
  const LIMITS = Object.freeze({ maxFrames: 20000, maxTimeSeconds: 86400,
    maxCoordinate: 1000000, maxJSONCharacters: 64000000 });
  const POINT_NAMES = Object.freeze(['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
    'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle']);
  const metric = (id, label, colour) => Object.freeze({ id, label, colour,
    angleKey: id + 'Angle', velocityKey: id + 'Velocity', validKey: id + 'Valid', segmentKey: id + 'Segment' });
  const group = (id, label, description, metrics, pointNames) => Object.freeze({ id, label, description,
    metrics: Object.freeze(metrics), pointNames: Object.freeze(pointNames) });
  const METRIC_GROUPS = Object.freeze({
    axes: group('axes', '肩と腰の向き', '右向きが0度、反時計回りが正です。',
      [metric('shoulder', '肩', '#5379ff'), metric('hip', '腰', '#ff907d')],
      ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip']),
    elbows: group('elbows', '肘の曲がり', '肩・肘・手首の内角です。腕が伸びるほど180度に近づきます。',
      [metric('leftElbow', '左肘', '#5379ff'), metric('rightElbow', '右肘', '#ff907d')],
      ['leftShoulder', 'leftElbow', 'leftWrist', 'rightShoulder', 'rightElbow', 'rightWrist']),
    knees: group('knees', '膝の曲がり', '腰・膝・足首の内角です。脚が伸びるほど180度に近づきます。',
      [metric('leftKnee', '左膝', '#5379ff'), metric('rightKnee', '右膝', '#ff907d')],
      ['leftHip', 'leftKnee', 'leftAnkle', 'rightHip', 'rightKnee', 'rightAnkle']),
    trunk: group('trunk', '体幹の傾き', '腰の中心から肩の中心へ引いた線です。直立が0度、画面の右への傾きが正です。',
      [metric('trunkTilt', '体幹', '#5379ff')], ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'])
  });
  const METRIC_PERIODS = Object.freeze({ shoulder: 180, hip: 180, leftElbow: null, rightElbow: null,
    leftKnee: null, rightKnee: null, trunkTilt: 360 });
  const SOURCE_KINDS = new Set(['demo', 'video', 'manual', 'results', 'unknown']);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function normaliseOptions(options) {
    if (options == null) options = {};
    if (!isObject(options)) throw new TypeError('解析条件はオブジェクトで指定してください。');
    const result = { ...DEFAULT_OPTIONS };
    for (const name of Object.keys(result)) {
      if (options[name] !== undefined) result[name] = options[name];
    }
    if (!finite(result.confidenceThreshold) || result.confidenceThreshold < 0 || result.confidenceThreshold > 1)
      throw new RangeError('信頼度のしきい値は0から1で指定してください。');
    if (!finite(result.minSpanPx) || result.minSpanPx <= 0 || result.minSpanPx > LIMITS.maxCoordinate)
      throw new RangeError('線の最小長は0より大きいピクセル数で指定してください。');
    if (![1, 3, 5, 7].includes(result.smoothingWindow))
      throw new RangeError('平滑化の窓は1・3・5・7から選んでください。');
    if (!finite(result.timeScale) || result.timeScale < 0.001 || result.timeScale > 1000)
      throw new RangeError('実時間への換算係数は0.001から1000で指定してください。');
    return result;
  }

  function normalisePoint(point, location) {
    if (point == null) return null;
    if (!isObject(point)) throw new TypeError(`${location}の座標形式が正しくありません。`);
    const confidence = point.confidence === undefined ? 1 : point.confidence;
    if (confidence === null || (typeof confidence === 'number' && !Number.isFinite(confidence))) return null;
    if (!finite(confidence) || confidence < 0 || confidence > 1)
      throw new RangeError(`${location}の信頼度は0から1で指定してください。`);
    for (const key of ['x', 'y']) {
      if (point[key] != null && typeof point[key] !== 'number')
        throw new TypeError(`${location}の${key}座標は数値で指定してください。`);
    }
    if (!finite(point.x) || !finite(point.y)) return null;
    if (Math.abs(point.x) > LIMITS.maxCoordinate || Math.abs(point.y) > LIMITS.maxCoordinate)
      throw new RangeError(`${location}の座標が大きすぎます。`);
    return { x: point.x, y: point.y, confidence };
  }

  function normaliseFrames(frames) {
    if (!Array.isArray(frames) || frames.length === 0)
      throw new TypeError('少なくとも1時点の座標を用意してください。');
    if (frames.length > LIMITS.maxFrames)
      throw new RangeError(`座標は${LIMITS.maxFrames}時点以内にしてください。`);
    let previousTime = -Infinity;
    return frames.map((row, index) => {
      if (!isObject(row)) throw new TypeError(`${index + 1}時点目の形式が正しくありません。`);
      if (!finite(row.time) || row.time < 0 || row.time > LIMITS.maxTimeSeconds)
        throw new RangeError('動画内の時刻は0から86400秒の有限な数値で指定してください。');
      if (row.time <= previousTime || (index > 0 && row.time - previousTime < 1e-9))
        throw new RangeError('時刻は重複させず、小さい順に並べてください。');
      previousTime = row.time;
      const frame = row.frame === undefined ? index : row.frame;
      if (!Number.isSafeInteger(frame) || frame < 0)
        throw new RangeError('フレーム番号は0以上の整数で指定してください。');
      const points = row.points == null ? {} : row.points;
      if (!isObject(points)) throw new TypeError('pointsには関節の座標を指定してください。');
      const selected = {};
      for (const name of POINT_NAMES) selected[name] = normalisePoint(points[name], `${index + 1}時点目の${name}`);
      return { time: row.time, frame, points: selected };
    });
  }

  function wrapPeriod(angle, period) {
    if (!finite(angle)) return null;
    const result = ((angle + period / 2) % period + period) % period - period / 2;
    return Object.is(result, -0) ? 0 : result;
  }
  function wrapAxisAngle(angle) { return wrapPeriod(angle, 180); }

  function axisMeasurement(a, b, options) {
    if (!a || !b) return { raw: null, confidence: null, span: null, valid: false, reason: 'missing' };
    const confidence = Math.min(a.confidence, b.confidence);
    const dx = b.x - a.x, dy = a.y - b.y;
    const span = Math.hypot(dx, dy);
    if (confidence < options.confidenceThreshold)
      return { raw: null, confidence, span, valid: false, reason: 'confidence' };
    if (span < options.minSpanPx)
      return { raw: null, confidence, span, valid: false, reason: 'short-axis' };
    return { raw: wrapAxisAngle(Math.atan2(dy, dx) * 180 / Math.PI), confidence, span, valid: true, reason: '' };
  }

  function jointMeasurement(a, vertex, c, options) {
    if (!a || !vertex || !c) return { raw: null, confidence: null, span: null, valid: false, reason: 'missing' };
    const confidence = Math.min(a.confidence, vertex.confidence, c.confidence);
    const ax = a.x - vertex.x, ay = a.y - vertex.y;
    const cx = c.x - vertex.x, cy = c.y - vertex.y;
    const span = Math.min(Math.hypot(ax, ay), Math.hypot(cx, cy));
    if (confidence < options.confidenceThreshold)
      return { raw: null, confidence, span, valid: false, reason: 'confidence' };
    if (span < options.minSpanPx)
      return { raw: null, confidence, span, valid: false, reason: 'short-axis' };
    const raw = Math.atan2(Math.abs(ax * cy - ay * cx), ax * cx + ay * cy) * 180 / Math.PI;
    return { raw, confidence, span, valid: true, reason: '' };
  }

  function trunkMeasurement(points, options) {
    const names = METRIC_GROUPS.trunk.pointNames;
    if (names.some(name => !points[name]))
      return { raw: null, confidence: null, span: null, valid: false, reason: 'missing' };
    const confidence = Math.min(...names.map(name => points[name].confidence));
    const dx = (points.leftShoulder.x + points.rightShoulder.x - points.leftHip.x - points.rightHip.x) / 2;
    const up = (points.leftHip.y + points.rightHip.y - points.leftShoulder.y - points.rightShoulder.y) / 2;
    const span = Math.hypot(dx, up);
    if (confidence < options.confidenceThreshold)
      return { raw: null, confidence, span, valid: false, reason: 'confidence' };
    if (span < options.minSpanPx)
      return { raw: null, confidence, span, valid: false, reason: 'short-axis' };
    return { raw: wrapPeriod(Math.atan2(dx, up) * 180 / Math.PI, 360), confidence, span, valid: true, reason: '' };
  }

  function contiguousSegments(raw, period) {
    const segments = [];
    const unwrapped = Array(raw.length).fill(null);
    const ambiguous = Array(raw.length).fill(false);
    let active = [];
    function finish() { if (active.length) segments.push(active); active = []; }
    for (let index = 0; index < raw.length; index++) {
      if (raw[index] === null) { finish(); continue; }
      if (active.length === 0) {
        unwrapped[index] = raw[index]; active.push(index); continue;
      }
      const previous = active[active.length - 1];
      const change = period ? wrapPeriod(raw[index] - raw[previous], period) : raw[index] - raw[previous];
      // 周期の半分だけ変わると回転方向を区別できないため区切る。
      if (period && Math.abs(Math.abs(change) - period / 2) < 1e-8) {
        finish(); ambiguous[index] = true; unwrapped[index] = raw[index]; active.push(index);
      } else {
        unwrapped[index] = unwrapped[previous] + change; active.push(index);
      }
    }
    finish();
    return { segments, unwrapped, ambiguous };
  }

  function smoothSegment(indices, values, times, window) {
    const half = Math.floor(window / 2);
    return indices.map((index, position) => {
      if (window === 1) return values[index];
      const neighbours = indices.slice(Math.max(0, position - half), position + half + 1);
      if (neighbours.length < 3) return values[index];
      // 実際の時刻を使う局所直線。一定の角速度を平滑化で変えない。
      const centre = times[index];
      let meanX = 0, meanY = 0;
      for (const neighbour of neighbours) { meanX += times[neighbour] - centre; meanY += values[neighbour]; }
      meanX /= neighbours.length; meanY /= neighbours.length;
      let numerator = 0, denominator = 0;
      for (const neighbour of neighbours) {
        const dx = times[neighbour] - centre - meanX;
        numerator += dx * (values[neighbour] - meanY); denominator += dx * dx;
      }
      return denominator > 0 ? meanY - numerator / denominator * meanX : values[index];
    });
  }

  function processMetric(raw, times, window, period) {
    const { segments, unwrapped, ambiguous } = contiguousSegments(raw, period);
    const angles = Array(raw.length).fill(null), velocities = Array(raw.length).fill(null);
    const rawVelocities = Array(raw.length).fill(null), segmentIds = Array(raw.length).fill(null);
    segments.forEach((indices, segmentId) => {
      const fitted = smoothSegment(indices, unwrapped, times, window);
      const smoothed = period ? fitted : fitted.map(value => Math.max(0, Math.min(180, value)));
      indices.forEach((index, position) => {
        segmentIds[index] = segmentId; angles[index] = smoothed[position];
        if (position === 0) return;
        const previous = indices[position - 1], dt = times[index] - times[previous];
        velocities[index] = (smoothed[position] - smoothed[position - 1]) / dt;
        rawVelocities[index] = (unwrapped[index] - unwrapped[previous]) / dt;
      });
    });
    return { angles, velocities, rawVelocities, unwrapped, ambiguous, segmentIds };
  }

  function peakAbs(rows, key) {
    let result = null;
    for (const row of rows) if (finite(row[key])) result = Math.max(result === null ? 0 : result, Math.abs(row[key]));
    return result;
  }

  function analyse(frames, suppliedOptions) {
    const options = normaliseOptions(suppliedOptions), inputFrames = normaliseFrames(frames);
    const times = inputFrames.map(row => row.time * options.timeScale);
    const measurements = inputFrames.map(row => ({
      shoulder: axisMeasurement(row.points.leftShoulder, row.points.rightShoulder, options),
      hip: axisMeasurement(row.points.leftHip, row.points.rightHip, options),
      leftElbow: jointMeasurement(row.points.leftShoulder, row.points.leftElbow, row.points.leftWrist, options),
      rightElbow: jointMeasurement(row.points.rightShoulder, row.points.rightElbow, row.points.rightWrist, options),
      leftKnee: jointMeasurement(row.points.leftHip, row.points.leftKnee, row.points.leftAnkle, options),
      rightKnee: jointMeasurement(row.points.rightHip, row.points.rightKnee, row.points.rightAnkle, options),
      trunkTilt: trunkMeasurement(row.points, options)
    }));
    const seriesByMetric = {};
    for (const [name, period] of Object.entries(METRIC_PERIODS))
      seriesByMetric[name] = processMetric(measurements.map(row => row[name].raw), times, options.smoothingWindow, period);
    const shoulder = seriesByMetric.shoulder, hip = seriesByMetric.hip;
    const output = inputFrames.map((row, index) => {
      const item = { frame: row.frame, time: row.time, timeSeconds: times[index],
        elapsedSeconds: times[index] - times[0] };
      for (const [name, series] of Object.entries(seriesByMetric)) {
        const measured = measurements[index][name];
        item[name + 'AngleRaw'] = measured.raw;
        item[name + 'AngleUnwrapped'] = series.unwrapped[index];
        item[name + 'Angle'] = series.angles[index];
        item[name + 'VelocityRaw'] = series.rawVelocities[index];
        item[name + 'Velocity'] = series.velocities[index];
        item[name + 'Confidence'] = measured.confidence;
        item[name + 'SpanPx'] = measured.span;
        item[name + 'Valid'] = measured.valid;
        item[name + 'Reason'] = measured.reason;
        item[name + 'Ambiguous'] = series.ambiguous[index];
        item[name + 'Segment'] = series.segmentIds[index];
      }
      item.relativeAngle = shoulder.angles[index] === null || hip.angles[index] === null ? null
        : wrapAxisAngle(shoulder.angles[index] - hip.angles[index]);
      return item;
    });
    const count = key => output.filter(row => row[key]).length;
    const shoulderValidCount = count('shoulderValid'), hipValidCount = count('hipValid');
    const summary = {
      frameCount: output.length, videoDurationSeconds: inputFrames.at(-1).time - inputFrames[0].time,
      durationSeconds: times.at(-1) - times[0], shoulderValidCount, hipValidCount,
      pairedValidCount: output.filter(row => row.shoulderValid && row.hipValid).length,
      shoulderValidRate: shoulderValidCount / output.length, hipValidRate: hipValidCount / output.length,
      shoulderVelocityCount: output.filter(row => row.shoulderVelocity !== null).length,
      hipVelocityCount: output.filter(row => row.hipVelocity !== null).length,
      shoulderPeakAbsVelocity: peakAbs(output, 'shoulderVelocity'),
      hipPeakAbsVelocity: peakAbs(output, 'hipVelocity'), relativePeakAbsAngle: peakAbs(output, 'relativeAngle')
    };
    summary.metrics = {};
    for (const name of Object.keys(METRIC_PERIODS)) {
      const values = output.map(row => row[name + 'Angle']).filter(finite);
      const validCount = count(name + 'Valid');
      summary.metrics[name] = {
        validCount, validRate: validCount / output.length,
        velocityCount: output.filter(row => row[name + 'Velocity'] !== null).length,
        peakAbsVelocity: peakAbs(output, name + 'Velocity'),
        minAngle: values.length ? Math.min(...values) : null,
        maxAngle: values.length ? Math.max(...values) : null
      };
    }
    return { schemaVersion: SCHEMA_VERSION, options, inputFrames, frames: output, summary };
  }

  function checkedResult(result) {
    if (!isObject(result) || result.schemaVersion !== SCHEMA_VERSION || !Array.isArray(result.inputFrames))
      throw new TypeError('解析結果を指定してください。');
    // 保存内容は入力と設定から組み立て、表示用の値の書き換えを引き継がない。
    return analyse(result.inputFrames, result.options);
  }

  function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function exportCSV(result) {
    const current = checkedResult(result);
    const fields = [
      ['frame', 'frame'], ['video_time_s', 'time'], ['analysis_time_s', 'timeSeconds'], ['elapsed_time_s', 'elapsedSeconds'],
      ['shoulder_angle_raw_deg', 'shoulderAngleRaw'], ['shoulder_angle_unwrapped_deg', 'shoulderAngleUnwrapped'],
      ['shoulder_angle_smoothed_deg', 'shoulderAngle'], ['shoulder_velocity_raw_deg_s', 'shoulderVelocityRaw'],
      ['shoulder_velocity_smoothed_deg_s', 'shoulderVelocity'], ['shoulder_confidence', 'shoulderConfidence'],
      ['shoulder_span_px', 'shoulderSpanPx'], ['shoulder_valid', 'shoulderValid'], ['shoulder_ambiguous_step', 'shoulderAmbiguous'],
      ['hip_angle_raw_deg', 'hipAngleRaw'], ['hip_angle_unwrapped_deg', 'hipAngleUnwrapped'],
      ['hip_angle_smoothed_deg', 'hipAngle'], ['hip_velocity_raw_deg_s', 'hipVelocityRaw'],
      ['hip_velocity_smoothed_deg_s', 'hipVelocity'], ['hip_confidence', 'hipConfidence'], ['hip_span_px', 'hipSpanPx'],
      ['hip_valid', 'hipValid'], ['hip_ambiguous_step', 'hipAmbiguous'], ['shoulder_minus_hip_deg', 'relativeAngle']
    ];
    for (const name of ['leftElbow', 'rightElbow', 'leftKnee', 'rightKnee', 'trunkTilt']) {
      const prefix = name.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
      for (const [suffix, column] of [['AngleRaw', 'angle_raw_deg'], ['AngleUnwrapped', 'angle_unwrapped_deg'],
        ['Angle', 'angle_smoothed_deg'], ['VelocityRaw', 'velocity_raw_deg_s'], ['Velocity', 'velocity_smoothed_deg_s'],
        ['Confidence', 'confidence'], ['SpanPx', 'span_px'], ['Valid', 'valid'], ['Ambiguous', 'ambiguous_step'], ['Reason', 'reason']])
        fields.push([prefix + '_' + column, name + suffix]);
    }
    const pointHeaders = POINT_NAMES.flatMap(name => {
      const prefix = name.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
      return [prefix + '_x_px', prefix + '_y_px', prefix + '_confidence'];
    });
    const lines = [fields.map(([header]) => header).concat(pointHeaders).join(',')];
    current.frames.forEach((row, index) => {
      const values = fields.map(([, key]) => row[key]);
      for (const name of POINT_NAMES) {
        const point = current.inputFrames[index].points[name];
        values.push(point ? point.x : null, point ? point.y : null, point ? point.confidence : null);
      }
      lines.push(values.map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function labelText(label) {
    if (label === undefined) return '';
    if (typeof label !== 'string' || label.length > 200) throw new TypeError('データ名は200文字以内で指定してください。');
    return label.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }

  function dimension(value, label) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > 100000)
      throw new RangeError(`${label}は1から100000の整数で指定してください。`);
    return value;
  }

  function metricGroup(value) {
    if (value === undefined) return 'axes';
    if (typeof value !== 'string' || !Object.hasOwn(METRIC_GROUPS, value))
      throw new TypeError('解析する部位を確認してください。');
    return value;
  }

  function exportJSON(result, metadata) {
    const current = checkedResult(result);
    if (metadata == null) metadata = {};
    if (!isObject(metadata)) throw new TypeError('保存するデータ名などはオブジェクトで指定してください。');
    const sourceKind = metadata.sourceKind === undefined ? 'unknown' : metadata.sourceKind;
    if (!SOURCE_KINDS.has(sourceKind)) throw new TypeError('データの種類を確認してください。');
    const text = JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: 'motion-analysis-points',
      label: labelText(metadata.label), sourceKind, metricGroup: metricGroup(metadata.metricGroup),
      width: dimension(metadata.width, '画像の幅'), height: dimension(metadata.height, '画像の高さ'),
      options: current.options, frames: current.inputFrames }, null, 2);
    if (text.length > LIMITS.maxJSONCharacters) throw new RangeError('保存するJSONが大きすぎます。時点数を減らしてください。');
    return text;
  }

  function readJSON(text) {
    if (typeof text !== 'string' || text.length > LIMITS.maxJSONCharacters)
      throw new TypeError('JSONファイルの形式と大きさを確認してください。');
    let data;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch (_) { throw new TypeError('JSONとして読み込めませんでした。'); }
    if (!isObject(data) || !((data.schemaVersion === SCHEMA_VERSION && data.kind === 'motion-analysis-points')
      || (data.schemaVersion === '1.0.0' && data.kind === 'swing-motion-points')))
      throw new TypeError('対応した動作解析のJSONを選んでください。');
    const sourceKind = data.sourceKind === undefined ? 'unknown' : data.sourceKind;
    if (!SOURCE_KINDS.has(sourceKind)) throw new TypeError('データの種類を確認してください。');
    return { schemaVersion: SCHEMA_VERSION, label: labelText(data.label), sourceKind,
      metricGroup: data.schemaVersion === '1.0.0' ? 'axes' : metricGroup(data.metricGroup),
      width: dimension(data.width, '画像の幅'), height: dimension(data.height, '画像の高さ'),
      frames: normaliseFrames(data.frames), options: normaliseOptions(data.options) };
  }

  return Object.freeze({ SCHEMA_VERSION, DEFAULT_OPTIONS, LIMITS, POINT_NAMES, METRIC_GROUPS,
    normaliseOptions, normaliseFrames, wrapAxisAngle, analyse, exportCSV, exportJSON, readJSON });
});
