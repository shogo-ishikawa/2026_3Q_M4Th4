import { CATALOGUE, makeScene, makeQuiz, normaliseSeed } from './core.js';
import { renderScene } from './renderer.js';
import { lessonMarkup } from './lesson-view.js';

const DIFFICULTIES = ['easy', 'standard', 'hard'];
const COUNTS = [5, 10, 15, 20, 30];
const CATEGORIES = {
  all: { label: 'すべて', en: 'ALL' },
  length: { label: '長さ', en: 'LENGTH' },
  size: { label: '大きさ', en: 'SIZE' },
  direction: { label: '向き・つながり', en: 'DIRECTION' },
  brightness: { label: '明るさ・色', en: 'COLOUR & LIGHT' },
  shape: { label: '輪郭・模様', en: 'SHAPE' },
};
const byId = new Map(CATALOGUE.map(item => [item.id, item]));
const quizCategories = new Set(CATALOGUE.filter(item => item.quiz).map(item => item.category));

export function parseSettings(search = '', hash = '') {
  const query = new URLSearchParams(search);
  const difficulty = DIFFICULTIES.includes(query.get('difficulty')) ? query.get('difficulty') : 'standard';
  const rawCount = Number(query.get('count'));
  const count = COUNTS.includes(rawCount) ? rawCount : 10;
  const rawCategory = query.get('category');
  const category = rawCategory === 'all' || quizCategories.has(rawCategory) ? rawCategory : 'all';
  const id = byId.has(query.get('id')) ? query.get('id') : 'muller-lyer';
  let seed = 2026;
  try { if (query.has('seed') && query.get('seed').trim()) seed = normaliseSeed(query.get('seed')); } catch (_) { /* Use the starting number. */ }
  const mode = hash === '#quiz' || (hash !== '#lab' && query.get('mode') === 'quiz') ? 'quiz' : 'lab';
  return { mode, id, difficulty, count, category, seed };
}

export function challengeUrl(base, settings) {
  const url = new URL(base);
  url.search = '';
  const query = url.searchParams;
  query.set('mode', settings.mode === 'quiz' ? 'quiz' : 'lab');
  query.set('seed', String(normaliseSeed(settings.seed)));
  query.set('difficulty', DIFFICULTIES.includes(settings.difficulty) ? settings.difficulty : 'standard');
  if (settings.mode === 'quiz') {
    query.set('count', String(COUNTS.includes(settings.count) ? settings.count : 10));
    query.set('category', settings.category === 'all' || quizCategories.has(settings.category) ? settings.category : 'all');
  } else {
    query.set('id', byId.has(settings.id) ? settings.id : 'muller-lyer');
  }
  url.hash = settings.mode === 'quiz' ? 'quiz' : 'lab';
  return url.toString();
}

export class QuizSession {
  constructor(scenes) {
    if (!Array.isArray(scenes) || scenes.length === 0 || scenes.length > 30) throw new RangeError('問題数を確認してください。');
    for (const scene of scenes) {
      if (!scene || !Array.isArray(scene.choices) || !scene.choices.some(choice => choice.id === scene.answer)) throw new TypeError('問題の選択肢を確認してください。');
    }
    this.scenes = scenes.slice();
    this.responses = [];
    this.index = 0;
    this.finished = false;
  }
  get current() { return this.scenes[this.index]; }
  get answered() { return this.responses[this.index] !== undefined; }
  get score() { return this.responses.filter(response => response.correct).length; }
  answer(choice) {
    if (this.finished || this.answered) return false;
    if (!this.current.choices.some(option => option.id === choice)) throw new RangeError('選択肢から答えを選んでください。');
    this.responses[this.index] = Object.freeze({ choice, correct: choice === this.current.answer });
    return true;
  }
  next() {
    if (this.finished || !this.answered) return false;
    if (this.index === this.scenes.length - 1) this.finished = true;
    else this.index += 1;
    return true;
  }
  review(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.responses.length) throw new RangeError('回答済みの問題を選んでください。');
    return { scene: this.scenes[index], response: this.responses[index] };
  }
}

export function categoryResults(session) {
  const result = new Map();
  session.responses.forEach((response, index) => {
    const category = byId.get(session.scenes[index].id)?.category ?? 'shape';
    const row = result.get(category) ?? { category, correct: 0, total: 0 };
    row.total += 1;
    if (response.correct) row.correct += 1;
    result.set(category, row);
  });
  return [...result.values()];
}

export function resultsCsv(session, options) {
  const rows = [['問題', '錯視', 'あなたの答え', '正しい答え', '正誤', '図の番号', 'セットの番号', '難易度']];
  session.responses.forEach((response, index) => {
    const scene = session.scenes[index];
    const label = id => scene.choices.find(choice => choice.id === id)?.label ?? id;
    rows.push([index + 1, byId.get(scene.id)?.name ?? scene.id, label(response.choice), label(scene.answer), response.correct ? '正解' : '不正解', scene.seed, options.seed, options.difficulty]);
  });
  return '\uFEFF' + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
}

export function proofOptions(answered, { reveal = true, contextOpacity = 1, overlay = false } = {}) {
  if (!answered) return { reveal: false, contextOpacity: 1, overlay: false };
  return { reveal: !!reveal, contextOpacity: Math.min(1, Math.max(0, Number.isFinite(Number(contextOpacity)) ? Number(contextOpacity) : 1)), overlay: !!overlay };
}

function newSeed() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 0x100000000);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initialiseApp() {
  const $ = id => document.getElementById(id);
  const initial = parseSettings(location.search, location.hash);
  const state = {
    mode: initial.mode,
    lab: { id: initial.id, seed: initial.seed, difficulty: initial.difficulty, scene: null, reveal: false, contextOpacity: 1, overlay: false },
    filter: 'all', session: null, quizOptions: null, quizProof: proofOptions(false), reviewIndex: null,
  };
  function status(message, error = false) {
    $('appStatus').textContent = message;
    $('appStatus').classList.toggle('is-error', error);
  }
  function safely(action) {
    return (...args) => { try { return action(...args); } catch (error) { status(error.message || '条件を確認してもう一度試してください。', true); } };
  }
  function replaceAddress(settings) {
    try { history.replaceState(null, '', challengeUrl(location.href, settings)); } catch (_) { /* The experiment also works from a local server. */ }
  }
  function labSettings() { return { mode: 'lab', id: state.lab.id, seed: state.lab.seed, difficulty: state.lab.difficulty }; }
  function readQuizOptions() {
    const raw = $('quizSeed').value.trim();
    return {
      seed: normaliseSeed(raw || '2026'),
      difficulty: DIFFICULTIES.includes($('quizDifficulty').value) ? $('quizDifficulty').value : 'standard',
      count: COUNTS.includes(Number($('quizCount').value)) ? Number($('quizCount').value) : 10,
      category: quizCategories.has($('quizCategory').value) ? $('quizCategory').value : 'all',
    };
  }
  function chooseMode(mode, updateUrl = true) {
    state.mode = mode;
    $('lab').hidden = mode !== 'lab';
    $('quiz').hidden = mode !== 'quiz';
    for (const [id, selected] of [['tabLab', mode === 'lab'], ['tabQuiz', mode === 'quiz']]) {
      $(id).setAttribute('aria-selected', String(selected));
      $(id).tabIndex = selected ? 0 : -1;
    }
    if (updateUrl) replaceAddress(mode === 'lab' ? labSettings() : { mode: 'quiz', ...(state.quizOptions || readQuizOptions()) });
    $('shareFallback').hidden = true;
    status('');
  }
  function showMeasurements(id, measurements) {
    const container = $(id);
    container.replaceChildren();
    for (const measurement of measurements || []) {
      const row = document.createElement('div');
      const label = document.createElement('dt');
      const value = document.createElement('dd');
      label.textContent = measurement.label;
      value.textContent = `${measurement.value}${measurement.unit ? ' ' + measurement.unit : ''}`;
      row.append(label, value);
      container.append(row);
    }
  }
  function renderLab() {
    const lab = state.lab;
    $('labGraphic').innerHTML = renderScene(lab.scene, { reveal: lab.reveal, contextOpacity: lab.contextOpacity, overlay: lab.overlay });
    const item = byId.get(lab.id);
    $('labTitle').textContent = item.name;
    $('labCategory').textContent = `${CATEGORIES[item.category].en} / ${CATEGORIES[item.category].label}`;
    $('labSummary').textContent = item.summary;
    $('labSeedReadout').textContent = String(lab.seed);
    $('labSeed').value = String(lab.seed);
    $('labType').value = lab.id;
    $('labDifficulty').value = lab.difficulty;
    $('labProof').hidden = !lab.reveal;
    $('revealLab').textContent = lab.reveal ? '補助線を表示中 ✓' : '答えを確かめる ↗';
    $('labContext').value = String(Math.round(lab.contextOpacity * 100));
    $('labContextValue').textContent = Math.round(lab.contextOpacity * 100) + '%';
    $('labOverlay').checked = lab.overlay;
    $('labOverlay').closest('label').hidden = !byId.get(lab.id).quiz;
    if (lab.reveal) {
      $('labAnswer').textContent = lab.scene.answerText;
      $('labExplanation').textContent = lab.scene.explanation;
      $('labLesson').innerHTML = lessonMarkup(lab.id);
      showMeasurements('labMeasurements', lab.scene.measurements);
    } else {
      $('labAnswer').textContent = '';
      $('labExplanation').textContent = '';
      $('labMeasurements').replaceChildren();
      $('labLesson').replaceChildren();
    }
    for (const button of $('catalogue').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === lab.id));
  }
  function generateLab({ id = $('labType').value, difficulty = $('labDifficulty').value, seed = $('labSeed').value } = {}) {
    const normalised = normaliseSeed(String(seed).trim() || '2026');
    const scene = makeScene(id, { seed: normalised, difficulty, truthMode: 'equal' });
    renderScene(scene); // Check the new drawing before replacing the current experiment.
    state.lab = { id, difficulty, seed: normalised, scene, reveal: false, contextOpacity: 1, overlay: false };
    renderLab();
    replaceAddress(labSettings());
    status('図をつくりました。見比べてから答えを確かめましょう。');
  }
  function renderCatalogue() {
    $('catalogue').replaceChildren();
    CATALOGUE.forEach((item, index) => {
      if (state.filter !== 'all' && item.category !== state.filter) return;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'catalogue-card'; button.dataset.id = item.id;
      button.setAttribute('aria-pressed', String(item.id === state.lab.id));
      const number = document.createElement('span'); number.className = 'catalogue-number'; number.textContent = String(index + 1).padStart(2, '0');
      const body = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = item.name;
      const description = document.createElement('p'); description.textContent = item.summary;
      const category = document.createElement('small'); category.textContent = CATEGORIES[item.category].label;
      body.append(title, description, category); button.append(number, body);
      button.addEventListener('click', safely(() => {
        generateLab({ id: item.id, difficulty: state.lab.difficulty, seed: state.lab.seed });
        $('labTitle').scrollIntoView({ block: 'start', behavior: 'auto' });
      }));
      $('catalogue').append(button);
    });
  }
  async function share(settings) {
    const url = challengeUrl(location.href, settings);
    $('shareUrl').value = url;
    $('shareFallback').hidden = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      status('リンクをコピーしました。同じ条件の図や問題を共有できます。');
    } catch (_) {
      status('下のリンクを選んでコピーしてください。');
      $('shareUrl').focus(); $('shareUrl').select();
    }
  }
  function labExportSvg() {
    const source = renderScene(state.lab.scene, { reveal: state.lab.reveal, contextOpacity: state.lab.contextOpacity, overlay: state.lab.overlay });
    const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (xml.querySelector('parsererror')) throw new Error('図を保存できませんでした。もう一度試してください。');
    xml.documentElement.setAttribute('width', '960');
    xml.documentElement.setAttribute('height', '600');
    return new XMLSerializer().serializeToString(xml.documentElement);
  }
  async function savePng() {
    const exportName = `IllusionLab_${state.lab.id}_${state.lab.seed}.png`;
    $('savePng').disabled = true;
    let url;
    try {
      status('PNG画像を作成しています…');
      url = URL.createObjectURL(new Blob([labExportSvg()], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('画像を作成できませんでした。SVG保存も使えます。')); image.src = url; });
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1200;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('PNGを作成できません。SVG保存をお試しください。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNGを作成できません。SVG保存をお試しください。');
      downloadBlob(blob, exportName);
      status('現在の図をPNGで保存しました。');
    } catch (error) { status(error.message, true); }
    finally { if (url) URL.revokeObjectURL(url); $('savePng').disabled = false; }
  }
  function renderQuizGraphic() {
    if (!state.session) return;
    const options = proofOptions(state.session.answered, state.quizProof);
    $('quizGraphic').innerHTML = renderScene(state.session.current, options);
    $('quizContext').value = String(Math.round(options.contextOpacity * 100));
    $('quizContextValue').textContent = Math.round(options.contextOpacity * 100) + '%';
    $('quizOverlay').checked = options.overlay;
    $('quizGuides').checked = options.reveal;
  }
  function renderQuestion() {
    const session = state.session, scene = session.current, response = session.responses[session.index];
    $('quizSetup').hidden = true; $('quizResults').hidden = true; $('quizPlay').hidden = false; $('reviewPanel').hidden = true;
    $('quizProgressLabel').textContent = `QUESTION ${String(session.index + 1).padStart(2, '0')} / ${session.scenes.length}`;
    $('quizProgress').setAttribute('aria-valuemax', String(session.scenes.length));
    $('quizProgress').setAttribute('aria-valuenow', String(session.responses.length));
    $('quizProgressFill').style.width = session.responses.length / session.scenes.length * 100 + '%';
    $('quizKind').textContent = byId.get(scene.id).name;
    $('quizQuestion').textContent = scene.question;
    renderQuizGraphic();
    $('quizChoices').replaceChildren();
    for (const choice of scene.choices) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'choice'; button.dataset.choice = choice.id;
      button.textContent = choice.label; button.disabled = session.answered;
      button.setAttribute('aria-pressed', String(response?.choice === choice.id));
      if (response && choice.id === scene.answer) { button.classList.add('is-correct'); const marker = document.createElement('span'); marker.className = 'choice-marker'; marker.textContent = '✓ 正しい答え'; button.append(marker); }
      else if (response?.choice === choice.id) button.classList.add('is-wrong');
      button.addEventListener('click', safely(() => {
        if (!session.answer(choice.id)) return;
        state.quizProof = proofOptions(true);
        renderQuestion();
      }));
      $('quizChoices').append(button);
    }
    $('quizFeedback').hidden = !session.answered;
    $('quizNext').hidden = !session.answered;
    $('quizContext').disabled = $('quizOverlay').disabled = $('quizGuides').disabled = !session.answered;
    $('quizNext').textContent = session.index === session.scenes.length - 1 ? '結果を見る →' : '次の問題 →';
    $('quizChoiceHint').textContent = session.answered ? '補助線や重ね合わせで、答えを確かめられます。' : '画面に描かれた形について答えてください。';
    if (response) {
      $('quizFeedback').classList.toggle('is-correct', response.correct);
      $('quizFeedback').classList.toggle('is-wrong', !response.correct);
      $('quizVerdict').textContent = response.correct ? '✓ 正解' : 'もう一度見てみよう';
      $('quizCorrectAnswer').textContent = scene.answerText;
      $('quizExplanation').textContent = scene.explanation;
      $('quizLesson').innerHTML = lessonMarkup(scene.id);
      showMeasurements('quizMeasurements', scene.measurements);
    } else {
      $('quizVerdict').textContent = ''; $('quizCorrectAnswer').textContent = ''; $('quizExplanation').textContent = ''; $('quizMeasurements').replaceChildren(); $('quizLesson').replaceChildren();
    }
  }
  function startQuiz(options = readQuizOptions()) {
    const ids = CATALOGUE.filter(item => item.quiz && (options.category === 'all' || item.category === options.category)).map(item => item.id);
    if (!ids.length) throw new Error('出題するテーマを選んでください。');
    const scenes = makeQuiz({ seed: options.seed, difficulty: options.difficulty, count: options.count, ids });
    const session = new QuizSession(scenes);
    for (const scene of scenes) renderScene(scene);
    state.session = session; state.quizOptions = { ...options }; state.quizProof = proofOptions(false); state.reviewIndex = null;
    $('quizSeed').value = String(options.seed); $('quizDifficulty').value = options.difficulty; $('quizCount').value = String(options.count); $('quizCategory').value = options.category;
    chooseMode('quiz', false); replaceAddress({ mode: 'quiz', ...options }); renderQuestion();
    status('クイズを始めました。答えを選ぶと仕掛けを確かめられます。');
    $('quizQuestion').scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  function settingsView() {
    $('quizSetup').hidden = false; $('quizPlay').hidden = true; $('quizResults').hidden = true; $('reviewPanel').hidden = true;
    state.session = null; state.quizOptions = null; state.reviewIndex = null;
    replaceAddress({ mode: 'quiz', ...readQuizOptions() }); status('条件を選んで、何度でも挑戦できます。');
  }
  function renderResults() {
    const session = state.session;
    $('quizPlay').hidden = true; $('quizSetup').hidden = true; $('quizResults').hidden = false; $('reviewPanel').hidden = true;
    $('resultScore').textContent = String(session.score); $('resultTotal').textContent = `/ ${session.scenes.length} 正解`;
    $('resultDescription').textContent = `${session.scenes.length}問に挑戦しました。番号 ${state.quizOptions.seed} の問題セットです。気になった図をもう一度確かめましょう。`;
    $('resultCategories').replaceChildren();
    for (const row of categoryResults(session)) {
      const card = document.createElement('div'); card.className = 'category-result';
      const label = document.createElement('span'); label.textContent = CATEGORIES[row.category].label;
      const score = document.createElement('strong'); score.textContent = String(row.correct);
      const total = document.createElement('small'); total.textContent = `/ ${row.total} 正解`; score.append(total); card.append(label, score); $('resultCategories').append(card);
    }
    $('resultList').replaceChildren();
    session.responses.forEach((response, index) => {
      const scene = session.scenes[index], label = scene.choices.find(choice => choice.id === response.choice).label;
      const button = document.createElement('button'); button.type = 'button'; button.className = `result-row${response.correct ? '' : ' is-wrong'}`;
      const mark = document.createElement('span'); mark.className = 'result-mark'; mark.textContent = response.correct ? '✓' : '↻';
      const content = document.createElement('div'); content.className = 'result-row-content';
      const title = document.createElement('h4'); title.textContent = `${String(index + 1).padStart(2, '0')}　${byId.get(scene.id).name}`;
      const answer = document.createElement('p'); answer.textContent = `あなた：${label} ／ 正解：${scene.answerText}`;
      const arrow = document.createElement('span'); arrow.className = 'review-arrow'; arrow.textContent = '↗';
      content.append(title, answer); button.append(mark, content, arrow); button.addEventListener('click', safely(() => showReview(index))); $('resultList').append(button);
    });
    status('結果を表示しました。各問題を押すと図を見直せます。');
    $('resultTitle').scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  function renderReview() {
    if (state.reviewIndex === null || !state.session) return;
    const { scene } = state.session.review(state.reviewIndex);
    const contextOpacity = Number($('reviewContext').value) / 100;
    $('reviewGraphic').innerHTML = renderScene(scene, { reveal: true, contextOpacity, overlay: $('reviewOverlay').checked });
    $('reviewContextValue').textContent = Math.round(contextOpacity * 100) + '%';
    $('reviewAnswer').textContent = scene.answerText; $('reviewExplanation').textContent = scene.explanation;
    $('reviewLesson').innerHTML = lessonMarkup(scene.id);
    showMeasurements('reviewMeasurements', scene.measurements);
  }
  function showReview(index) {
    state.session.review(index); state.reviewIndex = index;
    $('reviewPanel').hidden = false; $('reviewContext').value = '100'; $('reviewOverlay').checked = false;
    $('reviewTitle').textContent = `問題 ${index + 1}　${byId.get(state.session.scenes[index].id).name}`;
    renderReview(); $('reviewPanel').scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  for (const item of CATALOGUE) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; $('labType').append(option); }
  for (const [category, item] of Object.entries(CATEGORIES)) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label; button.dataset.category = category; button.setAttribute('aria-pressed', String(category === 'all'));
    button.addEventListener('click', () => { state.filter = category; for (const filter of $('catalogueFilters').querySelectorAll('button')) filter.setAttribute('aria-pressed', String(filter.dataset.category === category)); renderCatalogue(); });
    $('catalogueFilters').append(button);
  }
  for (const option of [...$('quizCategory').options]) if (option.value !== 'all' && !quizCategories.has(option.value)) option.remove();
  $('illusionCount').textContent = String(CATALOGUE.length);
  $('labType').value = initial.id; $('labDifficulty').value = initial.difficulty; $('labSeed').value = String(initial.seed);
  $('quizDifficulty').value = initial.difficulty; $('quizCount').value = String(initial.count); $('quizCategory').value = initial.category; $('quizSeed').value = String(initial.seed);
  $('tabLab').addEventListener('click', () => chooseMode('lab'));
  $('tabQuiz').addEventListener('click', () => chooseMode('quiz'));
  for (const [id, other, mode] of [['tabLab', 'tabQuiz', 'quiz'], ['tabQuiz', 'tabLab', 'lab']]) $(id).addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); chooseMode(mode); $(other).focus(); } });
  $('generateLab').addEventListener('click', safely(() => generateLab()));
  $('labSeed').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); safely(() => generateLab())(); } });
  $('labType').addEventListener('change', safely(() => generateLab()));
  $('labDifficulty').addEventListener('change', safely(() => generateLab()));
  $('randomLab').addEventListener('click', safely(() => generateLab({ id: state.lab.id, difficulty: state.lab.difficulty, seed: newSeed() })));
  $('revealLab').addEventListener('click', safely(() => { state.lab.reveal = true; renderLab(); status('補助線と図の値を表示しました。周囲を消したり重ねたりして比べましょう。'); }));
  $('resetLabView').addEventListener('click', safely(() => { state.lab.reveal = false; state.lab.contextOpacity = 1; state.lab.overlay = false; renderLab(); status('最初の見え方に戻しました。'); }));
  $('labContext').addEventListener('input', safely(() => { state.lab.contextOpacity = Number($('labContext').value) / 100; renderLab(); }));
  $('labOverlay').addEventListener('change', safely(() => { state.lab.overlay = $('labOverlay').checked; renderLab(); }));
  $('saveSvg').addEventListener('click', safely(() => { downloadBlob(new Blob([labExportSvg()], { type: 'image/svg+xml;charset=utf-8' }), `IllusionLab_${state.lab.id}_${state.lab.seed}.svg`); status('現在の図をSVGで保存しました。'); }));
  $('savePng').addEventListener('click', savePng);
  $('shareLab').addEventListener('click', () => share(labSettings()));
  $('quizForm').addEventListener('submit', event => { event.preventDefault(); safely(() => startQuiz())(); });
  $('randomQuizSeed').addEventListener('click', () => { $('quizSeed').value = String(newSeed()); status('新しい問題セットの番号を作りました。'); });
  $('shareQuizSetup').addEventListener('click', safely(() => share({ mode: 'quiz', ...readQuizOptions() })));
  $('quizNext').addEventListener('click', safely(() => { if (!state.session.next()) return; if (state.session.finished) renderResults(); else { state.quizProof = proofOptions(false); renderQuestion(); $('quizQuestion').scrollIntoView({ block: 'start', behavior: 'auto' }); } }));
  $('quitQuiz').addEventListener('click', safely(settingsView));
  for (const id of ['quizContext', 'quizOverlay', 'quizGuides']) $(id).addEventListener(id === 'quizContext' ? 'input' : 'change', safely(() => {
    if (!state.session?.answered) return;
    state.quizProof = { reveal: $('quizGuides').checked, contextOpacity: Number($('quizContext').value) / 100, overlay: $('quizOverlay').checked }; renderQuizGraphic();
  }));
  $('replayQuiz').addEventListener('click', safely(() => startQuiz(state.quizOptions)));
  $('newQuiz').addEventListener('click', safely(() => startQuiz({ ...state.quizOptions, seed: newSeed() })));
  $('changeQuizSettings').addEventListener('click', safely(settingsView));
  $('shareQuizResults').addEventListener('click', () => share({ mode: 'quiz', ...state.quizOptions }));
  $('saveQuizCsv').addEventListener('click', safely(() => { downloadBlob(new Blob([resultsCsv(state.session, state.quizOptions)], { type: 'text/csv;charset=utf-8' }), `IllusionLab_quiz_${state.quizOptions.seed}.csv`); status('クイズの結果をCSVで保存しました。'); }));
  $('closeReview').addEventListener('click', () => { $('reviewPanel').hidden = true; state.reviewIndex = null; });
  $('reviewContext').addEventListener('input', safely(renderReview)); $('reviewOverlay').addEventListener('change', safely(renderReview));
  window.addEventListener('hashchange', () => { if (location.hash === '#quiz') chooseMode('quiz', false); else if (location.hash === '#lab') chooseMode('lab', false); });
  renderCatalogue();
  generateLab({ id: initial.id, difficulty: initial.difficulty, seed: initial.seed });
  chooseMode(initial.mode);
  if (initial.mode === 'quiz') status('共有された条件を読み込みました。「クイズをはじめる」で挑戦できます。'); else status('');
  return { chooseMode };
}

if (typeof document !== 'undefined' && document.getElementById('workspace')) {
  try { initialiseApp(); }
  catch (error) { const status = document.getElementById('appStatus'); if (status) { status.textContent = error.message || 'ページを読み直してもう一度試してください。'; status.classList.add('is-error'); } }
}
