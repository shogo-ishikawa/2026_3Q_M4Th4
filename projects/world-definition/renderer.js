/* Canvas presentation only. Every game rule and collision lives in engine.js. */
'use strict';
(function (root) {
  const THEMES = {
    meadow: { edge: '#183f35', rim: '#67855a', ground: '#abc48f', grass: '#72955f', path: '#c4cea7', water: '#64acc5', deepWater: '#31768f', wall: '#829784', ink: '#254e36', lightInk: '#f6f5d7' },
    quarry: { edge: '#323e3a', rim: '#7f8a72', ground: '#c3c2a3', grass: '#939978', path: '#ddd3b5', water: '#639da9', deepWater: '#3a7182', wall: '#89958c', ink: '#3a5143', lightInk: '#fffae5' },
    night: { edge: '#112e35', rim: '#355950', ground: '#3d6658', grass: '#64947a', path: '#597c65', water: '#356c8a', deepWater: '#224d6c', wall: '#76928c', ink: '#e7efd0', lightInk: '#f6f5d7' },
    resonance: { edge: '#302f48', rim: '#6c6b79', ground: '#858d86', grass: '#637b72', path: '#a5b19a', water: '#688daa', deepWater: '#46627f', wall: '#747d91', ink: '#263f3a', lightInk: '#faf2d7' },
    ruins: { edge: '#183f42', rim: '#7f9675', ground: '#bcc89a', grass: '#7e9d77', path: '#dfd5a4', water: '#57a7b1', deepWater: '#2b7b88', wall: '#a6a18b', ink: '#30533e', lightInk: '#fff8d8' }
  };
  const TARGET_LABELS = { water: '水', stone: '石', tree: '木', fire: '炎' };
  const EFFECT_LABELS = { float: '浮遊', move: '移動', grow: '成長', glow: '発光', freeze: '凍結', solidify: '固体化', pulse: '脈動', heat: '加熱', shrink: '縮小', rotate: '回転' };

  // The camera is a view of world coordinates, independent of game state.
  function cameraFor(bounds, player, overview = false) {
    const width = 870, height = 570;
    if (overview) {
      const scale = Math.min((width - 44) / bounds.w, (height - 76) / bounds.h);
      return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, scale,
        offsetX: (width - bounds.w * scale) / 2, offsetY: 48 + (height - 76 - bounds.h * scale) / 2 };
    }
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    return { x: bounds.w >= width ? clamp(player.x - width / 2, bounds.x, bounds.x + bounds.w - width) : bounds.x - (width - bounds.w) / 2,
      y: bounds.h >= height ? clamp(player.y - height / 2, bounds.y, bounds.y + bounds.h - height) : bounds.y - (height - bounds.h) / 2,
      w: width, h: height, scale: 1, offsetX: 0, offsetY: 0 };
  }

  function createRenderer(canvas, E, options = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D を利用できません。');
    const reducedMotion = Boolean(options.reducedMotion);
    const pixelRatio = Math.min(root.devicePixelRatio || 1, 2);
    canvas.width = 870 * pixelRatio;
    canvas.height = 570 * pixelRatio;

    function rect(x, y, width, height, colour, radius = 0) {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
      ctx.fill();
    }
    function circle(x, y, radius, colour) {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    function ring(x, y, radius, colour, width = 2, dashed = false) {
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      if (dashed) ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    function line(x1, y1, x2, y2, colour, width = 2, dashed = false) {
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    }
    function word(value, x, y, size = 14, colour = '#254e36', align = 'left') {
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = 'top';
      ctx.fillStyle = colour;
      ctx.fillText(value, x, y);
      ctx.textAlign = 'left';
    }
    function halo(x, y, radius, colour) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, colour);
      gradient.addColorStop(1, '#ffffff00');
      circle(x, y, radius, gradient);
    }
    function diamond(x, y, radius, colour, border) {
      ctx.beginPath();
      ctx.moveTo(x, y - radius);
      ctx.lineTo(x + radius * .65, y);
      ctx.lineTo(x, y + radius);
      ctx.lineTo(x - radius * .65, y);
      ctx.closePath();
      ctx.fillStyle = colour;
      ctx.fill();
      if (border) { ctx.strokeStyle = border; ctx.lineWidth = 2; ctx.stroke(); }
    }
    function pill(value, x, y, colour = '#274b3fe8', textColour = '#fff8d7', size = 12) {
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      const width = ctx.measureText(value).width + 18;
      const left = E.clamp(x - width / 2, 61, 809 - width);
      rect(left, y, width, size + 12, colour, 5);
      word(value, left + width / 2, y + 5, size, textColour, 'center');
      return size + 12;
    }

    function drawGround(game, theme) {
      const level = game.level;
      rect(0, 100, 870, 570, theme.edge);
      rect(47, 107, 776, 560, theme.rim, 14);
      rect(55, 115, 760, 545, theme.ground, 8);
      for (let index = 0; index < 130; index++) {
        const x = 69 + index * 137 % 731, y = 124 + index * 193 % 525;
        if (level.rivers.some(river => y >= river.y - 8 && y <= river.y + river.h + 8)) continue;
        if (level.walls.some(wall => y >= wall.y - 5 && y <= wall.y + wall.h + 5)) continue;
        if (level.theme === 'quarry' || level.theme === 'ruins') {
          rect(x, y, index % 3 === 0 ? 12 : 6, 4, theme.grass + '50', 2);
        } else {
          line(x - 3, y - 4, x, y, theme.grass + '80', 1);
          line(x, y, x + 3, y - 5, theme.grass + '80', 1);
          if (index % 13 === 0) circle(x + 4, y - 5, 2, level.theme === 'night' ? '#a8deaa' : '#f7e8b3');
        }
      }
      // A short path marks the start without giving away the route.
      rect(level.spawn.x - 20, Math.max(115, level.spawn.y - 58), 40, 110, theme.path, 5);
      for (let y = level.spawn.y - 42; y < level.spawn.y + 40; y += 30) rect(level.spawn.x - 7, y, 14, 8, '#f0e8c680', 3);
      word('N ↑', 785, 132, 14, theme.ink, 'center');
      word(level.name, 77, 137, 16, theme.ink);
      if (level.advanced) word('応用ステージ', 77, 161, 11, theme.ink);
      if (Number.isFinite(level.parRules)) pill('挑戦目標：定義 ' + level.parRules + ' 回', 636, 133, '#f4ecd9e8', '#53603c', 11);
    }

    function snowflake(x, y, radius, colour) {
      for (let arm = 0; arm < 3; arm++) {
        const angle = arm * Math.PI / 3;
        const dx = Math.cos(angle) * radius, dy = Math.sin(angle) * radius;
        line(x - dx, y - dy, x + dx, y + dy, colour, 1.6);
      }
    }
    function waterCentre(game) {
      const river = game.level.rivers[0];
      return { x: river.x + river.w / 2, y: river.y + river.h / 2 };
    }
    function drawWater(game, selectedTarget, time, theme) {
      const frozen = E.has(game, 'water', 'freeze');
      const solid = E.has(game, 'water', 'solidify');
      const sealed = !E.supportedEffects(game, 'water').includes('freeze');
      for (const river of game.level.rivers) {
        rect(river.x, river.y - 4, river.w, river.h + 8, '#375f5e88');
        if (solid) {
          // Solidification changes the material, not merely the tint.
          rect(river.x, river.y, river.w, river.h, '#8d9d8e');
          for (let row = 0; row * 28 < river.h; row++) {
            for (let col = 0; col * 42 < river.w; col++) {
              const x = river.x + col * 42, y = river.y + row * 28;
              const w = Math.min(40, river.x + river.w - x), h = Math.min(26, river.y + river.h - y);
              rect(x + 1, y + 1, w, h, (row + col) % 3 === 0 ? '#d5d5b8' : '#bcc8b0', 3);
              line(x + 5, y + 4, x + w - 4, y + 4, '#edf0d1', 1);
            }
          }
          line(river.x, river.y + 3, river.x + river.w, river.y + 3, '#e9e2b1', 4);
          line(river.x, river.y + river.h - 3, river.x + river.w, river.y + river.h - 3, '#7c927e', 4);
        } else {
          const gradient = ctx.createLinearGradient(0, river.y, 0, river.y + river.h);
          gradient.addColorStop(0, frozen ? '#b9e5e9' : theme.water);
          gradient.addColorStop(1, frozen ? '#edf8e8' : theme.deepWater);
          rect(river.x, river.y, river.w, river.h, gradient);
          ctx.save();
          ctx.beginPath(); ctx.rect(river.x, river.y, river.w, river.h); ctx.clip();
          for (let index = 0; index < 28; index++) {
            const x = river.x + 12 + (index * 97 + (frozen ? 0 : time * 16)) % (river.w - 28);
            const y = river.y + 13 + index % Math.max(1, Math.floor((river.h - 20) / 18)) * 18;
            if (frozen) {
              line(x - 16, y + 9, x, y - 4, '#ffffffc0', 1.7);
              line(x, y - 4, x + 20, y + 3, '#79b8c580', 1.2);
              if (index % 4 === 0) snowflake(x, y, 7, '#ffffff');
            } else {
              line(x, y, x + 22, y, '#d6f6f080', 1.6);
              if (index % 6 === 0) circle(x + 8, y + 6, 2, '#b6e4df55');
            }
          }
          ctx.restore();
        }
        const centre = { x: river.x + river.w / 2, y: river.y + river.h / 2 };
        drawLight(game, 'water', centre.x, centre.y, 155, time);
        if (selectedTarget === 'water') {
          ctx.save(); ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = '#e6f4cbbc';
          ctx.strokeRect(river.x + 4, river.y + 4, river.w - 8, river.h - 8); ctx.restore();
        }
        const effects = game.rules.water?.effects || [];
        const heading = solid ? '水 → 石張りの通路' : frozen ? '水 → 氷の通路' : sealed ? '封印された水' : '水';
        const description = effects.length ? effects.map(id => EFFECT_LABELS[id]).join(' / ') : sealed ? '凍結・固体化は封印中' : 'そのままでは渡れません';
        const vertical = river.h > river.w;
        const caption = vertical ? solid ? '水：固体化' : frozen ? '水：凍結' : sealed ? '水：封印中' : '水' : heading + '  ·  ' + description;
        pill(caption, centre.x, vertical ? river.y + 10 : river.y + river.h - 29, solid || frozen ? '#375951df' : '#1e5269e8', '#fff8d7', vertical ? 11 : 12);
        if (sealed && !frozen && !solid) {
          // A lock at each bank identifies the stage restriction visually.
          for (const x of [river.x + 23, river.x + river.w - 23]) {
            rect(x - 7, centre.y - 2, 14, 13, '#d3d6b4', 3);
            ring(x, centre.y - 3, 5, '#d3d6b4', 3);
          }
        }
      }
    }

    function drawLight(game, target, x, y, radius, time) {
      const glowing = E.has(game, target, 'glow'), pulsing = E.has(game, target, 'pulse');
      if (!glowing && !pulsing) return;
      const brightness = pulsing && !reducedMotion ? .58 + .32 * Math.sin(time * 3) : .8;
      halo(x, y, radius, `rgba(255,238,136,${brightness})`);
      ring(x, y, radius * .45, '#fff2a1bb', 2.3);
      if (pulsing) {
        for (let index = 0; index < 3; index++) {
          const phase = reducedMotion ? (index + 1) / 4 : ((time * .4 + index / 3) % 1);
          ring(x, y, radius * (.3 + phase * .7), `rgba(255,240,153,${.75 * (1 - phase)})`, 2.3);
        }
      }
      if (glowing) {
        for (let index = 0; index < 8; index++) {
          const angle = index * Math.PI / 4 + (reducedMotion ? 0 : time * .22);
          const distance = radius * (.62 + .05 * Math.sin(time * 2 + index));
          diamond(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, 3, '#fff4b3');
        }
      }
    }
    function drawTargetBadges(game, target, x, y) {
      const effects = game.rules[target]?.effects || [];
      let title = TARGET_LABELS[target];
      if ((target === 'stone' || target === 'tree') && E.isBridge(game, target)) title += E.has(game, target, 'rotate') ? 'の足場 ↔' : 'の足場 ↕';
      else if (E.has(game, target, 'float')) title += '  ↑ 浮遊中';
      const top = E.clamp(y, 151, effects.length ? 602 : 626);
      const height = effects.length ? 52 : 25;
      // Keep the player visible when carrying an object or standing below its label.
      const nearPlayer = Math.abs(game.player.x - x) < 95 && game.player.y + 16 > top && game.player.y - 16 < top + height;
      const badgeX = nearPlayer ? x + (x > 435 ? -130 : 130) : x;
      pill(title, badgeX, top, '#264b3fe8', '#fff4d5', 13);
      if (effects.length) pill(effects.map(id => EFFECT_LABELS[id]).join(' / '), badgeX, top + 27, '#fff4d5e8', '#375644', 12);
    }
    function drawBridges(game, selectedTarget, time) {
      for (const target of ['stone', 'tree']) {
        if (!E.isBridge(game, target)) continue;
        const deck = E.bridgeGeometry(game, target);
        rect(deck.x - 4, deck.y + 5, deck.w + 8, deck.h + 5, '#153d4d55', 8);
        drawLight(game, target, deck.x + deck.w / 2, deck.y + deck.h / 2, Math.max(deck.w, deck.h) * .66, time);
        rect(deck.x, deck.y, deck.w, deck.h, target === 'tree' ? '#b9945f' : '#aebcac', 6);
        const horizontal = deck.w > deck.h;
        const length = horizontal ? deck.w : deck.h;
        const colours = target === 'tree' ? ['#d1b780', '#c5a46b'] : ['#bac8b1', '#ccd4bd'];
        for (let offset = 7, row = 0; offset < length - 5; offset += 17, row++) {
          const size = Math.min(14, length - 4 - offset);
          const x = horizontal ? deck.x + offset : deck.x + 4;
          const y = horizontal ? deck.y + 4 : deck.y + offset;
          const width = horizontal ? size : deck.w - 8;
          const height = horizontal ? deck.h - 8 : size;
          rect(x, y, width, height, colours[row % 2], target === 'tree' ? 2 : 3);
          if (target === 'tree') {
            circle(x + 5, y + 5, 1.7, '#806244'); circle(x + width - 5, y + height - 5, 1.7, '#806244');
          } else if (horizontal) line(x + 3, y + 4, x + 3, y + height - 4, '#eff1d6', 1);
          else line(x + 5, y + 3, x + width - 5, y + 3, '#eff1d6', 1);
        }
        drawBridgeDirection(deck);
        const border = E.has(game, target, 'glow') ? '#fff3a2' : selectedTarget === target ? '#eaffbd' : '#60775b';
        ctx.save(); ctx.lineWidth = E.has(game, target, 'glow') ? 4 : 2; ctx.strokeStyle = border;
        ctx.beginPath(); ctx.roundRect(deck.x, deck.y, deck.w, deck.h, 6); ctx.stroke(); ctx.restore();
        drawTargetBadges(game, target, deck.x + deck.w / 2, deck.y + deck.h + 7);
      }
    }

    function drawBridgeDirection(deck) {
      // Use the engine's deck dimensions so direction and support always agree.
      const x = deck.x + deck.w / 2, y = deck.y + deck.h / 2;
      const horizontal = deck.w > deck.h;
      const dx = horizontal ? Math.min(deck.w / 2 - 9, 30) : 0;
      const dy = horizontal ? 0 : Math.min(deck.h / 2 - 9, 30);
      line(x - dx, y - dy, x + dx, y + dy, '#486451aa', 2);
      for (const side of [-1, 1]) {
        const endX = x + dx * side, endY = y + dy * side;
        if (horizontal) {
          line(endX, endY, endX - side * 6, endY - 5, '#486451aa', 2);
          line(endX, endY, endX - side * 6, endY + 5, '#486451aa', 2);
        } else {
          line(endX, endY, endX - 5, endY - side * 6, '#486451aa', 2);
          line(endX, endY, endX + 5, endY - side * 6, '#486451aa', 2);
        }
      }
    }

    function drawSizeAndDirection(game, target, geometry) {
      if (E.has(game, target, 'shrink')) {
        // A dashed outline lets a small object remain identifiable next to its shadow.
        const radius = target === 'stone' ? 20 : 34;
        const y = geometry.y - (target === 'tree' ? 57 * geometry.scale : 0);
        ring(geometry.x, y, radius, '#f5f0b380', 1.4, true);
        for (const side of [-1, 1]) {
          const x = geometry.x + side * (radius + 7);
          line(x, y, x - side * 6, y, '#f7efb7', 1.7);
          line(x - side * 6, y, x - side * 2, y - 4, '#f7efb7', 1.7);
          line(x - side * 6, y, x - side * 2, y + 4, '#f7efb7', 1.7);
        }
      }
      if (E.has(game, target, 'rotate')) {
        const x = geometry.x, y = geometry.y - (target === 'tree' ? 57 * geometry.scale : 0);
        word('↔', x, Math.max(117, y - geometry.radius - 24), 19, '#fff4bd', 'center');
      }
    }

    function drawWallsAndGoal(game, theme, time) {
      for (const wall of game.level.walls) {
        rect(wall.x, wall.y + 5, wall.w, wall.h, '#203d4255', 3);
        rect(wall.x, wall.y, wall.w, wall.h, theme.wall, 3);
        for (let x = wall.x; x < wall.x + wall.w; x += 39) {
          const width = Math.min(37, wall.x + wall.w - x);
          if (width > 5) rect(x + 2, wall.y + 2, width - 4, 4, '#e2e8c180', 1);
          line(x, wall.y + 6, x, wall.y + wall.h - 2, '#35594870', 1);
        }
      }
      const goal = game.level.goal;
      rect(goal.x - 4, goal.y - 4, goal.w + 8, goal.h + 8, '#536f5c', 10);
      rect(goal.x, goal.y, goal.w, goal.h, '#e6e5b9', 7);
      rect(goal.x + 7, goal.y + 7, goal.w - 14, goal.h - 14, '#d4dfa9', 5);
      word('GOAL', goal.x + goal.w / 2, goal.y + 21, 24, '#3b6048', 'center');
      if (game.gateOpen) halo(goal.x + goal.w / 2, goal.y + goal.h / 2, 75, '#f4f3a866');
      const gate = game.level.gate;
      if (game.gateOpen) {
        rect(gate.x, gate.y, gate.w, gate.h, theme.path);
        for (let index = 0; index < 4; index++) {
          const x = gate.x + gate.w * (index + .5) / 4;
          diamond(x, gate.y + gate.h / 2, 4, '#f8edbd');
        }
        pill('開放', gate.x + gate.w / 2, gate.y - 31, '#3c7654e8');
        return;
      }
      rect(gate.x, gate.y, gate.w, gate.h, '#8c7352', 4);
      for (let x = gate.x + 6; x < gate.x + gate.w - 3; x += 15) rect(x, gate.y + 1, 5, gate.h - 2, game.heating ? '#ffe0a1' : '#d4b173', 2);
      if (game.gateHeat > 0) {
        halo(gate.x + gate.w / 2, gate.y + gate.h / 2, gate.w * .65, `rgba(248,132,59,${game.gateHeat * .72})`);
        rect(gate.x, gate.y + gate.h + 7, gate.w, 8, '#37534c', 4);
        rect(gate.x, gate.y + gate.h + 7, gate.w * game.gateHeat, 8, '#ffbe65', 4);
      }
      const sensorCount = Object.values(game.sensorLit).filter(Boolean).length;
      let status = !game.core ? '結晶が必要' : sensorCount < game.level.sensors.length ? `装置 ${sensorCount}/${game.level.sensors.length}` : game.level.gateMode === 'sensors' ? '装置を確認中' : 'E長押しで加熱';
      if (game.heating) status = '加熱 ' + Math.round(game.gateHeat * 100) + '%';
      pill(status, gate.x + gate.w / 2, gate.y - 32, game.heating ? '#a85d34ee' : '#425d4ce8');
      if (game.heating) {
        const centre = { x: gate.x + gate.w / 2, y: gate.y + gate.h / 2 };
        line(game.player.x, game.player.y - 8, centre.x, centre.y, '#ffd489bb', 8);
        line(game.player.x, game.player.y - 8, centre.x, centre.y, '#fff6c5', 2);
        for (let index = 0; index < 8; index++) {
          const phase = reducedMotion ? index / 8 : (time * .8 + index / 8) % 1;
          const x = game.player.x + (centre.x - game.player.x) * phase;
          const y = game.player.y - 8 + (centre.y - game.player.y + 8) * phase;
          diamond(x, y, 3, '#fff1ad');
        }
      }
    }

    function targetPoint(game, target) {
      if (target === 'water') return waterCentre(game);
      if (target === 'fire') return E.fireGeometry(game);
      if (E.isBridge(game, target)) {
        const deck = E.bridgeGeometry(game, target);
        return { x: deck.x + deck.w / 2, y: deck.y + deck.h / 2 };
      }
      const geometry = E.objectGeometry(game, target);
      if (target === 'tree') return { x: geometry.x, y: geometry.y - 57 * geometry.scale };
      return geometry;
    }
    function drawSensors(game, time) {
      for (const sensor of game.level.sensors) {
        const lit = Boolean(game.sensorLit[sensor.id]);
        const charge = E.clamp(game.sensorCharge[sensor.id] || 0, 0, 1);
        const colour = lit ? '#b9f3b7' : charge > 0 ? '#ffe3a0' : '#c9d3c0';
        circle(sensor.x, sensor.y + 4, 26, '#1c48464d');
        circle(sensor.x, sensor.y, 25, '#3f5e59');
        ring(sensor.x, sensor.y, 21, colour, 3);
        ring(sensor.x, sensor.y, sensor.radius, lit ? '#d7edba55' : '#d7e7bd77', 1.4, true);
        if (charge > 0) {
          ctx.save(); ctx.strokeStyle = '#ffe4a2'; ctx.lineWidth = 5; ctx.beginPath();
          ctx.arc(sensor.x, sensor.y, 29, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge); ctx.stroke(); ctx.restore();
        }
        if (lit) {
          halo(sensor.x, sensor.y, 64, '#c3f4a467');
          line(sensor.x - 9, sensor.y, sensor.x - 2, sensor.y + 7, '#e8ffd1', 3);
          line(sensor.x - 2, sensor.y + 7, sensor.x + 11, sensor.y - 8, '#e8ffd1', 3);
        } else {
          const icon = sensor.target === 'water' ? '◈' : sensor.requires.includes('pulse') ? '◎' : sensor.requires.includes('rotate') ? '↔' : sensor.requires.includes('shrink') ? '↘' : sensor.requires.includes('grow') ? '↗' : '✦';
          word(icon, sensor.x, sensor.y - 12, 25, colour, 'center');
        }
        const target = sensor.target === 'water' ? game.player : game[sensor.target];
        const active = E.sensorActive ? E.sensorActive(game, sensor) : sensor.requires.every(effect => E.has(game, sensor.target, effect)) && E.distance(target, sensor) <= sensor.radius;
        if (active) {
          const from = sensor.target === 'water' ? game.player : targetPoint(game, sensor.target);
          line(from.x, from.y, sensor.x, sensor.y, lit ? '#e8ffc780' : '#ffe4a2c0', 3, !lit);
          if (sensor.requires.includes('pulse')) ring(sensor.x, sensor.y, 32 + (reducedMotion ? 8 : (time * 18) % 20), '#ffeab67a', 2);
        }
        const shortName = sensor.label || '紋章';
        const requirements = TARGET_LABELS[sensor.target] + '：' + sensor.requires.map(id => EFFECT_LABELS[id]).join('＋') + (sensor.waterEffect ? '／水：' + EFFECT_LABELS[sensor.waterEffect] : '');
        const caption = lit ? shortName + (sensor.mode === 'hold' ? ' 維持中' : ' ✓') : requirements;
        pill(caption, sensor.x, sensor.y + 32, lit ? '#306b4be8' : '#354f4ee8', '#fff2ce', 11);
        if (sensor.mode === 'hold') pill('離すと消灯・同時に点灯', sensor.x, sensor.y + 57, '#f0ead7e8', '#4e664c', 10);
        else if (sensor.pulsed) {
          const receiving = E.pulseHigh ? E.pulseHigh(game) : Math.sin(game.elapsed * 3) > .45;
          pill(lit ? '受信完了' : receiving ? '脈動：受信する時間' : '脈動：次の波を待つ', sensor.x, sensor.y + 57, '#f0ead7e8', '#4e664c', 10);
        } else if (sensor.target === 'water') pill('プレイヤーが円へ入る', sensor.x, sensor.y + 57, '#f0ead7e8', '#4e664c', 10);
      }
    }

    function drawCollectibles(game, time) {
      if (!game.core) {
        const core = game.level.core;
        const bob = reducedMotion ? 0 : Math.sin(time * 2.8) * 4;
        halo(core.x, core.y, 43, '#a2ebf2a0');
        diamond(core.x, core.y + bob, 20, '#6bc5df', '#e9ffff');
        line(core.x, core.y - 14 + bob, core.x - 5, core.y + 3 + bob, '#ffffffaa', 2);
        pill('結晶', core.x, core.y + 25, '#235e70e8', '#eefcde', 12);
      }
      game.level.shards.forEach((shard, index) => {
        if (game.collectedShards[index]) return;
        const bob = reducedMotion ? 0 : Math.sin(time * 2.4 + index) * 3;
        halo(shard.x, shard.y, 24, '#ffe8a766');
        diamond(shard.x, shard.y + bob, 10, '#f7d985', '#fff3c7');
        ring(shard.x, shard.y, 17, '#f0dea970', 1, true);
      });
    }

    function latestRuleEvent(game, target) {
      return [...game.events].reverse().find(event => event.type === 'rule' && event.target === target && game.elapsed - event.time < 1.5);
    }
    function floatingMarks(game, target, geometry, time) {
      if (!E.has(game, target, 'float')) return;
      const object = game[target];
      line(object.x, object.y - 1, geometry.x, geometry.y + 6, '#e5f2b4a6', 1.7, true);
      for (const side of [-1, 1]) {
        const x = object.x + side * (target === 'stone' ? geometry.radius + 11 : 31 * geometry.scale + 11);
        const y = geometry.y + (reducedMotion ? -4 : Math.sin(time * 2 + side) * 6) - 3;
        line(x, y + 10, x, y - 6, '#e7f8b9', 2);
        line(x, y - 6, x - 4, y - 1, '#e7f8b9', 2);
        line(x, y - 6, x + 4, y - 1, '#e7f8b9', 2);
      }
      ring(object.x, object.y + 6, 21, '#d9ecb478', 1.4, true);
    }
    function drawStone(game, selectedTarget, geometry, time) {
      const stone = game.stone;
      const glowing = E.has(game, 'stone', 'glow');
      ctx.save();
      ctx.fillStyle = '#1e464866'; ctx.beginPath(); ctx.ellipse(stone.x, stone.y + 7, geometry.radius * 1.08, E.has(game, 'stone', 'float') ? 7 : 11, 0, 0, Math.PI * 2); ctx.fill();
      floatingMarks(game, 'stone', geometry, time);
      drawLight(game, 'stone', geometry.x, geometry.y, geometry.radius + 58, time);
      if (E.has(game, 'stone', 'grow') && latestRuleEvent(game, 'stone')) ring(geometry.x, geometry.y, 20, '#ffffffc0', 1.8, true);
      // The disc boundary is exactly the collision radius returned by the engine.
      circle(geometry.x, geometry.y, geometry.radius, '#a8b8a7');
      ctx.strokeStyle = glowing ? '#fff3ac' : '#587266'; ctx.lineWidth = glowing ? 3.5 : 2; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(geometry.x - geometry.radius * .65, geometry.y - 2);
      ctx.lineTo(geometry.x - geometry.radius * .12, geometry.y - geometry.radius * .68);
      ctx.lineTo(geometry.x + geometry.radius * .65, geometry.y - 3);
      ctx.strokeStyle = '#e4ead5'; ctx.lineWidth = 2; ctx.stroke();
      line(geometry.x - geometry.radius * .35, geometry.y + geometry.radius * .65, geometry.x + geometry.radius * .5, geometry.y + geometry.radius * .35, '#7f998b', 2);
      if (selectedTarget === 'stone') ring(geometry.x, geometry.y, geometry.radius + 8, '#f4f9c7', 1.7, true);
      drawSizeAndDirection(game, 'stone', geometry);
      drawTargetBadges(game, 'stone', stone.x, stone.y + geometry.radius + 15);
      ctx.restore();
    }
    function drawTree(game, selectedTarget, geometry, time) {
      const tree = game.tree, scale = geometry.scale;
      const top = geometry.y - 57 * scale;
      ctx.save();
      ctx.fillStyle = '#1e464858'; ctx.beginPath(); ctx.ellipse(tree.x, tree.y + 8, 28 * scale, E.has(game, 'tree', 'float') ? 8 : 13, 0, 0, Math.PI * 2); ctx.fill();
      floatingMarks(game, 'tree', geometry, time);
      drawLight(game, 'tree', geometry.x, top, 60 * scale + 22, time);
      if (E.has(game, 'tree', 'grow') && latestRuleEvent(game, 'tree')) {
        ring(geometry.x, geometry.y - 57, 34, '#ffffd1c0', 1.8, true);
        line(geometry.x - 8, geometry.y - 23, geometry.x + 8, geometry.y - 23, '#ffffd1aa', 1.5, true);
      }
      rect(geometry.x - 8 * scale, geometry.y - 55 * scale, 16 * scale, 55 * scale, '#94714e', 3);
      line(geometry.x + 3, geometry.y - 40 * scale, geometry.x + 3, geometry.y - 4, '#b79666', 2);
      circle(geometry.x, top, 34 * scale, '#39754e');
      circle(geometry.x - 13 * scale, geometry.y - 67 * scale, 19 * scale, '#589353');
      circle(geometry.x + 13 * scale, geometry.y - 73 * scale, 18 * scale, '#81ab63');
      if (E.has(game, 'tree', 'glow')) ring(geometry.x, top, 34 * scale + 2, '#fff1a5', 3.5);
      for (let index = 0; index < 4; index++) {
        const angle = index * Math.PI / 2 + .4;
        circle(geometry.x + Math.cos(angle) * 21 * scale, top + Math.sin(angle) * 17 * scale, 3 * scale, '#c7d989');
      }
      if (selectedTarget === 'tree') ring(geometry.x, top, 39 * scale, '#f4f9c7', 1.7, true);
      drawSizeAndDirection(game, 'tree', geometry);
      drawTargetBadges(game, 'tree', tree.x, tree.y + 17);
      ctx.restore();
    }

    function drawFire(game, selectedTarget, time) {
      const fire = E.fireGeometry(game);
      const original = game.level.fire;
      const moving = E.has(game, 'fire', 'move'), floating = E.has(game, 'fire', 'float'), heated = E.has(game, 'fire', 'heat');
      if (moving) {
        line(original.x - 52, fire.y + fire.radius + 17, original.x + 52, fire.y + fire.radius + 17, '#f5d2a591', 2, true);
        for (const direction of [-1, 1]) {
          const x = original.x + direction * 52;
          line(x, fire.y + fire.radius + 17, x - direction * 7, fire.y + fire.radius + 12, '#fff0b3', 2);
          line(x, fire.y + fire.radius + 17, x - direction * 7, fire.y + fire.radius + 22, '#fff0b3', 2);
        }
        if (!reducedMotion) {
          for (let index = 4; index > 0; index--) {
            const earlier = E.fireGeometry({ ...game, elapsed: Math.max(0, game.elapsed - index * .12) });
            circle(earlier.x, earlier.y, earlier.radius * .8, `rgba(238,148,78,${.04 + (4 - index) * .03})`);
          }
        }
      }
      if (floating) {
        line(fire.x, original.y + 8, fire.x, fire.y + fire.radius, '#e8dcb58c', 1.8, true);
        ring(fire.x, original.y + 8, 17, '#e7e9c37d', 1.5, true);
      }
      drawLight(game, 'fire', fire.x, fire.y, fire.radius + 53, time);
      if (fire.extinguished) {
        halo(fire.x, fire.y, fire.radius + 28, '#afdbed88');
        circle(fire.x, fire.y, fire.radius, '#769baf');
        ring(fire.x, fire.y, fire.radius, '#e3f3ef', 2);
        snowflake(fire.x, fire.y, fire.radius * .6, '#eafbff');
        for (let index = 0; index < 3; index++) circle(fire.x + (index - 1) * 9, fire.y - fire.radius - 9 - index % 2 * 5, 4, '#d4e3e078');
      } else {
        halo(fire.x, fire.y, fire.radius + (heated ? 54 : 28), heated ? '#fa733d9c' : '#ffd07999');
        circle(fire.x, fire.y, fire.radius, heated ? '#d6522f' : '#d67b3c');
        ring(fire.x, fire.y, fire.radius, heated ? '#ffd37a' : '#f6c16a', heated ? 3 : 1.8);
        circle(fire.x, fire.y + 3, fire.radius * .68, heated ? '#ffad44' : '#f4c164');
        circle(fire.x - fire.radius * .1, fire.y + fire.radius * .22, fire.radius * .33, '#fff2b4');
        if (heated) {
          for (let index = 0; index < 7; index++) {
            const phase = reducedMotion ? index / 7 : (time * .5 + index / 7) % 1;
            const angle = index * 2.4;
            diamond(fire.x + Math.sin(angle) * (fire.radius + 4) * .9, fire.y - fire.radius - phase * 33, 2.5, '#ffe6a1');
          }
        }
      }
      if (selectedTarget === 'fire') ring(fire.x, fire.y, fire.radius + 8, '#f8f5c0', 1.7, true);
      drawTargetBadges(game, 'fire', fire.x, Math.min(626, fire.y + fire.radius + (moving ? 30 : 15)));
    }

    function drawPlayer(game) {
      const player = game.player;
      ctx.fillStyle = '#1f434c66'; ctx.beginPath(); ctx.ellipse(player.x, player.y + 10, 15, 6, 0, 0, Math.PI * 2); ctx.fill();
      circle(player.x, player.y, 13, '#f5d398');
      ring(player.x, player.y, 13, '#685c3b', 2);
      rect(player.x - 9, player.y - 3, 18, 5, '#547d6a', 2);
      circle(player.x, player.y - 6, 4, '#fff3ce');
    }
    function drawEvents(game, time) {
      for (const event of game.events) {
        const age = game.elapsed - event.time;
        if (age < 0 || age > 2.3) continue;
        let point = { x: event.x, y: event.y };
        if (event.target && event.type === 'rule') point = targetPoint(game, event.target);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const alpha = E.clamp(1 - age / 2.3, 0, 1);
        if (event.type === 'rule') {
          const radius = reducedMotion ? 55 : 24 + age * 50;
          ring(point.x, point.y, radius, `rgba(255,250,187,${alpha})`, 3);
          ring(point.x, point.y, reducedMotion ? 67 : 38 + age * 53, `rgba(198,242,207,${alpha * .7})`, 2);
          if (!reducedMotion && age < .7) line(game.player.x, game.player.y - 8, point.x, point.y, `rgba(255,244,178,${alpha * .6})`, 2, true);
          const message = event.label || '定義を適用';
          pill(message, point.x, E.clamp(point.y - 105 - (reducedMotion ? 0 : age * 8), 170, 590), `rgba(40,87,63,${.92 * alpha})`, '#fff7c8');
        } else if (event.type === 'shard' || event.type === 'core' || event.type === 'sensor' || event.type === 'gate') {
          const radius = reducedMotion ? 30 : 10 + age * 38;
          ring(point.x, point.y, radius, event.type === 'core' ? `rgba(169,242,255,${alpha})` : `rgba(255,239,171,${alpha})`, 3);
          for (let index = 0; index < 8; index++) {
            const angle = index * Math.PI / 4;
            diamond(point.x + Math.cos(angle) * radius, point.y + Math.sin(angle) * radius, 3, `rgba(255,242,183,${alpha})`);
          }
        }
      }
      if (game.damageUntil > game.elapsed) pill('炎に触れた！ 安全な岸へ戻ります', 435, 198, '#965947eb');
      if (game.complete) {
        for (let index = 0; index < 24; index++) {
          const x = 90 + index * 137 % 690;
          const y = 125 + (index * 71 + time * 18) % 470;
          diamond(x, y, index % 2 ? 3 : 4, '#fff0a7bd');
        }
      }
    }

    function drawHintMarker(point, time) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const x = E.clamp(point.x, 82, 788), y = E.clamp(point.y, 147, 624);
      const bob = reducedMotion ? 0 : Math.sin(time * 3) * 4;
      ring(x, y, 25, '#fff7b7', 3);
      ring(x, y, 32, '#304c3ce0', 2, true);
      ctx.fillStyle = '#fff2a3'; ctx.beginPath();
      ctx.moveTo(x, y - 31 + bob); ctx.lineTo(x - 9, y - 45 + bob); ctx.lineTo(x + 9, y - 45 + bob); ctx.closePath(); ctx.fill();
      pill('目印：' + point.label, x, E.clamp(y - 77 + bob, 118, 560), '#694f24ed', '#fff8d2', 13);
    }

    function mysteryLabel(value, x, y, options = {}) {
      const size = options.size || 13;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      const width = ctx.measureText(value).width + 16;
      const left = options.align === 'left' ? x : x - width / 2;
      rect(left, y, width, size + 10, options.colour || '#173d39ed', 4);
      word(value, left + width / 2, y + 4, size, options.ink || '#fff8d7', 'center');
    }
    function sameRectangle(a, b) {
      return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    }
    function mysteryWaterState(game, river, physical) {
      const present = physical.rivers.some(active => active.id && river.id ? active.id === river.id : sameRectangle(active, river));
      if (!present) return 'dry';
      if (E.has(game, 'water', 'freeze')) return 'ice';
      if (E.has(game, 'water', 'solidify')) return 'solid';
      return 'water';
    }
    function mysteryWater(game, physical, time) {
      for (const river of game.level.rivers) {
        const state = mysteryWaterState(game, river, physical);
        rect(river.x - 4, river.y - 4, river.w + 8, river.h + 8, '#496d62', 5);
        rect(river.x, river.y, river.w, river.h, state === 'dry' ? '#a59774' : state === 'ice' ? '#c3e8e8' : state === 'solid' ? '#a9b5a3' : '#397d98', 2);
        if (state === 'dry') {
          for (let x = river.x + 16; x < river.x + river.w; x += 47) {
            for (let y = river.y + 15; y < river.y + river.h; y += 38) line(x - 6, y, x + 6, y + 3, '#776b51', 1.5);
          }
        } else if (state === 'solid') {
          for (let x = river.x + 4; x < river.x + river.w - 2; x += 42) {
            for (let y = river.y + 3; y < river.y + river.h - 2; y += 28) {
              rect(x, y, Math.max(1, Math.min(38, river.x + river.w - x - 2)), Math.max(1, Math.min(24, river.y + river.h - y - 2)), '#d0d3b7', 2);
            }
          }
        } else if (state === 'ice') {
          for (let x = river.x + 22; x < river.x + river.w; x += 74) {
            for (let y = river.y + 20; y < river.y + river.h; y += 62) snowflake(x, y, 9, '#6198a6');
          }
          line(river.x + 4, river.y + 5, river.x + river.w - 4, river.y + 5, '#effff7', 3);
        } else {
          const direction = river.flow || river.direction;
          const horizontal = direction === 'left' || direction === 'right' || (!['up', 'down'].includes(direction) && river.w >= river.h);
          const sign = ['left', 'up'].includes(direction) ? -1 : 1;
          const length = horizontal ? river.w : river.h;
          const phase = physical.flowing && !reducedMotion ? (time * 22) % 78 : 0;
          for (let distance = 25 + phase; distance < length - 12; distance += 78) {
            const at = sign > 0 ? distance : length - distance;
            const x = horizontal ? river.x + at : river.x + river.w / 2;
            const y = horizontal ? river.y + river.h / 2 : river.y + at;
            if (physical.flowing) {
              line(x - (horizontal ? 14 : 0), y - (horizontal ? 0 : 14), x + (horizontal ? 14 : 0), y + (horizontal ? 0 : 14), '#b0dce8', 2);
              if (horizontal) { line(x + 14 * sign, y, x + 7 * sign, y - 5, '#b0dce8', 2); line(x + 14 * sign, y, x + 7 * sign, y + 5, '#b0dce8', 2); }
              else { line(x, y + 14 * sign, x - 5, y + 7 * sign, '#b0dce8', 2); line(x, y + 14 * sign, x + 5, y + 7 * sign, '#b0dce8', 2); }
            } else line(x - 13, y, x + 13, y, '#a7ccda88', 1.5);
          }
        }
      }
    }
    function mysteryConnections(game, physical, time) {
      for (const connection of game.level.connections || []) {
        const from = connection.from, to = connection.to;
        if (!from || !to) continue;
        const points = connection.points || [from, { x: to.x, y: from.y }, to];
        const active = physical.activeConnections?.[connection.id] ?? (connection.activeKey ? physical.activeMechanisms?.[connection.activeKey] : connection.route ? physical.flowing && physical.flowRoute === connection.route : connection.kind === 'water' ? physical.flowing : false);
        for (let index = 1; index < points.length; index++) {
          const a = points[index - 1], b = points[index];
          line(a.x, a.y, b.x, b.y, connection.kind === 'water' ? '#244f55' : '#465c43', connection.kind === 'water' ? 12 : 6);
          line(a.x, a.y, b.x, b.y, active ? connection.kind === 'water' ? '#80c6d5' : '#e5d78f' : '#879382', connection.kind === 'water' ? 5 : 2);
          if (!active) continue;
          const length = Math.hypot(b.x - a.x, b.y - a.y);
          const phase = reducedMotion ? 20 : time * 28 % 66;
          for (let at = phase; at < length; at += 66) circle(a.x + (b.x - a.x) * at / Math.max(1, length), a.y + (b.y - a.y) * at / Math.max(1, length), 2.5, '#f8f0b9');
        }
      }
    }
    function mysteryWalls(level, physical) {
      for (const wall of level.walls) {
        rect(wall.x, wall.y + 6, wall.w, wall.h, '#17393466', 3);
        rect(wall.x, wall.y, wall.w, wall.h, '#819184', 3);
        line(wall.x + 3, wall.y + 3, wall.x + wall.w - 3, wall.y + 3, '#c0c8a8', 2);
      }
      for (const door of level.doors || []) {
        const open = physical.doorStates?.[door.id] ?? !physical.walls.some(wall => sameRectangle(wall, door));
        rect(door.x, door.y, door.w, door.h, open ? '#90b68344' : '#8f704d', 3);
        const horizontal = door.w > door.h;
        if (open) {
          const x = door.x + door.w / 2, y = door.y + door.h / 2;
          if (horizontal) line(door.x, y, door.x + door.w, y, '#c6df9b', 2, true);
          else line(x, door.y, x, door.y + door.h, '#c6df9b', 2, true);
        } else if (horizontal) {
          for (let x = door.x + 8; x < door.x + door.w; x += 19) line(x, door.y + 2, x, door.y + door.h - 2, '#dfc69a', 4);
        } else {
          for (let y = door.y + 8; y < door.y + door.h; y += 19) line(door.x + 2, y, door.x + door.w - 2, y, '#dfc69a', 4);
        }
      }
    }
    function mysteryObject(game, target, selectedTarget, time) {
      const geometry = E.objectGeometry(game, target), object = game[target];
      if (E.isBridge(game, target)) {
        const deck = E.bridgeGeometry(game, target);
        rect(deck.x, deck.y + 4, deck.w, deck.h, '#17393466', 5);
        rect(deck.x, deck.y, deck.w, deck.h, target === 'tree' ? '#c6a16c' : '#b5bfa9', 5);
        drawBridgeDirection(deck);
      } else {
        ctx.fillStyle = '#17393455'; ctx.beginPath(); ctx.ellipse(object.x, object.y + 7, geometry.radius * .9, 7 * geometry.scale, 0, 0, Math.PI * 2); ctx.fill();
        if (E.has(game, target, 'glow')) halo(geometry.x, geometry.y, 93 * geometry.scale, '#e9e79880');
        if (E.has(game, target, 'pulse')) ring(geometry.x, geometry.y, geometry.radius + 15 + (reducedMotion ? 0 : time * 15 % 35), '#fae8ad80', 2);
        if (geometry.floatOffset) line(object.x, object.y, geometry.x, geometry.y, '#f0e8bb88', 1.5, true);
        if (target === 'stone') {
          circle(geometry.x, geometry.y, geometry.radius, '#aab7a4'); ring(geometry.x, geometry.y, geometry.radius, '#d7dfbf', 2);
          line(geometry.x - geometry.radius * .6, geometry.y, geometry.x + geometry.radius * .3, geometry.y - geometry.radius * .5, '#dce4c5', 2);
        } else {
          rect(geometry.x - 7 * geometry.scale, geometry.y - 42 * geometry.scale, 14 * geometry.scale, 42 * geometry.scale, '#967143', 2);
          circle(geometry.x, geometry.y - 58 * geometry.scale, 35 * geometry.scale, '#6a9658');
          circle(geometry.x - 13 * geometry.scale, geometry.y - 72 * geometry.scale, 20 * geometry.scale, '#86ab68');
        }
        if (target === selectedTarget) ring(geometry.x, geometry.y, geometry.radius + 9, '#fff4b6', 1.8, true);
      }
      const effects = game.rules[target]?.effects || [];
      mysteryLabel(TARGET_LABELS[target] + (effects.length ? ' · ' + effects.map(id => EFFECT_LABELS[id]).join(' / ') : ' · 定義なし'), object.x, object.y + 24, { size: 11 });
    }
    function mysteryMechanism(game, mechanism, state, time, scale) {
      const active = Boolean(state?.active), x = mechanism.x, y = mechanism.y;
      const type = mechanism.type || 'lever';
      const colour = active ? '#d4e596' : '#9aab92';
      circle(x, y, 27, '#264e49'); ring(x, y, 27, colour, 2);
      if (/wheel|水車/.test(type)) {
        const angle = active && !reducedMotion ? time * 1.2 : 0;
        ring(x, y, 20, '#d7bc87', 4);
        for (let spoke = 0; spoke < 8; spoke++) {
          const a = angle + spoke * Math.PI / 4;
          line(x, y, x + Math.cos(a) * 21, y + Math.sin(a) * 21, '#bda271', 4);
        }
        circle(x, y, 5, '#f5e6b3');
        const charge = Math.max(0, Math.min(1, game.puzzle?.exitOpen ? 1 : game.puzzle?.powerCharge || 0));
        if (charge > 0) { ctx.strokeStyle = '#f4e59b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 32, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge); ctx.stroke(); }
      } else if (/plate|weight|重|床/.test(type)) {
        rect(x - 44, y - 32 + (active ? 5 : 0), 88, 64, active ? '#c1d293' : '#b0aa87', 6);
        ring(x, y, 48, active ? '#e4eea5' : '#b4bb93', 2);
        line(x - 35, y + 38, x + 35, y + 38, '#e2e6b8', 2);
      } else if (/rune|紋/.test(type)) {
        diamond(x, y, 17, active ? '#f0dda2' : '#7c9a91', '#d7e0bd');
        word(mechanism.symbol || mechanism.label?.slice(0, 1) || '◇', x, y - 10, 16, '#254d43', 'center');
      } else if (type === 'dam') {
        rect(x - 21, y - 20, 42, 40, active ? '#c4d1ac' : '#91a69b', 3);
        line(x - 19, y, x + 19, y, '#5c796d', 2); line(x, y - 19, x, y + 19, '#5c796d', 2);
        if (active) line(x - 29, y - 28, x + 29, y - 28, '#e9e2ac', 4);
      } else if (/root|根/.test(type)) {
        for (const side of [-1, 1]) { line(x, y + 12, x + side * 16, y - 15, '#b4c899', 3); line(x + side * 10, y - 3, x + side * 20, y - 8, '#b4c899', 2); }
      } else {
        rect(x - 14, y + 6, 28, 8, '#b5ad84', 3);
        line(x, y + 5, x + (active ? 12 : -12), y - 14, '#e4c88d', 5);
        circle(x + (active ? 12 : -12), y - 14, 5, active ? '#c7db93' : '#e4bc7d');
      }
      const near = E.distance(game.player, mechanism) < 76;
      if (near) ring(x, y, 35, '#f5e7a2', 1.5, true);
      mysteryLabel(mechanism.label || state?.label || type, x, y + 35, { size: 12 / scale, colour: active ? '#476644ee' : '#284a43ee' });
      if (near && ['lever', 'rune'].includes(type)) mysteryLabel('E', x + 30, y - 40, { size: 11 });
    }
    function mysteryClueVisible(game, clue, physical) {
      if (Array.isArray(physical.visibleClues)) return physical.visibleClues.includes(clue.id);
      if (!clue.reveal) return true;
      if (typeof clue.reveal === 'object') return E.has(game, clue.reveal.target || 'tree', clue.reveal.effect || 'glow');
      if (clue.reveal === 'dark') return !E.has(game, 'tree', 'glow');
      return E.has(game, 'tree', 'glow');
    }
    function mysteryMinimap(game, bounds, physical, camera, marker) {
      const x = 676, y = 18, width = 174, height = 116;
      const scale = Math.min((width - 12) / bounds.w, (height - 12) / bounds.h);
      const ox = x + (width - bounds.w * scale) / 2 - bounds.x * scale;
      const oy = y + (height - bounds.h * scale) / 2 - bounds.y * scale;
      rect(x, y, width, height, '#102f31ed', 7);
      rect(ox + bounds.x * scale, oy + bounds.y * scale, bounds.w * scale, bounds.h * scale, '#70876a');
      for (const river of game.level.rivers) rect(ox + river.x * scale, oy + river.y * scale, Math.max(1, river.w * scale), Math.max(1, river.h * scale), mysteryWaterState(game, river, physical) === 'dry' ? '#b1a47a' : '#5798b0');
      for (const wall of physical.walls) rect(ox + wall.x * scale, oy + wall.y * scale, Math.max(1, wall.w * scale), Math.max(1, wall.h * scale), '#cad1b1');
      for (const item of game.level.mechanisms || []) circle(ox + item.x * scale, oy + item.y * scale, 2.5, '#ecdaa1');
      const goal = game.level.goal; rect(ox + goal.x * scale, oy + goal.y * scale, Math.max(4, goal.w * scale), Math.max(4, goal.h * scale), '#d8e7a2');
      if (!game.core && game.level.core) diamond(ox + game.level.core.x * scale, oy + game.level.core.y * scale, 3.5, '#a5e7ef');
      if (marker) circle(ox + marker.x * scale, oy + marker.y * scale, 4, '#ffce6d');
      circle(ox + game.player.x * scale, oy + game.player.y * scale, 4, '#f9f4cb');
      ctx.strokeStyle = '#ffffdd'; ctx.lineWidth = 1;
      ctx.strokeRect(ox + camera.x * scale, oy + camera.y * scale, camera.w * scale, camera.h * scale);
      word('現在地 · Mで全体地図', x + width / 2, y + height + 5, 11, '#fff4cc', 'center');
    }
    function drawMystery(game, selectedTarget, hintMarker, viewOptions) {
      const bounds = E.worldBounds(game), physical = E.physicalState(game);
      const overview = Boolean(viewOptions?.overview), camera = cameraFor(bounds, game.player, overview);
      const time = reducedMotion ? 0 : game.elapsed;
      const theme = THEMES[game.level.theme] || THEMES.ruins;
      const status = E.puzzleStatus(game);
      const statuses = Array.isArray(status) ? status : status.mechanisms || [];
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); ctx.clearRect(0, 0, 870, 570);
      rect(0, 0, 870, 570, '#173b3b');
      ctx.save(); ctx.translate(camera.offsetX, camera.offsetY); ctx.scale(camera.scale, camera.scale); ctx.translate(-camera.x, -camera.y);
      rect(bounds.x, bounds.y, bounds.w, bounds.h, theme.ground, 8);
      for (const zone of game.level.zones || []) {
        rect(zone.x, zone.y, zone.w, zone.h, theme.path + '55', 10);
        word(zone.label, zone.x + 16, zone.y + 14, 15 / camera.scale, theme.ink);
      }
      for (let index = 0; index < 240; index++) {
        const x = bounds.x + 12 + index * 137 % (bounds.w - 24), y = bounds.y + 12 + index * 193 % (bounds.h - 24);
        rect(x, y, 5, 3, theme.grass + '50', 1);
      }
      mysteryWater(game, physical, time);
      mysteryConnections(game, physical, time);
      mysteryWalls(game.level, physical);
      const goal = game.level.goal;
      rect(goal.x, goal.y, goal.w, goal.h, game.gateOpen ? '#d3df9d' : '#9ca67f', 8);
      ring(goal.x + goal.w / 2, goal.y + goal.h / 2, Math.min(goal.w, goal.h) / 3, '#fff3ba', 2);
      word('GOAL', goal.x + goal.w / 2, goal.y + goal.h / 2 - 8, 15, '#355b43', 'center');
      for (const door of game.level.doors || []) mysteryLabel(door.label, door.x + door.w / 2, door.y - 30, { size: 11 / camera.scale, colour: '#24463de8' });
      for (const mechanism of game.level.mechanisms || []) {
        const state = statuses.find(item => item.id === mechanism.id) || {};
        mysteryMechanism(game, mechanism, { ...state, active: physical.activeMechanisms?.[mechanism.id] ?? state.active }, time, camera.scale);
      }
      for (const clue of game.level.clues || []) {
        const visible = mysteryClueVisible(game, clue, physical);
        if (visible && clue.reveal) halo(clue.x, clue.y, 38, '#e7df9f70');
        rect(clue.x - 16, clue.y - 22, 32, 40, visible ? '#b6b89b' : '#8b9988', 4);
        line(clue.x - 9, clue.y - 10, clue.x + 9, clue.y - 10, visible ? '#4f6955' : '#7d8c7b', 2);
        line(clue.x - 9, clue.y - 2, clue.x + 9, clue.y - 2, visible ? '#4f6955' : '#7d8c7b', 2);
        if (E.distance(game.player, clue) < 76) mysteryLabel('E · 調べる', clue.x, clue.y + 26, { size: 11 });
      }
      if (!game.core && game.level.core) {
        const core = game.level.core;
        halo(core.x, core.y, 32, '#a8edee60'); diamond(core.x, core.y, 14, '#9ddfeb', '#e4ffff');
        mysteryLabel('青い結晶', core.x, core.y + 24, { size: 11 });
      }
      for (const target of ['stone', 'tree']) mysteryObject(game, target, selectedTarget, time);
      if (game.level.fire && physical.fire !== false) {
        const fire = E.fireGeometry(game);
        if (fire.x >= bounds.x && fire.x <= bounds.x + bounds.w && fire.y >= bounds.y && fire.y <= bounds.y + bounds.h) {
          halo(fire.x, fire.y, fire.radius + 30, fire.extinguished ? '#b9e5eb66' : '#f4bd6488');
          circle(fire.x, fire.y, fire.radius, fire.extinguished ? '#79a8b2' : '#f0a34c');
          if (fire.extinguished) snowflake(fire.x, fire.y, 12, '#e5f7ed');
          else circle(fire.x, fire.y + 3, fire.radius * .5, '#ffe7a0');
        }
      }
      for (let index = 0; index < game.level.shards.length; index++) {
        if (!game.collectedShards[index]) { const point = game.level.shards[index]; diamond(point.x, point.y, 9, '#f4d588', '#fff4ba'); }
      }
      drawPlayer(game);
      if (hintMarker && Number.isFinite(hintMarker.x) && Number.isFinite(hintMarker.y)) {
        ring(hintMarker.x, hintMarker.y, 29, '#fff1a4', 3);
        line(hintMarker.x - 8, hintMarker.y - 41, hintMarker.x, hintMarker.y - 31, '#fff1a4', 3);
        line(hintMarker.x + 8, hintMarker.y - 41, hintMarker.x, hintMarker.y - 31, '#fff1a4', 3);
        mysteryLabel(hintMarker.label, hintMarker.x, hintMarker.y - 69, { size: 13 / camera.scale, colour: '#72572bf0' });
      }
      ctx.restore();
      mysteryLabel(overview ? '全体地図 · Mで探索へ' : game.level.name, 18, 15, { align: 'left', size: 15 });
      if (!overview) mysteryMinimap(game, bounds, physical, camera, hintMarker);
      else word('白い丸が現在地です。調べた手掛かりは手帳で確認できます。', 435, 546, 12, '#f3edc9', 'center');
      if (!overview && hintMarker && (hintMarker.x < camera.x || hintMarker.x > camera.x + camera.w || hintMarker.y < camera.y || hintMarker.y > camera.y + camera.h)) {
        mysteryLabel('目印は画面の外 · Mで全体地図', 435, 536, { size: 12, colour: '#6a542bea' });
      }
    }

    function draw(game, selectedTarget, hintMarker = null, viewOptions = {}) {
      if (game.level.mystery) { drawMystery(game, selectedTarget, hintMarker, viewOptions); return; }
      const theme = THEMES[game.level.theme] || THEMES.meadow;
      const time = reducedMotion ? 0 : game.elapsed;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.clearRect(0, 0, 870, 570);
      ctx.save();
      ctx.translate(0, -100);
      drawGround(game, theme);
      drawWater(game, selectedTarget, time, theme);
      drawBridges(game, selectedTarget, time);
      drawWallsAndGoal(game, theme, time);
      drawSensors(game, time);
      drawCollectibles(game, time);
      for (const target of ['stone', 'tree']) {
        if (E.isBridge(game, target)) continue;
        const geometry = E.objectGeometry(game, target);
        if (target === 'stone') drawStone(game, selectedTarget, geometry, time);
        else drawTree(game, selectedTarget, geometry, time);
      }
      drawFire(game, selectedTarget, time);
      drawPlayer(game);
      drawEvents(game, time);
      drawHintMarker(hintMarker, time);
      if (E.distance(game.player, game.level.spawn) < 50) word('START', game.level.spawn.x, Math.min(638, game.level.spawn.y + 36), 12, theme.ink, 'center');
      ctx.restore();
    }
    return { draw };
  }

  const api = { createRenderer, cameraFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinitionRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
