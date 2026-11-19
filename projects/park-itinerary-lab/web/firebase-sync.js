// Pinned Firebase Web SDK distributed with TDRoute so Auth can also restore a session offline.
const MAX_PAYLOAD_BYTES = 800_000;
const PLAN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/;

// This fingerprint selects a header label. Access to saved plans is enforced by Firestore rules.
const OWNER_UID_SHA256 = '59a9ddcef0808ba4c057a9015e2cbd352cd8fd39cb53d8490d90644d1153efba';

// Resolve the label before handing any name to the planner, including on token refresh.
async function plannerProfile(user) {
  const profile = {uid: user.uid, isOwner: false, displayName: ''};
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.uid));
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    profile.isOwner = hex === OWNER_UID_SHA256;
    if (!profile.isOwner) profile.displayName = user.displayName || '';
  } catch {
    // An unidentified account can use the planner with a neutral greeting.
  }
  return profile;
}

function syncError(code) {
  return Object.assign(new Error(syncErrorMessage({code})), {code});
}

export function syncErrorMessage(error) {
  switch (error?.code) {
    case 'auth/popup-blocked': return 'ポップアップを許可して、もう一度Googleでログインしてください。';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return 'ログインを中断しました。';
    case 'auth/web-storage-unsupported': return 'ブラウザのサイトデータの保存を許可してください。';
    case 'auth/operation-not-supported-in-this-environment': return 'SafariまたはChromeでTDRouteを開いてログインしてください。';
    case 'auth/unauthorized-domain':
    case 'auth/operation-not-allowed':
    case 'auth/invalid-api-key':
    case 'auth/configuration-not-found':
    case 'sync/config': return 'ログイン設定を確認できません。管理者にお問い合わせください。';
    case 'sync/account':
    case 'unauthenticated': return 'ログイン状態が変わりました。Googleアカウントを確認してください。';
    case 'permission-denied': return 'しおりの同期が許可されていません。ログインし直しても続く場合は管理者にお問い合わせください。';
    case 'resource-exhausted': return '同期の利用上限に達しました。時間をおいて同期してください。';
    case 'sync/size': return 'このしおりは同期できるサイズを超えています。端末に保存したしおりを利用できます。';
    case 'sync/data': return '同期するしおりのデータを読み取れませんでした。';
    case 'auth/network-request-failed':
    case 'unavailable':
    case 'deadline-exceeded': return '接続できません。通信できる場所でもう一度お試しください。';
    default: return '接続に失敗しました。通信状態を確認して、もう一度お試しください。';
  }
}

function publicConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw syncError('sync/config');
  if (!Object.keys(value).length) return null;
  const config = {};
  for (const key of ['apiKey', 'projectId', 'authDomain', 'appId']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 255) throw syncError('sync/config');
    config[key] = value[key];
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(config.authDomain)) throw syncError('sync/config');
  return config;
}

export async function readFirebaseConfig(fetchConfig = globalThis.fetch) {
  const url = new URL('./firebase-config.json', import.meta.url);
  const response = await fetchConfig(url, {cache: 'no-cache', credentials: 'omit', redirect: 'error'});
  if (!response.ok) throw syncError('sync/config');
  return publicConfig(await response.json());
}

// Firebase normally refreshes an expired token when checking its provider. Offline we can
// recognise a previous Google session from that same SDK user's last issued ID token.
function previousGoogleSession(user, projectId) {
  try {
    const token = user.toJSON().stsTokenManager.accessToken;
    const encoded = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))));
    return claims.sub === user.uid && claims.aud === projectId &&
      claims.iss === `https://securetoken.google.com/${projectId}` &&
      claims.firebase?.sign_in_provider === 'google.com';
  } catch {
    return false;
  }
}

async function usesGoogle(authSdk, user, projectId) {
  if (!user || user.isAnonymous) return false;
  try {
    const result = await authSdk.getIdTokenResult(user);
    return result.signInProvider === 'google.com';
  } catch (error) {
    if (error.code !== 'auth/network-request-failed') throw error;
    return previousGoogleSession(user, projectId);
  }
}

function decodePlan(snapshot) {
  const {revision, payload} = snapshot.data();
  if (!PLAN_ID.test(snapshot.id) || !Number.isSafeInteger(revision) || revision < 1 ||
      typeof payload !== 'string' || payload.length > MAX_PAYLOAD_BYTES) throw syncError('sync/data');
  if (payload === '') return {id: snapshot.id, revision, plan: null};
  let plan;
  try { plan = JSON.parse(payload); } catch { throw syncError('sync/data'); }
  if (!plan || plan.id !== snapshot.id) throw syncError('sync/data');
  return {id: snapshot.id, revision, plan};
}

function encodePlan(id, plan) {
  if (plan === null) return '';
  if (!plan || plan.id !== id) throw syncError('sync/data');
  const {name, createdAt, updatedAt, state} = plan;
  const payload = JSON.stringify({id, name, createdAt, updatedAt, state});
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) throw syncError('sync/size');
  return payload;
}

const loadSdk = name => import(`./assets/firebase/firebase-${name}.js`);

// Auth restores its own session. Firestore and its network connection are only needed for sync.
export async function connectFirebase(value, load = loadSdk) {
  const config = publicConfig(value);
  if (!config) throw syncError('sync/config');
  const [appSdk, authSdk] = await Promise.all([load('app'), load('auth')]);
  const app = appSdk.initializeApp(config, 'tdroute');
  const auth = authSdk.initializeAuth(app, {
    persistence: [authSdk.indexedDBLocalPersistence, authSdk.browserLocalPersistence, authSdk.browserSessionPersistence]
  });
  auth.languageCode = 'ja';
  await auth.authStateReady();
  const provider = new authSdk.GoogleAuthProvider();
  provider.setCustomParameters({prompt: 'select_account'});

  let verifiedUser = null;
  let storePromise;
  function store() {
    if (!storePromise) {
      storePromise = load('firestore').then(sdk => ({
        sdk, db: sdk.initializeFirestore(app, {localCache: sdk.memoryLocalCache()})
      })).catch(error => { storePromise = null; throw error; });
    }
    return storePromise;
  }
  function requireAccount(uid) {
    if (!uid || uid.includes('/') || auth.currentUser !== verifiedUser || verifiedUser?.uid !== uid) throw syncError('sync/account');
  }

  return {
    observeUser(next, error) {
      let observation = 0;
      const unsubscribe = authSdk.onIdTokenChanged(auth, async user => {
        const generation = ++observation;
        if (verifiedUser && user && verifiedUser !== user) next(null);
        verifiedUser = null;
        try {
          const permitted = await usesGoogle(authSdk, user, config.projectId);
          const profile = permitted ? await plannerProfile(user) : null;
          if (generation !== observation || user !== auth.currentUser) return;
          verifiedUser = permitted ? user : null;
          next(profile);
        } catch (reason) {
          if (generation !== observation || user !== auth.currentUser) return;
          next(null);
          error?.(reason);
        }
      }, error);
      return () => { observation++; unsubscribe(); };
    },
    async signIn() {
      // Call the popup from the click handler before any await. Redirect needs a same-origin auth helper.
      await authSdk.signInWithPopup(auth, provider, authSdk.browserPopupRedirectResolver);
    },
    signOut() { return authSdk.signOut(auth); },
    async albumIdToken(uid) {
      requireAccount(uid);
      const token = await authSdk.getIdToken(verifiedUser);
      requireAccount(uid);
      return token;
    },
    async list(uid) {
      requireAccount(uid);
      const {sdk, db} = await store();
      requireAccount(uid);
      const records = await sdk.getDocsFromServer(sdk.collection(db, 'users', uid, 'plans'));
      requireAccount(uid);
      return records.docs.map(decodePlan);
    },
    async write(uid, id, expectedRevision, plan) {
      requireAccount(uid);
      if (!PLAN_ID.test(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          expectedRevision >= Number.MAX_SAFE_INTEGER) throw syncError('sync/data');
      const payload = encodePlan(id, plan);
      const {sdk, db} = await store();
      const ref = sdk.doc(db, 'users', uid, 'plans', id);
      const result = await sdk.runTransaction(db, async transaction => {
        requireAccount(uid);
        const snapshot = await transaction.get(ref);
        requireAccount(uid);
        const current = snapshot.exists() ? decodePlan(snapshot) : null;
        if ((current?.revision ?? 0) !== expectedRevision) return {ok: false, current};
        const revision = expectedRevision + 1;
        transaction.set(ref, {revision, payload});
        return {ok: true, revision};
      });
      requireAccount(uid);
      return result;
    }
  };
}
