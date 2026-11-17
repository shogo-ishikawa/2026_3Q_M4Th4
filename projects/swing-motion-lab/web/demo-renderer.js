/* 合成デモ専用の描画。測定する関節と同じ座標から、服を着た人体を描く。 */
(function (root) {
  'use strict';
  const average = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const between = (a, b, amount) => ({ x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const skin = { light: '#ecc2a0', mid: '#cf9674', dark: '#a86d52' };
  function ellipse(ctx, x, y, radiusX, radiusY, fill, rotation = 0) {
    ctx.beginPath(); ctx.ellipse(x, y, radiusX, radiusY, rotation, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  }
  function segment(ctx, a, b, firstWidth, lastWidth, light, dark) {
    const length = distance(a, b), nx = -(b.y - a.y) / (length || 1), ny = (b.x - a.x) / (length || 1);
    const gradient = ctx.createLinearGradient(a.x + nx * firstWidth / 2, a.y + ny * firstWidth / 2, a.x - nx * firstWidth / 2, a.y - ny * firstWidth / 2);
    gradient.addColorStop(0, light); gradient.addColorStop(1, dark);
    ctx.beginPath();
    ctx.moveTo(a.x + nx * firstWidth / 2, a.y + ny * firstWidth / 2);
    ctx.lineTo(b.x + nx * lastWidth / 2, b.y + ny * lastWidth / 2);
    ctx.quadraticCurveTo(b.x + (b.x - a.x) / (length || 1) * lastWidth / 2, b.y + (b.y - a.y) / (length || 1) * lastWidth / 2,
      b.x - nx * lastWidth / 2, b.y - ny * lastWidth / 2);
    ctx.lineTo(a.x - nx * firstWidth / 2, a.y - ny * firstWidth / 2);
    ctx.quadraticCurveTo(a.x - (b.x - a.x) / (length || 1) * firstWidth / 2, a.y - (b.y - a.y) / (length || 1) * firstWidth / 2,
      a.x + nx * firstWidth / 2, a.y + ny * firstWidth / 2);
    ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.strokeStyle = '#182d3826'; ctx.lineWidth = 1; ctx.stroke();
  }
  function line(ctx, a, b, colour, width) {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke();
  }
  function scene(ctx, id) {
    const wall = ctx.createLinearGradient(0, 0, 0, 425); wall.addColorStop(0, '#dce5e5'); wall.addColorStop(1, '#b5c5c6');
    ctx.fillStyle = wall; ctx.fillRect(0, 0, 960, 540);
    ctx.fillStyle = '#ffffff23'; ctx.fillRect(68, 0, 118, 411); ctx.fillRect(766, 0, 112, 411);
    for (const x of [66, 188, 767, 880]) line(ctx, { x, y: 0 }, { x, y: 413 }, '#748c8d26', 2);
    ctx.fillStyle = '#597274'; ctx.fillRect(0, 407, 960, 9);
    const floor = ctx.createLinearGradient(0, 416, 0, 540); floor.addColorStop(0, '#c0ae96'); floor.addColorStop(1, '#e4d0b0');
    ctx.fillStyle = floor; ctx.fillRect(0, 416, 960, 124);
    for (const y of [437, 467, 511]) line(ctx, { x: 0, y }, { x: 960, y }, '#8d7b6033', 1);
    for (const x of [-110, 110, 330, 550, 770, 990]) line(ctx, { x: 480 + (x - 480) * 0.7, y: 416 }, { x, y: 540 }, '#8d7b6030', 1);
    // 床の印を身体の位置に固定し、足が滑らないことを見比べられるようにする。
    ctx.strokeStyle = '#f8f7e7a6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(483, 489, 154, 23, 0, 0, Math.PI * 2); ctx.stroke();
    if (id === 'swing') {
      ctx.fillStyle = '#ecede8a8'; ctx.beginPath(); ctx.moveTo(681, 473); ctx.lineTo(711, 473); ctx.lineTo(721, 482); ctx.lineTo(696, 491); ctx.lineTo(671, 482); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#385859'; ctx.font = '600 13px sans-serif'; ctx.fillText('MOTION STUDIO', 31, 37);
    ctx.fillStyle = '#385859b8'; ctx.font = '12px sans-serif'; ctx.fillText('合成アニメーション · 実測値ではありません', 31, 58);
  }
  function shoe(ctx, ankle, knee, side, id) {
    const lean = (ankle.x - knee.x) * 0.1, outward = id === 'squat' ? 1 : side === 'left' ? -1 : 1;
    const x = ankle.x + outward * 7 + lean, y = ankle.y + 6;
    ellipse(ctx, x + outward * 6, y + 5, 25, 5, '#1a2e3424');
    ctx.save(); ctx.translate(x, y); ctx.rotate(outward * 0.055);
    ctx.beginPath(); ctx.moveTo(-18, -8); ctx.quadraticCurveTo(-22, -1, -21, 7); ctx.lineTo(24, 7); ctx.quadraticCurveTo(28, 1, 18, -3); ctx.lineTo(5, -10); ctx.closePath();
    ctx.fillStyle = '#273b4c'; ctx.fill(); ctx.strokeStyle = '#162c3c'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#f2f1df'; ctx.fillRect(-21, 5, 46, 4);
    for (const laceX of [-3, 2, 7]) line(ctx, { x: laceX - 3, y: -4 }, { x: laceX + 2, y: 0 }, '#c9d6d9', 1.5);
    ctx.restore();
  }
  function leg(ctx, points, side, id, far) {
    const hip = points[side + 'Hip'], knee = points[side + 'Knee'], ankle = points[side + 'Ankle'];
    const shortsEnd = between(hip, knee, 0.48);
    segment(ctx, hip, knee, 33, 24, far ? '#bd8a6b' : skin.light, skin.dark);
    ellipse(ctx, knee.x, knee.y, 12, 13, far ? '#be8a6d' : '#d6a483');
    segment(ctx, knee, ankle, 23, 13, far ? '#c28d70' : skin.light, skin.dark);
    segment(ctx, hip, shortsEnd, 43, 34, far ? '#32495b' : '#4f687d', '#223848');
    const sockTop = between(ankle, knee, 0.16);
    segment(ctx, sockTop, ankle, 16, 15, '#f5f4e9', '#c4cdd0');
    shoe(ctx, ankle, knee, side, id);
  }
  function arm(ctx, points, side, far) {
    const shoulder = points[side + 'Shoulder'], elbow = points[side + 'Elbow'], wrist = points[side + 'Wrist'];
    segment(ctx, shoulder, elbow, 26, 20, far ? '#bc866b' : skin.light, skin.dark);
    ellipse(ctx, elbow.x, elbow.y, 10, 10, far ? '#b58268' : '#d9aa88');
    segment(ctx, elbow, wrist, 20, 12, far ? '#cb9675' : '#edc7a6', '#b17b5c');
    segment(ctx, shoulder, between(shoulder, elbow, 0.37), 32, 28, far ? '#347e83' : '#59a7a9', '#24646c');
  }
  function torso(ctx, points) {
    const ls = points.leftShoulder, rs = points.rightShoulder, lh = points.leftHip, rh = points.rightHip;
    const shoulder = average(ls, rs), hip = average(lh, rh), trunkLength = distance(shoulder, hip);
    const up = { x: (shoulder.x - hip.x) / trunkLength, y: (shoulder.y - hip.y) / trunkLength };
    const across = { x: -up.y, y: up.x }, shoulderSpan = distance(ls, rs), hipSpan = distance(lh, rh);
    // 関節の中心は動かさず、筋肉と布の厚みを外側に加える。
    const leftTop = { x: ls.x - across.x * 10, y: ls.y - across.y * 10 };
    const rightTop = { x: rs.x + across.x * 10, y: rs.y + across.y * 10 };
    const leftBottom = { x: lh.x - across.x * 14, y: lh.y - across.y * 14 };
    const rightBottom = { x: rh.x + across.x * 14, y: rh.y + across.y * 14 };
    const gradient = ctx.createLinearGradient(leftTop.x, leftTop.y, rightTop.x, rightTop.y);
    gradient.addColorStop(0, '#2d7078'); gradient.addColorStop(0.38, '#58a8aa'); gradient.addColorStop(1, '#24606b');
    ctx.beginPath(); ctx.moveTo(leftTop.x, leftTop.y);
    ctx.quadraticCurveTo(shoulder.x, shoulder.y - 8, rightTop.x, rightTop.y);
    ctx.bezierCurveTo(rightTop.x + across.x * 6, rightTop.y + 45, rightBottom.x, rightBottom.y - 25, rightBottom.x, rightBottom.y + 8);
    ctx.quadraticCurveTo(hip.x, hip.y + 15, leftBottom.x, leftBottom.y + 8);
    ctx.bezierCurveTo(leftBottom.x, leftBottom.y - 25, leftTop.x - across.x * 6, leftTop.y + 45, leftTop.x, leftTop.y);
    ctx.closePath(); ctx.fillStyle = gradient; ctx.fill(); ctx.strokeStyle = '#23515c88'; ctx.lineWidth = 1.3; ctx.stroke();
    line(ctx, { x: leftBottom.x, y: leftBottom.y + 5 }, { x: rightBottom.x, y: rightBottom.y + 5 }, '#1c46565e', 5);
    // 縫い目と小さな無地のワンポイント。
    line(ctx, between(leftTop, leftBottom, 0.3), between(leftTop, leftBottom, 0.86), '#b3dcda3b', 1);
    ellipse(ctx, shoulder.x + across.x * Math.min(18, shoulderSpan * 0.15) - up.x * 33,
      shoulder.y + across.y * Math.min(18, shoulderSpan * 0.15) - up.y * 33, 4, 3, '#c7e8dfb0');
    segment(ctx, { x: hip.x - (hipSpan / 2 + 8), y: hip.y + 5 }, { x: hip.x + (hipSpan / 2 + 8), y: hip.y + 5 }, 18, 18, '#3b5365', '#243b4c');
    return { shoulder, hip, up };
  }
  function head(ctx, body, faceTurn) {
    const { shoulder, up } = body;
    const neck = { x: shoulder.x + up.x * 14, y: shoulder.y + up.y * 14 };
    const centre = { x: shoulder.x + up.x * 48, y: shoulder.y + up.y * 48 };
    segment(ctx, shoulder, neck, 19, 18, skin.light, skin.dark);
    const rotation = Math.atan2(up.x, -up.y) * 0.7;
    ctx.save(); ctx.translate(centre.x, centre.y); ctx.rotate(rotation);
    const face = ctx.createLinearGradient(-20, -10, 21, 12); face.addColorStop(0, '#c28a6b'); face.addColorStop(0.45, '#edc7a4'); face.addColorStop(1, '#ce9674');
    ellipse(ctx, 0, 0, 22, 29, face);
    ellipse(ctx, -19, 3, 4, 7, '#cb9271'); ellipse(ctx, 19, 3, 4, 7, '#dca584');
    ctx.beginPath(); ctx.moveTo(-21, -2); ctx.bezierCurveTo(-29, -31, -7, -37, 12, -27); ctx.quadraticCurveTo(28, -25, 22, -7);
    ctx.lineTo(13, -19); ctx.quadraticCurveTo(-2, -15, -15, -16); ctx.lineTo(-18, 1); ctx.closePath(); ctx.fillStyle = '#293639'; ctx.fill();
    const eyeX = faceTurn * 9;
    ellipse(ctx, eyeX - 7, -1, 1.5, 1.7, '#343d3c'); ellipse(ctx, eyeX + 7, -1, 1.4, 1.6, '#343d3c');
    line(ctx, { x: eyeX + 1, y: 2 }, { x: eyeX + 3, y: 9 }, '#b17c5e', 1.3);
    line(ctx, { x: eyeX - 3, y: 15 }, { x: eyeX + 5, y: 15 }, '#9e6c58', 1.3);
    ctx.restore();
  }
  function hand(ctx, wrist, elbow, far) {
    const rotation = Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x);
    ellipse(ctx, wrist.x + Math.cos(rotation) * 5, wrist.y + Math.sin(rotation) * 5, 10, 7, far ? '#bd896b' : '#e6b592', rotation);
    line(ctx, { x: wrist.x + 1, y: wrist.y - 3 }, { x: wrist.x + 7, y: wrist.y - 1 }, '#ad775a70', 1);
  }
  function bat(ctx, points, direction) {
    const grip = average(points.leftWrist, points.rightWrist), length = Math.hypot(direction.x, direction.y);
    const unit = { x: direction.x / length, y: direction.y / length };
    const at = amount => ({ x: grip.x + unit.x * amount, y: grip.y + unit.y * amount });
    segment(ctx, at(-13), at(38), 7, 8, '#af7b40', '#805728');
    segment(ctx, at(35), at(length), 8, 18, '#e1bb78', '#aa7639');
    for (let amount = -9; amount < 18; amount += 5) line(ctx,
      { x: at(amount).x - unit.y * 4, y: at(amount).y + unit.x * 4 },
      { x: at(amount + 2).x + unit.y * 4, y: at(amount + 2).y - unit.x * 4 }, '#352e2b', 2);
  }
  function dumbbell(ctx, wrist) {
    line(ctx, { x: wrist.x - 16, y: wrist.y }, { x: wrist.x + 16, y: wrist.y }, '#879599', 5);
    for (const x of [wrist.x - 19, wrist.x + 19]) {
      ctx.fillStyle = '#2b3943'; ctx.fillRect(x - 5, wrist.y - 13, 10, 26);
      ctx.fillStyle = '#52636d'; ctx.fillRect(x - 4, wrist.y - 12, 3, 24);
    }
  }
  function draw(ctx, options) {
    const { width = 960, height = 540, points, demoId = 'swing', time = 0 } = options;
    const required = ['Shoulder', 'Elbow', 'Wrist', 'Hip', 'Knee', 'Ankle'];
    if (!points || !required.every(joint => ['left', 'right'].every(side => Number.isFinite(points[side + joint]?.x) && Number.isFinite(points[side + joint]?.y)))) return false;
    const data = root?.MotionDemoData || (typeof require === 'function' ? require('./demo-data.js') : null);
    const pose = data?.poseAt(demoId, time) || { faceTurn: 0, phase: '', batDirection: { x: -40, y: -150 } };
    ctx.save(); ctx.scale(width / 960, height / 540);
    scene(ctx, demoId);
    const left = points.leftAnkle, right = points.rightAnkle;
    ellipse(ctx, (left.x + right.x) / 2 + 8, 492, Math.max(60, Math.abs(left.x - right.x) / 2 + 44), 12, '#253e4130');
    // 奥の腕・脚 → 胴体 → 手前の腕の順で重なりを表す。
    const far = demoId === 'squat' ? 'left' : 'right', near = far === 'left' ? 'right' : 'left';
    leg(ctx, points, far, demoId, true); arm(ctx, points, far, true);
    leg(ctx, points, near, demoId, false);
    const body = torso(ctx, points); head(ctx, body, pose.faceTurn);
    arm(ctx, points, near, false);
    if (demoId === 'swing') bat(ctx, points, pose.batDirection);
    if (demoId === 'arm') { dumbbell(ctx, points.leftWrist); dumbbell(ctx, points.rightWrist); }
    hand(ctx, points[far + 'Wrist'], points[far + 'Elbow'], true); hand(ctx, points[near + 'Wrist'], points[near + 'Elbow'], false);
    ctx.fillStyle = '#355357'; ctx.font = '500 14px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(pose.phase, 928, 38);
    ctx.restore(); return true;
  }
  const api = { draw };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MotionDemoRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
