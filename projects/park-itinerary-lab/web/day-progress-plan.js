import {isRepeatVisit,repeatVisitId} from './repeat-visits.js';

// A visitor's statement takes precedence over the timetable for that occurrence.
export function progressEntries(park, settings) {
  const data = settings.dayProgress;
  if (settings.replanFrom == null || settings.replanFrom === '' ||
      !data || data.parkId !== park.id || data.date !== settings.date) return [];
  if (!data.visits || typeof data.visits !== 'object' || Array.isArray(data.visits))
    throw new RangeError('当日の体験記録を確認してください。');
  return Object.entries(data.visits);
}

function recordRow(kind, start, end, name, extra) {
  return {kind, type:kind, start, end, duration:end-start, name, cost:0, dpa:false, preserved:true, ...extra};
}

const overlap = (a,b) => a.start < b.end && b.start < a.end;

// Keep unaffected original legs. Where a correction leaves a gap in an old
// route, record a location anchor instead of inventing a walk or travel time.
export function applyProgressToPrefix(park, settings, cutoff, original, previous) {
  const entries = progressEntries(park, settings);
  if (!entries.length && !original.some(item=>item.userProgress || item.progressAnchor)) return original;
  const reports = new Map(entries), activities = new Map(park.activities.map(a=>[a.id,a]));
  const declared = [], intervals = [], keepCompleted = new Set();
  let active = false;
  for (const [id, value] of entries) {
    const activity = activities.get(id);
    if (!activity || !value || !['pending','skipped','done','queue','riding'].includes(value.status))
      throw new RangeError('当日の体験記録の施設・状態を確認してください。');
    if (value.status === 'pending' || value.status === 'skipped') continue;
    const ongoing = value.status !== 'done';
    if (ongoing && active) throw new RangeError('進行中の施設は同時に1件までです。');
    active ||= ongoing;
    const prior = (previous?.rows || []).find(r => (r.kind || r.type)==='activity' && r.activityId===id);
    // Completion without a time still fulfils the wish. A made-up timestamp
    // would distort the timeline (especially if the second ride is in progress).
    if (!ongoing && value.endsAt == null && value.startedAt == null) {
      const second = !isRepeatVisit(id) && reports.get(repeatVisitId(id));
      const latest = second?.startedAt ?? second?.endsAt ?? cutoff;
      if (prior && prior.end<=Math.min(cutoff,latest)) keepCompleted.add(id);
      continue;
    }
    const end = value.endsAt ?? cutoff;
    const start = value.startedAt ?? (ongoing ? cutoff : end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < settings.entry || start > cutoff || end < start ||
        end > settings.exit || (!ongoing && end > cutoff))
      throw new RangeError(activity.name+'の開始・終了時刻と組み替え時刻を確認してください。');
    if (ongoing && end<=cutoff)
      throw new RangeError(activity.name+'の終了見込みを過ぎました。「体験済み」にするか、終了見込みを延ばしてください。');
    const selection = settings.selections?.find(s=>s.id===id);
    const confirmsPrior = !ongoing && prior?.end===end && (value.startedAt==null || value.startedAt===prior.start);
    const admission = prior?.dpa ? (prior.dpaAdmission ?? previous.rows.find(r=>r.kind==='queue' && r.activityId===id)?.start ??
      previous.visits?.find(v=>v.id===id)?.queueStart ?? prior.start) : null;
    // A corrected completion before the original scan cannot have consumed it.
    const incompatibleScan = admission!=null && (admission>=end || (value.status==='queue' && admission<start));
    const accounted = prior && !incompatibleScan && (prior.userProgress || confirmsPrior) ? prior : null;
    const node = accounted?.dpa ? accounted.node : activity.node;
    const details = {activityId:id, node, userProgress:value.status};
    const rideStart = value.status==='queue' ? Math.max(cutoff, end - (selection?.duration ?? activity.duration ?? 10)) : start;
    if (start<rideStart)
      declared.push(recordRow('queue',start,rideStart,activity.name+'の待ち列',details));
    // Keep already accounted charges on a recorded visit. A posted estimate
    // cannot establish a purchase or a payment for an off-itinerary ride.
    const paid = accounted ?
      {cost:accounted.cost??0,dpaCost:accounted.dpaCost??0,dpa:!!accounted.dpa,...(accounted.plannedDpaPurchase?{plannedDpaPurchase:true}:{})} : {};
    if (accounted?.dpa) {
      // A completion marker may fall after the admission window. Keep the
      // entry that the ticket paid for, including across subsequent edits.
      paid.dpaAdmission=admission;
    }
    declared.push(recordRow('activity',rideStart,end,activity.name,{
      ...details, endNode:activity.endNode || node, category:activity.category, ...paid,
    }));
    intervals.push({start,end});
  }
  if (intervals.some((r,i)=>intervals.slice(i+1).some(s=>overlap(r,s))))
    throw new RangeError('入力した体験の時刻が重なっています。');

  const superseded = new Set([...reports.keys()].filter(id=>!keepCompleted.has(id)));
  // A corrected first visit invalidates any old timetable that places the
  // second one before the visitor could have finished the first.
  for (const [id, first] of entries) {
    if (isRepeatVisit(id)) continue;
    const secondId=repeatVisitId(id), second=reports.get(secondId);
    const confirmedSecond=second && ['done','queue','riding'].includes(second.status);
    const secondStart=second?.startedAt ?? second?.endsAt;
    if (confirmedSecond && (first.status!=='done' ||
        (Number.isInteger(first.endsAt) && Number.isInteger(secondStart) && secondStart<first.endsAt)))
      throw new RangeError('2回目の体験は1回目の体験終了後に記録してください。');
    if (first.status!=='done' || original.some(item=>item.activityId===secondId &&
        ['queue','activity'].includes(item.kind) && item.start<first.endsAt)) superseded.add(secondId);
  }
  for (const item of original) {
    if (item.activityId && ['queue','activity'].includes(item.kind) && intervals.some(f=>overlap(f,item)))
      superseded.add(item.activityId);
  }
  let lastOriginalVisit;
  const kept = original.filter(item=>{
    if(item.kind==='activity') lastOriginalVisit=item.activityId;
    // An early return to the exit attached to a visit that never happened
    // is no longer part of this visitor's route.
    if(item.kind==='walk' && !item.activityId && item.to===park.exitNode && superseded.has(lastOriginalVisit)) return false;
    return (!item.userProgress || keepCompleted.has(item.activityId)) && !item.progressAnchor && item.kind!=='location' &&
      !superseded.has(item.activityId) && !intervals.some(f=>overlap(f,item));
  });
  const timeline = [...kept,...declared].sort((a,b)=>a.start-b.start || a.end-b.end ||
    (a.userProgress && b.userProgress ? a.activityId.localeCompare(b.activityId) : 0));
  let node = park.entryNode;
  const rows=[];
  for (const item of timeline) {
    const from = item.kind==='walk' ? item.from : item.node;
    if (from && node!==from) {
      rows.push(recordRow('location',item.start,item.start,'しおりの地点を確認',{node:from,progressAnchor:true}));
      node=from;
    }
    rows.push(item);
    node=item.endNode || item.to || item.node || node;
  }
  return rows;
}
