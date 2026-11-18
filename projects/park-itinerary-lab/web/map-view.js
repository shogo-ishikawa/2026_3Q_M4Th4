/** Offline geographic/illustrated maps and walking paths. */
import {displayMapPoint} from './map-display.js?v=1.12.0';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const categories = {attraction:'アトラクション', show:'ショー', parade:'パレード', restaurant:'レストラン', cafe:'カフェ', snack:'スナック', popcorn:'ポップコーン', greeting:'グリーティング', shop:'ショップ'};
const colours = {attraction:'#2759a2', show:'#8545a5', parade:'#8545a5', restaurant:'#b65025', cafe:'#b65025', snack:'#b65025', popcorn:'#b65025', greeting:'#b52e6b', shop:'#147969'};
const views = new WeakMap();
let renderNumber = 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Expand graph edges in the direction travelled; never bridge a missing edge. */
export function routeCoordinates(park, path) {
  const nodes = new Map(park.nodes.map(node => [node.id, node]));
  const edges = new Map();
  for (const edge of park.edges || []) {
    edges.set(`${edge.from}\0${edge.to}`, {edge, reverse:false});
    edges.set(`${edge.to}\0${edge.from}`, {edge, reverse:true});
  }
  const result = [];
  for (let index = 1; index < path.length; index++) {
    const segment = edges.get(`${path[index-1]}\0${path[index]}`);
    if (!segment) return [];
    const {edge, reverse} = segment;
    const from = nodes.get(path[index-1]), to = nodes.get(path[index]);
    if (!from || !to) return [];
    const geometry = Array.isArray(edge.geometry) ? edge.geometry : [[nodes.get(edge.from).x,nodes.get(edge.from).y],[nodes.get(edge.to).x,nodes.get(edge.to).y]];
    const oriented = reverse ? [...geometry].reverse() : geometry;
    if (oriented.length < 2 || oriented.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value)))) return [];
    if (Math.hypot(oriented[0][0]-from.x, oriented[0][1]-from.y) > .01 || Math.hypot(oriented.at(-1)[0]-to.x, oriented.at(-1)[1]-to.y) > .01) return [];
    result.push(...(result.length ? oriented.slice(1) : oriented));
  }
  return result;
}

/** Keep zoom centred inside the drawing. Values are independent of screen size. */
export function mapViewBox(scale = 1, x = 500, y = 500) {
  const zoom = clamp(Number.isFinite(scale) ? scale : 1, 1, 4);
  const size = 1000 / zoom;
  const left = clamp(Number.isFinite(x) ? x - size / 2 : 0, 0, 1000 - size);
  const top = clamp(Number.isFinite(y) ? y - size / 2 : 0, 0, 1000 - size);
  return [left, top, size, size];
}

/** `onSelect` receives the facility ID when a map pin is activated. */
export function renderParkMap(container, park, {plan = null, selectedIds = [], onSelect} = {}) {
  if (!container || !park || !Array.isArray(park.nodes) || !Array.isArray(park.activities)) throw new TypeError('地図を表示するパークを確認してください。');
  const nodeMap = new Map(park.nodes.map(node => {
    const [x,y] = displayMapPoint(park,[node.x,node.y]);
    return [node.id,{...node,x,y}];
  }));
  const selected = new Set(selectedIds), visits = plan?.visits || [];
  const visitNumbers = new Map(visits.map((visit, index) => [visit.activityId || visit.id, index + 1]));
  const view = views.get(container)?.parkId === park.id ? views.get(container) : {parkId:park.id, scale:1, x:500, y:500, onlySelected:false,filterSetByUser:false};
  if(visits.length && !view.filterSetByUser)view.onlySelected=true;
  views.set(container, view);
  const sea = park.id === 'sea', unique = `park-map-${++renderNumber}`;
  const point = coordinates => displayMapPoint(park,coordinates).join(',');
  // A faint full graph shows connections without competing with the illustration.
  const geographic = Boolean(park.geographicMap);
  const paths = (park.edges || []).filter(edge => nodeMap.has(edge.from) && nodeMap.has(edge.to)).map(edge => {
    const coordinates = routeCoordinates(park, [edge.from,edge.to]).map(point).join(' ');
    return `<polyline points="${coordinates}" fill="none" stroke="#fff" stroke-width="${geographic ? 4 : 7}" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${coordinates}" fill="none" stroke="#536b75" stroke-width="${geographic ? .8 : 1.4}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const routeRows = (plan?.rows || []).filter(row => (row.kind || row.type) === 'walk' && Array.isArray(row.path));
  const routes = routeRows.map(row => {
    // Old saved plans retain recorded distances in the schedule. Their former
    // schematic paths must not be drawn on the new geographic background.
    if (geographic && row.routeSource !== park.routeGraphVersion) return '';
    const points = routeCoordinates(park,row.path);
    if (points.length < 2) return '';
    const coordinates = points.map(point).join(' ');
    return `<g><polyline points="${coordinates}" fill="none" stroke="white" stroke-width="13" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${coordinates}" fill="none" stroke="${sea ? '#005b9a' : '#b42e43'}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"><title>${escape(row.name)} · 約${escape(Math.round(row.metres || 0))}m</title></polyline></g>`;
  }).join('');
  const byNode = new Map();
  for (const activity of park.activities) {
    if (!nodeMap.has(activity.node)) continue;
    if (!byNode.has(activity.node)) byNode.set(activity.node, []);
    byNode.get(activity.node).push(activity);
  }
  const positions = new Map();
  for (const [nodeId, activities] of byNode) {
    const node = nodeMap.get(nodeId);
    activities.forEach((activity, index) => {
      const angle = index * Math.PI * 2 / activities.length - Math.PI / 2;
      const radius = activities.length > 1 ? Math.min(24, 10 + activities.length * 2) : 0;
      positions.set(activity.id, {x:clamp(node.x + Math.cos(angle) * radius, 24, 976), y:clamp(node.y + Math.sin(angle) * radius, 24, 976)});
    });
  }
  // Place area names in consistent positions instead of on top of facility pins.
  const areaGroups = new Map();
  for (const activity of park.activities) {
    const node = nodeMap.get(activity.node);
    if (!node || !activity.area) continue;
    if (!areaGroups.has(activity.area)) areaGroups.set(activity.area, []);
    areaGroups.get(activity.area).push(node);
  }
  const areaLabels = [...areaGroups].map(([name, nodes]) => {
    const x = clamp(nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length, 130, 870);
    const y = clamp(Math.min(...nodes.map(node => node.y)) - 28, 26, 955);
    return `<text x="${x}" y="${y}" class="park-area">${escape(name)}</text>`;
  }).join('');
  const markers = park.activities.map(activity => {
    const pos = positions.get(activity.id); if (!pos) return '';
    const isSelected = selected.has(activity.id), number = visitNumbers.get(activity.id);
    const colour = colours[activity.category] || '#2759a2';
    const title = `${activity.name} / ${categories[activity.category] || activity.category}${number ? ` / 予定${number}` : ''}${isSelected ? ' / 選んで希望から外す' : ' / 選んで希望に追加'}`;
    const marker = number ? `<circle r="18" fill="${sea ? '#005b9a' : '#b42e43'}" stroke="white" stroke-width="3"/><text y="6" text-anchor="middle" font-size="19" font-weight="800" fill="white">${number}</text>` : `<circle r="${isSelected ? 11 : 5}" fill="${colour}" stroke="white" stroke-width="${isSelected ? 3 : 1.5}"/>${isSelected ? '<path d="M-5,0 L-1,4 L6,-5" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' : ''}`;
    const tooltipX = clamp(-125, -pos.x + 8, 1000 - pos.x - 258);
    const tooltipY = pos.y < 85 ? 28 : -63;
    return `<g class="park-pin${isSelected || number ? ' park-chosen' : ''}" role="button" tabindex="0" aria-label="${escape(title)}" aria-pressed="${isSelected}" data-activity-id="${escape(activity.id)}" transform="translate(${pos.x} ${pos.y})"><title>${escape(title)}</title><circle class="park-hit" r="22" fill="transparent"/>${marker}<g class="park-tooltip" pointer-events="none"><rect x="${tooltipX}" y="${tooltipY}" width="250" height="35" rx="8" fill="#15324e"/><text x="${tooltipX + 125}" y="${tooltipY + 23}" fill="white" font-size="15" text-anchor="middle">${escape(activity.name.length > 16 ? activity.name.slice(0, 16) + '…' : activity.name)}</text></g></g>`;
  }).join('');
  const entry = nodeMap.get(park.entryNode), exit = nodeMap.get(park.exitNode);
  const gates = [[entry, '入口'], ...(park.exitNode === park.entryNode ? [] : [[exit, '出口']])].filter(([node]) => node).map(([node, label]) => `<g transform="translate(${node.x} ${node.y})"><rect x="-24" y="-16" width="48" height="32" rx="8" fill="#15324e" stroke="white" stroke-width="3"/><text x="0" y="6" fill="white" text-anchor="middle" font-size="17" font-weight="700">${label}</text></g>`).join('');
  const breakRows = (plan?.rows || []).filter(row => (row.kind || row.type) === 'rest' && row.fixedBreakId && nodeMap.has(row.node));
  const breaks = breakRows.map(row => {const node = nodeMap.get(row.node);return `<g transform="translate(${node.x} ${node.y})"><circle r="17" fill="#147969" stroke="white" stroke-width="3"/><text y="6" fill="white" font-size="18" text-anchor="middle">休</text><title>${escape(row.name || '休憩')}</title></g>`;}).join('');
  const activities = new Map(park.activities.map(activity => [activity.id, activity]));
  const listed = visits.length ? visits.map(visit => activities.get(visit.activityId || visit.id)).filter(Boolean) : park.activities.filter(activity => selected.has(activity.id));
  const list = listed.map(activity => {
    const number = visitNumbers.get(activity.id), colour = colours[activity.category] || '#2759a2';
    return `<button type="button" class="park-location" data-focus-activity="${escape(activity.id)}"><span style="background:${colour}">${number || '✓'}</span><span>${escape(activity.name)}</span><small>${number ? '予定' + number : '希望'} · ${escape(activity.area || '')}</small></button>`;
  }).join('');
  const graphLayer = `<g aria-hidden="true" opacity=".42">${paths}</g>`;
  const mapAsset = geographic ? park.geographicMap.asset : `assets/${sea ? 'sea' : 'land'}-map.webp`;
  container.innerHTML = `<style>
.park-map-tools{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:0 0 10px}.park-map-tools button{border:1px solid #cfdae6;border-radius:9px;background:white;color:#173450;padding:7px 11px;min-height:42px;font-size:14px;font-weight:650}.park-map-tools label{font-size:13px;display:flex;align-items:center;gap:6px;margin-left:auto}.park-map-tools input{width:17px;height:17px}.park-map-scale{font-size:12px;color:#536579;min-width:40px;text-align:center}.park-map-stage{overflow:hidden;border:1px solid #d6e1e8;border-radius:17px;background:${sea ? '#c1e4ee' : '#eaf0d8'}}
.park-route-map{display:block;width:100%;height:auto;max-height:75vh;min-height:280px;touch-action:pan-y}.park-route-map[data-zoomed=true]{touch-action:none;cursor:grab}.park-route-map .park-pin{cursor:pointer;outline:none}.park-route-map .park-pin:focus>circle:not(.park-hit){stroke:#e08022;stroke-width:6}.park-route-map .park-tooltip{display:none}.park-route-map .park-pin:hover .park-tooltip,.park-route-map .park-pin:focus .park-tooltip{display:block}.park-route-map .park-area{fill:#213b4c;font:750 17px system-ui,sans-serif;text-anchor:middle;paint-order:stroke;stroke:#fffffff0;stroke-width:6;stroke-linejoin:round}.park-route-map[data-only-selected=true] .park-pin:not(.park-chosen){display:none}.park-map-legend{display:flex;flex-wrap:wrap;gap:5px 13px;margin:10px 0;font-size:12px;color:#425368}.park-map-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.park-map-locations{display:flex;gap:8px;overflow:auto;padding:3px 2px 9px;scroll-snap-type:x proximity}.park-location{display:grid;grid-template-columns:24px minmax(0,1fr);gap:0 8px;align-items:center;flex:0 0 205px;text-align:left;background:white;border:1px solid #d8e1e9;border-radius:10px;padding:10px;color:#22364b;font-size:13px;line-height:1.6;scroll-snap-align:start}.park-location>span:first-child{grid-row:span 2;width:24px;height:24px;border-radius:50%;color:white;text-align:center;line-height:24px;font-weight:800}.park-location small{font-size:11px;color:#5b6f7f}.park-map-pan{display:flex;gap:4px}.park-map-pan[hidden]{display:none}@media(max-width:500px){.park-map-tools label{width:100%;margin-left:0}.park-map-tools button{padding:7px 10px}.park-route-map{min-height:0}}
</style><div class="park-map-tools" role="group" aria-label="地図の表示"><button type="button" data-map-action="out" aria-label="地図を縮小">−</button><span class="park-map-scale" aria-live="polite">${Math.round(view.scale * 100)}%</span><button type="button" data-map-action="in" aria-label="地図を拡大">＋</button><button type="button" data-map-action="reset">全体を見る</button><label><input type="checkbox" data-map-selected${view.onlySelected ? ' checked' : ''}>希望・予定の場所だけ</label><div class="park-map-pan"${view.scale === 1 ? ' hidden' : ''} aria-label="地図を動かす"><button type="button" data-map-action="left" aria-label="地図を左へ">←</button><button type="button" data-map-action="up" aria-label="地図を上へ">↑</button><button type="button" data-map-action="down" aria-label="地図を下へ">↓</button><button type="button" data-map-action="right" aria-label="地図を右へ">→</button></div></div><div class="park-map-stage"><svg data-attribution-url="https://www.openstreetmap.org/copyright" class="park-route-map" viewBox="${mapViewBox(view.scale, view.x, view.y).join(' ')}" data-only-selected="${view.onlySelected}" data-zoomed="${view.scale > 1}" role="group" tabindex="0" aria-label="${escape(park.name)}の${geographic ? '地理地図' : 'イラスト地図'}と徒歩ルート。施設を選ぶと希望に追加します。拡大後はドラッグか矢印キーで移動できます。" xmlns="http://www.w3.org/2000/svg"><desc>${geographic ? '© OpenStreetMap contributors · ODbL。施設は付近の公開通路上の参考位置です。' : '概略地図。現地の移動には公式の園内マップをご利用ください。'}</desc><defs><linearGradient id="${unique}" x2="1" y2="1"><stop stop-color="${sea ? '#c5e8f8' : '#e5eddc'}"/><stop offset="1" stop-color="${sea ? '#91c9e4' : '#d7e3d2'}"/></linearGradient></defs><rect width="1000" height="1000" fill="url(#${unique})"/>${geographic ? graphLayer : ''}<image class="park-map-art" href="${escape(mapAsset)}${geographic?'?v=1.12.0':''}" x="0" y="0" width="1000" height="1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true"/>${geographic ? '' : graphLayer}<g aria-hidden="true">${areaLabels}${routes}${gates}${breaks}</g>${markers}</svg></div><div class="park-map-legend" aria-label="施設の色"><span><i style="background:#2759a2"></i>アトラクション</span><span><i style="background:#8545a5"></i>ショー・パレード</span><span><i style="background:#b65025"></i>フード</span><span><i style="background:#b52e6b"></i>グリーティング</span><span><i style="background:#147969"></i>ショップ・休憩</span></div>${listed.length ? `<div class="park-map-locations" aria-label="${visits.length ? '予定の順番' : '希望に追加した場所'}">${list}</div>` : ''}`;
  let draggedUntil = 0;
  if (typeof onSelect === 'function') for (const marker of container.querySelectorAll('[data-activity-id]')) {
    marker.addEventListener('click', () => {if (Date.now() >= draggedUntil) onSelect(marker.dataset.activityId);});
    marker.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(marker.dataset.activityId); }
    });
  }
  const svg = container.querySelector?.('.park-route-map');
  if (!svg) return; // Also supports a markup-only renderer outside a browser.
  const applyView = () => {
    const box = mapViewBox(view.scale, view.x, view.y);
    view.x = box[0] + box[2] / 2; view.y = box[1] + box[3] / 2;
    svg.setAttribute('viewBox', box.join(' '));
    svg.dataset.zoomed = String(view.scale > 1);
    svg.dataset.onlySelected = String(view.onlySelected);
    container.querySelector('.park-map-scale').textContent = `${Math.round(view.scale * 100)}%`;
    container.querySelector('.park-map-pan').hidden = view.scale === 1;
    container.querySelector('[data-map-action="out"]').disabled = view.scale === 1;
    container.querySelector('[data-map-action="in"]').disabled = view.scale === 4;
  };
  const move = (dx, dy) => {view.x += dx * 120 / view.scale; view.y += dy * 120 / view.scale; applyView();};
  for (const button of container.querySelectorAll('[data-map-action]')) button.addEventListener('click', () => {
    const action = button.dataset.mapAction;
    if (action === 'in') view.scale = Math.min(4, view.scale * 1.5);
    if (action === 'out') view.scale = Math.max(1, view.scale / 1.5);
    if (action === 'reset') {view.scale = 1; view.x = 500; view.y = 500;}
    if (action === 'left') move(-1, 0);
    if (action === 'right') move(1, 0);
    if (action === 'up') move(0, -1);
    if (action === 'down') move(0, 1);
    applyView();
  });
  container.querySelector('[data-map-selected]').addEventListener('change', event => {view.onlySelected = event.target.checked;view.filterSetByUser=true; applyView();});
  for (const button of container.querySelectorAll('[data-focus-activity]')) button.addEventListener('click', () => {
    const position = positions.get(button.dataset.focusActivity);
    if (!position) return;
    view.x = position.x; view.y = position.y; view.scale = 2.5; applyView();
    const marker = [...container.querySelectorAll('[data-activity-id]')].find(pin => pin.dataset.activityId === button.dataset.focusActivity);
    marker?.focus({preventScroll:true});
  });
  svg.addEventListener('keydown', event => {
    if (event.target !== svg || view.scale === 1) return;
    const directions = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]};
    if (directions[event.key]) {event.preventDefault(); move(...directions[event.key]);}
    if (event.key === 'Escape') {view.scale = 1; view.x = 500; view.y = 500; applyView();}
  });
  let drag = null;
  svg.addEventListener('pointerdown', event => {
    if (view.scale <= 1 || event.button !== 0) return;
    drag = {pointerId:event.pointerId, clientX:event.clientX, clientY:event.clientY, x:view.x, y:view.y, moved:false};
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.clientX, dy = event.clientY - drag.clientY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; draggedUntil = Date.now() + 300;
    if (!svg.hasPointerCapture(event.pointerId)) svg.setPointerCapture(event.pointerId);
    const rect = svg.getBoundingClientRect();
    const pixels = Math.min(rect.width, rect.height);
    if (pixels > 0) {view.x = drag.x - dx * 1000 / view.scale / pixels; view.y = drag.y - dy * 1000 / view.scale / pixels; applyView();}
  });
  const finishDrag = event => {if (drag?.pointerId === event.pointerId) {if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId); drag = null;}};
  svg.addEventListener('pointerup', finishDrag); svg.addEventListener('pointercancel', finishDrag);
  container.querySelector('.park-map-art').addEventListener('error', event => {event.target.style.display = 'none';});
  applyView();
}
