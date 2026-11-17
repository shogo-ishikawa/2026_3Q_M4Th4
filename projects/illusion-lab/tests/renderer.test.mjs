import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, makeScene } from '../web/core.js';
import { renderScene } from '../web/renderer.js';

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}
function target(svg, id) {
  const matches = [...svg.matchAll(/<(?:line|circle|rect|path|g)\b[^>]*>/g)].filter(match => attributes(match[0])['data-target'] === id);
  assert.equal(matches.length, 1, `one ${id} target`);
  return attributes(matches[0][0]);
}
function close(a, b, tolerance = 0.003) { assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`); }
function lineLength(a) { return Math.hypot(Number(a.x2) - Number(a.x1), Number(a.y2) - Number(a.y1)); }
function angle(a) { return Math.atan2(Number(a.y2) - Number(a.y1), Number(a.x2) - Number(a.x1)) * 180 / Math.PI; }
const levels = ['easy', 'standard', 'hard'];
const seeds = [0, 1, 2, 19, 73, 137, 71803, 0xffffffff];

test('18種を全難易度・複数seed・4つの検証表示で自己完結SVGへ描ける', () => {
  for (const item of CATALOGUE) for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene(item.id, { seed, difficulty, truthMode: 'random' });
    for (const options of [{}, { reveal: true }, { reveal: true, contextOpacity: 0 }, { reveal: true, overlay: true }]) {
      const svg = renderScene(scene, options);
      assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 960 600"/);
      assert.match(svg, /role="img"/);
      assert.match(svg, /<title>.+<\/title>/);
      assert.doesNotMatch(svg, /NaN|Infinity|undefined|<script|<image|<style|href=/);
      assert.equal((svg.match(/<svg\b/g) || []).length, 1);
      assert.ok(svg.endsWith('</svg>'));
    }
  }
});

test('長さの正答は実際に描いた端点間距離から確認できる', () => {
  for (const id of ['muller-lyer', 'ponzo', 'vertical-horizontal']) for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene(id, { seed, difficulty, truthMode: 'random' });
    for (const overlay of [false, true]) {
      const svg = renderScene(scene, { reveal: true, overlay });
      for (const key of ['a', 'b']) close(lineLength(target(svg, key)), scene[key]);
    }
    const svg = renderScene(scene), a = lineLength(target(svg, 'a')), b = lineLength(target(svg, 'b'));
    assert.equal(Math.abs(a - b) < .003 ? 'same' : a > b ? 'a' : 'b', scene.answer);
  }
});

test('円の実際の直径は図形モデルと一致し重ね合わせでも保たれる', () => {
  for (const id of ['ebbinghaus', 'delboeuf']) for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene(id, { seed, difficulty, truthMode: 'random' });
    for (const overlay of [false, true]) {
      const svg = renderScene(scene, { reveal: true, overlay });
      for (const key of ['a', 'b']) close(Number(target(svg, key).r) * 2, scene[key]);
    }
  }
});

test('角度比較の重ね合わせは各線を回転させず傾きの違いを保つ', () => {
  for (const id of ['zollner', 'cafe-wall', 'hering', 'wundt']) for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene(id, { seed, difficulty, truthMode: 'random' });
    for (const overlay of [false, true]) {
      const svg = renderScene(scene, { reveal: true, overlay });
      for (const key of ['a', 'b']) close(angle(target(svg, key)), scene[key], .001);
      const a = angle(target(svg, 'a')), b = angle(target(svg, 'b'));
      assert.equal(Math.abs(a - b) < .001 ? 'same' : 'different', scene.answer);
    }
  }
});

test('ポッゲンドルフの正答は表示線を外挿した交点から独立に確認できる', () => {
  for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene('poggendorff', { seed, difficulty, truthMode: 'random' });
    const svg = renderScene(scene), reference = target(svg, 'reference');
    const slope = (reference.y2 - reference.y1) / (reference.x2 - reference.x1);
    const residual = key => {
      const candidate = target(svg, key);
      return Math.abs(Number(candidate.y1) - Number(reference.y2) - slope * (Number(candidate.x1) - Number(reference.x2)));
    };
    const a = residual('a'), b = residual('b');
    assert.equal(a < b ? 'a' : 'b', scene.answer);
    close(Math.min(a, b), 0, .003);
    assert.ok(Math.max(a, b) >= 16.9);
    const badges = [...svg.matchAll(/<circle\b[^>]*>/g)].map(match => attributes(match[0])).filter(a => a.cx === '850');
    assert.equal(badges.length, 2);
    assert.ok(Math.abs(Number(badges[0].cy) - Number(badges[1].cy)) >= 60);
  }
});

test('明るさ比較のパッチは文字を含まず指定RGBで一様に塗られる', () => {
  for (const id of ['simultaneous-brightness', 'white']) for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene(id, { seed, difficulty, truthMode: 'random' });
    for (const overlay of [false, true]) {
      const svg = renderScene(scene, { reveal: true, overlay });
      for (const key of ['a', 'b']) assert.equal(target(svg, key).fill, `rgb(${scene[key]},${scene[key]},${scene[key]})`);
    }
  }
});

test('色の比較ではRGBの各チャンネルが保存される', () => {
  for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene('colour-contrast', { seed, difficulty, truthMode: 'random' });
    for (const overlay of [false, true]) {
      const svg = renderScene(scene, { reveal: true, overlay });
      assert.equal(target(svg, 'a').fill, `rgb(${scene.params.colourA.join(',')})`);
      assert.equal(target(svg, 'b').fill, `rgb(${scene.params.colourB.join(',')})`);
    }
  }
});

test('ジャストローは内外半径比と弧の角度を保って一様拡大する', () => {
  for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene('jastrow', { seed, difficulty, truthMode: 'random' });
    for (const overlay of [false, true]) {
      const svg = renderScene(scene, { reveal: true, overlay });
      for (const key of ['a', 'b']) {
        const targetPath = target(svg, key).d;
        const radii = [...targetPath.matchAll(/A([\d.]+),([\d.]+)/g)];
        assert.equal(radii.length, 2);
        close(Number(radii[0][1]), scene[key] / 2);
        close(Number(radii[1][1]), scene[key] / 2 * scene.params.innerRatio);
      }
    }
  }
});

test('区切りの数を変えても比較区間の端点間距離は変わらない', () => {
  for (const difficulty of levels) for (const seed of seeds) {
    const scene = makeScene('oppel-kundt', { seed, difficulty, truthMode: 'random' });
    const svg = renderScene(scene);
    for (const key of ['a', 'b']) {
      const group = [...svg.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/g)].find(match => attributes(match[1])['data-target'] === key);
      assert.ok(group);
      const ends = [...group[2].matchAll(/<line\b[^>]*>/g)].map(match => attributes(match[0]));
      assert.equal(ends.length, 2);
      close(Number(ends[1].x1) - Number(ends[0].x1), scene[key]);
    }
  }
});

test('フレーザーの各輪は実際に同じ中心を持つ円である', () => {
  for (const difficulty of levels) {
    const scene = makeScene('fraser', { difficulty });
    const svg = renderScene(scene, { reveal: true, contextOpacity: 0 });
    for (const [i, radius] of scene.params.radii.entries()) {
      const a = target(svg, `ring-${i}`);
      assert.equal(Number(a.cx), 480);assert.equal(Number(a.cy), 300);assert.equal(Number(a.r), radius);
    }
  }
});

test('カニッツァの通常図は3つの切り欠きだけを描き三角形の辺を結ばない', () => {
  const scene = makeScene('kanizsa');
  const svg = renderScene(scene);
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map(match => attributes(match[0]));
  assert.equal(paths.length, 3);
  assert.ok(paths.every(path => path.fill === '#18243d' && !path.stroke));
  assert.doesNotMatch(svg, /<line|data-target=/);
  assert.match(renderScene(scene, { reveal: true }), /破線は答え合わせのための補助線/);
});

test('ヘルマン格子の誘導図形は黒い区画と白い通路だけで灰色の点を含まない', () => {
  const svg = renderScene(makeScene('hermann'));
  const fills = [...svg.matchAll(/<rect\b[^>]*>/g)].map(match => attributes(match[0]).fill);
  assert.ok(fills.includes('#11151c'));
  assert.ok(fills.every(fill => ['#fff', '#11151c'].includes(fill)));
  assert.doesNotMatch(svg, /<circle/);
});

test('周囲を隠しても比較対象の位置・寸法・色は変わらない', () => {
  for (const item of CATALOGUE.filter(item => item.quiz)) {
    const scene = makeScene(item.id, { seed: 71803, truthMode: 'random' });
    const first = renderScene(scene), second = renderScene(scene, { contextOpacity: 0 });
    for (const key of ['a', 'b']) assert.deepEqual(target(first, key), target(second, key));
    assert.match(second, /<g opacity="0" data-context="true">/);
  }
});

test('正答の文字列を書き換えても対象の図形や検証表示は変わらない', () => {
  for (const item of CATALOGUE) {
    const scene = makeScene(item.id, { seed: 84, truthMode: 'random' });
    const changed = { ...scene, answer: 'not-the-answer', answerText: '別の答え' };
    for (const options of [{}, { reveal: true }, { reveal: true, overlay: true }]) assert.equal(renderScene(scene, options), renderScene(changed, options));
  }
});

test('答え合わせ前には測定値の帯を表示せず文字をXMLとして安全に扱う', () => {
  const scene = makeScene('muller-lyer');
  assert.doesNotMatch(renderScene(scene), /fill="#f0f3f9"/);
  assert.match(renderScene(scene, { reveal: true }), /fill="#f0f3f9"/);
  const svg = renderScene({ ...scene, question: '<script>alert("a&b")</script>' });
  assert.doesNotMatch(svg, /<script>/);assert.match(svg, /&lt;script&gt;/);assert.match(svg, /&amp;/);
});

test('未対応種類・不正な座標・不正なRGB・範囲外の周囲設定を拒否する', () => {
  assert.throws(() => renderScene(null), TypeError);
  assert.throws(() => renderScene({ ...makeScene('ponzo'), id: 'unknown' }), RangeError);
  assert.throws(() => renderScene({ ...makeScene('ponzo'), a: NaN }), TypeError);
  for (const value of [-.01, 1.01, NaN, Infinity]) assert.throws(() => renderScene(makeScene('ponzo'), { contextOpacity: value }), RangeError);
  const bad = makeScene('colour-contrast');bad.params.colourA = [256, 2, 3];
  assert.throws(() => renderScene(bad), RangeError);
  const infinite = makeScene('fraser');infinite.params.radii[0] = Infinity;
  assert.throws(() => renderScene(infinite), RangeError);
});
