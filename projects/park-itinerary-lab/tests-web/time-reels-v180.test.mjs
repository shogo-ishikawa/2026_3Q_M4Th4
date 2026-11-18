import assert from 'node:assert/strict';
import test from 'node:test';
import {bindClockParts, bindTimeReels, clockMinute} from '../web/time-input.js';
import {validateSavedState} from '../web/storage.js';

class Option {
  dataset = {};
  attributes = {};
  offsetHeight = 40;
  setAttribute(name, value) { this.attributes[name] = value; }
}
class List extends EventTarget {
  ownerDocument = {createElement: () => new Option()};
  attributes = {};
  scrollTop = 0;
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren(...children) { this.children = children; }
  get firstElementChild() { return this.children[0]; }
  querySelector() { return this.children.find(option => option.attributes['aria-selected'] === 'true'); }
  scrollToIndex(index) {
    this.scrollTop = index * this.firstElementChild.offsetHeight;
    this.dispatchEvent(new Event('scroll'));
  }
  key(key) {
    const event = Object.assign(new Event('keydown', {cancelable: true}), {key});
    this.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  selected() { return Number(this.querySelector().dataset.value); }
}
const bounds = {min: 9 * 60 + 30, max: 20 * 60 + 15};
function reels(initial) {
  const hours = new List(), minutes = new List(), applied = [];
  const confirm = bindTimeReels(hours, minutes, initial, bounds, value => applied.push(value));
  return {hours, minutes, applied, confirm};
}
test('the actual hour and minute reels select with scrolling and commit only on confirmation', () => {
  const {hours, minutes, applied, confirm} = reels('12:35');
  assert.equal(hours.selected(), 12);
  assert.equal(minutes.selected(), 35);
  hours.scrollToIndex(5);
  minutes.scrollToIndex(12);
  assert.deepEqual(applied, []);
  confirm();
  assert.deepEqual(applied, [clockMinute('14:12')]);
});
test('reel limits follow official partial hours, stop at endpoints and keep ARIA selection in sync', () => {
  const {hours, minutes, applied} = reels('18:45');
  hours.key('End');
  assert.equal(minutes.selected(), 15);
  assert.equal(minutes.children.length, 16);
  minutes.key('ArrowDown');
  assert.equal(minutes.attributes['aria-activedescendant'], 'time-reel-minute-15');
  hours.key('Home');
  minutes.key('ArrowUp');
  assert.equal(minutes.selected(), 30);
  minutes.key('Enter');
  assert.deepEqual(applied, [clockMinute('09:30')]);
});
test('opening a blank reel leaves an optional slot unset until confirmed', () => {
  const {hours, minutes, applied} = reels('');
  assert.equal(hours.selected(), 9);
  assert.equal(minutes.selected(), 30);
  assert.deepEqual(applied, []);
});
test('saved day-link preference is optional for older plans and must be boolean when present', () => {
  const state = {parkId:'land', settings:{date:'2026-11-18',entry:570,exit:1215,speed:70,budget:10000,selections:[]}};
  for (const value of [undefined, false, true]) {
    state.settings.visitTimeLinked = value;
    if (value === undefined) delete state.settings.visitTimeLinked;
    assert.doesNotThrow(() => validateSavedState(state));
  }
  state.settings.visitTimeLinked = 'false';
  assert.throws(() => validateSavedState(state), /連動/);
});

test('two-digit direct entry accepts a partial first digit and leaves an independent endpoint in place', () => {
  const field = value => Object.assign(new EventTarget(), {value, required:false, disabled:false});
  const start = field('11:30'), end = field('14:00'), hours = field(''), minutes = field('');
  bindClockParts(start, hours, minutes, {getBounds: () => bounds});
  bindClockParts(end, field(''), field(''), {getBounds: () => bounds});
  hours.value = '1';
  hours.dispatchEvent(new Event('input'));
  assert.equal(start.value, '11:30');
  hours.value = '15';
  hours.dispatchEvent(new Event('input'));
  assert.equal(start.value, '15:30');
  assert.equal(end.value, '14:00');
});
