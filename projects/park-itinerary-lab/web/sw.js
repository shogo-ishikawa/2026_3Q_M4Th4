/* TDRoute の公開画面だけを版ごとに保存する。個人のしおりや認証の応答はここには保存しない。 */
const VERSION = '2.6.1';
const BUILD_ID = 'source';
const INTEGRITY = {};
const scope = self.registration.scope;
const cachePrefix = 'tdroute-offline:' + encodeURIComponent(scope) + ':';
const cacheName = cachePrefix + VERSION + ':' + BUILD_ID;

const OFFLINE_FILES = [
  'index.html', 'guide.html', 'accuracy.html', 'style.css', 'accuracy.css', 'manifest.webmanifest',
  'sync-ui.js', 'named-sync.js', 'firebase-sync.js', 'firebase-config.json', 'drive-memories.js',
  'companion-plans.js', 'companion-view.js', 'joint-planning.js',
  'assets/firebase/firebase-app.js', 'assets/firebase/firebase-auth.js', 'assets/firebase/firebase-firestore.js',
  'pwa.js', 'app.js', 'planner.js', 'planner-worker.js', 'contingency.js',
  'accuracy-page.js', 'forecast-accuracy.js', 'forecast-calendar.js', 'calendar-outlook.js',
  'onsite-navigation.js', 'visit-day-view.js', 'wishlist-presets.js', 'itinerary-image.js',
  'ticket-calendar.js', 'ticket-calendar-seed.js', 'day-progress-ui.js', 'day-progress-plan.js',
  'repeat-visits.js', 'intraday-waits.js', 'map-view.js', 'map-display.js', 'map-gestures.js', 'storage.js',
  'weather.js', 'weather-view.js', 'time-input.js', 'operation-windows.js',
  'wait-data.js', 'wait-model.js', 'calendar-features.js',
  'data/parks.json', 'data/calendar.json', 'data/live-waits.json', 'data/wait-model.json',
  'assets/tdroute-logo.webp', 'assets/tdroute-app-qr.png', 'assets/land-hero.webp', 'assets/sea-hero.webp',
  'assets/land-geographic-map.webp', 'assets/sea-geographic-map.webp',
  'assets/land-geographic-map.svg', 'assets/sea-geographic-map.svg', 'assets/land-map.webp', 'assets/sea-map.webp',
  'assets/pwa/apple-touch-icon.png', 'assets/pwa/icon-192.png',
  'assets/pwa/icon-512.png', 'assets/pwa/icon-maskable-512.png'
];
const offlinePaths = new Set(OFFLINE_FILES);

self.addEventListener('install', event => {
  const requests = OFFLINE_FILES.map(path => new Request(new URL(path, scope), {
    cache: 'reload', credentials: 'omit', redirect: 'error', integrity: INTEGRITY[path] || ''
  }));
  // addAll は全件に成功したときだけ一括で反映する。使用中のページには旧版を残す。
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(requests)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function fromRelease(path, request, refresh) {
  // 施設情報の手動更新はオンラインなら配布元を再確認する。失敗時も保存済み版を開ける。
  if (refresh) {
    try {
      const response = await fetch(request);
      if (response.ok) return response;
    } catch {
      // 次に保存済みの施設情報を使う。
    }
  }
  const cache = await caches.open(cacheName);
  return await cache.match(new URL(path, scope)) || fetch(request);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(scope) ||
      request.headers.has('range') || request.headers.has('authorization')) return;
  const url = new URL(request.url);
  const path = url.pathname.slice(new URL(scope).pathname.length) || 'index.html';
  if (!offlinePaths.has(path)) return;
  const refresh = path === 'data/parks.json' && /^\?refresh=\d+$/.test(url.search);
  const report = path === 'accuracy.html' && [...url.searchParams.keys()].every(key => key === 'date' || key === 'park');
  if (url.search && url.search !== '?v=' + VERSION && !refresh && !report) return;
  event.respondWith(fromRelease(path, request, refresh));
});
