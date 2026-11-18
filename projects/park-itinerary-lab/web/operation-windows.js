/** Dated interruptions are separate from a facility's full-day opening hours. */
import {baseVisitId} from './repeat-visits.js';
export const GONDOLA_ID='sea-attraction-230';
// Official programme durations. No extra preparation/reopening buffer is inferred.
const HARBOUR_SHOWS=new Map([
  ['sea-show-7404',{duration:15,url:'https://www.tokyodisneyresort.jp/tds/show/detail/7404/'}],
  ['sea-show-953',{duration:15,url:'https://www.tokyodisneyresort.jp/tds/show/detail/953/'}],
  ['sea-show-967',{duration:30,url:'https://www.tokyodisneyresort.jp/tds/show/detail/967/'}],
]);
const minute=value=>{
  if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=1440)return value;
  if(typeof value==='string'&&/^\d{2}:\d{2}$/.test(value)){
    const [h,m]=value.split(':').map(Number);if(h<=23&&m<=59)return h*60+m;
  }
  throw new RangeError('休止する時間帯を確認してください。');
};
export function normalisePauseWindows(values=[]) {
  if(!Array.isArray(values)||values.length>50)throw new RangeError('休止時間は50枠以内で指定してください。');
  return values.map(pair=>{
    if(!Array.isArray(pair)||pair.length!==2)throw new RangeError('休止の開始と終了を指定してください。');
    const result=pair.map(minute);if(result[0]>=result[1])throw new RangeError('休止の終了は開始より後にしてください。');return result;
  });
}
function mergeWindows(windows) {
  const merged=[];
  for(const [start,end] of windows.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1])){
    const last=merged.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);
  }return merged;
}
export function activityAvailable(activity,date) {
  return activity.closed!==true&&activity.dailySchedules?.[date]?.closed!==true&&
    !(activity.closedDates||[]).includes(date)&&
    !(activity.closedPeriods||[]).some(period=>period.startDate<=date&&(!period.endDate||date<=period.endDate))&&
    (!activity.startDate||activity.startDate<=date)&&(!activity.endDate||date<=activity.endDate);
}
export function operationPauseInfo(park,activity,selection={},settings={}) {
  const items=[];
  for(const window of normalisePauseWindows(activity.dailySchedules?.[settings.date]?.pauseWindows||[]))items.push({window,kind:'dated-operation',label:'日付付きの休止時間',sourceUrl:activity.dailySchedules?.[settings.date]?.sourceUrl||activity.dailyScheduleSourceUrl||activity.sourceUrl});
  for(const window of normalisePauseWindows(selection.pauseWindows||[]))items.push({window,kind:'user-confirmed',label:'指定した休止時間'});
  if(baseVisitId(activity.id)===GONDOLA_ID&&settings.gondolaAvoidHarbourShows!==false){
    for(const show of park?.activities||[]){
      const programme=HARBOUR_SHOWS.get(show.id);if(!programme||!activityAvailable(show,settings.date))continue;
      const chosen=(settings.selections||[]).find(item=>item.id===show.id);
      const daily=show.dailySchedules?.[settings.date];
      const starts=chosen?.confirmSchedule===true&&chosen.showTimes?.length?chosen.showTimes:
        daily?.showTimes??(show.showTimesDate===settings.date?show.showTimes:[]);
      for(const value of starts||[]){const start=minute(value),end=Math.min(1440,start+programme.duration);if(start<end)items.push({window:[start,end],kind:'show-avoidance',label:show.name,sourceUrl:programme.url});}
    }
  }
  const hasInferredShowWindows=items.some(item=>item.kind==='show-avoidance');
  return {windows:mergeWindows(items.map(item=>item.window)),items,hasInferredShowWindows,
    note:baseVisitId(activity.id)===GONDOLA_ID?'ショー上演中を避ける目安です。前後の準備・再開時刻は公式情報では確定できないため、当日の稼働状況を更新して確認します。':''};
}
export function subtractPauseWindows(windows,pauses) {
  let result=windows.map(pair=>pair.slice());
  for(const [start,end] of mergeWindows(normalisePauseWindows(pauses))){
    const next=[];for(const [open,close] of result){if(end<=open||start>=close)next.push([open,close]);else{if(open<start)next.push([open,start]);if(end<close)next.push([end,close]);}}result=next;
  }return result;
}
