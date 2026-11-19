// All browser contexts talk to the test's shared, in-memory store using the ordinary SDK interface.
export function initializeFirestore() { return {}; }
export function memoryLocalCache() { return {}; }
export function collection(_db, users, uid, plans) {
  if (users !== 'users' || !['plans','livePlanAudiences','liveEditors'].includes(plans)) throw Error('Unexpected collection');
  return {uid,kind:plans};
}
export function doc(db, users, uid, plans, id) {
  return {...collection(db, users, uid, plans), id};
}
function request(uid, ...args) {
  if (!navigator.onLine) throw Object.assign(Error('offline'), {code:'unavailable'});
  if (JSON.parse(localStorage.getItem('tdroute-fixture-auth'))?.uid !== uid) {
    throw Object.assign(Error('wrong owner'), {code:'permission-denied'});
  }
  return window.fixturePlanStore(uid, ...args);
}
function snapshot(id, data) {
  return {id, exists:() => data !== null, data:() => data};
}
export async function getDocsFromServer({uid}) {
  const records = await request(uid, 'list');
  return {docs:Object.entries(records).map(([id,data]) => snapshot(id, data))};
}
export async function runTransaction(_db, update) {
  // Retry if a second device changed the document between read and write.
  for (let retry = 0; retry < 5; retry++) {
    let before, pending;
    const result = await update({
      async get(ref) {
        // This fixture exercises private plans only. Shared-plan permissions are exercised in the emulator.
        if (ref.kind === 'livePlanAudiences') return snapshot(ref.id,null);
        before = await request(ref.uid, 'get', ref.id);
        return snapshot(ref.id, before);
      },
      set(ref, data) { pending = {ref, data}; },
    });
    if (!pending || await request(pending.ref.uid, 'commit', pending.ref.id, before?.revision ?? 0, pending.data)) return result;
  }
  throw Error('Too many concurrent writes');
}

export function onSnapshot(ref, _options, next) {
  if (!['livePlanAudiences','liveEditors'].includes(ref.kind)) throw Error('Unexpected listener');
  queueMicrotask(() => next({metadata:{fromCache:false},docs:[]}));
  return () => {};
}
