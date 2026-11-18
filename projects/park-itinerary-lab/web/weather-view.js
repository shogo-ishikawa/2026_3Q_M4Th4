import {forecastDateInRange, usableWeatherForecast, weatherRowInterval} from './weather.js?v=1.16.1';

/** Compact forecast cards. Original periods and provenance remain in the details. */
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const sourceName = info => ({'jma':'気象庁','open-meteo':'Open-Meteo'}[info.provider] || info.provider || '出典未提供');

const conditionNames = {sun:'晴れ', cloud:'くもり', rain:'雨'};
function conditionOf(row) {
  if (typeof row.label === 'string' && row.label.trim()) return row.label.trim().replace(/\s+/g, ' ');
  return row.weather === 'rain' ? '雨・雪' : conditionNames[row.weather];
}

function forecastTemperatures(rows, provider, entry, exit) {
  if (provider === 'jma') {
    // These extrema describe the day at the JMA station, including hours outside the visit.
    const {temperatureMin, temperatureMax} = rows[0];
    const extrema = [Number.isFinite(temperatureMin) && `日最低${temperatureMin}℃`,
      Number.isFinite(temperatureMax) && `日最高${temperatureMax}℃`].filter(Boolean);
    if (extrema.length) return extrema.join(' / ');
  }
  const points = new Map();
  for (const row of rows) {
    const at = provider === 'jma' ? row.temperatureAtMinute : row.minute;
    if (Number.isInteger(at) && at >= entry && at < exit && Number.isFinite(row.temperature)) points.set(at, row.temperature);
  }
  if (!points.size) return '';
  if (points.size === 1) {
    const [[at, value]] = points;
    return `${clock(at)} ${value}℃`;
  }
  const low = Math.min(...points.values()), high = Math.max(...points.values());
  return `予報気温 ${low === high ? low : low + '〜' + high}℃`;
}

/** Summarise the forecast already used by the visit outlook, in Japan time. */
export function visitWeatherSummary(settings, {pending = false, now = Date.now()} = {}) {
  const {date, entry, exit, weatherForecast:forecast} = settings;
  const manual = conditionNames[settings.weather];
  if (settings.weatherMode === 'manual') return {label:manual || '未設定', detail:'手動設定'};
  const fallback = manual ? `計画は${manual}で仮定` : '';
  if (!forecastDateInRange(date, now)) return {label:'予報の対象外', detail:fallback};
  if (pending) return {label:'確認中…', detail:''};
  if (!usableWeatherForecast(forecast, date, now)) return {label:'予報未取得', detail:fallback};

  let coveredTo = entry, gap = false;
  const rows = [], changes = [];
  for (const row of [...forecast.hours].sort((a,b) => a.minute - b.minute)) {
    const interval = weatherRowInterval(row, date, entry, exit);
    if (!interval) continue;
    const {start, end} = interval;
    if (start > coveredTo) gap = true;
    coveredTo = Math.max(coveredTo, end);
    rows.push(row);
    const label = conditionOf(row);
    if (label !== changes.at(-1)?.label) changes.push({label, start});
  }
  if (!rows.length) return {label:'滞在中の予報なし', detail:fallback};
  const partial = gap || coveredTo < exit;
  // A daily JMA bulletin can cover the same hours as a more detailed product.
  // Do not present repeated copies of the bulletin as hourly weather changes.
  const daily = forecast.provider === 'jma' && rows.find(row => row.weatherPeriodLabel?.includes('日予報'));
  const sequence = changes.map(change => change.label);
  let label = [...new Set(sequence)].join('・');
  if (daily) label = conditionOf(daily);
  else if (!partial && sequence.length <= 3) label = sequence.join('のち');
  const detail = [];
  if (daily) detail.push('日予報');
  if (partial) detail.push('一部時間帯のみ');
  if (!daily && !partial && changes.length === 2) detail.push(`${clock(changes[1].start)}から${changes[1].label}`);
  const temperatures = forecastTemperatures(rows, forecast.provider, entry, exit);
  if (temperatures) detail.push(temperatures);
  if (forecast.stale) detail.push('前回取得の予報');
  return {label, detail:detail.join(' · ')};
}

export function compactPeriod(label) {
  if (!label || label === '未提供') return '';
  const text = String(label), range = text.match(/(\d{2}:\d{2})\s*[〜～–—-]\s*(\d{2}:\d{2})/);
  if (range) return `${range[1]}–${range[2]}`;
  if (/日最低|日最高/.test(text)) return '日最低–最高';
  if (/日予報/.test(text)) return '日予報';
  const instant = text.match(/(\d{2}:\d{2})/);
  if (instant) return `${instant[1]}時点`;
  return text.replace(/^[^・]*・/, '').replace(/（[^）]*）$/, '');
}

function cardPeriod(info) {
  // JMA's hourly lookup rows repeat a 3-hour or daily product. Its display must
  // retain that product's scope rather than inventing an hourly forecast.
  if (info.provider === 'jma') return compactPeriod(info.weatherPeriodLabel) || '対象時間未提供';
  const rain = compactPeriod(info.precipitationPeriodLabel), chance = compactPeriod(info.probabilityPeriodLabel);
  if (rain && rain === chance && /\d{2}:\d{2}–\d{2}:\d{2}/.test(rain)) return rain;
  if (Number.isInteger(info.minute)) return `${clock(info.minute)}–${clock(info.endMinute ?? info.minute + 60)}`;
  return compactPeriod(info.weatherPeriodLabel) || '対象時間未提供';
}

function temperatureValue(info) {
  if (Number.isFinite(info.temperature)) return `${info.temperature}℃`;
  if (Number.isFinite(info.temperatureMin) && Number.isFinite(info.temperatureMax)) return `${info.temperatureMin}–${info.temperatureMax}℃`;
  if (Number.isFinite(info.temperatureMax)) return `最高${info.temperatureMax}℃`;
  if (Number.isFinite(info.temperatureMin)) return `最低${info.temperatureMin}℃`;
  return '—';
}

function weatherIcon(info) {
  if (/雪/.test(info.label || '') && !/雨/.test(info.label || '')) return '❄️';
  if (/雷/.test(info.label || '')) return '⛈️';
  return ({sun:'☀️',cloud:'☁️',rain:'🌧️'}[info.weather] || '🌡️');
}

/** This function only presents a row; it never changes stored forecast values. */
export function forecastCardHtml(info, {missingLabel = '天気 予報未取得'} = {}) {
  if (!info) return `<div class="forecast-card forecast-missing">${escape(missingLabel)}</div>`;
  const period = cardPeriod(info), label = info.label || ({sun:'晴れ',cloud:'曇り',rain:'雨'}[info.weather]) || '天気未提供';
  const temperature = temperatureValue(info), temperaturePeriod = compactPeriod(info.temperaturePeriodLabel);
  const metric = (value, unit, name, rawPeriod) => {
    const known = Number.isFinite(value), scope = compactPeriod(rawPeriod);
    return `<span class="forecast-value${known ? '' : ' forecast-missing'}" aria-label="${escape(`${name} ${known ? value + unit : '未提供'}${known && scope ? ' ' + scope : ''}`)}"><span class="forecast-metric-label">${escape(name)}</span><strong>${known ? escape(value + unit) : '—'}</strong>${known && scope && scope !== period ? `<small class="forecast-period">${escape(scope)}</small>` : ''}</span>`;
  };
  const rangeLabel = !Number.isFinite(info.temperature) && temperature !== '—' ? `<small class="forecast-period">${escape(temperaturePeriod || '最低–最高')}</small>` : '';
  return `<div class="forecast-card" role="group" aria-label="${escape(`天気予報 ${label} ${period}`)}"><div class="forecast-main"><span class="forecast-icon" role="img" aria-label="${escape(label)}">${weatherIcon(info)}</span><span class="forecast-temperature" title="${escape(info.temperaturePeriodLabel || '気温の対象時間未提供')}">${escape(temperature)}${rangeLabel}</span><span class="forecast-period">${escape(period)}</span></div><div class="forecast-rain">${metric(info.precipitationProbability, '%', '降水確率', info.probabilityPeriodLabel)}${metric(info.precipitation, 'mm', '降水量', info.precipitationPeriodLabel)}</div></div>`;
}

function sourceLink(info) {
  try {
    const url = new URL(info.sourceUrl);
    if (['https:', 'http:'].includes(url.protocol)) return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(sourceName(info))} ↗</a>`;
  } catch { /* Imported plans can lack a source URL. */ }
  return escape(sourceName(info));
}

/** Folded source details for the bottom of a screen or an offline itinerary. */
export function forecastSourcesHtml(infos = [], {snapshot = false} = {}) {
  const records = (Array.isArray(infos) ? infos : [infos]).filter(Boolean), groups = new Map();
  for (const info of records) {
    const key = JSON.stringify([info.provider, info.sourceUrl, info.issuedAt, info.fetchedAt]);
    if (!groups.has(key)) groups.set(key, {info, periods:new Map()});
    const periods = [info.label, info.weatherPeriodLabel, info.temperaturePeriodLabel, info.probabilityPeriodLabel, info.precipitationPeriodLabel];
    groups.get(key).periods.set(JSON.stringify(periods), periods);
  }
  if (!groups.size) return '';
  const parts = [...groups.values()].map(({info, periods}) => {
    const fetched = Date.parse(info.fetchedAt), age = Number.isFinite(fetched) ? Math.max(0, Math.floor((Date.now() - fetched) / 60000)) : null;
    const rows = [...periods.values()].map(values => `<tr>${values.map(value => `<td>${escape(value || '未提供')}</td>`).join('')}</tr>`).join('');
    return `<section class="forecast-source"><h4>${sourceLink(info)}</h4><p>発表 ${escape(info.issuedAt || '未提供')} · 取得 ${escape(info.fetchedAt || '未提供')}${age !== null ? ` · ${snapshot ? '保存' : '表示'}時点で取得から ${age}分` : ''}</p><div class="table-wrap"><table><thead><tr><th>天気</th><th>天気の対象時間</th><th>気温の対象時間</th><th>降水確率の対象時間</th><th>降水量の対象時間</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join('');
  return `<details class="forecast-sources"><summary>天気予報の情報源と詳細</summary>${parts}</details>`;
}
