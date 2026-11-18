"""Exercise the built Pages app, including its worker, on a mobile Chrome viewport."""
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright


class QuietFiles(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def read_itinerary(page):
    with page.expect_download() as download:
        page.get_by_role('button', name='計画JSON', exact=True).click()
    plan = json.loads(download.value.path().read_text())
    assert plan['result']['status'] == 'feasible', plan['result']['status']
    return plan


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


def check_mobile(page, url):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(datetime.fromisoformat('2026-11-19T09:15:00+09:00'))
    page.context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url + '/') else route.abort())
    page.goto(url + '/park-itinerary-lab/')
    expect(page.locator('#solveButton')).to_be_enabled(timeout=30_000)
    expect(page.locator('#visitDate')).to_have_value('2026-11-19')

    page.get_by_role('searchbox', name='施設名やエリアで検索').fill('カリブの海賊')
    ride = page.locator('#catalogue button[data-add]')
    expect(ride).to_have_count(1)
    first = ride.get_attribute('data-add')
    ride.click()
    page.get_by_label('乗りたい回数').select_option('2')
    plan = solve(page, page.locator('#solveButton'))
    first_visit, second_visit = activity_rows(plan)
    second = second_visit['activityId']
    assert first_visit['activityId'] == first and second != first
    assert '2回目' in second_visit['name']

    queue = next(row for row in plan['result']['rows'] if row['kind'] == 'queue' and row['activityId'] == first)
    at = queue['start'] + 1
    page.locator(f'[data-report-visit="{first}"][data-report-status="queue"]').click()
    set_time(page, 'progressClock', at)
    page.locator('#progressRemaining').fill('20')
    # Apply the edited form directly through the main replan action.
    plan = solve(page, page.locator('#progressReplan'))
    queued, next_visit = activity_rows(plan)
    assert queued['userProgress'] == 'queue' and queued['activityId'] == first
    assert queued['start'] == at + 20
    assert next_visit['activityId'] == second and next_visit['start'] >= queued['end']

    finished = queued['end'] - 1
    page.locator(f'[data-report-visit="{first}"][data-report-status="done"]').click()
    set_time(page, 'progressClock', finished)
    set_time(page, 'progressDoneAt', finished)
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
    page.locator('[data-load-saved]').click()
    restored = read_itinerary(page)
    assert restored['settings']['selections'][0]['repeatCount'] == 2
    assert restored['settings']['dayProgress'] == plan['settings']['dayProgress']
    assert activity_rows(restored) == activity_rows(plan)
    assert not errors, errors


if __name__ == '__main__':
    site = Path(__file__).resolve().parents[3] / '_site'
    assert (site / 'park-itinerary-lab/index.html').is_file(), 'Build the public site first.'
    with ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietFiles, directory=site)) as server, sync_playwright() as pw:
        Thread(target=server.serve_forever, daemon=True).start()
        try:
            browser = pw.chromium.launch(channel='chrome', headless=True)
            context = browser.new_context(locale='ja-JP', timezone_id='Asia/Tokyo', viewport={'width':393,'height':851},
                                          has_touch=True, is_mobile=True, service_workers='block', reduced_motion='reduce')
            check_mobile(context.new_page(), f'http://127.0.0.1:{server.server_port}')
            browser.close()
        finally:
            server.shutdown()
