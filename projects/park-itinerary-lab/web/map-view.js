/** Draw our own route sketch from walkway nodes, not from a copied park map. */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const categories = {attraction:'アトラクション', show:'ショー', parade:'パレード', restaurant:'レストラン', cafe:'カフェ', snack:'スナック', popcorn:'ポップコーン', greeting:'グリーティング', shop:'ショップ'};
const colours = {attraction:'#4969ac', show:'#9755aa', parade:'#9755aa', restaurant:'#b46535', cafe:'#b46535', snack:'#b46535', popcorn:'#b46535', greeting:'#b94878', shop:'#338875'};
let renderNumber = 0;

/** `onSelect` receives the facility ID when a marker is clicked or keyboard activated. */
export function renderParkMap(container, park, {plan = null, selectedIds = [], onSelect} = {}) {
  if (!container || !park || !Array.isArray(park.nodes) || !Array.isArray(park.activities)) throw new TypeError('地図を表示するパークを確認してください。');
  const nodeMap = new Map(park.nodes.map(node => [node.id, node]));
  const selected = new Set(selectedIds), visits = plan?.visits || [];
  const visitNumbers = new Map(visits.map((visit, index) => [visit.activityId || visit.id, index + 1]));
  const sea = park.id === 'sea', gradient = `park-map-background-${++renderNumber}`;
  const point = node => `${Number(node.x)},${Number(node.y)}`;
  const paths = (park.edges || []).filter(edge => nodeMap.has(edge.from) && nodeMap.has(edge.to)).map(edge => `<line x1="${Number(nodeMap.get(edge.from).x)}" y1="${Number(nodeMap.get(edge.from).y)}" x2="${Number(nodeMap.get(edge.to).x)}" y2="${Number(nodeMap.get(edge.to).y)}" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/><line x1="${Number(nodeMap.get(edge.from).x)}" y1="${Number(nodeMap.get(edge.from).y)}" x2="${Number(nodeMap.get(edge.to).x)}" y2="${Number(nodeMap.get(edge.to).y)}" stroke="${sea ? '#9fc5dc' : '#ccd6c4'}" stroke-width="2" stroke-linecap="round"/>`).join('');
  const routeRows = (plan?.rows || []).filter(row => (row.kind || row.type) === 'walk' && Array.isArray(row.path));
  const routes = routeRows.map(row => {
    const points = row.path.map(id => nodeMap.get(id)).filter(Boolean);
    if (points.length < 2) return '';
    return `<polyline points="${points.map(point).join(' ')}" fill="none" stroke="#1b658f" stroke-width="11" stroke-linejoin="round" stroke-linecap="round" opacity=".84"><title>${escape(row.name)} · 約${escape(Math.round(row.metres || 0))}m</title></polyline>`;
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
      positions.set(activity.id, {x: Math.max(24, Math.min(976, node.x + Math.cos(angle) * radius)), y: Math.max(24, Math.min(976, node.y + Math.sin(angle) * radius))});
    });
  }
  const areaGroups = new Map();
  for (const activity of park.activities) {
    const node = nodeMap.get(activity.node);
    if (!node || !activity.area) continue;
    if (!areaGroups.has(activity.area)) areaGroups.set(activity.area, []);
    areaGroups.get(activity.area).push(node);
  }
  const areaLabels = [...areaGroups].map(([name, nodes]) => {
    const x = nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length;
    const y = Math.max(30, Math.min(...nodes.map(node => node.y)) - 32);
    return `<text x="${x}" y="${y}" class="park-area">${escape(name)}</text>`;
  }).join('');
  const markers = park.activities.map(activity => {
    const pos = positions.get(activity.id); if (!pos) return '';
    const isSelected = selected.has(activity.id), number = visitNumbers.get(activity.id);
    const colour = colours[activity.category] || '#4969ac';
    const title = `${activity.name} / ${categories[activity.category] || activity.category}${number ? ` / 予定${number}` : ''}${isSelected ? ' / 希望に追加済み' : ' / 選んで希望に追加'}`;
    const marker = number ? `<circle r="19" fill="#fff" stroke="#1b658f" stroke-width="4"/><text y="7" text-anchor="middle" font-size="20" font-weight="800" fill="#174965">${number}</text>` : `<circle r="${isSelected ? 12 : 8}" fill="${colour}" stroke="${isSelected ? '#fff' : '#ffffffb8'}" stroke-width="${isSelected ? 4 : 2}"/>${isSelected ? '<path d="M-5,0 L-1,4 L6,-5" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' : ''}`;
    return `<g class="park-pin" role="button" tabindex="0" aria-label="${escape(title)}" aria-pressed="${isSelected}" data-activity-id="${escape(activity.id)}" transform="translate(${pos.x} ${pos.y})"><title>${escape(title)}</title><circle class="park-hit" r="22" fill="transparent"/>${marker}<g class="park-tooltip" pointer-events="none"><rect x="-125" y="-65" width="250" height="33" rx="8" fill="#193c54"/><text x="0" y="-43" fill="white" font-size="15" text-anchor="middle">${escape(activity.name.length > 15 ? activity.name.slice(0, 15) + '…' : activity.name)}</text></g></g>`;
  }).join('');
  const entry = nodeMap.get(park.entryNode), exit = nodeMap.get(park.exitNode);
  const gates = [[entry, '入口'], ...(park.exitNode === park.entryNode ? [] : [[exit, '出口']])].filter(([node]) => node).map(([node, label]) => `<g transform="translate(${node.x} ${node.y})"><circle r="13" fill="#193c54" stroke="white" stroke-width="3"/><path d="M-4,4 L-4,-5 L4,-5 L4,4" fill="none" stroke="white" stroke-width="2"/><text x="0" y="36" class="park-gate">${label}</text></g>`).join('');
  container.innerHTML = `<svg class="park-route-map" viewBox="0 0 1000 1000" role="group" aria-label="${escape(park.name)}の施設と徒歩ルート。地点を選ぶと希望に追加できます。" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto;max-height:75vh;min-height:280px"><defs><linearGradient id="${gradient}" x2="1" y2="1"><stop stop-color="${sea ? '#c5e8f8' : '#e5eddc'}"/><stop offset="1" stop-color="${sea ? '#91c9e4' : '#d7e3d2'}"/></linearGradient></defs><style>.park-route-map .park-pin{cursor:pointer;outline:none}.park-route-map .park-pin:focus>circle:not(.park-hit){stroke:#e28531;stroke-width:6}.park-route-map .park-tooltip{display:none}.park-route-map .park-pin:hover .park-tooltip,.park-route-map .park-pin:focus .park-tooltip{display:block}.park-route-map .park-area{fill:#476578;font:600 17px system-ui,sans-serif;text-anchor:middle;paint-order:stroke;stroke:#ffffffa8;stroke-width:5;stroke-linejoin:round}.park-route-map .park-gate{fill:#193c54;font:700 18px system-ui,sans-serif;text-anchor:middle;paint-order:stroke;stroke:white;stroke-width:4}</style><rect width="1000" height="1000" rx="32" fill="url(#${gradient})"/><g aria-hidden="true">${paths}${areaLabels}${routes}${gates}</g>${markers}</svg><p class="park-map-caption" style="font-size:11px;line-height:1.7;color:#526878;margin:12px 0 0">施設の位置と通路を示す概略図です。番号は予定の順序です。徒歩距離は通路に沿った目安として計算します。</p>`;
  if (typeof onSelect === 'function') for (const marker of container.querySelectorAll('[data-activity-id]')) {
    marker.addEventListener('click', () => onSelect(marker.dataset.activityId));
    marker.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(marker.dataset.activityId); }
    });
  }
}
