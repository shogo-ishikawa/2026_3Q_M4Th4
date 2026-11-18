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


test('計画後は予定のピンへ絞り込み、利用者が戻した全件表示も保つ',()=>{
 const container=new Container();const settings={selectedIds:['castle-ride'],plan:{visits:[{id:'castle-ride'}]}};
 renderParkMap(container,park());assert.equal(container.svg.dataset.onlySelected,'false');
 renderParkMap(container,park(),settings);assert.equal(container.svg.dataset.onlySelected,'true');
 assert.match(container.innerHTML,/選んで希望から外す/);
 container.selected.checked=false;container.selected.dispatch('change');
 renderParkMap(container,park(),settings);assert.equal(container.svg.dataset.onlySelected,'false');
});

test('希望・予定が変わっても地図とフォーカス中の施設を作り直さない', () => {
  class MapContainer extends Container {
    constructor() {
      super();
      this.layers = Object.fromEntries(['.park-map-locations','.park-routes','.park-rests'].map(key => [key,new Element()]));
      this.layers['.park-map-locations'].getAttribute = name => this.layers['.park-map-locations'].attributes[name];
    }
    querySelector(selector) { return this.layers[selector] || super.querySelector(selector); }
  }
  const container = new MapContainer(), data = park();
  renderParkMap(container, data);
  const svg = container.svg, pin = container.markers[0], otherPin = container.markers[1];
  pin.classList = {toggle() {}};
  container.action('in');
  const zoomed = svg.attributes.viewBox;
  const visit = {id:'castle-ride'};
  const row = {kind:'walk',name:'お城へ',path:['entry','castle']};
  renderParkMap(container, data, {selectedIds:['castle-ride'],plan:{visits:[visit],rows:[row]}});
  assert.equal(container.svg, svg);
  assert.equal(container.markers[0], pin);
  assert.equal(svg.attributes.viewBox, zoomed);
  assert.equal(pin.attributes['aria-pressed'],'true');
  assert.match(pin.attributes['aria-label'],/予定1/);
  assert.equal(otherPin.innerHTML,undefined);
  assert.match(container.layers['.park-routes'].innerHTML,/お城へ/);
  assert.match(container.layers['.park-map-locations'].innerHTML,/data-focus-activity="castle-ride"/);
  renderParkMap(container, data);
  assert.equal(container.layers['.park-routes'].innerHTML, '');
  assert.equal(container.layers['.park-map-locations'].hidden, true);
  assert.equal(pin.attributes['aria-pressed'],'false');
  const replacement = park();
  replacement.activities[0].name = '更新した施設名';
  renderParkMap(container, replacement);
  assert.notEqual(container.svg,svg);
  assert.match(container.innerHTML,/更新した施設名/);
});

test('公開地図は軽量な背景、同じ原画、通路の順に表示を引き継ぐ', () => {
  const container = new Container(), fallback = new Element(), data = park();
  data.geographicMap = {asset:'assets/land-geographic-map.svg'};
  const selector = container.querySelector.bind(container);
  container.querySelector = key => key === '.park-walkways' ? fallback : selector(key);
  renderParkMap(container, data);
  assert.match(container.innerHTML,/href="assets\/land-geographic-map\.webp\?v=/);
  assert.doesNotMatch(container.innerHTML,/<polyline/);
  container.art.dispatch('error');
  assert.match(container.art.attributes.href,/^assets\/land-geographic-map\.svg\?v=/);
  assert.equal(fallback.innerHTML,undefined);
  container.art.dispatch('error');
  assert.match(fallback.innerHTML,/points="500,950 500,450"/);
  assert.equal(container.art.style.display,'none');
});

test('独自の地図画像は標準背景に差し替えず通路と重ねて描く', () => {
  const data = park(), container = new Container();
  data.geographicMap = {asset:'assets/other-geography.svg'};
  renderParkMap(container,data);
  assert.match(container.innerHTML,/href="assets\/other-geography\.svg\?v=/);
  assert.match(container.innerHTML,/points="500,950 500,450"/);
  container.art.dispatch('error');
  assert.equal(container.art.style.display,'none');
});
