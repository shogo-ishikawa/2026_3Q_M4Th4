/** 実験条件と、円管の式を比較するためのReを保存する。 */
export const SCHEMA_VERSION = '1.0.0';
export const MAX_JSON_CHARACTERS = 16384;
const KIND = 'reynolds-flow-experiment';
const settingNames = ['re','mode','quality','alpha','lesson','view','speed','trails','dye','guides'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, names, label) {
  if (!object(value) || Object.keys(value).length !== names.length
      || names.some(name => !Object.hasOwn(value,name))
      || Object.keys(value).some(name => !names.includes(name))) {
    throw new TypeError(`${label}の形式を確認してください。`);
  }
}
function oneOf(value, choices, label) {
  if (!choices.includes(value)) throw new RangeError(`${label}の値を確認してください。`);
  return value;
}
function reynolds(value) {
  if (!Number.isInteger(value) || value < 100 || value > 100000)
    throw new RangeError('Reは100から100000の整数で指定してください。');
  return value;
}

export function normaliseSettings(value) {
  exactKeys(value,settingNames,'実験条件');
  const settings = {
    re: reynolds(value.re),
    mode: oneOf(value.mode,['laminar','sph','teaching'],'計算方法'),
    quality: oneOf(value.quality,['low','standard','high','ultra'],'計算の細かさ'),
    alpha: oneOf(value.alpha,[0,0.01,0.035,0.1],'人工粘性'),
    lesson: oneOf(value.lesson,[0,1,2,3],'実験の番号'),
    view: oneOf(value.view,['slice','volume'],'流れの見せ方'),
    speed: oneOf(value.speed,[0.25,0.5,1,2,4,8],'再生速度'),
  };
  for (const name of ['trails','dye','guides']) {
    if (typeof value[name] !== 'boolean') throw new TypeError('表示の設定はオン・オフで指定してください。');
    settings[name] = value[name];
  }
  if (settings.mode === 'laminar' && settings.re >= 2300)
    throw new RangeError('軸対称SPHの層流計算にはRe 2300未満を指定してください。');
  const guided = {1:[500,'laminar'],2:[1000,'laminar'],3:[20000,'teaching']}[settings.lesson];
  if (guided && (settings.re !== guided[0] || settings.mode !== guided[1]))
    throw new RangeError('実験の番号とRe・計算方法の組み合わせを確認してください。');
  return settings;
}

export function normaliseRecords(values) {
  if (!Array.isArray(values) || values.length > 6)
    throw new RangeError('比較するReは6条件までにしてください。');
  const records = values.map(reynolds);
  if (new Set(records).size !== records.length) throw new RangeError('比較するReを重複させないでください。');
  return records;
}

export function exportExperiment(settings,records) {
  return JSON.stringify({kind:KIND,schemaVersion:SCHEMA_VERSION,
    settings:normaliseSettings(settings),records:normaliseRecords(records)},null,2);
}

export function readExperiment(text) {
  if (typeof text !== 'string' || text.length > MAX_JSON_CHARACTERS)
    throw new RangeError('このアプリで保存した小さな実験JSONを選んでください。');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/,'')); }
  catch (_) { throw new SyntaxError('JSONを読み取れませんでした。保存した実験ファイルを選んでください。'); }
  if (!object(data) || data.kind !== KIND || data.schemaVersion !== SCHEMA_VERSION)
    throw new TypeError('この版で読み込める実験JSONを選んでください。');
  exactKeys(data,['kind','schemaVersion','settings','records'],'実験JSON');
  return {settings:normaliseSettings(data.settings),records:normaliseRecords(data.records)};
}
