// Provider records enter via a private pipe. Output only park-level error metrics.
import {readFileSync} from 'node:fs';
import {scoreForecastAccuracy} from '../web/forecast-accuracy.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const scored = scoreForecastAccuracy({...input, source:'themeparks-wiki'});
const {expected, matched, mae, bias, within10, coverage} = scored.overall;
const facilities = scored.facilities.filter(facility => facility.matched > 0);
let aggregate = null;
if (scored.status === 'complete' && matched >= 5 && facilities.length >= 3) {
  const {forecastLevel, observedLevel, facilities, slots, ratio} = scored.crowd;
  aggregate = {parkId:scored.parkId, issuedAt:scored.issuedAt, expected, matched, mae, bias, within10, coverage,
    crowd:{forecastLevel, observedLevel, facilities, slots, ratio}};
}
process.stdout.write(JSON.stringify(aggregate));
