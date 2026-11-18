import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WISH_PRESETS, presetFacilities, presetStartsPlan, addPresetWishes} from '../web/wishlist-presets.js';

const {parks} = JSON.parse(readFileSync(new URL('../web/data/parks.json', import.meta.url)));
const date = '2026-11-19';
const settings = () => ({date, selections:[]});
const ids = facilities => facilities.map(a => a.id);
const wish = a => ({id:a.id, required:false, dpaMode:'none'});

test('the three themes offer distinct, available facilities from each bundled park', () => {
  for (const park of parks) {
    const themes = WISH_PRESETS.map(p => presetFacilities(park,settings(),p.id));
    const [classic, rides, performances] = themes;
    assert.equal(new Set(themes.map(items => ids(items).join())).size,3);
    assert.ok(classic.some(a => a.category==='shop'));
    assert.ok(rides.filter(a => a.category==='attraction').length >= 3);
    assert.ok(performances.some(a => ['show','parade'].includes(a.category)));
    assert.ok(performances.some(a => a.category==='restaurant'));
    for (const items of themes) {
      assert.equal(items.length,new Set(ids(items)).size);
      assert.ok(items.every(a => a.id.startsWith(park.id+'-') && a.access==='normal'));
    }
  }
});

test('closures, missing catalogue entries and required admission are skipped before taking each group', () => {
  const land = parks.find(p => p.id==='land');
  const modified = {...land, activities:land.activities.filter(a => a.id!=='land-attraction-160').map(a => {
    if (a.id==='land-attraction-197') return {...a,dailySchedules:{[date]:{closed:true}}};
    if (a.id==='land-attraction-174') return {...a,access:'entry'};
    return a;
  })};
  const candidates = ids(presetFacilities(modified,settings(),'classics'));
  for(const id of ['land-attraction-197','land-attraction-174','land-attraction-160'])assert.ok(!candidates.includes(id));
  assert.ok(candidates.includes('land-attraction-172'));
});

test('adding the same theme twice preserves individual choices, receipts and recorded visits', () => {
  const park = parks.find(p => p.id==='sea'), existing = {id:'sea-attraction-219',repeatCount:2,required:true,weight:5,dpaMode:'owned',dpaVisit:2};
  const state = {...settings(),selections:[existing],purchases:[{id:existing.id,cost:2500}],
    dayProgress:{parkId:park.id,date,visits:{'sea-attraction-255':{status:'done'},'sea-attraction-218':{status:'skipped'},'sea-attraction-223':{status:'queue'}}}};
  const before = structuredClone(state);
  const choices = presetFacilities(park,state,'classics');
  assert.ok(!ids(choices).some(id => before.dayProgress.visits[id]));
  const added = addPresetWishes(state,choices,wish);
  assert.ok(added>0);
  assert.equal(state.selections[0],existing);
  assert.deepEqual(existing,before.selections[0]);
  assert.deepEqual(state.purchases,before.purchases);
  assert.deepEqual(state.dayProgress,before.dayProgress);
  assert.equal(addPresetWishes(state,presetFacilities(park,state,'classics'),wish),0);
  const anotherDay = {...state,date:'2026-11-20'};
  assert.ok(ids(presetFacilities(park,anotherDay,'classics')).includes('sea-attraction-255'));
});

test('only a new empty wishlist opens the planner immediately', () => {
  assert.ok(presetStartsPlan({settings:settings()}));
  assert.equal(presetStartsPlan({settings:settings(),result:{status:'feasible'}}),false);
  for(const values of [{selections:[{id:'a'}]},{replanFrom:600},{fixedBreaks:[{start:600}]},{purchases:[{id:'a'}]},{dayProgress:{visits:{a:{status:'done'}}}}])
    assert.equal(presetStartsPlan({settings:{...settings(),...values}}),false);
});
