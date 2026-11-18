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

function secondWish(first) {
  // Reapply the user's time, duration, budget and queue settings to the new wish.
  // A DPA or an individual entry confirmation belongs to the original visit.
  const wish = {...first, id:repeatVisitId(first.id), dpaMode:'none', confirmedAccess:false, confirmAccess:false};
  for (const key of ['repeatCount', 'dpaStart', 'dpaEnd', 'dpaPurchasedAt', 'dpaAvailableWindows', 'dpaWindowLinked', 'nodeOverride', 'viewingNode']) delete wish[key];
  return wish;
}

/** Expand editor wishes for search and independent validation without modifying the saved plan or catalogue. */
export function expandRepeatVisits(park, settings, previous) {
  if (!Array.isArray(park?.activities) || !Array.isArray(settings?.selections)) return {park, settings};
  const original = settings.selections;
  const firstWishes = original.filter(wish => !isRepeatVisit(wish?.id));
  const requested = new Set();
  for (const wish of firstWishes) {
    if (wish?.repeatCount === undefined || wish.repeatCount === 1) continue;
    if (wish.repeatCount !== 2) throw new RangeError('アトラクションの体験回数は1回か2回を選んでください。');
    requested.add(wish.id);
  }
  const alreadyExpanded = new Set();
  for (const wish of original) {
    if (!isRepeatVisit(wish?.id)) continue;
    if (!requested.has(baseVisitId(wish.id)) || alreadyExpanded.has(wish.id) || wish.dpaMode !== 'none')
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
  const extraWishes = firstWishes.filter(wish => requested.has(wish?.id) && !alreadyExpanded.has(repeatVisitId(wish.id))).map(secondWish);
  return {
    park: additional.length ? {...park, activities:park.activities.concat(additional)} : park,
    settings: extraWishes.length ? {...settings, selections:original.concat(extraWishes)} : settings,
  };
}
