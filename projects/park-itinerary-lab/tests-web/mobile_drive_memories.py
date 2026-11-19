"""Exercise the private album UI with local-only, synthetic accounts and photos."""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import struct
from urllib.parse import urlsplit
import zlib

from playwright.sync_api import expect, sync_playwright

WEB = Path(__file__).resolve().parents[1] / 'web'
ORIGIN = 'http://127.0.0.1:4173'
ENDPOINT = 'https://script.google.com/macros/s/fixture12345/exec'
METADATA = 'private-camera-tag'
EMAIL = 'guest@example.test'
VISIT = '2026-11-19:land:land-ride:2'


def synthetic_photo():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    header = struct.pack('>IIBBBBB', 2400, 400, 8, 2, 0, 0, 0)
    rows = (b'\0' + bytes([66, 36, 130]) * 2400) * 400
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'tEXt', b'Comment\0' + METADATA.encode())
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def fixture_page():
    html = (WEB / 'index.html').read_text()
    section = re.search(r'(<details id="driveMemories".*?</details>)', html, re.S)
    assert section, 'Missing album panel in planner'
    return ('''<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css"><div id="workflowSchedule">'''
            + section[1] + '''</div><script type="module">
import {mountDriveMemories} from '/drive-memories.js';
const role = location.pathname.slice(1);
const date = '2026-11-19', parkId = 'land';
const state = {parkId, settings:{date}, result:{parkId, settings:{date},
  visits:[{id:'land-ride'}, {id:'land-ride~2'}]}};
const park = {id:parkId, activities:[{id:'land-ride',name:'テスト施設'}]};
window.disposeMemories = mountDriveMemories({getIdToken:async () => 'mock-' + role,
  isOwner:role === 'owner', getState:() => state, getPark:() => park});
</script></html>''')


class LocalAlbums:
    def __init__(self):
        self.album = None
        self.member = False
        self.photo = None
        self.requests = 0
        self.images_read = 0
        self.delay_image = False
        self.pending = None

    def route(self, route):
        request = route.request
        if request.url != ENDPOINT:
            path = urlsplit(request.url).path
            if not request.url.startswith(ORIGIN + '/'):
                route.abort()
            elif path in ('/owner', '/guest'):
                route.fulfill(content_type='text/html;charset=utf-8', body=fixture_page())
            elif path in ('/drive-memories.js', '/repeat-visits.js', '/style.css'):
                body = (WEB / path[1:]).read_text()
                if path == '/drive-memories.js':
                    body, count = re.subn(r"const MEMORIES_ENDPOINT = '[^']*';",
                                          "const MEMORIES_ENDPOINT = '" + ENDPOINT + "';", body)
                    assert count == 1
                route.fulfill(content_type='text/css' if path.endswith('css') else 'text/javascript', body=body)
            else:
                route.fulfill(status=404, body='')
            return
        self.requests += 1
        assert request.method == 'POST'
        assert request.headers['content-type'].startswith('text/plain')
        assert not {'cookie', 'referer', 'authorization'} & request.headers.keys()
        payload = json.loads(request.post_data)
        action = payload['action']
        assert payload['idToken'] in ('mock-owner', 'mock-guest')
        owner = payload['idToken'] == 'mock-owner'
        body = {'ok': True}
        if action == 'albums':
            body['albums'] = [{**self.album, 'owner':owner}] if self.album and (self.member or owner) else []
        elif action == 'create':
            assert owner and not self.album
            self.album = {'id':payload['albumId'], 'title':payload['title']}
        elif not self.album or not (owner or self.member) or payload['albumId'] != self.album['id']:
            body = {'ok': False, 'error':'forbidden'}
        elif action == 'member':
            assert owner and payload['email'] == EMAIL
            self.member = not payload['remove']
        elif action == 'deleteAlbum':
            assert owner
            self.album = self.photo = None
            self.member = False
        elif action == 'upload':
            assert set(payload) == {'action','idToken','albumId','photoId','jpeg','visitKey','label'}
            assert payload['visitKey'] == VISIT and '2回目' in payload['label']
            raw = base64.b64decode(payload['jpeg'], validate=True)
            assert raw.startswith(b'\xff\xd8') and len(raw) <= 1_000_000
            assert METADATA.encode() not in raw and b'camera-roll' not in raw
            self.photo = {**payload, 'uploader':payload['idToken']}
        elif action == 'list':
            body['photos'] = [] if not self.photo else [{
                'id':self.photo['photoId'], 'visitKey':self.photo['visitKey'], 'label':self.photo['label'],
                'canDelete':owner or self.photo['uploader'] == payload['idToken'],
            }]
        elif action == 'image':
            assert self.photo and payload['photoId'] == self.photo['photoId']
            self.images_read += 1
            if self.delay_image:
                self.pending = route
                return
            body['jpeg'] = self.photo['jpeg']
        else:
            raise AssertionError(action)
        self.reply(route, body)

    @staticmethod
    def reply(route, body):
        route.fulfill(headers={'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json'},
                      body=json.dumps(body))


def wait_for_poll(page, action):
    def matches(response):
        return response.url == ENDPOINT and json.loads(response.request.post_data)['action'] == action

    with page.expect_response(matches) as received:
        page.clock.fast_forward(60_000)
    received.value.body()
    page.evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')


def run(browser):
    store = LocalAlbums()
    accounts = []
    for role in ('owner', 'guest'):
        context = browser.new_context(viewport={'width':390, 'height':844}, is_mobile=True, has_touch=True)
        context.route('**/*', store.route)
        page = context.new_page()
        page.clock.install()
        before = store.requests
        page.goto(ORIGIN + '/' + role)
        expect(page.locator('#driveMemories summary')).to_be_visible()
        assert store.requests == before
        page.locator('#driveMemories summary').click()
        expect(page.locator('#memoryStatus')).to_contain_text('まだありません')
        accounts.append(page)
    owner, guest = accounts
    expect(guest.locator('#memoryCreate')).to_be_hidden()
    owner.locator('#memoryTitle').fill('テストの思い出')
    owner.locator('#memoryCreateButton').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('アルバムを作りました')
    expect(owner.locator('#memoryAlbum option:checked')).to_have_text('テストの思い出')

    owner.locator('#memoryVisit').select_option(VISIT)
    owner.locator('#memoryFile').set_input_files({
        'name':'camera-roll-private.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    assert store.photo is None
    owner.locator('#memoryUpload').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('写真を追加しました')
    assert store.images_read == 0
    owner.locator('#memoryPhotos button').first.click()
    expect(owner.locator('#memoryPreview')).to_be_visible()
    width, height = owner.locator('#memoryImage').evaluate(
        'async img => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; }')
    assert width == 2048 and height == 341
    preview = owner.locator('#memoryImage').get_attribute('src')
    owner.locator('#memoryFile').set_input_files({
        'name':'draft.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    wait_for_poll(owner, 'list')
    expect(owner.locator('#memoryPreview')).to_be_visible()
    assert owner.locator('#memoryImage').get_attribute('src') == preview and store.images_read == 1
    assert owner.locator('#memoryFile').evaluate('el => el.files[0]?.name') == 'draft.png'
    expect(owner.locator('#memoryVisit')).to_have_value(VISIT)
    owner.locator('#memoryCloseImage').click()
    assert owner.locator('#memoryImage').get_attribute('src') is None

    owner.locator('#memoryEmail').fill(EMAIL)
    owner.locator('#memoryInvite').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('招待しました')
    guest.locator('#memoryRefresh').click()
    expect(guest.locator('#memoryPhotos button')).to_have_count(1)
    expect(guest.locator('#memoryMembers')).to_be_hidden()
    guest.locator('#memoryPhotos button').click()
    expect(guest.locator('#memoryPreview')).to_be_visible()
    guest.context.set_offline(True)
    expect(guest.locator('#memoryPreview')).to_be_hidden()
    assert guest.locator('#memoryImage').get_attribute('src') is None
    guest.context.set_offline(False)
    guest.locator('#memoryPhotos button').click()
    expect(guest.locator('#memoryPreview')).to_be_visible()
    # Another device deletes a photo while a guest is viewing it.
    saved = store.photo
    store.photo = None
    wait_for_poll(guest, 'list')
    expect(guest.locator('#memoryPreview')).to_be_hidden()
    assert guest.locator('#memoryImage').get_attribute('src') is None
    expect(guest.locator('#memoryPhotos button')).to_have_count(0)
    store.photo = saved
    guest.locator('#memoryRefresh').click()
    guest.locator('#memoryPhotos button').click()
    expect(guest.locator('#memoryPreview')).to_be_visible()
    owner.locator('#memoryEmail').fill(EMAIL)
    owner.once('dialog', lambda dialog: dialog.accept())
    owner.locator('#memoryRevoke').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('招待を取り消しました')
    wait_for_poll(guest, 'albums')
    expect(guest.locator('#memoryStatus')).to_contain_text('まだありません')
    expect(guest.locator('#memoryPhotos button')).to_have_count(0)
    assert guest.locator('#memoryImage').get_attribute('src') is None

    # With a response already in flight, unmounting removes the session and its photos.
    store.delay_image = True
    with owner.expect_request(ENDPOINT):
        owner.locator('#memoryPhotos button').first.click()
    owner.evaluate('window.disposeMemories()')
    assert store.pending
    store.reply(store.pending, {'ok': True, 'jpeg':store.photo['jpeg']})
    expect(owner.locator('#driveMemories')).to_be_hidden()
    assert owner.locator('#memoryImage').get_attribute('src') is None
    expect(owner.locator('#memoryPhotos button')).to_have_count(0)

    store.delay_image = False
    owner.reload()
    owner.locator('#driveMemories summary').click()
    owner.locator('#memoryPhotos button').first.click()
    expect(owner.locator('#memoryPreview')).to_be_visible()
    confirmations = []
    def confirm_deletion(dialog):
        confirmations.append(dialog.message)
        dialog.accept()
    owner.once('dialog', confirm_deletion)
    owner.locator('#memoryDeleteAlbum').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('アルバムを削除しました')
    assert len(confirmations) == 1 and 'テストの思い出' in confirmations[0] and '写真' in confirmations[0]
    assert store.album is None and store.photo is None
    assert owner.locator('#memoryImage').get_attribute('src') is None
    expect(owner.locator('#memoryPhotos button')).to_have_count(0)
    expect(owner.locator('#memoryAlbum option')).to_have_count(0)


if __name__ == '__main__':
    with sync_playwright() as pw:
        executable = os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium') or shutil.which('google-chrome')
        browser = pw.chromium.launch(executable_path=executable, headless=True)
        try:
            run(browser)
        finally:
            browser.close()
    print('Drive memories mobile browser checks passed.')
