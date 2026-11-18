// Freeze the online app's standard forecast while its target intervals are still in the future.
import {randomUUID} from 'node:crypto';
import {access, link, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chooseCatalogue, defaultSettings} from '../web/app.js';
import {calendarContext, longWeekendPosition, visitDayContext} from '../web/calendar-features.js';
import {activityAvailable, operationPauseInfo, subtractPauseWindows} from '../web/operation-windows.js';
import {estimateWait, setWaitForecastContext} from '../web/planner.js';
import {validateCatalogue} from '../web/storage.js';
import {shouldUsePublishedModel, validateCalendarData} from '../web/wait-data.js';
import {prepareWeatherForVisit, weatherFromPublishedCache} from '../web/weather.js';

const bundled = fileURLToPath(new URL('../web/data/', import.meta.url));
const slotMinutes = 30;
const jstOffset = 9 * 3600000;

// Missed evenings can issue the next morning, but past dates and started slots cannot be filled.
export function targetDay(issuedAt, published, bundledCatalogue) {
  const local = new Date(issuedAt.getTime() + jstOffset);
  const today = local.toISOString().slice(0, 10);
  let lastClose = 21 * 60 + 55;
  for (const parkId of ['land', 'sea']) {
    for (const catalogue of [published, bundledCatalogue]) {
      const windows = catalogue?.parks?.find(park => park.id === parkId)?.operatingCalendar?.[today]?.windows;
      const ends = (windows ?? []).filter(w => Array.isArray(w) && w.length === 2)
        .map(w => w[1]).filter(end => Number.isInteger(end) && end > 0 && end <= 1440);
      if (ends.length) {
        lastClose = Math.max(lastClose, ...ends);
        break;
      }
    }
  }
  if (local.getUTCHours() * 60 + local.getUTCMinutes() >= lastClose) {
    local.setUTCDate(local.getUTCDate() + 1);
  }
  return local.toISOString().slice(0, 10);
}

function chooseModel(candidates, parkId, date, now) {
  let chosen = null;
  for (const data of candidates) {
    const model = data?.parks?.find(item => item.parkId === parkId);
    if (model && Date.parse(model.trainedAt) <= now && model.lastDate < date &&
        shouldUsePublishedModel(chosen, model, parkId)) chosen = model;
  }
  return chosen;
}

function availableWindows(park, activity, settings, parkWindows) {
  const daily = activity.dailySchedules?.[settings.date];
  const hours = daily?.windows ?? (activity.windowsDate === settings.date ? activity.windows : null);
  const windows = hours ? parkWindows.flatMap(([open, close]) => hours.map(([a, b]) =>
    [Math.max(open, a), Math.min(close, b)]).filter(([a, b]) => a < b)) : parkWindows;
  const pauses = operationPauseInfo(park, activity, {}, settings).windows;
  return subtractPauseWindows(windows, pauses);
}

// Hours are JST intervals on the visit date. JMA's daily or three-hour weather
// keeps its original coverage. A point temperature is recorded only at that point.
function issuedWeatherHours(forecast, rows) {
  if (!forecast) return [];
  const hours = new Set(rows.map(row => Math.floor(row.minute / 60) * 60));
  return forecast.hours.filter(row => hours.has(row.minute)).map(row => ({
    minute:row.minute, endMinute:row.endMinute, weather:row.weather,
    weatherFromMinute:row.weatherFromMinute ?? row.minute,
    weatherToMinute:row.weatherToMinute ?? row.endMinute,
    temperature:forecast.provider === 'jma' && row.temperatureAtMinute !== row.minute ? null : row.temperature,
    precipitation:row.precipitation
  }));
}

function dayType(date, calendar) {
  const day = calendarContext(date, calendar);
  if (day.isHoliday) return 'holiday';
  if (day.weekday === 0 || day.weekday === 6) return 'weekend';
  return day.holidayKnown ? 'weekday' : null;
}

export async function forecastPark(park, {date, issuedAt, waitModel, calendarData, weatherCache, rideIds}) {
  const now = Date.parse(issuedAt);
  const midnight = Date.parse(date + 'T00:00:00+09:00');
  const parkWindows = park.operatingCalendar?.[date]?.windows ?? [[540, 1260]];
  const defaults = defaultSettings();
  const settings = await prepareWeatherForVisit({
    ...defaults, date, waitModel, calendarData, waitAsOf:now, liveMode:'off',
    entry:parkWindows[0]?.[0] ?? defaults.entry,
    exit:parkWindows.at(-1)?.[1] ?? defaults.exit
  }, park, {fetchWeatherImpl:() => weatherFromPublishedCache(weatherCache, date, now, {strictAsOf:true})});
  const references = new Map();
  const crowd = setWaitForecastContext(park, settings, (id, minute, mean) =>
    references.set(id + '/' + minute, mean));
  const activities = {}, rows = [];
  for (const activity of park.activities) {
    if (!rideIds.has(activity.id) || !activityAvailable(activity, date)) continue;
    const windows = availableWindows(park, activity, settings, parkWindows);
    for (const [open, close] of windows) {
      for (let minute = Math.ceil(open / slotMinutes) * slotMinutes; minute < close; minute += slotMinutes) {
        if (midnight + minute * 60000 <= now) continue;
        const end = Math.min(minute + slotMinutes, close);
        const estimate = estimateWait(activity, Math.floor((minute + end) / 2), settings);
        const row = {activityId:activity.id, minute, wait:estimate.minutes, source:estimate.source,
          reference:references.get(activity.id + '/' + minute) ?? null};
        if (end < minute + slotMinutes) row.endMinute = end;
        rows.push(row);
        activities[activity.id] = activity.name;
      }
    }
  }
  const forecast = settings.weatherForecast;
  const calendar = calendarData || waitModel?.calendarData;
  return {parkId:park.id, issuedAt, trainedThrough:waitModel?.lastDate ?? null,
    modelTrainedAt:waitModel?.trainedAt ?? null, weatherProvider:forecast?.provider ?? null,
    weatherFetchedAt:forecast?.fetchedAt ?? null, weatherIssuedAt:forecast?.issuedAt ?? null,
    weatherSourceUrl:forecast?.sourceUrl ?? null, weatherHours:issuedWeatherHours(forecast, rows),
    weatherAssumption:settings.weather,
    visitDayFactors:{
      inputs:visitDayContext(date,park,calendar,now),
      dayType:dayType(date,calendar), longWeekendPosition:longWeekendPosition(date,calendar),
      eventIds:settings.activeEvents.map(event => event.id),
      modelFeatures:waitModel?.usable ? (waitModel.visitFactors || []).map(factor=>factor.name) : []
    }, crowd, activities, rows};
}

async function readJson(path, optional = false) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function issueForecast(directory, currentTime = new Date()) {
  const [bundledCatalogue, publishedCatalogue] = await Promise.all([
    readJson(join(bundled, 'parks.json')), readJson(join(directory, 'catalogue.json'), true)
  ]);
  const asOf = currentTime.getTime();
  const knownCatalogues = [bundledCatalogue, publishedCatalogue].map(catalogue =>
    catalogue && Date.parse(catalogue.fetchedAt || catalogue.updatedAt) <= asOf ? catalogue : null);
  const [knownBundle, knownPublished] = knownCatalogues;
  const date = targetDay(currentTime, knownPublished, knownBundle);
  const issuedAt = currentTime.toISOString();
  const file = join(directory, 'forecasts', date + '.json');
  if (await exists(file) || !knownBundle && !knownPublished) return null;

  const [bundledModel, publishedModel, bundledCalendar,
    publishedCalendar, weatherCache, mapping] = await Promise.all([
    readJson(join(bundled, 'wait-model.json')), readJson(join(directory, 'wait-model.json'), true),
    readJson(join(bundled, 'calendar.json')), readJson(join(directory, 'calendar.json'), true),
    readJson(join(directory, 'weather-forecast.json'), true), readJson(join(bundled, 'queue-times-map.json'))
  ]);
  const catalogue = knownBundle ? chooseCatalogue(validateCatalogue(knownBundle),
    knownPublished ? validateCatalogue(knownPublished) : null) : validateCatalogue(knownPublished);
  const calendarData = [publishedCalendar, bundledCalendar].find(calendar =>
    validateCalendarData(calendar) && Date.parse(calendar.updatedAt) <= currentTime.getTime());
  const parks = await Promise.all(catalogue.parks.map(park => forecastPark(park, {
    date, issuedAt, calendarData, weatherCache, rideIds:new Set(Object.values(mapping.parks[park.id].rides)),
    waitModel:chooseModel([publishedModel, bundledModel], park.id, date, currentTime.getTime())
  })));
  if (!parks.some(park => park.rows.length)) return null;

  // A retry or concurrent issuer may only publish once; readers never see a partial file.
  await mkdir(dirname(file), {recursive:true});
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const archive = {schemaVersion:1, date, slotMinutes, parks};
    await writeFile(temporary, JSON.stringify(archive) + '\n', {flag:'wx'});
    await link(temporary, file);
    return file;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  } finally {
    await rm(temporary, {force:true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, directory, ...extra] = process.argv.slice(2);
  if (flag !== '--data-dir' || !directory || extra.length) throw Error('指定方法: --data-dir データの保存先');
  const file = await issueForecast(directory);
  console.log(file ? '事前予測を保存しました ' + file : '新たに保存する事前予測はありません。');
}
