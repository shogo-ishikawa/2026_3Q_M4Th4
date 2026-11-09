/* Browser input and Canvas drawing. The rules themselves live in engine.js. */
'use strict';
(() => {
  const E = window.WorldDefinition;
  const el = id => document.getElementById(id);
  const canvas = el('game');
  let storage;
  try { storage = window.localStorage; } catch (_) { storage = null; }
  const progressStore = window.WorldDefinitionProgress.createStore(storage, E.LEVELS.length);
  const sessions = window.WorldDefinitionSession;
  const sessionStore = sessions.createStore(storage, E);
  const history = sessions.createHistory(E, { limit: 40 });
  const savedSession = sessionStore.load(progressStore.snapshot().unlocked);
  let game = savedSession || E.createGame(progressStore.snapshot().lastStage);
  let started = false;
  let lastSaveTime = 0;
  let carrying = false;
  let selectedTarget = game.stageIndex === 2 ? 'tree' : game.stageIndex > 0 ? 'stone' : 'water';
  let selectedEffects = [...(game.rules[selectedTarget]?.effects || [])];
  let requestGeneration = 0;
  let pendingRequest = null;
  let proposalGeneration = 0;
  let interpretationRequest = null;
  let connectionRequest = null;
  let candidate = null;
  const localAI = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
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
  function saveSession() {
    if (!started || game.complete) return;
    sessionStore.save(game);
    text('session-status', sessionStore.persistent ? '途中の状態をこのブラウザに保存しています。' : '途中の状態を保存できません。この画面を開いている間は遊べます。');
  }
  function cancelInterpretation() {
    proposalGeneration++; interpretationRequest?.abort(); interpretationRequest = null; candidate = null;
    el('ai-candidate').hidden = true; el('ai-interpret').disabled = false;
    el('ai-cancel').hidden = !pendingRequest;
  }
  function cancelNaming() { requestGeneration++; pendingRequest?.abort(); pendingRequest = null; el('ai-cancel').hidden = !interpretationRequest; }
  function cancelAI() { cancelNaming(); cancelInterpretation(); }
  function formatTime(seconds) {
    const value = Math.max(0, Math.round(seconds));
    return Math.floor(value / 60) + '分' + String(value % 60).padStart(2, '0') + '秒';
  }
  function updateHud() {
    text('objective', E.objective(game));
    const rule = game.rules[selectedTarget];
    text('hudpower', '定義 ' + game.ruleCount + ' 回');
    el('undo').disabled = !history.canUndo || game.complete || paused();
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
      option.textContent = (index < 5 ? '基本 ' : '応用 ') + (index + 1) + '. ' + level.name + (option.disabled ? '（未解放）' : saved.best[index] ? ' ✓' : '');
      el('stage-select').append(option);
    });
    el('stage-select').value = String(game.stageIndex);
    text('stage-number', 'STAGE ' + String(game.stageIndex + 1).padStart(2, '0') + ' / ' + String(E.LEVELS.length).padStart(2, '0'));
    text('stage-name', game.level.name);
    text('stage-description', game.level.subtitle);
    text('start-intro', 'ステージ ' + (game.stageIndex + 1) + ' / ' + E.LEVELS.length + '：' + game.level.name + '。' + game.level.subtitle);
    text('start-rule-hint', game.stageIndex === 0 ? '迷ったら「水」＋「固体化」を選んで適用。' : game.level.subtitle);
    const best = saved.best[game.stageIndex];
    text('stage-record', (best ? 'ベスト：定義 ' + best.rules + ' 回 / 欠片 ' + best.shards + ' 個 / ' + formatTime(best.time) : '金の欠片は寄り道の目標です。集めなくてもクリアできます。') + (game.level.parRules ? ' 挑戦目標：定義 ' + game.level.parRules + ' 回以内（任意）' : ''));
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
  for (const target of ['stone', 'tree']) {
    visualDescriptions[target].shrink = '物体と足場が小さくなります。応用面の狭い入口を通せます。成長とは同時に使えません。';
    visualDescriptions[target].rotate = '足場の向きが90度変わります。縦の水路を横に渡る橋を作れます。';
  }
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
    text('unlock-message', game.level.gateMode === 'sensors' ? 'この応用面は盤と結晶で自動開門します。炎の加熱は必要ありません。' : game.core ? '結晶を回収済み。「炎」の「加熱」が使えます。' : '青い結晶を取ると、炎の「加熱」が使えます。');
    el('apply').disabled = selectedEffects.length === 0 || game.complete;
    el('apply').textContent = 'ルールを適用';
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
    if (game.complete) return;
    clearKeys();
    const before = sessions.capture(E, game);
    const result = E.applyRule(game, selectedTarget, selectedEffects);
    status(result.message);
    if (!result.ok) return;
    history.recordSnapshot(before); cancelAI(); saveSession();
    const target = selectedTarget, effects = [...selectedEffects];
    renderLab(); canvas.focus({ preventScroll: true }); canvas.scrollIntoView({ block: 'start' });
    if (!localAI || !el('use-ai').checked) return;
    const generation = ++requestGeneration, expectedRule = game.rules[target];
    const controller = new AbortController(); pendingRequest = controller;
    el('ai-cancel').hidden = false;
    text('ai-status', 'ルールは適用済みです。AIが名前を考えています。そのまま操作できます。');
    const timer = setTimeout(() => controller.abort(), 95000);
    try {
      const selection = { target, effects };
      if (el('ai-model').value) selection.model = el('ai-model').value;
      const response = await fetch('./api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection), signal: controller.signal });
      const data = await response.json();
      if (generation !== requestGeneration || game.rules[target] !== expectedRule) return;
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '名前を受け取れませんでした。');
      if (data.target !== target || !Array.isArray(data.effects) || JSON.stringify([...data.effects].sort()) !== JSON.stringify([...effects].sort()) || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 60) throw new Error('AIの返答を確認できませんでした。');
      expectedRule.name = data.name;
      text('ai-status', 'ルールの名前を更新しました。効果と操作説明は共通です。');
      saveSession();
    } catch (error) {
      if (generation === requestGeneration) text('ai-status', error.name === 'AbortError' ? '名前の生成を終了しました。標準の名前で遊べます。' : 'AIの名前を取得できませんでした。標準の名前で遊べます。');
    } finally {
      clearTimeout(timer);
      if (generation === requestGeneration) { pendingRequest = null; el('ai-cancel').hidden = !interpretationRequest; renderLab(); }
    }
  }
  el('apply').addEventListener('click', applySelectedRule);
  if (localAI) el('local-ai').hidden = false;
  else el('use-ai').checked = false;
  el('ai-check').addEventListener('click', async () => {
    if (!localAI) return;
    connectionRequest?.abort();
    const controller = new AbortController(); connectionRequest = controller;
    el('ai-check').disabled = true; text('ai-connection-status', 'Ollamaとの接続を確認しています…');
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch('./api/status', { signal: controller.signal });
      const data = await response.json();
      if (controller !== connectionRequest) return;
      if (!response.ok || !Array.isArray(data.models) || data.models.some(item => typeof item !== 'string' || item.length > 200) || typeof data.available !== 'boolean') throw new Error();
      const previous = el('ai-model').value;
      el('ai-model').replaceChildren();
      for (const name of data.models) { const option = document.createElement('option'); option.value = name; option.textContent = name; el('ai-model').append(option); }
      if (!data.models.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'モデルが見つかりません'; el('ai-model').append(option); }
      const selection = data.models.includes(previous) ? previous : data.models.includes(data.model) ? data.model : data.models[0] || '';
      if (previous !== selection) cancelAI();
      el('ai-model').value = selection;
      text('ai-connection-status', typeof data.message === 'string' ? data.message : data.available ? '接続できました。' : 'Ollamaとモデルの起動を確認してください。');
    } catch (_) {
      if (controller === connectionRequest) text('ai-connection-status', '接続できません。PythonサーバーとOllamaを起動し、もう一度確認してください。手動の定義はそのまま使えます。');
    } finally {
      clearTimeout(timer);
      if (controller === connectionRequest) { connectionRequest = null; el('ai-check').disabled = false; }
    }
  });
  el('ai-interpret').addEventListener('click', async () => {
    if (!localAI || game.complete) return;
    const instruction = el('ai-text').value.trim();
    if (!instruction || instruction.length > 500) { text('ai-status', '変えたい物体と動作を、500文字以内で入力してください。'); return; }
    cancelNaming(); cancelInterpretation(); clearKeys();
    const generation = proposalGeneration, stageIndex = game.stageIndex;
    const controller = new AbortController(); interpretationRequest = controller;
    el('ai-interpret').disabled = true; el('ai-cancel').hidden = false;
    text('ai-status', '文章から候補を作っています。手動の定義も使えます。初回は時間がかかる場合があります。');
    const timer = setTimeout(() => controller.abort(), 95000);
    try {
      const request = { text: instruction }; if (el('ai-model').value) request.model = el('ai-model').value;
      const response = await fetch('./api/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
      const data = await response.json();
      if (generation !== proposalGeneration || game.stageIndex !== stageIndex) return;
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '文章を解釈できませんでした。');
      if (!E.TARGETS.some(item => item.id === data.target) || !Array.isArray(data.effects) || data.effects.length < 1 || data.effects.length > 3 || new Set(data.effects).size !== data.effects.length || data.effects.some(id => !E.SUPPORTED[data.target].includes(id))) throw new Error('対応する物体と動作を確認できませんでした。');
      candidate = { target: data.target, effects: [...data.effects], generation, stageIndex };
      text('ai-candidate-text', '候補：' + label(data.target) + ' ＋ ' + data.effects.map(effectLabel).join(' ＋ '));
      el('ai-candidate').hidden = false;
      text('ai-status', '候補を確認してください。適用するときに、このステージで使える定義かも確認します。');
    } catch (error) {
      if (generation === proposalGeneration) text('ai-status', error.name === 'AbortError' ? '生成を終了しました。文章を短くするか、手動で動作を選んでください。' : error.message);
    } finally {
      clearTimeout(timer);
      if (generation === proposalGeneration) { interpretationRequest = null; el('ai-interpret').disabled = false; el('ai-cancel').hidden = !pendingRequest; }
    }
  });
  el('ai-apply-candidate').addEventListener('click', () => {
    if (!candidate || candidate.generation !== proposalGeneration || candidate.stageIndex !== game.stageIndex || paused()) return;
    selectedTarget = candidate.target; selectedEffects = [...candidate.effects]; renderLab();
    applySelectedRule();
  });
  el('ai-text').addEventListener('input', () => { cancelInterpretation(); text('ai-status', '文章を変更しました。「文章から候補を作る」で確認できます。'); });
  el('ai-model').addEventListener('change', () => { cancelAI(); text('ai-status', 'モデルを変更しました。新しい文章から候補を作れます。'); });
  el('use-ai').addEventListener('change', () => { if (!el('use-ai').checked) cancelNaming(); });
  el('ai-cancel').addEventListener('click', () => { cancelAI(); text('ai-status', '生成を中止しました。手動の定義はそのまま使えます。'); });
  function reset(stageIndex = game.stageIndex) {
    cancelAI(); history.clear(); carrying = false;
    clearKeys(); progressStore.select(stageIndex); game = E.createGame(stageIndex); selectedTarget = game.stageIndex === 2 ? 'tree' : game.stageIndex > 0 ? 'stone' : 'water'; selectedEffects = [];
    started = true; hadCore = false; hadComplete = false; hintIndex = 0; currentHintKey = '';
    el('hint-content').hidden = true; el('hint-panel').hidden = true; el('hint-marker').checked = false; text('hint-recovery-status', ''); el('hint-button').setAttribute('aria-expanded', 'false');
    dialogs.forEach(dialog => { if (dialog.open) dialog.close(); });
    status('新しく始めました。対象と動作を選んでみましょう。');
    renderStage(); renderLab(); saveSession(); canvas.focus({ preventScroll: true });
  }
  function undo() {
    if (paused() || game.complete || !history.canUndo) return;
    const restored = history.undo(); if (!restored) return;
    cancelAI(); clearKeys(); carrying = false; game = restored;
    hadCore = game.core; hadComplete = false; hintIndex = 0; currentHintKey = '';
    selectedEffects = [...(game.rules[selectedTarget]?.effects || [])];
    text('hint-recovery-status', ''); status('直前の定義・運搬・配置復旧を1手戻しました。');
    renderStage(); renderLab(); saveSession(); canvas.focus({ preventScroll: true });
  }
  el('undo').addEventListener('click', undo);
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
  function beginPlay() { started = true; el('start-dialog').close(); saveSession(); canvas.scrollIntoView({ block: 'start' }); }
  el('start-button').addEventListener('click', beginPlay);
  el('start-dialog').addEventListener('cancel', event => { event.preventDefault(); beginPlay(); });
  el('start-fresh').addEventListener('click', () => reset());
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
      clearKeys(); const before = sessions.capture(E, game); const result = E.recoverObject(game, target);
      text('hint-recovery-status', result.message); status(result.message);
      if (result.ok) { history.recordSnapshot(before); cancelAI(); renderLab(); renderHints(); saveSession(); }
    });
  }
  function editingField(target) { return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)); }
  const movement = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'e']);
  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (paused() || editingField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!event.repeat && (key === 'j' || key === '?')) { event.preventDefault(); showHints(); return; }
    if (!event.repeat && key === 'h') { event.preventDefault(); showHelp(); return; }
    if (!event.repeat && key === 'z') { event.preventDefault(); undo(); return; }
    if (!event.repeat && key === 'r') { event.preventDefault(); askReset(); return; }
    if (!event.repeat && key === 'l') { event.preventDefault(); clearKeys(); el('lab-panel').focus(); return; }
    // Arrow keys retain their normal scrolling behaviour outside the game controls.
    const gameFocus = event.target === canvas || event.target === document.body || event.target?.hasAttribute('data-key');
    if (movement.has(key) && gameFocus) { event.preventDefault(); keyboardKeys.add(key); syncKeys(); }
  });
  window.addEventListener('keyup', event => { keyboardKeys.delete(event.key.toLowerCase()); syncKeys(); });
  window.addEventListener('blur', () => { clearKeys(); saveSession(); });
  window.addEventListener('pagehide', saveSession);
  document.addEventListener('visibilitychange', () => { clearKeys(); saveSession(); });
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
    cancelAI(); sessionStore.clear(); history.clear(); text('session-status', 'クリアしました。次のステージでも途中の状態を保存します。');
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
    if (!paused()) {
      const isCarrying = pressed.has('e') && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].some(key => pressed.has(key)) && ['stone', 'tree'].some(target => E.has(game, target, 'float') && E.distance(game.player, game[target]) < 115);
      if (isCarrying && !carrying) { history.record(game); cancelInterpretation(); }
      if (!isCarrying && carrying) saveSession();
      carrying = isCarrying; E.update(game, pressed, dt);
      if (timestamp - lastSaveTime >= 1000) { lastSaveTime = timestamp; saveSession(); }
    }
    if (game.core !== hadCore) { hadCore = game.core; renderLab(); }
    if (game.notice) { status(game.notice); game.notice = ''; }
    if (game.complete && !hadComplete) { hadComplete = true; clearKeys(); recordComplete(); }
    updateHud();
    if (!el('hint-panel').hidden) renderHints();
    const marker = !el('hint-panel').hidden && el('hint-marker').checked ? E.hintTarget(game) : null;
    renderer.draw(game, selectedTarget, marker); requestAnimationFrame(frame);
  }
  renderStage(); renderLab();
  if (savedSession) {
    text('start-button', '続きから'); el('start-fresh').hidden = false; el('resume-note').hidden = false;
    text('resume-note', '保存した途中の状態があります。ステージ ' + (game.stageIndex + 1) + '：' + game.level.name + '／定義 ' + game.ruleCount + ' 回から再開できます。');
  }
  requestAnimationFrame(frame); el('start-dialog').showModal();
})();
