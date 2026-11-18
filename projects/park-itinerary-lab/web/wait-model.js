/* Models use observed waits; unknown weather and missing historical days remain unknown. */
import {validCalendarDate as dateValid,minuteOf,finiteObservationNumber,calendarContext,weatherAtMinute,eventIdsFor,WAIT_BASE_FEATURE_NAMES,waitFeatures,visitDayContext,learnVisitFactors,VISIT_FACTOR_NAMES} from './calendar-features.js?v=2.2.1';
import {activityAvailable} from './operation-windows.js';
const MIN_DATES=7,MIN_SAMPLES=100,MAX_SAMPLES=50000;
const clipped=value=>Math.max(0,Math.min(600,Math.round(value)));
const weekdayLabels=['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'];

function legacyFeatures(row) {
  const day=new Date(row.date+'T12:00:00Z').getUTCDay(),phase=2*Math.PI*row.minute/1440;
  return [1,Math.sin(phase),Math.cos(phase),Number(day===0||day===6),Number(row.weather==='rain'),Number(row.weather==='cloud'),Number(!!row.event)];
}
function baseline(row,activity) {
  const day=new Date(row.date+'T12:00:00Z').getUTCDay(),hour=row.minute/60,time=hour<10?.8:hour<12?1.12:hour<16?1.2:hour<18?1.03:.82;
  return clipped(activity.baseWait*time*(day===0||day===6?1.18:1)*(row.weather==='rain'?.84:row.weather==='cloud'?.97:1)*(row.eventIds?.length?1.15:1));
}
function observations(history,park,beforeDate,calendarData) {
  const contexts = new Map();
  const activities=new Map(park.activities.map(activity=>[activity.id,activity])),dedup=new Map();
  for(const row of Array.isArray(history)?history:[]) {
    const activityId=row.activityId??row.activity_id??row.id,activity=activities.get(activityId),minute=minuteOf(row.time??row.minute),wait=finiteObservationNumber(row.wait??row.waitMinutes??row.wait_minutes);
    if(!activity||!dateValid(row.date)||row.date>=beforeDate||minute===null||wait===null||wait<0||wait>600||row.isOpen===false||['CLOSED','DOWN','REFURBISHMENT'].includes(row.status))continue;
    if (!contexts.has(row.date)) contexts.set(row.date,visitDayContext(row.date,park,calendarData));
    const issued=row.issuedVisitFactors;
    const events=Array.isArray(issued?.eventIds) ? issued.eventIds : eventIdsFor(row.date,park,row);
    const item={activityId,date:row.date,minute,wait,atIssue:!!issued,visitContext:issued?.inputs??contexts.get(row.date),weather:['sun','cloud','rain'].includes(row.weather)?row.weather:'',eventIds:events,temperature:finiteObservationNumber(row.temperature),precipitation:finiteObservationNumber(row.precipitation),openingMinute:minuteOf(row.openingMinute)};
    const opening=item.openingMinute??minuteOf(activity.windows?.[0]?.[0])??540,bucket=minute>=opening&&minute<opening+90?10:30;
    dedup.set([row.date,activityId,bucket,Math.floor(minute/bucket)].join('|'),item);
  }
  return [...dedup.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.minute-b.minute||a.activityId.localeCompare(b.activityId));
}
function balancedSample(rows,limit=MAX_SAMPLES) {
  if(limit===null||rows.length<=limit)return rows;
  const dates=[...new Set(rows.map(row=>row.date))],groups=new Map(dates.map(date=>[date,[]]));
  for(const row of rows)groups.get(row.date).push(row);
  const result=[],base=Math.floor(limit/dates.length),extra=limit%dates.length;
  for(let day=0;day<dates.length;day++){
    const group=groups.get(dates[day]),quota=Math.min(group.length,base+(day<extra?1:0));
    // Spread each day's quota over clock time and facilities; rotate the offset by date.
    const offset=[...dates[day]].reduce((sum,char)=>sum+char.charCodeAt(0),0)%997/997;
    for(let i=0;i<quota;i++)result.push(group[Math.min(group.length-1,Math.floor((i+offset)*group.length/quota))]);
  }
  return result;
}
function featureValues(row,activity,model) {
  return model.schemaVersion===1?legacyFeatures(row):waitFeatures(row,{eventIds:model.eventIds,calendarData:model.calendarData,activity,visitFactors:model.visitFactors});
}
function featureNames(eventIds, visitFactors = []) {
  return WAIT_BASE_FEATURE_NAMES.concat(visitFactors.map(item => item.name),eventIds.map(id => 'event:'+id));
}
function validVisitFactors(factors, days) {
  if (factors === undefined) return true;
  if (!Array.isArray(factors) || factors.length > VISIT_FACTOR_NAMES.length) return false;
  let last = -1;
  for (const factor of factors) {
    const order = VISIT_FACTOR_NAMES.indexOf(factor?.name);
    if (order <= last || !Number.isInteger(factor.days) || factor.days < 6 || factor.days > days ||
        !Number.isFinite(factor.mean) || !Number.isInteger(factor.min) || !Number.isInteger(factor.max) ||
        factor.min < 0 || factor.max > (factor.name.endsWith('_yen') ? 100000 : 1) ||
        !(factor.min < factor.mean && factor.mean < factor.max)) return false;
    last = order;
  }
  return true;
}
function fit(rows,park,model) {
  const activities=new Map(park.activities.map(activity=>[activity.id,activity])),count=model.featureNames.length;
  const index=new Map(model.activityIds.map((id,i)=>[id,count+i])),n=count+model.activityIds.length;
  const matrix=Array.from({length:n},()=>new Float64Array(n+1));
  for(let i=0;i<n;i++)matrix[i][i]=i===0?.01:10;
  for(const row of rows) {
    const activity=activities.get(row.activityId),values=featureValues(row,activity,model).map((value,i)=>[i,value]).filter(([,value])=>value!==0);values.push([index.get(row.activityId),1]);
    const target=row.wait/Math.max(5,Number(activity.baseWait)||0);
    for(const [i,x] of values){matrix[i][n]+=x*target;for(const [j,y] of values)matrix[i][j]+=x*y;}
  }
  for(let i=0;i<n;i++) {
    let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(matrix[j][i])>Math.abs(matrix[pivot][i]))pivot=j;
    [matrix[i],matrix[pivot]]=[matrix[pivot],matrix[i]];
    const divisor=matrix[i][i];for(let j=i;j<=n;j++)matrix[i][j]/=divisor;
    for(let k=0;k<n;k++)if(k!==i){const factor=matrix[k][i];if(!factor)continue;for(let j=i;j<=n;j++)matrix[k][j]-=factor*matrix[i][j];}
  }
  return matrix.map(row=>row[n]);
}
function regressionPrediction(row,activity,model) {
  const index=model.activityIds.indexOf(activity.id);if(index<0)return null;
  const values=featureValues(row,activity,model),ratio=values.reduce((sum,x,i)=>sum+x*model.coefficients[i],model.coefficients[values.length+index]);
  return Math.max(5,Number(activity.baseWait)||0)*ratio;
}
function predict(row,activity,model) {
  const raw=regressionPrediction(row,activity,model);if(raw===null)return null;
  const profiles=(model.activityTimeProfiles||[]).filter(item=>item.activityId===activity.id&&item.days>=3).sort((a,b)=>a.hour-b.hour),hour=row.minute/60;
  const before=profiles.filter(item=>item.hour<=hour).at(-1),after=profiles.find(item=>item.hour>=hour);
  let correction=0;
  if(before&&after&&after.hour-before.hour<=2)correction=after.hour===before.hour?before.correctionMinutes:before.correctionMinutes+(after.correctionMinutes-before.correctionMinutes)*(hour-before.hour)/(after.hour-before.hour);
  else if(before&&hour-before.hour<1)correction=before.correctionMinutes;
  else if(after&&after.hour-hour<1)correction=after.correctionMinutes;
  return clipped(raw+correction);
}
function timeProfiles(rows,park,model) {
  const activities=new Map(park.activities.map(item=>[item.id,item])),groups=new Map();
  for(const row of rows){const hour=Math.floor(row.minute/60),key=row.activityId+'|'+hour;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  return [...groups.values()].map(items=>{const first=items[0],activity=activities.get(first.activityId),days=new Set(items.map(item=>item.date)).size;
    const meanWait=items.reduce((sum,item)=>sum+item.wait,0)/items.length,residual=items.reduce((sum,item)=>sum+item.wait-regressionPrediction(item,activity,model),0)/items.length;
    return {activityId:first.activityId,hour:Math.floor(first.minute/60),samples:items.length,days,meanWait:Math.round(meanWait*10)/10,correctionMinutes:days<3?0:residual*items.length/(items.length+20)};
  }).filter(item=>item.samples>=5&&item.days>=2).sort((a,b)=>a.activityId.localeCompare(b.activityId)||a.hour-b.hour);
}
function grouped(rows,keyFor,labelFor,activities) {
  const groups=new Map();for(const row of rows){for(const key of [keyFor(row)].flat()){if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}}
  return [...groups].map(([key,items])=>({key:String(key),label:labelFor(key),samples:items.length,days:new Set(items.map(row=>row.date)).size,meanWait:items.length>=5&&new Set(items.map(row=>row.date)).size>=2?Math.round(items.reduce((sum,row)=>sum+row.wait,0)/items.length*10)/10:null,meanRatio:items.length>=5&&new Set(items.map(row=>row.date)).size>=2?Math.round(items.reduce((sum,row)=>sum+row.wait/Math.max(5,activities.get(row.activityId).baseWait||0),0)/items.length*1000)/1000:null}));
}
function numericCorrelation(rows,key,activities) {
  const values=rows.filter(row=>Number.isFinite(row[key])),days=new Set(values.map(row=>row.date)).size,n=values.length;
  let r=null;if(n>=20&&days>=3){const xs=values.map(row=>row[key]),ys=values.map(row=>row.wait/Math.max(5,activities.get(row.activityId).baseWait||0)),xm=xs.reduce((a,b)=>a+b,0)/n,ym=ys.reduce((a,b)=>a+b,0)/n;const xx=xs.reduce((s,x)=>s+(x-xm)**2,0),yy=ys.reduce((s,y)=>s+(y-ym)**2,0);if(xx>0&&yy>0)r=xs.reduce((s,x,i)=>s+(x-xm)*(ys[i]-ym),0)/Math.sqrt(xx*yy);}
  return {samples:n,days,r:r===null?null:Math.round(r*1000)/1000};
}
function correlations(rows,park,calendarData) {
  const activities=new Map(park.activities.map(item=>[item.id,item])),eventNames=new Map((park.events||[]).map(item=>[item.id,item.name]));
  return {units:'minutes',normalisation:'wait/baseWait',weekday:grouped(rows,row=>calendarContext(row.date)?.weekday,key=>weekdayLabels[key],activities).sort((a,b)=>+a.key-+b.key),month:grouped(rows,row=>calendarContext(row.date)?.month,key=>key+'月',activities).sort((a,b)=>+a.key-+b.key),weather:grouped(rows,row=>row.weather||'unknown',key=>({sun:'晴れ',cloud:'曇り',rain:'雨',unknown:'不明'})[key],activities),holiday:grouped(rows,row=>{const c=calendarContext(row.date,calendarData);return !c.holidayKnown?'unknown':c.isHoliday?'holiday':'ordinary';},key=>({holiday:'祝日・休日',ordinary:'祝日以外',unknown:'祝日情報の範囲外'})[key],activities),event:grouped(rows,row=>row.eventIds.length?row.eventIds:['none'],key=>key==='none'?'イベント記録なし':eventNames.get(key)||key,activities),temperature:numericCorrelation(rows,'temperature',activities),precipitation:numericCorrelation(rows,'precipitation',activities),note:'記録内の相関の傾向です。平均は5件以上・2日以上、数値の相関係数は20件以上・3日以上で表示します。施設ごとの基準値でも補正しますが因果関係は表しません。'};
}
function compactCalendar(calendarData,firstDate,beforeDate) {
  if(!calendarData||!Array.isArray(calendarData.holidays))return null;
  const start=new Date(Date.parse((firstDate||beforeDate)+'T12:00:00Z')-2*86400000).toISOString().slice(0,10),last=new Date(Date.parse(beforeDate+'T12:00:00Z')+2*366*86400000).toISOString().slice(0,10);
  const range = calendarData.coverage;
  const coverage = range && {startDate:range.startDate > start ? range.startDate : start,endDate:range.endDate < last ? range.endDate : last};
  return {...calendarData,coverage,holidays:calendarData.holidays.filter(item=>dateValid(item?.date)&&item.date>=start&&item.date<=last).map(item=>({date:item.date,name:String(item.name||'祝日').slice(0,100)}))};
}
/** Later dates are held out before the final refit; future or target-day rows never train a model. */
export function trainWaitModel(history,park,{beforeDate,trainedAt=new Date().toISOString(),calendarData,dataSources=[],sampleLimit=MAX_SAMPLES}={}) {
  if(!dateValid(beforeDate))throw new RangeError('学習の基準日をYYYY-MM-DDで指定してください。');
  if(sampleLimit!==null&&(!Number.isInteger(sampleLimit)||sampleLimit<MIN_SAMPLES||sampleLimit>MAX_SAMPLES))throw new RangeError('学習件数の上限を確認してください。');
  const available=observations(history,park,beforeDate,calendarData),rows=balancedSample(available,sampleLimit),dates=[...new Set(rows.map(row=>row.date))],eventIds=[...new Set(rows.flatMap(row=>row.eventIds))].sort().slice(0,60);
  const result={schemaVersion:2,method:'ridge-regression',parkId:park.id,status:'insufficient-data',usable:false,trainedAt,beforeDate,samples:rows.length,availableSamples:available.length,sampling:rows.length<available.length?'calendar-balanced':'all-eligible',days:dates.length,firstDate:dates[0]??null,lastDate:dates.at(-1)??null,minDays:MIN_DATES,minSamples:MIN_SAMPLES,featureNames:featureNames(eventIds),eventIds,activityIds:[],coefficients:[],validation:null,dataSources:dataSources.filter(source=>source&&typeof source.name==='string'&&typeof source.url==='string'&&/^https:\/\//.test(source.url)).map(source=>({name:source.name.slice(0,120),url:source.url.slice(0,2000),kind:String(source.kind||'observation').slice(0,100),attribution:String(source.attribution||source.name).slice(0,300)})).slice(0,20),calendarData:compactCalendar(calendarData,dates[0],beforeDate),activityTimeProfiles:[],correlations:correlations(rows,park,calendarData)};
  const issuedRows=rows.filter(row=>row.atIssue);
  result.issuedInputCoverage={days:new Set(issuedRows.map(row=>row.date)).size,samples:issuedRows.length,
    withWeather:issuedRows.filter(row=>row.weather || row.temperature!==null || row.precipitation!==null).length};
  result.visitFactorSupport = learnVisitFactors(rows).support;
  if(dates.length<MIN_DATES||rows.length<MIN_SAMPLES)return result;
  const split=dates.slice(-Math.max(2,Math.ceil(dates.length*.2)))[0],training=rows.filter(row=>row.date<split),testing=rows.filter(row=>row.date>=split);
  const trainEvents=[...new Set(training.flatMap(row=>row.eventIds))].sort().slice(0,60),activities=new Map(park.activities.map(activity=>[activity.id,activity]));
  const provisional = {...result,eventIds:trainEvents,featureNames:featureNames(trainEvents),activityIds:[...new Set(training.map(row=>row.activityId))].sort()};
  const evaluated=testing.filter(row=>provisional.activityIds.includes(row.activityId));if(!evaluated.length)return result;
  function holdoutError(instance) {
    instance.coefficients=fit(training,park,instance);
    instance.activityTimeProfiles=timeProfiles(training,park,instance);
    return evaluated.reduce((sum,row)=>sum+Math.abs(predict(row,activities.get(row.activityId),instance)-row.wait),0)/evaluated.length;
  }
  const previousFeatureMae = holdoutError(provisional);
  let modelMae = previousFeatureMae;
  // Estimate support and centring on the earlier training days alone. An unrepresented
  // factor cannot be selected on the later test days or introduced silently at final refit.
  const candidates = learnVisitFactors(training).factors.filter(factor =>
    new Set(evaluated.map(row=>row.visitContext[factor.name]).filter(Number.isFinite)).size >= 2);
  if (candidates.length) {
    const extended = {...provisional,visitFactors:candidates,featureNames:featureNames(trainEvents,candidates)};
    const candidateMae = holdoutError(extended);
    const adopted = candidateMae < previousFeatureMae;
    result.visitFactorValidation = {candidates:candidates.map(item=>item.name),previousFeatureMae,candidateMae,adopted};
    if (adopted) {
      result.visitFactors = candidates;
      result.featureNames = featureNames(eventIds,candidates);
      modelMae = candidateMae;
    }
  }
  const baselineMae=evaluated.reduce((sum,row)=>sum+Math.abs(baseline(row,activities.get(row.activityId))-row.wait),0)/evaluated.length;
  result.status='trained';result.usable=modelMae<=baselineMae;result.validation={method:'later-days-holdout',trainThrough:training.at(-1).date,testFrom:split,testThrough:dates.at(-1),trainSamples:training.length,testSamples:evaluated.length,modelMae,baselineMae,units:'minutes',unseenEvents:[...new Set(testing.flatMap(row=>row.eventIds))].filter(id=>!trainEvents.includes(id))};
  result.activityIds=[...new Set(rows.map(row=>row.activityId))].sort();result.coefficients=fit(rows,park,result);result.activityTimeProfiles=timeProfiles(rows,park,result);return result;
}
export function validateWaitModel(model) {
  const v=model?.validation,metrics=!!v&&v.method==='later-days-holdout'&&dateValid(v.trainThrough)&&dateValid(v.testFrom)&&dateValid(v.testThrough)&&v.trainThrough<v.testFrom&&v.testFrom<=v.testThrough&&Number.isFinite(v.modelMae)&&v.modelMae>=0&&Number.isFinite(v.baselineMae)&&v.baselineMae>=0&&Number.isInteger(v.testSamples)&&v.testSamples>0;
  if(!model||![1,2].includes(model.schemaVersion)||model.method!=='ridge-regression'||!['land','sea'].includes(model.parkId)||!['trained','insufficient-data'].includes(model.status)||!Array.isArray(model.activityIds)||model.activityIds.length>400||new Set(model.activityIds).size!==model.activityIds.length||!model.activityIds.every(id=>typeof id==='string'&&id.length<121)||!Array.isArray(model.coefficients)||model.coefficients.some(value=>!Number.isFinite(value)))return false;
  let count=7;
  if(model.dataSources!==undefined&&(!Array.isArray(model.dataSources)||model.dataSources.length>20||model.dataSources.some(source=>!source||typeof source.name!=='string'||source.name.length>120||typeof source.url!=='string'||source.url.length>2000||!/^https:\/\//.test(source.url)||typeof source.attribution!=='string'||source.attribution.length>300)))return false;
  if(model.schemaVersion===2){if(!Number.isInteger(model.samples)||model.samples<0||!Number.isSafeInteger(model.samples)||!Number.isInteger(model.days)||model.days<0||model.days>100000||typeof model.trainedAt!=='string'||!Number.isFinite(Date.parse(model.trainedAt))||!dateValid(model.beforeDate)||(model.lastDate!==null&&(!dateValid(model.lastDate)||model.lastDate>=model.beforeDate))||(model.status==='trained'&&(!dateValid(model.firstDate)||model.firstDate>model.lastDate||v?.testThrough>model.lastDate)))return false;if(!Array.isArray(model.featureNames)||!Array.isArray(model.eventIds)||model.eventIds.length>60||model.eventIds.some(id=>typeof id!=='string'||!id||id.length>120)||new Set(model.eventIds).size!==model.eventIds.length)return false;if(!validVisitFactors(model.visitFactors,model.days))return false;const expected=featureNames(model.eventIds,model.visitFactors);if(JSON.stringify(expected)!==JSON.stringify(model.featureNames))return false;count=expected.length;if(model.calendarData!==null&&model.calendarData!==undefined&&(!Array.isArray(model.calendarData.holidays)||model.calendarData.holidays.length>5000||model.calendarData.holidays.some(item=>!item||!dateValid(item.date)||typeof item.name!=='string'||item.name.length>120)))return false;if(model.activityTimeProfiles!==undefined&&(!Array.isArray(model.activityTimeProfiles)||model.activityTimeProfiles.length>9600||new Set(model.activityTimeProfiles.map(p=>p?.activityId+'|'+p?.hour)).size!==model.activityTimeProfiles.length||model.activityTimeProfiles.some(p=>!p||!model.activityIds.includes(p.activityId)||!Number.isInteger(p.hour)||p.hour<0||p.hour>23||!Number.isInteger(p.days)||p.days<1||!Number.isInteger(p.samples)||p.samples<1||!Number.isFinite(p.correctionMinutes)||Math.abs(p.correctionMinutes)>600||!Number.isFinite(p.meanWait)||p.meanWait<0||p.meanWait>600)))return false;}
  return model.status!=='trained'||(metrics&&model.coefficients.length===count+model.activityIds.length&&dateValid(model.lastDate)&&model.days>=MIN_DATES&&model.samples>=MIN_SAMPLES);
}
/** Predict at queue start using hourly weather and the same calendar/event encoding used for fitting. */
export function predictModelWait(activity,minute,settings,model,visitContext) {
  if(!Number.isInteger(minute)||minute<0||minute>1439||!validateWaitModel(model)||model.status!=='trained'||!model.usable||!dateValid(settings.date)||model.lastDate>=settings.date||!activity.id.startsWith(model.parkId+'-'))return null;
  const weather=weatherAtMinute(settings.date,minute,settings),eventIds=(settings.activeEvents||[]).map(event=>typeof event==='string'?event:event.id).filter(Boolean);
  const row={date:settings.date,minute,...weather,eventIds,event:eventIds.join('|'),visitContext};
  const activeModel=model.schemaVersion===2?{...model,calendarData:settings.calendarData||model.calendarData}:model;
  const value=predict(row,activity,activeModel);return value===null?null:{minutes:value,source:'ml',samples:model.samples,modelDays:model.days,validationMae:model.validation?.modelMae,unseenEvents:eventIds.filter(id=>model.schemaVersion===2&&!model.eventIds.includes(id))};
}

const parkCrowdHours = [10, 12, 14, 16, 18];
export function calendarCrowdLevel(calendar) {
  return calendar?.isHoliday || calendar?.weekday === 0 || calendar?.weekday === 6 ? 'busy' : 'normal';
}

/** Use the same date, facility and time coverage to select a source in the calendar and planner. */
function parkCrowdCoverage(park, settings, recordReference) {
  const model = settings.waitModel, date = settings.date;
  const calendarData = settings.calendarData || (model?.parkId === park.id ? model.calendarData : null);
  const calendar = calendarContext(date, calendarData);
  const fallback = {level:calendarCrowdLevel(calendar), source:'calendar', ratio:null, rides:0, slots:0, days:0, samples:0};
  const result = {source:'calendar', fallback, calendarData, comparisons:[], slots:0};
  if (!calendar || model?.parkId !== park.id || !validateWaitModel(model) ||
      model.schemaVersion !== 2 || !dateValid(model.lastDate) || model.lastDate >= date) return result;
  fallback.days = model.days;
  fallback.samples = model.samples;
  if (model.status !== 'trained' || model.usable !== true || model.validation.modelMae > model.validation.baselineMae) return result;

  // Avoid extrapolating seasonality to a month the training records hardly cover.
  const hasDays = (dimension, key, minimum) => Array.isArray(model.correlations?.[dimension]) &&
    model.correlations[dimension].some(group => group?.key === String(key) && Number.isInteger(group.days) && group.days >= minimum);
  const covered = hasDays('month', calendar.month, 2) && hasDays('weekday', calendar.weekday, 1) &&
    (!calendar.isHoliday || hasDays('holiday', 'holiday', 2));
  // A dated report can still evaluate a calendar forecast against pre-existing reference waits.
  if (!covered && !recordReference) return result;

  const profilesByRide = new Map();
  for (const profile of model.activityTimeProfiles || []) {
    if (!profilesByRide.has(profile.activityId)) profilesByRide.set(profile.activityId, []);
    profilesByRide.get(profile.activityId).push(profile);
  }
  const parkHours = park.operatingCalendar?.[date]?.windows;
  const covers = (windows, minute) => !windows || windows.some(([start, end]) => start <= minute && minute < end);
  const usedHours = new Set();
  for (const activity of park.activities) {
    const profiles = profilesByRide.get(activity.id);
    if (!profiles || activity.category !== 'attraction' || !activityAvailable(activity, date)) continue;
    const daily = activity.dailySchedules?.[date], datedWindows = daily?.windows || (activity.windowsDate === date ? activity.windows : null);
    const anchors = profiles.filter(profile => {
      const minute = profile.hour * 60 + 30;
      return parkCrowdHours.includes(profile.hour) && profile.samples >= 5 && profile.days >= 3 && profile.meanWait >= 10 &&
        covers(parkHours, minute) && covers(datedWindows, minute);
    });
    if (anchors.length < 2) continue;
    const ride = datedWindows ? {...activity, windows:datedWindows} : activity;
    result.comparisons.push({ride, profiles, anchors});
    result.slots += anchors.length;
    for (const profile of anchors) {
      usedHours.add(profile.hour);
      recordReference?.(activity.id, profile.hour * 60 + 30, profile.meanWait);
    }
  }
  if (covered && result.comparisons.length >= 3 && usedHours.size >= 3) result.source = 'model';
  return result;
}

/** Classify a date without calculating individual waits or consulting the network. */
export function parkCrowdSource(park, settings) {
  return parkCrowdCoverage(park, settings).source;
}

/** Compare each ride's forecast with its own observed means at the same hours.
 * This is a park-wide posted-wait index, independent of the visitor's wishlist.
 */
export function estimateParkCrowd(park, settings, recordReference) {
  const {source, fallback, calendarData, comparisons, slots} = parkCrowdCoverage(park, settings, recordReference);
  if (source === 'calendar') return fallback;
  const model = settings.waitModel, date = settings.date;
  const visitContext = model.visitFactors?.length ? visitDayContext(date,park,calendarData,settings.visitForecastAsOf ?? settings.waitAsOf ?? Date.now()) : null;
  const events = (park.events || []).filter(event => event.startDate <= date && date <= event.endDate).map(event => event.id);
  const ratios = [];
  for (const {ride, profiles, anchors} of comparisons) {
    const activeModel = {...model, calendarData, activityTimeProfiles:profiles};
    let expected = 0, usual = 0;
    for (const profile of anchors) {
      const minute = profile.hour * 60 + 30;
      const row = {date, minute, ...weatherAtMinute(date, minute, settings), eventIds:events, visitContext};
      expected += predict(row, ride, activeModel);
      usual += profile.meanWait;
    }
    ratios.push(expected / usual);
  }
  ratios.sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const ratio = ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2;
  const level = ratio <= 0.85 ? 'quiet' : ratio >= 1.15 ? 'busy' : 'normal';
  return {level, source:'model', ratio, rides:ratios.length, slots, days:model.days, samples:model.samples};
}
