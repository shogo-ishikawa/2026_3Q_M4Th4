/* WORLD DEFINITION: data, rules and movement, independent of browser drawing. */
'use strict';
(function (root) {
  const TARGETS = [
    { id: 'water', jp: '水', symbol: '◈' }, { id: 'stone', jp: '石', symbol: '⬡' },
    { id: 'tree', jp: '木', symbol: '♧' }, { id: 'fire', jp: '炎', symbol: '♨' }
  ];
  const EFFECTS = [
    { id: 'float', jp: '浮遊', detail: '石・木が高く浮き、E＋移動で運べます。川に置くと橋になり、北岸へも運べます。炎は上空へ浮きます。' },
    { id: 'move', jp: '移動', detail: '炎が軌跡を残しながら左右へ往復します。光の経路と実際に触れる位置を確かめましょう。' },
    { id: 'grow', jp: '成長', detail: '石・木が大きくなり、浮遊した橋の幅と長さが伸びます。大きさを調べる台座にも使えます。炎も大きくなります。' },
    { id: 'glow', jp: '発光', detail: '対象が明るく光ります。「光の紋章」は、指定された物体を近くで発光させると反応します。' },
    { id: 'freeze', jp: '凍結', detail: '水は氷の通路になります。炎は消火されて安全になります。水の封印があるステージでは使えません。' },
    { id: 'solidify', jp: '固体化', detail: '川を石畳のような硬い通路に変えます。水の封印があるステージでは使えません。' },
    { id: 'pulse', jp: '脈動', detail: '光が明滅し、輪が周期的に広がります。発光と組み合わせると「共鳴盤」を作動させられます。' },
    { id: 'heat', jp: '加熱', detail: '結晶を取ると解放されます。炎に適用し、仕掛けを作動させた後でゲート近くでEを長押しします。' }
  ];
  const SUPPORTED = {
    water: ['freeze', 'solidify', 'glow', 'pulse'],
    stone: ['float', 'grow', 'glow', 'pulse'], tree: ['float', 'grow', 'glow', 'pulse'],
    fire: ['float', 'move', 'grow', 'glow', 'freeze', 'pulse', 'heat']
  };
  const sealedWater = { water: ['glow', 'pulse'] };
  function stage(data) {
    const gate = data.gate;
    return {
      rivers: [{ x: 55, y: 350, w: 760, h: 80 }],
      spawn: { x: 425, y: 565 }, stone: { x: 650, y: 520 }, tree: { x: 235, y: 535 },
      fire: { x: 680, y: 260 }, core: { x: 245, y: 316 },
      goal: { x: 370, y: 155, w: 110, h: 68 }, sensors: [], shards: [], allowed: {},
      ...data,
      walls: [
        { x: 55, y: gate.y, w: gate.x - 55, h: gate.h },
        { x: gate.x + gate.w, y: gate.y, w: 815 - gate.x - gate.w, h: gate.h }
      ]
    };
  }
  const LEVELS = [
    stage({ id: 'first-rules', name: '封印されたゴール', subtitle: '水を変える。物体を浮かせる。まずは自由に試そう。', theme: 'meadow', gate: { x: 355, y: 270, w: 140, h: 22 }, shards: [{ x: 120, y: 560 }, { x: 750, y: 320 }] }),
    stage({ id: 'stone-crossing', name: '石の渡し場', subtitle: '水の定義は封印中。浮かせた物体で道を作ろう。', theme: 'quarry', rivers: [{ x: 55, y: 390, w: 760, h: 80 }], spawn: { x: 650, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 625, y: 250, w: 120, h: 22 }, fire: { x: 520, y: 195 }, core: { x: 160, y: 320 }, goal: { x: 630, y: 150, w: 110, h: 68 }, allowed: sealedWater, shards: [{ x: 125, y: 585 }, { x: 440, y: 320 }] }),
    stage({ id: 'light-garden', name: '光を運ぶ庭', subtitle: '浮かせた木を北岸へ運び、光の紋章を照らそう。', theme: 'night', rivers: [{ x: 55, y: 390, w: 760, h: 80 }], spawn: { x: 425, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 355, y: 250, w: 140, h: 22 }, core: { x: 700, y: 330 }, goal: { x: 370, y: 145, w: 110, h: 68 }, allowed: sealedWater, sensors: [{ id: 'light', target: 'tree', x: 245, y: 330, radius: 70, requires: ['glow'], label: '木の光の紋章' }], shards: [{ x: 125, y: 595 }, { x: 545, y: 335 }] }),
    stage({ id: 'resonance-hall', name: '脈動の回廊', subtitle: '石を発光・脈動させ、北岸の共鳴盤へ運ぼう。', theme: 'resonance', gate: { x: 355, y: 250, w: 140, h: 22 }, goal: { x: 370, y: 145, w: 110, h: 68 }, allowed: sealedWater, sensors: [{ id: 'resonance', target: 'stone', x: 280, y: 320, radius: 70, requires: ['glow', 'pulse'], label: '石の共鳴盤' }], shards: [{ x: 120, y: 565 }, { x: 745, y: 320 }] }),
    stage({ id: 'final-definition', name: '最後の定義', subtitle: '広い川と二つの台座。物体ごとに役割を分けよう。', theme: 'ruins', rivers: [{ x: 55, y: 345, w: 760, h: 140 }], spawn: { x: 425, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 355, y: 220, w: 140, h: 22 }, core: { x: 700, y: 310 }, goal: { x: 370, y: 135, w: 110, h: 68 }, fire: { x: 700, y: 190 }, allowed: sealedWater, sensors: [{ id: 'grown', target: 'stone', x: 560, y: 310, radius: 65, requires: ['grow'], label: '大きな石の台座' }, { id: 'signal', target: 'tree', x: 240, y: 300, radius: 65, requires: ['glow', 'pulse'], label: '木の共鳴盤' }], shards: [{ x: 120, y: 595 }, { x: 120, y: 295 }] })
  ];
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function circleRect(x, y, radius, rect) {
    return Math.hypot(x - clamp(x, rect.x, rect.x + rect.w), y - clamp(y, rect.y, rect.y + rect.h)) < radius;
  }
  function createGame(stageIndex = 0) {
    if (!Number.isInteger(stageIndex) || !LEVELS[stageIndex]) stageIndex = 0;
    const level = LEVELS[stageIndex];
    return {
      stageIndex, level, player: { ...level.spawn }, checkpoint: { ...level.spawn }, preferredCarryTarget: null, stone: { ...level.stone }, tree: { ...level.tree },
      rules: { water: null, stone: null, tree: null, fire: null }, core: false,
      gateHeat: 0, gateOpen: false, complete: false, elapsed: 0, damageUntil: 0,
      ruleCount: 0, notice: '', heating: false, floatOffsets: { stone: 40, tree: 40 },
      sensorCharge: Object.fromEntries(level.sensors.map(sensor => [sensor.id, 0])),
      sensorLit: Object.fromEntries(level.sensors.map(sensor => [sensor.id, false])),
      collectedShards: level.shards.map(() => false), events: []
    };
  }
  function has(game, target, effect) { return Boolean(game.rules[target]?.effects.includes(effect)); }
  function supportedEffects(game, target) {
    if (!Object.hasOwn(SUPPORTED, target)) return [];
    return [...(game.level.allowed[target] || SUPPORTED[target])];
  }
  function bridgeRiver(game, target) {
    const object = game[target];
    return has(game, target, 'float') && game.level.rivers.find(river => object.x >= river.x && object.x <= river.x + river.w && object.y >= river.y + 12 && object.y <= river.y + river.h - 12);
  }
  function isBridge(game, target) { return Boolean(bridgeRiver(game, target)); }
  function bridgeHalfWidth(game, target) { return (target === 'tree' ? 35 : 37) + (has(game, target, 'grow') ? 20 : 0); }
  function bridgeGeometry(game, target) {
    const object = game[target], halfWidth = bridgeHalfWidth(game, target);
    const length = has(game, target, 'grow') ? 174 : 102;
    return { x: object.x - halfWidth, y: object.y - length / 2, w: halfWidth * 2, h: length };
  }
  function objectGeometry(game, target) {
    const object = game[target], grown = has(game, target, 'grow');
    const scale = grown ? (target === 'stone' ? 1.8 : 1.65) : 1;
    const floatOffset = has(game, target, 'float') ? game.floatOffsets[target] : 0;
    return { x: object.x, y: object.y - floatOffset, radius: (target === 'stone' ? 20 : 34) * scale, scale, floatOffset };
  }
  function targetFloor(game, target) {
    const geometry = objectGeometry(game, target);
    // Keep the whole lifted object on screen, including a grown tree canopy.
    const topExtent = target === 'stone' ? geometry.radius : 91 * geometry.scale;
    return 115 + geometry.floatOffset + topExtent;
  }
  function fireGeometry(game) {
    return {
      x: game.level.fire.x + (has(game, 'fire', 'move') ? 52 * Math.sin(game.elapsed * 2.4) : 0),
      y: game.level.fire.y - (has(game, 'fire', 'float') ? 40 + 6 * Math.sin(game.elapsed * 2.6) : 0),
      radius: has(game, 'fire', 'grow') ? 34 : 20, extinguished: has(game, 'fire', 'freeze')
    };
  }
  function walkable(game, point) {
    const radius = 13;
    if (point.x - radius < 55 || point.x + radius > 815 || point.y - radius < 115 || point.y + radius > 660) return false;
    const walls = game.gateOpen ? game.level.walls : [...game.level.walls, game.level.gate];
    if (walls.some(wall => circleRect(point.x, point.y, radius, wall))) return false;
    for (const target of ['stone', 'tree']) {
      if (isBridge(game, target)) continue;
      const geometry = objectGeometry(game, target);
      if (target === 'stone') {
        if (distance(point, geometry) < radius + geometry.radius) return false;
      } else {
        // The trunk blocks movement; the leafy canopy can pass in front of the player.
        const height = 23 * geometry.scale;
        if (circleRect(point.x, point.y, radius, { x: geometry.x - 8, y: geometry.y - height, w: 16, h: height })) return false;
      }
    }
    for (const river of game.level.rivers) {
      if (!circleRect(point.x, point.y, radius, river)) continue;
      if (has(game, 'water', 'freeze') || has(game, 'water', 'solidify')) continue;
      const top = Math.max(point.y - radius, river.y), bottom = Math.min(point.y + radius, river.y + river.h);
      const supported = ['stone', 'tree'].some(target => {
        if (!isBridge(game, target)) return false;
        const deck = bridgeGeometry(game, target);
        return point.x - radius >= deck.x && point.x + radius <= deck.x + deck.w && top >= deck.y && bottom <= deck.y + deck.h;
      });
      if (!supported) return false;
    }
    return true;
  }
  function rulePosition(game, target) {
    if (target === 'water') { const river = game.level.rivers[0]; return { x: river.x + river.w / 2, y: river.y + river.h / 2 }; }
    if (target === 'fire') return fireGeometry(game);
    return objectGeometry(game, target);
  }
  function event(game, type, point, label, target) {
    game.events.push({ type, target, x: point.x, y: point.y, time: game.elapsed, label });
  }
  function describeRule(target, effects) {
    const name = TARGETS.find(item => item.id === target).jp + 'の' + effects.map(id => EFFECTS.find(item => item.id === id).jp).join('・');
    const descriptions = {
      water: { freeze: '水面が氷になり、川を歩けます', solidify: '水面が硬い石畳の通路になります', glow: '川全体が光を放ちます', pulse: '川から光の輪が広がります' },
      stone: { float: '石が高く浮き、E＋移動で運べます', grow: '石と橋が大きくなります', glow: '石が光り、対応する紋章を照らします', pulse: '石から周期的に光の輪が広がります' },
      tree: { float: '木が高く浮き、E＋移動で運べます', grow: '木と橋が大きくなります', glow: '木が光り、対応する紋章を照らします', pulse: '木から周期的に光の輪が広がります' },
      fire: { float: '炎が高く浮きます', move: '炎が左右へ往復します', grow: '炎の大きさと接触範囲が広がります', glow: '炎が強く光ります', freeze: '炎が消え、触れても安全です', pulse: '炎の光が明滅します', heat: '炎が赤くなり、条件を満たしたゲートを加熱できます' }
    };
    return { target, effects: [...effects], name, description: effects.map(id => descriptions[target][id]).join('。') + '。' };
  }
  function applyRule(game, target, effects) {
    if (!Object.hasOwn(SUPPORTED, target) || !Array.isArray(effects) || effects.length < 1 || effects.length > 3 || new Set(effects).size !== effects.length || effects.some(id => !supportedEffects(game, target).includes(id))) {
      return { ok: false, message: target === 'water' && game.level.allowed.water ? 'このステージでは水の凍結と固体化が封印されています。浮かせた石や木を使いましょう。' : 'この対象で使える動作を1〜3個選んでください。' };
    }
    if ((target === 'fire' && effects.includes('freeze') && effects.includes('heat')) || (target === 'water' && effects.includes('freeze') && effects.includes('solidify'))) {
      return { ok: false, message: target === 'fire' ? '凍結と加熱は同時には使えません。炎を消すか、熱くするか、どちらかを選んでください。' : '凍結と固体化は同時には使えません。氷の通路か、石畳の通路か、どちらかを選んでください。' };
    }
    if (effects.includes('heat') && !game.core) return { ok: false, message: '結晶を取ると「加熱」が使えます。' };
    const previous = game.rules[target];
    const previousObject = target === 'stone' || target === 'tree' ? { ...game[target] } : null;
    game.rules[target] = describeRule(target, effects);
    if (previousObject) game[target].y = Math.max(game[target].y, targetFloor(game, target));
    if (!walkable(game, game.player)) {
      game.rules[target] = previous;
      if (previousObject) Object.assign(game[target], previousObject);
      return { ok: false, message: '今いる場所の足場がなくなります。いったん岸や、物体から離れた場所へ移動してください。' };
    }
    game.ruleCount += 1;
    event(game, 'rule', rulePosition(game, target), game.rules[target].name, target);
    return { ok: true, rule: game.rules[target], message: '「' + game.rules[target].name + '」を適用しました。' };
  }
  function onDryLand(game, point) {
    return !game.level.rivers.some(river => circleRect(point.x, point.y, 18, river));
  }
  function safeCheckpoint(game, point, fire) {
    return onDryLand(game, point) && walkable(game, point) && (fire.extinguished || distance(point, fire) >= fire.radius + 60);
  }
  function respawnPoint(game, fire) {
    const preferred = game.checkpoint || game.level.spawn;
    if (safeCheckpoint(game, preferred, fire)) return { ...preferred };
    // A carried object may now occupy the saved point. Find another spot on
    // the same bank before considering the original starting position.
    const bank = bankOf(game, preferred);
    for (let radius = 12; radius <= 144; radius += 12) {
      for (let direction = 0; direction < 16; direction++) {
        const angle = direction * Math.PI / 8;
        const point = { x: preferred.x + Math.cos(angle) * radius, y: preferred.y + Math.sin(angle) * radius };
        if (bankOf(game, point) === bank && safeCheckpoint(game, point, fire)) return point;
      }
    }
    if (safeCheckpoint(game, game.level.spawn, fire)) return { ...game.level.spawn };
    return { ...preferred };
  }
  function recoverObject(game, target) {
    if (target !== 'stone' && target !== 'tree') return { ok: false, message: '呼び戻せるのは石と木です。' };
    if (bankOf(game) === 'river' || bankOf(game) !== bankOf(game, game.level[target])) {
      return { ok: false, message: '初期位置と同じ岸で使えます。川の上や反対側の岸からは、通路を失わないよう呼び戻せません。' };
    }
    const previous = { ...game[target] };
    Object.assign(game[target], game.level[target]);
    if (!walkable(game, game.player)) {
      Object.assign(game[target], previous);
      return { ok: false, message: '今いる足場がなくなるか、呼び戻し先に重なります。岸の空いた場所へ移動してから呼び戻してください。' };
    }
    const label = TARGETS.find(item => item.id === target).jp;
    const message = label + 'を最初の位置へ呼び戻しました。定義・結晶・点灯した仕掛けは残っています。';
    game.notice = message;
    event(game, 'rule', rulePosition(game, target), label + 'を呼び戻す', target);
    return { ok: true, message };
  }
  function tick(game, input, dt) {
    game.elapsed += dt;
    game.events = game.events.filter(item => game.elapsed - item.time < 3);
    game.heating = false;
    // A floating object must never bob into a player standing beside it.
    // Keep its previous offset whenever the proposed animation would overlap.
    for (const target of ['stone', 'tree']) {
      const previousOffset = game.floatOffsets[target];
      game.floatOffsets[target] = 40 + 4 * Math.sin(game.elapsed * 3);
      if (!walkable(game, game.player)) game.floatOffsets[target] = previousOffset;
    }
    let dx = Number(input.has('d') || input.has('arrowright')) - Number(input.has('a') || input.has('arrowleft'));
    let dy = Number(input.has('s') || input.has('arrowdown')) - Number(input.has('w') || input.has('arrowup'));
    const length = Math.hypot(dx, dy);
    if (length) { dx /= length; dy /= length; }
    if (input.has('e') && length) {
      const nearby = ['stone', 'tree'].filter(target => has(game, target, 'float') && distance(game.player, game[target]) < 115);
      nearby.sort((a, b) => Number(b === game.preferredCarryTarget) - Number(a === game.preferredCarryTarget) || distance(game.player, game[a]) - distance(game.player, game[b]));
      if (nearby.length) {
        const object = game[nearby[0]], previous = { ...object };
        object.x = clamp(object.x + dx * 180 * dt, 95, 775);
        object.y = clamp(object.y + dy * 180 * dt, targetFloor(game, nearby[0]), 630);
        if (!walkable(game, game.player)) Object.assign(object, previous);
      }
    } else if (!input.has('e')) {
      for (const target of ['stone', 'tree']) {
        const river = bridgeRiver(game, target);
        if (!river) continue;
        const previous = game[target].y;
        game[target].y = river.y + river.h / 2;
        if (!walkable(game, game.player)) game[target].y = previous;
      }
    }
    const nextX = { x: game.player.x + dx * 215 * dt, y: game.player.y };
    if (walkable(game, nextX)) game.player.x = nextX.x;
    const nextY = { x: game.player.x, y: game.player.y + dy * 215 * dt };
    if (walkable(game, nextY)) game.player.y = nextY.y;
    if (!game.core && distance(game.player, game.level.core) < 33) {
      game.core = true; game.notice = '結晶を見つけた！ 炎の「加熱」が使えるようになりました。';
      event(game, 'core', game.level.core, '加熱を解放');
    }
    game.level.shards.forEach((shard, index) => {
      if (!game.collectedShards[index] && distance(game.player, shard) < 25) {
        game.collectedShards[index] = true; game.notice = '記憶の欠片を見つけました！'; event(game, 'shard', shard, '記憶の欠片');
      }
    });
    for (const sensor of game.level.sensors) {
      if (game.sensorLit[sensor.id]) continue;
      const active = distance(game[sensor.target], sensor) <= sensor.radius && sensor.requires.every(effect => has(game, sensor.target, effect));
      game.sensorCharge[sensor.id] = active ? clamp(game.sensorCharge[sensor.id] + dt, 0, 1) : 0;
      if (game.sensorCharge[sensor.id] >= 1) {
        game.sensorLit[sensor.id] = true; game.notice = sensor.label + 'が作動しました！'; event(game, 'sensor', sensor, sensor.label + ' 点灯', sensor.target);
      }
    }
    const fire = fireGeometry(game);
    if (safeCheckpoint(game, game.player, fire)) game.checkpoint = { ...game.player };
    if (!fire.extinguished && game.elapsed >= game.damageUntil && distance(game.player, fire) < 13 + fire.radius) {
      game.player = respawnPoint(game, fire); game.damageUntil = game.elapsed + 2;
      game.notice = '炎に触れました。直前の安全な岸へ戻ります。結晶と仕掛けはそのままです。'; event(game, 'damage', fire, '安全な岸へ');
    }
    const gate = game.level.gate;
    const gatePoint = { x: gate.x + gate.w / 2, y: gate.y + gate.h / 2 };
    const sensorsReady = game.level.sensors.every(sensor => game.sensorLit[sensor.id]);
    if (game.core && sensorsReady && !game.gateOpen && has(game, 'fire', 'heat') && distance(game.player, gatePoint) < 105 && input.has('e') && !length) {
      game.heating = true; game.gateHeat = clamp(game.gateHeat + dt * 0.8, 0, 1);
      if (game.gateHeat >= 1) { game.gateOpen = true; game.heating = false; game.notice = 'ゲートが開きました！ ゴールへ進みましょう。'; event(game, 'gate', gatePoint, 'ゲート開放'); }
    }
    if (game.gateOpen && circleRect(game.player.x, game.player.y, 13, game.level.goal)) game.complete = true;
  }
  function update(game, input, dt) {
    if (game.complete || !Number.isFinite(dt) || dt <= 0) return;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0.0000001 && !game.complete) {
      const step = Math.min(remaining, 1 / 120); tick(game, input, step); remaining -= step;
    }
  }
  function objective(game) {
    if (game.complete) return 'ステージクリア！';
    if (!game.core) return '川を渡って、青い結晶を見つけよう';
    const sensor = game.level.sensors.find(item => !game.sensorLit[item.id]);
    if (sensor) return sensor.label + '：' + TARGETS.find(item => item.id === sensor.target).jp + 'を運び、' + sensor.requires.map(id => EFFECTS.find(item => item.id === id).jp).join('＋') + 'で作動させよう';
    return game.gateOpen ? '開いたゲートを通って、北のゴールへ' : '炎に「加熱」を適用し、ゲートの近くでEを長押し';
  }
  function progressSteps(game) {
    const northBank = Math.min(...game.level.rivers.map(river => river.y));
    return [
      { label: '川を渡る', detail: game.level.allowed.water ? '浮遊した物体で道を作る' : '水や物体の性質を変える', done: game.core || game.player.y < northBank },
      { label: '結晶と仕掛け', detail: game.level.sensors.length ? '紋章・台座を作動させる' : '結晶で加熱を解放する', done: game.core && game.level.sensors.every(sensor => game.sensorLit[sensor.id]) },
      { label: 'ゲートを開く', detail: '炎を加熱し、Eを長押し', done: game.gateOpen },
      { label: 'ゴールへ', detail: '欠片の収集にも挑戦', done: game.complete }
    ];
  }
  function bankOf(game, point = game.player) {
    const river = game.level.rivers[0];
    if (point.y + 13 <= river.y) return 'north';
    if (point.y - 13 >= river.y + river.h) return 'south';
    return 'river';
  }
  function crossingTarget(game) {
    const floating = ['stone', 'tree'].filter(target => has(game, target, 'float'));
    const supporting = floating.find(target => {
      const deck = bridgeGeometry(game, target);
      return isBridge(game, target) && game.player.x - 13 >= deck.x && game.player.x + 13 <= deck.x + deck.w;
    });
    if (supporting) return supporting;
    if (floating.length === 1) return floating[0];
    return game.stageIndex === 2 ? 'tree' : 'stone';
  }
  function pendingSensor(game) { return game.level.sensors.find(sensor => !game.sensorLit[sensor.id]); }
  function gatePoint(game) { const gate = game.level.gate; return { x: gate.x + gate.w / 2, y: gate.y + gate.h / 2 }; }
  function hintKey(game) {
    if (game.complete) return 'complete';
    if (game.gateOpen) return 'goal';
    if (game.core && !pendingSensor(game) && distance(game.player, gatePoint(game)) < 105) {
      return has(game, 'fire', 'heat') ? 'heat-gate' : 'define-heat';
    }
    const bank = bankOf(game);
    if (bank !== 'north') {
      const target = crossingTarget(game);
      if (!game.level.allowed.water && (has(game, 'water', 'freeze') || has(game, 'water', 'solidify'))) return 'cross-water';
      if (!has(game, target, 'float')) return 'define-' + target;
      if (bank === 'river') return 'cross-bridge';
      if (bankOf(game, game[target]) === 'north') return 'recover-' + target;
      return distance(game.player, game[target]) < 115 ? 'carry-' + target : 'approach-' + target;
    }
    if (!game.core) return 'core';
    const sensor = pendingSensor(game);
    if (sensor) {
      if (!sensor.requires.every(effect => has(game, sensor.target, effect)) || (!has(game, sensor.target, 'float') && distance(game[sensor.target], sensor) > sensor.radius)) return 'define-sensor-' + sensor.id;
      if (bankOf(game, game[sensor.target]) === 'south') return 'fetch-sensor-' + sensor.id;
      if (distance(game[sensor.target], sensor) <= sensor.radius) return 'charge-sensor-' + sensor.id;
      return 'carry-sensor-' + sensor.id;
    }
    if (!has(game, 'fire', 'heat')) return 'define-heat';
    return distance(game.player, gatePoint(game)) < 105 ? 'heat-gate' : 'approach-gate';
  }
  function hintTarget(game) {
    const key = hintKey(game), target = crossingTarget(game);
    if (key === 'complete') return null;
    if (key === 'goal') return { x: game.level.goal.x + game.level.goal.w / 2, y: game.level.goal.y + game.level.goal.h / 2, label: 'ゴール' };
    if (key === 'core') return { ...game.level.core, label: '青い結晶' };
    if (key.startsWith('fetch-sensor-')) {
      const sensor = pendingSensor(game), river = game.level.rivers[0];
      const bridge = ['stone', 'tree'].find(item => isBridge(game, item) && bridgeGeometry(game, item).h >= river.h);
      if (bridge) return { ...game[sensor.target], label: '橋で南岸へ戻って運ぶ' };
      const helper = ['stone', 'tree'].find(item => item !== sensor.target && bankOf(game, game[item]) !== 'south');
      if (helper) return { x: game[helper].x, y: river.y + river.h / 2, label: '物体を川へ戻して橋にする' };
    }
    if (key.includes('sensor')) { const sensor = pendingSensor(game); return { x: sensor.x, y: sensor.y, label: sensor.label }; }
    if (key === 'define-heat') { const gate = game.level.gate; return { x: gate.x + gate.w / 2, y: gate.y + gate.h + 50, label: '先に研究室で炎＋加熱' }; }
    if (key.endsWith('gate')) { const gate = game.level.gate; return { x: gate.x + gate.w / 2, y: gate.y + gate.h + 50, label: 'ここで止まってE長押し' }; }
    if (key === 'cross-water' || key === 'cross-bridge' || key.startsWith('carry-')) {
      const river = game.level.rivers[0];
      return { x: key === 'cross-water' ? game.player.x : game[target].x, y: river.y + river.h / 2, label: '川の中央' };
    }
    const point = key.startsWith('recover-') ? game.level[target] : game[target];
    return { ...point, label: TARGETS.find(item => item.id === target).jp };
  }
  function hints(game) {
    const key = hintKey(game), target = crossingTarget(game), targetName = TARGETS.find(item => item.id === target).jp;
    const coreDirection = game.level.core.x < game.player.x ? '左' : '右';
    const crossing = game.stageIndex === 4 ? '浮遊＋成長' : game.stageIndex === 2 ? '浮遊＋発光' : game.stageIndex === 3 ? '浮遊＋発光＋脈動' : '浮遊';
    const routeAdvice = game.stageIndex === 1 ? '結晶のある左側からは、川沿いに少し下へ回って右側のゲートへ進めます。石が邪魔なら、近くでE＋下を押し、川へ避けてEを離しましょう。' : '浮遊物体が道を塞ぐ場合は、岸でその物体を「発光」だけに切り替えると下へ降ろせます。';
    if (key === 'complete') return ['このステージはクリア済みです。', game.stageIndex < LEVELS.length - 1 ? '「次のステージへ」で先へ進めます。' : '全5ステージをクリアしました。ステージ選択から遊び直せます。', '同じステージで欠片の収集にも挑戦できます。'];
    if (key === 'goal') return ['ゲートは開いています。', 'ゲートの中央をまっすぐ上へ進みましょう。', '北側のGOALの枠へ入ればクリアです。', routeAdvice];
    if (key === 'core') return ['川はもう渡れています。次は青い結晶です。', 'この位置から北岸を' + coreDirection + 'へ進むと結晶があります。', '青いひし形へ近づくだけで回収でき、「加熱」が使えるようになります。'];
    if (key.startsWith('recover-')) return [
      targetName + 'が向こう岸にあるため、そのままでは近づけません。',
      'ヒント内の「' + targetName + 'の配置を戻す」で、いまいる出発側の岸へ戻せます。結晶や点灯した仕掛けは失われません。',
      '呼び戻した' + targetName + 'に「' + crossing + '」を適用し、近くでE＋上を押して川へ運びましょう。'
    ];
    if (key.startsWith('define-') && !key.includes('sensor') && key !== 'define-heat') return [
      game.level.allowed.water ? 'このステージの水は封印中です。物体を橋にしましょう。' : '川には通路が必要です。水や物体の定義を変えましょう。',
      game.stageIndex === 0 ? '最初は「水＋固体化」が簡単です。「凍結」でも渡れます。' : '研究室で「' + targetName + '」を選び、「' + crossing + '」を適用します。',
      '次に' + targetName + 'の近くへ歩き、Eを押しながら上へ運びます。',
      '物体の影を川の中央へ置いたらEを離し、方向キーだけで橋の中央を上へ渡りましょう。'
    ];
    if (key.startsWith('approach-') && key !== 'approach-gate') return [
      '「浮遊」は適用されています。物体を運ぶには近づく必要があります。',
      targetName + 'の影の近くまで移動してください。',
      '画面の操作案内に「E＋移動で運べます」と出たら、Eを押しながら上へ運びます。',
      '別の浮遊物体も近くにあるときは、研究室で運びたい方を選んでください。'
    ];
    if (key.startsWith('carry-') && !key.includes('sensor')) return [
      targetName + 'を運べる距離です。Eを押しながら上へ進みましょう。',
      '物体の影が川の中央に来たらEを離してください。中央の目安は川の上下の岸の中間です。',
      'Eを離すと足場が安定します。方向キーだけで足場の中央を上へ渡ります。',
      '運びすぎて物体ごと北岸へ進んでも大丈夫です。青い結晶を回収しましょう。'
    ];
    if (key === 'cross-water') return ['水の定義が通路になっています。', 'Eを押さずに上へ進めば、川を歩けます。', '川を渡ったら北岸の青い結晶へ近づきましょう。'];
    if (key === 'cross-bridge') return [
      'いま川の足場に乗っています。',
      game.stageIndex === 4 && !has(game, target, 'grow') ? '小さな足場で広い川を渡る場合は、E＋上を押し続けて物体と一緒に進みます。' : 'ここではEを離し、方向キーだけで上へ渡りましょう。',
      '足場の左右の端へ寄ると川へ進めません。中央を通って北岸へ出てください。'
    ];
    if (key.startsWith('fetch-sensor-')) {
      const sensor = pendingSensor(game), name = TARGETS.find(item => item.id === sensor.target).jp;
      return [
        '次に必要な' + name + 'は南岸にあります。橋で出発側の岸へ戻ってから運びます。',
        '北岸にあるもう一方の物体に「浮遊＋成長」を適用し、川の中央へ戻してEを離します。点灯済みの盤は消えません。',
        'その橋の中央を南へ渡り、研究室で「' + name + '」を選びます。影の近くでE＋上を押して、物体と一緒に北岸へ運びましょう。',
        sensor.label + 'の光る円へ影を入れて約1秒待ちます。必要な定義が外れないようにしてください。'
      ];
    }
    if (key.includes('sensor')) {
      const sensor = pendingSensor(game), name = TARGETS.find(item => item.id === sensor.target).jp;
      const definition = ['float', ...sensor.requires].filter((effect, index, array) => array.indexOf(effect) === index).map(id => EFFECTS.find(item => item.id === id).jp).join('＋');
      return [
        sensor.label + 'を点灯させる必要があります。盤に表示された物体と動作を使います。',
        '「' + name + '」に「' + definition + '」を適用します。',
        key.startsWith('charge-') ? '物体は範囲内です。そのまま約1秒待つと点灯します。' : name + 'へ近づき、E＋移動で光る円の中へ影を運んで約1秒待ちましょう。',
        game.stageIndex === 4 ? '一度点灯した盤は点灯したままです。次の物体が南岸にある場合は、北岸にある物体を「浮遊＋成長」で川の中央へ戻し、橋にしてから取りに戻れます。' : '一度点灯した盤は点灯したままです。物体を動かしても大丈夫なので、ゲートへ進む通路を空けましょう。'
      ];
    }
    if (key === 'define-heat') return [
      '結晶と必要な仕掛けはそろっています。次は炎の定義です。',
      '研究室で対象を「炎」、動作を「加熱」にして適用します。',
      '炎に近づく必要はありません。ゲートの南側の中央へ進みましょう。',
      'ゲートの前で方向キーを離し、Eだけを約2秒押し続けます。' + (game.stageIndex === 1 ? routeAdvice : '')
    ];
    if (key === 'approach-gate') return ['ゲートを加熱するには、もう少し近づく必要があります。', 'ゲートの下側の中央へ進んでください。', routeAdvice, '止まって方向キーを離し、Eだけを約2秒押し続けましょう。'];
    return ['ゲートを加熱できる位置です。', '方向キーを離し、Eだけを約2秒押し続けてください。', '加熱ゲージが満ちて扉が開いたら、中央をまっすぐ上へ進みましょう。', routeAdvice];
  }
  function interactionStatus(game) {
    if (game.complete) return 'ステージクリア';
    if (game.heating) return 'ゲートを加熱中です。Eを押したまま待ちましょう。';
    const nearby = ['stone', 'tree'].filter(target => has(game, target, 'float') && distance(game.player, game[target]) < 115);
    nearby.sort((a, b) => Number(b === game.preferredCarryTarget) - Number(a === game.preferredCarryTarget) || distance(game.player, game[a]) - distance(game.player, game[b]));
    if (distance(game.player, gatePoint(game)) < 105 && game.core && !pendingSensor(game) && has(game, 'fire', 'heat')) {
      return game.gateOpen ? 'ゲートは開いています。中央を上へ進みましょう。' : 'ここで止まり、Eだけを長押しするとゲートが開きます。';
    }
    if (nearby.length) return TARGETS.find(item => item.id === nearby[0]).jp + '：E＋移動で運べます。Eを離すと置けます。';
    if (distance(game.player, gatePoint(game)) < 105) {
      if (game.gateOpen) return 'ゲートは開いています。中央を上へ進みましょう。';
      if (!game.core) return 'ゲートには青い結晶が必要です。';
      const sensor = pendingSensor(game);
      if (sensor) return 'ゲートは「' + sensor.label + '」の点灯を待っています。';
      if (!has(game, 'fire', 'heat')) return '炎に「加熱」を適用してください。炎へ近づく必要はありません。';
      return 'ここで止まり、Eだけを長押しするとゲートが開きます。';
    }
    return '移動はWASD・矢印キー。運ぶときは浮遊した物体の影へ近づきましょう。';
  }
  const api = { TARGETS, EFFECTS, SUPPORTED, LEVELS, createGame, has, supportedEffects, isBridge, bridgeHalfWidth, bridgeGeometry, objectGeometry, fireGeometry, walkable, applyRule, update, objective, progressSteps, hints, hintKey, hintTarget, interactionStatus, recoverObject, bankOf, distance, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinition = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
