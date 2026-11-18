/** A second ride has its own place in the itinerary and shares the facility's live data. */
const SECOND_VISIT = '~2';

export const isRepeatVisit = id => typeof id === 'string' && id.endsWith(SECOND_VISIT);
export const baseVisitId = id => isRepeatVisit(id) ? id.slice(0, -SECOND_VISIT.length) : id;
export const repeatVisitId = id => baseVisitId(id) + SECOND_VISIT;

export function canStartVisit(id, visited) {
  return !isRepeatVisit(id) || visited.has(baseVisitId(id));
}

export function facilityForVisit(activity) {
  return isRepeatVisit(activity?.id) ? {...activity, id:baseVisitId(activity.id)} : activity;
}

const dpaFields = ['dpaMode', 'dpaStart', 'dpaEnd', 'dpaPurchasedAt', 'dpaAvailableWindows', 'dpaWindowLinked', 'nodeOverride', 'viewingNode'];
const usesDpa = wish => wish?.dpaMode === 'owned' || wish?.dpaMode === 'consider';
const minute = value => Number.isInteger(value) ? value :
  typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0,2))*60 + Number(value.slice(3)) : null;

/** Keep one confirmed ticket with its actual admission. A reported early ride can leave it for the repeat. */
export function resolveDpaVisit(wish, settings, previous) {
  if (wish?.repeatCount !== 2 || !usesDpa(wish)) return 1;
  const chosen = wish.dpaVisit === 2 ? 2 : 1;
  const cutoff = minute(settings?.replanFrom), start = minute(wish.dpaStart), end = minute(wish.dpaEnd);
  if (wish.dpaMode !== 'owned' || cutoff === null || start === null || end === null) return chosen;
  const progress = settings.dayProgress;
  const parkId = /^(land|sea)-/.exec(wish.id)?.[1] ?? previous?.parkId ?? progress?.parkId;
  const records = progress?.date === settings.date && progress.parkId === parkId ? progress.visits : {};
  const first = records?.[wish.id];
  const firstEnd = minute(first?.endsAt ?? first?.reportedAt) ?? cutoff;
  // A visitor in a later replan may still hold the same unused ticket after the window opens.
  const knownFinished = first?.status === 'done' || (!first && settings.completedIds?.includes(wish.id));
  if (knownFinished && firstEnd <= start && cutoff < end) return 2;
  if (previous?.settings?.date !== settings.date || previous.parkId !== parkId) return chosen;
  const ticket = previous.purchases?.find(p => p.id === wish.id && p.owned && p.start === start && p.end === end);
  if (!ticket) return chosen;
  for (const visit of previous.visits || []) {
    const id = visit.activityId || visit.id;
    if (baseVisitId(id) !== wish.id || visit.method !== 'dpa' || visit.queueStart >= cutoff ||
        visit.queueStart < start || visit.queueStart >= end) continue;
    const record = records?.[id];
    if (record?.status === 'pending' || record?.status === 'skipped' ||
        (record?.status === 'done' && minute(record.endsAt ?? record.reportedAt) !== null &&
         minute(record.endsAt ?? record.reportedAt) <= visit.queueStart)) continue;
    return isRepeatVisit(id) ? 2 : 1;
  }
  return chosen;
}

function withoutDpa(wish) {
  const standby = {...wish};
  for (const key of dpaFields) delete standby[key];
  standby.dpaMode = 'none';
  return standby;
}

/** Fold occurrence-specific normalised solver fields into the single editable wish. */
export function compactRepeatSelections(normalised, original) {
  const raw = new Map(original.map(wish => [wish.id, wish]));
  const occurrences = new Map(normalised.map(wish => [wish.id, wish]));
  return normalised.filter(wish => !isRepeatVisit(wish.id)).map(first => {
    if (first.repeatCount !== 2) return first;
    const second = occurrences.get(repeatVisitId(first.id));
    const owner = usesDpa(second) ? second : first;
    if (!usesDpa(owner)) return first;
    const compact = {...first, required:!!raw.get(first.id)?.required};
    for (const key of dpaFields) {
      if (Object.hasOwn(owner,key)) compact[key] = owner[key];
      else delete compact[key];
    }
    if (owner === second || first.dpaVisit !== undefined) compact.dpaVisit = owner === second ? 2 : 1;
    return compact;
  });
}

/** Expand editor wishes for search and independent validation without modifying the saved plan or catalogue. */
export function expandRepeatVisits(park, settings, previous) {
  if (!Array.isArray(park?.activities) || !Array.isArray(settings?.selections)) return {park, settings};
  const original = settings.selections;
  const firstWishes = original.filter(wish => !isRepeatVisit(wish?.id));
  const requested = new Set();
  for (const wish of firstWishes) {
    if (wish?.dpaVisit !== undefined && (wish.dpaVisit !== 1 && wish.dpaVisit !== 2 ||
        wish.dpaVisit === 2 && wish.repeatCount !== 2)) throw new RangeError('DPAを使う体験回を確認してください。');
    if (wish?.repeatCount === undefined || wish.repeatCount === 1) continue;
    if (wish.repeatCount !== 2) throw new RangeError('アトラクションの体験回数は1回か2回を選んでください。');
    requested.add(wish.id);
  }
  const alreadyExpanded = new Set();
  const originalsById = new Map(firstWishes.map(wish => [wish?.id, wish]));
  for (const wish of original) {
    if (!isRepeatVisit(wish?.id)) continue;
    const first = originalsById.get(baseVisitId(wish.id));
    if (!requested.has(baseVisitId(wish.id)) || alreadyExpanded.has(wish.id) ||
        (usesDpa(wish) && (first.dpaVisit !== 2 || usesDpa(first))))
      throw new RangeError('2回目のアトラクションの希望を確認してください。');
    alreadyExpanded.add(wish.id);
  }

  const requiredFacilities = new Set(requested);
  // A previous visit can remain in today's timeline even after removing the corresponding wish.
  const remember = id => { if (isRepeatVisit(id)) requiredFacilities.add(baseVisitId(id)); };
  if (previous?.settings?.date === settings.date && previous.parkId === park.id) {
    for (const row of previous.rows || []) remember(row.activityId);
  }
  for (const id of settings.completedIds || []) remember(id);
  const progress = settings.dayProgress;
  if (progress && progress.date === settings.date && progress.parkId === park.id) {
    for (const id of Object.keys(progress.visits || {})) remember(id);
  }
  if (!requiredFacilities.size) return {park, settings};

  const activities = new Map(park.activities.map(activity => [activity.id, activity]));
  const additional = [];
  for (const id of requiredFacilities) {
    const facility = activities.get(id);
    if (facility?.category !== 'attraction') throw new RangeError('2回目の体験はアトラクションを選んでください。');
    if (!activities.has(repeatVisitId(id))) additional.push({...facility, id:repeatVisitId(id), name:facility.name + '（2回目）'});
  }
  const extraWishes = [], replacements = new Map();
  for (const first of firstWishes) {
    if (!requested.has(first?.id) || alreadyExpanded.has(repeatVisitId(first.id))) continue;
    const useSecond = resolveDpaVisit(first, settings, previous) === 2;
    const second = {...(useSecond ? first : withoutDpa(first)), id:repeatVisitId(first.id), confirmedAccess:false, confirmAccess:false};
    delete second.repeatCount;
    delete second.dpaVisit;
    extraWishes.push(second);
    if (useSecond) replacements.set(first.id, {...withoutDpa(first), dpaVisit:2});
  }
  return {
    park: additional.length ? {...park, activities:park.activities.concat(additional)} : park,
    settings: extraWishes.length ? {...settings, selections:original.map(wish => replacements.get(wish.id) ?? wish).concat(extraWishes)} : settings,
  };
}
