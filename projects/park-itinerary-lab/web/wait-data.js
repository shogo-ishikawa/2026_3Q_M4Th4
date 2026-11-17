import {trainWaitModel, validateWaitModel} from './wait-model.js';

const REMOTE='https://raw.githubusercontent.com/shogo-ishikawa/2026_3Q_M4Th4/park-wait-data/';
const QUEUE_URL='https://queue-times.com/';
const WEATHER_URL='https://open-meteo.com/';
const dateOf=value=>new Date(new Date(value).getTime()+9*3600000).toISOString().slice(0,10);
const minuteOf=value=>{const date=new Date(new Date(value).getTime()+9*3600000);return date.getUTCHours()*60+date.getUTCMinutes();};
const validTimestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const stamp=value=>validTimestamp(value)?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'更新日時なし';

export function validateLiveSnapshot(snapshot,parkId) {
  return !!snapshot&&snapshot.schemaVersion===1&&snapshot.provider==='queue-times'&&snapshot.parkId===parkId&&validTimestamp(snapshot.fetchedAt)&&Array.isArray(snapshot.rides)&&snapshot.rides.length<=400&&snapshot.rides.every(ride=>typeof ride.activityId==='string'&&ride.activityId.startsWith(parkId+'-')&&typeof ride.isOpen==='boolean'&&Number.isFinite(ride.wait)&&ride.wait>=0&&ride.wait<=600&&Number.isInteger(ride.providerId)&&validTimestamp(ride.updatedAt));
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
export function liveWaitFor(activity,minute,settings,{now=Date.now()}={}) {
  const snapshot=settings.liveData, current=new Date(now).getTime();
  if(settings.liveMode==='off'||settings.crowdMode==='manual'||!validateLiveSnapshot(snapshot,snapshot?.parkId)||dateOf(current)!==settings.date||!activity.id.startsWith(snapshot.parkId+'-'))return null;
  const ride=snapshot.rides.find(item=>item.activityId===activity.id);if(!ride)return null;
  const age=current-Date.parse(ride.updatedAt), collectedAge=current-Date.parse(snapshot.fetchedAt), currentMinute=minuteOf(current);
  if(age< -60000||collectedAge< -60000||age>15*60000||collectedAge>15*60000||minute<currentMinute||minute>currentMinute+60)return null;
  return {minutes:ride.wait,source:'live',samples:1,isOpen:ride.isOpen,updatedAt:ride.updatedAt,validUntilMinute:Math.min(1439,currentMinute+60)};
}
export function snapshotToHistory(snapshot,{weather='',event=''}={}) {
  if(!validateLiveSnapshot(snapshot,snapshot?.parkId))return [];
  return snapshot.rides.filter(ride=>ride.isOpen&&Date.parse(snapshot.fetchedAt)-Date.parse(ride.updatedAt)>=0&&Date.parse(snapshot.fetchedAt)-Date.parse(ride.updatedAt)<=15*60000).map(ride=>({date:dateOf(ride.updatedAt),activityId:ride.activityId,time:minuteOf(ride.updatedAt),wait:ride.wait,weather,event,source:'queue-times',observedAt:ride.updatedAt}));
}
export function mergeObservations(existing,incoming) {
  const rows=new Map();for(const row of [...(existing||[]),...(incoming||[])]){
    const time=typeof row.time==='string'?Number(row.time.slice(0,2))*60+Number(row.time.slice(3)):row.time;
    rows.set([row.date,row.activityId,Math.floor(time/30)].join('|'),row);
  }return [...rows.values()].slice(-50000);
}
function weatherFromCode(code){return code===0?'sun':code<=3||code===45||code===48?'cloud':'rain';}
export async function fetchWeather(date,{signal,fetchImpl=fetch,now=Date.now(),timeoutMs=15000}={}) {
  const today=dateOf(now), last=dateOf(new Date(now).getTime()+15*86400000);
  if(date<today||date>last)throw new RangeError('天気予報は今日から15日先まで取得できます。それ以外の日は天気を選んでください。');
  const url='https://api.open-meteo.com/v1/forecast?latitude=35.632&longitude=139.883&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=16&timezone=Asia%2FTokyo';
  const data=await readJson(url,signal,fetchImpl,timeoutMs), hourly=data.hourly;
  if(!Array.isArray(hourly?.time))throw new Error('天気予報の形式を確認してください。');
  const hours=hourly.time.map((time,i)=>({time,minute:Number(time.slice(11,13))*60,weather:weatherFromCode(hourly.weather_code?.[i]),temperature:hourly.temperature_2m?.[i],precipitationProbability:hourly.precipitation_probability?.[i]})).filter(row=>row.time.startsWith(date)&&Number.isFinite(row.temperature));
  const visit=hours.filter(row=>row.minute>=9*60&&row.minute<=21*60);if(!visit.length)throw new Error('指定した日の天気予報がありません。');
  const weather=visit.some(row=>row.weather==='rain')?'rain':visit.some(row=>row.weather==='cloud')?'cloud':'sun';
  return {date,weather,label:{sun:'晴れ',cloud:'曇り',rain:'雨・雪の可能性'}[weather],temperatureMin:Math.min(...visit.map(row=>row.temperature)),temperatureMax:Math.max(...visit.map(row=>row.temperature)),precipitationProbability:Math.max(...visit.map(row=>row.precipitationProbability??0)),hours,provider:'open-meteo',sourceUrl:WEATHER_URL,fetchedAt:new Date(now).toISOString()};
}
export async function fetchPublishedModel(park,{signal,fetchImpl=fetch,timeoutMs=15000}={}) {
  for(const url of [REMOTE+'wait-model.json',new URL('./data/wait-model.json',import.meta.url).href]){
    try{const data=await readJson(url,signal,fetchImpl,timeoutMs),model=data.parks?.find(item=>item.parkId===park.id);if(validateWaitModel(model))return model;}catch(error){if(error.name==='AbortError')throw error;}
  }return null;
}
export function buildObservationCsv(rows) {
  const fields=['date','activityId','time','wait','weather','event'];
  const cell=value=>{const text=String(value??'');return '"'+(/^[\s]*[=+\-@\t\r]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';};
  return '\ufeff'+[fields.join(','),...rows.map(row=>fields.map(key=>cell(key==='time'&&Number.isInteger(row.time)?String(Math.floor(row.time/60)).padStart(2,'0')+':'+String(row.time%60).padStart(2,'0'):row[key])).join(','))].join('\r\n');
}
function downloadObservations(rows) {
  const url=URL.createObjectURL(new Blob([buildObservationCsv(rows)],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='park-wait-observations.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function describeWaitModel(model) {
  if(!model)return 'まだ学習モデルを読み込んでいません。';
  const counts=`${model.days}日・${model.samples}件の記録`;
  if(model.status!=='trained')return `${counts}。7日以上かつ100件以上たまると学習します。今は傾向モデルを使います。`;
  const metrics=model.validation;if(!metrics||!Number.isFinite(metrics.modelMae)||!Number.isFinite(metrics.baselineMae))return counts+'。検証値がないため傾向モデルを使います。';
  return `${counts}で学習。後の日付を検証に使った平均絶対誤差は${Number(metrics.modelMae).toFixed(1)}分。傾向モデルは${Number(metrics.baselineMae).toFixed(1)}分。${model.usable?'検証で改善した学習モデルを使います。':'検証で改善しなかったため傾向モデルを使います。'}`;
}
export function shouldUsePublishedModel(existing,published,parkId) {
  return !!published&&validateWaitModel(published)&&published.parkId===parkId&&(!existing||existing.parkId!==parkId||(!existing.usable&&published.usable)||((published.usable||!existing.usable)&&Date.parse(published.trainedAt)>Date.parse(existing.trainedAt)));
}
/** A self-contained panel; settings and observations remain owned by the application. */
export function initialiseExternalData({container,getContext,onUpdate}) {
  if(!container)return;
  let generation=0,weatherResult=null,busy=false,contextKey='',modelRequest=0;
  container.innerHTML=`<h3>待ち時間と天気を更新</h3><p>来園前は学習モデルや履歴から予測します。記録が少ない場合は傾向モデルを使います。当日は更新から15分以内の待ち時間を直近1時間の計画に使います。</p><div class="field-grid"><label>当日の情報<select data-external="liveMode"><option value="auto">新しい待ち時間を使う</option><option value="off">予測だけを使う</option></select></label></div><div class="actions"><button type="button" data-external="refresh">最新の待ち時間を取得</button><button type="button" data-external="weather">天気予報を取得</button><button type="button" data-external="train">記録から学習し直す</button><button type="button" data-external="export">記録CSVを保存</button></div><p data-external="status" role="status" aria-live="polite"></p><p data-external="live"></p><p><a href="${QUEUE_URL}" target="_blank" rel="noopener">Powered by Queue-Times.com</a> · <a href="https://yosocal.com/" target="_blank" rel="noopener">混雑予想カレンダー</a> · <a data-external="comparison" href="https://queue-times.com/ja/parks/274/calendar" target="_blank" rel="noopener">過去の混雑を見る</a> · <a data-external="disneyreal" href="https://disneyreal.asumirai.info/realtime/disneyland-wait-today.html" target="_blank" rel="noopener">ディズニーリアル</a></p><p data-external="weatherResult"></p><p data-external="model"></p><details><summary>予測モデルと自分の記録</summary><p>施設・時刻・曜日・天気・イベントを説明変数とするリッジ回帰です。最後の約20%の日付を検証に回します。誤差が傾向モデルより小さいときに採用します。今日の記録は明日以降の予測に生かします。</p><div class="field-grid"><label>記録する施設<select data-external="activity"></select></label><label>並び始めた時刻<input type="time" data-external="time"></label><label>実際の待ち時間（分）<input type="number" min="0" max="600" step="1" value="30" data-external="wait"></label></div><button type="button" data-external="record">この待ち時間を記録</button></details>`;
  const element=name=>container.querySelector(`[data-external="${name}"]`);
  const status=message=>{element('status').textContent=message;};
  function render() {
    const {park,settings}=getContext();if(!park)return;
    element('liveMode').value=settings.liveMode||'auto';
    const snapshot=settings.liveData;
    if(snapshot?.parkId===park.id){const age=Date.now()-Date.parse(snapshot.fetchedAt);element('live').textContent=`取得 ${stamp(snapshot.fetchedAt)} · ${snapshot.rides.length}施設。${dateOf(Date.now())!==settings.date?'訪問日が今日ではないため予測を使います。':age>15*60000?'15分以上前のため予測を使います。':'新しい情報を直近の予定に使えます。'}${snapshot.transport==='bundled'?' 配布時の記録を表示しています。':''}`;}else element('live').textContent='待ち時間はまだ取得していません。';
    element('model').textContent=describeWaitModel(settings.waitModel);
    element('comparison').href=`https://queue-times.com/ja/parks/${park.id==='land'?274:275}/calendar`;
    element('disneyreal').href=`https://disneyreal.asumirai.info/realtime/${park.id==='land'?'disneyland':'disneysea'}-wait-today.html`;
    const activity=element('activity'), selected=activity.value;
    activity.innerHTML=park.activities.filter(item=>['attraction','greeting','restaurant','cafe'].includes(item.category)).map(item=>`<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');if([...activity.options].some(option=>option.value===selected))activity.value=selected;
    if(!element('time').value){const minute=minuteOf(Date.now());element('time').value=String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');}
    element('weatherResult').innerHTML=weatherResult?`${escape(weatherResult.date)}：${escape(weatherResult.label)} ${weatherResult.temperatureMin}〜${weatherResult.temperatureMax}℃ · 降水確率最大${weatherResult.precipitationProbability}% · <a href="${WEATHER_URL}" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>（予報を晴れ・曇り・雨に集約）`:'';
  }
  async function perform(action) {
    if(busy)return;busy=true;const token=++generation, context=getContext();status('取得・処理中です。');
    try{await action(context,token);}catch(error){if(token===generation)status('更新できませんでした。'+error.message);}finally{busy=false;if(token===generation)render();}
  }
  const current=(token,parkId,date)=>token===generation&&getContext().park.id===parkId&&getContext().settings.date===date;
  element('liveMode').addEventListener('change',()=>{onUpdate({liveMode:element('liveMode').value});render();});
  element('refresh').addEventListener('click',()=>perform(async({park,settings,history},token)=>{
    const [snapshot,publishedModel]=await Promise.all([fetchLiveWaits(park),fetchPublishedModel(park)]);if(!current(token,park.id,settings.date))return;
    const activeEvent=(park.events||[]).filter(event=>event.startDate<=dateOf(Date.now())&&dateOf(Date.now())<=event.endDate).map(event=>event.id).join('|');
    const rows=mergeObservations(getContext().history,snapshotToHistory(snapshot,{weather:weatherResult?.date===dateOf(Date.now())?weatherResult.weather:'',event:activeEvent}));
    const usePublished=shouldUsePublishedModel(getContext().settings.waitModel,publishedModel,park.id);onUpdate({liveData:snapshot,history:rows,...(usePublished?{waitModel:publishedModel}:{})});status(snapshot.transport==='bundled'?'配布時の記録を読み込みました。更新日時を確認してください。':'公開された最新の記録を読み込みました。');
  }));
  element('weather').addEventListener('click',()=>perform(async({park,settings},token)=>{const result=await fetchWeather(settings.date);if(!current(token,park.id,settings.date))return;weatherResult=result;onUpdate({weather:result.weather});status('天気予報を計画条件に反映しました。');}));
  element('train').addEventListener('click',()=>perform(async({park,settings,history},token)=>{const beforeDate=settings.date<dateOf(Date.now())?settings.date:dateOf(Date.now());const model=trainWaitModel(history,park,{beforeDate});if(!current(token,park.id,settings.date))return;onUpdate({waitModel:model});status(model.status==='trained'?'記録からモデルを更新しました。':'記録を集計しました。学習に必要な日数と件数を確認してください。');}));
  element('record').addEventListener('click',()=>{try{const {park,settings,history}=getContext(), wait=Number(element('wait').value),time=element('time').value;if(!time||!Number.isInteger(wait)||wait<0||wait>600)throw new Error('時刻と0〜600分の待ち時間を入力してください。');if(settings.date===dateOf(Date.now())&&Number(time.slice(0,2))*60+Number(time.slice(3))>minuteOf(Date.now()))throw new Error('まだ来ていない時刻は記録できません。');if(settings.date>dateOf(Date.now()))throw new Error('実際に訪れた日の待ち時間を記録してください。');const row={date:settings.date,activityId:element('activity').value,time:Number(time.slice(0,2))*60+Number(time.slice(3)),wait,weather:settings.weather,event:(park.events||[]).filter(event=>event.startDate<=settings.date&&settings.date<=event.endDate).map(event=>event.id).join('|'),source:'user'};onUpdate({history:mergeObservations(history,[row])});status('待ち時間を記録しました。CSVでも保存できます。');render();}catch(error){status(error.message);}});
  element('export').addEventListener('click',()=>{downloadObservations(getContext().history||[]);status('記録CSVを保存しました。');});
  function loadModel(){const {park,settings}=getContext();if(!park||settings.waitModel?.parkId===park.id)return;const token=++modelRequest;fetchPublishedModel(park).then(model=>{const current=getContext();if(model&&token===modelRequest&&current.park.id===park.id&&current.settings.date===settings.date&&shouldUsePublishedModel(current.settings.waitModel,model,park.id)){onUpdate({waitModel:model});render();}}).catch(()=>{});}
  document.addEventListener('park-context-change',()=>{const {park,settings}=getContext(),key=park.id+'|'+settings.date;if(key!==contextKey){generation++;weatherResult=null;contextKey=key;loadModel();}render();});
  const initial=getContext();contextKey=initial.park.id+'|'+initial.settings.date;render();loadModel();
  return {refresh:render};
}
