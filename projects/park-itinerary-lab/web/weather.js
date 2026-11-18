/** Forecast values retain the provider's original interval; missing values stay null. */
const PUBLISHED='https://raw.githubusercontent.com/shogo-ishikawa/2026_3Q_M4Th4/park-wait-data/weather-forecast.json';
const JMA_FORECAST='https://www.jma.go.jp/bosai/forecast/data/forecast/120000.json';
const JMA_SERIES='https://www.jma.go.jp/bosai/jmatile/data/wdist/VPFD/120010.json';
const JMA_SOURCE='https://www.jma.go.jp/bosai/forecast/#area_type=class20s&area_code=1222700';
const CACHE_KEY='park-weather-v150-start-hour';
const FRESH_MS=30*60000, MAX_AGE_MS=12*3600000;
const memory=new WeakMap();
const publishedBulletins=new WeakMap();
const labels={sun:'晴れ',cloud:'曇り',rain:'雨・雪の可能性'};
const icons={sun:'☀',cloud:'☁',rain:'☂'};
const dateOf=value=>new Date(new Date(value).getTime()+9*3600000).toISOString().slice(0,10);
export function forecastDateRange(now=Date.now()) {
  const time=new Date(now).getTime();
  if (!Number.isFinite(time)) return null;
  return {startDate:dateOf(time), endDate:dateOf(time+15*86400000)};
}
export function forecastDateInRange(date,now=Date.now()) {
  const range=forecastDateRange(now);
  if(!range||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const day=Date.parse(date+'T12:00Z');
  return Number.isFinite(day)&&new Date(day).toISOString().startsWith(date)&&date>=range.startDate&&date<=range.endDate;
}
/** JMA may publish the day's first bulletin after opening. Count only its stated interval. */
export function weatherRowInterval(row, date, entry, exit) {
  if (row.time && !String(row.time).startsWith(date + 'T')) return null;
  const start = Math.max(entry, row.minute, row.weatherFromMinute ?? 0);
  const end = Math.min(exit, row.endMinute ?? row.minute + 60, row.weatherToMinute ?? 1440);
  return start < end ? {start, end} : null;
}
const numeric=(value,min=-Infinity,max=Infinity)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null;
const jmaNumber=(value,min,max)=>value!==''&&value!==null&&value!==undefined?numeric(Number(value),min,max):null;
const minuteOf=value=>Number(value.slice(11,13))*60+Number(value.slice(14,16));
const clock=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
const interval=(start,end)=>`${clock(start)}〜${clock(end)}`;
const weatherFromCode=code=>code===0?'sun':code<=3||code===45||code===48?'cloud':'rain';
function openMeteoLabel(code) {
  if (code === 0) return '晴れ';
  if (code === 1) return 'おおむね晴れ';
  if (code === 2 || code === 3) return 'くもり';
  if (code === 45 || code === 48) return '霧';
  if ([71,73,75,77,85,86].includes(code)) return '雪';
  if ([95,96,99].includes(code)) return '雷雨';
  if ([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(code)) return '雨';
  return labels[weatherFromCode(code)];
}
const jmaWeather=code=>String(code).startsWith('1')?'sun':String(code).startsWith('2')?'cloud':'rain';
const weatherFromText=text=>/雨|雪/.test(text)?'rain':/晴/.test(text)?'sun':'cloud';
const aggregate=rows=>rows.some(row=>row.weather==='rain')?'rain':rows.some(row=>row.weather==='cloud')?'cloud':'sun';
const clone=value=>JSON.parse(JSON.stringify(value));
const aborted=()=>new DOMException('天気予報の取得を中止しました。','AbortError');
function checkAbort(signal){if(signal?.aborted)throw aborted();}
function ageOf(value,now){const age=now-Date.parse(value);return Number.isFinite(age)&&age>=-60000?Math.max(0,age):Infinity;}

/** The timeout also works with fetch implementations that do not honour AbortSignal. */
async function readJson(url,{signal,fetchImpl,timeoutMs}) {
  checkAbort(signal);
  const controller=new AbortController();let timer,abort;
  const interruption=new Promise((resolve,reject)=>{
    abort=()=>{controller.abort();reject(aborted());};
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{controller.abort();const error=new Error('通信がタイムアウトしました。もう一度お試しください。');error.name='TimeoutError';reject(error);},timeoutMs);
  });
  try {
    const data=await Promise.race([interruption,(async()=>{
      const response=await fetchImpl(url,{signal:controller.signal,cache:'no-cache'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      return response.json();
    })()]);
    checkAbort(signal);return data;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

function summarise(forecast,rows=forecast.hours) {
  if(!rows.length)throw new Error('指定した時間帯の天気予報がありません。');
  const weather=aggregate(rows);
  const minima=rows.map(row=>row.temperature??row.temperatureMin).filter(Number.isFinite);
  const maxima=rows.map(row=>row.temperature??row.temperatureMax).filter(Number.isFinite);
  const chances=rows.map(row=>row.precipitationProbability).filter(Number.isFinite);
  return {...forecast,weather,label:labels[weather],temperatureMin:minima.length?Math.min(...minima):null,temperatureMax:maxima.length?Math.max(...maxima):null,precipitationProbability:chances.length?Math.max(...chances):null};
}

export function normaliseOpenMeteo(data,date,{fetchedAt=new Date().toISOString(),transport='direct'}={}) {
  const hourly=data?.hourly;
  if(!Array.isArray(hourly?.time)||hourly.time.length>1000)throw new Error('Open-Meteoの予報形式を確認してください。');
  const timestamp=time=>typeof time==='string'?Date.parse(time+'+09:00'):NaN;
  const indexByTime=new Map(hourly.time.map((time,i)=>[timestamp(time),i]));
  const hours=[];
  for(let i=0;i<hourly.time.length;i++){
    const time=hourly.time[i],temperature=numeric(hourly.temperature_2m?.[i],-90,70),code=numeric(hourly.weather_code?.[i],0,99);
    if(typeof time!=='string'||!time.startsWith(date+'T')||temperature===null||code===null)continue;
    const minute=minuteOf(time),instant=timestamp(time);if(!Number.isFinite(instant)||!Number.isInteger(minute)||minute<0||minute>=1440)continue;
    // Accumulations/probabilities are end-labelled by Open-Meteo. The exact
    // following timestamp supplies this row's containing hour, without interpolation.
    const next=indexByTime.get(instant+3600000),period=interval(minute,minute+60);
    hours.push({time,minute,endMinute:minute+60,weather:weatherFromCode(code),label:openMeteoLabel(code),temperature,
      precipitation:numeric(hourly.precipitation?.[next],0,500),precipitationProbability:numeric(hourly.precipitation_probability?.[next],0,100),
      weatherPeriodLabel:`${clock(minute)}時点・1時間ごと`,temperaturePeriodLabel:`${clock(minute)}時点`,probabilityPeriodLabel:period+'（1時間）',precipitationPeriodLabel:period+'（1時間雨量）'});
  }
  return summarise({date,hours,provider:'open-meteo',sourceUrl:'https://open-meteo.com/',fetchedAt,transport,regionLabel:'パーク周辺'});
}

function shortArea(series,code){return series?.areas?.find(area=>area.area?.code===code);}
function dayIndex(series,date){return series?.timeDefines?.findIndex(time=>time.slice(0,10)===date)??-1;}
function jmaTemperatureRange(forecast,date){
  const short=forecast[0]?.timeSeries?.[2],station=shortArea(short,'45212');
  if(station&&short?.timeDefines?.some(time=>time.slice(0,10)===date)){
    // In this product 00:00 identifies the daily minimum and 09:00 the maximum,
    // rather than temperatures predicted at midnight and nine o'clock.
    const valueAt=hour=>{const i=short.timeDefines.findIndex(time=>time.startsWith(date+'T'+hour));return jmaNumber(station.temps?.[i],-90,70);};
    return {temperatureMin:valueAt('00:'),temperatureMax:valueAt('09:'),temperaturePeriodLabel:'千葉地点・日最低／最高'};
  }
  const weekly=forecast[1]?.timeSeries?.[1],index=dayIndex(weekly,date),area=weekly?.areas?.[0];
  return {temperatureMin:jmaNumber(area?.tempsMin?.[index],-90,70),temperatureMax:jmaNumber(area?.tempsMax?.[index],-90,70),temperaturePeriodLabel:`${area?.area?.name||'千葉県'}地点・日最低／最高`};
}

/** Official JSON: NW Chiba weather (3h/day), Chiba point temperature, PoP (6h/day). No rainfall amount. */
export function normaliseJma(forecast,series,date,{fetchedAt=new Date().toISOString(),transport='direct'}={}) {
  if(!Array.isArray(forecast)||forecast.length>5)throw new Error('気象庁の予報形式を確認してください。');
  const short=forecast[0]?.timeSeries,weekly=forecast[1]?.timeSeries;
  const shortIndex=dayIndex(short?.[0],date),weekIndex=dayIndex(weekly?.[0],date);
  const daily=shortIndex>=0?shortArea(short[0],'120010'):weekly?.[0]?.areas?.[0];
  const index=shortIndex>=0?shortIndex:weekIndex,code=daily?.weatherCodes?.[index];
  if(index<0||!/^[1-4]\d{2}$/.test(String(code)))throw new Error('指定した日の気象庁予報がありません。');
  const range=jmaTemperatureRange(forecast,date),hours=[];
  const weatherSeries=series?.areaTimeSeries,pointSeries=series?.pointTimeSeries;
  const sameIssue=series?.reportDateTime===forecast[0]?.reportDatetime;
  const weatherBands=sameIssue?(weatherSeries?.timeDefines||[]).flatMap((time,i)=>{
    const text=weatherSeries.weather?.[i];return typeof time.dateTime==='string'&&time.dateTime.startsWith(date+'T')&&typeof text==='string'&&time.duration==='PT3H'?[{minute:minuteOf(time.dateTime),text}]:[];
  }):[];
  const points=sameIssue&&pointSeries?.pointNameEN==='Chiba'?(pointSeries.timeDefines||[]).flatMap((time,i)=>{
    const temperature=numeric(pointSeries.temperature?.[i],-90,70);return typeof time.dateTime==='string'&&time.dateTime.startsWith(date+'T')&&temperature!==null?[{minute:minuteOf(time.dateTime),temperature}]:[];
  }):[];
  const popSeries=short?.[1],pops=shortArea(popSeries,'120010');
  for(let minute=0;minute<1440;minute+=60){
    const weatherBand=weatherBands.find(row=>minute>=row.minute&&minute<row.minute+180);
    const point=points.findLast(row=>row.minute<=minute&&minute<row.minute+180);
    const popIndex=popSeries?.timeDefines?.findIndex(time=>time.startsWith(date+'T')&&minute>=minuteOf(time)&&minute<minuteOf(time)+360)??-1;
    const chance=popIndex>=0?jmaNumber(pops?.pops?.[popIndex],0,100):jmaNumber(weekly?.[0]?.areas?.[0]?.pops?.[weekIndex],0,100);
    hours.push({time:`${date}T${clock(minute)}`,minute,endMinute:minute+60,weather:weatherBand?weatherFromText(weatherBand.text):jmaWeather(code),
      label:weatherBand?.text||(shortIndex>=0?daily.weathers?.[index]:null)||labels[jmaWeather(code)],temperature:point?.temperature??null,
      weatherFromMinute:weatherBand?.minute ?? minuteOf((shortIndex>=0?short:weekly)[0].timeDefines[index]),
      weatherToMinute:weatherBand?Math.min(1440,weatherBand.minute+180):1440,temperatureAtMinute:point?.minute??null,
      temperatureMin:range.temperatureMin,temperatureMax:range.temperatureMax,
      precipitationProbability:chance,precipitation:null,
      weatherPeriodLabel:weatherBand?`千葉県北西部・${interval(weatherBand.minute,weatherBand.minute+180)}（3時間）`:`${shortIndex>=0?'千葉県北西部':'千葉県'}・日予報`,
      temperaturePeriodLabel:point?`千葉地点・${clock(point.minute)}の予報（3時間ごと）`:range.temperaturePeriodLabel,
      probabilityPeriodLabel:popIndex>=0?interval(minuteOf(popSeries.timeDefines[popIndex]),minuteOf(popSeries.timeDefines[popIndex])+360)+'（6時間）':'千葉県・日予報',
      precipitationPeriodLabel:'未提供'});
  }
  return summarise({date,hours,provider:'jma',sourceUrl:JMA_SOURCE,fetchedAt,issuedAt:forecast[shortIndex>=0?0:1]?.reportDatetime,transport,regionLabel:'千葉県北西部・気温は千葉または銚子地点'});
}

function cacheFor(fetchImpl){let cache=memory.get(fetchImpl);if(!cache){cache=new Map();memory.set(fetchImpl,cache);}return cache;}
let savedWeatherText, savedWeatherDates;
function storedForecast(date,now){
  try{
    const text=globalThis.sessionStorage?.getItem(CACHE_KEY);
    if (!text) return null;
    if (text !== savedWeatherText) {
      savedWeatherDates=JSON.parse(text);
      savedWeatherText=text;
    }
    return usableWeatherForecast(savedWeatherDates?.[date],date,now) ? savedWeatherDates[date] : null;
  }catch{return null;}
}
export function usableWeatherForecast(forecast,date,now){
  if (!forecast || forecast.date !== date || !['open-meteo','jma'].includes(forecast.provider)) return false;
  if (ageOf(forecast.fetchedAt,now) > MAX_AGE_MS || (forecast.provider === 'jma' && ageOf(forecast.issuedAt,now) > 36*3600000)) return false;
  return Array.isArray(forecast.hours) && forecast.hours.length > 0 && forecast.hours.length <= 48 &&
    forecast.hours.every(row => Number.isInteger(row?.minute) && row.minute >= 0 && row.minute < 1440 && ['sun','cloud','rain'].includes(row.weather));
}
function saveForecast(cache,forecast,now,persist){
  const saved={...clone(forecast),cacheStoredAt:new Date(now).toISOString()};
  cache.set(forecast.date,saved);
  if(!persist)return;
  try{
    const previous=JSON.parse(globalThis.sessionStorage?.getItem(CACHE_KEY)||'{}'),kept={};
    for(const [date,value] of Object.entries(previous))if(usableWeatherForecast(value,date,now))kept[date]=value;
    kept[forecast.date]=saved;globalThis.sessionStorage?.setItem(CACHE_KEY,JSON.stringify(kept));
  }catch{/* A full or disabled session store does not prevent planning. */}
}
function cacheResult(forecast,now,stale=false){return {...clone(forecast),transport:stale?'last-good-cache':'session-cache',cacheAgeMinutes:Math.max(0,Math.floor(ageOf(forecast.fetchedAt,now)/60000)),stale};}

/** Both parks and every date use the same public file. A visit changing dates only
 * cancels that visit's wait; the shared download still has its own short deadline. */
function loadPublishedBulletin({fetchImpl, now, timeoutMs}) {
  let bulletin = publishedBulletins.get(fetchImpl);
  if (bulletin && now < bulletin.retryAt) return bulletin.request;
  if (!bulletin) {
    bulletin = {data:null, dates:new Map()};
    publishedBulletins.set(fetchImpl, bulletin);
  }
  bulletin.retryAt = now + FRESH_MS;
  bulletin.request = readJson(PUBLISHED, {fetchImpl, timeoutMs}).then(data => {
    if (data?.schemaVersion !== 1) throw new Error('公開済み予報の形式を確認してください。');
    bulletin.data = data;
    bulletin.dates.clear();
    return data;
  }).catch(error => {
    bulletin.retryAt = now + 60000;
    throw error;
  });
  return bulletin.request;
}

export async function warmCalendarWeather({fetchImpl=fetch, now=Date.now(), timeoutMs=4500}={}) {
  try { await loadPublishedBulletin({fetchImpl, now:Number(now), timeoutMs}); }
  catch { /* Previously fetched, unexpired dates remain available in the calendar. */ }
}

/** Read a date's forecast without contacting any provider. */
export function cachedForecastForDate(date, now=Date.now(), fetchImpl=fetch, useSessionCache=fetchImpl===globalThis.fetch) {
  if (!forecastDateInRange(date,now)) return null;
  const local = cacheFor(fetchImpl).get(date) || (useSessionCache && storedForecast(date,now));
  const bulletin = publishedBulletins.get(fetchImpl);
  let published = bulletin?.dates.get(date);
  if (bulletin?.data && (published === undefined || (published && !usableWeatherForecast(published,date,now)))) {
    try { published = weatherFromPublishedCache(bulletin.data,date,now); }
    catch { published = null; }
    bulletin.dates.set(date,published);
  }
  if (usableWeatherForecast(local,date,now) && (!published || Date.parse(local.fetchedAt) >= Date.parse(published.fetchedAt))) return local;
  return published || null;
}

async function publishedForecast(date,options){
  const {signal,now} = options;
  checkAbort(signal);
  let abort;
  try {
    const cancelled = new Promise((_,reject) => {
      abort = () => reject(aborted());
      signal.addEventListener('abort',abort,{once:true});
    });
    const data = await Promise.race([loadPublishedBulletin(options),cancelled]);
    return weatherFromPublishedCache(data,date,now);
  } finally {
    signal.removeEventListener('abort',abort);
  }
}

export function weatherFromPublishedCache(data,date,now,{strictAsOf=false}={}){
  if(data?.schemaVersion!==1)throw new Error('公開済み予報の形式を確認してください。');
  let firstError;
  for(const provider of ['open-meteo','jma']){
    const item=data.providers?.[provider];
    if(!item||ageOf(item.fetchedAt,now)>MAX_AGE_MS||(strictAsOf&&Date.parse(item.fetchedAt)>now))continue;
    try{
      const forecast=provider==='open-meteo'?normaliseOpenMeteo(item.data,date,{fetchedAt:item.fetchedAt,transport:'published-cache'}):normaliseJma(item.forecast,item.series,date,{fetchedAt:item.fetchedAt,transport:'published-cache'});
      if(provider==='jma'&&(ageOf(forecast.issuedAt,now)>36*3600000||(strictAsOf&&Date.parse(forecast.issuedAt)>now)))continue;
      return {...forecast,cacheAgeMinutes:Math.floor(ageOf(item.fetchedAt,now)/60000)};
    }catch(error){firstError??=error;}
  }
  throw firstError||new Error('新しい公開済み予報がありません。');
}

/** A selected-day request, a server cache, then an independent JMA fallback; each has a short deadline. */
export async function fetchWeather(date,{signal,fetchImpl=fetch,now=Date.now(),timeoutMs=4500,useSessionCache=fetchImpl===globalThis.fetch}={}) {
  now=new Date(now).getTime();checkAbort(signal);
  if(!forecastDateInRange(date,now))throw new RangeError('天気予報は今日から15日先まで取得できます。それ以外の日は天気を選んでください。');
  const cache=cacheFor(fetchImpl),previous=cache.get(date)||(useSessionCache?storedForecast(date,now):null);
  if(usableWeatherForecast(previous,date,now)&&ageOf(previous.cacheStoredAt||previous.fetchedAt,now)<FRESH_MS)return cacheResult(previous,now);
  const options={signal,fetchImpl,now,timeoutMs:Math.min(8000,Math.max(10,timeoutMs))};
  const url='https://api.open-meteo.com/v1/forecast?latitude=35.632&longitude=139.883&hourly=temperature_2m,precipitation,precipitation_probability,weather_code&start_date='+date+'&end_date='+date+'&timezone=Asia%2FTokyo';
  const requestController=new AbortController(),abort=()=>requestController.abort();
  signal?.addEventListener('abort',abort,{once:true});
  let forecast,firstError;
  try{
    const racing={...options,signal:requestController.signal};
    try{
      forecast=await Promise.any([
        readJson(url,racing).then(data=>normaliseOpenMeteo(data,date,{fetchedAt:new Date(now).toISOString()})),
        publishedForecast(date,racing)
      ]);
    }catch(error){checkAbort(signal);firstError=error.errors?.[0]||error;}
    requestController.abort();checkAbort(signal);
    if(!forecast&&date<=dateOf(now+7*86400000)){
      // Both endpoints return CORS headers on a GET with the browser Origin.
      const results=await Promise.allSettled([readJson(JMA_FORECAST,options),readJson(JMA_SERIES,options)]);
      checkAbort(signal);
      if(results[0].status==='fulfilled'){
        try{
          forecast=normaliseJma(results[0].value,results[1].status==='fulfilled'?results[1].value:null,date,{fetchedAt:new Date(now).toISOString()});
          if(ageOf(forecast.issuedAt,now)>36*3600000)throw new Error('気象庁の予報発表日時が古いため使用できません。');
        }catch(error){firstError??=error;forecast=null;}
      }
    }
    if(!forecast){
      const lastGood=cachedForecastForDate(date,now,fetchImpl,useSessionCache);
      if(lastGood)return {...cacheResult(lastGood,now,true),refreshFailure:firstError?.message||'通信失敗'};
      throw firstError||new Error('天気予報を取得できませんでした。');
    }
    checkAbort(signal);saveForecast(cache,forecast,now,useSessionCache);return clone(forecast);
  }finally{requestController.abort();signal?.removeEventListener('abort',abort);}
}

export function weatherForMinute(settings,minute){
  const forecast=settings?.weatherForecast;
  if(settings?.weatherMode==='manual'||forecast?.date!==settings?.date||!Array.isArray(forecast?.hours))return null;
  const row=forecast.hours.findLast(hour=>Number.isInteger(hour.minute)&&hour.minute<=minute&&minute<(hour.endMinute??hour.minute+60));
  if(!row)return null;
  return {...row,weather:row.weather,label:row.label||labels[row.weather],icon:icons[row.weather],temperature:numeric(row.temperature,-90,70),temperatureMin:numeric(row.temperatureMin,-90,70),temperatureMax:numeric(row.temperatureMax,-90,70),precipitationProbability:numeric(row.precipitationProbability,0,100),precipitation:numeric(row.precipitation,0,500),provider:forecast.provider,sourceUrl:forecast.sourceUrl,issuedAt:forecast.issuedAt,fetchedAt:forecast.fetchedAt};
}

/** Plain text shared by the itinerary, CSV and printable schedule. Callers escape HTML. */
export function formatWeatherDetails(info){
  if(!info)return '';
  const scope=value=>value?`（${value}）`:'';
  const temperature=Number.isFinite(info.temperature)?`${info.temperature}℃`:Number.isFinite(info.temperatureMin)&&Number.isFinite(info.temperatureMax)?`${info.temperatureMin}〜${info.temperatureMax}℃`:Number.isFinite(info.temperatureMax)?`最高${info.temperatureMax}℃`:Number.isFinite(info.temperatureMin)?`最低${info.temperatureMin}℃`:'未提供';
  const probability=Number.isFinite(info.precipitationProbability)?`${info.precipitationProbability}%`:'未提供';
  const precipitation=Number.isFinite(info.precipitation)?`${info.precipitation}mm`:'未提供';
  return `${info.icon||icons[info.weather]||''} ${info.label||labels[info.weather]||'未提供'}${scope(info.weatherPeriodLabel)} · 気温 ${temperature}${temperature==='未提供'?'':scope(info.temperaturePeriodLabel)} · 降水確率 ${probability}${probability==='未提供'?'':scope(info.probabilityPeriodLabel)} · 降水量 ${precipitation}${precipitation==='未提供'?'':scope(info.precipitationPeriodLabel)}`.trim();
}

export function forecastSourceLabel(forecast){return forecast.provider==='jma'?'気象庁（千葉県の予報）':'Open-Meteo（パーク周辺の予報）';}
export function forecastCacheLabel(forecast){
  if(forecast.stale)return `更新に失敗したため${forecast.cacheAgeMinutes}分前に取得した予報を使用`;
  if(forecast.transport==='published-cache')return `公開キャッシュ・取得から${forecast.cacheAgeMinutes}分`;
  if(forecast.transport==='session-cache')return `保存済み予報・取得から${forecast.cacheAgeMinutes}分`;
  return '取得完了';
}

/** Both browsing and selecting a day use the forecast for the same visit hours. */
export function weatherProfileForVisit(forecast,settings) {
  if(forecast.date!==settings.date)throw new Error('指定した日付と予報の日付が一致しません。');
  const duringVisit=forecast.hours.filter(hour=>weatherRowInterval(hour,settings.date,settings.entry,settings.exit));
  if(!duringVisit.length)throw new Error('滞在時間帯の予報がありません。');
  if(forecast.provider!=='jma'&&!duringVisit.some(row=>Number.isFinite(row.temperature)))throw new Error('気温を含む予報を取得できませんでした。');
  return summarise(forecast,duringVisit);
}

export async function prepareWeatherForVisit(settings,park,{signal,fetchWeatherImpl=fetchWeather}={}){
  const clean={...settings,weatherForecast:null};
  if(settings.weatherMode==='manual')return {...clean,weatherMode:'manual',weatherNotice:'天気は手動の設定を使います。'};
  try{
    const forecast=await fetchWeatherImpl(settings.date,{signal,park});checkAbort(signal);
    const profile=weatherProfileForVisit(forecast,settings);
    return {...clean,weatherMode:'auto',weather:profile.weather,weatherForecast:profile,weatherNotice:`天気予報を取得しました（${settings.date}・${forecastSourceLabel(profile)}）。滞在中の予報を計画に反映します。${forecastCacheLabel(profile)}。${profile.provider==='jma'?'天気は3時間または日単位、降水確率は6時間または日単位です。降水量は未提供です。':''}`};
  }catch(error){
    if(signal?.aborted||error.name==='AbortError')throw error;
    return {...clean,weatherMode:'auto',weatherNotice:`天気予報を取得できませんでした（${error.message}）。今回は「${{sun:'晴れ',cloud:'くもり',rain:'雨'}[settings.weather]||'天気'}」と仮定して計画します。`};
  }
}
