/* Colabが計算した集計値を読む。予測・誤差の再計算は行わない。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WindResultsCore = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const MAX_FILE = 50 * 1024 * 1024;
  const MAX_TEXT = 4 * 1024 * 1024;
  const MAX_IMAGE = 8 * 1024 * 1024;
  const GROUPS = ['month', 'hour', 'direction', 'speed_band'];
  const METRICS = ['speed_mae_ms', 'speed_rmse_ms', 'speed_bias_ms', 'direction_mae_deg', 'within_45_pct', 'vector_rmse_ms'];
  const COUNTS = ['n_rows', 'n_speed', 'n_direction', 'n_vector', 'n_excluded', 'n_calm', 'n_undefined_direction'];
  const decoder = new TextDecoder('utf-8', { fatal: true });

  function fail(message) { throw new Error(message); }
  function text(value, field) {
    if (typeof value !== 'string' || !value.trim() || value.length > 250) fail(`${field}を確認してください。`);
    return value.trim();
  }
  function number(value, field, nullable = true) {
    if (value == null || (typeof value === 'string' && /^(?:\s*|nan|null|none)$/i.test(value.trim()))) {
      if (nullable) return null;
      fail(`${field}に数値が必要です。`);
    }
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) fail(`${field}に不正な数値があります。`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) fail(`${field}は有限の数値にしてください。`);
    return parsed;
  }

  function parseCSV(input) {
    if (typeof input !== 'string' || input.length > MAX_TEXT) fail('集計CSVは4 MB以下で選んでください。');
    const source = input.replace(/^\uFEFF/, '');
    let rows = [], row = [], value = '', quoted = false, endedQuote = false;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"') {
          if (source[i + 1] === '"') { value += '"'; i++; }
          else { quoted = false; endedQuote = true; }
        } else value += char;
      } else if (char === '"') {
        if (value || endedQuote) fail('CSVの引用符を確認してください。');
        quoted = true;
      } else if (char === ',' || char === '\n' || char === '\r') {
        row.push(value); value = ''; endedQuote = false;
        if (char !== ',') {
          if (char === '\r' && source[i + 1] === '\n') i++;
          if (row.some(cell => cell !== '')) rows.push(row);
          row = [];
          if (rows.length > 10001) fail('集計CSVは10,000行以下で選んでください。');
        }
      } else {
        if (endedQuote) fail('CSVの引用符の後に文字があります。');
        value += char;
      }
    }
    if (quoted) fail('CSVの引用符が閉じていません。');
    row.push(value);
    if (row.some(cell => cell !== '')) rows.push(row);
    if (!rows.length) fail('CSVが空です。');
    const headers = rows.shift().map(name => name.trim());
    if (headers.some(name => !name || ['__proto__', 'prototype', 'constructor'].includes(name)) || new Set(headers).size !== headers.length) fail('CSVの列名が空欄または重複しています。');
    return rows.map((cells, index) => {
      if (cells.length !== headers.length) fail(`CSVの${index + 2}行目の列数が一致しません。`);
      const result = Object.create(null);
      headers.forEach((name, i) => { result[name] = cells[i]; });
      return result;
    });
  }

  function summaryRows(rows, group) {
    if (!Array.isArray(rows) || rows.length > 10000) fail('集計表の形式か行数を確認してください。');
    const keys = new Set();
    return rows.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('集計表の行を読み込めません。');
      const row = { station: text(item.station, '地点'), model: text(item.model, '手法'), horizon_h: number(item.horizon_h, '予測時間', false) };
      if (row.horizon_h <= 0 || row.horizon_h > 1000) fail('予測時間の範囲を確認してください。');
      for (const name of COUNTS) {
        row[name] = number(item[name], name, name !== 'n_speed');
        if (row[name] != null && (!Number.isInteger(row[name]) || row[name] < 0)) fail(`${name}は0以上の整数にしてください。`);
      }
      for (const name of METRICS) {
        row[name] = number(item[name], name);
        if (name !== 'speed_bias_ms' && row[name] != null && row[name] < 0) fail(`${name}は0以上です。`);
      }
      if (row.direction_mae_deg != null && row.direction_mae_deg > 180) fail('風向誤差は0〜180度です。');
      if (row.within_45_pct != null && row.within_45_pct > 100) fail('割合は0〜100%です。');
      // 空欄と真の0を区別する。採点0件なら数値が記録されていても未評価と表示する。
      if (!row.n_speed) for (const name of ['speed_mae_ms', 'speed_rmse_ms', 'speed_bias_ms']) row[name] = null;
      if (!row.n_direction) for (const name of ['direction_mae_deg', 'within_45_pct']) row[name] = null;
      if (!row.n_vector) row.vector_rmse_ms = null;
      if (group) {
        const value = item[group];
        if (value == null || String(value).length > 100) fail('条件別の区分を読み込めません。');
        row[group] = String(value);
      }
      const key = JSON.stringify([row.station, row.model, row.horizon_h, group ? row[group] : null]);
      if (keys.has(key)) fail(`集計表に同じ地点・手法・時間先の行が重複しています（${index + 1}行目）。`);
      keys.add(key);
      return row;
    });
  }

  function skillRows(rows) {
    if (!Array.isArray(rows) || rows.length > 10000) fail('改善度の表を読み込めません。');
    return rows.map(item => {
      const row = { station: text(item.station, '地点'), model: text(item.model, '手法'), horizon_h: number(item.horizon_h, '予測時間', false), baseline: text(item.baseline || 'persistence', '比較基準') };
      if (row.horizon_h <= 0 || row.horizon_h > 1000) fail('改善度の予測時間を確認してください。');
      for (const key of ['speed_skill_pct', 'ci_low_pct', 'ci_high_pct', 'n_pairs', 'n_days']) row[key] = number(item[key], key);
      for (const key of ['n_pairs', 'n_days']) if (row[key] != null && (!Number.isInteger(row[key]) || row[key] < 0)) fail('改善度の件数を確認してください。');
      if (!row.n_pairs) for (const key of ['speed_skill_pct', 'ci_low_pct', 'ci_high_pct']) row[key] = null;
      if (row.n_days == null || row.n_days < 2) row.ci_low_pct = row.ci_high_pct = null;
      if ((row.ci_low_pct == null) !== (row.ci_high_pct == null) || (row.ci_low_pct != null && row.ci_low_pct > row.ci_high_pct)) fail('改善度の95%区間を確認してください。');
      return row;
    });
  }

  function normaliseBundle(input) {
    if (!input || typeof input !== 'object') fail('解析結果を読み込めません。');
    const metadata = input.metadata || {};
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('metadata.jsonはオブジェクト形式で選んでください。');
    if (metadata.schema_version != null && !/^1\.0\.\d+$/.test(String(metadata.schema_version))) fail('この出力形式にはまだ対応していません。最新のWeb版を確認してください。');
    const kind = ['synthetic', 'observations', 'numerical_forecast'].includes(metadata.source_kind) ? metadata.source_kind : 'unknown';
    const grouped = {};
    GROUPS.forEach(group => { grouped[group] = summaryRows(input.grouped?.[group] || [], group); });
    return { metadata: { ...metadata, source_kind: kind }, summary: summaryRows(input.summary || []), skill: skillRows(input.skill || []), grouped, images: input.images || [], name: String(input.name || '解析結果') };
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function safePath(name) {
    return name && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) && !name.split('/').some(part => part === '..' || part === '.');
  }

  function zipDirectory(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE || bytes.length < 22) fail('ZIPは50 MB以下の結果ファイルを選んでください。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0) fail('ZIPの末尾を確認できません。結果ZIPを選び直してください。');
    const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || offset === 0xffffffff || size === 0xffffffff || count > 2000 || offset + size !== end) fail('分割ZIP・ZIP64・大きすぎるZIPには対応していません。');
    const entries = new Map();
    let cursor = offset;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail('ZIPのファイル一覧が壊れています。');
      const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
      const compressed = view.getUint32(cursor + 20, true), length = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > end || flags & (1 | 64 | 8192) || [compressed, length].includes(0xffffffff)) fail('暗号化ZIPや壊れた一覧は読み込めません。');
      let name;
      try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); } catch (_) { fail('ZIP内のファイル名を読み込めません。'); }
      if (!safePath(name) || entries.has(name)) fail('ZIP内のファイル名が不正または重複しています。');
      const local = view.getUint32(cursor + 42, true);
      if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) fail('ZIPのデータ位置が不正です。');
      const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
      const dataOffset = local + 30 + localNameLength + localExtra;
      if (dataOffset + compressed > offset || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) fail('ZIPのファイル情報が一致しません。');
      entries.set(name, { name, method, compressed, length, offset: dataOffset, crc: view.getUint32(cursor + 16, true) });
      cursor = next;
    }
    if (cursor !== end) fail('ZIPの一覧の長さが一致しません。');
    return entries;
  }

  async function unpack(bytes, entry, limit) {
    if (entry.length > limit) fail(`${entry.name}が大きすぎます。集計ファイルだけを選んでください。`);
    const compressed = bytes.subarray(entry.offset, entry.offset + entry.compressed);
    let result;
    if (entry.method === 0) result = compressed.slice();
    else if (entry.method === 8) {
      let decompressor;
      try { decompressor = new DecompressionStream('deflate-raw'); } catch (_) { fail('このブラウザではZIPを開けません。ZIPを展開し、summary.csvとmetadata.jsonをまとめて選んでください。'); }
      const reader = new Blob([compressed]).stream().pipeThrough(decompressor).getReader();
      const chunks = []; let total = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.length;
          if (total > limit || total > entry.length) { await reader.cancel(); fail('ZIPの展開サイズが不正です。'); }
          chunks.push(chunk.value);
        }
      } catch (error) { fail(`ZIPのデータを展開できません：${error.message}`); }
      result = new Uint8Array(total); let index = 0;
      for (const chunk of chunks) { result.set(chunk, index); index += chunk.length; }
    } else fail('このZIP圧縮方式には対応していません。CSVを選んでください。');
    if (result.length !== entry.length || crc32(result) !== entry.crc) fail(`ZIPの${entry.name}が破損しています。`);
    return result;
  }

  function isPNG(bytes) {
    if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return false;
    const width = view.getUint32(16), height = view.getUint32(20);
    return width > 0 && height > 0 && width <= 10000 && height <= 10000 && width * height <= 25000000;
  }

  async function readZip(buffer, name = '結果ZIP') {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entries = zipDirectory(bytes);
    if (!entries.has('summary.csv')) fail('summary.csvがありません。Colabの「結果ZIP」を選んでください。');
    const bundle = { name, metadata: {}, summary: [], skill: [], grouped: {}, images: [] };
    const needed = ['metadata.json', 'summary.csv', 'skill.csv', ...GROUPS.map(group => `errors_by_${group}.csv`)];
    for (const path of needed) {
      if (!entries.has(path)) continue;
      let decoded;
      try { decoded = decoder.decode(await unpack(bytes, entries.get(path), MAX_TEXT)); } catch (error) { fail(`${path}を読めません：${error.message}`); }
      if (path === 'metadata.json') {
        try { bundle.metadata = JSON.parse(decoded); } catch (_) { fail('metadata.jsonのJSONを確認してください。'); }
      } else if (path === 'summary.csv') bundle.summary = parseCSV(decoded);
      else if (path === 'skill.csv') bundle.skill = parseCSV(decoded);
      else bundle.grouped[path.slice(10, -4)] = parseCSV(decoded);
    }
    // 初期表示は最大12枚。重い生データ・モデルファイルは展開しない。
    let pixels = 0;
    for (const entry of [...entries.values()].filter(entry => /^figures\/[A-Za-z0-9_-]+\.png$/.test(entry.name)).slice(0, 12)) {
      const data = await unpack(bytes, entry, MAX_IMAGE);
      if (!isPNG(data)) fail('図のPNG形式または画像サイズを確認してください。');
      const dimensions = new DataView(data.buffer, data.byteOffset, data.byteLength);
      pixels += dimensions.getUint32(16) * dimensions.getUint32(20);
      if (pixels > 40000000) fail('図の合計サイズが大きすぎます。summary.csvとmetadata.jsonで結果を確認してください。');
      bundle.images.push({ name: entry.name, data });
    }
    return normaliseBundle(bundle);
  }

  async function readFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) fail('結果ZIPか集計CSVを選んでください。');
    if (list.some(file => file.size > MAX_FILE)) fail('1ファイル50 MB以下で選んでください。');
    const zip = list.filter(file => /\.zip$/i.test(file.name));
    if (zip.length) {
      if (list.length !== 1) fail('結果ZIPは1つずつ選んでください。CSVと混ぜずに選び直します。');
      return readZip(await zip[0].arrayBuffer(), zip[0].name);
    }
    const names = new Set();
    const bundle = { name: list.map(file => file.name).join('、'), metadata: {}, summary: [], skill: [], grouped: {} };
    for (const file of list) {
      if (file.size > MAX_TEXT) fail('集計CSV・JSONは4 MB以下で選んでください。');
      const name = file.name.toLowerCase();
      if (names.has(name)) fail('同じ名前のファイルを重複して選べません。');
      names.add(name);
      if (name === 'metadata.json') {
        try { bundle.metadata = JSON.parse(await file.text()); } catch (_) { fail('metadata.jsonを読み込めません。'); }
      } else if (name === 'summary.csv' || (list.length === 1 && name.endsWith('.csv'))) bundle.summary = parseCSV(await file.text());
      else if (name === 'skill.csv') bundle.skill = parseCSV(await file.text());
      else if (/^errors_by_(month|hour|direction|speed_band)\.csv$/.test(name)) bundle.grouped[name.slice(10, -4)] = parseCSV(await file.text());
      else fail('summary.csv、metadata.json、skill.csv、条件別CSVを選んでください。');
    }
    if (!list.some(file => file.name.toLowerCase() === 'summary.csv') && !(list.length === 1 && list[0].name.toLowerCase().endsWith('.csv'))) fail('summary.csvも一緒に選んでください。');
    return normaliseBundle(bundle);
  }

  function filterRows(rows, filters) {
    return rows.filter(row => (!filters.station || row.station === filters.station) && (!filters.model || row.model === filters.model) && (!filters.horizon || row.horizon_h === Number(filters.horizon)));
  }
  function modelLabel(value) {
    const map = { persistence: '持続予報', persistence_24h: '前日の同時刻', climatology: '季節・時刻の平均', linear: '線形モデル', boosting: '勾配ブースティング', boosting_shallow: '勾配ブースティング', jma_msm: 'JMA MSM', ecmwf_ifs025: 'ECMWF IFS 0.25°' };
    const parts = String(value).split(':');
    const extra = { land: '陸格子', sea: '海格子', calendar: '季節・時刻', recent: '過去の風', 'calendar+recent': '季節・時刻＋過去の風' };
    return (map[parts[0]] || parts[0]) + (parts[1] ? `（${extra[parts[1]] || parts[1]}）` : '');
  }
  return { parseCSV, summaryRows, skillRows, normaliseBundle, readZip, readFiles, zipDirectory, crc32, filterRows, modelLabel, MAX_FILE };
}));
