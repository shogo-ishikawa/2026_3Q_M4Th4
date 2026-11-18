"""Exercise the login gate and the planner against a synthetic Google identity and private store."""
import json
from pathlib import Path
import runpy
import shutil

from playwright.sync_api import expect

TESTS = Path(__file__).resolve().parent
PROJECT = TESTS.parent
APP_PATH = '/park-itinerary-lab/'


def make_test_site(built_site, site):
    """Replace only the external identity/store connection, never an application auth decision."""
    app = site / 'park-itinerary-lab'
    shutil.copytree(built_site / 'park-itinerary-lab', app, ignore=shutil.ignore_patterns('downloads'))
    config = {
        'projectId': 'demo-tdroute', 'apiKey': 'test-api-key-for-browser-tests',
        'appId': '1:123456789:web:123456789abcdef', 'authDomain': 'demo-tdroute.firebaseapp.com',
    }
    (app / 'firebase-config.json').write_text(json.dumps(config), encoding='utf-8')
    for name in ('firebase-auth.js', 'firebase-firestore.js'):
        shutil.copyfile(TESTS / 'fixtures' / name, app / 'assets/firebase' / name)
    # The PWA verifies each file; use the production packager for the changed test-only assets.
    shutil.copyfile(PROJECT / 'web/sw.js', app / 'sw.js')
    worker = runpy.run_path(str(PROJECT / 'scripts/package-web.py'))['public_worker'](app)
    (app / 'sw.js').write_bytes(worker)


class PrivateStore:
    def __init__(self):
        self.users = {}

    def request(self, uid, method, *args):
        records = self.users.setdefault(uid, {})
        if method == 'list':
            return records
        if method == 'get':
            return records.get(args[0])
        assert method == 'commit'
        plan_id, expected, data = args
        if records.get(plan_id, {}).get('revision', 0) != expected:
            return False
        records[plan_id] = data
        return True


def wire_device(context, store):
    context.expose_function('fixturePlanStore', store.request)


def sign_in(page, uid='visitor-one'):
    page.evaluate("uid => sessionStorage.setItem('tdroute-fixture-next-account', uid)", uid)
    page.locator('#googleSignIn').click()
    expect(page.locator('#appShell')).to_be_visible(timeout=30_000)
    expect(page.locator('#loginGate')).to_be_hidden()
    expect(page.locator('#accountName')).to_contain_text(uid)
    expect(page.locator('#solveButton')).to_be_enabled(timeout=30_000)


def assert_locked(page):
    expect(page.locator('#loginGate')).to_be_visible()
    expect(page.locator('#appShell')).to_be_hidden()
    expect(page.locator('#solveButton')).to_be_hidden()


def open_plans(page):
    expect(page.locator('#solveButton')).to_be_enabled(timeout=30_000)
    page.locator('#loadPlan').click()
    expect(page.locator('#savedPlansPanel')).to_be_visible()


def check_login_and_sync(browser, origin, store):
    app = origin + APP_PATH
    device = browser.new_context(service_workers='block')
    mirror = browser.new_context(service_workers='block')
    try:
        for context in (device, mirror):
            wire_device(context, store)
            context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())

        page = device.new_page()
        page.route('**/firebase-config.json*', lambda route: route.fulfill(json={}, status=200))
        page.goto(app)
        assert_locked(page)
        expect(page.locator('#loginStatus')).to_contain_text('準備中')
        expect(page.locator('#googleSignIn')).to_be_disabled()
        # A valid config still requires the provider to restore or establish a user session.
        page.unroute('**/firebase-config.json*')
        page.evaluate('''() => localStorage.setItem('tdroute-fixture-auth', JSON.stringify({
          uid:'not-signed-in-with-google', signInProvider:'password', providerData:[{providerId:'google.com'}]
        }))''')
        page.goto(app + '#savedPlansPanel')
        page.reload()
        expect(page.locator('#googleSignIn')).to_be_enabled()
        assert_locked(page)
        sign_in(page)

        page.locator('#seaTab').click()
        page.locator('#savePlan').click()
        page.locator('#planName').fill('二台で開くしおり')
        page.locator('#saveNewPlan').click()
        item = page.locator('[data-saved-plan]').filter(has_text='二台で開くしおり')
        expect(item).to_be_visible()

        another = mirror.new_page()
        another.goto(app)
        assert_locked(another)
        sign_in(another)
        open_plans(another)
        other_item = another.locator('[data-saved-plan]').filter(has_text='二台で開くしおり')
        expect(other_item).to_be_visible(timeout=15_000)
        other_item.locator('[data-load-saved]').click()
        expect(another.locator('#seaTab')).to_have_attribute('aria-selected', 'true')
        open_plans(another)
        mirror.set_offline(True)
        other_item.locator('[data-rename-saved]').click()
        other_item.locator('[data-saved-name]').fill('別の端末で更新')
        other_item.locator('[data-commit-rename]').click()
        changed = another.locator('[data-saved-plan]').filter(has_text='別の端末で更新')
        expect(changed).to_be_visible()
        expect(another.locator('#syncStatus')).to_contain_text('同期待ち')
        mirror.set_offline(False)
        expect(another.locator('#syncStatus')).to_contain_text('同期しました')

        page.reload()
        expect(page.locator('#appShell')).to_be_visible()
        open_plans(page)
        expect(page.locator('[data-saved-plan]').filter(has_text='別の端末で更新')).to_be_visible(timeout=15_000)

        # Switch the same browser to another Google identity; the first account's names must disappear.
        page.locator('#signOut').click()
        assert_locked(page)
        page.reload()
        expect(page.locator('#googleSignIn')).to_be_enabled()
        assert_locked(page)
        sign_in(page, 'visitor-two')
        open_plans(page)
        expect(page.locator('[data-saved-plan]')).to_have_count(0)
        expect(page.locator('#landTab')).to_have_attribute('aria-selected', 'true')

        # A pre-login v1 file stays on this device until its owner picks it for migration.
        legacy_plan = (TESTS / 'fixtures/land-v150-plan.json').read_text(encoding='utf-8')
        page.evaluate("raw => localStorage.setItem('park-itinerary-lab:v1', raw)", legacy_plan)
        page.reload()
        open_plans(page)
        expect(page.locator('[data-saved-plan]')).to_have_count(0)
        page.locator('#legacyImport > summary').click()
        choice = page.locator('#legacyPlans input[type=checkbox]').first
        expect(choice).not_to_be_checked()
        expect(page.locator('#importGuestPlans')).to_be_disabled()
        expect(page.locator('#syncStatus')).to_contain_text('同期しました')
        assert not store.users.get('visitor-two'), 'Unselected legacy plan reached the store'
        choice.check()
        page.locator('#importGuestPlans').click()
        expect(page.locator('[data-saved-plan]').filter(has_text='以前の計画')).to_be_visible()
        expect(page.locator('#syncStatus')).to_contain_text('同期しました')
        assert len(store.users['visitor-two']) == 1

        changed.locator('[data-delete-saved]').click()
        expect(changed).to_have_count(0)
        another.reload()
        open_plans(another)
        expect(another.locator('[data-saved-plan]')).to_have_count(0)
    finally:
        device.close()
        mirror.close()
