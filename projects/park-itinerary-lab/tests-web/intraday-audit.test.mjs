import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {issueIntraday, makeIssues, scoreIntraday} from '../scripts/issue_intraday_forecast.mjs';

const date = '2026-11-19';
const at = clock => Date.parse(date + 'T' + clock + ':00+09:00');
const now = at('10:02'), stamp = new Date(now).toISOString();
const ids = ['land-attraction-1', 'land-attraction-2', 'land-attraction-3'];
const park = {parkId:'land', issuedAt:'2026-11-18T22:00:00+09:00',
  rows:[570,600,660,690,720].flatMap(minute => ids.map(activityId => ({minute, activityId, wait:40, source:'ml'})))};
const forecast = {schemaVersion:1, slotMinutes:30, date, parks:[park]};
const snapshot = {parkId:'land', provider:'queue-times', fetchedAt:stamp,
  rides:ids.map(activityId => ({activityId, isOpen:true, wait:70, updatedAt:stamp}))};
const post = (time, wait, activityId = ids[0]) => ({activityId, date, time, wait, source:'queue-times',
  observedAt:new Date(at('00:00') + time * 60000).toISOString()});

test('public comparison uses current open observations, eligible horizons and original model rows only', () => {
  const [issue] = makeIssues(date, park, snapshot, now);
  assert.equal(issue.minute, 690);
  assert.deepEqual(issue.rows, ids.map(activityId => ({activityId,wait:50})));
  assert.equal(issue.issuedAt, stamp);
  assert.equal(issue.baselineIssuedAt, park.issuedAt);
  assert.equal(issue.evidence.rides,3);
  assert.equal(makeIssues(date, park, snapshot, at('10:18')).length,0);
  assert.equal(makeIssues(date, {...park, issuedAt:new Date(at('10:01')).toISOString()}, snapshot, now).length,0);
  for (const change of [{isOpen:false},{updatedAt:new Date(now + 60_000).toISOString()},{updatedAt:new Date(at('09:40')).toISOString()}]) {
    assert.equal(makeIssues(date,park,{...snapshot, rides:[...snapshot.rides.slice(0,2), {...snapshot.rides[2],...change}]},now).length,0);
  }
  assert.equal(makeIssues(date, park, {...snapshot,provider:'themeparks-wiki'}, now).length,0);
  assert.equal(makeIssues(date, park, {...snapshot,parkId:'sea'}, now).length,0);
  assert.equal(makeIssues(date, {...park,rows:park.rows.map(row=>({...row,source:'trend'}))}, snapshot,now).length,0);
});

test('paired score rejects after-the-fact issues and measures identical slots against deduplicated Queue-Times medians', () => {
  const [issue] = makeIssues(date,park,snapshot,now);
  const asOf = at('21:55');
  const samples = [post(691,58),post(691,58),post(693,62),post(692,30,ids[1]),{...post(692,90,ids[2]),source:'themeparks-wiki'}];
  const input = {date, forecast, observations:samples, asOf, intradayIssues:[issue]};
  assert.deepEqual(scoreIntraday(input,'land'),{source:'queue-times',leadMinutes:[75,105],expected:3,matched:2,samples:3,coverage:2/3,originalMae:15,correctedMae:15});
  assert.deepEqual(scoreIntraday({...input,observations:[]},'land'),{source:'queue-times',leadMinutes:[75,105],expected:3,matched:0,samples:0,coverage:0,originalMae:null,correctedMae:null});
  assert.equal(scoreIntraday({...input,intradayIssues:[{...issue,issuedAt:new Date(at('11:35')).toISOString()}]},'land'),null);
  assert.equal(scoreIntraday({...input,intradayIssues:[{...issue,issuedAt:new Date(at('10:45')).toISOString()}]},'land'),null);
  assert.equal(scoreIntraday({...input,intradayIssues:[{...issue,baselineIssuedAt:null}]},'land'),null);
});

test('concurrent issuers and retries freeze a single comparison and the nightly scorer retains it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tdroute-intraday-'));
  t.after(() => rm(dir,{force:true,recursive:true}));
  const publicDaily = join(dir,'forecasts',date+'.json');
  await mkdir(join(dir,'forecasts'));
  await writeFile(publicDaily, JSON.stringify(forecast));
  await writeFile(join(dir,'live-waits.json'), JSON.stringify({parks:[snapshot]}));
  const counts = await Promise.all([issueIntraday(dir,now),issueIntraday(dir,now)]);
  assert.equal(counts[0]+counts[1],1);
  const daily = join(dir,'forecasts-intraday',date);
  const path = join(daily,'land-1130.json');
  const original = await readFile(path,'utf8');
  assert.equal(await issueIntraday(dir,now+60_000),0);
  assert.equal(await readFile(path,'utf8'),original);
  assert.deepEqual(await readdir(daily),['land-1130.json']);
  assert.equal(await readFile(publicDaily,'utf8'),JSON.stringify(forecast));
  const scripts = fileURLToPath(new URL('../scripts/',import.meta.url));
  const run = () => execFileSync('python3',['-c',"import sys, datetime; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from score_daily_waits import run; run(Path(sys.argv[2]),datetime.datetime.fromisoformat('2026-11-19T22:00:00+09:00'))",scripts,dir]);
  const readReport = async () => JSON.parse(await readFile(join(dir,'accuracy-daily',date+'.json'),'utf8'));
  await writeFile(join(dir,'observations.json'),JSON.stringify([post(694,50)]));
  run();
  const comparison = (await readReport()).parks[0].intradayComparison;
  assert.equal(comparison.originalMae,10);
  assert.equal(comparison.correctedMae,0);
  assert.equal(comparison.matched,1);
  await writeFile(join(dir,'observations.json'),'[]');
  run();
  assert.deepEqual((await readReport()).parks[0].intradayComparison,comparison);
});
