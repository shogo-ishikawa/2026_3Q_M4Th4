import { weatherAtMinute } from './calendar-features.js?v=1.15.1';
import {trainWaitModel, validateWaitModel} from './wait-model.js?v=1.15.1';
import {validateCatalogue} from './storage.js?v=1.15.1';
import {prepareWeatherForVisit,forecastSourceLabel,forecastCacheLabel} from './weather.js?v=1.15.1';
export {fetchWeather,prepareWeatherForVisit} from './weather.js?v=1.15.1';

const REMOTE='https://raw.githubusercontent.com/shogo-ishikawa/2026_3Q_M4Th4/park-wait-data/';
const QUEUE_URL='https://queue-times.com/';
const THEMEPARKS_IDS={land:'3cc919f1-d16d-43e0-8c3f-1dd269bd1a42',sea:'67b290d5-3478-4f23-b601-2f8fb71ba803'};
const dateOf=value=>new Date(new Date(value).getTime()+9*3600000).toISOString().slice(0,10);
const minuteOf=value=>{const date=new Date(new Date(value).getTime()+9*3600000);return date.getUTCHours()*60+date.getUTCMinutes();};
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const safeSourceUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'#';}catch{return '#';}};
const validTimestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const stamp=value=>validTimestamp(value)?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'更新日時なし';

export function validateLiveSnapshot(snapshot,parkId) {
  return !!snapshot&&snapshot.schemaVersion===1&&['queue-times','themeparks-wiki'].includes(snapshot.provider)&&snapshot.parkId===parkId&&validTimestamp(snapshot.fetchedAt)&&Array.isArray(snapshot.rides)&&snapshot.rides.length<=400&&snapshot.rides.every(ride=>typeof ride.activityId==='string'&&ride.activityId.startsWith(parkId+'-')&&typeof ride.isOpen==='boolean'&&((snapshot.provider==='themeparks-wiki'&&ride.wait===null)||(Number.isFinite(ride.wait)&&ride.wait>=0&&ride.wait<=600))&&Number.isInteger(ride.providerId)&&validTimestamp(ride.updatedAt));
}
async function readJson(url,signal,fetchImpl=fetch,timeoutMs=15000) {
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort(signal?.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try {
    const response=await fetchImpl(url,{signal:controller.signal,cache:'no-cache'});
    if(!response.ok)throw new Error('HTTP '+response.status);
    return await response.json();
  } catch(error) {
    if(timedOut&&!signal?.aborted){const timeout=new Error('通信がタイムアウトしました。もう一度お試しください。');timeout.name='TimeoutError';throw timeout;}
    throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** Queue-Times has no browser CORS header. The documented API is collected by the repository workflow. */
export async function fetchLiveWaits(park,{signal,fetchImpl=fetch,timeoutMs=15000}={}) {
  let firstError;
  for(const [url,transport] of [[REMOTE+'live-waits.json','published'],[new URL('./data/live-waits.json',import.meta.url).href,'bundled']]) {
    try {
      const payload=await readJson(url,signal,fetchImpl,timeoutMs), snapshot=payload.parks?.find(item=>item.parkId===park.id);
      if(!validateLiveSnapshot(snapshot,park.id))throw new Error('待ち時間データの形式を確認してください。');
      return {...snapshot,transport};
    } catch(error){if(error.name==='AbortError')throw error;firstError??=error;}
  }
  throw new Error('待ち時間を取得できませんでした。'+(firstError?.message||''));
}
/** Live REST reports the current state; lastUpdated records its last change, not its latest observation. */
export function normaliseThemeParksLive(payload,park,{now=Date.now()}={}) {
  if(payload?.id!==THEMEPARKS_IDS[park.id]||!Array.isArray(payload.liveData)||payload.liveData.length>1000)throw new Error('現在の稼働情報の形式を確認してください。');
  const fetchedAt=new Date(now).toISOString(),rides=[],seen=new Set();
  const known=new Map(park.activities.map(activity=>[activity.id,activity]));
  for(const entity of payload.liveData){
    if(entity.entityType!=='ATTRACTION'||!/^\d+$/.test(String(entity.externalId))||!['OPERATING','DOWN','CLOSED','REFURBISHMENT'].includes(entity.status))continue;
    const activityId=`${park.id}-attraction-${entity.externalId}`,activity=known.get(activityId);
    if(!activity||seen.has(activityId))continue;
    const value=entity.queue?.STANDBY?.waitTime;
    const wait=Number.isFinite(value)&&value>=0&&value<=600?value:null;
    if(entity.lastUpdated!==undefined&&(!validTimestamp(entity.lastUpdated)||Date.parse(entity.lastUpdated)>new Date(now).getTime()+60000))continue;
    seen.add(activityId);rides.push({activityId,providerId:Number(entity.externalId),name:activity.name,wait:entity.status==='OPERATING'?wait:0,isOpen:entity.status==='OPERATING',status:entity.status,updatedAt:fetchedAt,...(entity.lastUpdated?{changedAt:entity.lastUpdated}:{})});
  }
  if(!rides.length)throw new Error('対応する施設の現在情報がありません。');
  return {schemaVersion:1,provider:'themeparks-wiki',parkId:park.id,fetchedAt,rides,unmatched:[],transport:'direct',attribution:'Powered by ThemeParks.wiki',attributionUrl:'https://www.themeparks.wiki/'};
}
export async function fetchRealtimeWaits(park,{signal,fetchImpl=fetch,now=Date.now(),timeoutMs=10000}={}) {
  try {
    const payload=await readJson(`https://api.themeparks.wiki/v1/entity/${THEMEPARKS_IDS[park.id]}/live`,signal,fetchImpl,timeoutMs);
    return normaliseThemeParksLive(payload,park,{now});
  } catch(error) {
    if(signal?.aborted||error.name==='AbortError')throw error;
    const fallback=await fetchLiveWaits(park,{signal,fetchImpl,timeoutMs});
    return {...fallback,directFailure:error.message};
  }
}
/** Last confirmed stops survive missing or stale data; only an explicit fresh open status removes one. */
export function updateOperationalHolds(settings,snapshot,{now=Date.now()}={}) {
  const date=settings.date,current=new Date(now).getTime();
  const previous=settings.operationalHolds?.date===date?settings.operationalHolds:null;
  const ids=new Set(previous?.activityIds||[]);let observedAt=previous?.observedAt;
  const older=settings.liveData;
  if(validateLiveSnapshot(older,older?.parkId)&&dateOf(older.fetchedAt)===date){
    for(const ride of older.rides)if(!ride.isOpen&&dateOf(ride.updatedAt)===date){ids.add(ride.activityId);observedAt=ride.updatedAt;}
  }
  if(validateLiveSnapshot(snapshot,snapshot?.parkId)&&dateOf(snapshot.fetchedAt)===date){
    const snapshotAge=current-Date.parse(snapshot.fetchedAt);
    if(snapshotAge>=-60000&&snapshotAge<=15*60000)for(const ride of snapshot.rides){
      const age=current-Date.parse(ride.updatedAt);if(age< -60000||age>15*60000)continue;
      if(ride.isOpen)ids.delete(ride.activityId);else ids.add(ride.activityId);
      observedAt=ride.updatedAt;
    }
  }
  return ids.size?{date,activityIds:[...ids].sort(),observedAt:observedAt||new Date(now).toISOString()}:null;
}
export function currentRideStatus(activity,settings,{now=Date.now()}={}) {
  const snapshot=settings.liveData,current=new Date(now).getTime();
  if(settings.liveMode==='off'||dateOf(current)!==settings.date)return null;
  if(validateLiveSnapshot(snapshot,snapshot?.parkId)&&activity.id.startsWith(snapshot.parkId+'-')){
    const ride=snapshot.rides.find(item=>item.activityId===activity.id);
    if(ride){
      const age=current-Date.parse(ride.updatedAt),collectedAge=current-Date.parse(snapshot.fetchedAt);
      if(age>=-60000&&collectedAge>=-60000&&age<=15*60000&&collectedAge<=15*60000)return {isOpen:ride.isOpen,status:ride.status||(ride.isOpen?'OPERATING':'CLOSED'),updatedAt:ride.updatedAt,changedAt:ride.changedAt};
    }
  }
  const holds=settings.operationalHolds;
  if(holds?.date===settings.date&&holds.activityIds?.includes(activity.id))return {isOpen:false,status:'DOWN',updatedAt:holds.observedAt,source:'last-confirmed-stop'};
  return null;
}
/** Every same-day replan refreshes waits and statuses before the worker starts. */
export async function prepareLiveForReplan(settings,park,{signal,now=Date.now(),fetchRealtimeWaitsImpl=fetchRealtimeWaits}={}) {
  if(settings.replanFrom===undefined||settings.replanFrom===null||settings.replanFrom===''||settings.date!==dateOf(now)||settings.liveMode==='off')return {...settings,liveNotice:settings.liveMode==='off'?'当日の情報は使わず予測で計画します。':''};
  try {
    const snapshot=await fetchRealtimeWaitsImpl(park,{signal,now});
    if(signal?.aborted)throw new DOMException('aborted','AbortError');
    if(!validateLiveSnapshot(snapshot,park.id))throw new Error('当日の情報の形式を確認してください。');
    const age=new Date(now).getTime()-Date.parse(snapshot.fetchedAt);
    if(age< -60000||age>15*60000)throw new Error('取得できた情報は15分以上前の記録です。');
    if(!snapshot.rides.some(ride=>{const age=new Date(now).getTime()-Date.parse(ride.updatedAt);return age>=-60000&&age<=15*60000;}))throw new Error('施設ごとの現在情報が古いため最新の稼働状況を確認できません。');
    const operationalHolds=updateOperationalHolds(settings,snapshot,{now});
    const stopped=park.activities.filter(activity=>currentRideStatus(activity,{...settings,liveData:snapshot,operationalHolds},{now})?.isOpen===false).length;
    return {...settings,liveData:snapshot,operationalHolds,liveNotice:`${snapshot.provider==='themeparks-wiki'?'ThemeParks.wiki':'Queue-Times'}の現在情報を取得しました（${stamp(snapshot.fetchedAt)}）。直近の待ち時間を更新し、停止中の${stopped}施設は今回の残り予定から外します。${snapshot.directFailure?' 直接取得できなかったため公開済みの収集記録を使いました。':''}`};
  } catch(error) {
    if(signal?.aborted||error.name==='AbortError')throw error;
    const operationalHolds=updateOperationalHolds(settings,null,{now});
    return {...settings,liveData:null,operationalHolds,liveNotice:`当日の最新情報を取得できませんでした（${error.message}）。${operationalHolds?.activityIds.length?`再開未確認の${operationalHolds.activityIds.length}施設は除外を保ちます。`:''}停止状況を確認できないため、予測の案として表示します。再取得して確認してください。`};
  }
}
export function liveWaitFor(activity,minute,settings,{now=Date.now()}={}) {
  const snapshot=settings.liveData, current=new Date(now).getTime();
  if(settings.liveMode==='off'||settings.crowdMode==='manual'||!validateLiveSnapshot(snapshot,snapshot?.parkId)||dateOf(current)!==settings.date||!activity.id.startsWith(snapshot.parkId+'-'))return null;
  const ride=snapshot.rides.find(item=>item.activityId===activity.id);if(!ride||!Number.isFinite(ride.wait))return null;
  const age=current-Date.parse(ride.updatedAt), collectedAge=current-Date.parse(snapshot.fetchedAt), currentMinute=minuteOf(current);
  if(age< -60000||collectedAge< -60000||age>15*60000||collectedAge>15*60000||minute<currentMinute||minute>currentMinute+60)return null;
  return {minutes:ride.wait,source:'live',samples:1,isOpen:ride.isOpen,updatedAt:ride.updatedAt,validUntilMinute:Math.min(1439,currentMinute+60)};
}
export function snapshotToHistory(snapshot,{weather='',event=''}={}) {
  if(!validateLiveSnapshot(snapshot,snapshot?.parkId)||snapshot.provider==='themeparks-wiki')return [];
  return snapshot.rides.filter(ride=>ride.isOpen&&Date.parse(snapshot.fetchedAt)-Date.parse(ride.updatedAt)>=0&&Date.parse(snapshot.fetchedAt)-Date.parse(ride.updatedAt)<=15*60000).map(ride=>({date:dateOf(ride.updatedAt),activityId:ride.activityId,time:minuteOf(ride.updatedAt),wait:ride.wait,weather,event,source:'queue-times',observedAt:ride.updatedAt}));
}
export function mergeObservations(existing,incoming) {
  const rows=new Map();for(const row of [...(existing||[]),...(incoming||[])]){
    const time=typeof row.time==='string'?Number(row.time.slice(0,2))*60+Number(row.time.slice(3)):row.time;
    const opening=Number.isInteger(row.openingMinute)?row.openingMinute:540;const width=time>=opening&&time<opening+90?10:30;
    rows.set([row.date,row.activityId,width,Math.floor(time/width)].join('|'),row);
  }return [...rows.values()].slice(-50000);
}
/** One weather profile and model lookup for the date preview and its planner. */
export function createVisitOutlook({prepareWeather=prepareWeatherForVisit,loadModel=fetchPublishedModel,now=Date.now}={}) {
  let current;
  const cancel=()=>{current?.controller.abort();current=null;};
  function resolve(park,settings,preparedWeather) {
    const manual=settings.weatherMode==='manual';
    const key=JSON.stringify([park.id,settings.date,settings.entry,settings.exit,manual,manual?settings.weather:null]);
    if(!preparedWeather && current?.key===key && (!current.values || now()<current.expiresAt))return current;
    cancel();
    const controller=new AbortController(),signal=controller.signal;
    const request={key,controller,values:null};
    current=request;
    const weather=preparedWeather || prepareWeather(settings,park,{signal});
    const model=settings.waitModel?.parkId===park.id ? null : loadModel(park,{signal,timeoutMs:5000});
    request.promise=Promise.all([weather,model]).then(([prepared,waitModel])=>{
      if(signal.aborted)throw new DOMException('訪問日が変わりました。','AbortError');
      const {weatherMode,weather,weatherForecast,weatherNotice}=prepared;
      const visitForecastAsOf=now();
      request.values={weatherMode,weather,weatherForecast,weatherNotice,visitForecastAsOf,...(waitModel?{waitModel}:{})};
      // Allow a failed fetch to be retried while keeping the displayed fallback available to an immediate solve.
      request.expiresAt=visitForecastAsOf+(manual || weatherForecast ? 30*60000 : 60000);
      return request.values;
    });
    return request;
  }
  return {resolve,cancel};
}

export async function fetchPublishedModel(park,{signal,fetchImpl=fetch,timeoutMs=15000}={}) {
  const candidates=await Promise.all([REMOTE+'wait-model.json',new URL('./data/wait-model.json',import.meta.url).href].map(async url=>{
    try{const data=await readJson(url,signal,fetchImpl,timeoutMs),model=data.parks?.find(item=>item.parkId===park.id);return validateWaitModel(model)?model:null;}catch(error){if(error.name==='AbortError')throw error;return null;}
  }));
  let chosen=null;for(const candidate of candidates)if(candidate&&shouldUsePublishedModel(chosen,candidate,park.id))chosen=candidate;
  return chosen;
}

export function validateCalendarData(data) {
  return !!data&&data.schemaVersion===1&&validTimestamp(data.updatedAt)&&safeSourceUrl(data.sourceUrl)!=='#'&&validDate(data.coverage?.startDate)&&validDate(data.coverage?.endDate)&&data.coverage.startDate<=data.coverage.endDate&&Array.isArray(data.holidays)&&data.holidays.length<=5000&&data.holidays.every(item=>item&&validDate(item.date)&&typeof item.name==='string'&&item.name.length<=120&&item.date>=data.coverage.startDate&&item.date<=data.coverage.endDate);
}
export async function fetchPublishedCatalogue({signal,fetchImpl=fetch,timeoutMs=15000}={}) {
  return validateCatalogue(await readJson(REMOTE+'catalogue.json',signal,fetchImpl,timeoutMs));
}
export async function fetchPublishedCalendar({signal,fetchImpl=fetch,timeoutMs=15000}={}) {
  for(const url of [REMOTE+'calendar.json',new URL('./data/calendar.json',import.meta.url).href]) {
    try{const data=await readJson(url,signal,fetchImpl,timeoutMs);if(validateCalendarData(data))return data;}catch(error){if(error.name==='AbortError')throw error;}
  }return null;
}
export function renderCorrelations(model,dimension='weekday') {
  const correlations=model?.correlations,labels={weekday:'曜日',month:'月',weather:'天気',holiday:'祝日',event:'イベント'};
  const rows=Array.isArray(correlations?.[dimension])?correlations[dimension].slice(0,50):[];
  if(!rows.length)return '<p class="field-note">この条件で比較できる記録はまだありません。</p>';
  const amount=value=>Number.isFinite(value)?Number(value).toFixed(1):'記録不足';
  return `<div class="correlation-table-wrap"><table class="correlation-table"><caption>${escape(labels[dimension]||'条件')}別の記録</caption><thead><tr><th>条件</th><th>件数</th><th>日数</th><th>平均待ち</th><th>基準比</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${escape(row.label||row.key)}</td><td>${Number.isInteger(row.samples)?row.samples:0}</td><td>${Number.isInteger(row.days)?row.days:0}</td><td>${amount(row.samples>=5&&row.days>=2?row.meanWait:null)}${row.samples>=5&&row.days>=2&&Number.isFinite(row.meanWait)?'分':''}</td><td>${amount(row.samples>=5&&row.days>=2?row.meanRatio:null)}${row.samples>=5&&row.days>=2&&Number.isFinite(row.meanRatio)?'倍':''}</td></tr>`).join('')}</tbody></table></div><p class="correlation-note">平均は5件以上かつ2日以上の記録がある場合に表示します。基準比は施設ごとの基準待ち時間に対する倍率です。施設や時間帯の違いも含む記録内の傾向で、因果関係を表すものではありません。</p>`;
}
export function forecastForSettings(settings) {
  return settings.weatherMode!=='manual'&&settings.weatherForecast?.date===settings.date?settings.weatherForecast:null;
}
export function correlationNumbers(model) {
  const parts=[];
  for(const [key,label] of [['temperature','気温'],['precipitation','降水量']]){
    const value=model?.correlations?.[key];
    if(Number.isFinite(value?.r)&&Math.abs(value.r)<=1&&value.samples>=20&&value.days>=3)parts.push(`${label}と基準比の相関 r=${value.r.toFixed(2)}（${value.samples}件・${value.days}日）`);
  }return parts.length?parts.join('。')+'。相関係数は−1から1の範囲で、符号は増減の向きを表します。':'気温・降水量の相関は20件以上かつ3日以上の記録がそろうと表示します。';
}
export function observationWeather(date,minute,settings) {
  if(date!==settings.date)return {weather:'',temperature:null,precipitation:null,weatherSource:'unknown'};
  const values=weatherAtMinute(date,minute,settings);
  return {...values,weatherSource:forecastForSettings(settings)?'forecast':'user'};
}
export function buildObservationCsv(rows) {
  rows=rows.filter(row=>row.source!=='themeparks-wiki');
  const fields=['date','activityId','time','wait','weather','event','temperature','precipitation','weatherSource','source','openingMinute'];
  const cell=value=>{const text=String(value??'');return '"'+(typeof value!=='number'&&/^[\s]*[=+\-@\t\r]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';};
  return '\ufeff'+[fields.join(','),...rows.map(row=>fields.map(key=>cell(key==='time'&&Number.isInteger(row.time)?String(Math.floor(row.time/60)).padStart(2,'0')+':'+String(row.time%60).padStart(2,'0'):row[key])).join(','))].join('\r\n');
}
function downloadObservations(rows) {
  const url=URL.createObjectURL(new Blob([buildObservationCsv(rows)],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='park-wait-observations.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function describeWaitModel(model,settings={}) {
  if(!model)return 'まだ学習モデルを読み込んでいません。';
  const counts=Number.isInteger(model.availableSamples)&&model.availableSamples>model.samples?`${model.days}日・全期間の${model.availableSamples}件から${model.samples}件を選択した記録`:`${model.days}日・${model.samples}件の記録`;
  if(model.status!=='trained')return `${counts}。7日以上かつ100件以上たまると学習します。学習予測はまだ使わず、履歴や傾向モデルで補います。`;
  const metrics=model.validation;if(!metrics||!Number.isFinite(metrics.modelMae)||!Number.isFinite(metrics.baselineMae))return counts+'。検証値がないため傾向モデルを使います。';
  const nextDate=validDate(model.lastDate)?dateOf(Date.parse(model.lastDate+'T15:00:00Z')):'';
  const period=nextDate?`学習最終日${model.lastDate}。${nextDate}以降の予測に使用できます。`:'';
  const use=settings.crowdMode==='manual'?'現在は手動の待ち時間を使います。':validDate(settings.date)&&model.lastDate>=settings.date?'選択日は対象外のため履歴・傾向モデルを使います。':model.usable?'検証で改善した学習モデルを使います。':'検証で改善しなかったため履歴や傾向モデルを使います。';
  return `${counts}で学習。後の日付を検証に使った平均絶対誤差は${Number(metrics.modelMae).toFixed(1)}分。傾向モデルは${Number(metrics.baselineMae).toFixed(1)}分。${period}${use}`;
}
export function shouldUsePublishedModel(existing,published,parkId) {
  if(!published||!validateWaitModel(published)||published.parkId!==parkId)return false;
  if(!existing||existing.parkId!==parkId||!validateWaitModel(existing))return true;
  const rank=model=>model.status==='trained'?(model.usable?2:1):0;
  if(rank(existing)!==rank(published))return rank(published)>rank(existing);
  if(validDate(existing.lastDate)&&validDate(published.lastDate)&&existing.lastDate!==published.lastDate)return published.lastDate>existing.lastDate;
  if(existing.status!=='trained'&&existing.samples!==published.samples)return published.samples>existing.samples;
  return Date.parse(published.trainedAt)>Date.parse(existing.trainedAt);
}

/** A self-contained panel; settings and observations remain owned by the application. */
export function initialiseExternalData({container,getContext,onUpdate,beforeAction}) {
  if(!container)return;
  let generation=0,weatherResult=null,busy=false,contextKey='',pendingController=null;
  container.innerHTML=`<h3>待ち時間と天気を更新</h3><p>来園前は学習モデルや履歴から予測します。記録が少ない場合は傾向モデルを使います。当日は更新から15分以内の掲示を直近1時間の計画に使います。組み替え時に複数施設の掲示が学習予測を同じ方向に外れているときは、1〜3時間先のアトラクションの待ち時間も補正します。</p><div class="field-grid"><label>当日の情報<select data-external="liveMode"><option value="auto">新しい待ち時間を使う</option><option value="off">予測だけを使う</option></select></label></div><div class="actions"><button type="button" data-external="refresh">最新の待ち時間を取得</button><button type="button" data-external="weather">天気予報を取得</button><button type="button" data-external="train">記録から学習し直す</button><button type="button" data-external="export">記録CSVを保存</button></div><p data-external="status" role="status" aria-live="polite"></p><p data-external="live"></p><p><a href="${QUEUE_URL}" target="_blank" rel="noopener">Powered by Queue-Times.com</a> · <a href="https://yosocal.com/" target="_blank" rel="noopener">混雑予想カレンダー</a> · <a data-external="comparison" href="https://queue-times.com/ja/parks/274/calendar" target="_blank" rel="noopener">過去の混雑を見る</a> · <a data-external="disneyreal" href="https://disneyreal.asumirai.info/realtime/disneyland-wait-today.html" target="_blank" rel="noopener">ディズニーリアル</a></p><p data-external="sources"></p><p data-external="weatherResult"></p><p data-external="model"></p><details class="correlation-panel"><summary>曜日・天気・イベント別の実績を見る</summary><label class="full-field">比べる条件<select data-external="correlationDimension"><option value="weekday">曜日</option><option value="month">月</option><option value="weather">天気</option><option value="holiday">祝日</option><option value="event">イベント</option></select></label><div data-external="correlations"></div><p data-external="numericCorrelations" class="correlation-note"></p></details><details><summary>予測モデルと自分の記録</summary><p>施設・時刻・曜日・季節・祝日・天気・イベントを使うリッジ回帰です。最後の約20%の日付を検証に回します。誤差が傾向モデルより小さいときに採用します。今日の記録は明日以降の予測に生かします。</p><div class="field-grid"><label>記録する施設<select data-external="activity"></select></label><label>並び始めた時刻<input type="time" data-external="time"></label><label>実際の待ち時間（分）<input type="number" min="0" max="600" step="1" value="30" data-external="wait"></label></div><button type="button" data-external="record">この待ち時間を記録</button></details>`;
  const element=name=>container.querySelector(`[data-external="${name}"]`);
  const status=message=>{element('status').textContent=message;};
  function render() {
    const {park,settings}=getContext();if(!park)return;
    element('liveMode').value=settings.liveMode||'auto';
    const snapshot=settings.liveData;
    if(snapshot?.parkId===park.id){const age=Date.now()-Date.parse(snapshot.fetchedAt);element('live').textContent=`取得 ${stamp(snapshot.fetchedAt)} · ${snapshot.rides.length}施設。${dateOf(Date.now())!==settings.date?'訪問日が今日ではないため予測を使います。':age>15*60000?'15分以上前のため予測を使います。':'新しい情報を直近の予定に使えます。'}${snapshot.transport==='bundled'?' 配布時の記録を表示しています。':''}`;}else element('live').textContent='待ち時間はまだ取得していません。';
    element('model').textContent=describeWaitModel(settings.waitModel,settings);
    element('correlations').innerHTML=renderCorrelations(settings.waitModel,element('correlationDimension').value);
    element('numericCorrelations').textContent=correlationNumbers(settings.waitModel);
    element('sources').innerHTML=(settings.liveData?.provider==='themeparks-wiki'?[{url:'https://www.themeparks.wiki/',attribution:'Powered by ThemeParks.wiki'}]:(Array.isArray(settings.waitModel?.dataSources)?settings.waitModel.dataSources:[]).filter(source=>source&&/themeparks\.wiki/i.test(source.name+' '+source.url))).map(source=>`<a href="${escape(safeSourceUrl(source.url))}" target="_blank" rel="noopener noreferrer">${escape(source.attribution||'Powered by ThemeParks.wiki')}</a>`).join(' · ');
    element('comparison').href=`https://queue-times.com/ja/parks/${park.id==='land'?274:275}/calendar`;
    element('disneyreal').href=`https://disneyreal.asumirai.info/realtime/${park.id==='land'?'disneyland':'disneysea'}-wait-today.html`;
    const activity=element('activity'), selected=activity.value;
    activity.innerHTML=park.activities.filter(item=>['attraction','greeting','restaurant','cafe'].includes(item.category)).map(item=>`<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');if([...activity.options].some(option=>option.value===selected))activity.value=selected;
    if(!element('time').value){const minute=minuteOf(Date.now());element('time').value=String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');}
    const shownWeather=forecastForSettings(settings);
    const summaryTemperature=shownWeather&&Number.isFinite(shownWeather.temperatureMin)&&Number.isFinite(shownWeather.temperatureMax)?`${shownWeather.temperatureMin}〜${shownWeather.temperatureMax}℃`:'未提供';
    element('weatherResult').innerHTML=shownWeather?`${escape(shownWeather.date)}：${escape(shownWeather.label)} · 気温 ${escape(summaryTemperature)}（${shownWeather.provider==='jma'?'参考範囲・地点と時刻は予定表に表示':'滞在中の最低〜最高'}） · 降水確率 ${Number.isFinite(shownWeather.precipitationProbability)?`最大${shownWeather.precipitationProbability}%`:'未提供'} · ${shownWeather.provider==='jma'?'降水量は未提供':'1時間ごとの降水量は予定表に表示'} · <a href="${escape(safeSourceUrl(shownWeather.sourceUrl))}" target="_blank" rel="noopener">${escape(forecastSourceLabel(shownWeather))}</a>${shownWeather.provider==='open-meteo'?' · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>':''} · 取得 ${escape(stamp(shownWeather.fetchedAt))}${shownWeather.issuedAt?` · 発表 ${escape(stamp(shownWeather.issuedAt))}`:''} · ${escape(forecastCacheLabel(shownWeather))}`:'';
  }
  function cancel(){const wasBusy=busy;generation++;pendingController?.abort();pendingController=null;busy=false;for(const button of container.querySelectorAll('button'))button.disabled=false;if(wasBusy)status('取得を中止しました。');}
  async function perform(action) {
    if(busy)return;
    try{beforeAction?.();}catch(error){status(error.message);return;}
    busy=true;const token=++generation,context=getContext(),controller=new AbortController();pendingController=controller;
    for(const button of container.querySelectorAll('button'))button.disabled=true;
    status('取得・処理中です。');
    try{await action(context,token,controller.signal);}catch(error){if(token===generation&&error.name!=='AbortError')status('更新できませんでした。'+error.message);}finally{if(token===generation){busy=false;pendingController=null;for(const button of container.querySelectorAll('button'))button.disabled=false;render();}}
  }
  const current=(token,parkId,date)=>token===generation&&getContext().park.id===parkId&&getContext().settings.date===date;
  element('correlationDimension').addEventListener('change',render);
  element('liveMode').addEventListener('change',()=>{onUpdate({liveMode:element('liveMode').value});render();});
  element('refresh').addEventListener('click',()=>perform(async({park,settings,history},token,signal)=>{
    const [snapshot,publishedModel]=await Promise.all([fetchRealtimeWaits(park,{signal}),fetchPublishedModel(park,{signal})]);if(!current(token,park.id,settings.date))return;
    const activeEvent=(park.events||[]).filter(event=>event.startDate<=dateOf(Date.now())&&dateOf(Date.now())<=event.endDate).map(event=>event.id).join('|');
    const contextSettings=getContext().settings;
    const rows=mergeObservations(getContext().history,snapshotToHistory(snapshot,{event:activeEvent}).map(row=>{const activity=park.activities.find(item=>item.id===row.activityId);return {...row,openingMinute:activity?.dailySchedules?.[row.date]?.windows?.[0]?.[0]??activity?.windows?.[0]?.[0]??540,...observationWeather(row.date,row.time,contextSettings)};}));
    const usePublished=shouldUsePublishedModel(getContext().settings.waitModel,publishedModel,park.id);onUpdate({liveData:snapshot,operationalHolds:updateOperationalHolds(contextSettings,snapshot),history:rows,...(usePublished?{waitModel:publishedModel}:{})});status(snapshot.transport==='bundled'?'配布時の記録を読み込みました。更新日時を確認してください。':'公開された最新の記録を読み込みました。');
  }));
  element('weather').addEventListener('click',()=>perform(async({park,settings},token,signal)=>{
    const prepared=await prepareWeatherForVisit({...settings,weatherMode:'auto'},park,{signal});
    if(!current(token,park.id,settings.date))return;
    const {weatherMode,weather,weatherForecast,weatherNotice}=prepared;
    onUpdate({weatherMode,weather,weatherForecast,weatherNotice});status(weatherNotice);
  }));
  element('train').addEventListener('click',()=>perform(async({park,settings,history},token)=>{const tomorrow=dateOf(Date.now()+86400000),beforeDate=settings.date<tomorrow?settings.date:tomorrow;const model=trainWaitModel(history,park,{beforeDate,calendarData:settings.calendarData});if(!current(token,park.id,settings.date))return;onUpdate({waitModel:model});status(model.status==='trained'?'記録からモデルを更新しました。':'記録を集計しました。学習に必要な日数と件数を確認してください。');}));
  element('record').addEventListener('click',()=>{try{const {park,settings,history}=getContext(), wait=Number(element('wait').value),time=element('time').value;if(!time||!Number.isInteger(wait)||wait<0||wait>600)throw new Error('時刻と0〜600分の待ち時間を入力してください。');if(settings.date===dateOf(Date.now())&&Number(time.slice(0,2))*60+Number(time.slice(3))>minuteOf(Date.now()))throw new Error('まだ来ていない時刻は記録できません。');if(settings.date>dateOf(Date.now()))throw new Error('実際に訪れた日の待ち時間を記録してください。');const activity=park.activities.find(item=>item.id===element('activity').value);const row={date:settings.date,activityId:element('activity').value,openingMinute:activity?.dailySchedules?.[settings.date]?.windows?.[0]?.[0]??activity?.windows?.[0]?.[0]??540,time:Number(time.slice(0,2))*60+Number(time.slice(3)),wait,...observationWeather(settings.date,Number(time.slice(0,2))*60+Number(time.slice(3)),settings),event:(park.events||[]).filter(event=>event.startDate<=settings.date&&settings.date<=event.endDate).map(event=>event.id).join('|'),source:'user'};onUpdate({history:mergeObservations(history,[row])});status('待ち時間を記録しました。CSVでも保存できます。');render();}catch(error){status(error.message);}});
  element('export').addEventListener('click',()=>{downloadObservations(getContext().history||[]);status('記録CSVを保存しました。');});
  document.addEventListener('park-context-change',()=>{const {park,settings}=getContext(),key=[park.id,settings.date,settings.entry,settings.exit,settings.weatherMode,settings.weather].join('|');if(key!==contextKey){cancel();weatherResult=null;contextKey=key;}render();});
  const initial=getContext();contextKey=[initial.park.id,initial.settings.date,initial.settings.entry,initial.settings.exit,initial.settings.weatherMode,initial.settings.weather].join('|');render();
  return {refresh:render,cancel};
}
