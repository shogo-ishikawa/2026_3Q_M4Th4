/** Calendar and hourly weather features shared by training and prediction. */
import {ticketFactsFor} from './ticket-calendar.js?v=2.3.1';
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
/** The first, interior and last days of a run of at least three weekends/public holidays. */
export function longWeekendPosition(date, calendarData) {
  const coverage = calendarData?.coverage;
  if (!validCalendarDate(date) || !coverage || !Array.isArray(calendarData.holidays) ||
      !validCalendarDate(coverage.startDate) || !validCalendarDate(coverage.endDate)) return null;
  const index = holidayIndex(calendarData);
  const off = offset => {
    const day = dateOffset(date,offset);
    if (day < coverage.startDate || day > coverage.endDate) return null;
    const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
    return weekday === 0 || weekday === 6 || index.has(day);
  };
  const today = off(0);
  if (today !== true) return today === false ? 'ordinary' : null;
  const before = off(-1), after = off(1);
  if (before == null || after == null) return null;
  if (before && after) return 'middle';
  if (!before && !after) return 'ordinary';
  const third = off(before ? -2 : 2);
  return third == null ? null : third ? (before ? 'last' : 'first') : 'ordinary';
}

const yen = amount => Number.isInteger(amount) && amount > 0 && amount <= 100000;
function knownBy(value, cutoff) {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Date.parse(value) <= cutoff;
}

/** Training and forecasting share the same pre-visit cutoff. Prices collected retrospectively stay unknown. */
export function visitDayContext(date, park, calendarData, asOf = Infinity) {
  const context = {};
  const position = longWeekendPosition(date,calendarData);
  if (position != null) {
    for (const key of ['first','middle','last']) context['long_weekend_'+key] = Number(position === key);
  }
  const cutoff = Math.min(asOf, Date.parse(date+'T00:00:00+09:00'));
  const fare = ticketFactsFor(park,date,cutoff);
  if (!fare) return context;
  const adult = knownBy(fare.adultKnownSince ?? fare.knownSince,cutoff) && yen(fare.adultOneDayYen);
  if (adult) context.adult_ticket_yen = fare.adultOneDayYen;
  if (knownBy(fare.studentKnownSince ?? fare.knownSince,cutoff) && typeof fare.studentOffer === 'boolean') {
    context.student_offer = Number(fare.studentOffer);
    if (fare.studentOffer && adult && knownBy(fare.studentPriceKnownSince ?? fare.studentKnownSince ?? fare.knownSince,cutoff) && yen(fare.studentOneDayYen) && fare.studentOneDayYen < fare.adultOneDayYen)
      context.student_saving_yen = fare.adultOneDayYen - fare.studentOneDayYen;
  }
  return context;
}

export const VISIT_FACTOR_NAMES = Object.freeze([
  'long_weekend_first','long_weekend_middle','long_weekend_last','adult_ticket_yen','student_offer','student_saving_yen'
]);

/** Different rides or time slots on the same day supply just one observation of a calendar factor. */
export function learnVisitFactors(rows) {
  const byDay = new Map(rows.map(row => [row.date,row.visitContext]));
  const factors = [], support = {};
  for (const name of VISIT_FACTOR_NAMES) {
    const counts = new Map();
    for (const context of byDay.values()) {
      const value = context?.[name];
      if (Number.isFinite(value)) counts.set(value, (counts.get(value) || 0) + 1);
    }
    const supported = [...counts].filter(([,days]) => days >= 3);
    support[name] = {knownDays:[...counts.values()].reduce((sum,n)=>sum+n,0),levels:counts.size,supportedLevels:supported.length};
    if (supported.length < 2) continue;
    const days = supported.reduce((sum,[,n]) => sum+n,0);
    const values = supported.map(([v])=>v);
    factors.push({name,days,mean:supported.reduce((sum,[v,n])=>sum+v*n,0)/days,min:Math.min(...values),max:Math.max(...values)});
  }
  return {factors,support};
}

function factorValue(context, factor) {
  const value = context?.[factor.name];
  if (!Number.isFinite(value)) return 0;
  const bounded = Math.min(factor.max,Math.max(factor.min,value));
  return (bounded-factor.mean) / (factor.name.endsWith('_yen') ? 1000 : 1);
}

/** Forecast categories are selected at queue start, never aggregated over the whole day. */
export function weatherAtMinute(date,minute,settings={}) {
  const forecast=settings.weatherForecast, rows=forecast?.date===date&&Array.isArray(forecast.hours)?forecast.hours:[];
  const candidates=rows.filter(row=>row&&typeof row==='object').map(row=>({...row,minute:minuteOf(row.minute??String(row.time||'').slice(11,16))})).filter(row=>row.minute!==null).sort((a,b)=>a.minute-b.minute);
  const hour=candidates.filter(row=>row.minute<=minute).at(-1);
  const chosen=hour&&minute<(hour.endMinute??hour.minute+60)?hour:{};
  // JMA may display a three-hourly point in later hours with its original
  // timestamp. Only the matching hour supplies a temperature to the wait model.
  const temperature=forecast?.provider==='jma' && chosen.temperatureAtMinute!==chosen.minute
    ? null : finiteObservationNumber(chosen.temperature);
  return {weather:['sun','cloud','rain'].includes(chosen.weather)?chosen.weather:settings.weather||'',temperature,precipitation:finiteObservationNumber(chosen.precipitation)};
}
export function eventIdsFor(date,park={},row={}) {
  if(typeof row.event==='string'&&row.event.trim())return [...new Set(row.event.split('|').map(value=>value.trim()).filter(value=>value&&value.length<=120))].slice(0,60);
  if(Array.isArray(row.events)&&row.events.length)return [...new Set(row.events.map(value=>typeof value==='string'?value:value?.id).filter(value=>typeof value==='string'&&value&&value.length<=120))].slice(0,60);
  return (park.events||[]).filter(event=>event.startDate<=date&&date<=event.endDate).map(event=>event.id).filter(id=>typeof id==='string').slice(0,60);
}

export const WAIT_BASE_FEATURE_NAMES=Object.freeze(['intercept','time_sin','time_cos','time_sin_2','time_cos_2','opening_90min','midday','weekday_1','weekday_2','weekday_3','weekday_4','weekday_5','weekday_6','month_sin','month_cos','holiday','before_holiday','after_holiday','rain','cloud','weather_known','temperature','temperature_known','precipitation','precipitation_known','event_present']);
export function waitFeatures(row,{eventIds=[],calendarData,activity={},visitFactors=[]}={}) {
  const calendar=calendarContext(row.date,calendarData),phase=2*Math.PI*row.minute/1440;
  const opening=minuteOf(row.openingMinute)??minuteOf(activity.windows?.[0]?.[0])??540;
  const temperature=finiteObservationNumber(row.temperature),precipitation=finiteObservationNumber(row.precipitation);
  const knownTemperature=temperature!==null&&temperature>=-40&&temperature<=60,knownRain=precipitation!==null&&precipitation>=0&&precipitation<=200;
  const values=[1,Math.sin(phase),Math.cos(phase),Math.sin(2*phase),Math.cos(2*phase),Math.max(0,Math.min(1,(row.minute-opening)/90)),Math.max(0,1-Math.abs(row.minute-840)/240),...Array.from({length:6},(_,i)=>Number(calendar?.weekday===i+1)),Math.sin(2*Math.PI*(calendar?.month-1)/12),Math.cos(2*Math.PI*(calendar?.month-1)/12),Number(!!calendar?.isHoliday),Number(!!calendar?.beforeHoliday),Number(!!calendar?.afterHoliday),Number(row.weather==='rain'),Number(row.weather==='cloud'),Number(['sun','cloud','rain'].includes(row.weather)),knownTemperature?(temperature-20)/15:0,Number(knownTemperature),knownRain?Math.min(30,precipitation)/5:0,Number(knownRain),Number(!!row.eventIds?.length)];
  return values.concat(visitFactors.map(factor=>factorValue(row.visitContext,factor)),eventIds.map(id=>Number(row.eventIds?.includes(id))));
}
