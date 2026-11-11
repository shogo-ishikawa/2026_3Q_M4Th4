/* 読み込んだファイルはブラウザ内だけで表示する。 */
(function () {
  'use strict';
  function initialise() {
    const mount = document.getElementById('results-app');
    const core = window.WindResultsCore;
    if (!mount || !core) return;
    const state = { bundle: null, token: 0, urls: [], redraw: null };
    const colours = ['#2458ed', '#078995', '#d96532', '#7553bd', '#376654', '#a63c75'];
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = text;
      return element;
    };
    const button = (label, id, secondary) => {
      const element = node('button', `button result-button${secondary ? ' secondary' : ''}`, label);
      element.type = 'button'; element.id = id; return element;
    };
    const toolbar = node('div', 'result-toolbar');
    const upload = button('結果ZIP・CSVを選ぶ', 'result-upload');
    const example = button('合成データの例を見る', 'result-demo', true);
    const reset = button('表示をリセット', 'result-reset', true);
    const files = node('input', 'result-file-input');
    files.type = 'file'; files.multiple = true; files.accept = '.zip,.csv,.json'; files.id = 'result-files';
    files.setAttribute('aria-label', '結果ZIP・CSVを選ぶ');
    files.style.display = 'none';
    toolbar.append(upload, example, reset, files);
    const filename = node('p', 'result-file-label', 'ファイルを選ぶと、前の表示を置き換えます。');
    const status = node('p', 'result-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const body = node('div', 'result-body');
    mount.append(toolbar, filename, status, body);

    function releaseImages() { for (const url of state.urls) URL.revokeObjectURL(url); state.urls = []; }
    function clear() { releaseImages(); state.bundle = null; state.redraw = null; body.replaceChildren(); }
    function format(value, digits = 2) { return value == null ? '未評価' : Number(value).toLocaleString('ja-JP', { maximumFractionDigits: digits, signDisplay: 'negative' }); }
    function horizon(value) { return `${format(value, 3)}時間先`; }
    function table(headers, rows, caption) {
      const wrap = node('div', 'result-table-wrap');
      wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', caption);
      const element = node('table', 'result-table');
      const title = node('caption', '', caption);
      const head = node('thead'); const header = node('tr');
      headers.forEach(label => { const th = node('th', '', label); th.scope = 'col'; header.append(th); });
      head.append(header);
      const contents = node('tbody');
      rows.forEach(cells => { const tr = node('tr'); cells.forEach(value => tr.append(node('td', '', value))); contents.append(tr); });
      element.append(title, head, contents); wrap.append(element); return wrap;
    }
    function select(label, id, values, allLabel) {
      const group = node('label', 'result-filter'); group.append(node('span', '', label));
      const input = node('select'); input.id = id;
      if (allLabel) { const option = node('option', '', allLabel); option.value = ''; input.append(option); }
      values.forEach(([value, text]) => { const option = node('option', '', text); option.value = value; input.append(option); });
      group.append(input); return { group, input };
    }
    function svgNode(tag, attrs = {}, text) {
      const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
      if (text != null) element.textContent = text;
      return element;
    }
    function leadChart(rows) {
      const available = rows.filter(row => row.n_speed > 0 && row.speed_mae_ms != null);
      if (!available.length) return node('p', 'result-note', '観測と照合できる行がないため、誤差のグラフは表示しません。');
      const container = node('div', 'result-chart');
      const plotWidth = window.matchMedia('(max-width: 600px)').matches ? 400 : 900;
      const left = 60, right = plotWidth - 25;
      const svg = svgNode('svg', { viewBox: `0 0 ${plotWidth} 360`, role: 'img', 'aria-label': 'Colabで計算した予測時間先ごとの風速MAE' });
      svg.append(svgNode('title', {}, '何時間先で、どのくらい外れたか'));
      svg.append(svgNode('desc', {}, '読み込んだ集計値をそのまま表示。線が低いほど風速MAEが小さいことを表します。未評価の点は線で結びません。'));
      const xValues = [...new Set(rows.map(row => row.horizon_h))].sort((a, b) => a - b);
      const xMin = Math.min(...xValues), xMax = Math.max(...xValues), maximum = Math.max(...available.map(row => row.speed_mae_ms), 0.1) * 1.18;
      const x = value => left + (xMax === xMin ? 0.5 : (value - xMin) / (xMax - xMin)) * (right - left);
      const y = value => 286 - value / maximum * 240;
      for (let step = 0; step <= 4; step++) {
        const value = maximum * step / 4;
        svg.append(svgNode('line', { x1: left, x2: right, y1: y(value), y2: y(value), stroke: '#d4e1eb', 'stroke-width': 1 }));
        svg.append(svgNode('text', { x: left - 10, y: y(value) + 4, 'text-anchor': 'end', fill: '#5c7186', 'font-size': 12 }, format(value)));
      }
      const tickStep = Math.max(1, Math.ceil(xValues.length / (plotWidth < 600 ? 5 : 10)));
      xValues.filter((_, index) => index % tickStep === 0 || index === xValues.length - 1).forEach(value => svg.append(svgNode('text', { x: x(value), y: 308, 'text-anchor': 'middle', fill: '#5c7186', 'font-size': 12 }, format(value, 2))));
      svg.append(svgNode('text', { x: (left + right) / 2, y: 342, 'text-anchor': 'middle', fill: '#132a43', 'font-size': 13 }, '予測する時間先（時間）'));
      svg.append(svgNode('text', { x: 12, y: 22, fill: '#132a43', 'font-size': 13 }, '風速MAE（m/s）'));
      const series = new Map();
      rows.forEach(row => { const key = JSON.stringify([row.station, row.model]); if (!series.has(key)) series.set(key, []); series.get(key).push(row); });
      const legend = node('ul', 'result-legend'); let index = 0;
      for (const group of series.values()) {
        const colour = colours[index++ % colours.length];
        const label = `${group[0].station} / ${core.modelLabel(group[0].model)}`;
        const item = node('li'); const swatch = node('span', 'result-swatch'); swatch.style.backgroundColor = colour; item.append(swatch, document.createTextNode(label)); legend.append(item);
        const sorted = group.slice().sort((a, b) => a.horizon_h - b.horizon_h);
        let segment = [];
        function finishSegment() {
          if (segment.length > 1) svg.append(svgNode('polyline', { points: segment.map(row => `${x(row.horizon_h)},${y(row.speed_mae_ms)}`).join(' '), fill: 'none', stroke: colour, 'stroke-width': 2.5 }));
          segment = [];
        }
        sorted.forEach(row => {
          if (!row.n_speed || row.speed_mae_ms == null) { finishSegment(); return; }
          segment.push(row);
        }); finishSegment();
        sorted.filter(row => row.n_speed && row.speed_mae_ms != null).forEach(row => {
          const point = svgNode('circle', { cx: x(row.horizon_h), cy: y(row.speed_mae_ms), r: 4.5, fill: colour, tabindex: 0 });
          const detail = `${label}、${horizon(row.horizon_h)}、MAE ${format(row.speed_mae_ms)} m/s、評価${format(row.n_speed, 0)}件`;
          point.setAttribute('aria-label', detail); point.append(svgNode('title', {}, detail)); svg.append(point);
        });
      }
      container.append(svg, legend); return container;
    }

    function render(bundle) {
      body.replaceChildren(); releaseImages(); state.bundle = bundle;
      const sourceText = {
        synthetic: '合成データの解析例です。実際の観測所での予測精度を示すものではありません。',
        observations: 'ファイルには実観測からの解析結果と記録されています。地点・期間・評価件数も確認してください。',
        numerical_forecast: '既存の気象予報を使った結果です。観測との照合件数と時刻の基準を確認してください。',
        unknown: '出所を確認できません。metadata.jsonも一緒に選ぶと、合成データ・実観測・気象予報の区分を表示できます。'
      };
      const banner = node('p', `result-source result-source-${bundle.metadata.source_kind}`, sourceText[bundle.metadata.source_kind]);
      banner.id = 'result-source';
      const overview = node('p', 'result-overview');
      const modeLabels = { demo: '合成データの過去検証', csv_backtest: '観測CSVの過去検証', latest_forecast: '最新予報の比較', historical_forecast: '過去の気象予報', future: '将来予測' };
      overview.textContent = [modeLabels[bundle.metadata.mode] || '集計結果', bundle.metadata.timezone ? `日時：${bundle.metadata.timezone}` : '日時の基準：記録なし', '誤差はColabの計算済み値'].join(' ／ ');
      body.append(banner, overview);
      const timeBasis = { retrieval_time: '時間先の基準：予報を取得した時刻', initialisation_time: '時間先の基準：モデルの初期時刻' };
      if (timeBasis[bundle.metadata.issue_basis]) body.append(node('p', 'result-note', timeBasis[bundle.metadata.issue_basis]));
      if (typeof bundle.metadata.note === 'string' && bundle.metadata.note.trim()) body.append(node('p', 'result-note', bundle.metadata.note.slice(0, 1000)));
      const periods = bundle.metadata.split;
      if (periods && typeof periods === 'object') {
        const periodText = [periods.start && `学習開始 ${String(periods.start).slice(0, 19)}`, periods.validation_start && `調整開始 ${String(periods.validation_start).slice(0, 19)}`, periods.test_start && `最終評価開始 ${String(periods.test_start).slice(0, 19)}`, periods.end && `終了 ${String(periods.end).slice(0, 19)}`].filter(Boolean).join(' → ');
        if (periodText) body.append(node('p', 'result-note', periodText));
      }
      if (Array.isArray(bundle.metadata.messages)) bundle.metadata.messages.slice(0, 10).forEach(message => body.append(node('p', 'result-note', String(message).slice(0, 600))));
      if (!bundle.summary.length) { body.append(node('p', 'result-note', '集計行がありません。観測がそろってからColabで再解析した結果を選んでください。')); return; }
      const filters = node('div', 'result-filters');
      const stations = [...new Set(bundle.summary.map(row => row.station))];
      const models = [...new Set(bundle.summary.map(row => row.model))];
      const horizons = [...new Set(bundle.summary.map(row => row.horizon_h))].sort((a, b) => a - b);
      const station = select('地点', 'result-station', stations.map(value => [value, value]), stations.length > 1 ? 'すべての地点' : null);
      const model = select('予測方法', 'result-model', models.map(value => [value, core.modelLabel(value)]), 'すべての予測方法');
      const lead = select('予測する時間先', 'result-horizon', horizons.map(value => [value, horizon(value)]), 'すべての時間先');
      filters.append(station.group, model.group, lead.group);
      const selected = node('div', 'result-selected');
      body.append(filters, selected);

      function draw() {
        selected.replaceChildren();
        const selection = { station: station.input.value, model: model.input.value, horizon: lead.input.value };
        const rows = core.filterRows(bundle.summary, selection);
        const summary = node('div', 'result-metrics');
        const cards = rows.length === 1 ? [
          ['風速MAE', format(rows[0].speed_mae_ms), 'm/s'], ['風速RMSE', format(rows[0].speed_rmse_ms), 'm/s'],
          ['予測−観測の偏り', format(rows[0].speed_bias_ms), 'm/s'], ['風速の評価件数', format(rows[0].n_speed, 0), '件']
        ] : [
          ['予測方法', format(new Set(rows.map(row => row.model)).size, 0), '種類'],
          ['時間先', format(new Set(rows.map(row => row.horizon_h)).size, 0), '種類'],
          ['表示する集計', format(rows.length, 0), '組'],
          ['評価できた集計', format(rows.filter(row => row.n_speed > 0).length, 0), '組']
        ];
        cards.forEach(([label, value, unit]) => { const card = node('div', 'result-metric'); card.append(node('span', 'result-metric-label', label), node('strong', 'result-metric-value', value), node('span', 'result-metric-unit', value === '未評価' ? '' : unit)); summary.append(card); });
        selected.append(summary);
        if (!rows.length) { selected.append(node('p', 'result-note', 'この組み合わせの集計はありません。条件を変えてください。')); return; }
        const evaluated = rows.filter(row => row.n_speed > 0);
        if (!evaluated.length) selected.append(node('p', 'result-note', '観測との照合は0件です。空欄は誤差ゼロではなく「未評価」を表します。'));
        else selected.append(node('p', 'result-note', '地点・対象期間・件数がそろう条件で比較します。手法ごとの件数は同じ観測を含むため、足し合わせていません。'));
        selected.append(leadChart(rows));
        selected.append(table(['地点・予測方法', '時間先', '風速MAE', '風速RMSE', '偏り', '風向MAE', '風速の件数', '風向の件数'], rows.slice(0, 200).map(row => [
          `${row.station} / ${core.modelLabel(row.model)}`, horizon(row.horizon_h), `${format(row.speed_mae_ms)}${row.speed_mae_ms == null ? '' : ' m/s'}`,
          `${format(row.speed_rmse_ms)}${row.speed_rmse_ms == null ? '' : ' m/s'}`, `${format(row.speed_bias_ms)}${row.speed_bias_ms == null ? '' : ' m/s'}`,
          `${format(row.direction_mae_deg)}${row.direction_mae_deg == null ? '' : '°'}`, format(row.n_speed, 0), format(row.n_direction, 0)
        ]), 'Colabで計算した誤差の集計'));
        if (rows.length > 200) selected.append(node('p', 'result-note', '表は先頭200行を表示しています。地点・方法・時間先で絞り込めます。'));
        const skill = core.filterRows(bundle.skill, selection);
        if (skill.length) {
          selected.append(table(['地点・予測方法', '時間先', '改善率', '95%区間', '比較した組／日数'], skill.slice(0, 100).map(row => [`${row.station} / ${core.modelLabel(row.model)}`, horizon(row.horizon_h), row.speed_skill_pct == null ? '未評価' : `${format(row.speed_skill_pct)}%`, row.ci_low_pct == null ? '算出なし' : `${format(row.ci_low_pct)}〜${format(row.ci_high_pct)}%`, `${format(row.n_pairs, 0)}組／${format(row.n_days, 0)}日`]), '持続予報からの改善度（同じ時刻の組で比較）'));
          selected.append(node('p', 'result-note', '改善率が正なら持続予報よりMAEが小さく、負なら大きいことを表します。95%区間は日単位で再抽出した成績のばらつきで、未来の風速の予測区間ではありません。'));
        }
        const availableGroups = ['month', 'hour', 'direction', 'speed_band'].filter(group => bundle.grouped[group].length);
        if (availableGroups.length) {
          const details = node('details', 'result-details'); const title = node('summary', '', '条件別の集計表を見る');
          const labels = { month: '月', hour: '時刻（JST）', direction: '観測風向', speed_band: '風速帯（m/s）' };
          details.append(title);
          availableGroups.forEach(group => {
            const matched = core.filterRows(bundle.grouped[group], selection);
            if (matched.length) details.append(table([labels[group], '地点・予測方法', '時間先', '風速MAE（m/s）', '評価件数'], matched.slice(0, 48).map(row => [row[group], `${row.station} / ${core.modelLabel(row.model)}`, horizon(row.horizon_h), format(row.speed_mae_ms), format(row.n_speed, 0)]), `${labels[group]}別の誤差（先頭48行）`));
          });
          selected.append(details);
        }
      }
      for (const control of [station.input, model.input, lead.input]) control.addEventListener('change', draw);
      state.redraw = draw;
      draw();
      if (bundle.images.length) {
        const gallery = node('details', 'result-gallery'); gallery.append(node('summary', '', `Colabで保存した図を見る（${bundle.images.length}枚）`));
        gallery.append(node('p', 'result-note', '保存された元の図です。上の絞り込み条件では変わりません。'));
        bundle.images.forEach(item => {
          const url = URL.createObjectURL(new Blob([item.data], { type: 'image/png' })); state.urls.push(url);
          const figure = node('figure'); const image = node('img'); image.src = url; image.alt = `Colabの保存図：${item.name}`; image.loading = 'lazy';
          figure.append(image, node('figcaption', '', item.name)); gallery.append(figure);
        }); body.append(gallery);
      }
    }

    window.matchMedia('(max-width: 600px)').addEventListener('change', () => state.redraw?.());
    upload.addEventListener('click', () => files.click());
    files.addEventListener('change', async () => {
      if (!files.files.length) return;
      const token = ++state.token; clear();
      filename.textContent = Array.from(files.files).map(file => file.name).join('、');
      status.textContent = 'ブラウザ内で結果を読み込んでいます…';
      try {
        const bundle = await core.readFiles(files.files);
        if (token !== state.token) return;
        render(bundle); status.textContent = '読み込みました。表示は選び直したファイルの結果だけです。';
      } catch (error) {
        if (token !== state.token) return;
        clear(); status.textContent = `読み込めませんでした：${error.message}`;
      } finally { if (token === state.token) files.value = ''; }
    });
    example.addEventListener('click', () => {
      ++state.token; clear(); files.value = '';
      try {
        if (!window.COASTAL_WIND_DEMO) throw new Error('教材の例が見つかりません。ページを読み直してください。');
        render(core.normaliseBundle(window.COASTAL_WIND_DEMO));
        filename.textContent = '教材に用意した合成データの解析例';
        status.textContent = '合成データの例を表示しています。ファイルの選択や通信は行っていません。';
      } catch (error) { status.textContent = error.message; }
    });
    reset.addEventListener('click', () => { ++state.token; clear(); files.value = ''; filename.textContent = 'ファイルを選ぶと、前の表示を置き換えます。'; status.textContent = '表示をリセットしました。結果ZIPか合成データの例を選べます。'; });
    if (window.COASTAL_WIND_DEMO) example.click();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialise, { once: true });
  else initialise();
}());
