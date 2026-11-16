/* 肩と腰を結ぶ二本の線を動かしたデモ座標。 */
(function (root) {
  'use strict';
  function ease(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }
  function axis(angle, centreX, centreY, span) {
    const radians = angle * Math.PI / 180;
    const dx = Math.cos(radians) * span / 2;
    const dy = Math.sin(radians) * span / 2;
    return [
      { x: centreX - dx, y: centreY + dy, confidence: 0.96 },
      { x: centreX + dx, y: centreY - dy, confidence: 0.96 }
    ];
  }
  const frames = [];
  for (let frame = 0; frame <= 120; frame++) {
    const time = frame / 30;
    const shoulderTurn = ease((time - 1.37) / 0.62);
    const hipTurn = ease((time - 1.0) / 0.9);
    const shoulderAngle = -38 + 135 * shoulderTurn;
    const hipAngle = -15 + 95 * hipTurn;
    const centreX = 470 + 35 * hipTurn;
    const [leftShoulder, rightShoulder] = axis(shoulderAngle, centreX + 4, 215, 128 - 14 * shoulderTurn);
    const [leftHip, rightHip] = axis(hipAngle, centreX, 335, 96 - 10 * hipTurn);
    frames.push({ time, frame, points: { leftShoulder, rightShoulder, leftHip, rightHip } });
  }
  const demo = {
    label: 'デモ：肩と腰の向きの変化', sourceKind: 'demo', width: 960, height: 540,
    description: '肩と腰を結ぶ二本の線を動かした座標です。', fps: 30,
    options: { confidenceThreshold: 0.5, minSpanPx: 12, smoothingWindow: 3, timeScale: 1 },
    frames
  };
  if (typeof module === 'object' && module.exports) module.exports = demo;
  if (root) root.SWING_DEMO = demo;
})(typeof globalThis !== 'undefined' ? globalThis : this);
