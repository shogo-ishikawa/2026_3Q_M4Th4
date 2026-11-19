import { after, before, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, setDoc, setLogLevel, writeBatch,
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

function companion(uid, email, verified = true, provider = 'google.com') {
  return environment.authenticatedContext(uid, {
    email, email_verified: verified, firebase: {sign_in_provider: provider},
  }).firestore();
}

const university = 'visitor@campus.example.ac.jp';
function liveRefs(db, id, email = university, uid = 'owner') {
  return {
    audience: doc(db, 'users', uid, 'livePlanAudiences', id),
    timetable: doc(db, 'users', uid, 'liveTimetables', id),
    inbox: collection(db, 'tripInboxes', email, 'invitations'),
    invite: doc(db, 'tripInboxes', email, 'invitations', uid + '~' + id),
  };
}
function invitation(id) {
  return {owner:'owner', planId:id, name:'日帰りのしおり'};
}
async function publishPlan(id) {
  const refs = liveRefs(owner, id);
  // The first invitation may be submitted in the same transaction as the audience.
  const batch = writeBatch(owner);
  batch.set(plan(owner, id), original);
  batch.set(refs.audience, {members:[university]});
  batch.set(refs.timetable, {view:'公開する予定だけ'});
  batch.set(refs.invite, invitation(id));
  await assertSucceeds(batch.commit());
  return refs;
}

test('a verified Workspace Google account can discover and follow only its own invitation', async () => {
  const id = 'workspace-visit';
  const refs = await publishPlan(id);
  const member = companion('visitor', 'Visitor@Campus.Example.ac.jp');
  const theirs = liveRefs(member, id);
  assert.ok((await assertSucceeds(getDocs(theirs.inbox))).docs.some(d => d.id === 'owner~' + id));
  assert.deepEqual((await assertSucceeds(getDoc(theirs.timetable))).data(), {view:'公開する予定だけ'});
  await assertSucceeds(setDoc(refs.timetable, {view:'午後の新しい予定'}));
  assert.equal((await assertSucceeds(getDoc(theirs.timetable))).data().view, '午後の新しい予定');
  await assertFails(getDoc(plan(member, id)));
  await assertFails(getDoc(theirs.audience));
  assert.ok((await assertSucceeds(getDocs(collection(owner,'users/owner/livePlanAudiences')))).docs.some(d => d.id === id));
  await assertFails(getDocs(collection(member,'users/owner/livePlanAudiences')));
  await assertFails(getDocs(collectionGroup(owner,'livePlanAudiences')));
  await assertFails(getDocs(collection(member, 'users/owner/liveTimetables')));
  await assertFails(getDocs(collection(member, 'tripInboxes/else@example.org/invitations')));
  await assertFails(getDocs(collectionGroup(member, 'invitations')));
  await assertFails(setDoc(theirs.timetable, {view:'書き換え'}));
  await assertFails(setDoc(theirs.audience, {members:['else@example.org']}));
  await assertFails(setDoc(theirs.invite, invitation(id)));
  await assertFails(deleteDoc(theirs.invite));
  for (const forbidden of [
    companion('uninvited', 'someone@example.org'),
    companion('unverified', university, false),
    companion('not-google', university, true, 'password'),
    guest,
  ]) {
    await assertFails(getDoc(liveRefs(forbidden, id).timetable));
    await assertFails(getDocs(liveRefs(forbidden, id).inbox));
  }
});

test('revocation, even if only one side was removed, and legacy deletion stop access', async () => {
  const member = companion('visitor-revoke', university);
  for (const action of ['revoke-invite', 'revoke-audience', 'legacy-delete']) {
    const refs = await publishPlan(action);
    const theirs = liveRefs(member, action);
    await assertSucceeds(getDoc(theirs.timetable));
    if (action === 'revoke-invite') await assertSucceeds(deleteDoc(refs.invite));
    if (action === 'revoke-audience') await assertSucceeds(setDoc(refs.audience, {members:[]}));
    if (action === 'legacy-delete') await assertSucceeds(setDoc(plan(owner, action), {revision:2, payload:''}));
    await assertFails(getDoc(theirs.timetable));
    if (action !== 'revoke-invite') await assertSucceeds(deleteDoc(refs.invite));
    await assertSucceeds(deleteDoc(refs.audience));
    await assertSucceeds(deleteDoc(refs.timetable));
  }
});

test('invitation writes require the sender, matching key, current plan and selected recipient', async () => {
  const id = 'grant-check', data = invitation(id), refs = liveRefs(owner, id);
  await assertSucceeds(setDoc(refs.audience, {members:[university]}));
  await assertFails(setDoc(refs.invite, data));
  await assertSucceeds(setDoc(plan(owner,id), original));
  await assertFails(setDoc(liveRefs(owner,id,'absent@example.org').invite, data));
  await assertFails(setDoc(liveRefs(other,id).invite, data));
  await assertFails(setDoc(doc(refs.inbox,'wrong-key'), data));
  await assertFails(setDoc(refs.invite, {...data, owner:'other'}));
  await assertFails(setDoc(refs.invite, {...data, name:''}));
  await assertFails(setDoc(refs.invite, {...data, name:'長'.repeat(81)}));
  await assertFails(setDoc(refs.invite, {...data, unexpected:'x'}));
  await assertSucceeds(setDoc(refs.invite, data));
  await assertFails(deleteDoc(liveRefs(other,id).invite));
  await assertSucceeds(getDoc(liveRefs(owner, 'yet-to-exist').audience));
});

test('share metadata is bounded, distinct from private records, and owner-controlled', async () => {
  const refs = liveRefs(owner, 'bounded');
  const guests = Array.from({length:12}, (_,i) => 'guest'+i+'@example.org');
  await assertSucceeds(setDoc(refs.audience, {members:guests}));
  for (const members of [[...guests,'thirteenth@example.org'],[university,university],['broken'], ['UPPER@EXAMPLE.ORG'],[1],['a@b.org/c@d.org']]) {
    await assertFails(setDoc(refs.audience, {members}));
  }
  await assertFails(setDoc(refs.audience, {members:[], extra:true}));
  await assertFails(setDoc(refs.timetable, {view:'あ'.repeat(46667)}));
  await assertFails(setDoc(refs.timetable, {view:'予定', payload:'private'}));
  await assertSucceeds(setDoc(refs.timetable, {view:'あ'.repeat(46666)}));
});

test('one transaction can rename and then remove a published plan with twelve recipients', async () => {
  const id = 'full-group';
  const guests = Array.from({length:12}, (_,i) => 'companion'+i+'@example.org');
  const refs = liveRefs(owner,id);
  const first = writeBatch(owner);
  first.set(plan(owner,id), original);
  first.set(refs.audience, {members:guests});
  first.set(refs.timetable, {view:'午前の予定'});
  for (const email of guests) first.set(liveRefs(owner,id,email).invite, invitation(id));
  await assertSucceeds(first.commit());
  const rename = writeBatch(owner);
  rename.set(plan(owner,id), {revision:2, payload:'新しい名前の私用計画'});
  rename.set(refs.timetable, {view:'午後の予定'});
  for (const email of guests) rename.set(liveRefs(owner,id,email).invite, {...invitation(id), name:'新しい名前'});
  await assertSucceeds(rename.commit());
  const member = companion('last-companion',guests.at(-1));
  assert.equal((await assertSucceeds(getDoc(liveRefs(member,id,guests.at(-1)).invite))).data().name, '新しい名前');
  const remove = writeBatch(owner);
  remove.set(plan(owner,id), {revision:3, payload:''});
  remove.delete(refs.audience);
  remove.delete(refs.timetable);
  for (const email of guests) remove.delete(liveRefs(owner,id,email).invite);
  await assertSucceeds(remove.commit());
  await assertFails(getDoc(liveRefs(member,id,guests.at(-1)).timetable));
  assert.equal((await assertSucceeds(getDocs(liveRefs(member,id,guests.at(-1)).inbox))).size, 0);
});

test('an opted-in editor can update only their shared workspace and its matching public view', async () => {
  const id = 'joint-trip', ownerRefs = await publishPlan(id);
  const member = companion('active-editor',university);
  const docFor = (db,kind) => doc(db,'users','owner',kind,id);
  const docs = db => ({editors:docFor(db,'liveEditors'), work:docFor(db,'liveWorkspaces'), ...liveRefs(db,id)});
  const mine=docs(owner), invited=docs(member);
  const work = {revision:1, draft:'joint planning fields', view:'morning'};
  await assertFails(setDoc(ownerRefs.invite,{...invitation(id),role:'editor'}));
  await assertFails(setDoc(mine.editors,{members:['uninvited@example.org']}));
  const setup = writeBatch(owner);
  setup.set(mine.editors,{members:[university]});
  setup.set(mine.work,work); setup.set(mine.timetable,{view:work.view});
  setup.set(mine.invite,{...invitation(id),role:'editor'});
  await assertSucceeds(setup.commit());
  await assertSucceeds(getDoc(invited.work));
  await assertFails(getDoc(plan(member,id)));
  await assertFails(getDoc(invited.editors)); await assertFails(getDoc(invited.audience));
  await assertFails(getDocs(collection(member,'users/owner/liveWorkspaces')));
  await assertFails(setDoc(invited.editors,{members:[]}));
  await assertFails(deleteDoc(invited.work));
  for (const db of [companion('stranger','other@example.org'),companion('unverified',university,false),guest])
    await assertFails(getDoc(docs(db).work));
  const change = (rev, v) => {
    const b=writeBatch(member);b.set(invited.work,{revision:rev,draft:'next draft',view:'afternoon'});
    b.set(invited.timetable,{view:v});return b.commit();
  };
  await assertFails(setDoc(invited.timetable,{view:'only view'}));
  await assertFails(change(3,'afternoon')); await assertFails(change(2,'mismatch'));
  await assertSucceeds(change(2,'afternoon')); await assertFails(change(2,'afternoon'));
  await assertSucceeds(setDoc(mine.invite,{...invitation(id),role:'viewer'}));
  await assertFails(getDoc(invited.work)); await assertSucceeds(getDoc(invited.timetable));
  await assertFails(change(3,'afternoon'));
  await assertSucceeds(setDoc(mine.invite,{...invitation(id),role:'editor'}));
  await assertSucceeds(deleteDoc(mine.editors)); await assertFails(getDoc(invited.work));
});
