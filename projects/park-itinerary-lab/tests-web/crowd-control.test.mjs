import test from 'node:test';
import assert from 'node:assert/strict';
import {crowdExplanation, defaultSettings} from '../web/app.js';
import {buildPlanJson, createShareUrl, parsePlanJson, readSharedState} from '../web/storage.js';

const park = {id:'land', activities:[]};

test('new plans show the automatic source and distinguish it from a manual assumption', () => {
  const settings = {...defaultSettings(), date:'2026-11-21'};
  assert.equal(settings.crowdLevel, 'auto');
  assert.match(crowdExplanation(park, settings).summary, /混み合う（暦の目安）/);
  assert.equal(crowdExplanation(park, settings).source, '暦の目安');
  assert.match(crowdExplanation(park, {...settings, date:'2026-11-19'}).summary, /ふつう（暦の目安）/);
  assert.match(crowdExplanation(park, {...settings, crowdLevel:'normal'}).summary, /ふつう（手動）/);
});

test('JSON and sharing retain automatic and existing explicit crowd choices', () => {
  for (const crowdLevel of ['auto', 'quiet', 'normal', 'busy']) {
    const state = {parkId:park.id, settings:{...defaultSettings(), crowdLevel}};
    assert.equal(parsePlanJson(buildPlanJson(state)).settings.crowdLevel, crowdLevel);
    const url = new URL(createShareUrl(state, 'https://example.org/plan/'));
    assert.equal(readSharedState(url.hash).settings.crowdLevel, crowdLevel);
  }
});
