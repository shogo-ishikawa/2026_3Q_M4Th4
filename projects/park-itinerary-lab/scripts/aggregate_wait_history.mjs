// Reuse the browser scorer for each data source. External change records stay private.
import {readFileSync} from 'node:fs';
import {scoreForecastAccuracy} from '../web/forecast-accuracy.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.source === 'queue-times') {
  const parks = ['land', 'sea'].map(parkId => scoreForecastAccuracy({...input, parkId}));
  if (input.intradayIssues?.length) {
    const {scoreIntraday} = await import('./issue_intraday_forecast.mjs');
    for (const park of parks) {
      const comparison = scoreIntraday(input, park.parkId);
      if (comparison) park.intradayComparison = comparison;
    }
  }
  process.stdout.write(JSON.stringify(parks));
} else {
  process.stdout.write(JSON.stringify(historicalSummary(input)));
}

function historicalSummary(input) {
  const scored = scoreForecastAccuracy({...input, source:'themeparks-wiki'});
  const {expected, matched, mae, bias, within10, coverage} = scored.overall;
  const facilities = scored.facilities.filter(facility => facility.matched > 0);
  if (scored.status !== 'complete' || matched < 5 || facilities.length < 3) return null;
  const {forecastLevel, observedLevel, slots, ratio} = scored.crowd;
  return {parkId:scored.parkId, issuedAt:scored.issuedAt, expected, matched, mae, bias, within10, coverage,
    crowd:{forecastLevel, observedLevel, facilities:scored.crowd.facilities, slots, ratio}};
}
