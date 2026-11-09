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
  const EFFECT_LABELS = { float: '浮遊', move: '移動', grow: '成長', glow: '発光', freeze: '凍結', solidify: '固体化', pulse: '脈動', heat: '加熱' };

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
        pill(heading + '  ·  ' + description, centre.x, river.y + river.h - 29, solid || frozen ? '#375951df' : '#1e5269e8');
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
      const brightness = pulsing && !reducedMotion ? .58 + .32 * Math.sin(time * 3.2) : .8;
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
      if ((target === 'stone' || target === 'tree') && E.isBridge(game, target)) title += 'の足場';
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
        for (let y = deck.y + 7, row = 0; y < deck.y + deck.h - 5; y += 17, row++) {
          const height = Math.min(14, deck.y + deck.h - 4 - y);
          if (target === 'tree') {
            rect(deck.x + 4, y, deck.w - 8, height, row % 2 ? '#c5a46b' : '#d1b780', 2);
            circle(deck.x + 9, y + 6, 1.7, '#806244'); circle(deck.x + deck.w - 9, y + 6, 1.7, '#806244');
          } else {
            rect(deck.x + 4, y, deck.w - 8, height, row % 2 ? '#ccd4bd' : '#bac8b1', 3);
            line(deck.x + 9, y + 3, deck.x + deck.w - 9, y + 3, '#eff1d6', 1);
          }
        }
        const border = E.has(game, target, 'glow') ? '#fff3a2' : selectedTarget === target ? '#eaffbd' : '#60775b';
        ctx.save(); ctx.lineWidth = E.has(game, target, 'glow') ? 4 : 2; ctx.strokeStyle = border;
        ctx.beginPath(); ctx.roundRect(deck.x, deck.y, deck.w, deck.h, 6); ctx.stroke(); ctx.restore();
        drawTargetBadges(game, target, deck.x + deck.w / 2, deck.y + deck.h + 7);
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
      let status = !game.core ? '結晶が必要' : sensorCount < game.level.sensors.length ? `紋章 ${sensorCount}/${game.level.sensors.length}` : 'E長押しで加熱';
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
          const icon = sensor.requires.includes('pulse') ? '◎' : sensor.requires.includes('grow') ? '↗' : '✦';
          word(icon, sensor.x, sensor.y - 12, 25, colour, 'center');
        }
        const target = game[sensor.target];
        const validEffects = sensor.requires.every(effect => E.has(game, sensor.target, effect));
        if (validEffects && E.distance(target, sensor) <= sensor.radius) {
          const from = targetPoint(game, sensor.target);
          line(from.x, from.y, sensor.x, sensor.y, lit ? '#e8ffc780' : '#ffe4a2c0', 3, !lit);
          if (sensor.requires.includes('pulse')) ring(sensor.x, sensor.y, 32 + (reducedMotion ? 8 : (time * 18) % 20), '#ffeab67a', 2);
        }
        const shortName = sensor.label || '紋章';
        const requirements = TARGET_LABELS[sensor.target] + '：' + sensor.requires.map(id => EFFECT_LABELS[id]).join('＋');
        pill(lit ? shortName + ' ✓' : requirements, sensor.x, sensor.y + 32, lit ? '#306b4be8' : '#354f4ee8', '#fff2ce', 11);
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
      rect(geometry.x - 8, geometry.y - 55 * scale, 16, 55 * scale, '#94714e', 3);
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
      if (game.damageUntil > game.elapsed) pill('炎に触れた！ スタートへ', 435, 198, '#965947eb');
      if (game.complete) {
        for (let index = 0; index < 24; index++) {
          const x = 90 + index * 137 % 690;
          const y = 125 + (index * 71 + time * 18) % 470;
          diamond(x, y, index % 2 ? 3 : 4, '#fff0a7bd');
        }
      }
    }

    function draw(game, selectedTarget) {
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
      if (E.distance(game.player, game.level.spawn) < 50) word('START', game.level.spawn.x, Math.min(638, game.level.spawn.y + 36), 12, theme.ink, 'center');
      ctx.restore();
    }
    return { draw };
  }

  const api = { createRenderer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinitionRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
