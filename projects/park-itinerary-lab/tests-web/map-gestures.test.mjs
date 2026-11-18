import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMapGestures} from '../web/map-gestures.js';

function map(scale = 1) {
  const events = new Map(), captured = new Set(), picks = [];
  const view = {x:500, y:500, scale};
  const bounds = {left:100, top:150, width:600, height:400};
  const svg = {
    isConnected:true,
    addEventListener(type, fn) { events.set(type, fn); },
    getBoundingClientRect() { return bounds; },
    setPointerCapture(id) { captured.add(id); },
    hasPointerCapture(id) { return captured.has(id); },
    releasePointerCapture(id) { captured.delete(id); },
  };
  const acceptsClick = bindMapGestures(svg, view, () => {}, id => picks.push(id));
  let time = 100;
  function fire(type, id, x, y, pin) {
    time += 10;
    const target = pin ? {closest:() => ({dataset:{activityId:pin}})} : svg;
    events.get(type)({type, pointerId:id, pointerType:'touch', button:0, clientX:x, clientY:y,
      target, timeStamp:time});
  }
  function tap(x, y, pin) { fire('pointerdown', 1, x, y, pin); fire('pointerup', 1, x, y, pin); }
  function world(x,y) {
    const unit = 1000 / (Math.min(bounds.width,bounds.height) * view.scale);
    return [view.x + (x - bounds.left - bounds.width / 2) * unit,
      view.y + (y - bounds.top - bounds.height / 2) * unit];
  }
  return {view, bounds, fire, tap, world, picks, acceptsClick, svg, captured};
}

function near(point, expected) {
  assert.ok(point.every((n,i) => Math.abs(n - expected[i]) < 1e-8), point+' != '+expected);
}

test('moving the midpoint while pinching preserves the touched map point in a letterboxed view', () => {
  const m = map();
  const anchor = m.world(360,300);
  m.fire('pointerdown',1,310,300,'castle');
  m.fire('pointerdown',2,410,300);
  m.fire('pointermove',1,300,330);
  m.fire('pointermove',2,500,330);
  assert.equal(m.view.scale,2);
  near(m.world(400,330),anchor);
  m.fire('pointerup',2,500,330);
  const underRemaining = m.world(300,330);
  m.fire('pointermove',1,335,360);
  near(m.world(335,360),underRemaining);
  m.fire('pointerup',1,335,360);
  assert.deepEqual(m.picks,[]);
  assert.equal(m.acceptsClick({detail:1}),false);
  assert.equal(m.acceptsClick({detail:0}),true);
});

test('a double tap on a pin zooms at that point and a tap after cancelling still selects once', async () => {
  const m = map();
  const anchor = m.world(440,380);
  m.tap(440,380,'castle'); m.tap(440,380,'castle');
  assert.equal(m.view.scale,2);
  near(m.world(440,380),anchor);
  m.fire('pointerdown',1,440,380,'cancelled');
  m.fire('pointercancel',1,440,380);
  m.tap(440,380,'castle');
  await new Promise(resolve => setTimeout(resolve,330));
  assert.deepEqual(m.picks,['castle']);
});

test('pinch, release and drag stay in bounds through extra fingers and lost capture', () => {
  const m = map(2);
  m.fire('pointerdown',1,350,340,'castle');
  m.fire('pointerdown',2,450,340);
  m.fire('pointerdown',3,430,250);
  m.fire('pointermove',3,480,258);
  assert.equal(m.view.scale,2);
  m.fire('pointermove',2,850,340);
  assert.equal(m.view.scale,4);
  m.captured.delete(2);
  m.fire('lostpointercapture',2,850,340);
  m.fire('pointercancel',3,480,258);
  m.fire('pointermove',1,3000,3000);
  near([m.view.x,m.view.y],[125,125]);
  m.fire('pointermove',1,2990,2990);
  assert.ok(m.view.x > 125 && m.view.y > 125);
  m.fire('pointermove',1,-3000,-3000);
  near([m.view.x,m.view.y],[875,875]);
  m.fire('pointerup',1,-3000,-3000);
  assert.deepEqual(m.picks,[]);
});

test('a vertical drag on the whole park scrolls the page, while a pinch or zoomed drag stays in the map', t => {
  const scrolls = [];
  t.after(() => { delete globalThis.window; });
  globalThis.window = {scrollBy:({top}) => scrolls.push(top)};
  const m = map();
  m.fire('pointerdown',1,340,300);
  m.fire('pointermove',1,341,270);
  m.fire('pointermove',1,342,260);
  assert.deepEqual(scrolls,[30,10]);
  m.fire('pointerdown',2,440,260);
  m.fire('pointermove',2,540,260);
  m.fire('pointerup',2,540,260);
  m.fire('pointermove',1,345,200);
  assert.deepEqual(scrolls,[30,10]);
  assert.ok(m.view.scale>1);
});
