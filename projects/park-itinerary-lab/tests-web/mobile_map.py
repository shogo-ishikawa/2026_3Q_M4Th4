"""Exercise real multi-touch input on the deployed map geometry in mobile Chromium."""
from time import time

from playwright.sync_api import expect


def touch(cdp, event, *points, timestamp=None):
    params = {'type': event, 'touchPoints': [{'id': i, 'x': x, 'y': y} for i, x, y in points]}
    if timestamp is not None:
        params['timestamp'] = timestamp
    cdp.send('Input.dispatchTouchEvent', params)


def painted(page):
    page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')


def centre_map(page):
    svg = page.locator('.park-route-map')
    svg.evaluate("el => el.scrollIntoView({block:'center', behavior:'instant'})")
    painted(page)
    rect = svg.bounding_box()
    return round(rect['x'] + rect['width'] / 2), round(rect['y'] + rect['height'] / 2)


def map_matrix(page):
    return page.locator('.park-map-art').evaluate('''el => {
        const m = el.getScreenCTM();
        return {scale:m.a, x:m.e, y:m.f};
    }''')


def assert_anchored(before, after, start, end):
    # Compare screen pixels, irrespective of the map's internal zoom representation.
    ratio = after['scale'] / before['scale']
    for axis, start_px, end_px in zip(('x', 'y'), start, end):
        actual = after[axis] + (start_px - before[axis]) * ratio
        assert abs(actual - end_px) < 3, (axis, actual, end_px)


def visible_pin(page):
    # The tap target must be an available facility, including at overlapping pins.
    return page.locator('.park-route-map').evaluate('''svg => {
        const available = new Set(Array.from(document.querySelectorAll(
            '#catalogue [data-add]:not(:disabled)'), el => el.dataset.add));
        const rect = svg.getBoundingClientRect();
        for (const pin of svg.querySelectorAll('[data-activity-id]')) {
            const id = pin.dataset.activityId;
            if (!available.has(id)) continue;
            const p = new DOMPoint(0,0).matrixTransform(pin.getScreenCTM());
            if (p.x < rect.left + 45 || p.x > rect.right - 45 ||
                p.y < rect.top + 45 || p.y > rect.bottom - 45) continue;
            if (document.elementFromPoint(p.x, p.y)?.closest('[data-activity-id]') === pin)
                return {x:Math.round(p.x), y:Math.round(p.y), id};
        }
        throw new Error('No tappable park marker in the viewport');
    }''')


def check_map_taps(page, cdp, park):
    page.locator(f'#{park}Tab').click()
    page.locator('[data-map-action=reset]').click()
    centre_map(page)
    pin = visible_pin(page)
    marker = page.locator(f'[data-activity-id="{pin["id"]}"]')
    point = (pin['x'], pin['y'])
    expect(marker).to_have_attribute('aria-pressed', 'false')
    initial = map_matrix(page)
    # Fix hardware timestamps so a slow CI paint is never mistaken for a long press.
    first_tap = time()
    for offset in (0, 0.15):
        touch(cdp, 'touchStart', (1, *point), timestamp=first_tap + offset)
        touch(cdp, 'touchEnd', timestamp=first_tap + offset + 0.04)
    painted(page)
    zoomed = map_matrix(page)
    assert zoomed['scale'] / initial['scale'] > 1.4
    assert_anchored(initial, zoomed, point, point)
    assert page.evaluate('visualViewport.scale') == 1

    # A drag starting on that same marker moves the drawing without adding a wish.
    touch(cdp, 'touchStart', (1, *point))
    moved = (point[0] + 21, point[1] - 18)
    touch(cdp, 'touchMove', (1, *moved))
    touch(cdp, 'touchEnd')
    painted(page)
    assert_anchored(zoomed, map_matrix(page), point, moved)
    expect(marker).to_have_attribute('aria-pressed', 'false')
    touch(cdp, 'touchStart', (1, *moved))
    touch(cdp, 'touchEnd')
    expect(marker).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('[data-focus-activity]').first).to_be_visible()
    page.locator('[data-focus-activity]').first.click()
    expect(marker).to_be_focused()
    page.locator('[data-map-action=reset]').click()
    expect(page.locator('.park-map-scale')).to_have_text('100%')


def check_map_gestures(page, app_url):
    page.clock.set_fixed_time('2026-11-19T09:15:00+09:00')
    page.goto(app_url, wait_until='domcontentloaded')
    expect(page.locator('#solveButton')).to_be_enabled(timeout=45_000)
    cdp = page.context.new_cdp_session(page)
    for park in ('sea', 'land'):
        check_map_taps(page, cdp, park)

    # Compute a route against today's graph for the Land facility tapped above.
    with page.expect_event('worker', timeout=30_000):
        page.locator('#solveButton').click()
    expect(page.locator('#solveButton')).to_be_enabled(timeout=45_000)
    route = page.locator('.park-route-map polyline:has(> title)').first
    expect(route).to_be_attached()
    points = route.get_attribute('points')
    x, y = centre_map(page)
    initial = map_matrix(page)
    start, end = (x + 12, y - 17), (x + 25, y - 6)
    # Spread from 64 to 112px while also moving the midpoint.
    touch(cdp, 'touchStart', (1, start[0] - 32, start[1]), (2, start[0] + 32, start[1]))
    touch(cdp, 'touchMove', (1, end[0] - 56, end[1]), (2, end[0] + 56, end[1]))
    painted(page)
    zoomed = map_matrix(page)
    assert abs(zoomed['scale'] / initial['scale'] - 1.75) < 0.04
    assert_anchored(initial, zoomed, start, end)
    # Release only the second finger and continue panning with the remaining finger.
    touch(cdp, 'touchEnd', (2, end[0] + 56, end[1]))
    retained = (end[0] - 56, end[1])
    moved = (retained[0] - 22, retained[1] + 19)
    touch(cdp, 'touchMove', (1, *moved))
    touch(cdp, 'touchEnd')
    painted(page)
    assert_anchored(zoomed, map_matrix(page), retained, moved)
    assert route.get_attribute('points') == points
    route_matrix = route.evaluate('el => { const m = el.getScreenCTM(); return [m.a, m.e, m.f]; }')
    art = map_matrix(page)
    for actual, expected in zip(route_matrix, (art['scale'], art['x'], art['y'])):
        assert abs(actual - expected) < 0.01
    assert page.evaluate('visualViewport.scale') == 1

    # A cancelled pinch must not poison the next gesture.
    touch(cdp, 'touchStart', (1, x - 16, y), (2, x + 16, y))
    touch(cdp, 'touchCancel')
    touch(cdp, 'touchStart', (1, x - 8, y), (2, x + 8, y))
    touch(cdp, 'touchMove', (1, x - 90, y), (2, x + 90, y))
    touch(cdp, 'touchEnd')
    expect(page.locator('.park-map-scale')).to_have_text('400%')
    touch(cdp, 'touchStart', (1, x - 90, y), (2, x + 90, y))
    touch(cdp, 'touchMove', (1, x - 8, y), (2, x + 8, y))
    touch(cdp, 'touchEnd')
    expect(page.locator('.park-map-scale')).to_have_text('100%')

    # In the overview you can still read down the page by swiping on the map;
    # the page gutter must also keep its ordinary native scrolling at every zoom.
    for on_map in (True, False):
        if not on_map:
            page.locator('[data-map-action=in]').click()
        x, y = centre_map(page)
        swipe_x = x if on_map else 4
        before = page.evaluate('window.scrollY')
        touch(cdp, 'touchStart', (1, swipe_x, y + 70))
        touch(cdp, 'touchMove', (1, swipe_x, y + 20))
        touch(cdp, 'touchMove', (1, swipe_x, y - 45))
        touch(cdp, 'touchEnd')
        page.wait_for_function('start => window.scrollY > start + 20', arg=before)
    cdp.detach()
