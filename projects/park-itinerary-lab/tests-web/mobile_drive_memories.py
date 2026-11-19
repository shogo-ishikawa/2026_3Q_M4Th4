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
        self.albums = {}
        self.photos = {}
        self.visibility_version = 1
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
        uid = payload['idToken']
        owner = uid == 'mock-owner'
        album_id = payload.get('albumId')
        album = self.albums.get(album_id)
        photo = self.photos.get(payload.get('photoId'))
        body = {'ok': True}
        if action == 'albums':
            if self.visibility_version:
                body['visibilityVersion'] = self.visibility_version
            body['albums'] = [{'id':key, 'title':a['title'], 'owner':owner}
                              for key, a in self.albums.items() if owner or a['member']]
        elif action == 'create':
            assert owner and album is None
            self.albums[album_id] = {'title':payload['title'], 'member':False}
        elif not album or not (owner or album['member']):
            body = {'ok': False, 'error':'forbidden'}
        elif action == 'member':
            assert owner and payload['email'] == EMAIL
            album['member'] = not payload['remove']
        elif action == 'deleteAlbum':
            assert owner
            del self.albums[album_id]
            self.photos = {key:p for key,p in self.photos.items() if p['albumId'] != album_id}
        elif action == 'upload':
            assert set(payload) == {'action','idToken','albumId','photoId','jpeg','visitKey','label','visibility'}
            assert payload['visibility'] in ('album', 'private')
            if payload['visitKey'] == VISIT:
                assert '2回目' in payload['label']
            raw = base64.b64decode(payload['jpeg'], validate=True)
            assert raw.startswith(b'\xff\xd8') and len(raw) <= 1_000_000
            assert METADATA.encode() not in raw and b'camera-roll' not in raw
            self.photos[payload['photoId']] = {**payload, 'uploader':uid}
        elif action == 'list':
            body['photos'] = [{
                'id':p['photoId'], 'visitKey':p['visitKey'], 'label':p['label'], 'visibility':p['visibility'],
                'canDelete':owner or p['uploader'] == uid, 'canSetVisibility':p['uploader'] == uid,
            } for p in self.photos.values() if p['albumId'] == album_id
                and (p['visibility'] == 'album' or p['uploader'] == uid)]
        elif not photo or photo['albumId'] != album_id or (photo['visibility'] == 'private' and photo['uploader'] != uid):
            body = {'ok': False, 'error':'forbidden'}
        elif action == 'setVisibility':
            assert set(payload) == {'action','idToken','albumId','photoId','visibility'}
            assert photo['uploader'] == uid and payload['visibility'] in ('album', 'private')
            photo['visibility'] = payload['visibility']
        elif action == 'image':
            self.images_read += 1
            if self.delay_image:
                self.pending = route
                return
            body['jpeg'] = photo['jpeg']
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


def confirm_click(page, button, accept=True):
    prompts = []
    def respond(dialog):
        prompts.append(dialog.message)
        if accept:
            dialog.accept()
        else:
            dialog.dismiss()
    page.once('dialog', respond)
    button.click()
    assert len(prompts) == 1, 'A sharing or deletion confirmation was required'
    return prompts[0]


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

    # Older deployments cannot accept a private upload.
    store.visibility_version = None
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('アルバムを開けません')
    expect(owner.locator('#memoryCreate')).to_be_hidden()
    expect(owner.locator('#memoryUpload')).to_be_hidden()
    expect(owner.locator('#memoryAlbum option')).to_have_count(0)
    store.visibility_version = 1
    owner.locator('#memoryRefresh').click()

    owner.locator('#memoryVisit').select_option(VISIT)
    owner.locator('#memoryFile').set_input_files({
        'name':'camera-roll-private.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    assert not store.photos
    owner.locator('#memoryUpload').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('写真を追加しました')
    owner_photo = next(iter(store.photos.values()))
    assert store.images_read == 0 and owner_photo['visibility'] == 'private'
    expect(owner.locator('#memoryPhotos li')).to_contain_text('自分だけ')
    owner.locator('#memoryPhotos button').first.click()
    expect(owner.locator('#memoryPreview')).to_be_visible()
    width, height = owner.locator('#memoryImage').evaluate(
        'async img => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; }')
    assert width == 2048 and height == 341
    preview = owner.locator('#memoryImage').get_attribute('src')
    owner.locator('#memoryFile').set_input_files({
        'name':'draft.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    owner.locator('#memoryVisibility').select_option('album')
    wait_for_poll(owner, 'list')
    expect(owner.locator('#memoryPreview')).to_be_visible()
    assert owner.locator('#memoryImage').get_attribute('src') == preview and store.images_read == 1
    assert owner.locator('#memoryFile').evaluate('el => el.files[0]?.name') == 'draft.png'
    expect(owner.locator('#memoryVisit')).to_have_value(VISIT)
    expect(owner.locator('#memoryVisibility')).to_have_value('album')
    owner.locator('#memoryCloseImage').click()
    assert owner.locator('#memoryImage').get_attribute('src') is None

    owner.locator('#memoryEmail').fill(EMAIL)
    owner.locator('#memoryInvite').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('招待しました')
    guest.locator('#memoryRefresh').click()
    expect(guest.locator('#memoryStatus')).to_contain_text('写真はまだありません')
    expect(guest.locator('#memoryMembers')).to_be_hidden()
    expect(guest.locator('#memoryVisibility')).to_have_value('private')
    guest.locator('#memoryFile').set_input_files({
        'name':'guest.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    guest.locator('#memoryUpload').click()
    expect(guest.locator('#memoryPhotos li')).to_contain_text('自分だけ')
    guest_photo = next(p for p in store.photos.values() if p['uploader'] == 'mock-guest')
    assert guest_photo['visibility'] == 'private'
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('1枚')
    guest_row = guest.locator('#memoryPhotos li')
    share = guest_row.get_by_role('button', name='メンバーに共有', exact=True)
    confirm_click(guest, share, accept=False)
    assert guest_photo['visibility'] == 'private'
    confirm_click(guest, share)
    expect(guest_row).to_contain_text('メンバーに共有中')
    wait_for_poll(owner, 'list')
    guest_photo_row = owner.locator('#memoryPhotos li').filter(has_text='自由な思い出')
    expect(guest_photo_row).to_contain_text('メンバーに共有中')
    expect(guest_photo_row.get_by_role('button', name='自分だけに戻す')).to_have_count(0)
    guest_photo_row.get_by_role('button', name=re.compile('を見る$')).click()
    expect(owner.locator('#memoryPreview')).to_be_visible()
    guest_row.get_by_role('button', name='自分だけに戻す', exact=True).click()
    expect(guest_row).to_contain_text('自分だけ')
    wait_for_poll(owner, 'list')
    expect(guest_photo_row).to_have_count(0)
    expect(owner.locator('#memoryPreview')).to_be_hidden()
    assert owner.locator('#memoryImage').get_attribute('src') is None

    # Initial sharing requires confirmation too. A canceled upload leaves the picker intact.
    owner.locator('#memoryVisit').select_option(VISIT[:-1] + '1')
    confirm_click(owner, owner.locator('#memoryUpload'), accept=False)
    assert len(store.photos) == 2
    confirm_click(owner, owner.locator('#memoryUpload'))
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    shared = next(p for p in store.photos.values() if p['visibility'] == 'album')
    guest.locator('#memoryRefresh').click()
    shared_row = guest.locator('#memoryPhotos li').filter(has_text=shared['label'])
    expect(shared_row).to_contain_text('メンバーに共有中')
    expect(shared_row.get_by_role('button', name='自分だけに戻す')).to_have_count(0)
    expect(shared_row.get_by_role('button', name='削除')).to_have_count(0)
    open_image = shared_row.get_by_role('button', name=re.compile('を見る$'))
    open_image.click()
    expect(guest.locator('#memoryPreview')).to_be_visible()
    guest.context.set_offline(True)
    expect(guest.locator('#memoryPreview')).to_be_hidden()
    assert guest.locator('#memoryImage').get_attribute('src') is None
    guest.context.set_offline(False)
    open_image.click()
    expect(guest.locator('#memoryPreview')).to_be_visible()
    # Another device deletes a photo while a guest is viewing it.
    del store.photos[shared['photoId']]
    wait_for_poll(guest, 'list')
    expect(guest.locator('#memoryPreview')).to_be_hidden()
    assert guest.locator('#memoryImage').get_attribute('src') is None
    expect(shared_row).to_have_count(0)
    store.photos[shared['photoId']] = shared
    guest.locator('#memoryRefresh').click()
    open_image.click()
    expect(guest.locator('#memoryPreview')).to_be_visible()
    owner.locator('#memoryEmail').fill(EMAIL)
    owner.once('dialog', lambda dialog: dialog.accept())
    owner.locator('#memoryRevoke').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('招待を取り消しました')
    wait_for_poll(guest, 'albums')
    expect(guest.locator('#memoryStatus')).to_contain_text('まだありません')
    expect(guest.locator('#memoryPhotos button')).to_have_count(0)
    assert guest.locator('#memoryImage').get_attribute('src') is None

    # A draft for one album must never preselect sharing in another album.
    first_album = owner.locator('#memoryAlbum').input_value()
    owner.locator('#memoryVisibility').select_option('album')
    owner.locator('#memoryTitle').fill('別の日の思い出')
    owner.locator('#memoryCreateButton').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('アルバムを作りました')
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    owner.locator('#memoryVisibility').select_option('album')
    confirm_click(owner, owner.locator('#memoryDeleteAlbum'))
    expect(owner.locator('#memoryAlbum')).to_have_value(first_album)
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    owner.locator('#memoryVisibility').select_option('album')

    # With a response already in flight, unmounting removes the session and its photos.
    store.delay_image = True
    with owner.expect_request(ENDPOINT):
        owner.locator('#memoryPhotos button').first.click()
    owner.evaluate('window.disposeMemories()')
    assert store.pending
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    store.reply(store.pending, {'ok': True, 'jpeg':owner_photo['jpeg']})
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
    assert not store.albums and not store.photos
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
