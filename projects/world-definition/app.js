/* Browser input and Canvas drawing. The rules themselves live in engine.js. */
'use strict';
(() => {
  const E = window.WorldDefinition;
  const el = id => document.getElementById(id);
  const canvas = el('game');
  let storage;
  try { storage = window.localStorage; } catch (_) { storage = null; }
  const progressStore = window.WorldDefinitionProgress.createStore(storage, E.LEVELS.length);
  let game = E.createGame(progressStore.snapshot().lastStage);
  let selectedTarget = game.stageIndex === 2 ? 'tree' : game.stageIndex > 0 ? 'stone' : 'water';
  let selectedEffects = [];
  let busy = false;
  let requestGeneration = 0;
  let pendingRequest = null;
  let hadCore = false;
  let hadComplete = false;
  let hintIndex = 0;
  let currentHintKey = '';
  const pressed = new Set();
  const keyboardKeys = new Set();
  const heldButtons = new Map();
  const pointerKeys = new Map();
  const dialogs = [...document.querySelectorAll('dialog')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = window.WorldDefinitionRenderer.createRenderer(canvas, E, { reducedMotion });
  const text = (id, value) => { if (el(id).textContent !== value) el(id).textContent = value; };
  const label = target => E.TARGETS.find(item => item.id === target).jp;
  const effectLabel = effect => E.EFFECTS.find(item => item.id === effect).jp;
  const paused = () => document.hidden || dialogs.some(dialog => dialog.open) || resetDialog.open;
  function syncKeys() {
    pressed.clear();
    for (const key of [...keyboardKeys, ...pointerKeys.values(), ...heldButtons.values()]) pressed.add(key);
    document.querySelectorAll('[data-key]').forEach(button => button.classList.toggle('held', pressed.has(button.dataset.key)));
  }
  function clearKeys() {
    pressed.clear(); keyboardKeys.clear(); pointerKeys.clear(); heldButtons.clear();
    document.querySelectorAll('[data-key]').forEach(button => button.classList.remove('held'));
  }
  function status(message) { text('rule-status', message); }
  function formatTime(seconds) {
    const value = Math.max(0, Math.round(seconds));
    return Math.floor(value / 60) + '分' + String(value % 60).padStart(2, '0') + '秒';
  }
  function updateHud() {
    text('objective', E.objective(game));
    const rule = game.rules[selectedTarget];
    text('hudpower', '定義 ' + game.ruleCount + ' 回');
    text('interaction-status', E.interactionStatus(game));
    text('shard-count', '欠片 ' + game.collectedShards.filter(Boolean).length + ' / ' + game.level.shards.length);
    E.progressSteps(game).forEach((step, index) => {
      const item = el('progress').querySelectorAll('li')[index];
      if (!item) return;
      item.classList.toggle('done', step.done);
      const current = !step.done && (index === 0 || E.progressSteps(game)[index - 1].done);
      item.classList.toggle('current', current);
      if (current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    text('generated-name', rule?.name || 'まだルールを作っていません');
    text('generated-desc', rule?.description || '対象と動作を選び、「ルールを適用」を押しましょう。');
  }
  function renderStage() {
    const saved = progressStore.snapshot();
    el('stage-select').replaceChildren();
    E.LEVELS.forEach((level, index) => {
      const option = document.createElement('option');
      option.value = String(index); option.disabled = index > saved.unlocked;
      option.textContent = (index + 1) + '. ' + level.name + (option.disabled ? '（未解放）' : saved.best[index] ? ' ✓' : '');
      el('stage-select').append(option);
    });
    el('stage-select').value = String(game.stageIndex);
    text('stage-number', 'STAGE ' + String(game.stageIndex + 1).padStart(2, '0') + ' / ' + String(E.LEVELS.length).padStart(2, '0'));
    text('stage-name', game.level.name);
    text('stage-description', game.level.subtitle);
    text('start-intro', 'ステージ ' + (game.stageIndex + 1) + ' / ' + E.LEVELS.length + '：' + game.level.name + '。' + game.level.subtitle);
    text('start-rule-hint', game.stageIndex === 0 ? '迷ったら「水」＋「固体化」を選んで適用。' : game.level.subtitle);
    const best = saved.best[game.stageIndex];
    text('stage-record', best ? 'ベスト：定義 ' + best.rules + ' 回 / 欠片 ' + best.shards + ' 個 / ' + formatTime(best.time) : '金の欠片は寄り道の目標です。集めなくてもクリアできます。');
    el('progress').replaceChildren();
    E.progressSteps(game).forEach((step, index) => {
      const item = document.createElement('li');
      const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('div'); title.textContent = step.label;
      const detail = document.createElement('small'); detail.textContent = step.detail;
      title.append(detail); item.append(number, title); el('progress').append(item);
    });
  }
  const visualDescriptions = {
    water: { freeze: '水面が氷と結晶に変わり、川を歩いて渡れます。', solidify: '水面が石張りの通路に変わります。', glow: '川全体に金色の光がともります。', pulse: '川に光の輪が広がり、明るさが周期的に変わります。' },
    stone: { float: '石が地面から浮きます。E＋移動で運び、川へ置くと足場になります。', grow: '石と足場が大きくなります。広い川や大きさを測る台座に使えます。', glow: '石が光源になります。光を受ける紋章を点灯できます。', pulse: '石から波紋が広がります。発光と合わせると共鳴盤を起動できます。' },
    tree: { float: '木が地面から浮きます。影が下に残り、E＋移動で運べます。', grow: '幹と葉が大きくなり、足場も広がります。', glow: '木に金色の光がともります。光の紋章の近くへ運ぶと充電します。', pulse: '木から光の波紋が広がります。発光と合わせて受信盤を起動できます。' },
    fire: { float: '炎が上空へ移り、地面に影が残ります。', move: '炎が軌跡に沿って左右へ往復します。', grow: '炎の大きさと触れる範囲が広がります。', glow: '炎の周りに大きな光の輪が現れます。', freeze: '炎が消えて、触れても安全になります。', pulse: '炎の明るさが変わり、波紋が広がります。', heat: '炎が赤く熱を帯びます。条件を満たしたゲートの近くでEを長押しすると熱を送れます。' }
  };
  function renderEffectSummary() {
    el('effect-summary').replaceChildren();
    const active = game.rules[selectedTarget]?.effects || [];
    for (const message of active.length ? active.map(id => visualDescriptions[selectedTarget][id]) : ['まだ適用されていません。選んだ動作は「ルールを適用」で世界に反映されます。']) {
      const item = document.createElement('li'); item.textContent = message; el('effect-summary').append(item);
    }
  }
  function renderLab() {
    game.preferredCarryTarget = ['stone', 'tree'].includes(selectedTarget) ? selectedTarget : null;
    el('targets').replaceChildren();
    for (const target of E.TARGETS) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'choice' + (selectedTarget === target.id ? ' selected' : '');
      button.dataset.target = target.id;
      button.setAttribute('aria-pressed', String(selectedTarget === target.id));
      const title = document.createElement('span'); title.textContent = target.symbol + ' ' + target.jp;
      const detail = document.createElement('small'); detail.textContent = game.rules[target.id] ? '適用中' : '';
      button.append(title, detail);
      button.addEventListener('click', () => {
        selectedTarget = target.id;
        selectedEffects = [...(game.rules[target.id]?.effects || [])];
        renderLab();
        el('targets').querySelector('[data-target="' + target.id + '"]').focus();
      });
      el('targets').append(button);
    }
    el('effects').replaceChildren();
    for (const effect of E.EFFECTS) {
      const supported = E.supportedEffects(game, selectedTarget).includes(effect.id);
      const sealed = E.SUPPORTED[selectedTarget].includes(effect.id) && !supported;
      const locked = effect.id === 'heat' && !game.core;
      const selected = selectedEffects.includes(effect.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice' + (selected ? ' selected' : '') + (!supported || locked ? ' locked' : '') + (sealed ? ' sealed' : '');
      button.dataset.effect = effect.id;
      button.disabled = !supported || locked;
      button.setAttribute('aria-pressed', String(selected));
      button.title = sealed ? 'このステージでは水の変化が封印されています。浮遊した石や木で道を作りましょう。' : supported ? effect.detail : label(selectedTarget) + 'では使えません。';
      const title = document.createElement('span'); title.textContent = (locked ? '🔒 ' : '') + effect.jp;
      const detail = document.createElement('small');
      detail.textContent = sealed ? '封印中' : !supported ? '対象外' : locked ? '結晶で解放' : selected ? '選択中' : '選択する';
      button.append(title, detail);
      button.addEventListener('click', () => {
        if (selectedEffects.includes(effect.id)) selectedEffects = selectedEffects.filter(id => id !== effect.id);
        else if (selectedEffects.length < 3) selectedEffects.push(effect.id);
        else { status('組み合わせられる動作は3つまでです。選択中の動作を押すと外せます。'); return; }
        renderLab();
        status(effect.detail);
        el('effects').querySelector('[data-effect="' + effect.id + '"]').focus();
      });
      el('effects').append(button);
    }
    el('queue').replaceChildren();
    for (const name of [label(selectedTarget), ...selectedEffects.map(effectLabel)]) {
      const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = name;
      el('queue').append(chip);
    }
    text('unlock-message', game.core ? '結晶を回収済み。「炎」の「加熱」が使えます。' : '青い結晶を取ると、炎の「加熱」が使えます。');
    el('apply').disabled = busy || selectedEffects.length === 0;
    el('apply').textContent = busy ? '名前と説明を生成中…' : 'ルールを適用';
    el('active-rules').replaceChildren();
    for (const target of E.TARGETS) {
      const rule = game.rules[target.id];
      if (!rule) continue;
      const item = document.createElement('li'); item.textContent = rule.name; el('active-rules').append(item);
    }
    if (!el('active-rules').children.length) {
      const item = document.createElement('li'); item.textContent = 'まだありません。ステージの目標に合わせて定義しましょう。'; el('active-rules').append(item);
    }
    renderEffectSummary(); updateHud();
  }
  async function applySelectedRule() {
    if (busy) return;
    clearKeys();
    const result = E.applyRule(game, selectedTarget, selectedEffects);
    status(result.message);
    if (!result.ok) return;
    const target = selectedTarget, effects = [...selectedEffects];
    renderLab();
    canvas.focus({ preventScroll: true });
    canvas.scrollIntoView({ block: 'start' });
    if (!el('use-ai').checked) return;
    const generation = ++requestGeneration;
    const expectedRule = game.rules[target];
    busy = true; renderLab();
    status('ルールを適用しました。Ollamaで名前と説明を補助しています…');
    pendingRequest = new AbortController();
    const abortController = pendingRequest;
    const timer = setTimeout(() => abortController.abort(), 35000);
    try {
      const response = await fetch('./api/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, effects }), signal: abortController.signal
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '応答を確認できませんでした。');
      if (data.target !== target || !Array.isArray(data.effects) || JSON.stringify([...data.effects].sort()) !== JSON.stringify([...effects].sort()) || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 60 || typeof data.description !== 'string' || data.description.length > 180) throw new Error('応答の形式が正しくありません。');
      if (generation !== requestGeneration || game.rules[target] !== expectedRule) return;
      expectedRule.name = data.name; expectedRule.description = data.description;
      status('名前と説明を更新しました。動作は選んだルールのままです。');
    } catch (error) {
      if (generation === requestGeneration) status('AIによる補助は利用できませんでした。標準の名前と説明で、そのまま遊べます。');
    } finally {
      clearTimeout(timer);
      if (generation === requestGeneration) { busy = false; pendingRequest = null; renderLab(); }
    }
  }
  el('apply').addEventListener('click', applySelectedRule);
  // Local AI is explicitly opt-in. Public Pages and offline play make no API requests.
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) el('local-ai').hidden = false;
  else el('use-ai').checked = false;
  function reset(stageIndex = game.stageIndex) {
    requestGeneration++; pendingRequest?.abort(); pendingRequest = null; busy = false;
    clearKeys(); progressStore.select(stageIndex); game = E.createGame(stageIndex); selectedTarget = game.stageIndex === 2 ? 'tree' : game.stageIndex > 0 ? 'stone' : 'water'; selectedEffects = [];
    hadCore = false; hadComplete = false; hintIndex = 0; currentHintKey = '';
    el('hint-content').hidden = true; el('hint-panel').hidden = true; el('hint-marker').checked = false; text('hint-recovery-status', ''); el('hint-button').setAttribute('aria-expanded', 'false');
    dialogs.forEach(dialog => { if (dialog.open) dialog.close(); });
    status('新しく始めました。対象と動作を選んでみましょう。');
    renderStage(); renderLab(); canvas.focus({ preventScroll: true });
  }
  const resetDialog = document.createElement('dialog');
  resetDialog.id = 'reset-dialog';
  const heading = document.createElement('h2'); heading.textContent = '最初からやり直しますか？';
  const explanation = document.createElement('p'); explanation.textContent = '今のルール、結晶、ゲートの進行をリセットします。';
  const confirmButton = document.createElement('button'); confirmButton.id = 'confirm-reset'; confirmButton.type = 'button'; confirmButton.className = 'button primary'; confirmButton.textContent = 'やり直す';
  const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.className = 'button quiet'; cancelButton.textContent = '続ける'; cancelButton.autofocus = true;
  let pendingStage = null;
  confirmButton.addEventListener('click', () => { const index = pendingStage ?? game.stageIndex; pendingStage = null; resetDialog.close(); reset(index); });
  cancelButton.addEventListener('click', () => resetDialog.close());
  resetDialog.append(heading, explanation, cancelButton, document.createTextNode(' '), confirmButton); document.body.append(resetDialog);
  function askReset() { clearKeys(); pendingStage = null; heading.textContent = 'このステージをやり直しますか？'; if (!paused()) resetDialog.showModal(); }
  el('reset').addEventListener('click', askReset);
  el('again').addEventListener('click', () => reset());
  el('next-stage').addEventListener('click', () => { if (game.complete && game.stageIndex + 1 < E.LEVELS.length) reset(game.stageIndex + 1); });
  el('change-stage').addEventListener('click', () => {
    const index = Number(el('stage-select').value), saved = progressStore.snapshot();
    if (!Number.isInteger(index) || index < 0 || index > saved.unlocked || paused()) return;
    if (game.complete || (game.ruleCount === 0 && game.elapsed < 1)) { reset(index); return; }
    clearKeys(); pendingStage = index; heading.textContent = '選んだステージへ移動しますか？'; resetDialog.showModal();
  });
  el('close-win').addEventListener('click', () => el('win-dialog').close());
  el('lab-focus').addEventListener('click', () => { clearKeys(); el('lab-panel').focus(); });
  function showHelp() { clearKeys(); if (!paused()) el('help-dialog').showModal(); }
  el('help-button').addEventListener('click', showHelp);
  el('close-help').addEventListener('click', () => el('help-dialog').close());
  el('start-button').addEventListener('click', () => { el('start-dialog').close(); canvas.scrollIntoView({ block: 'start' }); });
  for (const dialog of [...dialogs, resetDialog]) {
    dialog.addEventListener('close', () => { clearKeys(); canvas.focus({ preventScroll: true }); });
    dialog.addEventListener('cancel', clearKeys);
  }
  function renderHints() {
    const key = E.hintKey(game);
    if (key !== currentHintKey) { currentHintKey = key; hintIndex = 0; }
    const hints = E.hints(game);
    hintIndex = Math.min(hintIndex, hints.length - 1);
    text('hint-title', E.objective(game));
    text('hint-step', 'ヒント ' + (hintIndex + 1) + ' / ' + hints.length + (hintIndex === hints.length - 1 ? '：具体的な手順' : ''));
    text('hint-content', hints[hintIndex]);
    el('hint-prev').disabled = hintIndex === 0;
    el('hint-next').disabled = hintIndex === hints.length - 1;
    text('hint-next', hintIndex >= hints.length - 2 ? '答えの手順を見る' : 'もっと具体的に');
  }
  function showHints(open = el('hint-panel').hidden) {
    clearKeys();
    el('hint-panel').hidden = !open; el('hint-content').hidden = !open;
    el('hint-button').setAttribute('aria-expanded', String(open));
    if (open) { renderHints(); el('hint-content').focus({ preventScroll: true }); }
    else canvas.focus({ preventScroll: true });
  }
  el('hint-button').addEventListener('click', () => showHints());
  el('hint-close').addEventListener('click', () => showHints(false));
  el('hint-prev').addEventListener('click', () => { hintIndex = Math.max(0, hintIndex - 1); renderHints(); });
  el('hint-next').addEventListener('click', () => { hintIndex = Math.min(E.hints(game).length - 1, hintIndex + 1); renderHints(); });
  for (const target of ['stone', 'tree']) {
    el('recover-' + target).addEventListener('click', () => {
      clearKeys(); const result = E.recoverObject(game, target);
      text('hint-recovery-status', result.message); status(result.message);
      if (result.ok) { renderLab(); renderHints(); }
    });
  }
  function editingField(target) { return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)); }
  const movement = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'e']);
  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (paused() || editingField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!event.repeat && (key === 'j' || key === '?')) { event.preventDefault(); showHints(); return; }
    if (!event.repeat && key === 'h') { event.preventDefault(); showHelp(); return; }
    if (!event.repeat && key === 'r') { event.preventDefault(); askReset(); return; }
    if (!event.repeat && key === 'l') { event.preventDefault(); clearKeys(); el('lab-panel').focus(); return; }
    // Arrow keys retain their normal scrolling behaviour outside the game controls.
    const gameFocus = event.target === canvas || event.target === document.body || event.target?.hasAttribute('data-key');
    if (movement.has(key) && gameFocus) { event.preventDefault(); keyboardKeys.add(key); syncKeys(); }
  });
  window.addEventListener('keyup', event => { keyboardKeys.delete(event.key.toLowerCase()); syncKeys(); });
  window.addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', clearKeys);
  document.addEventListener('focusin', event => { if (event.target !== canvas && !event.target?.hasAttribute('data-key')) clearKeys(); });
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));
  for (const button of document.querySelectorAll('[data-key]')) {
    const key = button.dataset.key;
    button.addEventListener('pointerdown', event => {
      event.preventDefault(); if (paused()) return;
      button.setPointerCapture(event.pointerId); pointerKeys.set(event.pointerId, key); syncKeys();
    });
    function release(event) {
      pointerKeys.delete(event.pointerId);
      syncKeys();
    }
    button.addEventListener('blur', () => { heldButtons.delete(button); syncKeys(); });
    button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release); button.addEventListener('lostpointercapture', release);
    button.addEventListener('keydown', event => { if ([' ', 'Enter'].includes(event.key) && !paused()) { event.preventDefault(); heldButtons.set(button, key); syncKeys(); } });
    button.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); heldButtons.delete(button); syncKeys(); } });
  }
  function recordComplete() {
    const shards = game.collectedShards.filter(Boolean).length;
    progressStore.recordClear(game.stageIndex, { rules: game.ruleCount, shards, time: game.elapsed });
    const finalStage = game.stageIndex === E.LEVELS.length - 1;
    text('win-title', finalStage ? '全ステージクリア！' : 'ステージクリア！');
    text('win-result', game.level.name + ' / 定義 ' + game.ruleCount + ' 回 / 欠片 ' + shards + ' / ' + game.level.shards.length + ' / ' + formatTime(game.elapsed));
    text('save-status', progressStore.persistent ? 'クリア記録をこのブラウザに保存しました。' : 'この環境では記録を保存できません。この画面を開いている間は続けて遊べます。');
    el('next-stage').hidden = finalStage;
    renderStage(); el('win-dialog').showModal();
  }
  let previousTime = performance.now();
  function frame(timestamp) {
    const dt = Math.min((timestamp - previousTime) / 1000, .05); previousTime = timestamp;
    if (!paused()) E.update(game, pressed, dt);
    if (game.core !== hadCore) { hadCore = game.core; renderLab(); }
    if (game.notice) { status(game.notice); game.notice = ''; }
    if (game.complete && !hadComplete) { hadComplete = true; clearKeys(); recordComplete(); }
    updateHud();
    if (!el('hint-panel').hidden) renderHints();
    const marker = !el('hint-panel').hidden && el('hint-marker').checked ? E.hintTarget(game) : null;
    renderer.draw(game, selectedTarget, marker); requestAnimationFrame(frame);
  }
  renderStage(); renderLab(); requestAnimationFrame(frame); el('start-dialog').showModal();
})();
