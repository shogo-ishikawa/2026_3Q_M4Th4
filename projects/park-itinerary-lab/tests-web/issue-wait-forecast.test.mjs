import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {forecastPark, issueForecast, targetDay} from '../scripts/issue_wait_forecast.mjs';
import {defaultSettings} from '../web/app.js';
import {estimateWait, setWaitForecastContext} from '../web/planner.js';
import {estimateParkCrowd} from '../web/wait-model.js';

const date = '2026-11-19';
const json = async name => JSON.parse(await readFile(new URL('../web/data/' + name, import.meta.url)));
const park = (await json('parks.json')).parks[0];
const models = await json('wait-model.json');
const model = models.parks.find(item => item.parkId === park.id);
const rideIds = new Set(Object.values((await json('queue-times-map.json')).parks[park.id].rides));
const calendarData = await json('calendar.json');

test('nightly issuance targets the next JST day from 21:55, also covers midnight and month rollovers', () => {
  const day = time => targetDay(new Date(time));
  assert.equal(day('2026-11-30T12:54:59.999Z'), '2026-11-30');
  assert.equal(day('2026-11-30T12:55:00Z'), '2026-12-01');
  assert.equal(day('2026-11-30T15:00:00Z'), '2026-12-01');
  const lateHours = {parks:[{id:'sea', operatingCalendar:{'2026-11-30':{windows:[[540, 1340]]}}}]};
  assert.equal(targetDay(new Date('2026-11-30T13:19:00Z'), lateHours), '2026-11-30');
  assert.equal(targetDay(new Date('2026-11-30T13:20:00Z'), null, lateHours), '2026-12-01');
});

test('a frozen standard day matches the common planner and only uses pre-existing crowd references', async () => {
  const issuedAt = '2026-11-18T12:56:00Z';
  const settings = {...defaultSettings(), date, waitModel:model, calendarData};
  const crowd = setWaitForecastContext(park, settings);
  const report = await forecastPark(park, {date, issuedAt, waitModel:model, calendarData, rideIds});
  assert.deepEqual(report.crowd, crowd);
  assert.equal(report.weatherProvider, null);
  assert.deepEqual(report.weatherHours, []);
  assert.equal(report.visitDayFactors.dayType, 'weekday');
  assert.equal(report.visitDayFactors.longWeekendPosition, 'ordinary');
  assert.deepEqual(report.visitDayFactors.eventIds, park.events.filter(event =>
    event.startDate<=date && date<=event.endDate).map(event => event.id));
  assert.equal(report.trainedThrough, model.lastDate);
  assert.deepEqual(new Set(report.rows.map(row => row.source)), new Set(['ml', 'trend']));
  const activities = new Map(park.activities.map(a => [a.id, a]));
  const profiles = new Map(model.activityTimeProfiles.map(p => [p.activityId + '/' + p.hour, p]));
  const binKeys = new Set();
  for (const row of report.rows) {
    const end = row.endMinute ?? row.minute + 30;
    const expected = estimateWait(activities.get(row.activityId), Math.floor((row.minute + end) / 2), settings);
    assert.equal(row.wait, expected.minutes);
    assert.equal(report.activities[row.activityId], activities.get(row.activityId).name);
    const key = row.activityId + '/' + row.minute;
    assert.ok(!binKeys.has(key)); binKeys.add(key);
    if (row.reference !== null) {
      assert.ok([630, 750, 870, 990, 1110].includes(row.minute));
      const profile = profiles.get(row.activityId + '/' + Math.floor(row.minute / 60));
      assert.ok(profile.days >= 3 && profile.samples >= 5 && profile.meanWait >= 10);
      assert.equal(row.reference, profile.meanWait);
    }
  }
  assert.ok(report.rows.some(row => row.reference !== null));
  const futureMonth = {...settings, date:'2026-12-04'};
  let baselines = 0;
  assert.deepEqual(estimateParkCrowd(park, futureMonth, () => baselines++), estimateParkCrowd(park, futureMonth));
  assert.equal(estimateParkCrowd(park, futureMonth).source, 'calendar');
  assert.ok(baselines > 0);

  const holiday = {...settings, date:'2026-11-23'};
  baselines = 0;
  const holidayForecast = estimateParkCrowd(park, holiday, () => baselines++);
  assert.deepEqual(holidayForecast, estimateParkCrowd(park, holiday));
  assert.equal(holidayForecast.source, 'calendar');
  assert.equal(holidayForecast.level, 'busy');
  assert.ok(baselines > 0);
});

test('late issuance excludes begun intervals, known closures and dated pauses', async () => {
  const date = '2026-11-19', issuedAt = '2026-11-19T03:00:00Z'; // exactly 12:00 JST
  const base = {category:'attraction', baseWait:10, windows:[[540,1260]], windowsDate:date};
  const example = {id:'land', activities:[
    {id:'land-open', name:'open', ...base, dailySchedules:{[date]:{windows:[[630,805]], pauseWindows:[[765,810]]}}},
    {id:'land-closed', name:'closed', ...base, closedDates:[date]},
    {id:'land-unmapped', name:'unmapped', ...base}
  ], operatingCalendar:{[date]:{windows:[[540,1260]]}}};
  const report = await forecastPark(example, {date, issuedAt, waitModel:null, calendarData,
    rideIds:new Set(['land-open','land-closed'])});
  assert.deepEqual(report.rows.map(r => [r.activityId, r.minute, r.endMinute]), [['land-open',750,765]]);
  assert.equal(report.crowd.source, 'calendar');
  assert.equal(report.rows[0].reference, null);
});

test('the weather source is the available forecast at issuance', async () => {
  const issuedAt = '2026-11-18T12:56:00Z';
  const hourly = {time:[date+'T10:00',date+'T11:00'],temperature_2m:[13,15],
    weather_code:[61,61], precipitation:[0,1.5], precipitation_probability:[0,0]};
  const entry = {data:{hourly}, fetchedAt:issuedAt};
  const forecast = weatherCache => forecastPark(park, {date, issuedAt, waitModel:model, calendarData, rideIds, weatherCache});
  const current = await forecast({schemaVersion:1, providers:{'open-meteo':entry}});
  assert.equal(current.weatherProvider, 'open-meteo');
  assert.equal(current.weatherFetchedAt, issuedAt);
  assert.equal(current.weatherIssuedAt, null);
  assert.deepEqual(current.weatherHours, [
    {minute:600,endMinute:660,weather:'rain',weatherFromMinute:600,weatherToMinute:660,temperature:13,precipitation:1.5},
    {minute:660,endMinute:720,weather:'rain',weatherFromMinute:660,weatherToMinute:720,temperature:15,precipitation:null}
  ]);
  const future = await forecast({schemaVersion:1, providers:{'open-meteo':{...entry,fetchedAt:'2026-11-18T12:56:01Z'}}});
  assert.equal(future.weatherProvider, null);
  assert.deepEqual(future.weatherHours, []);
});

test('late JMA issue preserves original three-hour and daily weather periods without inventing hourly measurements', async () => {
  const issuedAt = date+'T01:05:00Z'; // 10:05 JST, first wait interval is 10:30.
  const reportDatetime = date+'T06:00:00+09:00';
  const op = at => date+'T'+at+':00+09:00';
  const forecast = [{reportDatetime,timeSeries:[{timeDefines:[op('06:00')],
    areas:[{area:{code:'120010'},weatherCodes:['100']}]}]}];
  const series = {reportDateTime:reportDatetime,
    areaTimeSeries:{timeDefines:[{dateTime:op('09:00'),duration:'PT3H'}],weather:['雨']},
    pointTimeSeries:{pointNameEN:'Chiba',timeDefines:[{dateTime:op('09:00')},{dateTime:op('12:00')}],temperature:[16,18]}};
  const weatherCache = {schemaVersion:1,providers:{jma:{forecast,series,fetchedAt:issuedAt}}};
  const issue = () => forecastPark(park,{date,issuedAt,waitModel:null,calendarData,rideIds,weatherCache});
  const report = await issue();
  assert.equal(report.weatherProvider, 'jma');
  assert.equal(report.weatherIssuedAt, reportDatetime);
  assert.equal(report.weatherHours[0].minute, 600);
  assert.deepEqual(report.weatherHours[0],{minute:600,endMinute:660,weather:'rain',
    weatherFromMinute:540,weatherToMinute:720,temperature:null,precipitation:null});
  assert.deepEqual(report.weatherHours.find(row=>row.minute===720),{minute:720,endMinute:780,weather:'sun',
    weatherFromMinute:360,weatherToMinute:1440,temperature:18,precipitation:null});
  assert.ok(report.weatherHours.every(row=>row.precipitation===null));
  forecast[0].reportDatetime = date+'T10:05:01+09:00';
  assert.deepEqual((await issue()).weatherHours, []);
});

test('concurrent runs freeze once; later models and repeated runs cannot change published bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tdroute-forecast-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const time = new Date('2026-11-18T12:56:00Z');
  const unseen = structuredClone(models);
  for (const model of unseen.parks) model.trainedAt = '2027-01-01T00:00:00Z';
  await writeFile(join(directory, 'wait-model.json'), JSON.stringify(unseen));
  const laterCatalogue = await json('parks.json');
  laterCatalogue.fetchedAt = '2027-01-01T00:00:00Z';
  for (const p of laterCatalogue.parks) p.events = [];
  await writeFile(join(directory, 'catalogue.json'), JSON.stringify(laterCatalogue));
  const files = (await Promise.all([issueForecast(directory,time), issueForecast(directory,time)])).filter(Boolean);
  assert.equal(files.length, 1);
  const before = await readFile(files[0], 'utf8');
  const snapshot = JSON.parse(before);
  assert.deepEqual(snapshot.parks.map(park => park.parkId), ['land','sea']);
  assert.ok(snapshot.parks.every(park => park.visitDayFactors.eventIds.length > 0));
  assert.ok(snapshot.parks.every(park => Date.parse(park.modelTrainedAt) < time.getTime()));
  await writeFile(join(directory, 'wait-model.json'), 'invalid');
  assert.equal(await issueForecast(directory, new Date('2026-11-19T02:00:00Z')), null);
  assert.equal(await readFile(files[0], 'utf8'), before);
});
