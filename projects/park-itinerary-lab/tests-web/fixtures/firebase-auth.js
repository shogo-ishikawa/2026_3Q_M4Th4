// Synthetic identity provider for browser tests. Only the temporary test site imports this file.
const key = 'tdroute-fixture-auth';
export const indexedDBLocalPersistence = {}, browserLocalPersistence = {}, browserSessionPersistence = {};
export const browserPopupRedirectResolver = {};
export class GoogleAuthProvider {
  setCustomParameters() {}
}
export function initializeAuth() {
  const listeners = new Set();
  const auth = {
    currentUser: JSON.parse(localStorage.getItem(key)),
    authStateReady() { return Promise.resolve(); },
    listeners,
    notify() {
      auth.currentUser = JSON.parse(localStorage.getItem(key));
      for (const listener of listeners) listener(auth.currentUser);
    },
  };
  addEventListener('storage', event => { if (event.key === key) auth.notify(); });
  return auth;
}
export function onAuthStateChanged(auth, listener) {
  auth.listeners.add(listener);
  queueMicrotask(() => { if (auth.listeners.has(listener)) listener(auth.currentUser); });
  return () => auth.listeners.delete(listener);
}
export const onIdTokenChanged = onAuthStateChanged;
export async function getIdTokenResult(user) {
  return {signInProvider:user.signInProvider || 'anonymous'};
}
export async function signInWithPopup(auth) {
  const uid = sessionStorage.getItem('tdroute-fixture-next-account') || 'visitor-one';
  const displayName = sessionStorage.getItem('tdroute-fixture-display-name') ?? uid;
  localStorage.setItem(key, JSON.stringify({uid, displayName, signInProvider:'google.com', providerData:[{providerId:'google.com'}]}));
  auth.notify();
}
export async function signOut(auth) {
  localStorage.removeItem(key);
  auth.notify();
}
