/* Display the bundled measurements; audio analysis stays in Colab. */
(function () {
  'use strict';
  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const isText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 250;
  function validateCatalogue(value) {
    const config = value && value.config;
    if (!value || value.schema_version !== 'vocal-reference-catalogue-v1' || !config
        || config.low_hz !== 0.2 || config.high_hz !== 20
        || config.segment_seconds !== 20 || config.auto_band !== false
        || !Array.isArray(value.references) || value.references.length > 1000) {
      throw new Error('比較DBの一覧形式を確認できませんでした。');
    }
    for (const row of value.references) {
      if (!row || !isText(row.artist) || !isText(row.track)
          || !isNumber(row.slope) || !isNumber(row.r_squared)
          || row.r_squared < 0 || row.r_squared > 1
          || !isNumber(row.duration_seconds) || row.duration_seconds <= 0) {
        throw new Error('比較DBの登録値を確認できませんでした。');
      }
    }
    return value;
  }
  function searchText(value) {
    return String(value).normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g, ' ').trim();
  }
  function filterReferences(references, query = '') {
    const terms = searchText(query).split(' ').filter(Boolean);
    return references.filter(row => terms.every(term => searchText(row.artist + ' ' + row.track).includes(term)));
  }
  function referenceKey(row) {
    return row.artist.normalize('NFC').trim() + '\0' + row.track.normalize('NFC').trim();
  }
  function validateListeningLinks(value) {
    if (!value || value.schema_version !== 'vocal-reference-listening-links-v1'
        || value.purpose !== 'song-identification' || value.measured_source !== false
        || !Array.isArray(value.references) || value.references.length > 1000) {
      throw new Error('楽曲紹介リンクの形式を確認できませんでした。');
    }
    const seen = new Set();
    for (const row of value.references) {
      if (!row || !isText(row.artist) || !isText(row.track)
          || typeof row.publisher !== 'string' || row.publisher.length > 250
          || (row.url !== null && (typeof row.url !== 'string'
              || !/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(row.url)))) {
        throw new Error('楽曲紹介リンクを確認できませんでした。');
      }
      const key = referenceKey(row);
      if (seen.has(key)) throw new Error('楽曲紹介リンクが重複しています。');
      seen.add(key);
    }
    return value;
  }
  if (typeof module !== 'undefined') module.exports = {validateCatalogue, filterReferences, validateListeningLinks};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  if (!$('reference-catalogue')) return;
  let catalogue;
  let listeningLinks;
  let listeningFailed = false;

  function textElement(tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }
  function renderCatalogue() {
    if (!catalogue) return;
    const rows = filterReferences(catalogue.references, $('catalogue-search').value);
    const output = $('catalogue-rows');
    output.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement('tr');
      const artist = textElement('th', row.artist);
      artist.scope = 'row';
      const track = textElement('td', row.track);
      const reference = textElement('span', '', 'listening-reference');
      const listening = listeningLinks && listeningLinks.get(referenceKey(row));
      if (listening && listening.url) {
        const link = textElement('a', listening.publisher === 'YOSHIKI'
          ? 'YOSHIKI公式で曲を聴く ↗' : '公式動画で曲を聴く ↗');
        link.href = listening.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', row.artist + '「' + row.track + '」の楽曲紹介動画をYouTubeで開く'
          + (listening.publisher === 'YOSHIKI' ? '（YOSHIKI公式）' : ''));
        reference.append(link);
      } else {
        reference.textContent = listeningLinks ? 'リンクなし'
          : listeningFailed ? '紹介リンクを読み込めませんでした' : '紹介リンクを読み込んでいます';
      }
      track.append(reference);
      tr.append(artist, track,
        textElement('td', row.slope.toFixed(2)), textElement('td', row.r_squared.toFixed(3)));
      output.append(tr);
    }
    const records = catalogue.references;
    const artists = new Set(records.map(row => row.artist));
    $('catalogue-status').textContent = '初期DB：' + records.length + '曲分・' + artists.size
      + 'アーティストの解析結果（数値）。表示 ' + rows.length + '件。';
    $('catalogue-table-wrap').hidden = rows.length === 0;
    $('catalogue-empty').hidden = rows.length > 0;
  }
  async function loadListeningLinks() {
    $('listening-retry').hidden = true;
    $('listening-status').classList.remove('error');
    $('listening-status').textContent = '楽曲紹介リンクを読み込んでいます。';
    listeningFailed = false;
    try {
      const response = await fetch('data/reference_listening_links.json');
      if (!response.ok) throw new Error('data');
      const value = validateListeningLinks(await response.json());
      listeningLinks = new Map(value.references.map(row => [referenceKey(row), row]));
      $('listening-status').textContent = '楽曲紹介リンクは、測定に使用した音源へのリンクではありません。';
    } catch (_) {
      listeningLinks = undefined;
      listeningFailed = true;
      $('listening-status').classList.add('error');
      $('listening-status').textContent = '楽曲紹介リンクを読み込めませんでした。数値の解析結果の読み込みには影響しません。';
      $('listening-retry').hidden = false;
    }
    renderCatalogue();
  }
  async function loadCatalogue() {
    $('reference-catalogue').setAttribute('aria-busy', 'true');
    $('catalogue-search').disabled = true;
    $('catalogue-retry').hidden = true;
    $('catalogue-table-wrap').hidden = $('catalogue-empty').hidden = true;
    $('catalogue-status').classList.remove('error');
    $('catalogue-status').textContent = '解析結果の数値を読み込んでいます。';
    try {
      const response = await fetch('data/reference_catalogue_public.json');
      if (!response.ok) throw new Error('data');
      catalogue = validateCatalogue(await response.json());
      renderCatalogue();
      $('catalogue-search').disabled = false;
    } catch (_) {
      $('catalogue-status').textContent = '解析結果の一覧を読み込めませんでした。「一覧を再読み込み」で再試行できます。Colabの「現在のDBに登録された解析結果」からも確認できます。';
      $('catalogue-status').classList.add('error');
      $('catalogue-retry').hidden = false;
    } finally {
      $('reference-catalogue').setAttribute('aria-busy', 'false');
    }
  }
  $('catalogue-search').addEventListener('input', renderCatalogue);
  $('catalogue-retry').addEventListener('click', loadCatalogue);
  $('listening-retry').addEventListener('click', loadListeningLinks);
  loadCatalogue();
  loadListeningLinks();
}());
