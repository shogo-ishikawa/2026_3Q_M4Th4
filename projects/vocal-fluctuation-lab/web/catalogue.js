/* Display the bundled measurements; audio analysis stays in Colab. */
(function () {
  'use strict';
  const METHODS = ['already-vocals', 'demucs:htdemucs'];
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
          || !METHODS.includes(row.separation_method)
          || typeof row.model_version !== 'string' || row.model_version.length > 100
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
  function filterReferences(references, query = '', method = 'all') {
    const terms = searchText(query).split(' ').filter(Boolean);
    return references.filter(row => (method === 'all' || row.separation_method === method)
      && terms.every(term => searchText(row.artist + ' ' + row.track).includes(term)));
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
    const rows = filterReferences(catalogue.references, $('catalogue-search').value, $('catalogue-group').value);
    const output = $('catalogue-rows');
    output.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement('tr');
      const artist = textElement('th', row.artist);
      artist.scope = 'row';
      const condition = document.createElement('td');
      const vocals = row.separation_method === 'already-vocals';
      condition.append(textElement('span', vocals ? '歌声のみ入力' : 'AIで歌声を抽出', 'input-badge' + (vocals ? ' vocals' : '')));
      condition.append(textElement('small', vocals ? '今回の解析では分離を省略' : 'Demucs htdemucs / ' + row.model_version));
      tr.append(artist, textElement('td', row.track), condition,
        textElement('td', row.slope.toFixed(2)), textElement('td', row.r_squared.toFixed(3)));
      output.append(tr);
    }
    const records = catalogue.references;
    const artists = new Set(records.map(row => row.artist));
    const extracted = records.filter(row => row.separation_method === 'demucs:htdemucs').length;
    const vocals = records.length - extracted;
    $('catalogue-status').textContent = '初期DB：' + records.length + '曲・' + artists.size
      + 'アーティスト（AI抽出 ' + extracted + '曲／歌声のみ入力 ' + vocals + '曲）。表示 ' + rows.length + '曲。';
    $('catalogue-table-wrap').hidden = rows.length === 0;
    $('catalogue-empty').hidden = rows.length > 0;
  }
  async function loadCatalogue() {
    $('reference-catalogue').setAttribute('aria-busy', 'true');
    $('catalogue-search').disabled = $('catalogue-group').disabled = true;
    $('catalogue-retry').hidden = true;
    $('catalogue-table-wrap').hidden = $('catalogue-empty').hidden = true;
    $('catalogue-status').classList.remove('error');
    $('catalogue-status').textContent = '登録曲を読み込んでいます。';
    try {
      const response = await fetch('data/reference_catalogue_public.json');
      if (!response.ok) throw new Error('data');
      catalogue = validateCatalogue(await response.json());
      renderCatalogue();
      $('catalogue-search').disabled = $('catalogue-group').disabled = false;
    } catch (_) {
      $('catalogue-status').textContent = '登録曲の一覧を読み込めませんでした。「一覧を再読み込み」で再試行できます。Colabの「現在の比較DBに入っている曲」からも確認できます。';
      $('catalogue-status').classList.add('error');
      $('catalogue-retry').hidden = false;
    } finally {
      $('reference-catalogue').setAttribute('aria-busy', 'false');
    }
  }
  $('catalogue-search').addEventListener('input', renderCatalogue);
  $('catalogue-group').addEventListener('change', renderCatalogue);
  $('catalogue-retry').addEventListener('click', loadCatalogue);
  loadCatalogue();
}());
