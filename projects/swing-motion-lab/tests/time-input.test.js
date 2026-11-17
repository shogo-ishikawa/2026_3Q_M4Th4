'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseTime, stepTime, bindTimeInput } = require('../web/time-input.js');

class FakeControl extends EventTarget {
  constructor(value = '') {
    super(); this.value = value; this.max = ''; this.disabled = false; this.readOnly = false;
  }
}

function controls(value = '0.4', maximum = 10) {
  const input = new FakeControl(value);
  const decreaseButton = new FakeControl(), increaseButton = new FakeControl();
  const bounds = { maximum };
  const binding = bindTimeInput(input, {
    decreaseButton, increaseButton, getMaximum: () => bounds.maximum
  });
  return { input, decreaseButton, increaseButton, bounds, binding };
}

function arrow(input, key) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value: key });
  input.dispatchEvent(event);
  return event;
}

test('manual values use tenths of a second and preserve a precise upper boundary', () => {
  assert.equal(normaliseTime('0.4'), 0.4);
  assert.equal(normaliseTime('1.26'), 1.3);
  assert.equal(normaliseTime('-1.2'), 0);
  assert.equal(normaliseTime('4.3', 4.23456789), 4.23456789);
  assert.equal(normaliseTime('0.1', 0.034), 0.034);
  for (const value of ['', ' ', null, undefined, 'not a number', Infinity])
    assert.equal(normaliseTime(value), null);
});

test('up/down moves by one second without losing the existing fraction', () => {
  assert.equal(stepTime('0.4', 1), 1.4);
  assert.equal(stepTime('1.4', -1), 0.4);
  assert.equal(stepTime('2.034', -1), 1.034);
  assert.equal(stepTime('0.4', -1), 0);
  assert.equal(stepTime('2.4', 1, 2.73125), 2.73125);
  assert.equal(stepTime('0.034', 1, 0.034), 0.034);
  assert.equal(stepTime('', 1), 1);
  assert.throws(() => stepTime('1', 0));
});

test('custom buttons produce one change and one input event per successful second step', () => {
  const { input, increaseButton, decreaseButton } = controls();
  const events = [];
  input.addEventListener('input', () => events.push(['input', input.value]));
  input.addEventListener('change', () => events.push(['change', input.value]));
  increaseButton.dispatchEvent(new Event('click'));
  assert.equal(input.value, '1.4');
  assert.deepEqual(events, [['input', '1.4'], ['change', '1.4']]);
  decreaseButton.dispatchEvent(new Event('click'));
  assert.equal(input.value, '0.4');
  assert.equal(events.length, 4);
  assert.equal(input.step, '0.1');
  assert.equal(input.min, '0');
});

test('arrow keys suppress native number stepping and use the same one-second behaviour', () => {
  const { input } = controls();
  assert.equal(arrow(input, 'ArrowUp').defaultPrevented, true);
  assert.equal(input.value, '1.4');
  assert.equal(arrow(input, 'ArrowDown').defaultPrevented, true);
  assert.equal(input.value, '0.4');
  assert.equal(arrow(input, 'ArrowLeft').defaultPrevented, false);
  assert.equal(input.value, '0.4');
});

test('committing manual input rounds to tenths and keeps an empty field available for validation', () => {
  const { input } = controls();
  input.value = '0.26'; input.dispatchEvent(new Event('change'));
  assert.equal(input.value, '0.3');
  input.value = ''; input.dispatchEvent(new Event('change'));
  assert.equal(input.value, '');
  input.value = '-0.2'; input.dispatchEvent(new Event('change'));
  assert.equal(input.value, '0');
});

test('an arrow key during typing first commits tenths, while source endpoint fractions remain precise', () => {
  const { input, binding } = controls();
  input.value = '0.26'; input.dispatchEvent(new Event('input'));
  arrow(input, 'ArrowUp');
  assert.equal(input.value, '1.3');
  binding.setValue(2.034);
  arrow(input, 'ArrowDown');
  assert.equal(input.value, '1.034');
});

test('video endpoints and live duration changes keep their source precision', () => {
  const { input, increaseButton, bounds, binding } = controls('0', 1.23456789);
  binding.setValue(1.23456789);
  assert.equal(input.value, '1.23456789');
  // ボタンからのchangeは、動画の末尾を手入力として丸めない。
  let changed = 0;
  input.addEventListener('change', () => ++changed);
  increaseButton.dispatchEvent(new Event('click'));
  assert.equal(input.value, '1.23456789');
  assert.equal(changed, 0);
  input.value = '0.4'; increaseButton.dispatchEvent(new Event('click'));
  assert.equal(input.value, '1.23456789');
  assert.equal(changed, 1);
  bounds.maximum = 0.034;
  binding.setValue(0.034);
  assert.equal(input.value, '0.034');
  input.value = '0.1'; input.dispatchEvent(new Event('change'));
  assert.equal(input.value, '0.034');
});

test('each time field can cross the other until analysis validates their order', () => {
  const start = controls('1.4', 5), end = controls('2.0', 5);
  start.increaseButton.dispatchEvent(new Event('click'));
  assert.equal(start.input.value, '2.4');
  assert.equal(end.input.value, '2.0');
});

test('busy state disables buttons and keyboard edits, and destroy removes all handlers', () => {
  const { input, increaseButton, decreaseButton, binding } = controls();
  binding.setDisabled(true);
  assert.equal(input.disabled, true);
  assert.equal(increaseButton.disabled, true);
  assert.equal(decreaseButton.disabled, true);
  increaseButton.dispatchEvent(new Event('click')); arrow(input, 'ArrowUp');
  assert.equal(input.value, '0.4');
  binding.setDisabled(false);
  increaseButton.dispatchEvent(new Event('click'));
  assert.equal(input.value, '1.4');
  binding.destroy();
  increaseButton.dispatchEvent(new Event('click'));
  assert.equal(arrow(input, 'ArrowUp').defaultPrevented, false);
  input.value = '0.26'; input.dispatchEvent(new Event('change'));
  assert.equal(input.value, '0.26');
});
