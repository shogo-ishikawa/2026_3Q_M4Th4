import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
const scope = 'https://example.test/course/park-itinerary-lab/';

function worker({code = source, fetchImpl = request => Promise.reject(Error(request.url)), addAll = async () => {}} = {}) {
  const listeners = {};
  const storage = new Map();
  let claimed = false;
  let downloaded;
  const cache = {
    addAll: async requests => {
      downloaded = Array.from(requests);
      await addAll(downloaded);
    },
    match: async url => new Response(new URL(url).pathname, {headers: {'X-Saved': 'yes'}})
  };
  const caches = {
    open: async name => {
      if (!storage.has(name)) storage.set(name, cache);
      return storage.get(name);
    },
    keys: async () => [...storage.keys()],
    delete: async name => storage.delete(name)
  };
  const self = {
    registration: {scope}, clients: {claim: async () => { claimed = true; }},
    addEventListener: (name, listener) => { listeners[name] = listener; }
  };
  runInNewContext(code, {self, caches, fetch: fetchImpl, URL, Request});
  function dispatch(name, args = {}) {
    let promise;
    const capture = value => { promise = value; };
    listeners[name]({waitUntil: capture, respondWith: capture, ...args});
    return promise;
  }
  return {
    dispatch, storage, files: () => downloaded, claimed: () => claimed,
    request: (path, options) => dispatch('fetch', {request: new Request(new URL(path, scope), options)})
  };
}

test('インストールは現地の計画に必要な画面・ワーカー・両園の地図を同じ範囲からそろえる', async () => {
  const sw = worker();
  await sw.dispatch('install');
  assert.ok(sw.files().every(request => request.url.startsWith(scope) &&
    request.credentials === 'omit' && request.cache === 'reload' && request.redirect === 'error'));
  const paths = new Set(sw.files().map(request => request.url.slice(scope.length)));
  for (const needed of ['index.html', 'planner-worker.js', 'data/parks.json', 'assets/land-geographic-map.svg',
    'assets/sea-geographic-map.svg', 'itinerary-image.js', 'assets/land-hero.webp', 'sync-ui.js', 'firebase-config.json',
    'assets/firebase/firebase-app.js', 'assets/firebase/firebase-auth.js', 'assets/firebase/firebase-firestore.js']) assert.ok(paths.has(needed));
  assert.equal(paths.size, sw.files().length);
  // 画面やワーカーから新たにモジュールを読むときも、オフラインの依存漏れを検出する。
  for (const path of paths) {
    if (!/\.(html|js)$/.test(path)) continue;
    const text = readFileSync(new URL('../web/' + path, import.meta.url), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*|new URL\(\s*|src\s*=\s*)['"](?:\.\/)?([\w-]+\.js)(?:\?v=[^'"]+)?['"]/g)) {
      const dependency = new URL(match[1], new URL(path, scope)).href.slice(scope.length);
      assert.ok(paths.has(dependency), path + ' からの ' + dependency);
    }
  }
});

test('公開版はファイルごとの配布バイト列を要求し、古い応答を検出できる', async () => {
  const hash = 'sha256-' + createHash('sha256').update('release HTML').digest('base64');
  const integrity = {'index.html': hash};
  const sw = worker({code: source.replace('const INTEGRITY = {};', 'const INTEGRITY = ' + JSON.stringify(integrity) + ';')});
  await sw.dispatch('install');
  const request = sw.files().find(item => item.url === scope + 'index.html');
  assert.equal(request.integrity, hash);
});

test('取得失敗はインストール失敗になり、使っている版を消さない', async () => {
  const sw = worker({addAll: async () => { throw Error('配布途中'); }});
  sw.storage.set('既存のキャッシュ', {});
  await assert.rejects(sw.dispatch('install'), /配布途中/);
  assert.ok(sw.storage.has('既存のキャッシュ'));
  assert.equal(sw.claimed(), false);
});

test('更新時は同じTDRouteだけの旧キャッシュを削除してページを担当する', async () => {
  const sw = worker();
  await sw.dispatch('install');
  const [current] = sw.storage.keys();
  const old = current.replace(/:[^:]+$/, ':previous-build');
  const neighbour = current.replace('park-itinerary-lab', 'another-app');
  sw.storage.set(old, {});
  sw.storage.set(neighbour, {});
  sw.storage.set('unrelated', {});
  await sw.dispatch('activate');
  assert.deepEqual([...sw.storage.keys()], [current, neighbour, 'unrelated']);
  assert.ok(sw.claimed());
});

test('起動URL・版付きモジュール・施設の手動更新失敗はいずれもオフラインで読める', async () => {
  const sw = worker();
  await sw.dispatch('install');
  assert.equal(await (await sw.request('./')).text(), '/course/park-itinerary-lab/index.html');
  assert.equal(await (await sw.request('accuracy.html?date=2026-11-01&park=sea')).text(), '/course/park-itinerary-lab/accuracy.html');
  assert.equal(await (await sw.request('guide.html#route')).text(), '/course/park-itinerary-lab/guide.html');
  const version = source.match(/const VERSION = '([^']+)'/)[1];
  assert.equal(await (await sw.request('planner-worker.js?v=' + version)).text(), '/course/park-itinerary-lab/planner-worker.js');
  assert.equal(await (await sw.request('data/parks.json?refresh=123')).text(), '/course/park-itinerary-lab/data/parks.json');
  const online = worker({fetchImpl: async () => new Response('new public catalogue')});
  assert.equal(await (await online.request('data/parks.json?refresh=123')).text(), 'new public catalogue');
});

test('公開シェル以外の取得・別の版・個人情報付きの要求には介入しない', () => {
  const sw = worker();
  for (const path of ['../another-app/', '../park-itinerary-lab-copy/app.js', 'https://example.org/weather.json',
    'https://raw.githubusercontent.com/shogo-ishikawa/2026_3Q_M4Th4/park-wait-data/live-waits.json',
    'downloads/TDRoute.zip', 'data/park-history.json', 'index.html?plan=private', 'app.js?v=previous',
    'app.js?v=2.5.0&user=private', 'data/parks.json?refresh=123&user=private']) {
    assert.equal(sw.request(path), undefined, path);
  }
  assert.equal(sw.request('app.js', {method: 'POST', body: 'private'}), undefined);
  for (const headers of [{Range: 'bytes=4-6'}, {Authorization: 'Bearer test'}]) {
    assert.equal(sw.request('index.html', {headers}), undefined);
  }
});
