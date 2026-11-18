import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {calendarContext, longWeekendPosition, visitDayContext, learnVisitFactors} from '../web/calendar-features.js';
import {predictModelWait, trainWaitModel, validateWaitModel} from '../web/wait-model.js';
import {estimateWait, setWaitForecastContext} from '../web/planner.js';
import {forecastPark} from '../scripts/issue_wait_forecast.mjs';

const calendar={coverage:{startDate:'2026-01-01',endDate:'2027-12-31'},holidays:[
  {date:'2026-11-23',name:'勤労感謝の日'},{date:'2027-01-01',name:'元日'}
]};
const knownSince='2026-01-01T00:00:00Z';
const activity={id:'land-attraction-test',name:'テスト施設',category:'attraction',baseWait:40,cost:0,duration:10,windows:[[540,1260]]};
const fare = adultOneDayYen => ({adultOneDayYen,knownSince,sourceUrl:'https://www.tokyodisneyresort.jp/ticket/index.html'});
const makeDate=offset=>new Date(Date.UTC(2026,8,1+offset)).toISOString().slice(0,10);

test('weekends, national holidays and year boundaries identify 3-day starts, middles and ends',()=>{
  assert.deepEqual(['2026-11-20','2026-11-21','2026-11-22','2026-11-23','2026-11-24']
    .map(date=>longWeekendPosition(date,calendar)),['ordinary','first','middle','last','ordinary']);
  assert.deepEqual(['2026-11-14','2026-11-15'].map(date=>longWeekendPosition(date,calendar)),['ordinary','ordinary']);
  assert.equal(longWeekendPosition('2027-01-02',calendar),'middle');
  assert.equal(longWeekendPosition('2026-11-22',{...calendar,coverage:{startDate:'2026-11-22',endDate:'2026-11-24'}}),null);
  assert.equal(longWeekendPosition('2028-01-01',calendar),null);
  assert.equal(calendarContext('2026-11-22',calendar).isHoliday,false);
});

test('fares respect each field’s as-of, the park and the start of the visit in Japan',()=>{
  const date='2034-03-02';
  const park={id:'land',ticketCalendar:{[date]:{...fare(9000),studentOffer:true,studentOneDayYen:8100,
    adultKnownSince:'2034-02-20T09:00:00Z',studentKnownSince:'2034-02-22T00:00:00Z',studentPriceKnownSince:'2034-02-26T00:00:00Z'}}};
  const observed=at=>visitDayContext(date,park,null,Date.parse(at));
  assert.deepEqual(observed('2034-02-19T00:00:00Z'),{});
  assert.deepEqual(observed('2034-02-21T00:00:00Z'),{adult_ticket_yen:9000});
  assert.deepEqual(observed('2034-02-23T00:00:00Z'),{adult_ticket_yen:9000,student_offer:1});
  assert.equal(observed('2034-02-27T00:00:00Z').student_saving_yen,900);
  park.ticketCalendar[date].adultKnownSince='2034-03-01T16:00:00Z'; // Already 01:00 on the visit day
  assert.deepEqual(observed('2034-03-03T00:00:00Z'),{student_offer:1});
  assert.equal(visitDayContext(date,{id:'sea',ticketCalendar:{[date]:{...fare(8900),studentOffer:false}}},null).student_offer,0);
  assert.equal(visitDayContext(date,{id:'sea',ticketCalendar:{[date]:fare(8900)}},null).student_offer,undefined);
});

test('factor support counts independent dates, including known absences; unmatched prices stay unknown',()=>{
  const rows=[];
  for(let d=0;d<7;d++) for(let i=0;i<40;i++)
    rows.push({date:makeDate(d),visitContext:d===6?{}:{adult_ticket_yen:d<3?8000:9000,student_offer:Number(d===0)}});
  const {factors,support}=learnVisitFactors(rows);
  assert.deepEqual(support.adult_ticket_yen,{knownDays:6,levels:2,supportedLevels:2});
  assert.deepEqual(support.student_offer,{knownDays:6,levels:2,supportedLevels:1});
  assert.deepEqual(factors,[{name:'adult_ticket_yen',min:8000,max:9000,mean:8500,days:6}]);
});

function sample(reverseHoldout=false) {
  const rows=[], park={id:'land',activities:[activity],events:[],ticketCalendar:{}};
  for(let i=0;i<50;i++) {
    const date=makeDate(i),high=(i%3)===0;
    park.ticketCalendar[date]=fare(high?10000:8000);
    const wait=(reverseHoldout&&i>=40?!high:high)?85:15;
    for(let hour=9;hour<=19;hour++)rows.push({date,activityId:activity.id,time:hour*60,wait});
  }
  return {park,rows};
}
test('supported ticket-price effects must improve the same later days; browser and frozen issue agree',async()=>{
  const {park,rows}=sample(),date=makeDate(51),issuedAt=makeDate(50)+'T12:00:00Z';
  const model=trainWaitModel(rows,park,{beforeDate:makeDate(50),calendarData:calendar});
  assert.ok(model.usable);assert.ok(validateWaitModel(model));
  assert.equal(model.visitFactorValidation.adopted,true);
  assert.ok(model.visitFactors.some(item=>item.name==='adult_ticket_yen'));
  assert.ok(model.validation.modelMae < model.visitFactorValidation.previousFeatureMae);
  const waits={};
  for(const [label,price] of [['low',8000],['unknown',null],['high',10000],['outside',12000]]) {
    if (price) park.ticketCalendar[date]=fare(price); else delete park.ticketCalendar[date];
    const settings={date,waitAsOf:Date.parse(issuedAt),calendarData:calendar,waitModel:model,liveMode:'off',crowdLevel:'auto'};
    setWaitForecastContext(park,settings);
    waits[label]=estimateWait(activity,600,settings).minutes;
    const report=await forecastPark(park,{date,issuedAt,waitModel:model,calendarData:calendar,rideIds:new Set([activity.id])});
    assert.equal(report.rows.find(x=>x.minute===600).wait,estimateWait(activity,615,settings).minutes);
    assert.equal(report.visitDayFactors.inputs.adult_ticket_yen,price??undefined);
    assert.ok(report.visitDayFactors.modelFeatures.includes('adult_ticket_yen'));
  }
  assert.ok(waits.low < waits.unknown && waits.unknown < waits.high);
  assert.equal(waits.high,waits.outside); // No extrapolation beyond seen prices
});
test('worse held-out errors leave the prior features and legacy published model still validates',async()=>{
  const {park,rows}=sample(true), model=trainWaitModel(rows,park,{beforeDate:makeDate(50),calendarData:calendar});
  assert.equal(model.visitFactorValidation.adopted,false);
  assert.equal(model.visitFactors,undefined);
  const old=(JSON.parse(await readFile(new URL('../web/data/wait-model.json',import.meta.url)))).parks[0];
  assert.equal(validateWaitModel(old),true);
  const act={id:old.activityIds[0],windows:[[540,1260]],baseWait:40};
  const settings={date:'2026-12-01'};
  assert.deepEqual(predictModelWait(act,600,settings,old,{adult_ticket_yen:9900}),predictModelWait(act,600,settings,old));
  assert.equal(validateWaitModel({...old,visitFactors:[{name:'adult_ticket_yen',days:1,min:8000,max:9000,mean:8500}]}),false);
});

test('confirmed student discounts and middle holiday days enter a supported forecast together',()=>{
  const rows=[], park={id:'sea',activities:[{...activity,id:'sea-attraction-test'}],events:[],ticketCalendar:{}};
  const day=n=>new Date(Date.UTC(2033,0,1+n)).toISOString().slice(0,10);
  const holidays=[];
  for(let i=0;i<120;i++)if(new Date(day(i)+'T12:00:00Z').getUTCDay()===1 && Math.floor(i/7)%2===0)
    holidays.push({date:day(i),name:'テスト用祝日'});
  const fixtureCalendar={coverage:{startDate:'2032-01-01',endDate:'2034-12-31'},holidays};
  for(let i=0;i<120;i++) {
    const date=day(i), studentOffer=[0,1].includes(i%5);
    park.ticketCalendar[date]={...fare(9000),studentOffer};
    const middle=longWeekendPosition(date,fixtureCalendar)==='middle';
    const wait=20+(studentOffer?30:0)+(middle?35:0);
    for(let hour=9;hour<20;hour++)rows.push({date,activityId:park.activities[0].id,time:hour*60,wait});
  }
  const model=trainWaitModel(rows,park,{beforeDate:day(120),calendarData:fixtureCalendar});
  assert.ok(model.usable);
  const names=model.visitFactors.map(item=>item.name);
  assert.ok(names.includes('long_weekend_middle') && names.includes('student_offer'));
  assert.ok(!names.includes('adult_ticket_yen') && !names.includes('student_saving_yen'));
  const settings={date:day(122),calendarData:fixtureCalendar};
  const predict=context=>predictModelWait(park.activities[0],630,settings,model,context).minutes;
  assert.ok(predict({student_offer:1,long_weekend_middle:1}) > predict({student_offer:0,long_weekend_middle:1}));
  assert.ok(predict({student_offer:1,long_weekend_middle:1}) > predict({student_offer:1,long_weekend_middle:0}));
});

test('price variation first seen in held-out days is excluded from both selection and refit',()=>{
  const {rows,park}=sample();
  for(let i=0;i<40;i++)park.ticketCalendar[makeDate(i)]=fare(8000);
  const model=trainWaitModel(rows,park,{beforeDate:makeDate(50),calendarData:calendar});
  assert.equal(model.visitFactorSupport.adult_ticket_yen.supportedLevels,2);
  assert.ok(!model.visitFactors?.some(factor=>factor.name==='adult_ticket_yen'));
  assert.ok(!model.featureNames.includes('adult_ticket_yen'));
});
