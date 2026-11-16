'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseVideoURL, loadVideoSource } = require('../web/video-input.js');

class FakeVideo extends EventTarget {
  constructor() {
    super(); this.events = new Map(); this.operations = []; this._src = '';
    this.readyState = 0; this.duration = NaN; this.videoWidth = 0; this.videoHeight = 0;
    this.seeking = false; this.onLoad = null;
  }
  addEventListener(name, callback, options) {
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(callback); super.addEventListener(name, callback, options);
  }
  removeEventListener(name, callback, options) {
    this.events.get(name)?.delete(callback); super.removeEventListener(name, callback, options);
  }
  get listenerCount() { return [...this.events.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
  get src() { return this._src; }
  set src(value) { this.operations.push(['src', value]); this._src = value; this.readyState = 0; }
  set crossOrigin(value) { this.operations.push(['crossOrigin', value]); this._crossOrigin = value; }
  get crossOrigin() { return this._crossOrigin; }
  removeAttribute(name) { this.operations.push(['remove', name]); if (name === 'src') this._src = ''; if (name === 'crossorigin') this._crossOrigin = null; }
  load() { this.operations.push(['load']); this.readyState = 0; this.onLoad?.(); }
  metadata({ duration = 2.5, width = 640, height = 360 } = {}) {
    this.duration = duration; this.videoWidth = width; this.videoHeight = height; this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
  decoded() { this.readyState = 2; this.dispatchEvent(new Event('loadeddata')); }
}
const remote = 'https://media.example.test/swing.mp4';

test('HTTP(S) URL normalisation preserves signed query and accepts a file endpoint without an extension', () => {
  assert.equal(normaliseVideoURL('  https://media.example.test/clip?token=a%2Fb&part=1#preview '), 'https://media.example.test/clip?token=a%2Fb&part=1');
  assert.equal(normaliseVideoURL('http://127.0.0.1:4173/clip.webm', { pageURL: 'http://127.0.0.1:4173/' }), 'http://127.0.0.1:4173/clip.webm');
});

test('invalid schemes, embedded credentials and mixed content are rejected with no source URL in the message', () => {
  for (const text of ['', 'clip.mp4', 'javascript:alert(1)', 'data:video/mp4,bytes', 'file:///clip.mp4', 'blob:https://example.test/a', 'https://secret:password@media.example.test/clip.mp4']) {
    assert.throws(() => normaliseVideoURL(text), error => !error.message.includes('secret') && !error.message.includes('password'));
  }
  assert.throws(() => normaliseVideoURL('http://media.example.test/clip.mp4?token=private', { pageURL: 'https://app.example.test/' }), /https:\/\//);
  assert.throws(() => normaliseVideoURL(null));
  assert.throws(() => normaliseVideoURL('https://example.test/' + 'a'.repeat(17000)));
});

test('YouTube viewing pages explain that a video file is needed while other signed video hosts remain usable', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'])
    assert.throws(() => normaliseVideoURL(`https://${host}/watch?v=x`), /動画ファイル/);
  assert.equal(normaliseVideoURL('https://video.example.test/play?id=2'), 'https://video.example.test/play?id=2');
});

test('CORS is set before src, listeners exist before load, and metadata alone does not resolve', async () => {
  const video = new FakeVideo();
  let resolved = false;
  video.onLoad = () => { assert.ok(video.listenerCount > 0); video.metadata(); };
  const result = loadVideoSource(video, { url: remote }).then(value => { resolved = true; return value; });
  await Promise.resolve(); assert.equal(resolved, false);
  assert.deepEqual(video.operations.slice(0, 2), [['crossOrigin', 'anonymous'], ['src', remote]]);
  video.decoded();
  assert.deepEqual(await result, { duration: 2.5, width: 640, height: 360 });
  assert.equal(video.listenerCount, 0);
});

test('a synchronously cached first frame is accepted and leaves no listeners', async () => {
  const video = new FakeVideo();
  video.onLoad = () => { video.metadata(); video.decoded(); };
  assert.equal((await loadVideoSource(video, { url: remote })).width, 640);
  assert.equal(video.listenerCount, 0);
});

test('local blob source clears an old crossOrigin setting before assigning the blob URL', async () => {
  const video = new FakeVideo(); video.crossOrigin = 'use-credentials'; video.operations = [];
  const result = loadVideoSource(video, { url: 'blob:https://app.example.test/local', objectURL: true });
  assert.deepEqual(video.operations.slice(0, 2), [['remove', 'crossorigin'], ['src', 'blob:https://app.example.test/local']]);
  video.metadata(); video.decoded(); await result;
  assert.equal(video.crossOrigin, null); assert.equal(video.listenerCount, 0);
  await assert.rejects(loadVideoSource(video, { url: remote, objectURL: true }), /ローカル/);
});

test('network error removes all load listeners and does not echo a signed URL', async () => {
  const video = new FakeVideo();
  const result = loadVideoSource(video, { url: remote + '?token=private' });
  video.dispatchEvent(new Event('error'));
  await assert.rejects(result, error => /外部読み込み/.test(error.message) && !error.message.includes('private'));
  assert.equal(video.listenerCount, 0);
});

test('timeout settles once and removes listeners before late data arrives', async () => {
  const video = new FakeVideo();
  await assert.rejects(loadVideoSource(video, { url: remote, timeoutMs: 3 }), /時間がかかって/);
  assert.equal(video.listenerCount, 0); video.metadata(); video.decoded();
});

test('abort rejects with AbortError and cancels only the source still owned by that load', async () => {
  const video = new FakeVideo(), controller = new AbortController();
  const result = loadVideoSource(video, { url: remote, signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(video.src, ''); assert.equal(video.listenerCount, 0);
});

test('aborting an old loader never clears a source assigned by its caller after it', async () => {
  const video = new FakeVideo(), controller = new AbortController();
  const result = loadVideoSource(video, { url: remote, signal: controller.signal });
  video.src = 'blob:https://app.example.test/new'; controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(video.src, 'blob:https://app.example.test/new'); assert.equal(video.listenerCount, 0);
});

test('a second load rejects the first and resolves with the new source metadata', async () => {
  const video = new FakeVideo();
  const first = loadVideoSource(video, { url: remote });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const secondURL = 'https://media.example.test/new.webm';
  const second = loadVideoSource(video, { url: secondURL });
  assert.equal(video.src, secondURL);
  video.metadata({ duration: 6, width: 960, height: 540 }); video.decoded();
  assert.deepEqual(await second, { duration: 6, width: 960, height: 540 });
  await firstRejected; assert.equal(video.listenerCount, 0);
});

test('a completed source can be loaded again and a previously aborted signal does not disturb it', async () => {
  const video = new FakeVideo(); video.onLoad = () => { video.metadata(); video.decoded(); };
  await loadVideoSource(video, { url: remote });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadVideoSource(video, { url: 'https://other.example.test/new.mp4', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(video.src, remote);
  assert.equal((await loadVideoSource(video, { url: remote })).duration, 2.5);
  assert.equal(video.listenerCount, 0);
});

test('invalid metadata and wait parameters are rejected instead of creating plausible dimensions', async () => {
  for (const metadata of [{ duration: Infinity }, { duration: 0 }, { width: 0 }, { height: NaN }]) {
    const video = new FakeVideo(); const result = loadVideoSource(video, { url: remote }); video.metadata(metadata);
    await assert.rejects(result, /長さや解像度/); assert.equal(video.listenerCount, 0);
  }
  await assert.rejects(loadVideoSource(new FakeVideo(), { url: remote, timeoutMs: 0 }), RangeError);
  await assert.rejects(loadVideoSource(null, { url: remote }), TypeError);
});

test('classic scripts expose only the two public helpers without a module loader', () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/video-input.js'), 'utf8'), context);
  assert.equal(vm.runInContext('MotionVideoInput.normaliseVideoURL("https://example.test/clip.mp4")', context), 'https://example.test/clip.mp4');
  assert.deepEqual(Object.keys(context.MotionVideoInput).sort(), ['loadVideoSource', 'normaliseVideoURL']);
});
