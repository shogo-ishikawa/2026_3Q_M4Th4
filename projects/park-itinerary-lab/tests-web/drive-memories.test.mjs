import assert from 'node:assert/strict';
import test from 'node:test';
import {canViewPhoto, makeAlbumClient, photoVisits} from '../web/drive-memories.js';

const date = '2026-11-19';
const park = {id:'land',activities:[{id:'land-ride', name:'ライド'}, {id:'land-souvenir', name:'買い物'}, {id:'land-show', name:'公演'}]};
const plan = {parkId:'land',settings:{date},visits:[{activityId:'land-ride'},{activityId:'land-ride~2'}]};
const progress = {parkId:'land',date,visits:{'land-ride':{status:'done'},'land-souvenir':{status:'riding'},'land-show':{status:'skipped'}}};
const state = {parkId:'land',settings:{date,dayProgress:progress},result:plan};
const endpoint = 'https://script.google.com/macros/s/test-fixture/exec';
const response = value => ({ok:true, json:async () => value});

test('memory choices associate the correct day, park, activity and occurrence after replanning',() => {
  const choices = photoVisits(state,park);
  assert.deepEqual(choices.map(v => v.visitKey), ['free:1','land-ride:1','land-ride:2','land-souvenir:1'].map(k => date + ':land:' + k));
  assert.match(choices[2].label,/2回目/);
  const replan = {...state,settings:{date},result:{...plan,visits:[plan.visits[1], plan.visits[0]]}};
  assert.deepEqual(photoVisits(replan,park)[1],choices[2]);
  assert.equal(photoVisits({...state,settings:{...state.settings,date:'2026-11-20'}},park).length,1);
  assert.deepEqual(photoVisits({...state,parkId:'sea'},park),[]);
});

test('album API restricts the destination and sends a single authenticated simple POST',async () => {
  for (const bad of [endpoint.replace('https','http'),endpoint + '?x=1',endpoint + '#id',endpoint.replace('google.com','google.com.example'),endpoint.replace('/s/','/s//')]) {
    assert.throws(() => makeAlbumClient(bad,() => assert.fail()),{code:'invalid'});
  }
  const signal = new AbortController().signal;
  const request = makeAlbumClient(endpoint,async () => 'synthetic', async (url, options) => {
    assert.equal(url,endpoint);
    assert.deepEqual(options,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',
      headers:{'Content-Type':'text/plain;charset=UTF-8'},signal,body:options.body});
    assert.deepEqual(JSON.parse(options.body),{action:'list',idToken:'synthetic',albumId:'test'});
    return response({ok:true,photos:[]});
  });
  assert.deepEqual(await request('list',{albumId:'test',idToken:'overwritten'},signal),{ok:true,photos:[]});
});

test('an aborted account cannot send a token or display a late response',async () => {
  const first = new AbortController();
  const blocked = makeAlbumClient(endpoint,async () => { first.abort(); return 'synthetic'; }, () => assert.fail());
  await assert.rejects(blocked('albums',{},first.signal),{name:'AbortError'});
  const second = new AbortController();
  const late = makeAlbumClient(endpoint,async () => 'synthetic',() => ({ok:true,json:async () => { second.abort(); return {ok:true}; }}));
  await assert.rejects(late('image',{},second.signal),{name:'AbortError'});
  for (const [received,code] of [['forbidden','forbidden'],['unexpected server detail','offline']]) {
    const fail = makeAlbumClient(endpoint,async () => 'synthetic',async () => response({ok:false,error:received}));
    await assert.rejects(fail('image',{},new AbortController().signal),{code});
  }
});


test('private rows need explicit author access, including for an album owner',() => {
  const photo = {id:'1b66bdee-2f26-445d-9542-a61a968dc145',label:'夢の思い出',canDelete:true};
  assert.equal(canViewPhoto({...photo, visibility:'album',canSetVisibility:false}),true);
  assert.equal(canViewPhoto({...photo, visibility:'private',canSetVisibility:true}),true);
  for (const access of [
    {visibility:'private',canSetVisibility:false}, {visibility:'private',canSetVisibility:'true'},
    {visibility:'unknown',canSetVisibility:true}, {visibility:'album'}, {}, {canSetVisibility:true}
  ]) assert.equal(canViewPhoto({...photo,...access}),false);
});

test('the album must confirm photo visibility support before the editor opens',async () => {
  for (const version of [null,undefined,0,'1',2]) {
    const request = makeAlbumClient(endpoint,async () => 'synthetic',async () => response({ok:true,albums:[],visibilityVersion:version}));
    await assert.rejects(request('albums',{},new AbortController().signal),{code:'version'});
  }
  for (const version of [null,undefined,0,'2',1]) {
    const request = makeAlbumClient(endpoint,async () => 'synthetic',async () => response({ok:true,albums:[],visibilityVersion:1,albumVersion:version}));
    await assert.rejects(request('albums',{},new AbortController().signal),{code:'version'});
  }
  const request = makeAlbumClient(endpoint,async () => 'synthetic',async () => response({ok:true,albums:[],visibilityVersion:1,albumVersion:2}));
  assert.deepEqual((await request('albums',{},new AbortController().signal)).albums,[]);
});
