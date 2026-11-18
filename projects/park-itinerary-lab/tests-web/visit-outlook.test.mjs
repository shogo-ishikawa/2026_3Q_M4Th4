import assert from 'node:assert/strict';
import test from 'node:test';
import {createVisitOutlook} from '../web/wait-data.js';
import {prepareWeatherForVisit} from '../web/weather.js';

const land={id:'land'}, sea={id:'sea'};
const settings={date:'2026-11-20',entry:540,exit:1260,weatherMode:'auto',weather:'sun'};

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

test('date preview and solve share pending requests and their settled weather and model',async()=>{
  const response=deferred(), model=deferred();
  let weatherCalls=0, modelCalls=0;
  const service=createVisitOutlook({
    prepareWeather:()=>{weatherCalls++;return response.promise;},
    loadModel:()=>{modelCalls++;return model.promise;},now:()=>12345,
  });
  const preview=service.resolve(land,settings);
  const solving=service.resolve(land,{...settings,selections:[{id:'land-a'}]});
  assert.equal(solving,preview);
  response.resolve({...settings,weather:'rain',weatherForecast:{date:settings.date,weather:'rain'}});
  model.resolve({parkId:'land'});
  const forecast=await preview.promise;
  assert.equal(forecast.weather,'rain');
  assert.equal(forecast.visitForecastAsOf,12345);
  assert.equal(forecast.waitModel.parkId,'land');
  assert.equal(service.resolve(land,{...settings,...forecast}).values,forecast);
  assert.deepEqual([weatherCalls,modelCalls],[1,1]);
});

test('a late request from a different visit day, park, time or mode cannot set the current outlook',async()=>{
  for(const [park,change] of [[sea,{}],[land,{date:'2026-11-21'}],[land,{entry:720}],[land,{weatherMode:'manual',weather:'cloud'}]]) {
    const responses=[];
    const service=createVisitOutlook({prepareWeather:(s,p,{signal})=>{
      const task=deferred();responses.push({task,signal});return task.promise;
    },loadModel:async()=>null});
    const oldRequest=service.resolve(land,settings), nextSettings={...settings,...change};
    const newRequest=service.resolve(park,nextSettings);
    assert.equal(responses[0].signal.aborted,true);
    responses[1].task.resolve({...nextSettings,weather:'cloud'});await newRequest.promise;
    responses[0].task.resolve({...settings,weather:'rain'});
    await assert.rejects(oldRequest.promise,{name:'AbortError'});
    assert.equal(oldRequest.values,null);
    assert.equal(newRequest.values.weather,'cloud');
  }
});

test('a failed forecast shares one fallback with an immediate solve and can recover later',async()=>{
  let now=0,calls=0;
  const profile={date:settings.date,provider:'open-meteo',hours:[{minute:600,weather:'rain',temperature:10}]};
  const service=createVisitOutlook({now:()=>now,loadModel:async()=>null,
    prepareWeather:(s,p,options)=>prepareWeatherForVisit(s,p,{...options,fetchWeatherImpl:async()=>{
      if(++calls===1)throw Error('offline');
      return profile;
    }})});
  const failed=await service.resolve(land,settings).promise;
  assert.equal(failed.weatherForecast,null);assert.match(failed.weatherNotice,/offline/);
  assert.equal(service.resolve(land,settings).values,failed);
  now=61000;
  assert.equal((await service.resolve(land,settings).promise).weather,'rain');
  const manual=await service.resolve(land,{...settings,weatherMode:'manual',weather:'cloud'}).promise;
  assert.equal(manual.weather,'cloud');assert.equal(manual.weatherForecast,null);
  assert.equal(calls,2);
});
