// Publish a standard park-wide comparison, independent of individual itineraries.
import {randomUUID} from 'node:crypto';
import {link, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {adjustedIntradayMinutes, summariseIntradayResiduals} from '../web/intraday-waits.js';
import {scoreForecastAccuracy} from '../web/forecast-accuracy.js';

const MINUTE = 60_000;
const SLOT = 30;
const LEAD_MIN = 75;
const LEAD_MAX = 105;
const validWait = value => Number.isFinite(value) && value >= 0 && value <= 600;
const dayInJapan = time => new Date(time + 9 * 3600_000).toISOString().slice(0, 10);
const midnightOf = date => Date.parse(date + 'T00:00:00+09:00');
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const midpoint = row => Math.floor((row.minute + (row.endMinute ?? row.minute + SLOT)) / 2);
const inLeadWindow = lead => lead >= LEAD_MIN && lead < LEAD_MAX;
const rowKey = row => row.activityId + '|' + row.minute;

function modelRows(park, date) {
  const midnight = midnightOf(date), issued = timestamp(park.issuedAt);
  return (park.rows || []).filter(row => row?.source === 'ml' && typeof row.activityId === 'string' && row.activityId.startsWith(park.parkId + '-attraction-') &&
    Number.isInteger(row.minute) && row.minute >= 0 && row.minute < 1440 && row.minute % SLOT === 0 &&
    (row.endMinute === undefined || Number.isInteger(row.endMinute) && row.endMinute > row.minute && row.endMinute <= row.minute + SLOT) &&
    validWait(row.wait) && issued < midnight + row.minute * MINUTE);
}

// Baselines come from the frozen facility/half-hour estimates. The app can use a
// different live provider and the exact minute, so this is a standardised test.
export function makeIssues(date, park, snapshot, now) {
  const midnight = midnightOf(date), collected = timestamp(snapshot?.fetchedAt);
  if (date !== dayInJapan(now) || !park || park.parkId !== snapshot?.parkId || snapshot.provider !== 'queue-times' ||
      !Array.isArray(snapshot.rides) || !(collected >= midnight && collected <= now && now - collected <= 15 * MINUTE)) return [];
  const rows = modelRows(park, date);
  const bySlot = new Map(rows.map(row => [rowKey(row), row]));
  const samples = [];
  for (const ride of snapshot.rides) {
    const observed = timestamp(ride.updatedAt);
    if (ride.isOpen !== true || !validWait(ride.wait) || !(observed >= midnight && observed <= collected && now - observed <= 15 * MINUTE)) continue;
    const minute = Math.floor((observed - midnight) / MINUTE);
    const row = bySlot.get(rowKey({activityId:ride.activityId, minute:Math.floor(minute / SLOT) * SLOT}));
    if (row && minute < (row.endMinute ?? row.minute + SLOT)) samples.push({activityId:row.activityId, expected:row.wait, observed:ride.wait});
  }
  const asOfMinute = Math.floor((now - midnight) / MINUTE);
  const signal = summariseIntradayResiduals(samples, asOfMinute);
  if (!signal) return [];
  const issues = new Map();
  for (const row of rows) {
    if (!inLeadWindow(midpoint(row) - asOfMinute) || midnight + row.minute * MINUTE <= now) continue;
    if (!issues.has(row.minute)) issues.set(row.minute, {
      schemaVersion:1, date, parkId:park.parkId, minute:row.minute, issuedAt:new Date(now).toISOString(),
      baselineIssuedAt:park.issuedAt, source:'queue-times', evidence:{rides:signal.rides, agreeing:signal.agreeing, offset:signal.offset}, rows:[]});
    issues.get(row.minute).rows.push({activityId:row.activityId, wait:adjustedIntradayMinutes(row.wait, midpoint(row), signal)});
  }
  return [...issues.values()];
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function freeze(path, issue) {
  await mkdir(dirname(path), {recursive:true});
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(issue) + '\n', {flag:'wx'});
    await link(temp, path); // Only the first issue for this park and target slot can win.
    return true;
  } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { await rm(temp, {force:true}); }
}

export async function issueIntraday(directory, now = Date.now()) {
  const date = dayInJapan(now);
  const [forecast, live] = await Promise.all([readOptional(join(directory, 'forecasts', date + '.json')),
    readOptional(join(directory, 'live-waits.json'))]);
  if (forecast?.schemaVersion !== 1 || forecast.date !== date || forecast.slotMinutes !== SLOT || !Array.isArray(forecast.parks)) return 0;
  let count = 0;
  for (const parkId of ['land', 'sea']) {
    const park = forecast.parks.find(item => item.parkId === parkId);
    const snapshot = live?.parks?.find(item => item.parkId === parkId);
    if (!park || !snapshot) continue;
    for (const issue of makeIssues(date, park, snapshot, now)) {
      const clock = String(Math.floor(issue.minute / 60)).padStart(2,'0') + String(issue.minute % 60).padStart(2,'0');
      if (await freeze(join(directory, 'forecasts-intraday', date, parkId + '-' + clock + '.json'), issue)) count++;
    }
  }
  return count;
}

export function scoreIntraday(input, parkId) {
  const {date, forecast, intradayIssues} = input;
  const park = forecast?.parks?.find(item => item.parkId === parkId);
  if (!park || !intradayIssues?.length) return null;
  const midnight = midnightOf(date);
  const baseline = new Map(modelRows(park, date).map(row => [rowKey(row), row]));
  const original = [], corrected = [], seen = new Set();
  for (const issue of intradayIssues) {
    const issued = timestamp(issue?.issuedAt);
    if (issue?.schemaVersion !== 1 || issue.source !== 'queue-times' || issue.parkId !== parkId || issue.date !== date ||
        issue.baselineIssuedAt !== park.issuedAt || !(issued >= midnight && issued >= timestamp(park.issuedAt) && issued < midnight + issue.minute * MINUTE) ||
        !Array.isArray(issue.rows)) continue;
    for (const candidate of issue.rows) {
      if (!candidate || typeof candidate.activityId !== 'string') continue;
      const key = rowKey({activityId:candidate.activityId, minute:issue.minute});
      const row = baseline.get(key);
      if (!row || seen.has(key) || !validWait(candidate.wait) || !inLeadWindow(midpoint(row) - Math.floor((issued - midnight) / MINUTE))) continue;
      seen.add(key);
      original.push(row);
      corrected.push({...row, wait:candidate.wait});
    }
  }
  if (!original.length) return null;
  const measure = rows => scoreForecastAccuracy({...input, parkId, source:'queue-times', forecast:{...forecast, parks:[{...park, rows}]}}).overall;
  const before = measure(original), after = measure(corrected);
  return {source:'queue-times', leadMinutes:[LEAD_MIN, LEAD_MAX], expected:after.expected, matched:after.matched,
    samples:after.samples, coverage:after.coverage, originalMae:before.mae, correctedMae:after.mae};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, directory, ...extra] = process.argv.slice(2);
  if (flag !== '--data-dir' || !directory || extra.length) throw Error('指定方法: --data-dir データの保存先');
  console.log('新たに保存した園別・時間帯別の当日補正 ' + await issueIntraday(directory) + '件');
}
