import { after, before, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, setDoc, setLogLevel,
} from 'firebase/firestore';

let environment;
let owner;
let other;
let guest;
let passwordUser;

function plan(database, id = 'saved-plan') {
  return doc(database, 'users', 'owner', 'plans', id);
}

function googleAccount(uid) {
  return environment.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' } }).firestore();
}

const original = { revision: 1, payload: '{"name":"夏のしおり"}' };

before(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  assert.match(host || '', /^127\.0\.0\.1:\d+$/, 'Start the local Firestore emulator with firebase emulators:exec');
  const projectId = 'demo-tdroute';
  assert.equal(process.env.GCLOUD_PROJECT, projectId);
  setLogLevel('silent');
  // Use the rules already loaded from firebase.json by the deployment CLI.
  environment = await initializeTestEnvironment({
    projectId, firestore: { host: '127.0.0.1', port: Number(host.split(':')[1]) },
  });
  owner = googleAccount('owner');
  other = googleAccount('other');
  guest = environment.unauthenticatedContext().firestore();
  passwordUser = environment.authenticatedContext('owner', { firebase: { sign_in_provider: 'password' } }).firestore();
  await assertSucceeds(setDoc(plan(owner), original));
});

after(async () => { await environment?.cleanup(); });

test('Google account can create, get and list its own plans', async () => {
  assert.deepEqual((await assertSucceeds(getDoc(plan(owner)))).data(), original);
  const result = await assertSucceeds(getDocs(collection(owner, 'users/owner/plans')));
  assert.ok(result.docs.some(snapshot => snapshot.id === 'saved-plan'));
  await assertSucceeds(setDoc(doc(other, 'users/other/plans/own'), original));
});

test('other users, signed-out users and non-Google sign-ins cannot read or write', async () => {
  for (const database of [other, guest, passwordUser]) {
    await assertFails(getDoc(plan(database)));
    await assertFails(getDocs(collection(database, 'users/owner/plans')));
    await assertFails(setDoc(plan(database, 'unauthorised'), original));
    await assertFails(setDoc(plan(database), { revision: 2, payload: '' }));
    await assertFails(deleteDoc(plan(database)));
  }
});

test('clients cannot enumerate all users or plans, or add arbitrary documents', async () => {
  await assertFails(getDocs(collection(owner, 'users')));
  await assertFails(getDocs(collectionGroup(owner, 'plans')));
  await assertFails(setDoc(doc(owner, 'users/owner'), { name: 'me' }));
  await assertFails(setDoc(doc(owner, 'training/observations'), { payload: 'private' }));
});

test('only the next integer revision can replace a plan, including a deletion marker', async () => {
  const ref = plan(owner, 'revision-check');
  await assertFails(setDoc(ref, { revision: 2, payload: 'first' }));
  await assertSucceeds(setDoc(ref, original));
  await assertFails(setDoc(ref, { revision: 3, payload: '' }));
  await assertSucceeds(setDoc(ref, { revision: 2, payload: '' }));
  await assertFails(setDoc(ref, { revision: 2, payload: 'stale' }));
  await assertFails(deleteDoc(ref));
  assert.deepEqual((await getDoc(ref)).data(), { revision: 2, payload: '' });
});

test('malformed or unexpected fields and out-of-range UTF-8 payloads are rejected', async () => {
  const ref = plan(owner, 'format-check');
  const full = 'あ'.repeat(266666) + 'ab';
  assert.equal(Buffer.byteLength(full), 800000);
  for (const invalid of [
    { ...original, owner: 'owner' }, { revision: 1 }, { payload: '' },
    { revision: '1', payload: '' }, { revision: 0.5, payload: '' },
    { revision: 1, payload: { freeText: 'x' } }, { revision: 1, payload: full + 'x' },
  ]) await assertFails(setDoc(ref, invalid));
  await assertSucceeds(setDoc(ref, { revision: 1, payload: full }));
});
