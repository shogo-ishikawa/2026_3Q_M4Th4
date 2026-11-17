import test from 'node:test';
import assert from 'node:assert/strict';
import { graphDistances, estimateWait, solveItinerary, validatePlan } from '../web/planner.js';

const venue = (id, extra = {}) => ({
  id, name: id, category: 'attraction', node: id, duration: 15, baseWait: 0,
  cost: 0, windows: [[540, 1260]], showTimes: [], access: 'normal', ...extra,
});
function park(activities = [venue('a'), venue('b'), venue('c')]) {
  const ids = ['gate', ...activities.map(item => item.node), ...activities.map(item => item.endNode).filter(Boolean)];
  const nodes = [...new Set(ids)].map((id, i) => ({ id, x: i * 100, y: 200 }));
  return { id: 'test', entryNode: 'gate', exitNode: 'gate', nodes,
    edges: nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id, metres: 100 })),
    activities, events: [] };
}
const settings = (extra = {}) => ({
  date: '2026-11-17', entry: 540, exit: 720, speed: 50, budget: 5000,
  crowdMode: 'manual', weather: 'sun', crowdLevel: 'normal', restEvery: 0, restMinutes: 0,
  searchSeconds: 0.2, selections: [{ id: 'a', weight: 5 }, { id: 'b', weight: 3 }, { id: 'c', weight: 1 }],
  ...extra,
});
const solve = (p, s, options = {}) => solveItinerary(p, s, options);

test('shortest walking route uses graph paths rather than a line through obstacles', () => {
  const p = park(), graph = graphDistances(p);
  assert.equal(graph.distances.gate.c, 300);
  assert.deepEqual(graph.paths.gate.c, ['gate', 'a', 'b', 'c']);
});

test('exit travel is included and every returned plan passes independent checks', () => {
  const p = park(), s = settings({ exit: 590 }), result = solve(p, s);
  assert.equal(result.status, 'feasible');
  assert.ok(result.rows.at(-1).end <= 590);
  assert.equal(result.rows.at(-1).kind, 'exit');
  assert.equal(result.coverage.weight, 8);
  assert.equal(validatePlan(p, s, result).valid, true);
});

test('importance can outweigh the number of visits under a short time budget', () => {
  const p = park([venue('a', { duration: 38 }), venue('b', { duration: 12 }), venue('c', { duration: 12 })]);
  const result = solve(p, settings({ exit: 584, selections: [{ id: 'a', weight: 5 }, { id: 'b', weight: 2 }, { id: 'c', weight: 2 }] }));
  assert.deepEqual(result.visits.map(item => item.id), ['a']);
  assert.equal(result.coverage.percent, 56);
});

test('required wishes are never silently dropped and no-plan is not infeasibility proof', () => {
  const p = park([venue('a', { duration: 100 })]);
  const result = solve(p, settings({ exit: 580, selections: [{ id: 'a', weight: 1, required: true }] }));
  assert.equal(result.status, 'no-plan');
  assert.equal(result.coverage.requiredCount, 0);
  assert.equal(result.diagnostics.optimal, false);
  assert.match(result.diagnostics.notes.join(' '), /証明/);
});

test('food must finish inside the selected meal time window', () => {
  const p = park([venue('a', { category: 'restaurant', duration: 45, cost: 1730 })]);
  const s = settings({ selections: [{ id: 'a', weight: 3, earliest: 600, latest: 650 }] });
  const result = solve(p, s);
  assert.equal(result.visits[0].start, 600);
  assert.equal(result.visits[0].end, 645);
  assert.equal(result.totals.cost, 1800);
  const impossible = solve(p, { ...s, selections: [{ id: 'a', weight: 3, earliest: 600, latest: 640, required: true }] });
  assert.equal(impossible.status, 'no-plan');
});

test('fixed performances start at the confirmed performance time', () => {
  const p = park([venue('a', { category: 'show', duration: 20, baseWait: 10, showTimes: [610], showTimesDate: '2026-11-17' })]);
  const result = solve(p, settings({ selections: [{ id: 'a', weight: 4, required: true }] }));
  assert.equal(result.visits[0].start, 610);
  assert.equal(result.visits[0].queueStart, 600);
  assert.equal(solve(p, settings({ date: '2026-11-18', selections: [{ id: 'a', weight: 4, required: true }] })).status, 'no-plan');
  assert.equal(solve(p, settings({ date: '2026-11-18', selections: [{ id: 'a', weight: 4, required: true, showTimes: [620] }] })).visits[0].start, 620);
});

test('closed dates and entry conditions exclude an unavailable wish', () => {
  const p = park([venue('a', { closedDates: ['2026-11-17'] }), venue('b', { access: 'entry' })]);
  const result = solve(p, settings({ selections: [{ id: 'a', weight: 5 }, { id: 'b', weight: 5 }] }));
  assert.equal(result.visits.length, 0);
  assert.match(result.omissions.find(item => item.id === 'a').reason, /休止/);
  assert.match(result.omissions.find(item => item.id === 'b').reason, /利用条件/);
});

test('observed historical rows take precedence, future and invalid rows never leak into a past visit', () => {
  const activity = venue('a', { baseWait: 30 }), s = settings({ crowdMode: 'estimate' });
  const rows = [
    { activityId: 'a', date: '2026-11-16', time: '10:00', wait: 45 },
    { activityId: 'a', date: '2026-11-18', time: '10:00', wait: 300 },
    { activityId: 'a', date: '2026-99-99', time: '10:00', wait: 300 },
  ];
  const measured = estimateWait(activity, 600, s, rows);
  assert.deepEqual(measured, { minutes: 45, source: 'history', samples: 1 });
  assert.equal(estimateWait(activity, 600, s, rows.slice(1)).source, 'trend');
});

test('manual waits are used as entered, with invalid values rejected', () => {
  assert.equal(estimateWait(venue('a'), 600, settings({ selections: [{ id: 'a', manualWait: 73 }] })).minutes, 73);
  assert.throws(() => solve(park(), settings({ selections: [{ id: 'a', manualWait: -1 }] })), /待ち時間/);
  assert.throws(() => solve(park(), settings({ budget: NaN })), /予算/);
});

test('dated events affect the labelled trend, and event effects disappear outside their dates', () => {
  const p = park([venue('a', { baseWait: 60 })]);
  p.events = [{ id: 'winter', startDate: '2026-11-10', endDate: '2026-12-25', multiplier: 1.3 }];
  const result = solve(p, settings({ crowdMode: 'estimate', selections: [{ id: 'a', weight: 3 }] }));
  assert.equal(result.settings.activeEvents.length, 1);
  assert.equal(result.diagnostics.waitSource, 'trend');
});

test('DPA is considered only with explicit available windows and within operating hours', () => {
  const p = park([venue('a', { baseWait: 80, dpa: { price: 1500, wait: 5, kind: 'attraction' } })]);
  let s = settings({ exit: 610, budgetPreference: 'dpa', selections: [{ id: 'a', weight: 5, dpaMode: 'consider' }] });
  assert.equal(solve(p, s).visits.length, 0);
  s = { ...s, selections: [{ ...s.selections[0], dpaAvailableWindows: [[550, 580]] }] };
  const result = solve(p, s);
  assert.equal(result.visits[0].method, 'dpa');
  assert.equal(result.purchases[0].purchasedAt, 540);
  assert.equal(result.totals.dpaCost, 1500);
  p.activities[0].windows = [[600, 720]];
  assert.equal(solve(p, s).visits.length, 0);
});

test('owned DPA requires actual purchase time and its fixed window, without double-counting paid money', () => {
  const p = park([venue('a', { dpa: { price: 1500, wait: 5, kind: 'attraction' } })]);
  const selection = { id: 'a', weight: 5, dpaMode: 'owned', dpaStart: 600, dpaEnd: 630, dpaPurchasedAt: 550 };
  const result = solve(p, settings({ spentBudget: 1500, selections: [selection] }));
  assert.equal(result.visits[0].queueStart, 600);
  assert.equal(result.totals.cost, 1500);
  assert.equal(result.totals.dpaCost, 1500);
  assert.throws(() => solve(p, settings({ selections: [{ ...selection, dpaPurchasedAt: undefined }] })), /購入時刻/);
});

test('DPA categories have independent purchase clocks, while the same category respects the next-purchase time', () => {
  const p = park([
    venue('a', { dpa: { price: 1500, wait: 5, kind: 'attraction' } }),
    venue('b', { dpa: { price: 2000, wait: 5, kind: 'attraction' } }),
    venue('c', { category: 'show', showTimes: [700], dpa: { price: 2500, wait: 5, kind: 'show' } }),
  ]);
  const s = settings({ exit: 750, budget: 10000, budgetPreference: 'dpa', selections: [
    { id: 'a', weight: 5, dpaMode: 'owned', dpaStart: 600, dpaEnd: 620, dpaPurchasedAt: 540 },
    { id: 'b', weight: 4, dpaMode: 'consider', dpaAvailableWindows: [[610, 660]] },
    { id: 'c', weight: 3, dpaMode: 'consider', dpaAvailableWindows: [[685, 700]] },
  ] });
  const result = solve(p, s);
  const purchases = Object.fromEntries(result.purchases.map(item => [item.id, item]));
  assert.equal(purchases.b.purchasedAt, 600);
  assert.equal(purchases.c.purchasedAt, 540);
  assert.equal(validatePlan(p, s, result).valid, true);
});

test('a DPA purchase kind cannot be changed to evade its purchase clock or create negative expenditure', () => {
  const p = park([venue('a', { dpa: { price: 1500, wait: 5, kind: 'attraction' } })]);
  const purchase = { id: 'a', kind: 'show', purchasedAt: 540, start: 600, end: 630, cost: 1500 };
  assert.throws(() => solve(p, settings({ selections: [], purchases: [purchase] })), /種別/);
  assert.throws(() => solve(p, settings({ selections: [], purchases: [{ ...purchase, kind: 'attraction', cost: -100 }] })), /費用/);
});

test('parade DPA needs the actual viewing location and locally confirmed show time', () => {
  const p = park([venue('a', { category: 'parade', showTimes: [620], dpa: { price: 2500, wait: 5, kind: 'show' } })]);
  const selection = { id: 'a', weight: 5, dpaMode: 'owned', dpaPurchasedAt: 540, dpaStart: 600, dpaEnd: 620 };
  assert.equal(solve(p, settings({ selections: [selection] })).status, 'no-plan');
  const result = solve(p, settings({ selections: [{ ...selection, nodeOverride: 'gate', showTimes: [620] }] }));
  assert.equal(result.status, 'feasible');
  assert.equal(result.visits[0].node, 'gate');
});

test('transport activities finish at the disembarkation point and keep pedestrian distances separate', () => {
  const p = park([venue('a', { endNode: 'c', duration: 4 }), venue('b'), venue('c')]);
  const result = solve(p, settings({ selections: [{ id: 'a', weight: 5, required: true }] }));
  const outward = result.rows.find(item => item.kind === 'walk');
  const inward = result.rows.filter(item => item.kind === 'walk').at(-1);
  assert.equal(outward.to, 'a');
  assert.equal(inward.from, 'c');
  assert.equal(result.visits[0].endNode, 'c');
});

test('rest time and souvenir reserves are included in feasibility and the budget', () => {
  const p = park([venue('a', { duration: 25, cost: 1000 }), venue('b', { cost: 2000 }), venue('c')]);
  const result = solve(p, settings({ budget: 2500, souvenirReserve: 1000, restEvery: 20, restMinutes: 10 }));
  assert.ok(result.rows.some(item => item.kind === 'rest'));
  assert.ok(result.totals.cost <= 1500);
  assert.equal(result.totals.souvenirAllocation, 1000);
});

test('replanning preserves an already-started queue and its complete activity, then plans from its end', () => {
  const p = park([venue('a', { baseWait: 30, cost: 1000 }), venue('b'), venue('c')]);
  const first = solve(p, settings({ selections: [{ id: 'a', weight: 5 }, { id: 'b', weight: 2 }] }));
  const queue = first.rows.find(item => item.kind === 'queue');
  const cutoff = queue.start + 5;
  const s = settings({ replanFrom: cutoff, spentBudget: 1000, selections: [{ id: 'a', weight: 5 }, { id: 'c', weight: 4 }] });
  const result = solve(p, s, { initialPlan: first });
  const activity = result.rows.find(item => item.kind === 'activity' && item.activityId === 'a');
  assert.ok(activity.preserved);
  assert.equal(activity.end, first.visits[0].end);
  assert.equal(result.visits.find(item => item.id === 'c').start >= activity.end, true);
  assert.equal(result.totals.cost, 1000);
});

test('replanning new purchases never goes back to opening time, and a declared current position is an explicit anchor', () => {
  const p = park([venue('a', { dpa: { price: 1500, wait: 5, kind: 'attraction' } }), venue('b')]);
  const s = settings({ exit: 1260, replanFrom: 900, currentNode: 'b', budgetPreference: 'dpa',
    selections: [{ id: 'a', weight: 5, dpaMode: 'consider', dpaAvailableWindows: [[960, 980]] }] });
  const previous = { rows: [{ kind: 'walk', type: 'walk', start: 540, end: 544, from: 'gate', to: 'b', node: 'b', metres: 200, cost: 0 }, { kind: 'activity', type: 'activity', start: 550, end: 565, node: 'b', activityId: 'b', category: 'attraction', name: 'b', cost: 0, dpaCost: 0 }], visits: [{ id: 'b', node: 'b', start: 550, end: 565 }] };
  const result = solve(p, s, { initialPlan: previous });
  assert.ok(result.purchases[0].purchasedAt >= 900);
  const changed = solve(p, { ...s, currentNode: 'a' }, { initialPlan: previous });
  assert.ok(changed.rows.some(item => item.kind === 'location' && item.node === 'a'));
  assert.equal(validatePlan(p, { ...s, currentNode: 'a' }, changed).valid, true);
});

test('validator rejects omitted travel, counterfeit costs and an over-budget edited plan', () => {
  const p = park([venue('a', { cost: 100 })]), s = settings({ selections: [{ id: 'a', weight: 5 }] });
  const result = solve(p, s);
  const changed = structuredClone(result);
  changed.rows.find(item => item.kind === 'activity').cost = 2000;
  assert.equal(validatePlan(p, s, changed).valid, false);
  const teleported = structuredClone(result); teleported.rows = teleported.rows.filter(item => item.kind !== 'walk');
  assert.equal(validatePlan(p, s, teleported).valid, false);
  const expensive = structuredClone(result); expensive.totals.cost = 100000;
  assert.equal(validatePlan(p, s, expensive).valid, false);
});

test('tiny schedules agree with an independent exhaustive enumeration of all visit subsets and orders', () => {
  for (let instance = 0; instance < 12; instance++) {
    const activities = ['a', 'b', 'c', 'd', 'e'].map((id, i) => venue(id, { duration: 8 + (instance * 7 + i * 11) % 27, cost: (i % 3) * 300 }));
    const p = park(activities), s = settings({ exit: 595 + instance * 2, budget: 1500, selections: activities.map((item, i) => ({ id: item.id, weight: 1 + (i + instance) % 5 })) });
    // The fixture is a straight chain with 100 m per segment; this oracle does not call graphDistances or the search.
    let best = 0;
    const walk = (current, remaining, minute, cost, score) => {
      if (minute + Math.abs(current) * 2 <= s.exit) best = Math.max(best, score);
      for (const index of remaining) {
        const start = minute + Math.abs(current - (index + 1)) * 2;
        const end = start + activities[index].duration, money = cost + activities[index].cost;
        if (end + (index + 1) * 2 <= s.exit && money <= s.budget) walk(index + 1, remaining.filter(value => value !== index), end, money, score + s.selections[index].weight);
      }
    };
    walk(0, [0, 1, 2, 3, 4], s.entry, 0, 0);
    const result = solve(p, s);
    assert.equal(result.totals.score, best, 'instance ' + instance);
  }
});

test('a short exploration limit returns its best feasible answer with no optimality claim', () => {
  const activities = Array.from({ length: 30 }, (_, i) => venue('n' + i, { duration: 4 }));
  const p = park(activities), s = settings({ selections: activities.map(item => ({ id: item.id, weight: 3 })), searchSeconds: 0.05 });
  const started = performance.now(), result = solve(p, s);
  assert.ok(performance.now() - started < 1200);
  assert.equal(result.status, 'feasible');
  assert.equal(result.diagnostics.optimal, false);
});

test('an unspent owned DPA remains paid even when its wish is removed while replanning', () => {
  const p = park([venue('a', { dpa: { price: 1500, wait: 5, kind: 'attraction' } }), venue('b')]);
  const first = solve(p, settings({ selections: [{ id: 'a', weight: 5, dpaMode: 'owned', dpaPurchasedAt: 540, dpaStart: 650, dpaEnd: 680 }] }));
  const s = settings({ replanFrom: 570, selections: [{ id: 'b', weight: 3 }] });
  const result = solve(p, s, { initialPlan: first });
  assert.equal(result.totals.cost, 1500);
  assert.equal(result.purchases[0].owned, true);
  assert.equal(result.visits.some(visit => visit.id === 'a'), false);
  assert.ok(result.rows.find(item => item.kind === 'activity').start < 650);
});

test('a declared idle wait can be interrupted at the replanning time', () => {
  const p = park([venue('a', { category: 'show', showTimes: [680] }), venue('b')]);
  const first = solve(p, settings({ selections: [{ id: 'a', weight: 5 }] }));
  const result = solve(p, settings({ replanFrom: 580, selections: [{ id: 'b', weight: 5 }] }), { initialPlan: first });
  const wait = result.rows.find(item => item.kind === 'wait');
  assert.equal(wait.end, 580);
  assert.ok(result.visits[0].start < 680);
});

test('the independent validator detects a deleted final walk to the exit', () => {
  const p = park([venue('a')]), s = settings({ selections: [{ id: 'a', weight: 5 }] });
  const result = solve(p, s);
  const finalWalk = result.rows.filter(item => item.kind === 'walk').at(-1);
  result.rows = result.rows.filter(item => item !== finalWalk);
  assert.equal(validatePlan(p, s, result).valid, false);
});

test('considering parade DPA does not move its normal-viewing alternative to the paid area', () => {
  const p = park([venue('a', { category: 'parade', showTimes: [600], showTimesDate: '2026-11-17', dpa: { price: 2500, wait: 5, kind: 'show' } })]);
  const s = settings({ budget: 0, selections: [{ id: 'a', weight: 5, dpaMode: 'consider', dpaAvailableWindows: [[600, 620]], nodeOverride: 'gate', showTimes: [620] }] });
  const result = solve(p, s);
  assert.equal(result.visits[0].node, 'a');
  assert.equal(result.visits[0].start, 600);
  assert.equal(result.visits[0].method, 'normal');
});

test('an explicit replacement purchase ledger can correct a mistakenly recorded unused DPA', () => {
  const p = park([venue('a', { dpa: { price: 1500, wait: 5, kind: 'attraction' } }), venue('b')]);
  const first = solve(p, settings({ selections: [{ id: 'a', weight: 5, dpaMode: 'owned', dpaPurchasedAt: 540, dpaStart: 650, dpaEnd: 680 }] }));
  const s = settings({ replanFrom: 570, purchases: [], selections: [{ id: 'b', weight: 3 }] });
  const result = solve(p, s, { initialPlan: first });
  assert.equal(result.totals.cost, 0);
  assert.equal(result.purchases.length, 0);
});
