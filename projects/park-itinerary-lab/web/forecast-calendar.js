import {forecastDateRange} from './weather.js?v=1.16.0';

const weatherStatus = {
  confirmed: {mark:'●', label:'予報確認済み'},
  eligible: {mark:'○', label:'取得対象'},
  outside: {mark:'−', label:'取得対象外'}
};
const crowdStatus = {
  model: {mark:'◆', label:'学習予測'},
  calendar: {mark:'◇', label:'暦の目安'},
  pending: {mark:'…', label:'判定中'}
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

/** The text input keeps the selected date. The calendar only commits on activation. */
export function createForecastCalendar({getCoverage, onOpen, today = () => forecastDateRange().startDate}) {
  const byId = id => document.getElementById(id);
  const input = byId('visitDate'), opener = byId('openForecastCalendar'), dialog = byId('forecastCalendarDialog');
  const grid = byId('forecastCalendarDays'), detail = byId('forecastCalendarDetail');
  let cursor;

  function describe(button) {
    const {date, weather, crowd} = button.dataset;
    return shortDate(date) + '　天気 ' + weatherStatus[weather].label + '　混雑 ' + crowdStatus[crowd].label;
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
        cell.setAttribute('aria-selected', String(date === input.value));
        cell.append(makeDay(date, todayKey));
      }
      fragment.append(row);
    }
    grid.replaceChildren(fragment);
    detail.textContent = describe(cursorButton());
    const range = forecastDateRange(todayKey + 'T12:00:00+09:00');
    byId('forecastCalendarRange').textContent = '天気の取得対象　' + shortDate(range.startDate) + '〜' + shortDate(range.endDate);
    byId('forecastCalendarPending').hidden = !grid.querySelector('[data-crowd="pending"]');
  }

  function moveCursor(next, focus = true) {
    const changeMonth = next.slice(0,7) !== cursor.slice(0,7);
    const old = cursorButton();
    if (old) old.tabIndex = -1;
    cursor = next;
    if (changeMonth) render();
    const button = cursorButton();
    button.tabIndex = 0;
    detail.textContent = describe(button);
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
    cursor = /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : today();
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
    if (!date) return;
    dialog.close();
    if (date !== input.value) {
      input.value = date;
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
