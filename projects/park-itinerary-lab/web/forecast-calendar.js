import {forecastDateRange} from './weather.js?v=2.6.1';

const weatherStatus = {
  confirmed: {mark:'●', label:'予報あり'},
  eligible: {mark:'○', label:'未取得'},
  outside: {mark:'−', label:'期間外'}
};
const crowdStatus = {
  model: {mark:'◆', label:'過去の待ち時間から予想'},
  calendar: {mark:'◇', label:'曜日・祝日から予想'},
  pending: {mark:'…', label:'確認中'}
};

function dateKey(day) {
  return day.toISOString().slice(0, 10);
}
function asDate(key) {
  return new Date(key + 'T00:00:00Z');
}
function shortDate(key) {
  const [,month,day] = key.split('-');
  return Number(month) + '/' + Number(day);
}
const visitDayLabel = new Intl.DateTimeFormat('ja-JP', {month:'long',day:'numeric',timeZone:'UTC'});
function visitDay(date) {
  const day = asDate(date);
  return visitDayLabel.format(day) + '（' + '日月火水木金土'[day.getUTCDay()] + '）';
}
function moveDate(key, days, months = 0) {
  const day = asDate(key);
  if (months) {
    const previousDay = day.getUTCDate();
    day.setUTCDate(1);
    day.setUTCMonth(day.getUTCMonth() + months);
    const last = new Date(day);
    last.setUTCMonth(day.getUTCMonth() + 1, 0);
    day.setUTCDate(Math.min(previousDay, last.getUTCDate()));
  }
  day.setUTCDate(day.getUTCDate() + days);
  return day.getUTCFullYear() >= 1 && day.getUTCFullYear() <= 9999 ? dateKey(day) : key;
}

/** The grid previews a candidate. Only the confirmation button changes the plan. */
export function createForecastCalendar({getCoverage, getPreview, getChangeNotice, onOpen, today = () => forecastDateRange().startDate}) {
  const byId = id => document.getElementById(id);
  const input = byId('visitDate'), opener = byId('openForecastCalendar'), dialog = byId('forecastCalendarDialog');
  const grid = byId('forecastCalendarDays'), confirm = byId('confirmForecastDate');
  let cursor;

  function describe(button) {
    const {date, weather, crowd} = button.dataset;
    const current = date === input.value ? '、現在の訪問日' : '';
    return visitDay(date) + current + '、天気予報 ' + weatherStatus[weather].label + '、混雑 ' + crowdStatus[crowd].label;
  }

  function makeDay(date, todayKey) {
    const {weather, crowd} = getCoverage(date);
    const button = document.createElement('button');
    button.type = 'button';
    Object.assign(button.dataset, {date, weather, crowd});
    button.tabIndex = date === cursor ? 0 : -1;
    button.setAttribute('aria-label', describe(button));
    if (date === todayKey) button.setAttribute('aria-current','date');
    const number = document.createElement('span');
    number.textContent = Number(date.slice(-2));
    const marks = document.createElement('span');
    marks.className = 'calendar-marks';
    marks.setAttribute('aria-hidden','true');
    const w = document.createElement('i'), c = document.createElement('i');
    w.className = weather === 'outside' ? 'empty-mark' : 'weather-mark';
    w.textContent = weatherStatus[weather].mark;
    c.className = crowd === 'pending' ? 'empty-mark' : 'crowd-mark';
    c.textContent = crowdStatus[crowd].mark;
    marks.append(w,c);
    button.append(number,marks);
    return button;
  }

  function cursorButton() {
    return grid.querySelector('[data-date="' + cursor + '"]');
  }

  function updatePreview() {
    const {weather, crowd, ticket} = getPreview(cursor);
    byId('calendarPreviewWeather').textContent = weather.label;
    byId('calendarPreviewWeatherDetail').textContent = weather.detail;
    byId('calendarPreviewCrowd').textContent = crowd.label;
    byId('calendarPreviewCrowdDetail').textContent = crowd.detail;
    byId('calendarPreviewTicket').textContent = ticket ?? '料金未確認';
    const notice = byId('calendarDateNotice');
    notice.textContent = cursor !== input.value ? getChangeNotice?.(cursor) || '' : '';
    notice.hidden = !notice.textContent;
    confirm.textContent = visitDay(cursor) + 'を訪問日にする';
  }

  function render() {
    const first = asDate(cursor.slice(0,7) + '-01');
    const end = new Date(first);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    const firstWeekday = first.getUTCDay(), monthLength = end.getUTCDate();
    const month = first.getUTCFullYear() + '年' + (first.getUTCMonth() + 1) + '月';
    if (byId('forecastCalendarMonth').textContent !== month) byId('forecastCalendarMonth').textContent = month;
    byId('previousForecastMonth').disabled = first.getUTCFullYear() === 1 && first.getUTCMonth() === 0;
    byId('nextForecastMonth').disabled = first.getUTCFullYear() === 9999 && first.getUTCMonth() === 11;
    const todayKey = today(), fragment = document.createDocumentFragment();
    for (let week = 0; week < Math.ceil((firstWeekday + monthLength) / 7); week++) {
      const row = document.createElement('tr');
      for (let weekday = 0; weekday < 7; weekday++) {
        const cell = row.insertCell(), number = week * 7 + weekday - firstWeekday + 1;
        if (number < 1 || number > monthLength) continue;
        const date = dateKey(first).slice(0,8) + String(number).padStart(2,'0');
        cell.setAttribute('aria-selected', String(date === cursor));
        if (date === input.value) cell.className = 'current-visit';
        cell.append(makeDay(date, todayKey));
      }
      fragment.append(row);
    }
    grid.replaceChildren(fragment);
    updatePreview();
    const range = forecastDateRange(todayKey + 'T12:00:00+09:00');
    byId('forecastCalendarRange').textContent = '天気を調べられる期間　' + shortDate(range.startDate) + '〜' + shortDate(range.endDate);
    byId('forecastCalendarPending').hidden = !grid.querySelector('[data-crowd="pending"]');
  }

  function moveCursor(next, focus = true) {
    const changeMonth = next.slice(0,7) !== cursor.slice(0,7);
    const old = cursorButton();
    old.tabIndex = -1;
    old.parentElement.setAttribute('aria-selected','false');
    cursor = next;
    if (changeMonth) render();
    else updatePreview();
    const button = cursorButton();
    button.tabIndex = 0;
    button.parentElement.setAttribute('aria-selected','true');
    if (focus) button.focus();
  }
  function refresh() {
    if (!dialog.open) return;
    const hasDayFocus = grid.contains(document.activeElement);
    render();
    if (hasDayFocus) cursorButton().focus({preventScroll:true});
  }

  if (typeof dialog.showModal !== 'function') return {refresh};
  opener.hidden = false;
  input.classList.add('has-forecast-calendar');
  opener.addEventListener('click', () => {
    const selected = /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : null;
    cursor = selected || today();
    byId('forecastCalendarCurrent').textContent = selected ? selected.slice(0,4) + '年' + visitDay(selected) : input.value || '未設定';
    render();
    dialog.showModal();
    cursorButton().focus();
    onOpen?.();
  });
  byId('closeForecastCalendar').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => opener.focus({preventScroll:true}));
  byId('previousForecastMonth').addEventListener('click', () => moveCursor(moveDate(cursor,0,-1),false));
  byId('nextForecastMonth').addEventListener('click', () => moveCursor(moveDate(cursor,0,1),false));
  grid.addEventListener('click', event => {
    const date = event.target.closest('button[data-date]')?.dataset.date;
    if (date) moveCursor(date);
  });
  confirm.addEventListener('click', () => {
    dialog.close();
    if (cursor !== input.value) {
      input.value = cursor;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    }
  });
  grid.addEventListener('keydown', event => {
    const day = event.target.dataset.date;
    if (!day) return;
    const weekday = asDate(day).getUTCDay();
    const days = {ArrowRight:1, ArrowLeft:-1, ArrowDown:7, ArrowUp:-7, Home:-weekday, End:6-weekday};
    let next;
    if (Object.hasOwn(days,event.key)) next = moveDate(day,days[event.key]);
    else if (event.key === 'PageDown' || event.key === 'PageUp') {
      const direction = event.key === 'PageDown' ? 1 : -1;
      next = moveDate(day,0,direction * (event.shiftKey ? 12 : 1));
    } else return;
    event.preventDefault();
    moveCursor(next);
  });
  return {refresh};
}
