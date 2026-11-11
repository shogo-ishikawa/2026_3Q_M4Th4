"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const learning = require("../web/learning.js");

function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }

test("north wind travels south and east wind travels west", () => {
  const north = learning.windVector(5, 0);
  close(north.u, 0); close(north.v, -5);
  const east = learning.windVector(5, 90);
  close(east.u, -5); close(east.v, 0);
  const south = learning.windVector(5, 180);
  close(south.u, 0); close(south.v, 5);
});

test("wind direction wraps around north", () => {
  close(learning.angularDifference(359, 1), 2);
  close(learning.angularDifference(0, 360), 0);
  close(learning.angularDifference(90, 270), 180);
  close(learning.angularDifference(-1, 361), 2);
});

test("hand-calculated residuals use predicted minus observed", () => {
  const result = learning.calculateMetrics([2, 4, 3], [3, 2, 6]);
  close(result.mae, 2);
  close(result.rmse, Math.sqrt(14 / 3));
  close(result.bias, 2 / 3);
});

test("zero bias does not imply correct predictions", () => {
  const data = learning.toyData();
  const metrics = learning.calculateMetrics(data.observed, data.predicted);
  close(metrics.bias, 0); close(metrics.mae, .5); close(metrics.rmse, .5);
});

test("single large miss raises RMSE more than MAE", () => {
  const data = learning.toyData(0, true);
  const metrics = learning.calculateMetrics(data.observed, data.predicted);
  close(metrics.mae, 1.25);
  close(metrics.bias, .75);
  close(metrics.rmse, Math.sqrt(44 / 8));
  assert.ok(metrics.rmse > metrics.mae);
});

test("missing input is not presented as a zero error", () => {
  assert.throws(() => learning.calculateMetrics([], []));
  assert.throws(() => learning.calculateMetrics([1, 2], [1]));
  assert.throws(() => learning.calculateMetrics([1, NaN], [1, 2]));
  assert.throws(() => learning.calculateMetrics([1], [Infinity]));
});
