/** Compare a separately searched delay scenario without changing the original plan. */
export function contingencySettings(settings, extraMinutes) {
  if (!Number.isInteger(extraMinutes) || extraMinutes < 1 || extraMinutes > 60) throw new RangeError('追加する待ち時間は1〜60分で指定してください。');
  const delay = Number(settings.queueDelayMinutes || 0) + extraMinutes;
  if (delay > 60) throw new RangeError('追加の混雑の想定は合計60分以内にしてください。');
  return {...settings, queueDelayMinutes:delay};
}

export function compareContingency(original, alternative) {
  const previous = new Set((original.visits || []).map(visit => visit.activityId || visit.id));
  const next = new Set((alternative.visits || []).map(visit => visit.activityId || visit.id));
  return {
    feasible:alternative.status === 'feasible',
    removed:(original.visits || []).filter(visit => !next.has(visit.activityId || visit.id)).map(visit => visit.name),
    added:(alternative.visits || []).filter(visit => !previous.has(visit.activityId || visit.id)).map(visit => visit.name),
    previousCount:original.coverage?.count ?? previous.size,
    nextCount:alternative.coverage?.count ?? next.size,
    previousFinish:original.totals?.finish,
    nextFinish:alternative.totals?.finish,
  };
}
