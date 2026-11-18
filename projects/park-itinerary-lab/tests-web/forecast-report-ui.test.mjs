import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreForecastAccuracy} from '../web/forecast-accuracy.js';
import {loadAccuracyReport, issuanceNote} from '../web/accuracy-page.js';

const date = '2026-11-19', asOf = Date.parse('2026-11-19T12:00:00+09:00');
const forecastPath = 'forecasts/' + date + '.json';
const archivePath = 'history/2026-11.json';
const recentPath = 'observations.json';
const dailyPath = 'accuracy-daily/' + date + '.json';
const summaryPath = 'accuracy-history/' + date + '.json';
const activityId = 'land-attraction-152';
const forecast = {
  schemaVersion: 1, slotMinutes: 30, date,
  parks: [{parkId:'land', issuedAt:'2026-11-18T13:00:00Z', activities:{[activityId]:'試験施設'}, crowd:{level:'normal'},
    rows:[{activityId, minute:570, wait:25}, {activityId, minute:600, wait:20}]}]
};
const observation = {source:'queue-times', date, time:575, wait:30, activityId, observedAt:'2026-11-19T00:35:00Z'};

function settings(responses, now = asOf) {
  responses = {[summaryPath]:404, [dailyPath]:404, ...responses};
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
  assert.deepEqual(missing.paths, [forecastPath, dailyPath]);
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
  assert.deepEqual(historic.paths, [forecastPath, dailyPath, summaryPath, archivePath]);
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

const evening = Date.parse('2026-11-19T23:00:00+09:00');
const sea = {
  ...forecast.parks[0], parkId:'sea', issuedAt:'2026-11-19T09:55:31.742Z',
  rows:Array.from({length:103}, (_, i) => ({
    activityId:'sea-attraction-' + (i % 27), minute:1140 + Math.floor(i / 27) * 30, wait:20
  }))
};
const seaForecast = {...forecast, parks:[sea]};
const changeSummary = {
  schemaVersion:1, date, source:'themeparks-wiki', method:'latest-standby-change-per-slot',
  parks:[{parkId:'sea', issuedAt:sea.issuedAt, expected:103, matched:41, mae:11.37, bias:-4.5,
    within10:25/41, crowd:{forecastLevel:'normal', observedLevel:null, facilities:0, slots:0, ratio:null}}]
};

test('completed 103-slot evening uses independently scored history, even with no sampled posts', async () => {
  const options = settings({[forecastPath]:seaForecast, [archivePath]:[], [recentPath]:[], [summaryPath]:changeSummary}, evening);
  const report = await loadAccuracyReport(date, 'sea', options);
  assert.equal(report.result.status, 'complete');
  assert.equal(report.result.provider, 'themeparks-wiki');
  assert.equal(report.result.overall.matched, 41);
  assert.equal(report.result.overall.coverage, 41 / 103);
  assert.equal(report.result.overall.mae.toFixed(1), '11.4');
  assert.equal(report.queueTimes.overall.matched, 0);
});

test('when both sources match, keep the coverage and breakdown of each source separate', async () => {
  const post = {source:'queue-times', date, time:1140, wait:35, activityId:'sea-attraction-0',
    observedAt:'2026-11-19T10:00:00Z'};
  const options = settings({[forecastPath]:seaForecast, [archivePath]:[post], [recentPath]:[post], [summaryPath]:changeSummary}, evening);
  const report = await loadAccuracyReport(date, 'sea', options);
  assert.equal(report.result.overall.matched, 41);
  assert.equal(report.historyComparison.matched, 41);
  assert.equal(report.queueTimes.overall.matched, 1);
  assert.equal(report.queueTimes.overall.mae, 15);
  assert.equal(report.queueTimes.facilities.find(({activityId}) => activityId === post.activityId).matched, 1);
});

test('a historical summary survives a Queue-Times outage and cannot attach to a different forecast', async () => {
  const responses = {[forecastPath]:seaForecast, [archivePath]:new Error('offline'), [recentPath]:[], [summaryPath]:changeSummary};
  const report = await loadAccuracyReport(date, 'sea', settings(responses, evening));
  assert.ok(report.queueIncomplete);
  assert.equal(report.result.overall.matched, 41);
  const unrelated = {...changeSummary, parks:[{...changeSummary.parks[0], issuedAt:'2026-11-19T23:00:00Z'}]};
  await assert.rejects(loadAccuracyReport(date, 'sea', settings({...responses, [summaryPath]:unrelated}, evening)), /取得/);
});

test('before all slots end, ignore a nightly summary and score elapsed slots only', async () => {
  const options = settings({[forecastPath]:seaForecast, [archivePath]:[], [recentPath]:[], [summaryPath]:changeSummary},
    Date.parse('2026-11-19T20:15:00+09:00'));
  const report = await loadAccuracyReport(date, 'sea', options);
  assert.equal(report.result.status, 'no-observations');
  assert.deepEqual(options.paths, [forecastPath, archivePath, recentPath]);
});

test('an overall timeout retains a completed provider summary but explicit cancellation still aborts', async () => {
  for (const reason of ['TimeoutError', 'AbortError']) {
    const controller = new AbortController();
    const fetchImpl = async (url, {signal}) => {
      if (url.endsWith(archivePath) || url.endsWith(recentPath)) {
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
      }
      if (url.endsWith(summaryPath)) {
        setTimeout(() => controller.abort(new DOMException('interrupted', reason)), 0);
      }
      return {ok:true, json:async () => url.endsWith(summaryPath) ? changeSummary : seaForecast};
    };
    const loading = loadAccuracyReport(date, 'sea', {asOf:evening, fetchImpl, signal:controller.signal});
    if (reason === 'AbortError') await assert.rejects(loading, {name:'AbortError'});
    else {
      const report = await loading;
      assert.equal(report.result.overall.matched, 41);
      assert.equal(report.queueIncomplete, true);
    }
  }
});


function dailyScores(dateForecast, records, parkId = 'land') {
  const scored = scoreForecastAccuracy({date, forecast:dateForecast, observations:records, parkId, asOf:evening});
  return {schemaVersion:1, date, source:'queue-times', method:'median-per-slot', parks:[scored]};
}

test('stored after-close scores include breakdowns and coverage without downloading monthly observations', async () => {
  const daily = dailyScores(forecast, [observation]);
  const options = settings({[forecastPath]:forecast, [dailyPath]:daily}, evening);
  const report = await loadAccuracyReport(date, 'land', options);
  assert.equal(report.savedDaily, true);
  assert.equal(report.result.provider, 'queue-times');
  assert.equal(report.result.overall.coverage, 0.5);
  assert.equal(report.result.overall.mae, 5);
  assert.deepEqual(report.result.facilities, daily.parks[0].facilities);
  assert.deepEqual(options.paths, [forecastPath, dailyPath, summaryPath]);
});

test('saved missing outcomes distinguish a missing forecast and an issued forecast without matching posts', async () => {
  for (const issued of [null, forecast]) {
    const daily = dailyScores(issued, []);
    const options = settings({[forecastPath]:issued ?? 404, [dailyPath]:daily, [summaryPath]:new Error('offline')}, evening);
    const report = await loadAccuracyReport(date, 'land', options);
    assert.equal(report.savedDaily, true);
    assert.equal(report.result.status, issued ? 'no-observations' : 'no-forecast');
    assert.equal(report.result.overall.matched, 0);
    assert.equal(report.result.overall.mae, null);
    assert.ok(!options.paths.includes(archivePath));
  }
});

test('past samples remain available when the saved report belongs to a different issuance', async () => {
  const daily = dailyScores(forecast, [observation]);
  daily.parks[0].issuedAt = '2026-11-18T18:00:00Z';
  const options = settings({[forecastPath]:forecast, [dailyPath]:daily, [archivePath]:[], [recentPath]:[observation]}, evening);
  const report = await loadAccuracyReport(date, 'land', options);
  assert.equal(report.savedDaily, false);
  assert.equal(report.queueTimes.overall.matched, 1);
  assert.ok(options.paths.includes(archivePath));
});

test('saved samples and supplementary provider scores remain independent', async () => {
  const post = {source:'queue-times', date, time:1140, wait:35, activityId:'sea-attraction-0',
    observedAt:'2026-11-19T10:00:00Z'};
  const daily = dailyScores(seaForecast, [post], 'sea');
  const options = settings({[forecastPath]:seaForecast, [dailyPath]:daily, [summaryPath]:changeSummary}, evening);
  const report = await loadAccuracyReport(date, 'sea', options);
  assert.equal(report.savedDaily, true);
  assert.equal(report.result.provider, 'themeparks-wiki');
  assert.equal(report.historyComparison.matched, 41);
  assert.equal(report.queueTimes.overall.matched, 1);
  assert.ok(!options.paths.includes(recentPath));
});
