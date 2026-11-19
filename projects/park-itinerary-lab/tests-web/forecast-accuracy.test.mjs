import assert from 'node:assert/strict';
import test from 'node:test';
import {scoreForecastAccuracy} from '../web/forecast-accuracy.js';

const date = '2026-11-19';
const midnight = Date.parse(date + 'T00:00:00+09:00');
const instant = minute => new Date(midnight + minute * 60000).toISOString();
const facility = 'land-alpha';
const target = (minute, wait, activityId = facility, reference = null) => ({minute, wait, activityId, reference});
const post = (time, wait, activityId = facility) => ({
  date, activityId, source:'queue-times', time, observedAt:instant(time), wait
});

function score(rows, observations, {issuedAt = instant(-120), asOf = instant(1500), ...override} = {}) {
  const park = {parkId:'land', rows, issuedAt, activities:{[facility]:'施設A'}, crowd:{level:'busy'}};
  const forecast = {schemaVersion:1, date, slotMinutes:30, parks:[park]};
  return scoreForecastAccuracy({date, parkId:'land', forecast, observations, asOf, ...override});
}

test('one independent score per completed facility-slot; bias is signed, baseline uses matched support', () => {
  const rows = [target(630, 30, facility, 22), target(660, 5), target(690, 60), target(720, 20)];
  const observations = [post(630, 40), post(635, 60), post(635, 60), post(636, 80),
    post(655, 90), post(660, 5), post(688, 5), post(690, 50)];
  const result = score(rows, observations);
  assert.equal(result.status, 'complete');
  assert.equal(result.overall.expected, 4);
  assert.equal(result.overall.matched, 3);
  assert.equal(result.overall.coverage, 0.75);
  assert.equal(result.overall.mae, (40 + 0 + 10) / 3);
  assert.equal(result.overall.bias, (-40 + 0 + 10) / 3);
  assert.equal(result.overall.within10, 2 / 3);
  assert.equal(result.overall.meanPredicted, 95 / 3);
  assert.equal(result.overall.meanObserved, 125 / 3);
  assert.equal(result.overall.baselineMatched, 1);
  assert.equal(result.overall.baselineMae, 48);
  assert.equal(result.overall.comparableMae, 40);
  assert.equal(result.facilities[0].name, '施設A');
  assert.deepEqual(result.hours.map(row => [row.hour, row.matched, row.expected]), [[10,1,1],[11,2,2],[12,0,1]]);
});

test('archive backups fill uncovered collector buckets while all eligible primary posts still count', () => {
  const openingPost = (time, wait) => ({...post(time, wait), openingMinute:540});
  const backup = (time, wait) => ({...openingPost(time, wait), collector:'watchdog'});
  const observations = [
    backup(548, 100), openingPost(543, 10), openingPost(546, 20), // primary-only 09:00 bucket
    backup(550, 110), backup(555, 30), // latest backup in the 09:10 bucket
    {...openingPost(557, 0), isOpen:false}, // ineligible to suppress the 09:10 backup
    openingPost(787, 50), backup(795, 120) // after opening, 13:00 is a single 30-minute bucket
  ];
  for (const order of [observations, [...observations].reverse()]) {
    const result = score([target(540, 20), target(780, 50)], order);
    assert.equal(result.overall.samples, 4);
    assert.equal(result.overall.matched, 2);
    assert.equal(result.overall.mae, 0);
  }
});

test('only an eligible public measurement with a consistent dated timestamp can match', () => {
  const wrongPark = post(630, 30, 'sea-alpha');
  const observations = [wrongPark, {...post(630, 30), date:'2026-11-18'},
    {...post(630, 0), isOpen:false}, {...post(630, 30), source:'themeparks-wiki'},
    {...post(630, 30), observedAt:instant(631)}, {...post(630, 20), observedAt:date+'T10:30:00'},
    {...post(630, 30), observedAt:instant(630-1440)}, post(630, null), post(630, -2)];
  const missing = score([target(630, 5)], observations);
  assert.equal(missing.status, 'no-observations');
  assert.equal(missing.overall.mae, null);
  assert.equal(missing.overall.matched, 0);
  const openZero = score([target(630, 5)], [...observations, post(630, 0)]);
  assert.equal(openZero.overall.mae, 5);
  assert.equal(openZero.overall.baselineMae, null);
});

test('future, empty, missing and ongoing dates differ; future or unissued bins cannot earn a score', () => {
  const rows = [target(630, 20), target(660, 10), target(690, 15)], observed = [post(630, 30), post(660, 30)];
  assert.equal(score(rows, observed, {asOf:instant(-1)}).status, 'future');
  assert.equal(score(rows, observed, {forecast:null}).status, 'no-forecast');
  assert.equal(score(rows, observed, {date:'2026-11-18'}).status, 'no-forecast');
  assert.equal(score(rows, observed, {issuedAt:instant(695)}).status, 'no-forecast');
  assert.equal(score(rows, observed, {issuedAt:instant(630), asOf:instant(650)}).status, 'pending');
  assert.equal(score(rows, observed, {issuedAt:instant(740), asOf:instant(650)}).status, 'no-forecast');
  const partial = score(rows, observed, {asOf:instant(660)});
  assert.equal(partial.status, 'partial');
  assert.equal(partial.overall.expected, 1);
  assert.equal(partial.overall.matched, 1);
  assert.equal(partial.slotsInDay, 3);
  const late = score(rows, observed, {issuedAt:instant(630)});
  assert.equal(late.slotsInDay, 2);
  assert.equal(late.overall.matched, 1);
});

test('duplicate target bins, malformed rows and measurements outside truncated hours never inflate coverage', () => {
  const rows = [{...target(630, 50), endMinute:645}, target(630, 50), target(705, 50),
    target(660, NaN), target(-30, 20), target(690, 30, 'sea-test'), {...target(690, 10), endMinute:725}];
  const result = score(rows, [post(644, 40), post(645, 100), post(646, 120)]);
  assert.equal(result.overall.expected, 1);
  assert.equal(result.overall.matched, 1);
  assert.equal(result.overall.meanObserved, 40);
});

test('observed park congestion needs multiple hours per ride, three rides, and neutral facility weighting', () => {
  const slots = [], notes = [];
  for (const [suffix, minutes, observed] of [['a',[630,750,870],40],['b',[630,750],40],['c',[630,870],10]]) {
    for (const minute of minutes) {
      const id = 'land-'+suffix;
      slots.push(target(minute, 25, id, 20));
      notes.push(post(minute, observed, id));
    }
  }
  const result = score(slots, notes);
  assert.deepEqual(result.crowd, {forecastLevel:'busy',observedLevel:'busy',ratio:2,facilities:3,slots:7,expected:7,matched:7});
  const withoutThirdHour = score(slots, notes.filter(row=>row.time !== 870));
  assert.equal(withoutThirdHour.crowd.observedLevel, null);
  assert.equal(withoutThirdHour.crowd.ratio, null);
  assert.equal(withoutThirdHour.crowd.expected, 7);
  assert.equal(withoutThirdHour.crowd.matched, 5);
  const morning = score(slots, notes, {asOf:instant(700)});
  assert.equal(morning.crowd.expected, 3);
  assert.equal(morning.crowd.observedLevel, null);
  const scarce = score(slots, notes.filter(row => row.activityId === 'land-a'));
  assert.equal(scarce.crowd.observedLevel, null);
  const arbitraryHour = score([target(540, 20, facility, 25)], [post(540, 30)]);
  assert.equal(arbitraryHour.crowd.matched, 0);
  assert.equal(arbitraryHour.crowd.expected, 0);
});

test('invalid date and timezone-less as-of rejected', () => {
  assert.throws(() => score([], [], {date:'2026-02-31'}), RangeError);
  assert.throws(() => score([], [], {asOf:'2026-11-19T12:00:00'}), RangeError);
});
