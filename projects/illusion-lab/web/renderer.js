import { CATALOGUE } from './core.js';

// The figure uses the same lengths, diameters, angles and RGB values as the model.
const INK = '#18243d';
const TARGET = '#3454d8';
const PROOF_A = '#3155df';
const PROOF_B = '#e56148';
const MUTED = '#75819a';
const TAU = 2 * Math.PI;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function number(value) {
  if (!Number.isFinite(value) || Math.abs(value) > 10000) throw new RangeError('図形の座標が範囲外です。');
  return String(Math.round(value * 1000) / 1000);
}

function rgb(values) {
  if (!Array.isArray(values) || values.length !== 3 || values.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
    throw new RangeError('RGBは0〜255の整数で指定します。');
  }
  return `rgb(${values.join(',')})`;
}

const attrs = object => Object.entries(object).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}="${escape(v)}"`).join(' ');
const line = (x1, y1, x2, y2, extra = {}) => `<line ${attrs({ x1: number(x1), y1: number(y1), x2: number(x2), y2: number(y2), stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'butt', ...extra })}/>`;
const rect = (x, y, width, height, extra = {}) => `<rect ${attrs({ x: number(x), y: number(y), width: number(width), height: number(height), ...extra })}/>`;
const circle = (x, y, radius, extra = {}) => `<circle ${attrs({ cx: number(x), cy: number(y), r: number(radius), ...extra })}/>`;
const text = (x, y, label, extra = {}) => `<text ${attrs({ x: number(x), y: number(y), fill: INK, 'font-size': 20, 'font-family': 'system-ui, sans-serif', 'text-anchor': 'middle', ...extra })}>${escape(label)}</text>`;
const group = (content, extra = {}) => `<g ${attrs(extra)}>${content}</g>`;

function label(id, x, y) {
  return circle(x, y - 7, 18, { fill: '#fff', stroke: '#dbe0eb', 'stroke-width': 1.5 }) + text(x, y, id.toUpperCase(), { 'font-size': 19, 'font-weight': 750 });
}

function segment(x, y, length, angle, id, extra = {}) {
  const theta = angle * Math.PI / 180;
  const dx = length * Math.cos(theta) / 2, dy = length * Math.sin(theta) / 2;
  return line(x - dx, y - dy, x + dx, y + dy, {
    stroke: TARGET, 'stroke-width': 7, 'data-target': id,
    'data-length': number(length), 'data-angle': number(angle), ...extra,
  });
}

function measure(x1, y1, x2, y2, value, extra = {}) {
  const colour = extra.stroke || '#9ba7bc';
  return line(x1, y1, x2, y2, { stroke: colour, 'stroke-width': 1.5, 'stroke-dasharray': '5 5' }) +
    line(x1, y1 - 6, x1, y1 + 6, { stroke: colour, 'stroke-width': 1.5 }) +
    line(x2, y2 - 6, x2, y2 + 6, { stroke: colour, 'stroke-width': 1.5 }) +
    text((x1 + x2) / 2, (y1 + y2) / 2 - 11, value, { fill: colour, 'font-size': 16 });
}

function angleLines(scene, centres, length, reveal) {
  let targets = '', guides = '';
  for (const [i, id] of ['a', 'b'].entries()) {
    const [x, y] = centres[i], value = scene[id];
    targets += segment(x, y, length, value, id) + label(id, x + (value > 45 && value < 135 ? -66 : -length / 2 - 40), y - 2);
    if (reveal) {
      const reference = Math.abs(scene.a - 90) < 30 ? 90 : 0;
      guides += segment(x, y, length + 40, reference, `guide-${id}`, { stroke: '#e59a61', 'stroke-width': 1.5, 'stroke-dasharray': '6 6', 'data-target': undefined });
      guides += text(x + 85, y + (reference === 90 ? 160 : 47), `${number(value)}°`, { fill: PROOF_A, 'font-size': 18 });
    }
  }
  return { targets, guides };
}

function ringSector(cx, cy, diameter, innerRatio, spanDeg, extra) {
  const outer = diameter / 2, inner = outer * innerRatio;
  const start = (-90 - spanDeg / 2) * Math.PI / 180, end = (-90 + spanDeg / 2) * Math.PI / 180;
  const point = (r, angle) => `${number(cx + r * Math.cos(angle))},${number(cy + r * Math.sin(angle))}`;
  const large = spanDeg > 180 ? 1 : 0;
  const d = `M${point(outer, start)} A${number(outer)},${number(outer)} 0 ${large} 1 ${point(outer, end)} L${point(inner, end)} A${number(inner)},${number(inner)} 0 ${large} 0 ${point(inner, start)} Z`;
  return `<path ${attrs({ d, ...extra })}/>`;
}

function pairOverlay(scene) {
  const p = scene.params;
  const ids = ['a', 'b'];
  let art = '';
  if (['simultaneous-brightness', 'white', 'colour-contrast'].includes(scene.id)) {
    for (const [i, id] of ids.entries()) {
      const value = scene[id];
      const colour = scene.id === 'colour-contrast' ? p[id === 'a' ? 'colourA' : 'colourB'] : [value, value, value];
      art += rect(330 + i * 150, 210, 150, 150, { fill: rgb(colour), 'data-target': id, 'data-colour': colour.join(','), 'data-grey': scene.id === 'colour-contrast' ? undefined : value });
      art += label(id, 405 + i * 150, 407);
    }
    return art + text(480, 167, '周囲を取り除いて隣り合わせに比較', { fill: MUTED, 'font-size': 18 });
  }
  if (['ebbinghaus', 'delboeuf'].includes(scene.id)) {
    for (const [i, id] of ids.entries()) art += circle(480, 290, scene[id] / 2, { fill: 'none', stroke: i ? PROOF_B : PROOF_A, 'stroke-width': i ? 3 : 6, 'stroke-dasharray': i ? '9 5' : undefined, 'data-target': id, 'data-diameter': number(scene[id]) });
  } else if (scene.id === 'jastrow') {
    for (const [i, id] of ids.entries()) art += ringSector(480, 440, scene[id], p.innerRatio, p.spanDeg, { fill: 'none', stroke: i ? PROOF_B : PROOF_A, 'stroke-width': i ? 3 : 6, 'stroke-dasharray': i ? '9 5' : undefined, 'data-target': id, 'data-diameter': number(scene[id]) });
  } else if (['zollner', 'cafe-wall', 'hering', 'wundt'].includes(scene.id)) {
    for (const [i, id] of ids.entries()) art += segment(480, 285, 330, scene[id], id, { stroke: i ? PROOF_B : PROOF_A, 'stroke-width': i ? 3 : 7, 'stroke-dasharray': i ? '9 5' : undefined });
  } else {
    for (const [i, id] of ids.entries()) art += segment(480, 290, scene[id], 0, id, { stroke: i ? PROOF_B : PROOF_A, 'stroke-width': i ? 3 : 7, 'stroke-dasharray': i ? '9 5' : undefined });
  }
  const caption = ['zollner', 'cafe-wall', 'hering', 'wundt'].includes(scene.id) ? '向きを変えずに位置をそろえて重ねる' : '向きと中心をそろえて重ねる';
  return art + text(480, 120, caption, { fill: MUTED, 'font-size': 18 }) +
    label('a', 395, 474) + text(430, 474, '実線', { fill: PROOF_A, 'text-anchor': 'start', 'font-size': 18 }) +
    label('b', 535, 474) + text(570, 474, '破線', { fill: PROOF_B, 'text-anchor': 'start', 'font-size': 18 });
}

function normalFigure(scene, reveal, opacity) {
  const p = scene.params;
  let context = '', targets = '', guides = '', labels = '';
  const strength = p.strength ?? 0.65;
  if (scene.id === 'muller-lyer') {
    const wing = p.wingLength, angle = p.wingAngle * Math.PI / 180;
    for (const [i, id] of ['a', 'b'].entries()) {
      const y = i ? 390 : 205, length = scene[id];
      targets += segment(480, y, length, 0, id);
      labels += label(id, 480 - length / 2 - wing - 46, y + 6);
      for (const side of [-1, 1]) for (const direction of [-1, 1]) {
        const x = 480 + side * length / 2, sign = (i ? -1 : 1) * (p.flip ? -1 : 1);
        context += line(x, y, x + sign * side * wing * Math.cos(angle), y + direction * wing * Math.sin(angle), { 'stroke-width': 5 });
      }
      if (reveal) guides += measure(480 - length / 2, y + 52, 480 + length / 2, y + 52, number(length));
    }
  } else if (scene.id === 'ponzo') {
    const spread = p.railBottom * 0.72, top = p.railTop / 3;
    context += line(480 - spread, 495, 480 - top, 95) + line(480 + spread, 495, 480 + top, 95);
    for (let k = 1; k < p.railCount; k++) {
      const y = 95 + k * 400 / p.railCount;
      const half = top + (y - 95) / 400 * (spread - top);
      context += line(480 - half - 10, y, 480 + half + 10, y, { stroke: '#6e7889', 'stroke-width': 2 });
    }
    for (const [i, id] of ['a', 'b'].entries()) {
      const y = (i === 0) !== !!p.flip ? 205 : 395, length = scene[id];
      targets += segment(480, y, length, 0, id);
      labels += label(id, 480 - length / 2 - 46, y + 6);
      if (reveal) guides += measure(480 - length / 2, y + 37, 480 + length / 2, y + 37, number(length));
    }
  } else if (['ebbinghaus', 'delboeuf'].includes(scene.id)) {
    for (const [i, id] of ['a', 'b'].entries()) {
      const x = i ? 690 : 270, diameter = scene[id];
      targets += circle(x, 300, diameter / 2, { fill: TARGET, 'data-target': id, 'data-diameter': number(diameter) });
      labels += label(id, x, 105);
      if (scene.id === 'delboeuf') {
        const radius = p[i ? 'ringB' : 'ringA'];
        context += circle(x, 300, radius, { fill: 'none', stroke: INK, 'stroke-width': 4 });
      } else {
        const radius = p[i ? 'surroundB' : 'surroundA'], orbit = p[i ? 'orbitB' : 'orbitA'], count = p[i ? 'countB' : 'countA'];
        for (let k = 0; k < count; k++) {
          const angle = TAU * k / count;
          context += circle(x + orbit * Math.cos(angle), 300 + orbit * Math.sin(angle), radius, { fill: '#b5bfce' });
        }
      }
      if (reveal) guides += measure(x - diameter / 2, 300 + diameter / 2 + 30, x + diameter / 2, 300 + diameter / 2 + 30, `直径 ${number(diameter)}`);
    }
  } else if (scene.id === 'zollner') {
    const centres = [[480, 210], [480, 390]], length = p.lineLength;
    const tickAngle = Math.min(40, p.hatchAngle);
    for (const [i, id] of ['a', 'b'].entries()) {
      const [cx, cy] = centres[i], theta = scene[id] * Math.PI / 180;
      for (let k = -4; k <= 4; k++) {
        const x = cx + k * 58 * Math.cos(theta), y = cy + k * 58 * Math.sin(theta);
        context += segment(x, y, 90 + strength * 14, scene[id] + (i ? -tickAngle : tickAngle), `context-${i}-${k}`, { stroke: INK, 'stroke-width': 3, 'data-target': undefined });
      }
    }
    ({ targets, guides } = angleLines(scene, centres, length, reveal));
  } else if (scene.id === 'cafe-wall') {
    for (const [i, id] of ['a', 'b'].entries()) {
      let bricks = '';
      const cy = i ? 390 : 205, cell = p.tileWidth, h = p.tileHeight;
      for (let row = 0; row < 2; row++) for (let col = -1; col < 10; col++) {
        const x = 105 + col * cell + (row ? cell * (0.34 + strength * 0.2) : 0);
        if (x < 100 || x + cell > 860) continue;
        bricks += rect(x, cy - h + row * h, cell, h, { fill: col % 2 === 0 ? INK : '#fff' });
      }
      bricks += line(105, cy, 855, cy, { stroke: '#818b99', 'stroke-width': p.mortar });
      context += group(bricks, { transform: `rotate(${number(scene[id])} 480 ${cy})` });
      targets += segment(480, cy, p.lineLength, scene[id], id, { stroke: '#818b99', 'stroke-width': p.mortar });
      labels += label(id, 67, cy + 6);
      if (reveal) guides += segment(480, cy, 770, 0, `reference-${id}`, { 'data-target': undefined, stroke: PROOF_B, 'stroke-width': 1.5, 'stroke-dasharray': '7 5' }) + text(480, cy + 92, `${number(scene[id])}°`, { fill: PROOF_A, 'font-size': 18 });
    }
  } else if (['hering', 'wundt'].includes(scene.id)) {
    if (scene.id === 'hering') {
      for (let k = 0; k < p.rayCount; k++) {
        const angle = k * Math.PI / p.rayCount + (p.wingAngle - 40) * Math.PI / 180;
        context += line(480 - Math.cos(angle) * 390, 300 - Math.sin(angle) * 240, 480 + Math.cos(angle) * 390, 300 + Math.sin(angle) * 240, { stroke: '#8793a9', 'stroke-width': 2 });
      }
    } else {
      // Wundt reverses Hering: the two fan foci lie outside the target pair.
      const focusY = 300 + p.wingAngle - 40;
      for (let k = 0; k < p.rayCount; k++) {
        const y = 70 + k * 460 / (p.rayCount - 1);
        context += `<path d="M140,${number(focusY)} L480,${number(y)} L820,${number(focusY)}" fill="none" stroke="#8793a9" stroke-width="2"/>`;
      }
    }
    ({ targets, guides } = angleLines(scene, [[390, 300], [570, 300]], p.lineLength, reveal));
  } else if (scene.id === 'poggendorff') {
    const { left, rightA, rightB, occluder, slope } = p;
    const exactLine = (item, id) => line(item.x1, item.y1, item.x2, item.y2, { stroke: TARGET, 'stroke-width': 6, 'data-target': id, 'data-offset': id === 'reference' ? undefined : number(scene[id]) });
    targets = exactLine(left, 'reference') + exactLine(rightA, 'a') + exactLine(rightB, 'b');
    context += rect(occluder.x, occluder.y, occluder.width, occluder.height, { fill: '#e8edf6', stroke: '#aab6ca', 'stroke-width': 2 });
    labels += text(left.x1, left.y1 - 28, '基準', { fill: MUTED, 'font-size': 17 });
    const badgeCentre = Math.max(110, Math.min(490, (rightA.y2 + rightB.y2) / 2));
    for (const [id, candidate] of [['a', rightA], ['b', rightB]]) {
      const isUpper = candidate.y2 === Math.min(rightA.y2, rightB.y2), y = badgeCentre + (isUpper ? -31 : 31);
      labels += line(candidate.x2 + 7, candidate.y2, 826, y, { stroke: MUTED, 'stroke-width': 1.5 });
      labels += label(id, 850, y + 7);
    }
    if (reveal) {
      const endX = Math.max(rightA.x2, rightB.x2), endY = left.y2 + slope * (endX - left.x2);
      guides += line(left.x2, left.y2, endX, endY, { stroke: PROOF_B, 'stroke-width': 2.5, 'stroke-dasharray': '9 5' });
      guides += circle(rightA.x1, p.expectedY, 8, { fill: '#fff', stroke: PROOF_B, 'stroke-width': 2.5 });
    }
  } else if (scene.id === 'vertical-horizontal') {
    targets = segment(480, 420, scene.a, 0, 'a') + segment(480, 420 - scene.b / 2, scene.b, 90, 'b');
    labels = label('a', 480 - scene.a / 2 - 45, 426) + label('b', 526, 420 - scene.b / 2 + 6);
    if (reveal) {
      guides += measure(480 - scene.a / 2, 463, 480 + scene.a / 2, 463, number(scene.a));
      guides += line(440, 420, 440, 420 - scene.b, { stroke: PROOF_B, 'stroke-width': 1.5, 'stroke-dasharray': '5 5' });
      guides += text(414, 420 - scene.b / 2, number(scene.b), { fill: PROOF_B, 'font-size': 16 });
    }
  } else if (scene.id === 'jastrow') {
    const centres = [[480 - p.shift, 335], [480 + p.shift, 465]];
    for (const [i, id] of ['a', 'b'].entries()) {
      const [cx, cy] = centres[i], diameter = scene[id];
      targets += ringSector(cx, cy, diameter, p.innerRatio, p.spanDeg, { fill: TARGET, 'data-target': id, 'data-diameter': number(diameter) });
      labels += label(id, i ? cx + diameter / 2 + 38 : cx - diameter / 2 - 38, cy - diameter * 0.35);
      if (reveal) guides += measure(cx - diameter / 2, cy - diameter / 2 - 24, cx + diameter / 2, cy - diameter / 2 - 24, `外径 ${number(diameter)}`);
    }
  } else if (['simultaneous-brightness', 'white', 'colour-contrast'].includes(scene.id)) {
    let positions;
    if (scene.id === 'white') {
      const h = p.stripeWidth, y = 300 - h * 3.5;
      for (let k = 0; k < 7; k++) context += rect(95, y + k * h, 770, h, { fill: k % 2 ? '#fff' : '#1e2532' });
      positions = [[280, y + h * 2.5], [680, y + h * 3.5]];
    } else {
      const backgrounds = scene.id === 'colour-contrast' ? [p.backgroundA, p.backgroundB] : [[p.backgroundA, p.backgroundA, p.backgroundA], [p.backgroundB, p.backgroundB, p.backgroundB]];
      context += rect(100, 130, 380, 340, { fill: rgb(backgrounds[0]) }) + rect(480, 130, 380, 340, { fill: rgb(backgrounds[1]) });
      positions = [[290, 300], [670, 300]];
    }
    for (const [i, id] of ['a', 'b'].entries()) {
      const [cx, cy] = positions[i], grey = scene[id];
      const colour = scene.id === 'colour-contrast' ? p[i ? 'colourB' : 'colourA'] : [grey, grey, grey];
      const width = scene.id === 'white' ? p.patchWidth : 130, height = scene.id === 'white' ? p.patchHeight : 130;
      targets += rect(cx - width / 2, cy - height / 2, width, height, { fill: rgb(colour), 'data-target': id, 'data-grey': scene.id === 'colour-contrast' ? undefined : grey, 'data-colour': colour.join(',') });
      labels += label(id, cx, scene.id === 'white' ? cy - height / 2 - 25 : 100);
      if (reveal) guides += rect(cx - width / 2, cy - height / 2, width, height, { fill: 'none', stroke: PROOF_B, 'stroke-width': 2, 'stroke-dasharray': '5 5' });
    }
  } else if (scene.id === 'oppel-kundt') {
    for (const [i, id] of ['a', 'b'].entries()) {
      const cx = i ? 690 : 270, length = scene[id], filled = (i === 0) !== !!p.flip;
      const ends = line(cx - length / 2, 255, cx - length / 2, 345, { stroke: TARGET, 'stroke-width': 5, 'data-edge': 'start' }) + line(cx + length / 2, 255, cx + length / 2, 345, { stroke: TARGET, 'stroke-width': 5, 'data-edge': 'end' });
      targets += group(ends, { 'data-target': id, 'data-length': number(length) });
      if (filled) for (let k = 1; k < p.divisions; k++) context += line(cx - length / 2 + length * k / p.divisions, 270, cx - length / 2 + length * k / p.divisions, 330, { 'stroke-width': 3 });
      labels += label(id, cx, 407);
      if (reveal) guides += measure(cx - length / 2, 375, cx + length / 2, 375, number(length));
    }
  } else if (scene.id === 'hermann') {
    const n = p.cells, size = 420, unit = size / n, gap = p.corridor;
    context += rect(270, 90, size, size, { fill: '#11151c' });
    for (let k = 0; k <= n; k++) context += rect(270 + k * unit - gap / 2, 90, gap, size, { fill: '#fff' }) + rect(270, 90 + k * unit - gap / 2, size, gap, { fill: '#fff' });
    if (reveal) {
      const x = 270 + Math.floor(n / 2) * unit, y = 90 + Math.floor(n / 2) * unit;
      guides += circle(x, y, gap / 2 + 8, { fill: 'none', stroke: PROOF_B, 'stroke-width': 2 });
      guides += text(780, 270, '交差点も白', { fill: INK, 'font-size': 19 }) + text(780, 301, 'RGB 255, 255, 255', { fill: MUTED, 'font-size': 15 });
    }
  } else if (scene.id === 'kanizsa') {
    const vertices = p.vertices, radius = p.inducerRadius;
    for (const [i, vertex] of vertices.entries()) {
      const { x, y } = vertex, next = vertices[(i + 1) % 3], prior = vertices[(i + 2) % 3];
      let start = Math.atan2(next.y - y, next.x - x), end = Math.atan2(prior.y - y, prior.x - x);
      let span = (end - start + TAU) % TAU;
      if (span > Math.PI) { [start, end] = [end, start]; span = TAU - span; }
      const x1 = x + radius * Math.cos(start + span), y1 = y + radius * Math.sin(start + span), x2 = x + radius * Math.cos(start), y2 = y + radius * Math.sin(start);
      context += `<path d="M${number(x)},${number(y)} L${number(x1)},${number(y1)} A${number(radius)},${number(radius)} 0 1 1 ${number(x2)},${number(y2)} Z" fill="${INK}"/>`;
    }
    if (reveal && opacity > 0) guides += `<path d="M${vertices.map(v => `${number(v.x)},${number(v.y)}`).join(' L')} Z" fill="none" stroke="${PROOF_B}" stroke-width="2" stroke-dasharray="7 6"/>` + text(480, 522, '破線は答え合わせのための補助線', { fill: PROOF_B, 'font-size': 16 });
    if (reveal && opacity === 0) guides += text(480, 310, '中央に輪郭線は描かれていません', { fill: MUTED, 'font-size': 20 });
  } else if (scene.id === 'fraser') {
    for (const [i, radius] of p.radii.entries()) {
      targets += circle(480, 300, radius, { fill: 'none', stroke: reveal ? ['#3155df', '#e56148', '#3c9f87'][i % 3] : '#d8deeb', 'stroke-width': reveal ? 2 : 10, 'data-target': `ring-${i}`, 'data-radius': number(radius) });
      const count = Math.max(18, Math.round(TAU * radius / 18));
      for (let k = 0; k < count; k++) {
        const angle = TAU * k / count, cx = 480 + radius * Math.cos(angle), cy = 300 + radius * Math.sin(angle);
        context += rect(-8, -5, 16, 10, { fill: k % 2 ? '#fff' : INK, stroke: '#535d72', 'stroke-width': 0.8, transform: `translate(${number(cx)} ${number(cy)}) rotate(${number(angle * 180 / Math.PI + 90 + p.tilt)})` });
      }
    }
    if (reveal) guides += circle(480, 300, 4, { fill: PROOF_B }) + text(480, 522, 'すべて同じ中心を持つ円です', { fill: MUTED, 'font-size': 17 });
  }
  const behind = group(context, { opacity: number(opacity), 'data-context': 'true' });
  return behind + targets + guides + labels;
}

/** Return an exportable SVG. No answer-dependent target geometry is used. */
export function renderScene(scene, { reveal = false, contextOpacity = 1, overlay = false } = {}) {
  if (!scene || typeof scene !== 'object' || !scene.params || !Number.isFinite(scene.a) || !Number.isFinite(scene.b)) throw new TypeError('錯視の条件を指定してください。');
  const item = CATALOGUE.find(entry => entry.id === scene.id);
  if (!item) throw new RangeError('未対応の錯視です。');
  if (!Number.isFinite(contextOpacity) || contextOpacity < 0 || contextOpacity > 1) throw new RangeError('周囲の濃さは0〜1で指定します。');
  const exhibition = ['hermann', 'kanizsa', 'fraser'].includes(scene.id);
  let figure;
  if (overlay && !exhibition && scene.id !== 'poggendorff') figure = pairOverlay(scene);
  else figure = normalFigure(scene, reveal, overlay ? 0 : contextOpacity);
  let footer = '';
  if (reveal) {
    const rows = scene.measurements.slice(0, 3).map(m => `${m.label} ${m.value}${m.unit ? ` ${m.unit}` : ''}`);
    footer = rect(20, 544, 920, 42, { rx: 8, fill: '#f0f3f9' }) + text(480, 571, rows.join('     ／     '), { fill: '#435376', 'font-size': 15 });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600" width="960" height="600" role="img" aria-label="${escape(scene.question)}"><title>${escape(item.name)} — ${escape(scene.question)}</title><rect width="960" height="600" fill="#fff"/>${figure}${footer}</svg>`;
}
