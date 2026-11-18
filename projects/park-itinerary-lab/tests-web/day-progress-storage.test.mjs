import assert from 'node:assert/strict';
import test from 'node:test';
import {solveItinerary} from '../web/planner.js';
import {
  buildCalendar, buildOfflineHtml, buildPlanJson, buildScheduleCsv, createShareUrl,
  loadSavedPlan, parsePlanJson, readSharedState, saveNamedPlan, validateSavedState,
} from '../web/storage.js';

const date = '2026-11-19';
const ride = 'land-attraction-1';
const second = ride + '~2';
const park = {id:'land', name:'ランド', nodes:[{id:'town', name:'広場'}]};

function plan() {
  const progress = {
    parkId:park.id, date,
    visits:{[ride]:{status:'done', endsAt:650}, [second]:{status:'queue', startedAt:690, endsAt:740}},
  };
  return {
    parkId:park.id,
    settings:{
      date, entry:540, exit:1260, budget:10000, speed:70, selections:[{id:ride, weight:4, repeatCount:2}],
      dayProgress:progress, replanFrom:700, currentNode:'town',
    },
    result:{
      rows:[
        {kind:'activity', name:'テストライド', activityId:ride, start:640, end:650, node:'town', userProgress:'done'},
        {kind:'activity', name:'テストライド（2回目）', activityId:second, start:735, end:740, node:'town', userProgress:'queue'},
      ],
      visits:[
        {id:ride, node:'town', start:640, end:650},
        {id:second, node:'town', start:735, end:740},
      ],
    },
  };
}

test('named plans and JSON restore occurrence-specific progress and retain second-visit names in exports', () => {
  const records = new Map();
  const storage = {getItem:key=>records.get(key)??null, setItem:(key, value)=>records.set(key, value)};
  const state = plan();
  state.settings.skipAutoRestAfter = [second];
  state.settings.excludedAutoBreaks = ['town:' + second];
  assert.deepEqual(parsePlanJson(buildPlanJson(state)), {format:'park-itinerary-lab', version:1, ...state});
  const saved = saveNamedPlan('二度乗り', state, {storage});
  assert.deepEqual(loadSavedPlan(saved.id, {storage}), state);
  for (const exportSchedule of [buildCalendar, buildScheduleCsv, buildOfflineHtml]) {
    const exported = exportSchedule(state.result, park, state.settings);
    assert.match(exported, /テストライド（体験済み）/);
    assert.match(exported, /テストライド（2回目）/);
  }
  assert.match(buildOfflineHtml(state.result, park, state.settings), /data-row="0" checked/);
  state.result.rows[0].start = state.result.rows[0].end;
  const firstEvent = buildCalendar(state.result, park, state.settings).split('END:VEVENT')[0];
  assert.match(firstEvent, /SUMMARY:テストライド（体験済み）/);
  assert.doesNotMatch(firstEvent, /DTEND:/);
});

test('a shared link carries the requested ride count without the current trip progress or its anchors', () => {
  const state = plan();
  state.settings.completedIds = [ride];
  const url = new URL(createShareUrl(state, 'https://example.org/park/'));
  const shared = readSharedState(url.hash);
  assert.equal(shared.settings.selections[0].repeatCount, 2);
  for (const key of ['dayProgress', 'completedIds', 'currentNode', 'replanFrom']) {
    assert.equal(Object.hasOwn(shared.settings, key), false, key);
  }
  assert.equal(state.settings.dayProgress.visits[ride].status, 'done');
});

test('the same owned DPA assigned to the second ride is charged once after saving, sharing and replanning', () => {
  const ticket = {id:ride, kind:'attraction', purchasedAt:550, start:720, end:780, cost:1500};
  const facility = {id:ride, name:'テストライド', category:'attraction', node:'town', cost:0, duration:10,
    baseWait:30, windows:[[540,1260]], dpa:{kind:'attraction', price:1500, wait:5}};
  const parkData = {...park, entryNode:'town', exitNode:'town', edges:[], activities:[facility]};
  const selection = {id:ride, repeatCount:2, dpaVisit:2, required:true, weight:5,
    dpaMode:'owned', dpaStart:720, dpaEnd:780, dpaPurchasedAt:550, manualWait:30};
  const settings = {date, entry:540, exit:1260, speed:70, budget:3000, restEvery:0, searchSeconds:0.1,
    crowdMode:'manual', selections:[selection], purchases:[ticket]};
  const state = {parkId:park.id, settings, result:solveItinerary(parkData, settings)};
  const records = new Map();
  const storage = {getItem:k=>records.get(k)??null, setItem:(k,v)=>records.set(k,v)};
  const saved = saveNamedPlan('DPAは2回目', state, {storage});
  const shared = readSharedState(new URL(createShareUrl(state,'https://example.org/')).hash);
  const duplicate = {...state, settings:{...settings, purchases:[ticket, ticket]}};
  assert.throws(()=>validateSavedState(duplicate), /DPAが重複/);
  for (const restored of [parsePlanJson(buildPlanJson(state)), loadSavedPlan(saved.id,{storage}), shared]) {
    assert.equal(restored.settings.selections[0].dpaVisit, 2);
    assert.deepEqual(restored.settings.purchases, [ticket]);
    if (restored.result) {
      assert.deepEqual(restored.result.purchases.map(ticket=>ticket.id), [ride]);
      assert.equal(restored.result.settings.selections.length, 1);
      assert.equal(restored.result.settings.selections[0].dpaVisit, 2);
      assert.equal(restored.result.settings.selections[0].dpaMode, 'owned');
    }
    const result = solveItinerary(parkData,restored.settings);
    assert.equal(result.status, 'feasible');
    assert.deepEqual(result.rows.filter(row=>row.kind === 'activity').map(row=>[row.activityId,row.dpa]),
      [[ride,false], [second,true]]);
    assert.deepEqual(result.purchases.map(ticket=>ticket.id), [ride]);
    assert.equal(result.totals.dpaCost, 1500);
    const html = buildOfflineHtml(result, parkData, restored.settings);
    assert.match(html, /テストライド（2回目）<\/h2><p>[^<]*DPA利用/);
  }
});

test('the offline itinerary lists untimed completions without inventing a calendar event', () => {
  const state = plan();
  state.settings.dayProgress.visits[ride] = {status:'done', reportedAt:680};
  state.result.rows.shift();
  const facilities = {...park, activities:[{id:ride, name:'最初のライド'}]};
  const page = buildOfflineHtml(state.result, facilities, state.settings);
  assert.equal(parsePlanJson(buildPlanJson(state)).settings.dayProgress.visits[ride].reportedAt,680);
  assert.match(page, /体験済み（時刻の記録なし）<\/h2><ul><li>最初のライド<\/li>/);
  assert.doesNotMatch(buildCalendar(state.result, facilities, state.settings), /最初のライド/);
});

test('old files require no progress data and an overdue finish estimate can be reopened to correct it', () => {
  const legacy = plan();
  delete legacy.settings.dayProgress;
  delete legacy.settings.selections[0].repeatCount;
  assert.equal(validateSavedState(legacy), legacy);
  const state = plan();
  state.settings.replanFrom = 800;
  assert.deepEqual(parsePlanJson(buildPlanJson(state)).settings.dayProgress, state.settings.dayProgress);
});

test('stored progress validates its park, date, visit occurrence, status, times and active visit', () => {
  const state = plan();
  const invalidChanges = [
    value=>{value.dayProgress.parkId='sea';},
    value=>{value.dayProgress.date='2026-11-20';},
    value=>{value.dayProgress.visits[ride + '~3']={status:'done'};},
    value=>{value.dayProgress.visits['sea-ride']={status:'done'};},
    value=>{value.dayProgress.visits[ride].status='unknown';},
    value=>{value.dayProgress.visits[ride]={status:'queue', endsAt:720};},
    value=>{value.dayProgress.visits[second]={status:'riding'};},
    value=>{value.dayProgress.visits[second].endsAt=680;},
    value=>{value.dayProgress.visits[second].startedAt=740;},
    value=>{value.dayProgress.visits[second].endsAt=740.5;},
    value=>{value.dayProgress.visits[ride].reportedAt=640;},
    value=>{value.dayProgress.visits[second].reportedAt=700;},
    value=>{value.selections[0].repeatCount=3;},
    value=>{value.selections[0].id=second;},
    value=>{value.selections[0].dpaVisit=3;},
    value=>{value.selections[0].dpaVisit='2';},
    value=>{value.selections[0].dpaVisit=2; delete value.selections[0].repeatCount;},
    value=>{value.purchases=[{id:second,kind:'attraction',purchasedAt:550,start:720,end:780,cost:1500}];},
  ];
  for (const change of invalidChanges) {
    const invalid = structuredClone(state);
    change(invalid.settings);
    assert.throws(()=>validateSavedState(invalid));
  }
});
