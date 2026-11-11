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
  if (typeof module !== 'undefined') module.exports = {validateCatalogue, filterReferences};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  if (!$('reference-catalogue')) return;
  let catalogue;

  function textElement(tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }
  function renderCatalogue() {
    const rows = filterReferences(catalogue.references, $('catalogue-search').value);
    const output = $('catalogue-rows');
    output.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement('tr');
      const artist = textElement('th', row.artist);
      artist.scope = 'row';
      tr.append(artist, textElement('td', row.track),
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
  loadCatalogue();
}());
