import {cachedForecastForDate, forecastDateInRange, usableWeatherForecast, weatherProfileForVisit} from './weather.js?v=2.2.0';
import {parkTimeBounds, clampClock} from './time-input.js?v=2.2.0';
import {ticketFactsFor} from './ticket-calendar.js?v=2.2.0';
import {visitWeatherSummary} from './weather-view.js?v=2.2.0';
import {estimateParkCrowd, parkCrowdSource} from './wait-model.js?v=2.2.0';

export const CROWD_LABELS = {quiet:'比較的すいている', normal:'ふつう', busy:'混み合う'};

function settingsForDate(park, settings, date) {
  const bounds = parkTimeBounds(park,date);
  return {...settings,date,entry:clampClock(settings.entry,bounds),exit:clampClock(settings.exit,bounds)};
}

function availableProfile(settings, now) {
  const date = settings.date;
  const forVisit = forecast => {
    if (!usableWeatherForecast(forecast,date,now)) return null;
    try {
      return weatherProfileForVisit(forecast,settings);
    } catch {
      // A valid bulletin can have no weather during these visit hours.
      return null;
    }
  };
  return forVisit(settings.weatherForecast) || forVisit(cachedForecastForDate(date, now));
}

/** Show automatic methods available for a visit. Issued predictions are stored separately for scoring. */
export function calendarDayOutlook(park, settings, date, {now = Date.now(), pendingModel = false} = {}) {
  const candidate = settingsForDate(park,settings,date);
  const crowd = pendingModel ? 'pending' : parkCrowdSource(park,candidate);
  let weather = 'outside';
  if (forecastDateInRange(date, now)) weather = availableProfile(candidate,now) ? 'confirmed' : 'eligible';
  return {weather,crowd};
}

/** Read-only preview for the highlighted date. New requests start after the user confirms. */
export function calendarDayPreview(park, settings, date, {now = Date.now(), pendingModel = false} = {}) {
  const automatic = settings.weatherMode !== 'manual';
  const candidate = settingsForDate(park,settings,date);
  const profile = automatic && forecastDateInRange(date, now) ? availableProfile(candidate,now) : null;
  // When changing days the planner discards the previous day's automatic weather.
  const newDayWeather = automatic && date !== settings.date && settings.weatherForecast ? 'sun' : settings.weather;
  candidate.weather = profile?.weather || newDayWeather;
  candidate.weatherForecast = profile;
  candidate.visitForecastAsOf = date === settings.date ? settings.visitForecastAsOf ?? now : now;
  const fare = ticketFactsFor(park,date,now).adultOneDayYen;
  return {ticket:fare ? fare.toLocaleString('ja-JP') + '円' : null,
    weather:visitWeatherSummary(candidate,{now}), crowd:previewCrowd(park,candidate,pendingModel)};
}

function previewCrowd(park, candidate, pendingModel) {
  if (Object.hasOwn(CROWD_LABELS,candidate.crowdLevel)) return {label:CROWD_LABELS[candidate.crowdLevel], detail:'手動設定'};
  if (pendingModel) return {label:'確認中…',detail:''};
  const estimate = estimateParkCrowd(park,candidate);
  return {label:CROWD_LABELS[estimate.level],
    detail:estimate.source === 'model' ? '過去の待ち時間から予想' : '曜日・祝日からの目安'};
}
