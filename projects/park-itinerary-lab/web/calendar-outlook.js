import {cachedForecastForDate, forecastDateInRange, usableWeatherForecast, weatherRowInterval} from './weather.js?v=1.16.0';
import {parkCrowdSource} from './wait-model.js?v=1.16.0';

function weatherCoverage(date, settings, now) {
  if (!forecastDateInRange(date, now)) return 'outside';
  const coversVisit = forecast => usableWeatherForecast(forecast, date, now) &&
    forecast.hours.some(row => weatherRowInterval(row, date, settings.entry, settings.exit));
  return coversVisit(settings.weatherForecast) || coversVisit(cachedForecastForDate(date, now)) ? 'confirmed' : 'eligible';
}

/** Show automatic methods available for a visit. Issued predictions are stored separately for scoring. */
export function calendarDayOutlook(park, settings, date, {now = Date.now(), pendingModel = false} = {}) {
  const crowd = pendingModel ? 'pending' : parkCrowdSource(park, {...settings, date});
  return {weather:weatherCoverage(date, settings, now), crowd};
}
