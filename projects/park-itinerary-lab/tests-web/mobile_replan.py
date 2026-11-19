"""Exercise the built Pages app, including its worker, on a mobile Chrome viewport."""
from datetime import datetime, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import base64
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread

from playwright.sync_api import expect, sync_playwright


class QuietFiles(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def read_itinerary(page):
    already_open = page.locator('#savedPlansPanel').evaluate('el => !el.hidden && el.open')
    page.locator('#loadPlan').click()
    tools = page.locator('.plan-file-tools')
    if not tools.evaluate('el => el.open'):
        tools.locator('summary').click()
    with page.expect_download() as download:
        tools.get_by_role('button', name='この計画をファイルに保存').click()
    tools.locator('summary').click()
    if not already_open:
        page.locator('#savedPlansPanel > summary').click()
    plan = json.loads(download.value.path().read_text())
    assert plan['result']['status'] == 'feasible', plan['result']['status']
    return plan


def download_saved_plan(page, name):
    with page.expect_download() as download:
        page.get_by_role('button', name=f'「{name}」をファイルに保存', exact=True).click()
    return download.value.path()


def set_time(page, field, minute):
    page.locator(f'#{field}-hour').fill(f'{minute // 60:02d}')
    page.locator(f'#{field}-minute').fill(f'{minute % 60:02d}')
    page.locator(f'#{field}-minute').press('Tab')


def solve(page, button):
    with page.expect_event('worker', timeout=30_000):
        button.click()
    expect(page.locator('#solveButton')).to_be_enabled(timeout=45_000)
    return read_itinerary(page)


def activity_rows(plan):
    return [row for row in plan['result']['rows'] if row['kind'] == 'activity']


def check_forecast_calendar(page):
    date = page.locator('#visitDate')
    opener = page.get_by_role('button', name='訪問日を選ぶ')
    opener.click()
    dialog = page.get_by_role('dialog', name='訪問日を選ぶ')
    expect(dialog).to_be_visible()
    expect(dialog.locator('[aria-current="date"]')).to_be_focused()
    expect(dialog.locator('#forecastCalendarRange')).to_contain_text('11/19〜12/4')
    dialog.locator('#nextForecastMonth').click()
    outside = dialog.locator('[data-date="2026-12-05"]')
    expect(outside).to_have_attribute('data-weather', 'outside')
    outside.click()
    expect(dialog.locator('#confirmForecastDate')).to_have_text('12月5日（土）を訪問日にする')
    expect(date).to_have_value('2026-11-19')
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(opener).to_be_focused()
    opener.click()
    page.keyboard.press('ArrowRight')
    page.keyboard.press('Enter')
    expect(date).to_have_value('2026-11-19')
    expect(dialog.locator('#calendarPreviewCrowd')).not_to_be_empty()
    page.keyboard.press('Tab')
    confirm = dialog.get_by_role('button', name='11月20日（金）を訪問日にする')
    expect(confirm).to_be_focused()
    page.keyboard.press('Enter')
    expect(date).to_have_value('2026-11-20')
    expect(dialog).not_to_be_visible()
    date.fill('2026-11-19')


def check_forecast_panel(page):
    ticket = page.locator('#dayTicketPrice')
    expect(ticket).to_have_text('10,900円')
    page.locator('#landTab').focus()
    page.keyboard.press('ArrowRight')
    expect(page.locator('#seaTab')).to_be_focused()
    expect(page.locator('#seaTab')).to_have_attribute('aria-selected', 'true')
    page.locator('#visitDate').fill('2026-11-21')
    expect(ticket).to_have_text('12,400円')
    page.locator('#visitDate').fill('2028-01-15')
    expect(ticket).to_have_text('料金未確認')
    page.locator('#landTab').click()
    page.locator('#visitDate').fill('2026-11-19')
    expect(ticket).to_have_text('10,900円')
    page.get_by_text('予算とお金の使い方', exact=True).click()
    page.locator('#budget').fill('14000')
    page.locator('#budget').press('Tab')
    expect(ticket).to_have_text('10,900円')
    page.locator('#forecastPanel > summary').click()
    expect(page.locator('#crowdOutlookValue')).to_be_visible()
    expect(page.locator('#forecastPanel a')).to_have_count(0)
    expect(page.locator('#forecastPanel').get_by_text('予測に使うデータ', exact=True)).to_have_count(0)
    expect(page.locator('#crowdLevelDetail, #crowdLevelUse')).to_have_count(0)
    expect(page.locator('#weather')).to_be_hidden()
    expect(page.locator('#weather')).to_be_disabled()
    page.locator('#weatherMode').select_option('manual')
    expect(page.locator('#weather')).to_be_visible()
    page.locator('#weather').select_option('rain')
    expect(page.locator('#dayWeatherValue')).to_have_text('雨')
    expect(page.locator('#dayWeatherDetail')).to_have_text('手動設定')
    page.locator('#crowdLevel').select_option('busy')
    expect(page.locator('#dayCrowdTitle')).to_have_text('混雑の想定')
    expect(page.locator('#dayCrowdValue')).to_have_text('混み合う')
    expect(page.locator('#dayCrowdSource')).to_have_text('手動')
    page.locator('#weatherMode').select_option('auto')
    expect(page.locator('#manualWeatherField')).to_be_hidden()
    expect(page.locator('#weather')).to_be_disabled()

    # Import a saved manual choice, then check the report for that specific date.
    fixture = json.loads((Path(__file__).parent / 'fixtures/land-v150-plan.json').read_text())
    fixture['settings'].update(weatherMode='manual', weather='rain')
    page.locator('#planFile').set_input_files({
        'name':'saved.json', 'mimeType':'application/json', 'buffer':json.dumps(fixture).encode(),
    })
    expect(page.locator('#weatherMode')).to_have_value('manual')
    expect(page.locator('#weather')).to_be_enabled()
    expect(page.locator('#weather')).to_have_value('rain')
    expect(page.locator('#dayWeatherValue')).to_have_text('雨')
    expect(page.locator('#budget')).to_have_value('10000')
    expect(ticket).to_have_text('10,900円')
    report = page.locator('#sourcePanel #visitDayFactSources a[href*="accuracy.html"]')
    expect(report).to_have_attribute('href', 'accuracy.html?date=2026-11-18&park=land')

    # The v1.5 JSON contains a valid fractional search limit. Preserve it and
    # its itinerary when transferring the file to a new home-screen app.
    expect(page.locator('#searchSeconds')).to_have_value('0.1')
    page.locator('#savePlan').click()
    page.locator('#planName').fill('JSONから引き継いだしおり')
    page.locator('#saveNewPlan').click()
    saved = page.locator('[data-saved-plan]').filter(has_text='JSONから引き継いだしおり')
    saved.locator('[data-load-saved]').click()
    restored = read_itinerary(page)
    assert restored['settings']['searchSeconds'] == fixture['settings']['searchSeconds']
    assert restored['result']['rows'] == fixture['result']['rows']
    page.locator('#loadPlan').click()
    saved.locator('[data-delete-saved]').click()


def check_album_entries(page):
    header_entry = page.get_by_role('navigation', name='ページの案内').get_by_role('button', name='アルバムを振り返る', exact=True)
    album = page.get_by_role('dialog', name='夢の思い出')
    header_entry.click()
    expect(album).to_be_visible()
    expect(album.get_by_role('button', name='閉じる')).to_be_focused()
    assert album.evaluate('el => el.scrollWidth <= el.clientWidth')
    page.keyboard.press('Escape')
    expect(album).to_be_hidden()
    expect(header_entry).to_be_focused()
    expect(page.locator('#workflowWishlistTab')).to_have_attribute('aria-selected', 'true')

    page.locator('#workflowScheduleTab').click()
    progress = page.locator('#dayProgressEditor > summary')
    expect(progress).to_contain_text('残りの予定を組み直す')
    entry = page.locator('#openScheduleAlbum')
    expect(entry).to_contain_text('写真を見返す')
    for control in (progress, entry):
        assert control.bounding_box()['height'] >= 64
    entry.click()
    expect(album).to_be_visible()
    album.get_by_role('button', name='閉じる').click()
    expect(entry).to_be_focused()
    expect(page.locator('#workflowScheduleTab')).to_have_attribute('aria-selected', 'true')
    page.locator('#workflowWishlistTab').click()


def check_share_edits(page):
    share = page.locator('#sharePlan')
    panel = page.locator('#sharePanel')
    link = page.locator('#shareUrl')
    date = page.locator('#visitDate')
    share.click()
    expect(page.locator('#copyShare')).to_be_focused()
    date.fill('2026-11-20')
    expect(panel).to_be_hidden()
    expect(link).to_have_value('')
    share.click()
    page.evaluate("""Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: {writeText: async value => { window.copiedPlan = value; }}
    })""")
    page.locator('#copyShare').click()
    copied = page.evaluate('window.copiedPlan')
    assert copied == link.input_value()
    encoded = copied.split('#plan=')[1]
    shared = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
    assert shared['settings']['date'] == '2026-11-20'
    assert shared['parkId'] == 'land'
    page.locator('#seaTab').click()
    expect(panel).to_be_hidden()
    share.click()
    sea_url = link.input_value()
    share.click()
    expect(share).to_have_attribute('aria-expanded', 'false')
    expect(panel).to_be_hidden()
    page.locator('#landTab').click()
    page.locator('#savePlan').click()
    page.locator('#planName').fill('受信前のランド')
    page.locator('#saveNewPlan').click()
    expect(page.locator('#overwritePlan')).to_be_visible()
    page.goto(sea_url)
    expect(page.locator('#seaTab')).to_have_attribute('aria-selected', 'true')
    expect(page.locator('#overwritePlan')).to_be_hidden()
    expect(page.locator('#planName')).to_have_value('')
    expect(page.locator('[data-saved-plan]')).to_have_count(1)
    saved = page.locator('[data-saved-plan]').filter(has_text='受信前のランド')
    saved.locator('[data-load-saved]').click()
    expect(page.locator('#landTab')).to_have_attribute('aria-selected', 'true')
    saved.locator('[data-delete-saved]').click()

    fresh = page.context.new_page()
    fresh.route('**/*', lambda route: route.continue_() if route.request.url.startswith(sea_url.split('#')[0]) else route.abort())
    fresh.goto(sea_url)
    expect(fresh.locator('#seaTab')).to_have_attribute('aria-selected', 'true', timeout=30_000)
    fresh.close()
    page.goto(sea_url.split('#')[0] + '#workspace')
    date.fill('2026-11-19')


def check_mobile_course_links(website):
    course_links = 'a[href="../"], a[href="#learn"], a[href*="colab.research.google.com"], a[href*="github.com/shogo-ishikawa/"], a[href$=".zip"], #learn'
    expect(website.locator('a[href="../"]')).to_be_visible()
    guide = website.context.new_page()
    guide.goto(website.url + 'guide.html#learn')
    expect(guide.locator('#learn a[href*="colab"]').first).to_be_visible()
    expect(guide.locator('a[href*="docs/wait-data.md"]')).to_have_count(1)
    guide.close()

    app = website.context.new_page()
    app.add_init_script("Object.defineProperty(navigator, 'standalone', {value:true})")
    app.goto(website.url)
    expect(app.locator('html')).to_have_class('tdroute-standalone')
    expect(app.locator(course_links)).to_have_count(0)
    app.locator('header a[href="guide.html"]').click()
    expect(app.locator('html')).to_have_class('tdroute-standalone')
    expect(app.locator(course_links)).to_have_count(0)
    expect(app.locator('#official a').first).to_be_visible()
    app.locator('nav a[href="accuracy.html"]').click()
    expect(app.locator('#reportForm')).to_be_visible()
    expect(app.locator(course_links)).to_have_count(0)
    app.get_by_role('link', name='プラン作成に戻る').click()
    expect(app.locator(course_links)).to_have_count(0)
    app.close()


def check_mobile(page, url):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    midnight = datetime.fromisoformat('2026-11-19T00:00:00+09:00')
    page.clock.set_fixed_time(midnight + timedelta(hours=9, minutes=15))
    page.context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url + '/') else route.abort())
    page.goto(url + '/park-itinerary-lab/')
    expect(page.locator('#solveButton')).to_be_enabled(timeout=30_000)
    expect(page.locator('#visitDate')).to_have_value('2026-11-19')
    check_mobile_course_links(page)
    check_album_entries(page)
    check_share_edits(page)
    check_forecast_calendar(page)
    check_forecast_panel(page)
    page.reload()
    expect(page.locator('#solveButton')).to_be_enabled(timeout=30_000)
    expect(page.locator('#sourcePanel #visitDayFactSources a[href*="accuracy.html"]')).to_have_count(0)

    page.locator('#jumpToWishes').click()
    expect(page.locator('#selectionTitle')).to_be_focused()
    expect(page.locator('#workflowWishlistTab')).to_have_attribute('aria-selected', 'true')
    page.get_by_role('searchbox', name='施設名やエリアで検索').fill('カリブの海賊')
    ride = page.locator('#catalogue button[data-add]')
    expect(ride).to_have_count(1)
    first = ride.get_attribute('data-add')
    ride.click()
    page.get_by_label('乗りたい回数').select_option('2')
    page.locator('#savePlan').click()
    page.locator('#planName').fill('移行する希望')
    page.locator('#saveNewPlan').click()
    page.get_by_label('乗りたい回数').select_option('1')
    draft_file = download_saved_plan(page, '移行する希望')
    draft = json.loads(draft_file.read_text())
    assert draft['result'] is None and draft['settings']['selections'][0]['repeatCount'] == 2
    expect(page.get_by_label('乗りたい回数')).to_have_value('1')
    page.locator('[data-delete-saved]').click()
    page.locator('#planFile').set_input_files(draft_file)
    expect(page.get_by_label('乗りたい回数')).to_have_value('2')
    plan = solve(page, page.locator('#solveButton'))
    first_visit, second_visit = activity_rows(plan)
    second = second_visit['activityId']
    assert first_visit['activityId'] == first and second != first
    assert '2回目' in second_visit['name']

    queue = next(row for row in plan['result']['rows'] if row['kind'] == 'queue' and row['activityId'] == first)
    at = queue['start'] + 1
    page.clock.set_fixed_time(midnight + timedelta(minutes=at))
    page.locator(f'[data-report-visit="{first}"][data-report-status="queue"]').click()
    set_time(page, 'progressClock', at)
    page.get_by_role('group', name='残り時間の候補').get_by_role('button', name='20分', exact=True).click()
    expect(page.locator('#progressRemaining')).to_have_value('20')
    expect(page.locator('#progressEstimate')).to_contain_text('に終了予定')
    # The now card resumes a pending edit without discarding or submitting it.
    page.locator('#dayProgressEditor summary').click()
    page.locator('#onsiteReplan').click()
    expect(page.locator('#progressRemaining')).to_be_visible()
    expect(page.locator('#progressRemaining')).to_have_value('20')
    expect(page.locator('#progressList button')).to_have_count(0)
    # Apply the edited form directly through the main replan action.
    plan = solve(page, page.locator('#progressReplan'))
    queued, next_visit = activity_rows(plan)
    assert queued['userProgress'] == 'queue' and queued['activityId'] == first
    assert queued['start'] == at + 20
    assert next_visit['activityId'] == second and next_visit['start'] >= queued['end']

    finished = queued['end'] - 1
    page.clock.set_fixed_time(midnight + timedelta(minutes=finished))
    page.locator('#onsiteFinish').click()
    expect(page.locator('#progressStatus')).to_have_value('done')
    set_time(page, 'progressClock', finished)
    expect(page.locator('#progressEstimate')).to_contain_text('に体験を終えたと記録')
    # A tracked ride uses the report clock when the optional actual time is blank.
    plan = solve(page, page.locator('#progressReplan'))
    recorded, next_visit = activity_rows(plan)
    assert recorded['userProgress'] == 'done' and recorded['activityId'] == first and recorded['end'] == finished
    assert next_visit['activityId'] == second and next_visit['start'] >= finished

    page.locator('#savePlan').click()
    page.locator('#planName').fill('現地のテスト計画')
    page.locator('#saveNewPlan').click()
    expect(page.locator('[data-load-saved]')).to_have_count(1)
    page.reload()
    expect(page.locator('#solveButton')).to_be_enabled(timeout=30_000)
    page.locator('#loadPlan').click()
    complete_file = download_saved_plan(page, '現地のテスト計画')
    page.locator('#planFile').set_input_files(complete_file)
    imported = read_itinerary(page)
    assert imported['settings']['dayProgress'] == plan['settings']['dayProgress']
    assert activity_rows(imported) == activity_rows(plan)
    page.locator('[data-load-saved]').click()
    restored = read_itinerary(page)
    assert restored['settings']['selections'][0]['repeatCount'] == 2
    assert restored['settings']['dayProgress'] == plan['settings']['dayProgress']
    assert activity_rows(restored) == activity_rows(plan)

    # Reopen from the installed app's start URL with both HTTP cache and network unavailable.
    page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=30_000)
    context = page.context
    context.set_offline(True)
    page.close()
    offline = context.new_page()
    offline.on('pageerror', lambda error: errors.append(str(error)))
    offline.goto(url + '/park-itinerary-lab/')
    expect(offline.locator('#solveButton')).to_be_enabled(timeout=30_000)
    offline.locator('#loadPlan').click()
    offline.locator('[data-load-saved]').click()
    reopened = read_itinerary(offline)
    assert reopened['settings']['dayProgress'] == plan['settings']['dayProgress']
    assert activity_rows(reopened) == activity_rows(plan)
    assert not errors, errors


if __name__ == '__main__':
    from mobile_map import check_map_gestures
    from mobile_auth import PrivateStore, check_login_and_sync, make_test_site, sign_in, wire_device

    built_site = Path(__file__).resolve().parents[3] / '_site'
    assert (built_site / 'park-itinerary-lab/index.html').is_file(), 'Build the public site first.'
    with TemporaryDirectory() as folder, ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietFiles, directory=folder)) as server, sync_playwright() as pw:
        make_test_site(built_site, Path(folder))
        Thread(target=server.serve_forever, daemon=True).start()
        try:
            browser = pw.chromium.launch(channel='chrome', headless=True)
            context = browser.new_context(locale='ja-JP', timezone_id='Asia/Tokyo', viewport={'width':393,'height':851},
                                          has_touch=True, is_mobile=True, service_workers='allow', reduced_motion='reduce')
            origin = f'http://127.0.0.1:{server.server_port}'
            store = PrivateStore()
            check_login_and_sync(browser, origin, store)
            wire_device(context, store)
            map_page = context.new_page()
            map_page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())
            map_page.goto(origin + '/park-itinerary-lab/')
            sign_in(map_page, 'mobile-visitor')
            check_map_gestures(map_page, origin + '/park-itinerary-lab/')
            map_page.close()
            check_mobile(context.new_page(), origin)
            browser.close()
        finally:
            server.shutdown()
