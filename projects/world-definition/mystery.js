/* 広い遺跡の謎。配置データと、流れ・光・重さによる仕掛けを扱います。 */
'use strict';
(function (root) {
  const BOUNDS = { x: 55, y: 115, w: 1600, h: 1050 };
  const point = (x, y) => ({ x, y });
  const wall = (x, y, w, h) => ({ x, y, w, h });
  const door = (id, x, y, w, h, label, kind) => ({ id, x, y, w, h, label, kind });
  const mechanism = (id, type, x, y, label, extra = {}) => ({ id, type, x, y, label, ...extra });
  const clue = (id, x, y, title, text, extra = {}) => ({ id, x, y, title, text, ...extra });
  const connection = (id, kind, x1, y1, x2, y2) => ({ id, kind, from: point(x1, y1), to: point(x2, y2) });
  function level(data) {
    return { mystery: true, advanced: true, bounds: { ...BOUNDS }, theme: 'ruins',
      sensors: [], shards: [], obstacles: [], ...data, allowed: { fire: [], ...(data.allowed || {}) } };
  }
  const LEVELS = [
    level({ id: 'mystery-waterwheel', name: '止まった水車', defaultTarget: 'water',
      subtitle: '固定された岩と木のある水車場。水で道を作り、解除で動力を戻そう。',
      allowed: { stone: ['grow', 'shrink', 'rotate', 'glow', 'pulse'], tree: ['grow', 'shrink', 'rotate', 'glow', 'pulse'] },
      spawn: point(250, 1020), stone: point(580, 980), tree: point(360, 900), fire: point(1560, 1020),
      core: point(1000, 350), gate: door('exit', 1180, 300, 28, 160, '蓄電扉', 'power'), goal: { x: 1480, y: 210, w: 100, h: 80 },
      rivers: [{ id: 'main-river', x: 55, y: 600, w: 1600, h: 110, flow: 'right' }],
      walls: [wall(1180, 115, 28, 185), wall(1180, 460, 28, 705)],
      doors: [door('exit', 1180, 300, 28, 160, '蓄電扉', 'power')],
      mechanisms: [mechanism('intake', 'lever', 850, 390, '取水門'), mechanism('wheel', 'wheel', 940, 850, '発電水車')],
      clues: [clue('wheel-sign', 250, 900, '水車守の覚え書き', '岩と木は、土台と深い根で動かない。北岸の取水門は閉じたままだ。水車を回すのは水の形ではなく流れ。扉には、水車が作った電気を蓄える仕組みが残っている。')],
      zones: [{ x: 100, y: 810, w: 650, h: 260, label: '水車の広場' }, { x: 180, y: 220, w: 900, h: 290, label: '取水門の岸' }, { x: 1250, y: 160, w: 330, h: 280, label: '蓄電庫' }],
      connections: [connection('intake-water', 'water', 850, 390, 940, 850), connection('wheel-power', 'power', 940, 850, 1194, 380)],
      shards: [point(140, 1040), point(650, 300)] }),
    level({ id: 'mystery-shadow-library', name: '光と影の書庫', defaultTarget: 'tree', theme: 'night', allowed: { water: [] },
      subtitle: '光は文字を見せ、扉を閉ざす。読んだ手掛かりは手帳に残る。',
      spawn: point(250, 1030), stone: point(650, 1000), tree: point(300, 650), fire: point(1560, 1060),
      core: point(1120, 520), gate: door('exit', 1400, 430, 140, 24, '三紋章の扉', 'runes'), goal: { x: 1450, y: 220, w: 100, h: 80 },
      rivers: [],
      walls: [wall(850, 115, 24, 685), wall(850, 940, 24, 225), wall(874, 430, 526, 24), wall(1540, 430, 115, 24)],
      doors: [door('dark', 850, 800, 24, 140, '暗闇を好む扉', 'dark'), door('exit', 1400, 430, 140, 24, '三紋章の扉', 'runes')],
      mechanisms: [mechanism('wave', 'rune', 1300, 900, '波の紋章', { symbol: '≈' }), mechanism('moon', 'rune', 1050, 680, '月の紋章', { symbol: '☾' }), mechanism('sun', 'rune', 1450, 580, '太陽の紋章', { symbol: '☀' })],
      clues: [clue('library-entry', 200, 950, '書庫の案内', '古い文字は、木の光に照らされる間だけ姿を現す。東の番人は光を嫌い、暗闇の客を通す。消えた文字も、読んだ者の記録からは消えない。'),
        clue('hidden-poem', 350, 450, '光で現れた詩', 'まず流れをたどり、次に夜を越え、最後に朝を迎える。三つの紋章は、この旅の順に呼びかけよ。', { reveal: 'glow' })],
      zones: [{ x: 100, y: 260, w: 620, h: 710, label: '古い書庫' }, { x: 950, y: 530, w: 580, h: 500, label: '三紋章の回廊' }, { x: 1000, y: 160, w: 540, h: 200, label: '暁の間' }],
      connections: [connection('rune-power', 'power', 1300, 900, 1470, 442)],
      shards: [point(150, 300), point(1560, 1080)] }),
    level({ id: 'mystery-weight', name: '重さが開く水門', defaultTarget: 'stone',
      subtitle: '運ぶ間は浮かせ、支えるときは下ろす。根と重さで通り道を変えよう。',
      spawn: point(250, 1060), stone: point(650, 1000), tree: point(600, 550), fire: point(1560, 1050),
      core: point(1000, 300), gate: door('exit', 1180, 300, 28, 170, '水車の扉', 'power'), goal: { x: 1480, y: 200, w: 100, h: 80 },
      rivers: [{ id: 'upper-river', x: 55, y: 620, w: 1600, h: 110, flow: 'right' }],
      walls: [wall(55, 800, 375, 24), wall(570, 800, 610, 24), wall(750, 115, 24, 265), wall(750, 520, 24, 100), wall(1180, 115, 28, 185), wall(1180, 470, 28, 695)],
      doors: [door('weight', 430, 800, 140, 24, '重さの格子', 'weight'), door('roots', 750, 380, 24, 140, '根の水門', 'roots'), door('exit', 1180, 300, 28, 170, '水車の扉', 'power')],
      mechanisms: [mechanism('weight-plate', 'plate', 520, 950, '重さの床'), mechanism('roots', 'root', 600, 550, '根が持ち上げる取水口'), mechanism('intake', 'lever', 950, 450, '上流の取水弁'), mechanism('wheel', 'wheel', 1040, 550, '上流水車')],
      clues: [clue('weight-sign', 280, 1000, '石工の手記', '宙にある石は、床へ重さを預けない。この格子が求めるのは、地に足をつけた石の重さ。小石では、その重みを満たせない。'), clue('root-sign', 500, 580, '庭師の記録', '木の根は東の取水口へつながっている。育つ力は、水門の重さをも持ち上げる。奥の庭の取水弁は、長く閉じられたままだ。')],
      zones: [{ x: 100, y: 870, w: 850, h: 230, label: '石工の広場' }, { x: 180, y: 270, w: 500, h: 300, label: '根の庭' }, { x: 830, y: 250, w: 290, h: 300, label: '取水弁の庭' }, { x: 1250, y: 170, w: 330, h: 300, label: '水車の蔵' }],
      connections: [connection('weight-wire', 'power', 520, 950, 500, 812), connection('root-link', 'water', 600, 550, 762, 450), connection('root-intake', 'water', 762, 450, 950, 450), connection('upper-water', 'water', 950, 450, 1040, 550), connection('upper-power', 'power', 1040, 550, 1194, 385)],
      shards: [point(140, 1080), point(280, 300)] }),
    level({ id: 'mystery-source-maze', name: '水源の迷宮', defaultTarget: 'water',
      subtitle: '氷で渡るか、堰で水を抜くか。水路を読み替え、流れを出口へ戻そう。',
      spawn: point(220, 1040), stone: point(650, 1000), tree: point(400, 900), fire: point(1560, 1060),
      core: point(1100, 550), gate: door('exit', 1450, 300, 120, 24, '南水路の動力扉', 'power'), goal: { x: 1480, y: 160, w: 100, h: 80 },
      rivers: [{ id: 'source', x: 55, y: 450, w: 725, h: 110, flow: 'right' }, { id: 'tail', x: 804, y: 450, w: 650, h: 200, flow: 'right' }],
      walls: [wall(780, 115, 24, 355), wall(780, 620, 24, 545), wall(804, 420, 650, 24), wall(804, 650, 486, 24), wall(1420, 650, 34, 24), wall(1454, 420, 24, 430), wall(1454, 980, 24, 185), wall(804, 300, 646, 24), wall(1570, 300, 85, 24)],
      doors: [door('drain', 780, 470, 24, 150, '水位連動の水密扉', 'drain'), door('hatch', 1290, 650, 130, 24, '点検用ハッチ', 'hatch'), door('dark', 1454, 850, 24, 130, '光を嫌う通路', 'dark'), door('exit', 1450, 300, 120, 24, '南水路の動力扉', 'power')],
      mechanisms: [mechanism('source-dam', 'dam', 720, 505, '導水口'), mechanism('north-valve', 'lever', 1200, 500, '北水路の弁'), mechanism('south-valve', 'lever', 1350, 590, '南水路の弁'), mechanism('wheel', 'wheel', 1190, 360, '南水路の水車')],
      clues: [clue('source-sign', 250, 950, '水路管理人の案内', '氷は水面を覆っても、川底を見せない。石の堰は導水口をふさぎ、下流の水位を下げる。水密扉は、川底が見える高さで開くように作られている。'),
        clue('flow-plan', 420, 820, '光に浮かぶ配管図', '北水路は途中で破れ、水が地中へ逃げている。南水路の先には発電水車。流路が整うと点検用ハッチが開く。水車には流れが必要だ。東の番人は、暗闇を好む。', { reveal: 'glow' })],
      zones: [{ x: 100, y: 760, w: 600, h: 300, label: '水源管理室' }, { x: 920, y: 470, w: 480, h: 160, label: '下流の川床' }, { x: 950, y: 760, w: 400, h: 300, label: '点検広場' }, { x: 1490, y: 400, w: 150, h: 620, label: '東の通路' }],
      connections: [connection('north-flow', 'water', 720, 505, 1200, 500), connection('south-flow', 'water', 1350, 590, 1190, 360), connection('final-power', 'power', 1190, 360, 1510, 312)],
      shards: [point(150, 300), point(1080, 1000)] })
  ];
  const has = (game, target, effect) => Boolean(game.rules[target]?.effects.includes(effect));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const liquid = game => !has(game, 'water', 'freeze') && !has(game, 'water', 'solidify');
  const lit = game => has(game, 'tree', 'glow');
  function createState(level) {
    return { exitOpen: false, intakeOpen: false, westValve: false, northValve: true, southValve: false,
      codeProgress: 0, powerCharge: 0, eHeld: false,
      seenClues: Object.fromEntries(level.clues.map(item => [item.id, false])) };
  }
  function visibleClue(game, item) {
    return item.reveal !== 'glow' || lit(game) && distance(game.tree, item) <= 400;
  }
  function weighted(game) {
    const plate = game.level.mechanisms.find(item => item.id === 'weight-plate');
    return Boolean(plate && distance(game.stone, plate) <= 45 && !has(game, 'stone', 'float') && !has(game, 'stone', 'shrink'));
  }
  function rootsRaised(game) {
    const root = game.level.mechanisms.find(item => item.id === 'roots');
    return Boolean(root && distance(game.tree, root) <= 70 && has(game, 'tree', 'grow'));
  }
  function routed(game) { return !game.puzzle.northValve && game.puzzle.southValve; }
  function physicalState(game) {
    const p = game.puzzle, id = game.level.id;
    const flowing = liquid(game), doorStates = { exit: p.exitOpen }, activeMechanisms = {}, activeConnections = {};
    let rivers = game.level.rivers, flowRoute = 'blocked';
    if (id === 'mystery-waterwheel') {
      const running = flowing && p.intakeOpen;
      activeMechanisms.intake = p.intakeOpen; activeMechanisms.wheel = running;
      activeConnections['intake-water'] = running; activeConnections['wheel-power'] = running || p.exitOpen;
      flowRoute = running ? 'south' : 'blocked';
    }
    if (id === 'mystery-shadow-library') {
      doorStates.dark = !lit(game);
      ['wave', 'moon', 'sun'].forEach((rune, index) => { activeMechanisms[rune] = p.codeProgress > index; });
      activeConnections['rune-power'] = p.codeProgress === 3;
    }
    if (id === 'mystery-weight') {
      doorStates.weight = weighted(game); doorStates.roots = rootsRaised(game);
      const running = flowing && p.intakeOpen && doorStates.roots;
      activeMechanisms['weight-plate'] = doorStates.weight; activeMechanisms.roots = doorStates.roots;
      activeMechanisms.intake = p.intakeOpen; activeMechanisms.wheel = running;
      activeConnections['weight-wire'] = doorStates.weight; activeConnections['root-link'] = flowing && doorStates.roots; activeConnections['root-intake'] = running;
      activeConnections['upper-water'] = running; activeConnections['upper-power'] = running || p.exitOpen;
      flowRoute = running ? 'south' : 'blocked';
    }
    if (id === 'mystery-source-maze') {
      const drained = has(game, 'water', 'solidify') || routed(game);
      doorStates.drain = drained; doorStates.hatch = routed(game); doorStates.dark = !lit(game);
      if (drained) rivers = game.level.rivers.filter(item => item.id !== 'tail');
      const running = flowing && routed(game);
      activeMechanisms['source-dam'] = has(game, 'water', 'solidify');
      activeMechanisms['north-valve'] = p.northValve; activeMechanisms['south-valve'] = p.southValve; activeMechanisms.wheel = running;
      activeConnections['north-flow'] = flowing && p.northValve;
      activeConnections['south-flow'] = running; activeConnections['final-power'] = running || p.exitOpen;
      flowRoute = !flowing ? 'blocked' : p.northValve ? 'north' : p.southValve ? 'south' : 'blocked';
    }
    return { walls: [...game.level.walls, ...game.level.doors.filter(item => !doorStates[item.id])], rivers,
      doorStates, activeMechanisms, activeConnections, flowing, flowRoute, sourceOpen: id === 'mystery-weight' ? Boolean(doorStates.roots) : Boolean(p.intakeOpen || id === 'mystery-source-maze'), fire: false,
      visibleClues: game.level.clues.filter(item => visibleClue(game, item)).map(item => item.id) };
  }
  function nearestInteraction(game) {
    const items = [...game.level.clues.map(item => ({ ...item, kind: 'clue' })),
      ...game.level.mechanisms.filter(item => ['lever', 'rune'].includes(item.type)).map(item => ({ ...item, kind: item.type }))];
    return items.filter(item => distance(game.player, item) < 76).sort((a, b) => distance(game.player, a) - distance(game.player, b))[0] || null;
  }
  function note(game, text) { game.notice = text; }
  function touches(point, rect, radius = 13) {
    const x = Math.max(rect.x, Math.min(point.x, rect.x + rect.w));
    const y = Math.max(rect.y, Math.min(point.y, rect.y + rect.h));
    return Math.hypot(point.x - x, point.y - y) < radius;
  }
  function toggleValve(game, key) {
    const before = physicalState(game);
    game.puzzle[key] = !game.puzzle[key];
    const after = physicalState(game);
    const closesOnPlayer = after.walls.some(rect => touches(game.player, rect));
    const floodsPlayer = liquid(game) && after.rivers.some(rect => touches(game.player, rect) && !before.rivers.some(old => old.id === rect.id));
    if (closesOnPlayer || floodsPlayer) {
      game.puzzle[key] = !game.puzzle[key];
      note(game, '今いる通路が閉じるか、足元へ水が戻るため操作できません。先に安全な場所へ移動してください。');
      return false;
    }
    return true;
  }
  function interact(game, item) {
    const p = game.puzzle;
    if (item.kind === 'clue') {
      if (!visibleClue(game, item)) return note(game, '石碑にはかすかな溝だけが見えます。近くの木に光を灯すと読めるかもしれません。');
      p.seenClues[item.id] = true; return note(game, '「' + item.title + '」を手帳に記録しました。手帳で読み返せます。');
    }
    if (item.id === 'intake') {
      p.intakeOpen = !p.intakeOpen;
      return note(game, p.intakeOpen ? '取水門を開きました。水が流れているか、水車の様子を確かめましょう。' : '取水門を閉じました。');
    }
    if (item.id === 'north-valve') { if (!toggleValve(game, 'northValve')) return; return note(game, '北水路の弁を' + (p.northValve ? '開きました。北へ水が逃げます。' : '閉じました。')); }
    if (item.id === 'south-valve') { if (!toggleValve(game, 'southValve')) return; return note(game, '南水路の弁を' + (p.southValve ? '開きました。' : '閉じました。')); }
    if (item.kind === 'rune') {
      const sequence = ['wave', 'moon', 'sun'];
      if (p.codeProgress === sequence.length) return note(game, '三つの紋章は呼応しています。青い結晶も回収して扉へ進みましょう。');
      if (sequence[p.codeProgress] === item.id) {
        p.codeProgress++; return note(game, p.codeProgress === 3 ? '波、月、太陽。三つの紋章が正しい順に呼応しました。' : item.label + 'が応えました。次の紋章へ進みましょう。');
      }
      p.codeProgress = item.id === sequence[0] ? 1 : 0;
      return note(game, '紋章の順が違うようです。光に現れた詩を手帳で読み返しましょう。最初からやり直せます。');
    }
  }
  function tick(game, input, dt) {
    const p = game.puzzle, moving = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].some(key => input.has(key));
    const pressed = input.has('e');
    if (pressed && !p.eHeld && !moving) { const item = nearestInteraction(game); if (item) interact(game, item); }
    p.eHeld = pressed;
    const state = physicalState(game), id = game.level.id;
    const powered = id === 'mystery-shadow-library' ? p.codeProgress === 3 : Boolean(state.activeMechanisms.wheel);
    if (!p.exitOpen) p.powerCharge = powered ? Math.min(1, p.powerCharge + dt / 1.5) : 0;
    if (!p.exitOpen && powered && p.powerCharge >= 1 && game.core) {
      p.exitOpen = true; note(game, '仕掛けがつながり、出口の扉が開きました。開いた扉はそのまま残ります。');
    }
  }
  function interactionStatus(game) {
    const item = nearestInteraction(game);
    if (item) return item.kind === 'clue' ? item.title + '：立ち止まってEで調べる' : item.label + '：立ち止まってEを押す';
    return '石碑や装置に近づき、立ち止まってEで調べます。Mで全体地図を確認できます。';
  }
  function notebook(game) {
    return game.level.clues.filter(item => game.puzzle.seenClues[item.id]).map(({ id, title, text }) => ({ id, title, text }));
  }
  function status(game) {
    const p = game.puzzle, state = physicalState(game), id = game.level.id;
    const water = has(game, 'water', 'freeze') ? '凍結：渡れるが水車は止まる' : has(game, 'water', 'solidify') ? '固体化：流れをせき止める' : '液体：水が流れる';
    const result = [];
    if (game.level.rivers.length) result.push({ id: 'water', label: '水の状態', value: water, active: liquid(game) });
    if (id === 'mystery-waterwheel' || id === 'mystery-weight') result.push({ id: 'intake', label: '取水門', value: p.intakeOpen ? '開いている' : '閉じている', active: p.intakeOpen });
    if (id === 'mystery-shadow-library') {
      result.push({ id: 'light', label: '木の光と扉', value: lit(game) ? '文字が見える／暗闇の扉は閉じる' : '消灯／暗闇の扉が開く', active: lit(game) });
      result.push({ id: 'code', label: '紋章の呼応', value: p.codeProgress + ' / 3', active: p.codeProgress === 3 });
    }
    if (id === 'mystery-weight') {
      result.push({ id: 'weight', label: '重さの床', value: state.doorStates.weight ? '石の重さで格子が開く' : '重さが届いていない', active: state.doorStates.weight });
      result.push({ id: 'roots', label: '根の取水口', value: state.doorStates.roots ? '根が水門を持ち上げ、水を通せる' : '根が届かず、取水口は閉じている', active: state.doorStates.roots });
    }
    if (id === 'mystery-source-maze') {
      result.push({ id: 'level', label: '下流の川床', value: state.rivers.some(item => item.id === 'tail') ? '水位が高い／水密扉は閉じる' : '排水済み／川床を歩ける', active: state.doorStates.drain });
      result.push({ id: 'route', label: '水路の弁', value: '北：' + (p.northValve ? '開' : '閉') + ' ／ 南：' + (p.southValve ? '開' : '閉'), active: routed(game) });
    }
    if (id !== 'mystery-shadow-library') result.push({ id: 'wheel', label: '水車と蓄電', value: p.exitOpen ? '蓄電済み／出口を維持' : state.activeMechanisms.wheel ? '回転中／蓄電 ' + Math.round(p.powerCharge * 100) + '%' : '停止中', active: Boolean(state.activeMechanisms.wheel) });
    result.push({ id: 'exit', label: '出口の扉', value: p.exitOpen ? '開いている' : '閉じている', active: p.exitOpen });
    return result;
  }
  const hintResult = (key, title, lines, x, y, label) => ({ key, title, lines, target: x === null ? null : { x, y, label } });
  function hint(game) {
    const p = game.puzzle, id = game.level.id, h = hintResult;
    if (game.complete) return h('complete', '謎を解き明かしました', ['この遺跡の仕掛けは解けました。', '次の遺跡、または練習ステージへ進めます。'], null, null);
    if (p.exitOpen) return h('goal', '開いた扉の向こうへ', ['出口の扉は開いたままです。', '全体地図で出口を確認し、GOALの枠へ進みましょう。'], game.level.goal.x + 50, game.level.goal.y + 40, '出口');
    if (id === 'mystery-waterwheel') {
      if (!p.intakeOpen) return h('wheel-intake', '止まった水車の原因を探ろう', ['水車は、水門と流れる水の両方を必要とします。', '広場の石碑をEで調べます。水門は川の向こう岸です。', '水を凍結または固体化して、上の岸へ渡りましょう。', '上の岸の取水門へ近づき、移動を止めてEを押します。'], 850, 390, '取水門');
      if (!game.core) return h('wheel-key', '取水門の岸を探索しよう', ['取水門は開きました。出口には青い結晶も必要です。', '取水門から右上へ進み、青い結晶を回収します。', '水車がまだ止まっているなら、水の定義が流れを止めていないか確かめましょう。'], 1000, 350, '青い結晶');
      return h('wheel-flow', '道にした水へ、流れを返そう', ['水門を開いても、水が凍ったままでは水車は回りません。', '岸に立ったまま、水の「定義を解除」を押します。', '水車の回転と出口への送電を確かめ、少し待ちましょう。石や木を運ぶ必要はありません。'], game.player.x, game.player.y, '岸で水の定義を解除');
    }
    if (id === 'mystery-shadow-library') {
      if (p.codeProgress === 3) return h('library-key', '紋章の回廊で結晶を探そう', ['三つの紋章は正しい順に呼応しました。', '青い結晶を回収し、右上の三紋章の扉へ進みましょう。'], 1120, 520, '青い結晶');
      if (!p.seenClues['hidden-poem'] && p.codeProgress === 0) return h('library-light', '消えた文字を読む方法を探そう', ['古い書庫の石碑は、木の光で文字が現れます。', '木に「発光」を適用し、書庫の北側にある石碑へ近づきます。', '石碑の前でEを押すと、詩が手帳へ記録されます。木を運ぶ必要はありません。'], 350, 450, '古い石碑');
      if (lit(game)) return h('library-dark', '文字を覚えたら、光の役割を変えよう', ['詩は手帳へ残っています。東の扉は光を嫌います。', '木の定義を解除し、消灯してから東の扉を通ります。', '扉は書庫の右下にあります。光を消しても読んだ手掛かりは消えません。'], 862, 870, '暗闇を好む扉');
      if (p.codeProgress < 3) {
        const next = ['wave', 'moon', 'sun'][p.codeProgress], rune = game.level.mechanisms.find(item => item.id === next);
        return h('library-code-' + p.codeProgress, '詩の旅を、紋章の順に読み替えよう', ['書庫の詩は「流れ」「夜」「朝」という順番でした。', 'それぞれに対応する紋章を探し、順に近づいてEを押します。', '正しい順は、波→月→太陽です。間違えても最初からやり直せます。'], rune.x, rune.y, rune.label);
      }
      return h('library-key', '紋章の回廊で結晶を探そう', ['三つの紋章は正しい順に呼応しました。', '青い結晶を回収し、右上の三紋章の扉へ進みましょう。'], 1120, 520, '青い結晶');
    }
    if (id === 'mystery-weight') {
      if (!weighted(game) && game.player.y > 800) return h('weight-drop', '運ぶ性質と、床を押す重さを切り替えよう', ['浮遊した石では床の重さの仕掛けが反応しません。', '石を浮かせ、広場の丸い床へ運びます。影を円の中央付近へ入れてください。', '石から少し離れ、石の定義を解除します。小さくなっていた石も通常の重さへ戻せます。', '格子が開いたら石は置いたまま、中央の通路を上へ進みます。'], 520, 950, '重さの床');
      if (!rootsRaised(game)) return h('weight-roots', '根がつながる水門を探そう', ['重さの格子は開いています。次は上流の庭です。', '水を凍らせて川を渡り、木の近くの石碑を調べます。', '木に「成長」を適用すると、根が東の格子を持ち上げます。石の重さはそのまま残しましょう。'], 600, 550, '根の水門の木');
      if (!p.intakeOpen) return h('weight-intake', '根が開いた通路の先へ', ['木の根が東の格子を持ち上げています。', '川より上の庭で、格子の中央を右へ通ります。', '東の取水弁でEを押し、近くの青い結晶も回収しましょう。'], 950, 450, '上流の取水弁');
      if (!game.core) return h('weight-key', '上流の庭の結晶を回収しよう', ['取水弁は開いています。', '庭の右上にある青い結晶へ近づきます。'], 1000, 300, '青い結晶');
      return h('weight-flow', '根と重さを残し、水へ流れを返そう', ['石と木の役割はそのまま残します。', '岸で水の定義を解除し、上流水車を動かしましょう。', '蓄電が終わると右の出口が開きます。'], game.player.x, game.player.y, '岸で水の定義を解除');
    }
    if (!p.seenClues['flow-plan'] && !routed(game)) return h('maze-plan', '見えない配管図を探そう', ['水源管理室の案内と、光に浮かぶ配管図を調べましょう。', '木に「発光」を適用し、管理室の石碑へ近づいてEを押します。', '配管図は手帳へ残ります。木の光は後で解除できます。'], 420, 820, '配管図の石碑');
    if (!routed(game)) return h('maze-drain', '堰で川底を出し、流路を組み替えよう', ['凍結では水面を歩けても、水位連動の扉は閉じたままです。', '水に「固体化」を適用します。導水口が堰となり、右の川床が現れます。', '川床へ入り、北の弁を閉じ、南の弁を開きます。青い結晶も川床にあります。', '二つの弁が整うと下側の点検ハッチが開きます。そこから右下の広場へ出られます。'], p.northValve ? 1200 : 1350, p.northValve ? 500 : 590, p.northValve ? '北の弁を閉じる' : '南の弁を開く');
    if (!game.core) return h('maze-key', '乾いた川床で結晶を回収しよう', ['流路は南へつながりました。川床は排水されたままです。', '川床中央の青い結晶を回収し、下側の点検ハッチから出ます。'], 1100, 550, '川床の青い結晶');
    if (lit(game)) return h('maze-dark', '手帳を残し、東の通路を暗くしよう', ['配管図は手帳へ残っています。東の通路は光を嫌います。', '木の定義を解除し、下側の点検ハッチから右下の広場へ出ます。', '東の通路を右へ抜け、上へ進めます。'], 1466, 915, '光を嫌う通路');
    return h('maze-flow', '堰を外し、南水路へ流れを戻そう', ['北は閉じ、南は開いています。あとは水車へ水を返します。', '岸に立って水の定義を解除し、配管と水車の変化を確認します。', '出口は東の通路を上へ進んだ先です。Mの全体地図で確認できます。'], game.player.x, game.player.y, '水の定義を解除');
  }
  function validateState(game) {
    const p = game.puzzle;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    const expected = createState(game.level);
    if (Object.keys(p).length !== Object.keys(expected).length || !Object.keys(expected).every(key => Object.hasOwn(p, key))) return false;
    if (!['exitOpen', 'intakeOpen', 'westValve', 'northValve', 'southValve', 'eHeld'].every(key => typeof p[key] === 'boolean')) return false;
    if (!Number.isInteger(p.codeProgress) || p.codeProgress < 0 || p.codeProgress > 3 || !Number.isFinite(p.powerCharge) || p.powerCharge < 0 || p.powerCharge > 1) return false;
    if (!p.seenClues || Object.keys(p.seenClues).length !== game.level.clues.length || !game.level.clues.every(item => typeof p.seenClues[item.id] === 'boolean')) return false;
    if (typeof game.gateOpen !== 'boolean' || game.gateOpen !== p.exitOpen) return false;
    if (game.level.id !== 'mystery-shadow-library' && p.codeProgress !== 0) return false;
    if (p.exitOpen && (!game.core || p.powerCharge < 1 || game.level.id === 'mystery-shadow-library' && p.codeProgress !== 3)) return false;
    return true;
  }
  const api = { LEVELS, createState, physicalState, tick, hint, status, notebook, interactionStatus, validateState, nearestInteraction, nearbyInteraction: nearestInteraction };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinitionMystery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
