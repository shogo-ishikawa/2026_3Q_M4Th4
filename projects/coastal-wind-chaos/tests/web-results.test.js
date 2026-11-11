'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateRawSync } = require('node:zlib');
const core = require('../web/results-core.js');

function summary(changes = {}) {
  return { station: '仮想観測点（合成）', model: 'persistence', horizon_h: 3,
    speed_mae_ms: 0.7, speed_rmse_ms: 1.1, speed_bias_ms: -0.2,
    direction_mae_deg: 12, within_45_pct: 90, vector_rmse_ms: 1.3,
    n_rows: 100, n_speed: 98, n_direction: 95, n_vector: 98, ...changes };
}
function zip(files, method = 8) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const filename = Buffer.from(name);
    const crc = core.crc32(raw);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(Object.keys(files).length, 8); tail.writeUInt16LE(Object.keys(files).length, 10);
  const catalogue = Buffer.concat(central); tail.writeUInt32LE(catalogue.length, 12); tail.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, catalogue, tail]));
}
const csv = 'station,model,horizon_h,speed_mae_ms,speed_rmse_ms,speed_bias_ms,n_speed,n_direction,n_vector\r\n"仮想観測点（合成）",persistence,3,0,0,0,24,0,24\r\n';
const metadata = JSON.stringify({ schema_version: '1.0.0', source_kind: 'synthetic', timezone: 'Asia/Tokyo' });

test('CSV preserves BOM, CRLF, quoted commas, escaped quotes and multiline cells', () => {
  const rows = core.parseCSV('\uFEFFstation,model,value\r\n"地点, A","a""b","line1\r\nline2"\r\n');
  assert.equal(rows[0].station, '地点, A'); assert.equal(rows[0].model, 'a"b'); assert.equal(rows[0].value, 'line1\r\nline2');
});
test('malformed quotation, duplicate headers and wrong width fail clearly', () => {
  for (const value of ['a,a\n1,2', 'a,b\n1', 'a\n"unclosed', 'a\n"closed"extra', 'a\nx"y', '__proto__\na']) assert.throws(() => core.parseCSV(value));
});
test('blank fields remain missing while zero is a real score', () => {
  const [row] = core.summaryRows([{ ...summary(), speed_mae_ms: '', speed_rmse_ms: '0', speed_bias_ms: '0' }]);
  assert.equal(row.speed_mae_ms, null); assert.equal(row.speed_rmse_ms, 0); assert.equal(row.speed_bias_ms, 0);
});
test('future with no matching observations never displays error zero', () => {
  const [row] = core.summaryRows([summary({ n_speed: 0, n_direction: 0, n_vector: 0, speed_mae_ms: 0, speed_rmse_ms: 0 })]);
  assert.equal(row.speed_mae_ms, null); assert.equal(row.speed_rmse_ms, null); assert.equal(row.direction_mae_deg, null); assert.equal(row.vector_rmse_ms, null);
});
test('reject malformed scores, counts and time horizons', () => {
  for (const changes of [{ n_speed: -1 }, { n_speed: 0.5 }, { n_speed: '' }, { speed_mae_ms: '0x10' }, { speed_mae_ms: 'Infinity' }, { speed_mae_ms: -1 }, { horizon_h: 0 }, { horizon_h: NaN }, { direction_mae_deg: 181 }, { within_45_pct: 101 }]) assert.throws(() => core.summaryRows([summary(changes)]));
});
test('duplicate group identifiers are rejected instead of silently averaging', () => {
  assert.throws(() => core.summaryRows([summary(), summary()]));
  assert.equal(core.summaryRows([summary(), summary({ horizon_h: 6 })]).length, 2);
});
test('normalisation keeps the recorded provenance and rejects an unknown schema', () => {
  assert.equal(core.normaliseBundle({ metadata: { source_kind: 'synthetic', schema_version: '1.0.0' }, summary: [summary()] }).metadata.source_kind, 'synthetic');
  assert.equal(core.normaliseBundle({ summary: [summary()] }).metadata.source_kind, 'unknown');
  assert.throws(() => core.normaliseBundle({ metadata: { schema_version: '2.0.0' } }));
  assert.throws(() => core.normaliseBundle({ metadata: [] }));
});
test('one-day skill has no confidence interval and no-pair skill is unscored', () => {
  const rows = core.skillRows([{ ...summary(), n_pairs: 24, n_days: 1, speed_skill_pct: 10, ci_low_pct: 1, ci_high_pct: 20 }]);
  assert.equal(rows[0].speed_skill_pct, 10); assert.equal(rows[0].ci_low_pct, null);
  assert.equal(core.skillRows([{ ...summary(), n_pairs: 0, n_days: 0, speed_skill_pct: 0 }])[0].speed_skill_pct, null);
  assert.throws(() => core.skillRows([{ ...summary(), n_pairs: 24, n_days: 3, ci_low_pct: 20, ci_high_pct: 10 }]));
});
test('filters preserve exact per-row exported values and never average', () => {
  const rows = [summary(), summary({ horizon_h: 6, speed_mae_ms: 1.8 }), summary({ model: 'linear:recent' })];
  const filtered = core.filterRows(rows, { model: 'persistence', horizon: '6' });
  assert.equal(filtered.length, 1); assert.equal(filtered[0].speed_mae_ms, 1.8);
});
test('native raw-deflate ZIP reads only display data, preserving UTF-8 and zeros', async () => {
  const archive = zip({ 'metadata.json': metadata, 'summary.csv': csv, 'models.joblib': Buffer.from('not executed'), 'predictions.csv': 'not a CSV for this viewer' });
  const result = await core.readZip(archive);
  assert.equal(result.metadata.source_kind, 'synthetic'); assert.equal(result.summary.length, 1); assert.equal(result.summary[0].speed_mae_ms, 0);
});
test('stored ZIP and grouped file names are supported', async () => {
  const result = await core.readZip(zip({ 'summary.csv': csv, 'errors_by_speed_band.csv': csv.replace('n_vector', 'n_vector,speed_band').replace('24,0,24', '24,0,24,0–2') }, 0));
  assert.equal(result.grouped.speed_band[0].speed_band, '0–2');
});
test('damaged central directory and CRC do not produce plausible results', async () => {
  const broken = zip({ 'summary.csv': csv }); broken[broken.length - 10] = 0xff;
  await assert.rejects(core.readZip(broken));
  const corrupt = zip({ 'summary.csv': csv }, 0); corrupt[35] ^= 1;
  await assert.rejects(core.readZip(corrupt));
});
test('traversal and absolute ZIP file names fail even for an ignored file', async () => {
  for (const name of ['../data', '/absolute', 'C:/escape', 'figures/../escape', 'x\\escape']) await assert.rejects(core.readZip(zip({ 'summary.csv': csv, [name]: 'unused' })));
});
test('oversized declared output is refused before decompression', async () => {
  const bytes = zip({ 'summary.csv': csv }); const directory = core.zipDirectory(bytes).get('summary.csv');
  assert.equal(directory.name, 'summary.csv');
  const end = bytes.length - 22; const view = new DataView(bytes.buffer); const central = view.getUint32(end + 16, true);
  view.setUint32(central + 24, 5 * 1024 * 1024, true);
  await assert.rejects(core.readZip(bytes), /大きすぎ/);
});
test('unsupported compression gives a CSV fallback instead of running code', async () => {
  await assert.rejects(core.readZip(zip({ 'summary.csv': csv }, 99)), /圧縮方式/);
});
test('only PNG with bounded dimensions is accepted for saved figures', async () => {
  await assert.rejects(core.readZip(zip({ 'summary.csv': csv, 'figures/fake.png': '<svg onload="alert(1)"></svg>' })), /PNG/);
});
test('CSV alone is explicitly unknown provenance and multiple files replace the bundle', async () => {
  const file = (name, content) => ({ name, size: Buffer.byteLength(content), text: async () => content });
  const alone = await core.readFiles([file('summary.csv', csv)]);
  assert.equal(alone.metadata.source_kind, 'unknown');
  const together = await core.readFiles([file('summary.csv', csv), file('metadata.json', metadata)]);
  assert.equal(together.metadata.source_kind, 'synthetic');
  await assert.rejects(core.readFiles([file('summary.csv', csv), file('summary.csv', csv)]), /重複/);
  await assert.rejects(core.readFiles([file('metadata.json', metadata)]), /summary/);
});
test('HTML-like labels remain plain input strings, not a template operation', () => {
  const [row] = core.summaryRows([summary({ station: '<img src=x onerror=alert(1)>', model: '<script>1</script>' })]);
  assert.equal(row.station, '<img src=x onerror=alert(1)>');
  assert.equal(core.modelLabel(row.model), '<script>1</script>');
});
