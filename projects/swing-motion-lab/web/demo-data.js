/* 関節の線と角度の関係を確かめる、幾何学的なデモ座標。 */
(function (root) {
  'use strict';
  const point = (x, y) => ({ x, y, confidence: 0.96 });
  function ease(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }
  function axis(angle, centreX, centreY, span) {
    const radians = angle * Math.PI / 180;
    const dx = Math.cos(radians) * span / 2, dy = Math.sin(radians) * span / 2;
    return [point(centreX - dx, centreY + dy), point(centreX + dx, centreY - dy)];
  }
  function standingLegs(points) {
    for (const [side, direction] of [['left', -1], ['right', 1]]) {
      const hip = points[side + 'Hip'];
      points[side + 'Knee'] = point(hip.x + direction * 20, hip.y + 80);
      points[side + 'Ankle'] = point(hip.x + direction * 32, hip.y + 160);
    }
    return points;
  }
  function swingPoints(time) {
    const shoulderTurn = ease((time - 1.37) / 0.62), hipTurn = ease((time - 1.0) / 0.9);
    const centreX = 470 + 35 * hipTurn;
    const [leftShoulder, rightShoulder] = axis(-38 + 135 * shoulderTurn, centreX + 4, 215, 128 - 14 * shoulderTurn);
    const [leftHip, rightHip] = axis(-15 + 95 * hipTurn, centreX, 335, 96 - 10 * hipTurn);
    const points = standingLegs({ leftShoulder, rightShoulder, leftHip, rightHip });
    for (const [side, direction] of [['left', -1], ['right', 1]]) {
      const shoulder = points[side + 'Shoulder'];
      points[side + 'Elbow'] = point(shoulder.x + 65 + direction * 5, shoulder.y + 50);
      points[side + 'Wrist'] = point(shoulder.x + 135 + 35 * shoulderTurn, shoulder.y + 5 - 55 * shoulderTurn);
    }
    return points;
  }
  function squatPoints(time) {
    const bend = 0.5 * (1 - Math.cos(Math.PI * time));
    const legAngle = 45 * bend * Math.PI / 180;
    const leg = 95, hipY = 490 - 2 * leg * Math.cos(legAngle), shoulderY = hipY - 135;
    const points = {};
    for (const [side, x] of [['left', 435], ['right', 505]]) {
      points[side + 'Hip'] = point(x, hipY);
      points[side + 'Knee'] = point(x + leg * Math.sin(legAngle), hipY + leg * Math.cos(legAngle));
      points[side + 'Ankle'] = point(x, 490);
      points[side + 'Shoulder'] = point(x, shoulderY);
      points[side + 'Elbow'] = point(x + 60, shoulderY + 50);
      points[side + 'Wrist'] = point(x + 115, shoulderY + 10);
    }
    return points;
  }
  function armPoints(time) {
    const bend = 0.5 * (1 - Math.cos(Math.PI * time / 2));
    const points = standingLegs({ leftShoulder: point(405, 190), rightShoulder: point(535, 190),
      leftHip: point(422, 325), rightHip: point(518, 325) });
    for (const [side, direction, amount] of [['left', -1, 135], ['right', 1, 100]]) {
      const shoulder = points[side + 'Shoulder'], angle = (180 - amount * bend) * Math.PI / 180;
      const elbow = point(shoulder.x, shoulder.y + 80);
      points[side + 'Elbow'] = elbow;
      points[side + 'Wrist'] = point(elbow.x + direction * 78 * Math.sin(angle), elbow.y - 78 * Math.cos(angle));
    }
    return points;
  }
  function makeDemo(id, label, metricGroup, makePoints) {
    const frames = Array.from({ length: 121 }, (_, frame) => ({ time: frame / 30, frame, points: makePoints(frame / 30) }));
    return { id, label, sourceKind: 'demo', metricGroup, width: 960, height: 540, fps: 30,
      description: '関節の線と角度の関係を確かめるデモ座標です。',
      options: { confidenceThreshold: 0.5, minSpanPx: 12, smoothingWindow: 3, timeScale: 1 }, frames };
  }
  const demos = {
    swing: makeDemo('swing', 'デモ：肩と腰の向きの変化', 'axes', swingPoints),
    squat: makeDemo('squat', 'デモ：スクワットの膝の曲がり', 'knees', squatPoints),
    arm: makeDemo('arm', 'デモ：腕の曲げ伸ばし', 'elbows', armPoints)
  };
  if (typeof module === 'object' && module.exports) module.exports = { ...demos.swing, demos };
  if (root) { root.SWING_DEMO = demos.swing; root.MOTION_DEMOS = demos; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
