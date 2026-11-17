import test from 'node:test';
import assert from 'node:assert/strict';
import {mapViewBox, renderParkMap} from '../web/map-view.js';

const park = (id = 'land') => ({id, name:'テストパーク', entryNode:'entry', exitNode:'entry', nodes:[{id:'entry', x:500, y:950}, {id:'castle', x:500, y:450}, {id:'village', x:900, y:100}], edges:[{from:'entry', to:'castle', metres:400}], activities:[{id:'castle-ride', name:'お城の体験', area:'お城のエリア', category:'attraction', node:'castle'}, {id:'village-cafe', name:'村のカフェ', area:'村のエリア', category:'cafe', node:'village'}]});
class Element {
  constructor(dataset = {}) {this.dataset=dataset; this.events={}; this.attributes={}; this.style={}; this.hidden=false; this.disabled=false; this.captured=null;}
  addEventListener(type, fn) {this.events[type]=fn;}
  dispatch(type, event={}) {this.events[type]?.({target:this, ...event});}
  setAttribute(name, value) {this.attributes[name]=value;}
  getBoundingClientRect() {return {width:500,height:500};}
  hasPointerCapture(id) {return this.captured===id;}
  setPointerCapture(id) {this.captured=id;}
  releasePointerCapture() {this.captured=null;}
  focus(options) {this.focused=options;}
}
class Container {
  set innerHTML(markup) {
    this.markup=markup; this.svg=new Element(); this.scale=new Element(); this.pan=new Element(); this.selected=new Element(); this.art=new Element();
    this.controls=['in','out','reset','left','right','up','down'].map(mapAction=>new Element({mapAction}));
    this.markers=[...markup.matchAll(/data-activity-id="([^"]+)"/g)].map(match=>new Element({activityId:match[1]}));
    this.locations=[...markup.matchAll(/data-focus-activity="([^"]+)"/g)].map(match=>new Element({focusActivity:match[1]}));
  }
  get innerHTML() {return this.markup;}
  querySelector(selector) {
    return {'.park-route-map':this.svg,'.park-map-scale':this.scale,'.park-map-pan':this.pan,'[data-map-selected]':this.selected,'.park-map-art':this.art}[selector] || this.controls.find(control=>selector===`[data-map-action="${control.dataset.mapAction}"]`);
  }
  querySelectorAll(selector) {return {'[data-map-action]':this.controls,'[data-activity-id]':this.markers,'[data-focus-activity]':this.locations}[selector] || [];}
  action(name) {this.controls.find(control=>control.dataset.mapAction===name).dispatch('click');}
}

test('端の施設へ拡大しても表示範囲は図からはみ出さない', () => {
  assert.deepEqual(mapViewBox(), [0,0,1000,1000]);
  for (const zoom of [1,1.5,2.5,4,10,-2,NaN]) for (const x of [-500,0,500,1000,2000,NaN]) for (const y of [-500,0,500,1000,2000,NaN]) {
    const [left,top,width,height]=mapViewBox(zoom,x,y);
    assert.ok(left>=0 && top>=0 && left+width<=1000 && top+height<=1000);
    assert.ok(width>=250 && width<=1000 && height===width);
  }
});

test('イラスト背景と施設の色・予定の順番・休憩を一緒に読める', () => {
  const container=new Container();
  renderParkMap(container,park(),{selectedIds:['castle-ride'],plan:{visits:[{id:'castle-ride'}],rows:[{kind:'walk',name:'お城へ移動',path:['entry','castle'],metres:400},{kind:'rest',fixedBreakId:'break-1',node:'village',name:'午後の休憩'}]}});
  assert.match(container.innerHTML,/href="assets\/land-map.webp"/);
  assert.match(container.innerHTML,/points="500,950 500,450"/);
  assert.match(container.innerHTML,/data-focus-activity="castle-ride"/);
  assert.match(container.innerHTML,/予定1/); assert.match(container.innerHTML,/午後の休憩/);
  assert.match(container.innerHTML,/現地の移動には公式/);
  container.art.dispatch('error'); assert.equal(container.art.style.display,'none');
  assert.match(container.innerHTML,/お城へ移動/);
});

test('予定の場所で拡大し希望を変更せず場所だけ確かめられる', () => {
  const container=new Container(); let selected=null;
  renderParkMap(container,park(),{selectedIds:['village-cafe'],onSelect:id=>{selected=id;}});
  container.locations[0].dispatch('click');
  assert.equal(selected,null);
  assert.equal(container.svg.attributes.viewBox,'600 0 400 400');
  assert.equal(container.scale.textContent,'250%'); assert.deepEqual(container.markers[1].focused,{preventScroll:true});
  container.markers[1].dispatch('click'); assert.equal(selected,'village-cafe');
  selected=null; let prevented=false;
  container.markers[0].dispatch('keydown',{key:'Enter',preventDefault(){prevented=true;}});
  assert.equal(selected,'castle-ride'); assert.equal(prevented,true);
  renderParkMap(container,park(),{selectedIds:['village-cafe']});
  assert.equal(container.svg.attributes.viewBox,'600 0 400 400');
  renderParkMap(container,park('sea'));
  assert.equal(container.svg.attributes.viewBox,'0 0 1000 1000');
  assert.match(container.innerHTML,/href="assets\/sea-map.webp"/);
});

test('拡大・移動・全体表示と絞り込みをマウスとキーボードで操作できる', () => {
  const container=new Container(); renderParkMap(container,park());
  assert.equal(container.querySelector('[data-map-action="out"]').disabled,true);
  container.action('in'); assert.equal(container.svg.dataset.zoomed,'true');
  const initial=container.svg.attributes.viewBox;
  let prevented=false; container.svg.dispatch('keydown',{key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(prevented,true); assert.notEqual(container.svg.attributes.viewBox,initial);
  container.selected.checked=true; container.selected.dispatch('change'); assert.equal(container.svg.dataset.onlySelected,'true');
  container.action('reset'); assert.equal(container.svg.attributes.viewBox,'0 0 1000 1000');
  assert.equal(container.svg.dataset.zoomed,'false');
  for(let i=0;i<8;i++) container.action('in');
  assert.equal(container.scale.textContent,'400%'); assert.equal(container.querySelector('[data-map-action="in"]').disabled,true);
  container.svg.dispatch('keydown',{key:'Escape'}); assert.equal(container.svg.attributes.viewBox,'0 0 1000 1000');
});

test('拡大図をドラッグした後のクリックは希望の追加と取り違えない', () => {
  const container=new Container(); let selected=null; renderParkMap(container,park(),{onSelect:id=>{selected=id;}});
  container.action('in');
  container.svg.dispatch('pointerdown',{button:0,pointerId:1,clientX:200,clientY:200});
  const initial=container.svg.attributes.viewBox;
  container.svg.dispatch('pointermove',{pointerId:1,clientX:250,clientY:220});
  assert.notEqual(container.svg.attributes.viewBox,initial);
  container.svg.dispatch('pointerup',{pointerId:1});
  container.markers[0].dispatch('click'); assert.equal(selected,null);
});
