/* Browser input and Canvas drawing. The rules themselves live in engine.js. */
'use strict';
(() => {
  const E = window.WorldDefinition;
  const el = id => document.getElementById(id);
  const canvas = el('game');
  const ctx = canvas.getContext('2d');
  let game = E.createGame();
  let selectedTarget = 'water';
  let selectedEffects = [];
  let busy = false;
  let requestGeneration = 0;
  let pendingRequest = null;
  let hadCore = false;
  let hadComplete = false;
  let hintIndex = 0;
  let magicUntil = 0;
  const pressed = new Set();
  const keyboardKeys = new Set();
  const heldButtons = new Map();
  const pointerKeys = new Map();
  const dialogs = [...document.querySelectorAll('dialog')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = 870 * pixelRatio;
  canvas.height = 570 * pixelRatio;
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
  function updateHud() {
    text('objective', E.objective(game));
    const rule = game.rules[selectedTarget];
    text('hudpower', 'ルール適用 ' + game.ruleCount + ' 回');
    const completed = [game.core || game.player.y < 350, game.core, game.gateOpen, game.complete];
    el('progress').querySelectorAll('li').forEach((item, index) => {
      item.classList.toggle('done', completed[index]);
      item.classList.toggle('current', !completed[index] && (index === 0 || completed[index - 1]));
      if (!completed[index] && (index === 0 || completed[index - 1])) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    text('generated-name', rule?.name || 'まだルールを作っていません');
    text('generated-desc', rule?.description || '対象と動作を選び、「ルールを適用」を押しましょう。');
  }
  function renderLab() {
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
      const supported = E.SUPPORTED[selectedTarget].includes(effect.id);
      const locked = effect.id === 'heat' && !game.core;
      const selected = selectedEffects.includes(effect.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice' + (selected ? ' selected' : '') + (!supported || locked ? ' locked' : '');
      button.dataset.effect = effect.id;
      button.disabled = !supported || locked;
      button.setAttribute('aria-pressed', String(selected));
      button.title = supported ? effect.detail : label(selectedTarget) + 'では使えません。';
      const title = document.createElement('span'); title.textContent = (locked ? '🔒 ' : '') + effect.jp;
      const detail = document.createElement('small');
      detail.textContent = !supported ? '対象外' : locked ? '結晶で解放' : selected ? '選択中' : '選択する';
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
      const item = document.createElement('li'); item.textContent = 'まだありません。まずは水を変えてみましょう。'; el('active-rules').append(item);
    }
    updateHud();
  }
  async function applySelectedRule() {
    if (busy) return;
    clearKeys();
    const result = E.applyRule(game, selectedTarget, selectedEffects);
    status(result.message);
    if (!result.ok) return;
    magicUntil = game.elapsed + 1.2;
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
  function reset() {
    requestGeneration++; pendingRequest?.abort(); pendingRequest = null; busy = false;
    clearKeys(); game = E.createGame(); selectedTarget = 'water'; selectedEffects = [];
    hadCore = false; hadComplete = false; hintIndex = 0; magicUntil = 0;
    el('hint-content').hidden = true; el('hint-button').setAttribute('aria-expanded', 'false');
    dialogs.forEach(dialog => { if (dialog.open) dialog.close(); });
    status('新しく始めました。対象と動作を選んでみましょう。');
    renderLab(); canvas.focus({ preventScroll: true });
  }
  const resetDialog = document.createElement('dialog');
  resetDialog.id = 'reset-dialog';
  const heading = document.createElement('h2'); heading.textContent = '最初からやり直しますか？';
  const explanation = document.createElement('p'); explanation.textContent = '今のルール、結晶、ゲートの進行をリセットします。';
  const confirmButton = document.createElement('button'); confirmButton.id = 'confirm-reset'; confirmButton.type = 'button'; confirmButton.className = 'button primary'; confirmButton.textContent = 'やり直す';
  const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.className = 'button quiet'; cancelButton.textContent = '続ける'; cancelButton.autofocus = true;
  confirmButton.addEventListener('click', () => { resetDialog.close(); reset(); });
  cancelButton.addEventListener('click', () => resetDialog.close());
  resetDialog.append(heading, explanation, cancelButton, document.createTextNode(' '), confirmButton); document.body.append(resetDialog);
  function askReset() { clearKeys(); if (!paused()) resetDialog.showModal(); }
  el('reset').addEventListener('click', askReset);
  el('again').addEventListener('click', reset);
  el('close-win').addEventListener('click', () => el('win-dialog').close());
  el('lab-focus').addEventListener('click', () => { clearKeys(); el('lab-panel').focus(); });
  function showHelp() { clearKeys(); if (!paused()) el('help-dialog').showModal(); }
  el('help-button').addEventListener('click', showHelp);
  el('close-help').addEventListener('click', () => el('help-dialog').close());
  el('start-button').addEventListener('click', () => el('start-dialog').close());
  for (const dialog of [...dialogs, resetDialog]) {
    dialog.addEventListener('close', () => { clearKeys(); canvas.focus({ preventScroll: true }); });
    dialog.addEventListener('cancel', clearKeys);
  }
  el('hint-button').addEventListener('click', () => {
    const hints = !game.core ? [
      '川はそのままでは渡れません。研究室で「水」に使える動作を調べましょう。',
      '「水＋固体化」または「水＋凍結」で川全体を通路にできます。',
      '別解：石や木を「浮遊」させ、近づいてE＋移動。川の中央に置くと橋になります。'
    ] : !game.gateOpen ? [
      '結晶で解放された「加熱」は、対象を「炎」にすると選べます。',
      '「炎＋加熱」を適用し、ゲートの南側中央で立ち止まってEを長押ししましょう。'
    ] : ['開いたゲートの中央を通り、北のGOALへ進みましょう。'];
    const content = el('hint-content'); content.hidden = false;
    content.textContent = hints[Math.min(hintIndex, hints.length - 1)]; hintIndex++;
    el('hint-button').setAttribute('aria-expanded', 'true');
  });
  function editingField(target) { return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)); }
  const movement = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'e']);
  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (paused() || editingField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
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
  function rect(x, y, w, h, colour, radius = 0) {
    ctx.fillStyle = colour; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
  }
  function circle(x, y, radius, colour) {
    ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  }
  function word(value, x, y, size = 14, colour = '#244936', align = 'left') {
    ctx.font = '600 ' + size + 'px system-ui, sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillStyle = colour; ctx.fillText(value, x, y); ctx.textAlign = 'left';
  }
  function halo(x, y, radius, colour) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, colour); gradient.addColorStop(1, '#ffffff00'); circle(x, y, radius, gradient);
  }
  function glowObject(target, x, y, radius) {
    if (!E.has(game, target, 'glow') && !E.has(game, target, 'pulse')) return;
    const wave = E.has(game, target, 'pulse') && !reducedMotion ? 0.5 + 0.3 * Math.sin(game.elapsed * 3) : 0.7;
    halo(x, y, radius, 'rgba(255,245,168,' + wave + ')');
  }
  function draw() {
    const time = reducedMotion ? 0 : game.elapsed;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, 870, 570); ctx.save(); ctx.translate(0, -100);
    rect(0, 100, 870, 570, '#1d4036');
    rect(47, 107, 776, 560, '#506d4a', 14);
    rect(55, 115, 760, 545, '#acc294', 8);
    // Hand-drawn-looking grass tufts and small flowers use deterministic positions.
    for (let index = 0; index < 130; index++) {
      const x = 69 + index * 137 % 731, y = 124 + index * 193 % 525;
      if (y > 343 && y < 440 || y > 260 && y < 300) continue;
      ctx.strokeStyle = '#73986665'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 3, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + 3, y - 5); ctx.stroke();
      if (index % 11 === 0) { circle(x + 4, y - 5, 2, '#f5e6ad'); circle(x + 4, y - 5, 0.8, '#c8974d'); }
    }
    rect(404, 435, 42, 210, '#c4ceaa');
    for (let y = 458; y < 634; y += 36) { rect(416, y, 17, 10, '#e0dcb9', 3); }
    const frozen = E.has(game, 'water', 'freeze'), solid = E.has(game, 'water', 'solidify');
    rect(55, 346, 760, 88, '#658f7a');
    const waterGradient = ctx.createLinearGradient(0, 350, 0, 430);
    waterGradient.addColorStop(0, frozen ? '#b6e0dc' : solid ? '#b2c8bc' : '#70b4c6');
    waterGradient.addColorStop(1, frozen ? '#d2efdf' : solid ? '#c9d3b7' : '#438caa');
    rect(55, 350, 760, 80, waterGradient);
    glowObject('water', 425, 390, 280);
    for (let index = 0; index < 25; index++) {
      const x = 62 + (index * 97 + (frozen || solid ? 0 : time * 12)) % 725, y = 362 + index % 4 * 18;
      ctx.strokeStyle = frozen ? '#f5fff3' : solid ? '#8ba89b' : '#c8edf170'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 23, y); if (frozen) ctx.lineTo(x + 12, y + 9); ctx.stroke();
    }
    if (frozen || solid) word(frozen ? '凍った川を歩けます' : '固まった川を歩けます', 72, 402, 12, '#24585d');
    for (const target of ['tree', 'stone']) {
      if (!E.isBridge(game, target)) continue;
      const object = game[target], half = E.bridgeHalfWidth(game, target);
      rect(object.x - half - 3, 340, half * 2 + 6, 102, '#35524b55', 5);
      rect(object.x - half, 340, half * 2, 98, target === 'tree' ? '#bd9b66' : '#bac5b3', 5);
      for (let y = 350; y < 434; y += 17) rect(object.x - half + 4, y, half * 2 - 8, 2, target === 'tree' ? '#906d43' : '#879d92');
      glowObject(target, object.x, 390, 80);
      word(label(target) + 'の足場', object.x, 350, 11, '#344c3c', 'center');
    }
    // The wall and closed gate exactly match the collision geometry in engine.js.
    rect(55, 274, 760, 26, '#395b4c55', 4);
    for (let x = 55; x < 815; x += 40) {
      if (x >= 335 && x < 495) continue;
      const width = Math.min(40, 815 - x, x < 355 ? 355 - x : 40);
      if (x + width <= 355 || x >= 495) { rect(x, 270, width - 1, 22, '#7e9384', 2); rect(x + 3, 272, width - 7, 3, '#b5c3a3', 1); }
    }
    // Fill the few edge blocks so there are no visual gaps beside the gate.
    rect(335, 270, 20, 22, '#7e9384', 2); rect(495, 270, 20, 22, '#7e9384', 2);
    if (!game.gateOpen) {
      rect(355, 270, 140, 22, '#8e7654', 3);
      for (let x = 362; x < 491; x += 15) rect(x, 271, 5, 20, '#d0ad68', 2);
      rect(355, 300, 140, 7, '#3a5a4c', 3); rect(355, 300, 140 * game.gateHeat, 7, '#f0c274', 3);
      word(game.core ? 'E長押しで開錠' : '結晶が必要', 425, 245, 13, '#365440', 'center');
    } else { rect(355, 270, 140, 22, '#d1d6b3'); word('ゲート開放', 425, 247, 12, '#365440', 'center'); }
    rect(367, 152, 116, 76, '#66836b', 9); rect(370, 155, 110, 68, '#e6e4b5', 7);
    rect(378, 163, 94, 52, '#d3dca8', 5); word('GOAL', 425, 175, 23, '#3b6048', 'center');
    word('N ↑', 781, 131, 13, '#355744', 'center');
    word('封印されたゴール', 78, 139, 15, '#355744');
    if (!game.core) {
      const bob = Math.sin(time * 3) * 3; halo(245, 316, 37, '#d8fbf4c0');
      ctx.fillStyle = '#66bed5'; ctx.beginPath(); ctx.moveTo(245, 297 + bob); ctx.lineTo(258, 316 + bob); ctx.lineTo(245, 335 + bob); ctx.lineTo(232, 316 + bob); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#d5ffff'; ctx.lineWidth = 2; ctx.stroke();
      word('結晶', 245, 336, 12, '#355744', 'center');
    }
    for (const target of ['stone', 'tree']) {
      if (E.isBridge(game, target)) continue;
      const object = game[target], floating = E.has(game, target, 'float'), grown = E.has(game, target, 'grow');
      const y = object.y - (floating ? 18 : 0);
      ctx.fillStyle = '#35574836'; ctx.beginPath(); ctx.ellipse(object.x, object.y + 5, grown ? 40 : 26, 10, 0, 0, Math.PI * 2); ctx.fill();
      glowObject(target, object.x, y - 15, 70);
      if (target === 'stone') {
        const radius = grown ? 36 : 20;
        circle(object.x, y, radius, '#a5b3a8'); ctx.strokeStyle = '#657e72'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(object.x - radius * .6, y - 3); ctx.lineTo(object.x, y - radius * .6); ctx.lineTo(object.x + radius * .6, y - 4); ctx.strokeStyle = '#d2dbcc'; ctx.stroke();
        word('石' + (floating ? ' · Eで運ぶ' : ''), object.x, y + radius + 10, 12, '#355744', 'center');
      } else {
        const scale = grown ? 1.5 : 1;
        rect(object.x - 8, y - 55 * scale, 16, 55 * scale, '#91774e', 3);
        circle(object.x, y - 57 * scale, 34 * scale, '#477b54');
        circle(object.x - 13 * scale, y - 67 * scale, 19 * scale, '#5d9160');
        circle(object.x + 13 * scale, y - 73 * scale, 18 * scale, '#759c66');
        word('木' + (floating ? ' · Eで運ぶ' : ''), object.x, y + 10, 12, '#355744', 'center');
      }
    }
    const fire = E.fireGeometry(game);
    if (!fire.extinguished) {
      halo(fire.x, fire.y, fire.radius + 23, '#f3c36f85'); glowObject('fire', fire.x, fire.y, 90);
      circle(fire.x, fire.y, fire.radius, '#d48046'); circle(fire.x, fire.y + 3, fire.radius * .65, '#f4c46e');
      circle(fire.x - 4, fire.y + 5, fire.radius * .3, '#f8e9a8');
    } else { circle(fire.x, fire.y, fire.radius, '#6d8a8a'); word('消火済み', fire.x, fire.y - 6, 10, '#f3f4df', 'center'); }
    word('炎', fire.x, fire.y + fire.radius + 8, 12, '#355744', 'center');
    const player = game.player;
    ctx.fillStyle = '#2e514a55'; ctx.beginPath(); ctx.ellipse(player.x, player.y + 10, 15, 6, 0, 0, Math.PI * 2); ctx.fill();
    circle(player.x, player.y, 13, '#f3d294'); ctx.strokeStyle = '#685c3b'; ctx.lineWidth = 2; ctx.stroke();
    rect(player.x - 9, player.y - 3, 18, 5, '#6c9476', 2); circle(player.x, player.y - 6, 4, '#fff0c6');
    if (game.elapsed < magicUntil && !reducedMotion) {
      ctx.strokeStyle = '#f7f6b9bb'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(player.x, player.y, 15 + (1.2 - magicUntil + game.elapsed) * 35, 0, Math.PI * 2); ctx.stroke();
    }
    if (game.damageUntil > game.elapsed) { rect(264, 208, 328, 30, '#8f6047ed', 8); word('炎に触れました。スタートへ戻ります', 428, 215, 13, '#fff5dc', 'center'); }
    word('START', 425, 615, 11, '#607756', 'center');
    ctx.restore();
  }
  let previousTime = performance.now();
  function frame(timestamp) {
    const dt = Math.min((timestamp - previousTime) / 1000, .05); previousTime = timestamp;
    if (!paused()) E.update(game, pressed, dt);
    if (game.core !== hadCore) { hadCore = game.core; hintIndex = 0; renderLab(); }
    if (game.notice) { status(game.notice); game.notice = ''; }
    if (game.complete && !hadComplete) { hadComplete = true; clearKeys(); el('win-dialog').showModal(); }
    updateHud(); draw(); requestAnimationFrame(frame);
  }
  renderLab(); requestAnimationFrame(frame); el('start-dialog').showModal();
})();
