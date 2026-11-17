/* 動画ファイルのURLを確認し、最初のフレームまで読み込む。 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MotionVideoInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const activeLoads = new WeakMap();

  function normaliseVideoURL(text, options = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16384)
      throw new Error('動画ファイルのURLを入力してください。');
    let address;
    try { address = new URL(text.trim()); }
    catch (_) { throw new Error('https:// または http:// で始まる動画ファイルのURLを入力してください。'); }
    if (!['http:', 'https:'].includes(address.protocol))
      throw new Error('https:// または http:// で始まる動画ファイルのURLを入力してください。');
    if (address.username || address.password)
      throw new Error('ユーザー名やパスワードを含まない動画URLを指定してください。');
    const host = address.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')
        || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com'))
      throw new Error('YouTubeの視聴ページは直接解析できません。MP4・WebMなどの動画ファイルのURLか、ローカルの動画を選んでください。');
    const pageURL = options.pageURL === undefined ? root.location?.href : options.pageURL;
    if (pageURL) {
      let page;
      try { page = new URL(pageURL); } catch (_) { throw new TypeError('ページのURLが正しくありません。'); }
      if (page.protocol === 'https:' && address.protocol !== 'https:')
        throw new Error('このページでは https:// で始まる動画URLを指定してください。');
    }
    address.hash = '';
    return address.href;
  }

  function abortError() {
    const error = new Error('動画の読み込みを中止しました。');
    error.name = 'AbortError';
    return error;
  }

  function loadVideoSource(video, options = {}) {
    return new Promise((resolve, reject) => {
      const { objectURL = false, signal, timeoutMs = 20000 } = options;
      if (!video || typeof video.addEventListener !== 'function'
          || typeof video.removeEventListener !== 'function' || typeof video.load !== 'function') {
        reject(new TypeError('動画を表示する要素を指定してください。')); return;
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
        reject(new RangeError('読み込みの待ち時間は1から120000ミリ秒で指定してください。')); return;
      }
      let url;
      try {
        if (objectURL) {
          if (typeof options.url !== 'string' || new URL(options.url).protocol !== 'blob:')
            throw new Error('ローカルの動画ファイルを選んでください。');
          url = options.url;
        } else url = normaliseVideoURL(options.url, { pageURL: options.pageURL });
      } catch (error) { reject(error); return; }
      if (signal?.aborted) { reject(abortError()); return; }

      // 同じ要素への次の要求が、前の要求のイベントを引き継がないようにする。
      activeLoads.get(video)?.cancel();
      let timer, settled = false;
      const entry = { cancel };
      const events = ['loadedmetadata', 'loadeddata', 'canplay'];
      function report(phase) {
        if (settled || activeLoads.get(video) !== entry) return;
        if (typeof options.onProgress === 'function') options.onProgress(phase);
      }
      function buffering() { report('buffering'); if (video.readyState >= 2) ready(); }
      function stalled() { report('stalled'); }
      function clean() {
        clearTimeout(timer);
        for (const name of events) video.removeEventListener(name, ready);
        video.removeEventListener('error', failed);
        video.removeEventListener('progress', buffering);
        video.removeEventListener('waiting', buffering);
        video.removeEventListener('stalled', stalled);
        signal?.removeEventListener('abort', cancel);
        if (activeLoads.get(video) === entry) activeLoads.delete(video);
      }
      function finish(error, value) {
        if (settled) return;
        settled = true; clean();
        if (error) reject(error); else resolve(value);
      }
      function cancel() {
        if (settled) return;
        const ownsSource = activeLoads.get(video) === entry && video.src === url;
        finish(abortError());
        // 新しいsrcへ切り替え済みなら、その動画には触れない。
        if (ownsSource) {
          try { video.removeAttribute('src'); video.load(); } catch (_) {}
        }
      }
      function failed() {
        finish(new Error(objectURL
          ? '動画を開けませんでした。MP4やWebMなど、ブラウザで再生できるファイルを選んでください。'
          : '動画を読み込めませんでした。動画ファイルのURLと配信元の外部読み込み設定を確認するか、ローカルの動画を選んでください。'));
      }
      function ready() {
        if (settled || activeLoads.get(video) !== entry) return;
        if (video.readyState < 1) return;
        report('metadata');
        if (!Number.isFinite(video.duration) || video.duration <= 0
            || !Number.isFinite(video.videoWidth) || video.videoWidth <= 0
            || !Number.isFinite(video.videoHeight) || video.videoHeight <= 0) {
          finish(new Error('動画の長さや解像度を読み取れませんでした。別の動画ファイルを選んでください。'));
          return;
        }
        if (video.readyState >= 2 && !video.seeking)
          finish(null, { duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      }

      activeLoads.set(video, entry);
      for (const name of events) video.addEventListener(name, ready);
      video.addEventListener('error', failed);
      video.addEventListener('progress', buffering);
      video.addEventListener('waiting', buffering);
      video.addEventListener('stalled', stalled);
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish(new Error('動画の読み込みに時間がかかっています。別のURLを指定するか、ローカルの動画を選んでください。')), timeoutMs);
      try {
        report('connecting');
        // 利用者が開いた動画は、情報だけでなく最初の映像も取得する。
        video.preload = 'auto';
        if (objectURL) video.removeAttribute('crossorigin');
        else video.crossOrigin = 'anonymous';
        video.src = url;
        video.load();
        ready();
      } catch (_) { failed(); }
    });
  }

  return Object.freeze({ normaliseVideoURL, loadVideoSource });
});
