import assert from 'node:assert/strict';
import test from 'node:test';
import {readFirebaseConfig, connectFirebase} from '../web/firebase-sync.js';

const config = {apiKey: 'test-key', projectId: 'demo-tdroute', authDomain: 'demo-tdroute.firebaseapp.com', appId: '1:123:web:test'};
const plan = {id:'plan-test', name:'午後のシー', createdAt:'2026-11-19T01:00:00Z', updatedAt:'2026-11-19T01:00:00Z', state:{parkId:'sea'}};
const googleUser = () => ({uid:'a', displayName:'Alice', providerData:[{providerId:'google.com'}], issuer:'google.com'});
const document = (id, data) => ({id, exists:() => data !== undefined, data:() => data});

async function fixture(user = googleUser()) {
  const loaded = [];
  const records = new Map();
  const calls = [];
  const listeners = new Set();
  const auth = {currentUser: user, async authStateReady() {}};
  const sdk = {
    app: {initializeApp() {return {};}},
    auth: {
      initializeAuth() {return auth;},
      GoogleAuthProvider: class { setCustomParameters(options) {assert.equal(options.prompt, 'select_account');} },
      signInWithPopup() {calls.push('popup');},
      getIdTokenResult: async user => {
        if (user.tokenError) throw Object.assign(new Error(), {code:user.tokenError});
        return {signInProvider:user.issuer};
      },
      onIdTokenChanged(_auth, next) {
        listeners.add(next);
        queueMicrotask(() => next(auth.currentUser));
        return () => listeners.delete(next);
      },
      signOut() {
        auth.currentUser = null;
        return Promise.all([...listeners].map(next => next(null)));
      }
    },
    firestore: {
      initializeFirestore(_app, options) {assert.equal(options.localCache, 'memory'); return {};},
      memoryLocalCache: () => 'memory',
      doc: (_db, ...segments) => segments.join('/'),
      collection: (_db, ...segments) => segments.join('/'),
      getDocsFromServer: async path => ({
        docs:[...records.entries()].filter(([key]) => key.startsWith(path + '/')).map(([key, value]) => document(key.split('/').at(-1), value))
      }),
      runTransaction: (_db, run) => run({
        get: async ref => document(ref.split('/').at(-1), records.get(ref)),
        set: (ref, data) => records.set(ref, data)
      })
    }
  };
  const adapter = await connectFirebase(config, async name => {loaded.push(name); return sdk[name];});
  const initial = await new Promise(resolve => adapter.observeUser(resolve));
  return {adapter, initial, sdk, calls, loaded, auth, records};
}

test('only public project options are used, and no SDK is needed to detect missing config', async () => {
  const read = value => readFirebaseConfig(async (url, options) => {
    assert.equal(url.pathname.split('/').at(-1), 'firebase-config.json');
    assert.equal(options.credentials, 'omit');
    return {ok:true, json:async () => value};
  });
  assert.equal(await read({}), null);
  assert.deepEqual(await read({...config, measurementId:'G-test'}), config);
  await assert.rejects(read({...config, authDomain:'not-a-domain/path'}), {code:'sync/config'});
  await assert.rejects(connectFirebase({}, () => assert.fail('loaded SDK without config')), {code:'sync/config'});
});

test('only an active Google sign-in enables personal sync, including for linked accounts', async () => {
  for (const user of [null, {...googleUser(), isAnonymous:true}, {...googleUser(), issuer:'password'}]) {
    const {adapter, initial, loaded} = await fixture(user);
    assert.equal(initial, null);
    await assert.rejects(adapter.list('a'), {code:'sync/account'});
    assert.deepEqual(loaded, ['app', 'auth']);
  }
  const {adapter, initial, loaded, calls} = await fixture();
  assert.deepEqual(initial, {uid:'a', displayName:'Alice', isOwner:false});
  assert.deepEqual(loaded, ['app', 'auth']);
  const action = adapter.signIn();
  assert.deepEqual(calls, ['popup']);
  await action;
  await assert.rejects(adapter.list('other'), {code:'sync/account'});
  await adapter.signOut();
  await assert.rejects(adapter.write('a', plan.id, 0, plan), {code:'sync/account'});
});

test('a fingerprint lookup failure keeps the account name private and does not block sync', async t => {
  t.mock.method(globalThis.crypto.subtle, 'digest', async () => { throw Error('Unavailable'); });
  const {adapter, initial} = await fixture();
  assert.deepEqual(initial, {uid: 'a', displayName: '', isOwner: false});
  assert.deepEqual(await adapter.list('a'), []);
});

test('offline restoration only recognises the previous Google credential for this project and SDK user', async () => {
  const claims = {sub:'a', aud:config.projectId, iss:`https://securetoken.google.com/${config.projectId}`, firebase:{sign_in_provider:'google.com'}};
  for (const [patch, allowed] of [[{}, true], [{aud:'another-project'}, false], [{sub:'b'}, false], [{iss:'another-issuer'}, false], [{firebase:{sign_in_provider:'password'}}, false]]) {
    const token = 'header.' + Buffer.from(JSON.stringify({...claims,...patch})).toString('base64url') + '.signature';
    const user = {...googleUser(), tokenError:'auth/network-request-failed', toJSON:() => ({stsTokenManager:{accessToken:token}})};
    assert.equal((await fixture(user)).initial?.uid ?? null, allowed ? 'a' : null);
  }
});

test('optimistic writes, same-id conflicts and deletion tombstones use one account path', async () => {
  const {adapter, records, loaded} = await fixture();
  assert.deepEqual(await adapter.list('a'), []);
  assert.deepEqual(loaded, ['app', 'auth', 'firestore']);
  assert.deepEqual(await adapter.write('a', plan.id, 0, {...plan, privateDeviceKey:'skip'}), {ok:true,revision:1});
  const original = {id:plan.id,revision:1,plan};
  const key = 'users/a/plans/' + plan.id;
  assert.deepEqual(records.get(key), {revision:1,payload:JSON.stringify(plan)});
  assert.deepEqual(await adapter.write('a', plan.id, 0, {...plan, name:'conflicting change'}), {ok:false,current:original});
  assert.deepEqual(await adapter.list('a'), [original]);
  assert.deepEqual(await adapter.write('a', plan.id, 1, null), {ok:true,revision:2});
  assert.deepEqual(records.get(key), {revision:2,payload:''});
  const deleted = {id:plan.id,revision:2,plan:null};
  assert.deepEqual(await adapter.write('a', plan.id, 1, plan), {ok:false,current:deleted});
  assert.deepEqual(await adapter.list('a'), [deleted]);
  assert.deepEqual(await adapter.write('a', 'other', 0, null), {ok:true,revision:1});
});

test('transaction and remote reads reject stale identities, invalid IDs and oversized UTF-8', async () => {
  const {adapter, sdk, auth, records} = await fixture();
  await assert.rejects(adapter.write('a', 'nested/path', 0, null), {code:'sync/data'});
  await assert.rejects(adapter.write('a', plan.id, 0, {...plan, state:{text:'六'.repeat(267000)}}), {code:'sync/size'});
  sdk.firestore.runTransaction = (_db, run) => run({
    async get() {auth.currentUser = null; return document(plan.id, undefined);},
    set() {assert.fail('no write after account changed');}
  });
  await assert.rejects(adapter.write('a', plan.id, 0, plan), {code:'sync/account'});
  assert.equal(records.size, 0);

  const read = await fixture();
  read.sdk.firestore.getDocsFromServer = async () => {
    read.auth.currentUser = null;
    return {docs:[document(plan.id, {revision:1,payload:JSON.stringify(plan)})]};
  };
  await assert.rejects(read.adapter.list('a'), {code:'sync/account'});
});

test('a first Firestore import failure can be retried without disturbing sign-in', async () => {
  const {adapter,sdk,loaded} = await fixture();
  const init = sdk.firestore.initializeFirestore;
  sdk.firestore.initializeFirestore = () => {throw new Error('transient');};
  await assert.rejects(adapter.list('a'), /transient/);
  sdk.firestore.initializeFirestore = init;
  assert.deepEqual(await adapter.list('a'), []);
  assert.deepEqual(loaded, ['app','auth','firestore','firestore']);
});
