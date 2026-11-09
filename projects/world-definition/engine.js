/* WORLD DEFINITION: the game rules, independent of drawing and browser input. */
'use strict';
(function (root) {
  const TARGETS = [
    { id: 'water', jp: '水', symbol: '◈' },
    { id: 'stone', jp: '石', symbol: '⬡' },
    { id: 'tree', jp: '木', symbol: '♧' },
    { id: 'fire', jp: '炎', symbol: '♨' }
  ];
  const EFFECTS = [
    { id: 'float', jp: '浮遊', detail: '石・木を浮かせ、E＋移動で運びます。川の中央で離すと橋になります。炎は上へ浮きます。' },
    { id: 'move', jp: '移動', detail: '炎が左右に往復します。描かれている位置が、そのまま接触する位置です。' },
    { id: 'grow', jp: '成長', detail: '石・木を大きくします。浮かせた足場は幅が広がります。炎は接触範囲も広がります。' },
    { id: 'glow', jp: '発光', detail: '対象の周りに光をともします。通れる場所は変わりません。' },
    { id: 'freeze', jp: '凍結', detail: '水は凍って通れるようになります。炎は消え、触れてもスタートへ戻されません。' },
    { id: 'solidify', jp: '固体化', detail: '川全体を硬い通路に変えます。水の凍結とは別の、川を渡る方法です。' },
    { id: 'pulse', jp: '脈動', detail: '対象の光がゆっくり明滅します。大きさや足場の幅は変わりません。' },
    { id: 'heat', jp: '加熱', detail: '結晶を取ると解放されます。炎に適用し、ゲートの近くでEを長押しすると開錠します。' }
  ];
  const SUPPORTED = {
    water: ['freeze', 'solidify', 'glow', 'pulse'],
    stone: ['float', 'grow', 'glow', 'pulse'],
    tree: ['float', 'grow', 'glow', 'pulse'],
    fire: ['float', 'move', 'grow', 'glow', 'freeze', 'pulse', 'heat']
  };
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function circleRect(x, y, radius, rect) {
    return Math.hypot(x - clamp(x, rect.x, rect.x + rect.w), y - clamp(y, rect.y, rect.y + rect.h)) < radius;
  }
  function createGame() {
    return {
      player: { x: 425, y: 565 },
      stone: { x: 650, y: 520 }, tree: { x: 235, y: 535 },
      rules: { water: null, stone: null, tree: null, fire: null },
      core: false, gateHeat: 0, gateOpen: false, complete: false,
      elapsed: 0, damageUntil: 0, ruleCount: 0, notice: ''
    };
  }
  function has(game, target, effect) {
    return Boolean(game.rules[target]?.effects.includes(effect));
  }
  function isBridge(game, target) {
    const object = game[target];
    return has(game, target, 'float') && object.y >= 362 && object.y <= 418;
  }
  function bridgeHalfWidth(game, target) {
    return (target === 'tree' ? 35 : 37) + (has(game, target, 'grow') ? 20 : 0);
  }
  function fireGeometry(game) {
    return {
      x: 680 + (has(game, 'fire', 'move') ? 28 * Math.sin(game.elapsed * 2.4) : 0),
      y: 260 - (has(game, 'fire', 'float') ? 27 + 10 * Math.sin(game.elapsed * 2.6) : 0),
      radius: has(game, 'fire', 'grow') ? 31 : 20,
      extinguished: has(game, 'fire', 'freeze')
    };
  }
  function walkable(game, point) {
    const radius = 13;
    if (point.x - radius < 55 || point.x + radius > 815 || point.y - radius < 115 || point.y + radius > 660) return false;
    const walls = [{ x: 55, y: 270, w: 300, h: 22 }, { x: 495, y: 270, w: 320, h: 22 }];
    if (!game.gateOpen) walls.push({ x: 355, y: 270, w: 140, h: 22 });
    if (walls.some(wall => circleRect(point.x, point.y, radius, wall))) return false;
    for (const target of ['stone', 'tree']) {
      if (isBridge(game, target)) continue;
      const object = game[target];
      const floatOffset = has(game, target, 'float') ? 18 : 0;
      if (target === 'stone') {
        if (distance(point, { x: object.x, y: object.y - floatOffset }) < radius + (has(game, target, 'grow') ? 36 : 20)) return false;
      } else {
        const height = has(game, target, 'grow') ? 34.5 : 23;
        if (circleRect(point.x, point.y, radius, { x: object.x - 8, y: object.y - floatOffset - height, w: 16, h: height })) return false;
      }
    }
    if (point.y + radius > 350 && point.y - radius < 430) {
      if (has(game, 'water', 'freeze') || has(game, 'water', 'solidify')) return true;
      return ['stone', 'tree'].some(target => {
        const halfWidth = bridgeHalfWidth(game, target);
        return isBridge(game, target) && point.x - radius >= game[target].x - halfWidth && point.x + radius <= game[target].x + halfWidth;
      });
    }
    return true;
  }
  function describeRule(target, effects) {
    const label = TARGETS.find(item => item.id === target).jp;
    const names = effects.map(id => EFFECTS.find(item => item.id === id).jp);
    return { target, effects: [...effects], name: label + 'の' + names.join('・'), description: names.map(name => name + 'を適用').join('、') + '。対象ごとのルールは、別の対象を選んでも残ります。' };
  }
  function applyRule(game, target, effects) {
    if (!Object.hasOwn(SUPPORTED, target) || !Array.isArray(effects) || effects.length < 1 || effects.length > 3 || new Set(effects).size !== effects.length || effects.some(id => !SUPPORTED[target].includes(id))) {
      return { ok: false, message: 'この対象で使える動作を1〜3個選んでください。' };
    }
    if (effects.includes('heat') && !game.core) return { ok: false, message: '結晶を取ると「加熱」が使えます。' };
    const previous = game.rules[target];
    game.rules[target] = describeRule(target, effects);
    if (!walkable(game, game.player)) {
      game.rules[target] = previous;
      return { ok: false, message: '今いる場所の足場がなくなります。いったん岸や、物体から離れた場所へ移動してください。' };
    }
    game.ruleCount += 1;
    return { ok: true, rule: game.rules[target], message: '「' + game.rules[target].name + '」を適用しました。' };
  }
  function tick(game, input, dt) {
    game.elapsed += dt;
    let dx = Number(input.has('d') || input.has('arrowright')) - Number(input.has('a') || input.has('arrowleft'));
    let dy = Number(input.has('s') || input.has('arrowdown')) - Number(input.has('w') || input.has('arrowup'));
    const length = Math.hypot(dx, dy);
    if (length) { dx /= length; dy /= length; }
    if (input.has('e') && length) {
      const nearby = ['stone', 'tree'].filter(target => has(game, target, 'float') && distance(game.player, game[target]) < 115);
      nearby.sort((a, b) => distance(game.player, game[a]) - distance(game.player, game[b]));
      if (nearby.length) {
        const object = game[nearby[0]], previous = { ...object };
        object.x = clamp(object.x + dx * 180 * dt, 95, 775);
        object.y = clamp(object.y + dy * 180 * dt, 330, 630);
        if (!walkable(game, game.player)) Object.assign(object, previous);
      }
    } else if (!input.has('e')) {
      for (const target of ['stone', 'tree']) if (isBridge(game, target)) game[target].y = 390;
    }
    const nextX = { x: game.player.x + dx * 215 * dt, y: game.player.y };
    if (walkable(game, nextX)) game.player.x = nextX.x;
    const nextY = { x: game.player.x, y: game.player.y + dy * 215 * dt };
    if (walkable(game, nextY)) game.player.y = nextY.y;
    if (!game.core && distance(game.player, { x: 245, y: 316 }) < 33) {
      game.core = true;
      game.notice = '結晶を見つけた！ 炎の「加熱」が使えるようになりました。';
    }
    const fire = fireGeometry(game);
    if (!fire.extinguished && distance(game.player, fire) < 13 + fire.radius) {
      game.player = { x: 425, y: 565 };
      game.damageUntil = game.elapsed + 2;
      game.notice = '炎に触れました。ルールと結晶はそのまま、スタートへ戻ります。';
    }
    if (game.core && !game.gateOpen && has(game, 'fire', 'heat') && distance(game.player, { x: 425, y: 281 }) < 105 && input.has('e') && !length) {
      game.gateHeat = clamp(game.gateHeat + dt * 0.8, 0, 1);
      if (game.gateHeat >= 1) { game.gateOpen = true; game.notice = 'ゲートが開きました！ 北側のゴールへ進みましょう。'; }
    }
    if (game.gateOpen && circleRect(game.player.x, game.player.y, 13, { x: 370, y: 155, w: 110, h: 68 })) game.complete = true;
  }
  function update(game, input, dt) {
    if (game.complete || !Number.isFinite(dt) || dt <= 0) return;
    // Small steps keep contact checks stable even when a frame takes longer.
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0.0000001 && !game.complete) {
      const step = Math.min(remaining, 1 / 120);
      tick(game, input, step);
      remaining -= step;
    }
  }
  function objective(game) {
    if (game.complete) return 'ステージクリア！';
    if (!game.core) return game.player.y > 350 ? '川を渡って、青い結晶を見つけよう' : '青い結晶へ近づこう';
    return game.gateOpen ? '開いたゲートを通って、北のゴールへ' : '炎に「加熱」を適用し、ゲートの近くでEを長押し';
  }
  const api = { TARGETS, EFFECTS, SUPPORTED, createGame, has, isBridge, bridgeHalfWidth, fireGeometry, walkable, applyRule, update, objective, distance, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinition = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
