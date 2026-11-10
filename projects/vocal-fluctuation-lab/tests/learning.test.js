'use strict';
const assert = require('node:assert/strict');
const {makeToneWave, componentPowers, makeCombinedWave, envelopeModel} = require('../web/app.js');
const close = (actual, expected, tolerance = 1e-10) => assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
let checks = 0;

// Same duration: twice the frequency produces twice as many positive crossings.
const first = makeToneWave(0.4, 1000, 10, 1001);
const second = makeToneWave(0.4, 2000, 10, 1001);
const cycles = points => points.filter((point, index) => index > 0 && point[1] > 1e-9 && points[index - 1][1] <= 1e-9).length;
assert.equal(cycles(first), 10);
assert.equal(cycles(second), 20);
close(first[0][0], 0);
close(first[first.length - 1][0], 10);
checks++;

const stronger = makeToneWave(0.8, 1000, 10, 1001);
first.forEach((point, index) => close(stronger[index][1], point[1] * 2));
close(Math.max(...stronger.map(point => point[1])), 0.8);
assert(makeToneWave(0, 440).every(point => point[1] === 0));
checks++;

// Theoretical component bars show mean-square power, not amplitude or PSD.
const quietHarmonic = componentPowers(0.25);
const louderHarmonic = componentPowers(0.5);
close(quietHarmonic[0], 0.6 ** 2 / 2);
close(louderHarmonic[0], quietHarmonic[0]);
close(louderHarmonic[1], quietHarmonic[1] * 4);
close(componentPowers(0)[1], 0);
close(componentPowers(1)[1], componentPowers(1)[0]);
checks++;

// Independently integrate a whole number of periods to check A²/2.
const periods = makeToneWave(0.6, 220, 50, 10001).slice(0, -1);
const meanSquare = periods.reduce((sum, point) => sum + point[1] ** 2, 0) / periods.length;
close(meanSquare, componentPowers(0)[0]);
checks++;

const combination = makeCombinedWave(0.5);
const fundamental = makeToneWave(0.6, 220);
const harmonic = makeToneWave(0.3, 440);
combination.forEach((point, index) => close(point[1], fundamental[index][1] + harmonic[index][1]));
checks++;

// This explanatory envelope is periodic at 0.5 Hz; it is not a 1/f example.
for (const time of [0, 0.25, 0.5, 0.75, 1.25]) close(envelopeModel(time), envelopeModel(time + 2));
close(envelopeModel(0.5), 0.85);
close(envelopeModel(1.5), 0.25);
checks++;

console.log(`${checks} educational signal checks passed.`);
