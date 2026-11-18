/** Pointer coordinates are in CSS pixels; the park drawing is a 1000 × 1000 square. */
const tapDelay = 300;
const tapRadius = 24;
const dragThreshold = 6;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({x:(a.x + b.x) / 2, y:(a.y + b.y) / 2});
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mapViewBox(scale = 1, x = 500, y = 500) {
  const zoom = clamp(Number.isFinite(scale) ? scale : 1, 1, 4);
  const size = 1000 / zoom;
  const left = clamp(Number.isFinite(x) ? x - size / 2 : 0, 0, 1000 - size);
  const top = clamp(Number.isFinite(y) ? y - size / 2 : 0, 0, 1000 - size);
  return [left, top, size, size];
}

function drawingFrame(svg) {
  const rect = svg.getBoundingClientRect();
  const pixels = Math.min(rect.width, rect.height);
  // SVG's default xMidYMid meet can letterbox the square in a wide or short viewport.
  return pixels > 0 ? {x:(rect.left ?? 0) + rect.width / 2, y:(rect.top ?? 0) + rect.height / 2, pixels} : null;
}

function mapPoint(view, frame, point) {
  const units = 1000 / (view.scale * frame.pixels);
  return {x:view.x + (point.x - frame.x) * units, y:view.y + (point.y - frame.y) * units};
}

/** Preserve the world point under the moving finger or the midpoint of a pinch. */
function placePoint(view, frame, anchor, point, scale) {
  view.scale = clamp(scale, 1, 4);
  const half = 500 / view.scale;
  const units = 2 * half / frame.pixels;
  const x = anchor.x - (point.x - frame.x) * units, y = anchor.y - (point.y - frame.y) * units;
  view.x = clamp(x, half, 1000 - half);
  view.y = clamp(y, half, 1000 - half);
  return view.x !== x || view.y !== y || view.scale !== scale;
}

export function bindMapGestures(svg, view, paint, select) {
  const pointers = new Map();
  let frame, gesture, queuedPaint = false, pendingTap, blockClick = false;
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(rebase) : null;

  function paintNextFrame() {
    if (typeof requestAnimationFrame !== 'function') { paint(); return; }
    if (queuedPaint) return;
    queuedPaint = true;
    requestAnimationFrame(() => { queuedPaint = false; if (svg.isConnected) paint(); });
  }

  function rebase() {
    frame = drawingFrame(svg);
    if (svg.isConnected === false) {
      resize?.disconnect(); pointers.clear(); return;
    }
    anchorGesture();
  }

  function anchorGesture() {
    const [a, b] = pointers.values();
    if (!a || !frame) return;
    const point = b ? midpoint(a, b) : a;
    gesture = {anchor:mapPoint(view, frame, point), scale:view.scale, spread:b ? distance(a, b) : 0};
  }

  function clearTap() {
    if (pendingTap) clearTimeout(pendingTap.timer);
    pendingTap = null;
  }

  function finishTap() {
    const id = pendingTap?.id;
    clearTap();
    if (id && svg.isConnected !== false) select(id);
  }

  function zoomAt(point) {
    const currentFrame = drawingFrame(svg);
    if (!currentFrame) return;
    placePoint(view, currentFrame, mapPoint(view, currentFrame, point), point, view.scale * 2);
    paintNextFrame();
  }

  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.has(event.pointerId)) return;
    const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
    const p = {x:event.clientX, y:event.clientY, startX:event.clientX, startY:event.clientY,
      id:event.target.closest?.('[data-activity-id]')?.dataset.activityId,
      time:event.timeStamp, touch, moved:false, second:false,
      scrollOverview:touch && pointers.size === 0 && view.scale === 1, lastScrollY:event.clientY};
    if (pointers.size) {
      clearTap();
      for (const other of pointers.values()) { other.moved = true; other.scrollOverview = false; }
      p.moved = true;
    } else if (pendingTap) {
      p.second = touch && event.timeStamp - pendingTap.time <= tapDelay && distance(p, pendingTap) <= tapRadius;
      if (p.second) clearTap(); else finishTap();
    }
    blockClick = touch || p.moved;
    pointers.set(event.pointerId, p);
    if (touch) svg.setPointerCapture(event.pointerId);
    if (pointers.size === 1) resize?.observe(svg);
    rebase();
  });

  function movePointer(event) {
    const p = pointers.get(event.pointerId);
    if (!p || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    p.x = event.clientX; p.y = event.clientY;
    if (!p.moved && Math.hypot(p.x - p.startX, p.y - p.startY) >= dragThreshold) p.moved = true;
    if (!p.moved || !frame || !gesture) return;
    blockClick = true;
    if (event.type !== 'pointerup' && !svg.hasPointerCapture(event.pointerId)) svg.setPointerCapture(event.pointerId);
    const [a, b] = pointers.values();
    if (p !== a && p !== b) return;
    // At the full-park overview the map has no room to pan. Let a vertical
    // swipe move the page while a second finger can still start a pinch.
    if (!b && p.scrollOverview && view.scale === 1) {
      if (Math.abs(p.y - p.startY) > Math.abs(p.x - p.startX)) {
        globalThis.window?.scrollBy({top:p.lastScrollY - p.y, behavior:'instant'});
      }
      p.lastScrollY = p.y;
      return;
    }
    if (b && gesture.spread < 1) { rebase(); return; }
    const scale = b ? gesture.scale * distance(a, b) / gesture.spread : gesture.scale;
    const reachedEdge = placePoint(view, frame, gesture.anchor, b ? midpoint(a, b) : a, scale);
    // Reverse direction immediately after reaching an edge or a zoom limit.
    if (reachedEdge) anchorGesture();
    paintNextFrame();
  }
  svg.addEventListener('pointermove', movePointer);

  function endPointer(event, cancelled) {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    if (!cancelled && (p.x !== event.clientX || p.y !== event.clientY)) movePointer(event);
    pointers.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (pointers.size) rebase(); else resize?.disconnect();
    if (cancelled || p.moved || !p.touch || event.timeStamp - p.time > 550) return;
    if (p.second) { zoomAt(p); return; }
    pendingTap = {id:p.id, x:p.x, y:p.y, time:event.timeStamp, timer:setTimeout(finishTap, tapDelay)};
  }
  svg.addEventListener('pointerup', event => endPointer(event, false));
  svg.addEventListener('pointercancel', event => endPointer(event, true));
  svg.addEventListener('lostpointercapture', event => {
    if (event.target === svg && !svg.hasPointerCapture(event.pointerId)) endPointer(event, true);
  });
  // Uncaptured mouse presses can leave the drawing before they qualify as drags.
  svg.addEventListener('pointerleave', event => {
    if (event.pointerType === 'mouse' && !svg.hasPointerCapture(event.pointerId)) endPointer(event, true);
  });
  svg.addEventListener('dblclick', event => {
    if (!blockClick && !event.target.closest?.('[data-activity-id]')) {
      event.preventDefault();
      zoomAt({x:event.clientX, y:event.clientY});
    }
  });
  // Keyboard/screen reader activation (detail 0) stays immediate. Native clicks
  // from a touch have already been handled as either a tap or a map gesture.
  return event => event.detail === 0 || !blockClick;
}
