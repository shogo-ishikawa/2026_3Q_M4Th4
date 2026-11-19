import test from 'node:test';
import assert from 'node:assert/strict';
import {companionEmail, companionStore, timetablePayload} from '../web/companion-view.js';

const id = 'sample';
const email = 'friend@dept.example.ac.jp';
const plan = {name:'同行者の計画',updatedAt:'2026-11-19T10:00:00Z',state:{parkId:'sea',
  settings:{date:'2026-11-19',budget:12345, history:[{secret:'exclude'}], purchases:[{label:'private'}],
    dayProgress:{date:'2026-11-19',parkId:'sea',visits:{ride:{status:'queue',startedAt:600,endsAt:650,privateNote:'private'}}}},
  result:{status:'feasible',rows:[{kind:'activity',start:650,end:657,name:'乗りもの',cost:2000,privateNote:'private'}]},
  parkStates:{land:{privateKey:'other park'}}}};

test('timetable has only the public schedule and records for its day/park', () => {
  const raw = timetablePayload(plan), view = JSON.parse(raw);
  assert.deepEqual(view.rows,[{name:'乗りもの',start:650,end:657}]);
  assert.deepEqual(view.records,[{id:'ride',status:'queue',start:600,end:650}]);
  assert.doesNotMatch(raw,/budget|private|cost|purchase|12345|other park|history/);
  const other = structuredClone(plan); other.state.settings.dayProgress.date = '2026-11-18';
  assert.deepEqual(JSON.parse(timetablePayload(other)).records,[]);
  other.state.result = null; assert.deepEqual(JSON.parse(timetablePayload(other)).rows,[]);
  const oversized = structuredClone(plan);
  oversized.state.result.rows = Array(2000).fill({name:'大'.repeat(100),start:600,end:610});
  assert.equal(JSON.parse(timetablePayload(oversized)).tooLarge,true);
});

test('Google Workspace addresses are valid, independent of domain, while directory separators are rejected', () => {
  assert.equal(companionEmail(' Friend@Dept.Example.ac.JP '),email);
  assert.equal(companionEmail('a+trip@gmail.com'),'a+trip@gmail.com');
  for (const invalid of ['a@b', '/x@example.jp', 'a@b@c.jp', 'bad address@example.jp'])
    assert.throws(()=>companionEmail(invalid));
});

function fixture() {
  const owner = 'creator';
  const db = new Map(), watchers = new Map();
  const doc = (_,...parts)=>parts.join('/');
  const snap = ref => ({exists:()=>db.has(ref),data:()=>db.get(ref),metadata:{fromCache:false},id:ref.split('/').at(-1)});
  const tx = {get:async ref=>snap(ref),set:(ref,value)=>db.set(ref,value),delete:ref=>db.delete(ref)};
  const sdk = {doc,collection:doc,runTransaction:(_,fn)=>fn(tx),onSnapshot(ref,_,fn){watchers.set(ref,fn);return ()=>watchers.delete(ref);}};
  let account = owner;
  const store = companionStore({store:async()=>({sdk,db}),requireAccount(uid){assert.equal(uid,account,'changed account');},
    current:()=>({emailVerified:true,email:'own@example.jp'})});
  db.set('users/creator/plans/sample',{revision:1,payload:JSON.stringify(plan)});
  return {db,store,sdk,tx,owner,watchers,signOut(){account=null;}};
}

test('invite, save, rename, revoke and remove keep the named plan and each guest inbox consistent',async () => {
  const {db,store,sdk,tx,owner} = fixture();
  const inbox = 'tripInboxes/'+email+'/invitations/creator~sample';
  const audience = 'users/creator/livePlanAudiences/sample';
  const view = 'users/creator/liveTimetables/sample';
  await store.changeMember(owner,id,email,true);
  await store.changeMember(owner,id,email,true);
  assert.deepEqual(db.get(audience),{members:[email]});
  assert.deepEqual(db.get(inbox),{owner,planId:id,name:plan.name});
  assert.equal(db.get(view).view,timetablePayload(plan));
  const updated = {...plan,name:'改名したしおり'};
  await store.updateSharedCopy(sdk,db,tx,owner,id,plan,updated);
  assert.equal(db.get(inbox).name,updated.name);
  assert.equal(db.get(view).view,timetablePayload(updated));
  await store.changeMember(owner,id,email,false);
  assert.equal(db.has(inbox)||db.has(audience)||db.has(view),false);
  await store.changeMember(owner,id,email,true);
  await store.changeMember(owner,id,'other@example.jp',true);
  await store.updateSharedCopy(sdk,db,tx,owner,id,plan,null);
  assert.equal(db.size,1);
  assert.equal(db.has('users/creator/plans/sample'),true);
});

test('a stale/cached or signed-out snapshot is never shown as fresh', async () => {
  const {store,owner,watchers,signOut} = fixture();
  const received = [], errors = [];
  const close = store.watchView(owner,{owner,planId:id},v=>received.push(v),e=>errors.push(e));
  await Promise.resolve(); await Promise.resolve();
  const send = watchers.get('users/creator/liveTimetables/sample');
  const snap = fromCache=>({metadata:{fromCache},exists:()=>true,data:()=>({view:timetablePayload(plan)})});
  send(snap(true)); assert.deepEqual(received,[null]);
  send(snap(false)); assert.equal(received[1].name,plan.name);
  signOut(); send(snap(false)); assert.equal(received.length,2); assert.equal(errors.length,1);
  close(); send(snap(false)); assert.equal(watchers.size,0); assert.equal(errors.length,1);
});
