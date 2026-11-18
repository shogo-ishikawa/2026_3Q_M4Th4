import assert from 'node:assert/strict';
import test from 'node:test';
import {isFreshLaunch, mobilePlatform} from '../web/pwa.js';

test('home-screen instructions recognise iPhone and desktop-mode iPad', () => {
  assert.equal(mobilePlatform({userAgent:'iPhone'}), 'ios');
  assert.equal(mobilePlatform({userAgent:'Macintosh', platform:'MacIntel', maxTouchPoints:5}), 'ios');
  assert.equal(mobilePlatform({userAgent:'Macintosh', platform:'MacIntel', maxTouchPoints:0}), 'desktop');
});

test('Android tablet and phone use mobile installation, desktop uses phone handoff', () => {
  assert.equal(mobilePlatform({userAgent:'Android', userAgentData:{mobile:false}}), 'android');
  assert.equal(mobilePlatform({userAgent:'', userAgentData:{mobile:true}}), 'android');
  assert.equal(mobilePlatform({userAgent:'Windows', maxTouchPoints:5}), 'desktop');
});

test('show launch artwork on a fresh opening and skip returns to the planner', () => {
  const app = 'https://example.com/course/park-itinerary-lab/';
  assert.ok(isFreshLaunch('navigate', '', app));
  assert.ok(isFreshLaunch('navigate', 'https://example.com/course/', app));
  assert.ok(!isFreshLaunch('navigate', app+'guide.html', app));
  assert.ok(!isFreshLaunch('reload', '', app));
  assert.ok(!isFreshLaunch('back_forward', '', app));
});
