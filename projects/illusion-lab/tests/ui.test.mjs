import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CATALOGUE, makeQuiz, makeScene, normaliseSeed } from '../web/core.js';
import { QuizSession, parseSettings, challengeUrl, proofOptions, categoryResults, resultsCsv } from '../web/app.js';

const sample = () => makeQuiz({ seed: 8451, count: 5, difficulty: 'standard' });

test('共有URLは不正な選択肢や過長な番号でも標準条件から開ける', () => {
  const value = parseSettings('?mode=invalid&difficulty=extreme&count=999&category=shape&id=unknown&seed=' + 'x'.repeat(81));
  assert.deepEqual(value, { mode: 'lab', id: 'muller-lyer', difficulty: 'standard', count: 10, category: 'all', seed: 2026 });
  assert.equal(parseSettings('?mode=lab&seed=47', '#quiz').mode, 'quiz');
  assert.equal(parseSettings('?mode=quiz&seed=47', '#lab').mode, 'lab');
});

test('共有URLは図とクイズの番号・条件を再現する', () => {
  const settings = { mode: 'quiz', difficulty: 'hard', count: 15, category: 'direction', seed: 345 };
  const link = new URL(challengeUrl('https://example.test/illusion-lab/?old=1#lab', settings));
  const parsed = parseSettings(link.search, link.hash);
  assert.equal(parsed.seed, 345); assert.equal(parsed.mode, 'quiz'); assert.equal(parsed.difficulty, 'hard'); assert.equal(parsed.count, 15); assert.equal(parsed.category, 'direction');
  assert.equal(link.searchParams.has('old'), false);
  const lab = new URL(challengeUrl('https://example.test/illusion-lab/', { mode: 'lab', id: 'white', seed: 17, difficulty: 'easy' }));
  assert.equal(parseSettings(lab.search, lab.hash).id, 'white');
  assert.equal(parseSettings(lab.search, lab.hash).seed, 17);
});

test('未回答の問題は検証指定があっても答え合わせを描画しない', () => {
  assert.deepEqual(proofOptions(false, { reveal: true, contextOpacity: 0, overlay: true }), { reveal: false, contextOpacity: 1, overlay: false });
  assert.deepEqual(proofOptions(true, { reveal: true, contextOpacity: -3, overlay: true }), { reveal: true, contextOpacity: 0, overlay: true });
  assert.equal(proofOptions(true, { contextOpacity: Infinity }).contextOpacity, 1);
});

test('未回答では進まず、二重回答で得点が増えない', () => {
  const session = new QuizSession(sample());
  assert.equal(session.next(), false); assert.equal(session.index, 0);
  assert.throws(() => session.answer('unknown'), RangeError); assert.equal(session.responses.length, 0);
  assert.equal(session.answer(session.current.answer), true); assert.equal(session.score, 1);
  assert.equal(session.answer(session.current.answer), false); assert.equal(session.score, 1);
  assert.equal(session.next(), true); assert.equal(session.index, 1); assert.equal(session.answered, false);
});

test('最後の回答後だけ結果に進み、見直しは採点を変えない', () => {
  const session = new QuizSession(sample());
  for (let i = 0; i < session.scenes.length; i += 1) {
    assert.equal(session.finished, false);
    session.answer(session.current.answer); session.next();
  }
  assert.equal(session.finished, true); assert.equal(session.score, 5); assert.equal(session.next(), false);
  assert.equal(session.answer(session.current.answer), false);
  const reviewed = session.review(1); assert.equal(reviewed.scene, session.scenes[1]);
  assert.throws(() => { reviewed.response.correct = false; }, TypeError);
  assert.equal(session.score, 5); assert.equal(session.index, 4); assert.throws(() => session.review(8), RangeError);
});

test('再挑戦は同じ図を未回答状態から再開し、カテゴリ合計も正しい', () => {
  const first = new QuizSession(sample());
  for (let i = 0; i < first.scenes.length; i += 1) { first.answer(first.current.answer); first.next(); }
  const second = new QuizSession(sample());
  assert.deepEqual(second.scenes, first.scenes); assert.equal(second.score, 0); assert.equal(second.responses.length, 0);
  const summary = categoryResults(first);
  assert.equal(summary.reduce((sum, row) => sum + row.total, 0), 5);
  assert.equal(summary.reduce((sum, row) => sum + row.correct, 0), 5);
});

test('CSVは回答済みの行だけを出力し、カンマと引用符を保持する', () => {
  const scenes = sample();
  scenes[0] = { ...scenes[0], choices: [{ id: 'chosen', label: 'A,"B"' }], answer: 'chosen' };
  const session = new QuizSession(scenes); session.answer('chosen');
  const csv = resultsCsv(session, { seed: 81, difficulty: 'easy' });
  assert.ok(csv.startsWith('\uFEFF'));
  assert.equal(csv.trim().split('\r\n').length, 2);
  assert.ok(csv.includes('"A,""B"""'));
  assert.ok(csv.includes('"正解"'));
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.parentElement = null;
    const classes = new Set(); this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), toggle: (name, force) => { const next = force ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; }, contains: name => classes.has(name) };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]); return selector === 'button' ? all.filter(child => child.tagName === 'BUTTON') : []; }
  closest(selector) { if (selector === 'label') return this.parentElement ?? this; return this; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  scrollIntoView() {} focus() {} select() {}
}
function appHarness(url = 'https://example.test/illusion-lab/') {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const nodes = {};
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    assert.equal(nodes[match[3]], undefined, 'Duplicate id: ' + match[3]);
    const element = new Element(match[1]); element.hidden = /\bhidden(?:\s|>|$)/.test(match[2]);
    const value = match[2].match(/\bvalue="([^"]*)"/); if (value) element.value = value[1];
    nodes[match[3]] = element;
  }
  for (const id of ['labOverlay', 'quizOverlay', 'quizGuides', 'reviewOverlay']) nodes[id].parentElement = new Element('label');
  for (const category of ['all', 'length', 'size', 'direction', 'brightness']) { const option = new Element('option'); option.value = category; nodes.quizCategory.append(option); }
  let address = new URL(url); const draws = [];
  const context = {
    CATALOGUE, makeQuiz, makeScene, normaliseSeed,
    renderScene(scene, options = {}) { draws.push({ scene, options }); return `<svg data-id="${scene.id}" data-seed="${scene.seed}" data-reveal="${!!options.reveal}" data-context="${options.contextOpacity ?? 1}" data-overlay="${!!options.overlay}"></svg>`; },
    document: { getElementById: id => nodes[id] ?? null, createElement: tag => new Element(tag), body: new Element('body') },
    location: { get href() { return address.href; }, get search() { return address.search; }, get hash() { return address.hash; } },
    history: { replaceState(_state, _title, next) { address = new URL(next, address); } },
    window: { addEventListener() {} }, navigator: {}, localStorage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } },
    crypto: { getRandomValues(array) { array[0] = 931; return array; } }, URL, URLSearchParams, console, setTimeout, Uint32Array,
  };
  vm.createContext(context);
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(source, context, { timeout: 5000 });
  async function fire(nodeOrId, name = 'click') {
    const node = typeof nodeOrId === 'string' ? nodes[nodeOrId] : nodeOrId;
    for (const callback of node.listeners[name] ?? []) await callback({ preventDefault() {}, key: '', target: node });
  }
  return { nodes, draws, fire, address: () => address };
}

test('実HTMLの操作で図の再生成は検証状態をリセットする', async () => {
  const app = appHarness(); const { nodes, fire } = app;
  assert.equal(nodes.catalogue.children.length, 18); assert.equal(nodes.labProof.hidden, true);
  await fire('revealLab'); assert.equal(nodes.labProof.hidden, false); assert.match(nodes.labGraphic.innerHTML, /data-reveal="true"/);
  nodes.labContext.value = '0'; await fire('labContext', 'input');
  nodes.labOverlay.checked = true; await fire('labOverlay', 'change');
  assert.match(nodes.labGraphic.innerHTML, /data-context="0"/); assert.match(nodes.labGraphic.innerHTML, /data-overlay="true"/);
  await fire('randomLab'); assert.equal(nodes.labProof.hidden, true); assert.equal(nodes.labSeed.value, '931');
  assert.match(nodes.labGraphic.innerHTML, /data-reveal="false"/); assert.match(nodes.labGraphic.innerHTML, /data-context="1"/); assert.match(nodes.labGraphic.innerHTML, /data-overlay="false"/);
  nodes.labType.value = 'kanizsa'; await fire('labType', 'change'); assert.equal(nodes.labOverlay.parentElement.hidden, true);
});

test('実HTMLのクイズを回答・見直し・再挑戦まで進められる', async () => {
  const { nodes, fire } = appHarness('https://example.test/illusion-lab/?mode=quiz&seed=8451&count=5&category=direction#quiz');
  assert.equal(nodes.quiz.hidden, false); assert.equal(nodes.quizCount.value, '5');
  await fire('quizForm', 'submit'); const original = nodes.quizGraphic.innerHTML;
  assert.equal(nodes.quizFeedback.hidden, true); assert.equal(nodes.quizNext.hidden, true);
  assert.equal(nodes.quizContext.disabled, true); assert.match(original, /data-reveal="false"/);
  for (let i = 0; i < 5; i += 1) {
    const choice = nodes.quizChoices.children[0]; await fire(choice);
    assert.equal(nodes.quizFeedback.hidden, false); assert.equal(nodes.quizNext.hidden, false); assert.match(nodes.quizGraphic.innerHTML, /data-reveal="true"/);
    nodes.quizContext.value = '0'; await fire('quizContext', 'input');
    nodes.quizOverlay.checked = true; await fire('quizOverlay', 'change');
    assert.match(nodes.quizGraphic.innerHTML, /data-context="0"/);
    await fire('quizNext');
    if (i < 4) { assert.equal(nodes.quizFeedback.hidden, true); assert.equal(nodes.quizNext.hidden, true); assert.match(nodes.quizGraphic.innerHTML, /data-reveal="false"/); assert.match(nodes.quizGraphic.innerHTML, /data-context="1"/); }
  }
  assert.equal(nodes.quizResults.hidden, false); assert.equal(nodes.resultList.children.length, 5);
  const score = nodes.resultScore.textContent;
  await fire(nodes.resultList.children[0]); assert.equal(nodes.reviewPanel.hidden, false); assert.match(nodes.reviewGraphic.innerHTML, /data-reveal="true"/);
  nodes.reviewContext.value = '0'; await fire('reviewContext', 'input'); assert.equal(nodes.resultScore.textContent, score);
  await fire('replayQuiz'); assert.equal(nodes.quizResults.hidden, true); assert.equal(nodes.quizFeedback.hidden, true); assert.equal(nodes.quizGraphic.innerHTML, original);
  assert.equal(nodes.quizChoices.children.every(button => !button.disabled), true);
});
