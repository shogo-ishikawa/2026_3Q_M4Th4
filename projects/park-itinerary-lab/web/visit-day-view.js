import {calendarContext, longWeekendPosition, validCalendarDate} from './calendar-features.js?v=2.0.0';
import {ticketFactsFor} from './ticket-calendar.js?v=2.0.0';

const yen = n => n.toLocaleString('ja-JP')+'円';
const positions = {first:'初日',last:'最終日'};
// Adult one-day fares listed in the park calendars. An unfamiliar revised price still shows in full.
const fareLevels = [8900, 9400, 9900, 10900, 11900, 12400];

function fareBadge(amount) {
  if (!amount) return {label:'大人1デーパスポート 料金未確認', tone:'unknown'};
  const level = fareLevels.indexOf(amount) + 1;
  const label = '大人1デーパスポート '+yen(amount);
  return level ? {label:label+'（料金帯 '+level+'/'+fareLevels.length+'）', tone:'fare-'+level}
    : {label, tone:'unknown'};
}

function dayBadge(day, position) {
  const weekend = day.weekday === 0 || day.weekday === 6;
  if (!weekend && !day.holidayKnown) return {label:'祝日情報未確認', tone:'unknown'};
  if (!weekend && !day.isHoliday) return {label:'平日', tone:'weekday'};
  const label = position === 'middle' ? '連休中日' : '休日';
  const qualifiers = [];
  if (position === 'first' || position === 'last') qualifiers.push('連休の'+positions[position]);
  if (day.holidayName) qualifiers.push(day.holidayName);
  return {label:qualifiers.length ? label+'（'+qualifiers.join('・')+'）' : label,
    tone:position === 'middle' ? 'middle' : 'holiday'};
}

function eventLabels(park, date, fare) {
  const names = new Set((park.events || []).filter(event=>event.startDate<=date && date<=event.endDate)
    .map(event=>event.name));
  if (fare.studentOffer === true) {
    const name = fare.studentSourceUrl === 'https://www.tokyodisneyresort.jp/treasure/spring2027/'
      ? 'キャンパスデーパスポート' : '学生向け割引パスポート';
    const catalogueName = [...names].find(label=>label.includes(name));
    if (catalogueName) names.delete(catalogueName);
    const price = fare.studentOneDayYen ? '（対象の大人 '+yen(fare.studentOneDayYen)+'）' : '';
    names.add((catalogueName || name)+price);
  }
  return [...names];
}

export function visitDayDetails(park,settings,now=Date.now()) {
  if (!validCalendarDate(settings.date)) return null;
  const model=settings.waitModel?.parkId===park.id ? settings.waitModel : null;
  const calendar=settings.calendarData || model?.calendarData;
  const fare=ticketFactsFor(park,settings.date,now);
  const day=calendarContext(settings.date,calendar);
  const position=longWeekendPosition(settings.date,calendar);
  const facts=[dayBadge(day,position),fareBadge(fare.adultOneDayYen)];
  const sources=[];
  if (fare.adultOneDayYen && fare.sourceUrl) sources.push({label:'大人料金の出典',url:fare.sourceUrl});
  if (fare.studentOffer===true && fare.studentSourceUrl) sources.push({label:'学生向け割引の対象・条件',url:fare.studentSourceUrl});
  if (day.holidayKnown && calendar?.sourcePage) sources.push({label:'内閣府の祝日一覧',url:calendar.sourcePage});
  const past=settings.date<new Date(now+9*3600000).toISOString().slice(0,10);
  return {adultOneDayYen:fare.adultOneDayYen ?? null, facts, events:eventLabels(park,settings.date,fare), sources,
    report:past?'accuracy.html?date='+settings.date+'&park='+park.id:null};
}
