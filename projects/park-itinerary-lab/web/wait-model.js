/* Ridge regression fitted only to observed waits. No synthetic observations are shipped. */
const SCHEMA = 1;
const FEATURE_COUNT = 7;
const MIN_DATES = 7;
const MIN_SAMPLES = 100;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
const clipped = value => Math.max(0, Math.min(600, Math.round(value)));

function minuteOf(value) {
  if (Number.isInteger(value) && value >= 0 && value < 1440) return value;
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(String(value));
  return match && Number(match[1]) < 24 ? Number(match[1])*60+Number(match[2]) : null;
}
function features(row) {
  const day = new Date(row.date+'T12:00:00Z').getUTCDay();
  const phase = 2*Math.PI*row.minute/1440;
  return [1,Math.sin(phase),Math.cos(phase),Number(day===0||day===6),Number(row.weather==='rain'),Number(row.weather==='cloud'),Number(!!row.event)];
}
function baseline(row, activity) {
  const day = new Date(row.date+'T12:00:00Z').getUTCDay(), hour=row.minute/60;
  const time=hour<10?.8:hour<12?1.12:hour<16?1.2:hour<18?1.03:.82;
  return clipped(activity.baseWait*time*(day===0||day===6?1.18:1)*(row.weather==='rain'?.84:row.weather==='cloud'?.97:1)*(row.event?1.15:1));
}
function observations(history, park, beforeDate) {
  const activities = new Map(park.activities.map(activity=>[activity.id,activity]));
  const dedup=new Map();
  for(const row of Array.isArray(history)?history:[]) {
    const id=row.activityId??row.activity_id??row.id, activity=activities.get(id);
    const minute=minuteOf(row.time??row.minute), wait=Number(row.wait??row.waitMinutes??row.wait_minutes);
    if(!activity||!dateValid(row.date)||row.date>=beforeDate||minute===null||!Number.isFinite(wait)||wait<0||wait>600||row.isOpen===false)continue;
    // One observation per half hour prevents polling frequency from dominating training.
    dedup.set([row.date,id,Math.floor(minute/30)].join('|'),{activityId:id,date:row.date,minute,wait,weather:['sun','cloud','rain'].includes(row.weather)?row.weather:'',event:row.event||''});
  }
  return [...dedup.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.minute-b.minute||a.activityId.localeCompare(b.activityId)).slice(-50000);
}
function fit(rows, park, activityIds) {
  const activities=new Map(park.activities.map(activity=>[activity.id,activity]));
  const index=new Map(activityIds.map((id,i)=>[id,FEATURE_COUNT+i]));
  const n=FEATURE_COUNT+activityIds.length, matrix=Array.from({length:n},()=>Array(n+1).fill(0));
  for(let i=0;i<n;i++)matrix[i][i]=i===0?.01:10;
  for(const row of rows) {
    const values=features(row).map((value,i)=>[i,value]); values.push([index.get(row.activityId),1]);
    const y=row.wait/Math.max(5,Number(activities.get(row.activityId).baseWait)||0);
    for(const [i,x] of values){matrix[i][n]+=x*y;for(const [j,z] of values)matrix[i][j]+=x*z;}
  }
  // Gaussian elimination with pivoting; the positive ridge term keeps the matrix non-singular.
  for(let i=0;i<n;i++) {
    let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(matrix[j][i])>Math.abs(matrix[pivot][i]))pivot=j;
    [matrix[i],matrix[pivot]]=[matrix[pivot],matrix[i]];
    const divisor=matrix[i][i];for(let j=i;j<=n;j++)matrix[i][j]/=divisor;
    for(let k=0;k<n;k++)if(k!==i){const factor=matrix[k][i];for(let j=i;j<=n;j++)matrix[k][j]-=factor*matrix[i][j];}
  }
  return matrix.map(row=>row[n]);
}
function predict(row, activity, coefficients, activityIds) {
  const index=activityIds.indexOf(activity.id);if(index<0)return null;
  const ratio=features(row).reduce((sum,x,i)=>sum+x*coefficients[i],coefficients[FEATURE_COUNT+index]);
  return clipped(Math.max(5,Number(activity.baseWait)||0)*ratio);
}

/** Fit a real, regularised linear model and compare on later calendar days. */
export function trainWaitModel(history, park, {beforeDate,trainedAt=new Date().toISOString()}={}) {
  if(!dateValid(beforeDate))throw new RangeError('学習の基準日をYYYY-MM-DDで指定してください。');
  const rows=observations(history,park,beforeDate), dates=[...new Set(rows.map(row=>row.date))];
  const result={schemaVersion:SCHEMA,method:'ridge-regression',parkId:park.id,status:'insufficient-data',usable:false,trainedAt,beforeDate,samples:rows.length,days:dates.length,firstDate:dates[0]??null,lastDate:dates.at(-1)??null,minDays:MIN_DATES,minSamples:MIN_SAMPLES,activityIds:[],coefficients:[],validation:null};
  if(dates.length<MIN_DATES||rows.length<MIN_SAMPLES)return result;
  const holdoutDates=dates.slice(-Math.max(2,Math.ceil(dates.length*.2))), split=holdoutDates[0];
  const training=rows.filter(row=>row.date<split), testing=rows.filter(row=>row.date>=split);
  const activityIds=[...new Set(training.map(row=>row.activityId))].sort(), activities=new Map(park.activities.map(activity=>[activity.id,activity]));
  const coefficients=fit(training,park,activityIds);
  const evaluated=testing.filter(row=>activityIds.includes(row.activityId));
  if(!evaluated.length)return result;
  const modelMae=evaluated.reduce((sum,row)=>sum+Math.abs(predict(row,activities.get(row.activityId),coefficients,activityIds)-row.wait),0)/evaluated.length;
  const baselineMae=evaluated.reduce((sum,row)=>sum+Math.abs(baseline(row,activities.get(row.activityId))-row.wait),0)/evaluated.length;
  result.status='trained';result.usable=modelMae<=baselineMae;
  result.validation={method:'later-days-holdout',trainThrough:training.at(-1).date,testFrom:split,testThrough:dates.at(-1),trainSamples:training.length,testSamples:evaluated.length,modelMae,baselineMae,units:'minutes'};
  result.activityIds=[...new Set(rows.map(row=>row.activityId))].sort();result.coefficients=fit(rows,park,result.activityIds);
  return result;
}

export function validateWaitModel(model) {
  const validation=model?.validation;
  const validationValid=!!validation&&validation.method==='later-days-holdout'&&dateValid(validation.trainThrough)&&dateValid(validation.testFrom)&&dateValid(validation.testThrough)&&validation.trainThrough<validation.testFrom&&validation.testFrom<=validation.testThrough&&Number.isFinite(validation.modelMae)&&validation.modelMae>=0&&Number.isFinite(validation.baselineMae)&&validation.baselineMae>=0&&Number.isInteger(validation.testSamples)&&validation.testSamples>0;
  return !!model&&model.schemaVersion===SCHEMA&&model.method==='ridge-regression'&&['land','sea'].includes(model.parkId)&&['trained','insufficient-data'].includes(model.status)&&Array.isArray(model.activityIds)&&model.activityIds.length<=400&&new Set(model.activityIds).size===model.activityIds.length&&model.activityIds.every(id=>typeof id==='string'&&id.length<121)&&Array.isArray(model.coefficients)&&(model.status!=='trained'||(validationValid&&model.coefficients.length===FEATURE_COUNT+model.activityIds.length&&model.coefficients.every(Number.isFinite)&&dateValid(model.lastDate)&&model.days>=MIN_DATES&&model.samples>=MIN_SAMPLES));
}

/** Models trained on the target date or later are never used to predict that date. */
export function predictModelWait(activity, minute, settings, model) {
  if(!validateWaitModel(model)||model.status!=='trained'||!model.usable||!dateValid(settings.date)||model.lastDate>=settings.date||!activity.id.startsWith(model.parkId+'-'))return null;
  const event=(settings.activeEvents||[]).length?'event':'';
  const value=predict({date:settings.date,minute,weather:settings.weather,event},activity,model.coefficients,model.activityIds);
  return value===null?null:{minutes:value,source:'ml',samples:model.samples,modelDays:model.days,validationMae:model.validation?.modelMae};
}
