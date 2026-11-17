/* 実測値ではなく、動作の順序と画像上の関節角を学ぶための合成人体デモ。 */
(function (root) {
  'use strict';
  const radians = degrees => degrees * Math.PI / 180;
  const point = (x, y) => ({ x, y, confidence: 0.96 });
  const add = (a, b) => a.map((value, index) => value + b[index]);
  const subtract = (a, b) => a.map((value, index) => value - b[index]);
  const multiply = (a, amount) => a.map(value => value * amount);
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  function unit(vector) { return multiply(vector, 1 / Math.hypot(...vector)); }
  function ease(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }
  // 小さな奥行きを残した正投影。身体の水平回転を、画面内の回転に置き換えない。
  function project(position) {
    return point(480 + position[0] + 0.38 * position[2], 490 - position[1] + 0.18 * position[2]);
  }
  function bodyAxis(centre, yaw, halfWidth) {
    const offset = [halfWidth * Math.cos(radians(yaw)), 0, halfWidth * Math.sin(radians(yaw))];
    return [subtract(centre, offset), add(centre, offset)];
  }
  // 二つの一定長の骨から、目標位置に届く肘・膝を作る。
  function bendJoint(start, end, upperLength, lowerLength, bendTowards) {
    const difference = subtract(end, start), distance = Math.hypot(...difference);
    const direction = unit(difference);
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
    const perpendicular = unit(subtract(bendTowards, multiply(direction, dot(bendTowards, direction))));
    return add(add(start, multiply(direction, along)), multiply(perpendicular, height));
  }
  // 時刻を含めた三次補間で、構え・加速・振り抜きの間を滑らかにつなぐ。
  function handPosition(time) {
    const keys = [[0, -46, 252, 12], [0.85, -57, 263, -5], [1.2, -48, 258, 0],
      [1.65, 53, 229, 55], [1.88, 65, 237, 53], [2.45, 16, 286, 5], [3.1, -12, 285, -12], [4, -12, 285, -12]];
    let index = 0;
    while (index < keys.length - 2 && time > keys[index + 1][0]) index++;
    const a = keys[index], b = keys[index + 1], before = keys[Math.max(0, index - 1)], after = keys[Math.min(keys.length - 1, index + 2)];
    const duration = b[0] - a[0], u = Math.max(0, Math.min(1, (time - a[0]) / duration));
    return [1, 2, 3].map(axis => {
      const firstSlope = index === 0 ? 0 : (b[axis] - before[axis]) / (b[0] - before[0]);
      const lastSlope = index + 1 === keys.length - 1 ? 0 : (after[axis] - a[axis]) / (after[0] - a[0]);
      return (2 * u ** 3 - 3 * u ** 2 + 1) * a[axis] + (u ** 3 - 2 * u ** 2 + u) * duration * firstSlope
        + (-2 * u ** 3 + 3 * u ** 2) * b[axis] + (u ** 3 - u ** 2) * duration * lastSlope;
    });
  }
  function swingPose(time) {
    const load = ease(time / 0.9), drive = ease((time - 1.05) / 0.9), follow = ease((time - 1.65) / 1.1);
    const hipTurn = -4 - 16 * load + 85 * drive;
    const shoulderTurn = -12 - 26 * load + 126 * ease((time - 1.3) / 1.05);
    const shift = -10 * load + 37 * drive;
    const hipCentre = [shift, 179 - 7 * load + 13 * follow, 0];
    const shoulderCentre = [shift + 6 + 7 * drive, hipCentre[1] + 130, 18];
    const [leftShoulder, rightShoulder] = bodyAxis(shoulderCentre, shoulderTurn, 54);
    const [leftHip, rightHip] = bodyAxis(hipCentre, hipTurn, 35);
    const world = { leftShoulder, rightShoulder, leftHip, rightHip };
    const grip = add(handPosition(time), [shift, 0, 0]);
    const batAngle = -108 - 18 * load + 146 * ease((time - 1.22) / 0.64) + 193 * ease((time - 1.86) / 0.8);
    const batDirection = unit([Math.cos(radians(batAngle)), -Math.sin(radians(batAngle)), -0.18]);
    for (const [side, sign] of [['left', -1], ['right', 1]]) {
      const ankle = [sign < 0 ? -64 : 73, 10 + (sign < 0 ? 5 * follow : 0), sign < 0 ? 4 : -8];
      world[side + 'Ankle'] = ankle;
      world[side + 'Knee'] = bendJoint(world[side + 'Hip'], ankle, 98, 98, [0, 0, 1]);
      const wrist = add(grip, multiply(batDirection, sign * 4));
      world[side + 'Wrist'] = wrist;
      world[side + 'Elbow'] = bendJoint(world[side + 'Shoulder'], wrist, 82, 80, [sign * 0.65, -0.5, 0.8]);
    }
    return { points: Object.fromEntries(Object.entries(world).map(([name, value]) => [name, project(value)])),
      batDirection: subtractPoint(project(add(grip, multiply(batDirection, 160))), project(grip)),
      faceTurn: Math.sin(radians(shoulderTurn)) * 0.5 + 0.25,
      phase: time < 0.9 ? '構え → 体重をためる' : time < 1.3 ? '腰から動き始める' : time < 1.9 ? '腕とバットを加速する' : time < 2.7 ? '振り抜く' : '姿勢を保つ' };
  }
  function subtractPoint(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function squatPose(time) {
    const bend = 0.5 * (1 - Math.cos(Math.PI * time));
    const halfBend = radians(45 * bend), lean = radians(-9 * bend), leg = 95;
    const reach = 2 * leg * Math.cos(halfBend), points = {};
    for (const [side, ankleX, shoulderOffset] of [['left', 435, -8], ['right', 495, 8]]) {
      const ankle = point(ankleX, 484);
      const hip = point(ankle.x + reach * Math.sin(lean), ankle.y - reach * Math.cos(lean));
      const knee = point((hip.x + ankle.x) / 2 + leg * Math.sin(halfBend) * Math.cos(lean),
        (hip.y + ankle.y) / 2 + leg * Math.sin(halfBend) * Math.sin(lean));
      const trunkLean = radians(15 * bend);
      const shoulder = point(hip.x + shoulderOffset + 135 * Math.sin(trunkLean), hip.y - 135 * Math.cos(trunkLean));
      points[side + 'Ankle'] = ankle; points[side + 'Knee'] = knee;
      points[side + 'Hip'] = hip; points[side + 'Shoulder'] = shoulder;
      points[side + 'Elbow'] = point(shoulder.x + 65, shoulder.y - 4);
      points[side + 'Wrist'] = point(shoulder.x + 124, shoulder.y - 16);
    }
    return { points, faceTurn: 0.75, phase: Math.sin(Math.PI * time) >= 0 ? 'ゆっくり腰を下ろす' : '足で床を押して立つ' };
  }
  function armPose(time) {
    const bend = 0.5 * (1 - Math.cos(Math.PI * time / 2));
    const points = { leftShoulder: point(410, 184), rightShoulder: point(530, 184), leftHip: point(432, 326), rightHip: point(508, 326) };
    for (const [side, sign, amount] of [['left', -1, 135], ['right', 1, 100]]) {
      const shoulder = points[side + 'Shoulder'], angle = radians(180 - amount * bend);
      const elbow = point(shoulder.x + sign * 6, shoulder.y + Math.sqrt(80 ** 2 - 6 ** 2));
      // 上腕の傾きを含めて回すので、表示する肘角は指定した値に一致する。
      const upperTilt = Math.atan2(6, Math.sqrt(80 ** 2 - 6 ** 2));
      const forearmAngle = angle - upperTilt;
      points[side + 'Elbow'] = elbow;
      points[side + 'Wrist'] = point(elbow.x + sign * 78 * Math.sin(forearmAngle), elbow.y - 78 * Math.cos(forearmAngle));
      const hip = points[side + 'Hip'];
      points[side + 'Knee'] = point(hip.x + sign * 7, 405);
      points[side + 'Ankle'] = point(hip.x + sign * 14, 484);
    }
    return { points, faceTurn: 0.12, phase: time < 2 ? '肘の位置を保って曲げる' : 'ゆっくり腕を戻す' };
  }
  function poseAt(id, time) {
    const safeTime = Math.max(0, Math.min(4, Number.isFinite(time) ? time : 0));
    return id === 'squat' ? squatPose(safeTime) : id === 'arm' ? armPose(safeTime) : swingPose(safeTime);
  }
  function makeDemo(id, label, metricGroup) {
    const frames = Array.from({ length: 121 }, (_, frame) => ({ time: frame / 30, frame, points: poseAt(id, frame / 30).points }));
    return { id, label, sourceKind: 'demo', metricGroup, width: 960, height: 540, fps: 30,
      description: '人体の動作を簡略化した合成アニメーションです。実際の撮影映像や実測値ではありません。',
      options: { confidenceThreshold: 0.5, minSpanPx: 12, smoothingWindow: 3, timeScale: 1 }, frames };
  }
  const demos = { swing: makeDemo('swing', 'デモ：スイングと体重移動', 'axes'),
    squat: makeDemo('squat', 'デモ：スクワットの膝の曲がり', 'knees'), arm: makeDemo('arm', 'デモ：腕の曲げ伸ばし', 'elbows') };
  const api = { poseAt };
  if (typeof module === 'object' && module.exports) module.exports = { ...demos.swing, demos, ...api };
  if (root) { root.SWING_DEMO = demos.swing; root.MOTION_DEMOS = demos; root.MotionDemoData = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
