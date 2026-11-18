import {visitDayContext} from './calendar-features.js?v=2.2.1';
import {predictModelWait} from './wait-model.js?v=2.2.1';
import {validateLiveSnapshot} from './wait-data.js';

const MIN_FACILITIES = 3;
const LIVE_MINUTES = 60;
const END_MINUTES = 180;
const freshAge = (timestamp, now) => {
  const age = now - Date.parse(timestamp);
  return age >= 0 && age <= 15 * 60000;
};
const localTime = timestamp => new Date(timestamp + 9 * 3600000).toISOString();
const clockMinute = iso => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
const postedWait = value => Number.isFinite(value) && value >= 0 && value <= 600;

/** One vote per open attraction. Positive differences mean longer queues than predicted. */
export function summariseIntradayResiduals(samples, asOfMinute) {
  const differences = new Map();
  for (const sample of samples) {
    if (!sample.activityId || differences.has(sample.activityId) || !postedWait(sample.observed) ||
        !postedWait(sample.expected) || sample.expected < 5) continue;
    differences.set(sample.activityId, sample.observed - sample.expected);
  }
  const values = [...differences.values()].sort((a,b) => a-b);
  const rides = values.length;
  if (rides < MIN_FACILITIES) return null;
  const middle = Math.floor(rides / 2);
  const medianDifference = rides % 2 ? values[middle] : (values[middle-1] + values[middle]) / 2;
  const agreeing = values.filter(value => Math.sign(medianDifference) * value >= 5).length;
  if (agreeing < MIN_FACILITIES || agreeing * 3 < rides * 2) return null;
  const offset = Math.max(-15, Math.min(15, medianDifference / 2));
  return {asOfMinute, rides, agreeing, medianDifference, offset};
}

/** Restrict a temporary park-wide signal to the next few hours and to each ride's wait scale. */
export function adjustedIntradayMinutes(expectedMinutes, targetMinute, signal) {
  if (!signal) return expectedMinutes;
  const ahead = targetMinute - signal.asOfMinute;
  if (ahead <= LIVE_MINUTES || ahead >= END_MINUTES) return expectedMinutes;
  const fraction = (END_MINUTES - ahead) / (END_MINUTES - LIVE_MINUTES);
  const limit = expectedMinutes * 0.3;
  const delta = Math.max(-limit, Math.min(limit, signal.offset * fraction));
  return Math.max(0, Math.min(600, Math.round(expectedMinutes + delta)));
}

/** Compare posted waits with model estimates for the same rides at their observation times. */
export function deriveIntradayAdjustment(park, settings, visitContext) {
  if (settings.replanFrom == null || settings.replanFrom === '' || settings.crowdMode === 'manual' || settings.liveMode === 'off') return null;
  const snapshot = settings.liveData;
  const model = settings.waitModel;
  if (!validateLiveSnapshot(snapshot, park.id) || model?.parkId !== park.id || model.usable !== true) return null;
  const now = settings.waitAsOf ?? Date.now();
  if (!Number.isFinite(now) || !freshAge(snapshot.fetchedAt, now)) return null;
  const nowLocal = localTime(now);
  if (nowLocal.slice(0,10) !== settings.date) return null;
  const facilities = new Map(park.activities.map(activity => [activity.id, activity]));
  const samples = [];
  if (visitContext === undefined && model.visitFactors?.length)
    visitContext = visitDayContext(settings.date,park,settings.calendarData || model.calendarData,now);
  for (const ride of snapshot.rides) {
    const activity = facilities.get(ride.activityId);
    if (activity?.category !== 'attraction' || !ride.isOpen || !postedWait(ride.wait) || !freshAge(ride.updatedAt, now)) continue;
    const observationTime = localTime(Date.parse(ride.updatedAt));
    if (observationTime.slice(0,10) !== settings.date) continue;
    const windows = activity.dailySchedules?.[settings.date]?.windows;
    const prediction = predictModelWait(windows ? {...activity, windows} : activity, clockMinute(observationTime), settings, model, visitContext);
    if (prediction) samples.push({activityId:ride.activityId, observed:ride.wait, expected:prediction.minutes});
  }
  return summariseIntradayResiduals(samples, clockMinute(nowLocal));
}

export function applyIntradayAdjustment(prediction, minute, signal, activity) {
  if (activity.category !== 'attraction' || !signal) return prediction;
  const minutes = adjustedIntradayMinutes(prediction.minutes, minute, signal);
  return minutes === prediction.minutes ? prediction : {...prediction, minutes, source:'intraday'};
}

export function describeIntradayAdjustment(signal) {
  const direction = signal.medianDifference > 0 ? '長め' : '短め';
  return `当日の補正：${signal.rides}施設の掲示と同時刻のモデル予測を比較すると、中央値で${Math.abs(signal.medianDifference)}分${direction}でした。1〜3時間先のアトラクションの予測にこの差の一部を使い、先の時刻ほど補正を小さくします。`;
}
