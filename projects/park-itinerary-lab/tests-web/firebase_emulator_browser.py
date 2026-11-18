"""Exercise TDRoute's Firebase adapter with Chrome and the official Auth/Firestore emulators.

From the project's firebase/ directory, with Playwright and Chrome installed:
firebase emulators:exec --project demo-tdroute-check --only auth,firestore "python ../tests-web/firebase_emulator_browser.py"
"""

import argparse
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
from uuid import uuid4

from playwright.sync_api import sync_playwright


PROJECT = 'demo-tdroute-check'


def emulator_endpoint(variable):
    value = os.environ[variable]
    endpoint = urlsplit('http://' + value)
    if endpoint.hostname not in {'localhost', '127.0.0.1'} or not endpoint.port or endpoint.path:
        raise ValueError(f'{variable} must name a local emulator host and port')
    return [endpoint.hostname, endpoint.port]


HARNESS = """<!doctype html><meta charset="utf-8"><button disabled>Google login</button><script type="module">
import { connectFirebase } from './firebase-sync.js';
const { projectId, authServer, firestoreServer } = ENDPOINTS;
const config = {projectId, apiKey:'tdroute-emulator-key', appId:'1:123:web:tdroute', authDomain:projectId+'.firebaseapp.com'};
async function emulatorSdk(name) {
  const sdk = await import('./assets/firebase/firebase-'+name+'.js');
  if (name === 'auth') return {...sdk, initializeAuth(app, options) {
    const auth = sdk.initializeAuth(app, options);
    window.signInTestGoogleUser = email => sdk.signInWithCredential(auth,
      sdk.GoogleAuthProvider.credential(JSON.stringify({sub:email, email, email_verified:true})));
    sdk.connectAuthEmulator(auth, 'http://'+authServer.join(':'), {disableWarnings:true});
    return auth;
  }};
  if (name === 'firestore') return {...sdk, initializeFirestore(app, options) {
    const db = sdk.initializeFirestore(app, options);
    sdk.connectFirestoreEmulator(db, ...firestoreServer);
    window.rawRead = (uid, id) => sdk.getDocFromServer(sdk.doc(db, 'users', uid, 'plans', id));
    return db;
  }};
  return sdk;
}
window.remote = await connectFirebase(config, emulatorSdk);
remote.observeUser(user => { window.account = user; });
const button = document.querySelector('button');
button.onclick = () => remote.signIn().catch(error => { window.loginError = String(error); });
button.disabled = false;
</script>"""


class FixtureServer(SimpleHTTPRequestHandler):
    def __init__(self, *args, fixture, **kwargs):
        self.fixture = fixture
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if self.path != '/fixture.html':
            return super().do_GET()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(self.fixture.encode())

    def log_message(self, *_):
        pass


def new_device(browser, origin):
    context = browser.new_context()
    page = context.new_page()
    page.goto(origin + '/fixture.html')
    page.wait_for_function('window.account === null')
    return page


def popup_sign_in(page, email, *, returning=False):
    with page.expect_popup() as opened:
        page.get_by_role('button', name='Google login').click()
    popup = opened.value
    if returning:
        popup.get_by_text(email, exact=True).click()
    else:
        popup.locator('#add-account-button').click()
        popup.locator('#email-input').fill(email)
        popup.locator('#display-name-input').fill('TDRoute emulator user')
        popup.locator('#sign-in').click()
    page.wait_for_function('window.account?.uid || window.loginError', timeout=45_000)
    assert page.evaluate('window.loginError') is None
    return page.evaluate('account.uid')


def credential_sign_in(page, email, *, returning=False):
    # The Auth emulator issues a Google-provider Firebase ID token for this synthetic identity.
    page.evaluate('email => signInTestGoogleUser(email).then(() => true)', email)
    page.wait_for_function('window.account?.uid')
    return page.evaluate('account.uid')


def exercise(browser, origin, sign_in):
    run = uuid4().hex
    email = f'visitor-{run}@example.invalid'
    phone = new_device(browser, origin)
    uid = sign_in(phone, email)
    pc = new_device(browser, origin)
    assert sign_in(pc, email, returning=True) == uid

    plan = {'id': 'visit', 'name': 'ランドの土曜日', 'createdAt': '2026-11-19T00:00:00Z',
            'updatedAt': '2026-11-19T00:00:00Z', 'state': {'park': 'land'}}
    write = '(p) => remote.write(account.uid, p.id, 0, p)'
    read = '() => remote.list(account.uid)'
    assert phone.evaluate(write, plan) == {'ok': True, 'revision': 1}
    assert pc.evaluate(read) == [{'id': 'visit', 'revision': 1, 'plan': plan}]
    assert pc.evaluate(write, plan)['current']['plan'] == plan

    stranger = new_device(browser, origin)
    assert sign_in(stranger, f'other-{run}@example.invalid') != uid
    assert stranger.evaluate(read) == []
    # Read directly with the Firestore SDK so the denial must come from deployed emulator rules.
    denied = stranger.evaluate('(uid) => rawRead(uid, "visit").then(() => "allowed", e => e.code)', uid)
    assert denied == 'permission-denied', denied

    # Reopen the locally served SDK and adapter with both Firebase emulators unreachable.
    external = lambda url: not url.startswith(origin + '/')
    phone.route(external, lambda route: route.abort('internetdisconnected'))
    phone.reload()
    phone.wait_for_function('window.account?.uid === ' + json.dumps(uid))
    phone.unroute(external)
    assert phone.evaluate('() => remote.write(account.uid, "visit", 1, null)') == {'ok': True, 'revision': 2}
    assert pc.evaluate(read) == [{'id': 'visit', 'revision': 2, 'plan': None}]
    pc.evaluate('() => remote.signOut()')
    pc.wait_for_function('window.account === null')
    assert pc.evaluate('(uid) => remote.list(uid).then(() => "allowed", e => e.code)', uid) == 'sync/account'
    assert pc.evaluate('(uid) => rawRead(uid, "visit").then(() => "allowed", e => e.code)', uid) == 'permission-denied'
    pc.reload()
    pc.wait_for_function('window.account === null')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credential', action='store_true',
                        help='Use the Auth emulator Google credential flow when public Google popup scripts are unavailable.')
    args = parser.parse_args()
    endpoints = {'projectId': PROJECT, 'authServer': emulator_endpoint('FIREBASE_AUTH_EMULATOR_HOST'),
                 'firestoreServer': emulator_endpoint('FIRESTORE_EMULATOR_HOST')}
    web = Path(__file__).resolve().parents[1] / 'web'
    fixture = HARNESS.replace('ENDPOINTS', json.dumps(endpoints))
    handler = partial(FixtureServer, directory=os.getenv('TDROUTE_TEST_WEB', web), fixture=fixture)
    with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server, sync_playwright() as pw:
        Thread(target=server.serve_forever, daemon=True).start()
        executable = os.getenv('TDROUTE_CHROME')
        browser = pw.chromium.launch(executable_path=executable, channel=None if executable else 'chrome')
        try:
            exercise(browser, f'http://127.0.0.1:{server.server_port}',
                     credential_sign_in if args.credential else popup_sign_in)
        finally:
            browser.close()
            server.shutdown()
    print('Google Auth emulator sign-in, Firestore sync, isolation, offline session restore and sign-out passed.')


if __name__ == '__main__':
    main()
