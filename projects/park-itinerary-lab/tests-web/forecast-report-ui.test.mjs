import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAccuracyReport, issuanceNote} from '../web/accuracy-page.js';

const date = '2026-11-19', asOf = Date.parse('2026-11-19T12:00:00+09:00');
const forecastPath = 'forecasts/' + date + '.json';
const archivePath = 'history/2026-11.json';
const recentPath = 'observations.json';
const activityId = 'land-attraction-152';
const forecast = {
  schemaVersion: 1, slotMinutes: 30, date,
  parks: [{parkId:'land', issuedAt:'2026-11-18T13:00:00Z', activities:{[activityId]:'試験施設'}, crowd:{level:'normal'},
    rows:[{activityId, minute:570, wait:25}, {activityId, minute:600, wait:20}]}]
};
const observation = {source:'queue-times', date, time:575, wait:30, activityId, observedAt:'2026-11-19T00:35:00Z'};

function settings(responses, now = asOf) {
  const paths = [];
  const fetchImpl = async url => {
    const path = url.split('/park-wait-data/')[1];
    paths.push(path);
    assert.ok(Object.hasOwn(responses, path), 'Unexpected request: ' + path);
    const value = responses[path];
    if (value instanceof Error) throw value;
    return {ok: value !== 404, status: value === 404 ? 404 : 200, json:async () => value};
  };
  return {fetchImpl, asOf:now, paths};
}

test('a future date, an unavailable forecast and a pending day never download observation history', async () => {
  const next = settings({});
  assert.equal((await loadAccuracyReport('2026-11-20', 'land', next)).result.status, 'future');
  assert.deepEqual(next.paths, []);
  const missing = settings({[forecastPath]:404});
  assert.equal((await loadAccuracyReport(date, 'land', missing)).result.status, 'no-forecast');
  assert.deepEqual(missing.paths, [forecastPath]);
  const early = settings({[forecastPath]:forecast}, Date.parse('2026-11-19T09:15:00+09:00'));
  assert.equal((await loadAccuracyReport(date, 'land', early)).result.status, 'pending');
  assert.deepEqual(early.paths, [forecastPath]);
});

test('on-demand report combines archived and recent records with equal duplicate observations counted once', async () => {
  const newer = {...observation, time:610, wait:10, observedAt:'2026-11-19T01:10:00Z'};
  const options = settings({[forecastPath]:forecast, [archivePath]:[observation], [recentPath]:[observation, newer]});
  const report = await loadAccuracyReport(date, 'land', options);
  assert.equal(report.result.overall.matched, 2);
  assert.equal(report.result.overall.mae, 7.5);
  assert.equal(report.incompleteDownload, false);
  assert.equal(report.result.facilities[0].name, '試験施設');
});

test('archived dates need only one observation file, current missing month can use the rolling file', async () => {
  const historic = settings({[forecastPath]:forecast, [archivePath]:[observation]}, Date.parse('2027-02-01T00:00:00Z'));
  assert.equal((await loadAccuracyReport(date, 'land', historic)).result.overall.matched, 1);
  assert.deepEqual(historic.paths, [forecastPath, archivePath]);
  const monthlyMissing = settings({[forecastPath]:forecast, [archivePath]:404, [recentPath]:[observation]});
  assert.equal((await loadAccuracyReport(date, 'land', monthlyMissing)).result.overall.matched, 1);
});

test('report distinguishes missing records, partial observation-source failure, and transport errors', async () => {
  const missing = settings({[forecastPath]:forecast, [archivePath]:404, [recentPath]:[]});
  assert.equal((await loadAccuracyReport(date, 'land', missing)).result.status, 'no-observations');
  const partial = settings({[forecastPath]:forecast, [archivePath]:new Error('offline'), [recentPath]:[observation]});
  assert.equal((await loadAccuracyReport(date, 'land', partial)).incompleteDownload, true);
  const offline = settings({[forecastPath]:forecast, [archivePath]:new Error('offline'), [recentPath]:[]});
  await assert.rejects(loadAccuracyReport(date, 'land', offline), /取得/);
  await assert.rejects(loadAccuracyReport(date, 'land', settings({[forecastPath]:new Error('offline')})), /offline/);
  await assert.rejects(loadAccuracyReport(date, 'land', settings({[forecastPath]:{date:'2027-12-01'}})), /形式/);
});

test('invalid dates and unknown park IDs are rejected before a request', async () => {
  const options = settings({});
  await assert.rejects(loadAccuracyReport('2026-02-31', 'land', options));
  await assert.rejects(loadAccuracyReport(date, 'toString', options));
  assert.deepEqual(options.paths, []);
});

test('late first issuance describes the remaining hours using the park local date', () => {
  const late = issuanceNote({date, issuedAt:'2026-11-19T09:30:00Z'});
  assert.match(late, /当日18:30発行/);
  assert.match(late, /発行後の予測枠/);
  assert.match(issuanceNote({date, issuedAt:'2026-11-18T13:15:00Z'}), /予測保存時刻/);
});
