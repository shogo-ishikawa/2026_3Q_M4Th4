/* WORLD DEFINITION: data, rules and movement, independent of browser drawing. */
'use strict';
(function (root) {
  const Mystery = typeof module !== 'undefined' && module.exports ? require('./mystery.js') : root.WorldDefinitionMystery;
  const TARGETS = [
    { id: 'water', jp: '水', symbol: '◈' }, { id: 'stone', jp: '石', symbol: '⬡' },
    { id: 'tree', jp: '木', symbol: '♧' }, { id: 'fire', jp: '炎', symbol: '♨' }
  ];
  const EFFECTS = [
    { id: 'float', jp: '浮遊', detail: '石・木が高く浮き、E＋移動で運べます。川に置くと橋になり、北岸へも運べます。炎は上空へ浮きます。' },
    { id: 'move', jp: '移動', detail: '炎が軌跡を残しながら左右へ往復します。光の経路と実際に触れる位置を確かめましょう。' },
    { id: 'grow', jp: '成長', detail: '石・木が大きくなり、浮遊した橋の幅と長さが伸びます。大きさを調べる台座にも使えます。炎も大きくなります。' },
    { id: 'shrink', jp: '縮小', detail: '石・木と足場を小さくします。応用ステージでは狭い搬入口を通せます。成長とは同時に使えません。' },
    { id: 'rotate', jp: '回転', detail: '浮遊した石・木の足場を横向きにします。縦に流れる水路を渡る橋に使えます。' },
    { id: 'glow', jp: '発光', detail: '対象が明るく光ります。「光の紋章」は、指定された物体を近くで発光させると反応します。' },
    { id: 'freeze', jp: '凍結', detail: '水は氷の通路になります。炎は消火されて安全になります。水の封印があるステージでは使えません。' },
    { id: 'solidify', jp: '固体化', detail: '川を石畳のような硬い通路に変えます。水の封印があるステージでは使えません。' },
    { id: 'pulse', jp: '脈動', detail: '光が明滅し、輪が周期的に広がります。発光と組み合わせると「共鳴盤」を作動させられます。' },
    { id: 'heat', jp: '加熱', detail: '結晶を取ると解放されます。炎に適用し、仕掛けを作動させた後でゲート近くでEを長押しします。' }
  ];
  const SUPPORTED = {
    water: ['freeze', 'solidify', 'glow', 'pulse'],
    stone: ['float', 'grow', 'shrink', 'rotate', 'glow', 'pulse'], tree: ['float', 'grow', 'shrink', 'rotate', 'glow', 'pulse'],
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
        { x: gate.x + gate.w, y: gate.y, w: 815 - gate.x - gate.w, h: gate.h },
        ...(data.obstacles || [])
      ]
    };
  }
  const LEVELS = [
    stage({ id: 'first-rules', name: '封印されたゴール', subtitle: '水を変える。物体を浮かせる。まずは自由に試そう。', theme: 'meadow', gate: { x: 355, y: 270, w: 140, h: 22 }, shards: [{ x: 120, y: 560 }, { x: 750, y: 320 }] }),
    stage({ id: 'stone-crossing', name: '石の渡し場', subtitle: '水の定義は封印中。浮かせた物体で道を作ろう。', theme: 'quarry', rivers: [{ x: 55, y: 390, w: 760, h: 80 }], spawn: { x: 650, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 625, y: 250, w: 120, h: 22 }, fire: { x: 520, y: 195 }, core: { x: 160, y: 320 }, goal: { x: 630, y: 150, w: 110, h: 68 }, allowed: sealedWater, shards: [{ x: 125, y: 585 }, { x: 440, y: 320 }] }),
    stage({ id: 'light-garden', name: '光を運ぶ庭', subtitle: '浮かせた木を北岸へ運び、光の紋章を照らそう。', theme: 'night', rivers: [{ x: 55, y: 390, w: 760, h: 80 }], spawn: { x: 425, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 355, y: 250, w: 140, h: 22 }, core: { x: 700, y: 330 }, goal: { x: 370, y: 145, w: 110, h: 68 }, allowed: sealedWater, sensors: [{ id: 'light', target: 'tree', x: 245, y: 330, radius: 70, requires: ['glow'], label: '木の光の紋章' }], shards: [{ x: 125, y: 595 }, { x: 545, y: 335 }] }),
    stage({ id: 'resonance-hall', name: '脈動の回廊', subtitle: '石を発光・脈動させ、北岸の共鳴盤へ運ぼう。', theme: 'resonance', gate: { x: 355, y: 250, w: 140, h: 22 }, goal: { x: 370, y: 145, w: 110, h: 68 }, allowed: sealedWater, sensors: [{ id: 'resonance', target: 'stone', x: 280, y: 320, radius: 70, requires: ['glow', 'pulse'], label: '石の共鳴盤' }], shards: [{ x: 120, y: 565 }, { x: 745, y: 320 }] }),
    stage({ id: 'final-definition', name: '最後の定義', subtitle: '広い川と二つの台座。物体ごとに役割を分けよう。', theme: 'ruins', rivers: [{ x: 55, y: 345, w: 760, h: 140 }], spawn: { x: 425, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 355, y: 220, w: 140, h: 22 }, core: { x: 700, y: 310 }, goal: { x: 370, y: 135, w: 110, h: 68 }, fire: { x: 700, y: 190 }, allowed: sealedWater, sensors: [{ id: 'grown', target: 'stone', x: 560, y: 310, radius: 65, requires: ['grow'], label: '大きな石の台座' }, { id: 'signal', target: 'tree', x: 240, y: 300, radius: 65, requires: ['glow', 'pulse'], label: '木の共鳴盤' }], shards: [{ x: 120, y: 595 }, { x: 120, y: 295 }] }),
    stage({ id: 'small-door', name: '小さな入口、大きな足場', subtitle: '縮小して入口を通り、広い場所で成長させよう。', theme: 'quarry', advanced: true, gateMode: 'sensors', spawn: { x: 650, y: 610 }, stone: { x: 650, y: 560 }, tree: { x: 200, y: 560 }, gate: { x: 625, y: 220, w: 120, h: 22 }, goal: { x: 630, y: 135, w: 110, h: 68 }, fire: { x: 520, y: 170 }, core: { x: 160, y: 300 }, allowed: sealedWater, obstacles: [{ x: 55, y: 490, w: 578, h: 20 }, { x: 667, y: 490, w: 148, h: 20 }], sensors: [{ id: 'large', target: 'stone', x: 650, y: 310, radius: 90, requires: ['grow'], label: '大きな石の盤' }], shards: [{ x: 125, y: 600 }, { x: 430, y: 310 }], parRules: 2 }),
    stage({ id: 'turning-bridge', name: '向きを変える橋', subtitle: '縦の水路には横の橋。足場の向きを変えよう。', theme: 'night', advanced: true, gateMode: 'sensors', rivers: [{ x: 395, y: 242, w: 80, h: 418 }], spawn: { x: 190, y: 550 }, stone: { x: 650, y: 560 }, tree: { x: 240, y: 550 }, gate: { x: 625, y: 220, w: 120, h: 22 }, goal: { x: 630, y: 135, w: 110, h: 68 }, fire: { x: 520, y: 170 }, core: { x: 700, y: 300 }, allowed: sealedWater, sensors: [{ id: 'turned-light', target: 'tree', x: 650, y: 330, radius: 65, requires: ['rotate', 'glow'], label: '横向きの木の光盤' }], shards: [{ x: 125, y: 315 }, { x: 745, y: 595 }], parRules: 1 }),
    stage({ id: 'two-lights', name: '二つの灯を同時に', subtitle: '二つの盤は置いている間だけ点灯。同時に光を届けよう。', theme: 'resonance', advanced: true, gateMode: 'sensors', rivers: [{ x: 55, y: 450, w: 100, h: 60 }], spawn: { x: 425, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 355, y: 220, w: 140, h: 22 }, goal: { x: 370, y: 135, w: 110, h: 68 }, fire: { x: 700, y: 170 }, core: { x: 425, y: 310 }, allowed: sealedWater, sensors: [{ id: 'held-stone', target: 'stone', x: 280, y: 340, radius: 60, requires: ['grow', 'glow'], label: '石の維持盤', mode: 'hold' }, { id: 'held-tree', target: 'tree', x: 580, y: 340, radius: 60, requires: ['glow', 'pulse'], label: '木の維持盤', mode: 'hold' }], shards: [{ x: 180, y: 590 }, { x: 745, y: 320 }], parRules: 2 }),
    stage({ id: 'material-rhythm', name: '材質とリズム', subtitle: '氷と石畳を使い分け、最後は脈動で充電しよう。', theme: 'ruins', advanced: true, gateMode: 'sensors', rivers: [{ x: 55, y: 410, w: 760, h: 80 }], spawn: { x: 425, y: 600 }, stone: { x: 650, y: 550 }, tree: { x: 240, y: 550 }, gate: { x: 355, y: 220, w: 140, h: 22 }, goal: { x: 370, y: 135, w: 110, h: 68 }, fire: { x: 700, y: 170 }, core: { x: 160, y: 320 }, sensors: [{ id: 'ice-record', target: 'water', x: 230, y: 450, radius: 60, requires: ['freeze'], label: '氷の記録盤' }, { id: 'solid-record', target: 'water', x: 650, y: 450, radius: 60, requires: ['solidify'], label: '石畳の記録盤' }, { id: 'rhythm', target: 'stone', x: 290, y: 320, radius: 65, requires: ['glow', 'pulse'], label: 'リズムの共鳴盤', pulsed: true }], shards: [{ x: 125, y: 595 }, { x: 745, y: 320 }], parRules: 4 })
  ].concat(Mystery.LEVELS);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function circleRect(x, y, radius, rect) {
    return Math.hypot(x - clamp(x, rect.x, rect.x + rect.w), y - clamp(y, rect.y, rect.y + rect.h)) < radius;
  }
  function createGame(stageIndex = 0) {
    if (!Number.isInteger(stageIndex) || !LEVELS[stageIndex]) stageIndex = 0;
    const level = LEVELS[stageIndex];
    const game = {
      stageIndex, level, player: { ...level.spawn }, checkpoint: { ...level.spawn }, preferredCarryTarget: null, stone: { ...level.stone }, tree: { ...level.tree },
      rules: { water: null, stone: null, tree: null, fire: null }, core: false,
      gateHeat: 0, gateOpen: false, complete: false, elapsed: 0, damageUntil: 0,
      ruleCount: 0, notice: '', heating: false, floatOffsets: { stone: 40, tree: 40 },
      sensorCharge: Object.fromEntries(level.sensors.map(sensor => [sensor.id, 0])),
      sensorLit: Object.fromEntries(level.sensors.map(sensor => [sensor.id, false])),
      collectedShards: level.shards.map(() => false), events: []
    };
    if (level.mystery) game.puzzle = Mystery.createState(level);
    return game;
  }
  function worldBounds(game) { return game.level.bounds || { x: 55, y: 115, w: 760, h: 545 }; }
  function physicalState(game) {
    return game.level.mystery ? Mystery.physicalState(game) : {
      walls: game.gateOpen ? game.level.walls : [...game.level.walls, game.level.gate], rivers: game.level.rivers
    };
  }
  function puzzleStatus(game) { return game.level.mystery ? Mystery.status(game) : []; }
  function notebook(game) { return game.level.mystery ? Mystery.notebook(game) : []; }
  function validPuzzleState(game) { return !game.level.mystery || Mystery.validateState(game) && game.gateOpen === game.puzzle.exitOpen; }
  function nearbyInteraction(game) { return game.level.mystery ? (Mystery.nearbyInteraction || Mystery.nearestInteraction)(game) : null; }
  function has(game, target, effect) { return Boolean(game.rules[target]?.effects.includes(effect)); }
  function supportedEffects(game, target) {
    if (!Object.hasOwn(SUPPORTED, target)) return [];
    return [...(game.level.allowed[target] || SUPPORTED[target])];
  }
  function bridgeRiver(game, target) {
    const object = game[target];
    return has(game, target, 'float') && physicalState(game).rivers.find(river => river.h > river.w
      ? object.x >= river.x + 12 && object.x <= river.x + river.w - 12 && object.y >= river.y && object.y <= river.y + river.h
      : object.x >= river.x && object.x <= river.x + river.w && object.y >= river.y + 12 && object.y <= river.y + river.h - 12);
  }
  function isBridge(game, target) { return Boolean(bridgeRiver(game, target)); }
  function bridgeHalfWidth(game, target) { return ((target === 'tree' ? 35 : 37) + (has(game, target, 'grow') ? 20 : 0)) * (has(game, target, 'shrink') ? .55 : 1); }
  function bridgeGeometry(game, target) {
    const object = game[target], halfWidth = bridgeHalfWidth(game, target);
    const length = (has(game, target, 'grow') ? 174 : 102) * (has(game, target, 'shrink') ? .55 : 1);
    const w = has(game, target, 'rotate') ? length : halfWidth * 2, h = has(game, target, 'rotate') ? halfWidth * 2 : length;
    return { x: object.x - w / 2, y: object.y - h / 2, w, h };
  }
  function objectGeometry(game, target) {
    const object = game[target], grown = has(game, target, 'grow');
    const scale = has(game, target, 'shrink') ? .55 : grown ? (target === 'stone' ? 1.8 : 1.65) : 1;
    const floatOffset = has(game, target, 'float') ? game.floatOffsets[target] : 0;
    return { x: object.x, y: object.y - floatOffset, radius: (target === 'stone' ? 20 : 34) * scale, scale, floatOffset };
  }
  function targetFloor(game, target) {
    const geometry = objectGeometry(game, target);
    // Keep the whole lifted object on screen, including a grown tree canopy.
    const topExtent = target === 'stone' ? geometry.radius : 91 * geometry.scale;
    return worldBounds(game).y + geometry.floatOffset + topExtent;
  }
  function fireGeometry(game) {
    const mysteryFire = game.level.mystery ? physicalState(game).fire : null;
    if (mysteryFire === false) return { ...game.level.fire, radius: 0, extinguished: true };
    if (mysteryFire) return mysteryFire;
    return {
      x: game.level.fire.x + (has(game, 'fire', 'move') ? 52 * Math.sin(game.elapsed * 2.4) : 0),
      y: game.level.fire.y - (has(game, 'fire', 'float') ? 40 + 6 * Math.sin(game.elapsed * 2.6) : 0),
      radius: has(game, 'fire', 'grow') ? 34 : 20, extinguished: has(game, 'fire', 'freeze')
    };
  }
  function walkable(game, point) {
    const radius = 13;
    const bounds = worldBounds(game);
    if (point.x - radius < bounds.x || point.x + radius > bounds.x + bounds.w || point.y - radius < bounds.y || point.y + radius > bounds.y + bounds.h) return false;
    const walls = physicalState(game).walls;
    if (walls.some(wall => circleRect(point.x, point.y, radius, wall))) return false;
    for (const target of ['stone', 'tree']) {
      if (isBridge(game, target)) continue;
      const geometry = objectGeometry(game, target);
      if (target === 'stone') {
        if (distance(point, geometry) < radius + geometry.radius) return false;
      } else {
        // The trunk blocks movement; the leafy canopy can pass in front of the player.
        const height = 23 * geometry.scale;
        if (circleRect(point.x, point.y, radius, { x: geometry.x - 8 * geometry.scale, y: geometry.y - height, w: 16 * geometry.scale, h: height })) return false;
      }
    }
    for (const river of physicalState(game).rivers) {
      if (!circleRect(point.x, point.y, radius, river)) continue;
      if (has(game, 'water', 'freeze') || has(game, 'water', 'solidify')) continue;
      const left = Math.max(point.x - radius, river.x), right = Math.min(point.x + radius, river.x + river.w);
      const top = Math.max(point.y - radius, river.y), bottom = Math.min(point.y + radius, river.y + river.h);
      const supported = ['stone', 'tree'].some(target => {
        if (!isBridge(game, target)) return false;
        const deck = bridgeGeometry(game, target);
        return left >= deck.x && right <= deck.x + deck.w && top >= deck.y && bottom <= deck.y + deck.h;
      });
      if (!supported) return false;
    }
    return true;
  }
  function objectPositionValid(game, target) {
    if ((!game.level.advanced && !game.level.mystery) || (target !== 'stone' && target !== 'tree')) return true;
    const point = game[target], geometry = objectGeometry(game, target);
    const radius = target === 'stone' ? geometry.radius : 34 * geometry.scale;
    const bounds = worldBounds(game);
    if (point.x - radius < bounds.x || point.x + radius > bounds.x + bounds.w || point.y - radius < bounds.y || point.y + radius > bounds.y + bounds.h) return false;
    const walls = physicalState(game).walls;
    if (walls.some(wall => circleRect(point.x, point.y, radius, wall))) return false;
    if (isBridge(game, target)) {
      // Only the part of a deck over water is a physical support. Its bank
      // approach may extend across scenery, where the normal wall still blocks walking.
      const deck = bridgeGeometry(game, target), river = bridgeRiver(game, target);
      const support = { x: Math.max(deck.x, river.x), y: Math.max(deck.y, river.y), right: Math.min(deck.x + deck.w, river.x + river.w), bottom: Math.min(deck.y + deck.h, river.y + river.h) };
      if (walls.some(wall => support.x < wall.x + wall.w && support.right > wall.x && support.y < wall.y + wall.h && support.bottom > wall.y)) return false;
    }
    return true;
  }
  function rulePosition(game, target) {
    if (target === 'water') { const river = game.level.rivers[0]; return river ? { x: river.x + river.w / 2, y: river.y + river.h / 2 } : { ...game.player }; }
    if (target === 'fire') return fireGeometry(game);
    return objectGeometry(game, target);
  }
  function event(game, type, point, label, target) {
    game.events.push({ type, target, x: point.x, y: point.y, time: game.elapsed, label });
  }
  function describeRule(target, effects, game) {
    const name = TARGETS.find(item => item.id === target).jp + 'の' + effects.map(id => EFFECTS.find(item => item.id === id).jp).join('・');
    const descriptions = {
      water: { freeze: '水面が氷になり、川を歩けます', solidify: '水面が硬い石畳の通路になります', glow: '川全体が光を放ちます', pulse: '川から光の輪が広がります' },
      stone: { float: '石が高く浮き、E＋移動で運べます', grow: '石と橋が大きくなります', shrink: '石と橋が小さくなり、細い搬入口を通せます', rotate: '石の足場が横向きになります', glow: '石が光り、対応する紋章を照らします', pulse: '石から周期的に光の輪が広がります' },
      tree: { float: '木が高く浮き、E＋移動で運べます', grow: '木と橋が大きくなります', shrink: '木と橋が小さくなります', rotate: '木の足場が横向きになります', glow: '木が光り、対応する紋章を照らします', pulse: '木から周期的に光の輪が広がります' },
      fire: { float: '炎が高く浮きます', move: '炎が左右へ往復します', grow: '炎の大きさと接触範囲が広がります', glow: '炎が強く光ります', freeze: '炎が消え、触れても安全です', pulse: '炎の光が明滅します', heat: '炎が赤くなり、条件を満たしたゲートを加熱できます' }
    };
    if (game?.level.mystery) {
      descriptions.water.freeze = '水面は渡れますが、流れは止まり水車も動きません';
      descriptions.water.solidify = game.level.id === 'mystery-source-maze' ? '導水口が堰となり、下流の水位が下がって川床が現れます' : '水が固い通路になり、流れは止まります';
      if (game.level.id === 'mystery-weight') {
        descriptions.stone.float = '石を運べますが、浮遊中は重さの床を押せません';
        descriptions.tree.grow = '根が伸び、つながる水門の格子を持ち上げます';
      }
      if (['mystery-shadow-library', 'mystery-source-maze'].includes(game.level.id)) descriptions.tree.glow = '近くの隠れた文字を照らしますが、光を嫌う扉は閉じます';
    }
    return { target, effects: [...effects], name, description: effects.map(id => descriptions[target][id]).join('。') + '。' };
  }
  function applyRule(game, target, effects) {
    if (!Object.hasOwn(SUPPORTED, target) || !Array.isArray(effects) || effects.length < 1 || effects.length > 3 || new Set(effects).size !== effects.length || effects.some(id => !supportedEffects(game, target).includes(id))) {
      return { ok: false, message: target === 'water' && game.level.allowed.water ? 'このステージでは水の凍結と固体化が封印されています。浮かせた石や木を使いましょう。' : 'この対象で使える動作を1〜3個選んでください。' };
    }
    if ((target === 'fire' && effects.includes('freeze') && effects.includes('heat')) || (target === 'water' && effects.includes('freeze') && effects.includes('solidify'))) {
      return { ok: false, message: target === 'fire' ? '凍結と加熱は同時には使えません。炎を消すか、熱くするか、どちらかを選んでください。' : '凍結と固体化は同時には使えません。氷の通路か、石畳の通路か、どちらかを選んでください。' };
    }
    if (effects.includes('grow') && effects.includes('shrink')) return { ok: false, message: '成長と縮小は同時には使えません。大きくするか、小さくするかを選んでください。' };
    if (effects.includes('heat') && !game.core) return { ok: false, message: '結晶を取ると「加熱」が使えます。' };
    const previous = game.rules[target];
    const previousObject = target === 'stone' || target === 'tree' ? { ...game[target] } : null;
    game.rules[target] = describeRule(target, effects, game);
    if (previousObject) game[target].y = Math.max(game[target].y, targetFloor(game, target));
    if (!walkable(game, game.player) || (game.level.mystery ? !['stone', 'tree'].every(item => objectPositionValid(game, item)) : previousObject && !objectPositionValid(game, target))) {
      game.rules[target] = previous;
      if (previousObject) Object.assign(game[target], previousObject);
      return { ok: false, message: '今いる足場がなくなるか、変更後の物体が壁に重なります。岸の空いた場所で変更してください。' };
    }
    game.ruleCount += 1;
    if (game.level.mystery) refreshCheckpoint(game);
    event(game, 'rule', rulePosition(game, target), game.rules[target].name, target);
    return { ok: true, rule: game.rules[target], message: '「' + game.rules[target].name + '」を適用しました。' };
  }
  function clearRule(game, target) {
    if (!Object.hasOwn(SUPPORTED, target)) return { ok: false, message: '解除する物体を選んでください。' };
    const previous = game.rules[target];
    if (!previous) return { ok: false, message: 'この物体には定義がありません。' };
    game.rules[target] = null;
    if (!walkable(game, game.player) || !['stone', 'tree'].every(item => objectPositionValid(game, item))) {
      game.rules[target] = previous;
      return { ok: false, message: '定義を解除すると今いる足場がなくなるか、物体や扉が重なります。安全な岸や広場へ移動してから解除してください。' };
    }
    game.ruleCount += 1;
    if (game.level.mystery) refreshCheckpoint(game);
    const label = TARGETS.find(item => item.id === target).jp;
    event(game, 'rule', rulePosition(game, target), label + 'の定義を解除', target);
    const consequence = game.level.mystery && target === 'water' ? '水が液体へ戻り、開いた水路へ流れます。' : game.level.mystery && target === 'stone' ? '地面へ下り、もとの重さへ戻ります。' : 'もとの性質へ戻ります。';
    return { ok: true, message: label + 'の定義を解除しました。' + consequence };
  }
  function onDryLand(game, point) {
    return !physicalState(game).rivers.some(river => circleRect(point.x, point.y, 18, river));
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
    if (!walkable(game, game.player) || !objectPositionValid(game, target)) {
      Object.assign(game[target], previous);
      return { ok: false, message: '今いる足場がなくなるか、呼び戻す物体がプレイヤーや壁に重なります。定義や位置を確認してから呼び戻してください。' };
    }
    const label = TARGETS.find(item => item.id === target).jp;
    const message = label + 'を最初の位置へ呼び戻しました。定義・結晶・記録型の盤は残ります。維持盤は配置に応じて消灯します。';
    game.notice = message;
    event(game, 'rule', rulePosition(game, target), label + 'を呼び戻す', target);
    return { ok: true, message };
  }
  function refreshCheckpoint(game) {
    const fire = fireGeometry(game);
    if (safeCheckpoint(game, game.player, fire)) { game.checkpoint = { ...game.player }; return; }
    if (!game.level.mystery || safeCheckpoint(game, game.checkpoint, fire)) return;
    // A drained riverbed may flood again after a definition or valve changes.
    // Keep the saved recovery point on a currently safe dry spot.
    for (let radius = 24; radius <= 264; radius += 24) {
      for (let direction = 0; direction < 16; direction++) {
        const angle = direction * Math.PI / 8;
        const point = { x: game.player.x + Math.cos(angle) * radius, y: game.player.y + Math.sin(angle) * radius };
        if (safeCheckpoint(game, point, fire)) { game.checkpoint = point; return; }
      }
    }
    if (safeCheckpoint(game, game.level.spawn, fire)) game.checkpoint = { ...game.level.spawn };
  }
  function updateSafety(game) {
    const fire = fireGeometry(game);
    refreshCheckpoint(game);
    if (!fire.extinguished && game.elapsed >= game.damageUntil && distance(game.player, fire) < 13 + fire.radius) {
      game.player = respawnPoint(game, fire); game.damageUntil = game.elapsed + 2;
      game.notice = game.level.mystery ? '炎に触れました。直前の安全な場所へ戻ります。回収した手掛かりはそのままです。' : '炎に触れました。直前の安全な岸へ戻ります。結晶と仕掛けはそのままです。';
      event(game, 'damage', fire, '安全な場所へ');
    }
  }
  function pulseHigh(game) { return Math.sin(game.elapsed * 3) > .45; }
  function sensorActive(game, sensor) {
    const point = sensor.target === 'water' ? game.player : game[sensor.target];
    return distance(point, sensor) <= sensor.radius && sensor.requires.every(effect => has(game, sensor.target, effect));
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
        const bounds = worldBounds(game);
        object.x = clamp(object.x + dx * 180 * dt, bounds.x + 40, bounds.x + bounds.w - 40);
        object.y = clamp(object.y + dy * 180 * dt, targetFloor(game, nearby[0]), bounds.y + bounds.h - 30);
        if (!walkable(game, game.player) || !objectPositionValid(game, nearby[0])) Object.assign(object, previous);
      }
    } else if (!input.has('e')) {
      for (const target of ['stone', 'tree']) {
        const river = bridgeRiver(game, target);
        if (!river) continue;
        const previous = { ...game[target] };
        if (river.h > river.w) game[target].x = river.x + river.w / 2;
        else game[target].y = river.y + river.h / 2;
        if (!walkable(game, game.player) || !objectPositionValid(game, target)) Object.assign(game[target], previous);
      }
    }
    const nextX = { x: game.player.x + dx * 215 * dt, y: game.player.y };
    if (walkable(game, nextX)) game.player.x = nextX.x;
    const nextY = { x: game.player.x, y: game.player.y + dy * 215 * dt };
    if (walkable(game, nextY)) game.player.y = nextY.y;
    if (!game.core && distance(game.player, game.level.core) < 33) {
      game.core = true; game.notice = game.level.mystery ? '封印の鍵を見つけました。仕掛けを解き、出口への道を開きましょう。' : game.level.gateMode === 'sensors' ? '結晶を見つけた！ 必要な盤をそろえるとゲートが自動で開きます。' : '結晶を見つけた！ 炎の「加熱」が使えるようになりました。';
      event(game, 'core', game.level.core, game.level.mystery ? '封印の鍵を回収' : game.level.gateMode === 'sensors' ? '結晶を回収' : '加熱を解放');
    }
    game.level.shards.forEach((shard, index) => {
      if (!game.collectedShards[index] && distance(game.player, shard) < 25) {
        game.collectedShards[index] = true; game.notice = '記憶の欠片を見つけました！'; event(game, 'shard', shard, '記憶の欠片');
      }
    });
    if (game.level.mystery) {
      Mystery.tick(game, input, dt);
      game.gateOpen = Boolean(game.puzzle.exitOpen);
      updateSafety(game);
    } else {
      for (const sensor of game.level.sensors) {
        if (game.sensorLit[sensor.id] && sensor.mode !== 'hold') continue;
        const active = sensorActive(game, sensor);
        const wasLit = game.sensorLit[sensor.id];
        if (!active) game.sensorCharge[sensor.id] = 0;
        else if (!sensor.pulsed || pulseHigh(game)) game.sensorCharge[sensor.id] = clamp(game.sensorCharge[sensor.id] + dt, 0, 1);
        game.sensorLit[sensor.id] = game.sensorCharge[sensor.id] >= 1;
        if (!wasLit && game.sensorLit[sensor.id]) {
          game.notice = sensor.label + 'が作動しました！'; event(game, 'sensor', sensor, sensor.label + ' 点灯', sensor.target);
        }
      }
      updateSafety(game);
      const gate = game.level.gate;
      const gatePoint = { x: gate.x + gate.w / 2, y: gate.y + gate.h / 2 };
      const sensorsReady = game.level.sensors.every(sensor => game.sensorLit[sensor.id]);
      if (game.level.gateMode === 'sensors' && game.core && sensorsReady && !game.gateOpen) {
        game.gateOpen = true; game.gateHeat = 1; game.notice = 'すべての仕掛けがそろい、ゲートが開きました！'; event(game, 'gate', gatePoint, 'ゲート開放');
      }
      if (game.level.gateMode !== 'sensors' && game.core && sensorsReady && !game.gateOpen && has(game, 'fire', 'heat') && distance(game.player, gatePoint) < 105 && input.has('e') && !length) {
        game.heating = true; game.gateHeat = clamp(game.gateHeat + dt * 0.8, 0, 1);
        if (game.gateHeat >= 1) { game.gateOpen = true; game.heating = false; game.notice = 'ゲートが開きました！ ゴールへ進みましょう。'; event(game, 'gate', gatePoint, 'ゲート開放'); }
      }
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
  function hintPoint(x, y, label) { return { x, y, label }; }
  function hintResult(key, title, lines, target) { return { key, title, lines, target }; }
  function smallDoorHint(game) {
    const point = hintPoint, result = hintResult;
    if (game.stone.y > 460) return result('small-entry', '石を縮小して、柵の入口を通そう', [
      '柵の細い入口は、普通の大きさの石では通れません。',
      '石に「浮遊＋縮小」を適用し、研究室でも石を選びます。',
      '右下の石の南側へ近づき、E＋上で入口の中央を通します。入口は石の真上です。',
      '石の影が柵より十分上に出たところでEを離します。目印の広い場所まで運べば、次に大きくできます。'
    ], point(650, 450, '入口の上の広場'));
    if (!has(game, 'stone', 'float') || !has(game, 'stone', 'grow')) return result('enlarge', '広い場所で石を成長させよう', [
      '入口を通せました。縮小したままでは大きな石の盤を作動させられません。',
      '石が柵から離れた広場にあることを確認します。',
      '石の「縮小」を外し、「浮遊＋成長」を適用します。',
      '変更を拒否された場合は、石を柵から少し上へ運ぶか、プレイヤーを横へ離してから適用してください。'
    ], point(game.stone.x, game.stone.y, '石を大きくする場所'));
    if (!game.sensorLit.large) return result('large-bridge', '大きな石を川の中央へ置こう', [
      '成長した石は長い足場になります。大きな石の盤も、その石を調べます。',
      '石の影を川の中央へ運びます。川は柵の上にあります。',
      '石が川の中央へ来たらEを離し、約1秒待ちます。',
      '盤の点灯を確認したら、Eを押さずに足場の中央を上へ渡りましょう。'
    ], point(650, 390, '大きな石の橋'));
    if (!game.core) return result('left-crystal', '橋を渡り、左の結晶へ', [
      '大きな石の盤は作動済みです。石は橋に残せます。',
      'Eを離し、足場の中央を上へ渡って岸へ出ます。',
      '川の上側の岸を左へ進み、青い結晶へ近づいてください。',
      'この面は加熱不要です。結晶を取ると右上の門が自動で開きます。'
    ], { ...game.level.core, label: '青い結晶' });
    return null;
  }
  function turningBridgeHint(game) {
    const point = hintPoint, result = hintResult;
    if (bankOf(game) !== 'east') return result('turn-crossing', '横向きの橋で、右の岸へ渡ろう', [
      'この水路は縦に流れています。足場の長い向きも横へ変えます。',
      '木に「浮遊＋回転＋発光」を適用します。発光は渡った後の盤に使います。',
      '木の左側へ近づき、E＋右で水路の中央へ運びます。影が水路中央に来たらEを離します。',
      '方向キーだけで横の足場を右へ渡ります。回転を外すと足場が縦になり、この水路をまたげません。'
    ], point(435, game.tree.y, '横向きの木の橋'));
    if (!game.sensorLit['turned-light']) return result('turned-light', '木の光を右上の盤へ運ぼう', [
      '水路を渡れました。次は木の光盤です。',
      '木は「浮遊＋回転＋発光」のままにします。研究室でも木を選んでください。',
      '右の岸からE＋右で木を水路から引き上げ、右側の広場へ運びます。その後、E＋上で光る円へ近づけます。',
      '木の影を盤の円に入れて約1秒待ちます。影の目安は円の少し下でも大丈夫です。'
    ], point(650, 360, '木の光盤へ'));
    if (!game.core) return result('right-crystal', '右上の青い結晶を回収しよう', [
      '木の光盤は作動しました。点灯後は木を動かしても消えません。',
      '木の下側へ少し戻ってから、右へ回り、右上の青い結晶へ近づきます。目安は川の中ほどの高さから右端の岸へ回る経路です。',
      '結晶を取ると右上の門が自動で開きます。炎の加熱は不要です。'
    ], { ...game.level.core, label: '青い結晶' });
    return null;
  }
  function twoLightsHint(game) {
    const point = hintPoint, result = hintResult;
    const sensor = game.level.sensors.find(item => !game.sensorLit[item.id]);
    if (sensor) {
      const isStone = sensor.target === 'stone', name = isStone ? '石' : '木';
      return result('hold-' + sensor.id, name + 'を置き、二つの盤を同時に光らせよう', [
        'この面の維持盤は、物体を置いて必要な定義を保つ間だけ点灯します。',
        isStone ? '石に「浮遊＋成長＋発光」を適用します。' : '木に「浮遊＋発光＋脈動」を適用します。石の定義はそのまま残します。',
        name + 'に近づき、下の広場を盤の横位置まで運んでから上へ運びます。影を光る円へ入れて約1秒待ちましょう。',
        '先に置いた物体を動かさず、もう一方も盤へ届けます。二つが同時に点灯し、結晶を取れば開門します。開いた門は閉じません。'
      ], point(sensor.x, sensor.y + 25, name + 'の維持盤'));
    }
    if (!game.core) return result('middle-crystal', '二つの灯を保ち、中央の結晶へ', [
      '二つの維持盤が同時に点灯しています。',
      '石と木はそのままにし、方向キーだけで中央の青い結晶へ進みます。',
      '結晶を取れば門が自動で開きます。開門後は盤を離しても門は閉じません。'
    ], { ...game.level.core, label: '青い結晶' });
    return null;
  }
  function materialRhythmHint(game) {
    const point = hintPoint, result = hintResult;
    if (!game.sensorLit['ice-record']) return result('ice-record', '水を凍らせ、左の氷の記録盤へ', [
      '二つの水の盤は、氷と石畳を別々に記録します。',
      '水に「凍結」を適用します。川を歩けるようになります。',
      '川の左側にある「氷の記録盤」の円へ入り、約1秒待ちます。',
      '点灯した記録は残ります。次は水の定義を変えて右の盤へ進みます。'
    ], point(230, 450, '凍結して氷の記録盤へ'));
    if (!game.sensorLit['solid-record']) return result('solid-record', '水を固体化し、右の石畳の記録盤へ', [
      '氷の記録は残っています。今度は別の材質を使います。',
      '水の「凍結」を外し、「固体化」を適用します。石畳も歩いて渡れます。',
      '川の右側にある「石畳の記録盤」の円へ入り、約1秒待ちます。',
      '水は固体化したまま残しましょう。石を運ぶ間も自由に川を歩けます。'
    ], point(650, 450, '固体化して石畳の記録盤へ'));
    if (!game.sensorLit.rhythm) return result('rhythm', '石の脈動で左上の盤を充電しよう', [
      '最後の共鳴盤は、脈動の明るい時間だけ充電します。暗い間も充電した分は残ります。',
      '石に「浮遊＋発光＋脈動」を適用し、研究室でも石を選びます。',
      '右下の石の南側へ戻り、E＋上で川の上側まで運びます。次にE＋左で左上の共鳴盤へ運びます。',
      '石の影を盤の円へ入れ、約3〜4秒待ちます。川を固体化しておけば、行き来する足場を失いません。'
    ], point(290, 365, 'リズムの共鳴盤へ'));
    if (!game.core) return result('last-crystal', '盤の下を回り、左の結晶へ', [
      '材質とリズムの三つの盤が作動しました。',
      '石が道を塞ぐ場合は、盤の下側を左へ回りましょう。',
      '左上の青い結晶へ近づけば中央の門が自動で開きます。門へ戻るときも石の下側を回り、中央へ進んでから上へ向かいます。',
      '慣れたら、目標の定義回数や金の欠片にも挑戦できます。回数はクリアの制限ではありません。'
    ], { ...game.level.core, label: '青い結晶' });
    return null;
  }
  function advancedHint(game) {
    const point = hintPoint, result = hintResult;
    if (game.complete) return result('complete', 'ステージクリア！', ['このステージはクリア済みです。', game.stageIndex < LEVELS.length - 1 ? '次のステージへ進めます。' : '全' + LEVELS.length + 'ステージをクリアしました。少ない定義回数や欠片の収集にも挑戦できます。'], null);
    const gate = game.level.gate;
    if (game.gateOpen) return result('goal', '開いたゲートを通ってゴールへ', ['必要な仕掛けはそろいました。ゲートは開いたままです。', 'ゲートの中央を通って、上のGOALの枠へ進みましょう。', '物体が通路を塞ぐ場合は下側を回ってください。'], point(game.level.goal.x + game.level.goal.w / 2, game.level.goal.y + game.level.goal.h / 2, 'ゴール'));
    let detail;
    if (game.stageIndex === 5) detail = smallDoorHint(game);
    if (game.stageIndex === 6) detail = turningBridgeHint(game);
    if (game.stageIndex === 7) detail = twoLightsHint(game);
    if (game.stageIndex === 8) detail = materialRhythmHint(game);
    if (detail) return detail;
    return result('ready-gate', '仕掛けの完了を確認しよう', ['必要な盤と結晶をそろえると門が自動で開きます。', '点灯していない盤がないか確認してください。'], point(gate.x + gate.w / 2, gate.y + gate.h + 50, 'ゲート'));
  }
  function objective(game) {
    if (game.level.mystery) return Mystery.hint(game).title;
    if (game.level.advanced) return advancedHint(game).title;
    if (game.complete) return 'ステージクリア！';
    if (!game.core) return '川を渡って、青い結晶を見つけよう';
    const sensor = game.level.sensors.find(item => !game.sensorLit[item.id]);
    if (sensor) return sensor.label + '：' + TARGETS.find(item => item.id === sensor.target).jp + 'を運び、' + sensor.requires.map(id => EFFECTS.find(item => item.id === id).jp).join('＋') + 'で作動させよう';
    return game.gateOpen ? '開いたゲートを通って、北のゴールへ' : '炎に「加熱」を適用し、ゲートの近くでEを長押し';
  }
  function progressSteps(game) {
    if (game.level.mystery) {
      return [
        { label: '手掛かりを探す', detail: '近づいてEで調べる', done: notebook(game).length > 0 },
        { label: '仕組みをつなぐ', detail: '定義と解除で状態を変える', done: game.gateOpen },
        { label: '出口を開く', detail: '機構の因果を確かめる', done: game.gateOpen },
        { label: 'ゴールへ', detail: '開いた道を進む', done: game.complete }
      ];
    }
    if (game.level.advanced) return [
      { label: '新しい定義', detail: game.stageIndex === 5 ? '縮小と成長を使い分ける' : game.stageIndex === 6 ? '橋の向きを変える' : game.stageIndex === 7 ? '物体を役割で分ける' : '氷と石畳を使い分ける', done: game.gateOpen || (game.stageIndex === 5 ? game.stone.y <= 460 && has(game, 'stone', 'grow') : game.stageIndex === 6 ? bankOf(game) === 'east' || game.core : game.stageIndex === 7 ? Object.values(game.sensorLit).some(Boolean) : Boolean(game.sensorLit['ice-record'])) },
      { label: '盤と結晶', detail: game.stageIndex === 7 ? '二つの点灯を同時に保つ' : '必要な仕掛けを作動させる', done: game.gateOpen || game.core && game.level.sensors.every(sensor => game.sensorLit[sensor.id]) },
      { label: 'ゲートを開く', detail: '盤と結晶で自動開門', done: game.gateOpen },
      { label: 'ゴールへ', detail: '欠片や定義回数にも挑戦', done: game.complete }
    ];
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
    if (!river) return 'land';
    if (river.h > river.w) {
      if (point.x + 13 <= river.x) return 'west';
      if (point.x - 13 >= river.x + river.w) return 'east';
      return 'river';
    }
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
    if (game.level.mystery) return Mystery.hint(game).key;
    if (game.level.advanced) return advancedHint(game).key;
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
      if ((has(game, target, 'shrink') || has(game, target, 'rotate')) && bridgeGeometry(game, target).h < game.level.rivers[0].h) return 'adjust-bridge-' + target;
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
    if (game.level.mystery) return Mystery.hint(game).target;
    if (game.level.advanced) return advancedHint(game).target;
    const key = hintKey(game), target = crossingTarget(game);
    if (key === 'complete') return null;
    if (key === 'goal') return { x: game.level.goal.x + game.level.goal.w / 2, y: game.level.goal.y + game.level.goal.h / 2, label: 'ゴール' };
    if (key === 'core') return { ...game.level.core, label: '青い結晶' };
    if (key.startsWith('adjust-bridge-')) {
      if (bankOf(game) === 'river') {
        const river = game.level.rivers[0];
        const y = game.player.y < river.y + river.h / 2 ? river.y - 24 : river.y + river.h + 24;
        return { x: game[target].x, y, label: 'E＋移動で足場ごと近い岸へ' };
      }
      return { ...game.player, label: '岸で縮小・回転を外す' };
    }
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
    if (game.level.mystery) return Mystery.hint(game).lines;
    if (game.level.advanced) return advancedHint(game).lines;
    const key = hintKey(game), target = crossingTarget(game), targetName = TARGETS.find(item => item.id === target).jp;
    const coreDirection = game.level.core.x < game.player.x ? '左' : '右';
    const crossing = game.stageIndex === 4 ? '浮遊＋成長' : game.stageIndex === 2 ? '浮遊＋発光' : game.stageIndex === 3 ? '浮遊＋発光＋脈動' : '浮遊';
    const routeAdvice = game.stageIndex === 1 ? '結晶のある左側からは、川沿いに少し下へ回って右側のゲートへ進めます。石が邪魔なら、近くでE＋下を押し、川へ避けてEを離しましょう。' : '浮遊物体が道を塞ぐ場合は、岸でその物体を「発光」だけに切り替えると下へ降ろせます。';
    if (key === 'complete') return ['このステージはクリア済みです。', game.stageIndex < LEVELS.length - 1 ? '「次のステージへ」で先へ進めます。' : '全' + LEVELS.length + 'ステージをクリアしました。ステージ選択から遊び直せます。', '同じステージで欠片の収集にも挑戦できます。'];
    if (key === 'goal') return ['ゲートは開いています。', 'ゲートの中央をまっすぐ上へ進みましょう。', '北側のGOALの枠へ入ればクリアです。', routeAdvice];
    if (key === 'core') return ['川はもう渡れています。次は青い結晶です。', 'この位置から北岸を' + coreDirection + 'へ進むと結晶があります。', '青いひし形へ近づくだけで回収でき、「加熱」が使えるようになります。'];
    if (key.startsWith('adjust-bridge-')) {
      const definition = game.stageIndex === 4 ? '浮遊＋成長' : '浮遊';
      if (bankOf(game) === 'river') return [
        '縮小や回転で足場の縦の長さが川の幅より短くなっています。置いたままでは岸まで届きません。',
        'いまは川の上です。Eを押しながら上か下へ移動し、足場ごと近い岸へ進みましょう。',
        '岸へ出てから' + targetName + 'の「縮小」「回転」を外し、「' + definition + '」を適用します。',
        '今いる足場を失う変更は拒否されます。まず岸へ戻るか、「1手戻す」で変更前へ戻ってください。'
      ];
      return [
        '縮小や回転で足場の縦の長さが川の幅より短くなっています。置くだけでは川をまたげません。',
        '岸に立ったまま、' + targetName + 'の「縮小」「回転」を外し、「' + definition + '」を適用します。',
        '物体が向こう岸にある場合は、このヒント内の「' + targetName + 'の配置を戻す」で出発側へ呼び戻せます。',
        '物体へ近づき、E＋移動で川の中央へ運びます。Eを離してから、方向キーだけで足場の中央を上へ渡りましょう。'
      ];
    }
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
    if (game.level.mystery) return Mystery.interactionStatus(game);
    if (game.complete) return 'ステージクリア';
    if (game.level.advanced && game.gateOpen) return 'ゲートは開いたままです。中央を通ってゴールへ進みましょう。';
    if (game.heating) return 'ゲートを加熱中です。Eを押したまま待ちましょう。';
    const nearby = ['stone', 'tree'].filter(target => has(game, target, 'float') && distance(game.player, game[target]) < 115);
    nearby.sort((a, b) => Number(b === game.preferredCarryTarget) - Number(a === game.preferredCarryTarget) || distance(game.player, game[a]) - distance(game.player, game[b]));
    if (!game.level.advanced && distance(game.player, gatePoint(game)) < 105 && game.core && !pendingSensor(game) && has(game, 'fire', 'heat')) {
      return game.gateOpen ? 'ゲートは開いています。中央を上へ進みましょう。' : 'ここで止まり、Eだけを長押しするとゲートが開きます。';
    }
    if (nearby.length) return TARGETS.find(item => item.id === nearby[0]).jp + '：E＋移動で運べます。Eを離すと置けます。';
    if (game.level.advanced) return '盤と結晶をそろえると自動開門します。迷ったら攻略ヒント（J）へ。';
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
  const api = { TARGETS, EFFECTS, SUPPORTED, LEVELS, createGame, worldBounds, physicalState, mysteryState: physicalState, puzzleStatus, notebook, validPuzzleState, nearbyInteraction, has, supportedEffects, isBridge, bridgeHalfWidth, bridgeGeometry, objectGeometry, fireGeometry, objectPositionValid, sensorActive, pulseHigh, walkable, applyRule, clearRule, update, objective, progressSteps, hints, hintKey, hintTarget, interactionStatus, recoverObject, bankOf, distance, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinition = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
