import test from 'node:test';
import assert from 'node:assert/strict';
import {initialiseExternalData,prepareLiveForReplan,currentRideStatus} from '../web/wait-data.js';

class Control extends EventTarget {
 constructor(){super();this.value='';this.disabled=false;this._html='';this.textContent='';this.options=[];}
 set innerHTML(value){this._html=value;this.options=[...value.matchAll(/<option value="([^"]+)"/g)].map(match=>({value:match[1]}));if(this.options.length&&!this.value)this.value=this.options[0].value;}
 get innerHTML(){return this._html;}
}
function panel(){const controls=new Map();return {controls,innerHTML:'',querySelector(selector){const key=/data-external="([^"]+)"/.exec(selector)[1];if(!controls.has(key))controls.set(key,new Control());return controls.get(key);},querySelectorAll(){return [...controls.values()];}};}
const moment=Date.parse('2026-11-17T01:00:00Z');
const park={id:'land',activities:[{id:'land-a',name:'A',category:'attraction',baseWait:10}],events:[]};
const hourly={time:['2026-11-17T09:00','2026-11-17T17:00'],temperature_2m:[15,18],weather_code:[61,2],precipitation:[2,0],precipitation_probability:[90,20]};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function withEnvironment(run){
 const saved={document:globalThis.document,fetch:globalThis.fetch,now:Date.now};globalThis.document=new EventTarget();Date.now=()=>moment;
 try{await run();}finally{globalThis.document=saved.document;globalThis.fetch=saved.fetch;Date.now=saved.now;}
}

test('manual forecast button synchronises edited visit hours and shares plan preparation',()=>withEnvironment(async()=>{
 const container=panel();let settings={date:'2026-11-17',entry:540,exit:1260,weatherMode:'manual',weather:'sun'},sync=0,patch;
 globalThis.fetch=async url=>({ok:true,json:async()=>String(url).includes('api.open-meteo.com')?{hourly}:{parks:[]}});
 initialiseExternalData({container,getContext:()=>({park,settings,history:[]}),beforeAction:()=>{sync++;settings={...settings,entry:1020,exit:1080};},onUpdate:value=>{patch=value;settings={...settings,...value};}});
 container.controls.get('weather').dispatchEvent(new Event('click'));await settle();
 assert.equal(sync,1);assert.equal(patch.weatherMode,'auto');assert.equal(patch.weather,'cloud');assert.equal(patch.weatherForecast.temperatureMin,18);assert.equal(patch.weatherForecast.precipitationProbability,20);
 assert.match(container.controls.get('status').textContent,/予報を取得しました/);
}));
test('starting a new plan cancels a pending manual forecast without applying its late result',()=>withEnvironment(async()=>{
 const container=panel();const settings={date:'2026-11-17',entry:540,exit:1260,weatherMode:'auto',weather:'sun'};let updates=0,aborted=false;
 globalThis.fetch=async(url,{signal}={})=>String(url).includes('api.open-meteo.com')?new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'));},{once:true})):{ok:true,json:async()=>({parks:[]})};
 const api=initialiseExternalData({container,getContext:()=>({park,settings,history:[]}),onUpdate:()=>updates++});
 container.controls.get('weather').dispatchEvent(new Event('click'));api.cancel();await settle();
 assert.equal(aborted,true);assert.equal(updates,0);assert.equal(container.controls.get('weather').disabled,false);assert.match(container.controls.get('status').textContent,/中止しました/);
}));
test('explicit forecast failure clears stale weather and leaves a visible retry message',()=>withEnvironment(async()=>{
 const container=panel();let patch;const settings={date:'2026-11-17',entry:540,exit:1260,weatherMode:'auto',weather:'sun',weatherForecast:{date:'2026-11-17'}};
 globalThis.fetch=async url=>String(url).includes('api.open-meteo.com')?{ok:false,status:503}:{ok:true,json:async()=>({parks:[]})};
 initialiseExternalData({container,getContext:()=>({park,settings,history:[]}),onUpdate:value=>patch=value});
 container.controls.get('weather').dispatchEvent(new Event('click'));await settle();
 assert.equal(patch.weatherForecast,null);assert.match(container.controls.get('status').textContent,/取得できませんでした.*503/);
}));

test('manual live refresh clears a confirmed reopening hold before a later offline replan',()=>withEnvironment(async()=>{
 const container=panel();const activity={id:'land-attraction-153',name:'A',category:'attraction',baseWait:20};const currentPark={...park,activities:[activity]};
 let settings={date:'2026-11-17',entry:540,exit:1260,replanFrom:660,weatherMode:'auto',weather:'sun',operationalHolds:{date:'2026-11-17',activityIds:[activity.id],observedAt:'2026-11-17T00:00:00Z'}};
 const payload={id:'3cc919f1-d16d-43e0-8c3f-1dd269bd1a42',liveData:[{entityType:'ATTRACTION',externalId:'153',status:'OPERATING',lastUpdated:'2026-11-17T00:59:00Z',queue:{STANDBY:{waitTime:10}}}]};
 globalThis.fetch=async url=>({ok:true,json:async()=>String(url).includes('api.themeparks.wiki')?payload:{parks:[]}});
 let complete;const updated=new Promise(resolve=>complete=resolve);
 initialiseExternalData({container,getContext:()=>({park:currentPark,settings,history:[]}),onUpdate:value=>{settings={...settings,...value};complete();}});
 container.controls.get('refresh').dispatchEvent(new Event('click'));await updated;
 assert.equal(settings.operationalHolds,null);assert.equal(currentRideStatus(activity,settings,{now:moment}).isOpen,true);
 const later=moment+16*60000;
 const offline=await prepareLiveForReplan(settings,currentPark,{now:later,fetchRealtimeWaitsImpl:async()=>{throw Error('offline');}});
 assert.equal(offline.operationalHolds,null);assert.equal(currentRideStatus(activity,offline,{now:later}),null);
}));
