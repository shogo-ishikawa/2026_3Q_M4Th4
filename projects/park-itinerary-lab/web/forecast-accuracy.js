// A scored sample is one facility and one completed half-hour, in Japan time.
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const SLOT = 30;
const crowdAnchors = new Set([630, 750, 870, 990, 1110]);

function validWait(value) {
  return Number.isFinite(value) && value >= 0 && value <= 600;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function emptyMetrics() {
  return {expected:0, matched:0, samples:0, coverage:null, mae:null, bias:null, within10:null, meanPredicted:null, meanObserved:null,
    baselineMatched:0, comparableMae:null, baselineMae:null};
}

function measure(slots) {
  const result = emptyMetrics();
  result.expected = slots.length;
  let absolute = 0, signed = 0, within = 0, comparable = 0, baseline = 0;
  let predicted = 0, observed = 0;
  for (const slot of slots) {
    if (slot.observed === null) continue;
    const error = slot.wait - slot.observed;
    absolute += Math.abs(error);
    signed += error;
    predicted += slot.wait;
    observed += slot.observed;
    if (Math.abs(error) <= 10) within++;
    result.matched++;
    result.samples += slot.posts.size;
    if (slot.reference !== null) {
      result.baselineMatched++;
      comparable += Math.abs(error);
      baseline += Math.abs(slot.reference - slot.observed);
    }
  }
  if (result.expected) result.coverage = result.matched / result.expected;
  if (result.matched) {
    result.mae = absolute / result.matched;
    result.bias = signed / result.matched;
    result.meanPredicted = predicted / result.matched;
    result.meanObserved = observed / result.matched;
    result.within10 = within / result.matched;
  }
  if (result.baselineMatched) {
    result.comparableMae = comparable / result.baselineMatched;
    result.baselineMae = baseline / result.baselineMatched;
  }
  return result;
}

function classifyCrowd(estimate, slots) {
  const result = {
    forecastLevel:['quiet', 'normal', 'busy'].includes(estimate?.level) ? estimate.level : null,
    observedLevel:null, ratio:null, facilities:0, slots:0, expected:0, matched:0
  };
  const rides = new Map();
  for (const slot of slots) {
    if (slot.reference === null) continue;
    result.expected++;
    if (slot.observed === null) continue;
    result.matched++;
    if (!rides.has(slot.activityId)) rides.set(slot.activityId, []);
    rides.get(slot.activityId).push(slot);
  }

  // Apply the same minimum support and weighting as estimateParkCrowd.
  const ratios = [], hours = new Set();
  for (const matches of rides.values()) {
    if (matches.length < 2) continue;
    let observed = 0, usual = 0;
    for (const match of matches) {
      observed += match.observed;
      usual += match.reference;
      hours.add(match.minute);
    }
    ratios.push(observed / usual);
    result.slots += matches.length;
  }
  result.facilities = ratios.length;
  if (ratios.length < 3 || hours.size < 3) return result;
  result.ratio = median(ratios);
  result.observedLevel = result.ratio <= 0.85 ? 'quiet' : result.ratio >= 1.15 ? 'busy' : 'normal';
  return result;
}

function parseTimestamp(value) {
  // Reject date-only and timezone-less inputs: on a remote device these could
  // otherwise accept reports from a later slot or from another business day.
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN;
  return Date.parse(value);
}

function collectPosts(rows, date, midnight, asOf, slots, source) {
  const primaryBuckets = new Set();
  const backups = new Map();
  for (const row of rows) {
    if (row?.date !== date || row.source !== source || !validWait(row.wait) ||
        row.isOpen === false || !Number.isInteger(row.time) || row.time < 0 || row.time >= 1440) continue;
    const observedAt = parseTimestamp(row.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > asOf ||
        Math.floor((observedAt - midnight) / MINUTE) !== row.time) continue;
    const start = Math.floor(row.time / SLOT) * SLOT;
    const slot = slots.get(row.activityId + '|' + start);
    if (!slot || row.time >= slot.end) continue;
    if (source === 'queue-times') {
      // An archive can still contain a backup after recent observations gained a primary reading.
      const sinceOpening = row.time - row.openingMinute;
      const width = Number.isInteger(row.openingMinute) && sinceOpening >= 0 && sinceOpening < 90 ? 10 : SLOT;
      const key = row.activityId + '|' + Math.floor(row.time / width) * width;
      if (row.collector === 'watchdog') {
        const prior = backups.get(key);
        if (!prior || observedAt > prior.observedAt) backups.set(key, {slot, observedAt, wait:row.wait});
        continue;
      }
      primaryBuckets.add(key);
    }
    slot.posts.set(observedAt, row.wait);
  }
  for (const [key, {slot, observedAt, wait}] of backups) {
    if (!primaryBuckets.has(key) && !slot.posts.has(observedAt)) slot.posts.set(observedAt, wait);
  }
}

/**
 * Compare an immutable, published park-day forecast with posted waits.
 * Supply public monthly and/or recent Queue-Times rows. Repeated timestamps
 * count once. One bin's median makes denser sampling near opening comparable
 * with the rest of the day. Coverage and within10 are fractions, bias is
 * forecast minus observed in minutes. Empty metrics are null.
 */
export function scoreForecastAccuracy({date, parkId, forecast, observations = [], asOf = Date.now(), source = 'queue-times'}) {
  const midnight = Date.parse(date + 'T00:00:00+09:00');
  const now = typeof asOf === 'string' ? parseTimestamp(asOf) : Number(asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) ||
      new Date(midnight + DAY / 2).toISOString().slice(0, 10) !== date ||
      !Number.isFinite(now) || !['land', 'sea'].includes(parkId) || !['queue-times', 'themeparks-wiki'].includes(source)) {
    throw new RangeError('日付とパークを確認してください。');
  }
  const result = {date, parkId, status:'no-forecast', issuedAt:null, slotsInDay:0,
    overall:emptyMetrics(), facilities:[], hours:[], crowd:classifyCrowd(null, [])};
  if (now < midnight) return {...result, status:'future'};
  const park = Array.isArray(forecast?.parks) && forecast.parks.find(item => item?.parkId === parkId);
  if (forecast?.schemaVersion !== 1 || forecast.date !== date || forecast.slotMinutes !== SLOT ||
      !park || !Array.isArray(park.rows)) return result;
  const issued = parseTimestamp(park.issuedAt);
  if (!Number.isFinite(issued) || issued > now) return result;

  const slots = new Map();
  for (const row of park.rows) {
    if (typeof row?.activityId !== 'string' || !row.activityId.startsWith(parkId + '-') ||
        !validWait(row.wait) || !Number.isInteger(row.minute) || row.minute < 0 ||
        row.minute >= 1440 || row.minute % SLOT !== 0) continue;
    const end = row.endMinute ?? row.minute + SLOT;
    if (!Number.isInteger(end) || end <= row.minute || end > row.minute + SLOT ||
        issued >= midnight + row.minute * MINUTE) continue;
    const key = row.activityId + '|' + row.minute;
    if (slots.has(key)) continue;
    const reference = crowdAnchors.has(row.minute) && validWait(row.reference) && row.reference >= 10 ?
      row.reference : null;
    slots.set(key, {activityId:row.activityId, minute:row.minute, end, wait:row.wait, reference,
      posts:new Map(), observed:null});
  }
  if (!slots.size) return result;
  result.issuedAt = park.issuedAt;
  result.slotsInDay = slots.size;
  const elapsed = [...slots.values()].filter(slot => midnight + slot.end * MINUTE <= now);
  collectPosts(Array.isArray(observations) ? observations : [], date, midnight, now, slots, source);
  const byActivity = new Map(), byHour = new Map();
  for (const slot of elapsed) {
    if (source === 'themeparks-wiki' && slot.posts.size) {
      // Change events have a different sampling pattern from periodic observations.
      const lastChange = Math.max(...slot.posts.keys());
      slot.observed = slot.posts.get(lastChange);
    } else {
      slot.observed = median([...slot.posts.values()]);
    }
    if (!byActivity.has(slot.activityId)) byActivity.set(slot.activityId, []);
    byActivity.get(slot.activityId).push(slot);
    const hour = Math.floor(slot.minute / 60);
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(slot);
  }
  result.overall = measure(elapsed);
  result.facilities = [...byActivity].map(([activityId, values]) => {
    const name = park.activities?.[activityId];
    return {activityId, name:typeof name === 'string' ? name : activityId, ...measure(values)};
  });
  result.hours = [...byHour].sort(([a], [b]) => a - b).map(([hour, values]) => ({hour, ...measure(values)}));
  result.crowd = classifyCrowd(park.crowd, elapsed);
  if (!elapsed.length) result.status = 'pending';
  else if (!result.overall.matched) result.status = 'no-observations';
  else result.status = elapsed.length < slots.size ? 'partial' : 'complete';
  return result;
}
