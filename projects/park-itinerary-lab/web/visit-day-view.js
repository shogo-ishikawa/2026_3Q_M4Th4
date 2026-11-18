import {visitDayContext, validCalendarDate} from './calendar-features.js?v=1.14.0';
import {ticketFactsFor} from './ticket-calendar.js';
import {validateWaitModel} from './wait-model.js?v=1.14.0';

const yen = n => n.toLocaleString('ja-JP')+'円';
const positions = {first:'初日',middle:'中日',last:'最終日'};
const factorLabels = {
  long_weekend_first:'連休の初日かどうか', long_weekend_middle:'連休の中日かどうか',
  long_weekend_last:'連休の最終日かどうか', adult_ticket_yen:'大人料金',
  student_offer:'学生向け割引の有無', student_saving_yen:'学生向け割引額',
};

function forecastUse(park, settings, inputs) {
  if (settings.crowdMode==='manual') return '待ち時間は各施設に入力した値を使います。';
  const model=settings.waitModel;
  if (model?.parkId!==park.id || !validateWaitModel(model) || model.usable!==true || model.status!=='trained')
    return 'この訪問日に使える検証済みの待ち時間モデルはまだありません。';
  if (model.lastDate>=settings.date) return 'この訪問日は現在のモデルの最終学習日以前です。';
  const adopted=model.visitFactors || [];
  if (!adopted.length) return '料金・学生向け割引・連休の位置は、現在の待ち時間モデルでは未採用です。';
  const used=adopted.filter(({name})=>Number.isFinite(inputs[name])).map(({name,min,max})=>{
    if (!name.endsWith('_yen')) return factorLabels[name];
    const usedValue=Math.max(min,Math.min(max,inputs[name]));
    const limit=inputs[name]>max ? '（学習範囲の上限）' : inputs[name]<min ? '（学習範囲の下限）' : '';
    return factorLabels[name]+' '+yen(usedValue)+limit;
  });
  if (!used.length) return 'モデルが採用した項目は、この訪問日の予測に使える値が未確認です。';
  return '施設別のモデル予測に使う項目は'+used.join('、')+'です。';
}

function supportSummary(model) {
  const support=model?.visitFactorSupport;
  if (!support) return '';
  // The three long-weekend indicators share the same set of known dates.
  return [['長い連休の位置','long_weekend_first'],['大人料金','adult_ticket_yen'],
    ['学生向け割引の有無','student_offer'],['学生向け割引額','student_saving_yen']]
    .filter(([,key])=>Number.isInteger(support[key]?.knownDays) && support[key].knownDays>=0 && support[key].knownDays<=model.days)
    .map(([label,key])=>label+' '+support[key].knownDays+'日').join('、');
}

export function visitDayDetails(park,settings,now=Date.now()) {
  if (!validCalendarDate(settings.date)) return null;
  const model=settings.waitModel?.parkId===park.id ? settings.waitModel : null;
  const calendar=settings.calendarData || model?.calendarData;
  const inputs=visitDayContext(settings.date,park,calendar,now);
  const fare=ticketFactsFor(park,settings.date,now);
  const facts=['大人1デーパスポート '+(fare.adultOneDayYen ? yen(fare.adultOneDayYen) : '料金未確認')];
  const offer= fare.studentSourceUrl==='https://www.tokyodisneyresort.jp/treasure/spring2027/'
    ? '春のキャンパスデーパスポート（2027年）' : '収録した学生向け割引';
  if (fare.studentOffer===true) facts.push(offer+'の対象日'+(fare.studentOneDayYen ? '・対象者 '+yen(fare.studentOneDayYen) : ''));
  if (fare.studentOffer===false) facts.push(offer+'は期間外');
  if (fare.studentOffer===undefined) facts.push('学生向け割引は未確認');
  const position=Object.keys(positions).find(key=>inputs['long_weekend_'+key]===1);
  if (position) facts.push('土日・祝日が3日以上続く連休の'+positions[position]);
  const sources=[];
  if (fare.adultOneDayYen && fare.sourceUrl) sources.push({label:'公式料金カレンダー',url:fare.sourceUrl});
  if (fare.studentOffer!==undefined && fare.studentSourceUrl) sources.push({label:'学生向け割引の対象・条件',url:fare.studentSourceUrl});
  if (position && calendar?.sourcePage) sources.push({label:'内閣府の祝日一覧',url:calendar.sourcePage});
  const past=settings.date<new Date(now+9*3600000).toISOString().slice(0,10);
  return {facts, forecast:forecastUse(park,settings,inputs), support:settings.crowdMode==='manual'?'':supportSummary(model),
    sources, report:past?'accuracy.html?date='+settings.date+'&park='+park.id:null};
}
