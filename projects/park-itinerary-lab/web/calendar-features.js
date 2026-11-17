/** Calendar and hourly weather features shared by training and prediction. */
export const validCalendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
export const minuteOf = value => {
  if (Number.isInteger(value) && value >= 0 && value < 1440) return value;
  const match=/^(\d{1,2}):([0-5]\d)$/.exec(String(value));
  return match && Number(match[1]) < 24 ? Number(match[1])*60+Number(match[2]) : null;
};
export function finiteObservationNumber(value) {
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!value.trim()||!/^[-+]?\d+(\.\d+)?$/.test(value.trim()))return null;
  return Number.isFinite(Number(value))?Number(value):null;
}
const dateOffset = (date,days) => new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const calendarIndexes=new WeakMap();
function holidayIndex(calendarData) {
  if(!calendarData || typeof calendarData!=='object')return new Map();
  if(!calendarIndexes.has(calendarData))calendarIndexes.set(calendarData,new Map((Array.isArray(calendarData.holidays)?calendarData.holidays:[]).filter(item=>validCalendarDate(item?.date)).map(item=>[item.date,String(item.name||'祝日')])));
  return calendarIndexes.get(calendarData);
}
export function calendarContext(date,calendarData) {
  if(!validCalendarDate(date))return null;
  const instant=new Date(date+'T12:00:00Z'),index=holidayIndex(calendarData),coverage=calendarData?.coverage;
  const known=!!coverage&&validCalendarDate(coverage.startDate)&&validCalendarDate(coverage.endDate)&&coverage.startDate<=date&&date<=coverage.endDate;
  return {weekday:instant.getUTCDay(),month:instant.getUTCMonth()+1,dayOfYear:Math.floor((instant-Date.UTC(instant.getUTCFullYear(),0,1,12))/86400000),holidayKnown:known,isHoliday:known&&index.has(date),holidayName:known?index.get(date)||'':null,beforeHoliday:known&&index.has(dateOffset(date,1)),afterHoliday:known&&index.has(dateOffset(date,-1))};
}
/** Forecast categories are selected at queue start, never aggregated over the whole day. */
export function weatherAtMinute(date,minute,settings={}) {
  const forecast=settings.weatherForecast, rows=forecast?.date===date&&Array.isArray(forecast.hours)?forecast.hours:[];
  const candidates=rows.filter(row=>row&&typeof row==='object').map(row=>({...row,minute:minuteOf(row.minute??String(row.time||'').slice(11,16))})).filter(row=>row.minute!==null).sort((a,b)=>a.minute-b.minute);
  const hour=candidates.filter(row=>row.minute<=minute).at(-1);
  const chosen=hour&&minute-hour.minute<120?hour:{};
  return {weather:['sun','cloud','rain'].includes(chosen.weather)?chosen.weather:settings.weather||'',temperature:finiteObservationNumber(chosen.temperature),precipitation:finiteObservationNumber(chosen.precipitation)};
}
export function eventIdsFor(date,park={},row={}) {
  if(typeof row.event==='string'&&row.event.trim())return [...new Set(row.event.split('|').map(value=>value.trim()).filter(value=>value&&value.length<=120))].slice(0,60);
  if(Array.isArray(row.events)&&row.events.length)return [...new Set(row.events.map(value=>typeof value==='string'?value:value?.id).filter(value=>typeof value==='string'&&value&&value.length<=120))].slice(0,60);
  return (park.events||[]).filter(event=>event.startDate<=date&&date<=event.endDate).map(event=>event.id).filter(id=>typeof id==='string').slice(0,60);
}

export const WAIT_BASE_FEATURE_NAMES=Object.freeze(['intercept','time_sin','time_cos','time_sin_2','time_cos_2','opening_90min','midday','weekday_1','weekday_2','weekday_3','weekday_4','weekday_5','weekday_6','month_sin','month_cos','holiday','before_holiday','after_holiday','rain','cloud','weather_known','temperature','temperature_known','precipitation','precipitation_known','event_present']);
export function waitFeatures(row,{eventIds=[],calendarData,activity={}}={}) {
  const calendar=calendarContext(row.date,calendarData),phase=2*Math.PI*row.minute/1440;
  const opening=minuteOf(row.openingMinute)??minuteOf(activity.windows?.[0]?.[0])??540;
  const temperature=finiteObservationNumber(row.temperature),precipitation=finiteObservationNumber(row.precipitation);
  const knownTemperature=temperature!==null&&temperature>=-40&&temperature<=60,knownRain=precipitation!==null&&precipitation>=0&&precipitation<=200;
  const values=[1,Math.sin(phase),Math.cos(phase),Math.sin(2*phase),Math.cos(2*phase),Math.max(0,Math.min(1,(row.minute-opening)/90)),Math.max(0,1-Math.abs(row.minute-840)/240),...Array.from({length:6},(_,i)=>Number(calendar?.weekday===i+1)),Math.sin(2*Math.PI*(calendar?.month-1)/12),Math.cos(2*Math.PI*(calendar?.month-1)/12),Number(!!calendar?.isHoliday),Number(!!calendar?.beforeHoliday),Number(!!calendar?.afterHoliday),Number(row.weather==='rain'),Number(row.weather==='cloud'),Number(['sun','cloud','rain'].includes(row.weather)),knownTemperature?(temperature-20)/15:0,Number(knownTemperature),knownRain?Math.min(30,precipitation)/5:0,Number(knownRain),Number(!!row.eventIds?.length)];
  return values.concat(eventIds.map(id=>Number(row.eventIds?.includes(id))));
}
