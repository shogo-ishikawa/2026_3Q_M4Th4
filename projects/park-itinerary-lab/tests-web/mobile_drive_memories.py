"""Exercise private and shared albums with two mobile browsers and synthetic photos."""
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
EMAIL = 'guest@university.example.test'
ANOTHER = 'friend@example.test'
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
    section = re.search(r'(<dialog id="albumDialog".*?</dialog>)', html, re.S)
    assert section, 'Missing album dialog in planner'
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
  getState:() => state, getPark:() => park});
</script></html>''')


class LocalAlbums:
    def __init__(self):
        self.albums = {}
        self.photos = {}
        self.files = {}
        self.visibility_version = 1
        self.archive_version = 1
        self.album_version = 2
        self.lose_create_response = False
        self.lose_visibility_response = False
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
        address = EMAIL if uid == 'mock-guest' else 'operator@example.test'
        album_id = payload.get('albumId')
        album = self.albums.get(album_id)
        owner = album is not None and album['owner'] == uid
        photo = self.photos.get(payload.get('photoId'))
        body = {'ok': True}
        if action == 'albums':
            if self.visibility_version:
                body['visibilityVersion'] = self.visibility_version
            if self.archive_version:
                body['archiveVersion'] = self.archive_version
            if self.album_version:
                body['albumVersion'] = self.album_version
            body['albums'], body['hiddenAlbums'] = [], []
            for key, a in self.albums.items():
                if uid == a['owner'] or address in a['members']:
                    target = 'hiddenAlbums' if uid in a['hidden'] else 'albums'
                    body[target].append({'id':key, 'title':a['title'], 'owner':a['owner'] == uid, 'kind':a['kind']})
        elif action == 'create':
            if album is None:
                self.albums[album_id] = {'title':payload['title'], 'kind':payload['kind'], 'owner':uid,
                                         'members':{}, 'hidden':set(), 'creatorAlias':''}
            else:
                assert owner and album['title'] == payload['title'] and album['kind'] == payload['kind']
            if self.lose_create_response:
                self.lose_create_response = False
                route.abort()
                return
        elif action == 'restoreAlbum':
            assert album['kind'] == 'shared' and (owner or address in album['members'])
            album['hidden'].discard(uid)
        elif not album or uid in album['hidden'] or not (owner or address in album['members']):
            body = {'ok': False, 'error':'forbidden'}
        elif action == 'member':
            assert owner and album['kind'] == 'shared'
            if payload['remove']:
                album['members'].pop(payload['email'], None)
            else:
                album['members'][payload['email']] = payload.get('alias') or 'メンバー'
        elif action == 'setAlbumAlias':
            if owner:
                album['creatorAlias'] = payload['alias']
            else:
                album['members'][address] = payload['alias']
        elif action == 'dismissAlbum':
            if album['kind'] == 'shared':
                album['hidden'].add(uid)
            else:
                assert owner
                del self.albums[album_id]
                self.photos = {key:p for key,p in self.photos.items() if p['albumId'] != album_id}
        elif action == 'upload':
            assert set(payload) == {'action','idToken','albumId','photoId','jpeg','visitKey','label','visibility'}
            assert payload['visibility'] in ('album', 'private')
            assert album['kind'] == 'shared' or payload['visibility'] == 'private'
            if payload['visitKey'] == VISIT:
                assert '2回目' in payload['label']
            raw = base64.b64decode(payload['jpeg'], validate=True)
            assert raw.startswith(b'\xff\xd8') and len(raw) <= 1_000_000
            assert METADATA.encode() not in raw and b'camera-roll' not in raw
            self.photos[payload['photoId']] = {**payload, 'uploader':uid}
            self.files[payload['photoId']] = raw
        elif action == 'list':
            body['photos'] = [{
                'id':p['photoId'], 'visitKey':p['visitKey'], 'label':p['label'], 'visibility':p['visibility'],
                'canDelete':owner or p['uploader'] == uid, 'canSetVisibility':p['uploader'] == uid,
            } for p in self.photos.values() if p['albumId'] == album_id
                and (p['visibility'] == 'album' or p['uploader'] == uid)]
            if album['kind'] == 'shared':
                body['participants'] = [{'label':album['creatorAlias'] or '作成者', 'role':'creator', 'self':owner}]
                body['participants'] += [{'label':alias or 'メンバー', 'role':'member', 'self':member == address}
                                         for member, alias in album['members'].items()]
            if owner:
                body['invitations'] = {'addresses':sorted(album['members']), 'unidentified':0}
        elif not photo or photo['albumId'] != album_id or (photo['visibility'] == 'private' and photo['uploader'] != uid):
            body = {'ok': False, 'error':'forbidden'}
        elif action == 'setVisibility':
            assert set(payload) == {'action','idToken','albumId','photoId','visibility'}
            assert photo['uploader'] == uid and payload['visibility'] in ('album', 'private')
            photo['visibility'] = payload['visibility']
            if self.lose_visibility_response:
                route.abort()
                return
        elif action == 'archivePhoto':
            assert photo['uploader'] == uid or owner
            del self.photos[payload['photoId']]
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


def confirmed(page, action, accept=True):
    prompts = []
    def respond(dialog):
        prompts.append(dialog.message)
        if accept:
            dialog.accept()
        else:
            dialog.dismiss()
    page.once('dialog', respond)
    action()
    assert len(prompts) == 1, 'A sharing or deletion confirmation was required'
    return prompts[0]


def open_album(page):
    # Shell navigation and return-to-opener focus are exercised in mobile_replan.
    page.locator('#albumDialog').evaluate("dialog => { dialog.showModal(); dialog.querySelector('details').open = true; }")
    expect(page.get_by_role('dialog', name='夢の思い出')).to_be_visible()


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
        expect(page.get_by_role('dialog')).to_have_count(0)
        page.wait_for_function("typeof window.disposeMemories === 'function'")
        assert store.requests == before
        open_album(page)
        expect(page.locator('#memoryStatus')).to_contain_text('まだありません')
        accounts.append(page)
    owner, guest = accounts
    # A regular account can create a private album. Replaying a create after a
    # lost acknowledgement must keep the original album and its identity.
    for page in accounts:
        expect(page.locator('#memoryPersonalTab')).to_have_attribute('aria-selected', 'true')
        expect(page.locator('#memoryCreate')).to_be_visible()
    guest.locator('#memoryTitle').fill('自分のアルバム')
    store.lose_create_response = True
    guest.locator('#memoryCreateButton').click()
    expect(guest.locator('#memoryStatus')).to_contain_text('接続できません')
    guest.locator('#memoryCreateButton').click()
    expect(guest.locator('#memoryAlbum option:checked')).to_have_text('自分のアルバム')
    personal_id = guest.locator('#memoryAlbum').input_value()
    assert len(store.albums) == 1 and store.albums[personal_id]['kind'] == 'private'
    expect(guest.locator('#memoryPersonalCount')).to_have_text('1')
    expect(guest.locator('#memoryGroupCount')).to_have_text('0')
    expect(guest.locator('#memoryAlbum optgroup')).to_have_attribute('label', '自分が作成')
    expect(guest.locator('#memoryEmail')).to_be_hidden()
    expect(guest.locator('#memoryVisibility')).to_be_hidden()
    guest.locator('#memoryFile').set_input_files({
        'name':'personal.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    guest.locator('#memoryUpload').click()
    expect(guest.locator('#memoryPhotos li')).to_have_count(1)
    expect(guest.locator('#memoryPhotos li select')).to_have_count(0)
    personal_photo = next(iter(store.photos.values()))
    assert personal_photo['visibility'] == 'private'
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryAlbum option:not([value=""])')).to_have_count(0)
    # Switching collection also switches the upload destination before the next
    # file is selected. The private draft must not carry over to a group.
    guest.locator('#memoryFile').set_input_files({
        'name':'unsent-personal.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    for page in accounts:
        page.locator('#memoryGroupTab').click()
        expect(page.locator('#memoryGroupTab')).to_have_attribute('aria-selected', 'true')
    owner.locator('#memoryTitle').fill('テストの思い出')
    owner.locator('#memoryCreateButton').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('アルバムを作りました')
    expect(owner.locator('#memoryAlbum option:checked')).to_have_text('テストの思い出')

    # Older deployments cannot accept a private upload.
    store.album_version = None
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('アルバムを開けません')
    expect(owner.locator('#memoryCreate')).to_be_hidden()
    expect(owner.locator('#memoryUpload')).to_be_hidden()
    expect(owner.locator('#memoryAlbum option:not([value=""])')).to_have_count(0)
    store.album_version = 2
    owner.locator('#memoryRefresh').click()

    owner.locator('#memoryVisit').select_option(VISIT)
    owner.locator('#memoryFile').set_input_files({
        'name':'camera-roll-private.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    assert set(store.photos) == {personal_photo['photoId']}
    owner.locator('#memoryUpload').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('写真を追加しました')
    owner_photo = next(p for p in store.photos.values() if p['albumId'] != personal_id)
    assert store.images_read == 0 and owner_photo['visibility'] == 'private'
    expect(owner.get_by_role('region', name='写真を追加').get_by_label('追加する写真の公開範囲')).to_have_value('private')
    expect(owner.locator('#memoryPhotos li select')).to_have_value('private')
    # A backend that still trashes originals must not be used for removal.
    store.archive_version = None
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryDeleteAlbum')).to_be_hidden()
    expect(owner.locator('#memoryPhotos li').get_by_role('button', name='写真を削除')).to_have_count(0)
    store.archive_version = 1
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryDeleteAlbum')).to_be_hidden()
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
    owner.locator('#memoryInviteAlias').fill('同行の友達')
    owner.locator('#memoryInvite').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('招待しました')
    expect(owner.locator('#memoryRoster')).to_contain_text(EMAIL)
    expect(owner.locator('#memoryParticipants')).to_contain_text('同行の友達')
    guest.locator('#memoryRefresh').click()
    expect(guest.locator('#memoryStatus')).to_contain_text('写真はまだありません')
    assert guest.locator('#memoryFile').evaluate('el => el.files.length') == 0
    expect(guest.locator('#memoryAlbum optgroup')).to_have_attribute('label', '招待されたアルバム')
    expect(guest.locator('#memoryGroupCount')).to_have_text('1')
    guest.set_viewport_size({'width':320, 'height':700})
    assert guest.locator('#albumDialog').evaluate('el => el.scrollWidth <= el.clientWidth')
    for tab in ('#memoryPersonalTab', '#memoryGroupTab'):
        b = guest.locator(tab).bounding_box()
        assert b and b['x'] >= 0 and b['x'] + b['width'] <= 320 and b['height'] >= 44, (tab, b)
    guest.set_viewport_size({'width':390, 'height':844})
    expect(guest.locator('#memoryEmail')).to_be_hidden()
    expect(guest.locator('#memoryParticipants')).to_contain_text('同行の友達')
    expect(guest.locator('#memoryParticipants')).not_to_contain_text('@')
    guest.locator('#memoryAlias').fill('新しい呼び名')
    guest.locator('#memorySetAlias').click()
    expect(guest.locator('#memoryParticipants')).to_contain_text('新しい呼び名')
    expect(guest.locator('#memoryVisibility')).to_have_value('private')
    guest.locator('#memoryFile').set_input_files({
        'name':'guest.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    guest.locator('#memoryUpload').click()
    expect(guest.locator('#memoryPhotos li select')).to_have_value('private')
    # Two pictures of the same visit must stay distinguishable when sharing or removing one.
    guest.locator('#memoryFile').set_input_files({
        'name':'another-photo.png', 'mimeType':'image/png', 'buffer':synthetic_photo(),
    })
    guest.locator('#memoryUpload').click()
    guest_rows = guest.locator('#memoryPhotos li')
    expect(guest_rows).to_have_count(2)
    first, second = (p for p in store.photos.values() if p['uploader'] == 'mock-guest' and p['albumId'] != personal_id)
    assert first['visibility'] == second['visibility'] == 'private'
    guest_row = guest_rows.filter(has_text='写真2')
    guest_row.get_by_role('button', name=re.compile('を見る$')).click()
    expect(guest_row.locator('#memoryPreview')).to_be_visible()
    expect(guest_row.locator('#memoryCaption')).to_contain_text('写真2')
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('1枚')
    audience = guest_row.get_by_role('combobox', name=re.compile('この写真の公開範囲'))
    assert '写真2' in confirmed(guest, lambda: audience.select_option('album'), accept=False)
    expect(audience).to_have_value('private')
    # Losing the reply after a successful write must never mislabel a shared picture as private.
    store.lose_visibility_response = True
    confirmed(guest, lambda: audience.select_option('album'))
    expect(guest.locator('#memoryStatus')).to_contain_text('接続できません')
    expect(audience).to_be_disabled()
    expect(audience).to_have_value('')
    store.lose_visibility_response = False
    guest.locator('#memoryRefresh').click()
    expect(audience).to_have_value('album')
    guest_row.get_by_role('button', name=re.compile('を見る$')).click()
    expect(guest_row.locator('#memoryPreview')).to_be_visible()
    assert first['visibility'] == 'private' and second['visibility'] == 'album'
    wait_for_poll(owner, 'list')
    guest_photo_row = owner.locator('#memoryPhotos li').filter(has_text='自由な思い出')
    expect(guest_photo_row).to_contain_text('メンバーに共有中')
    expect(guest_photo_row.get_by_role('combobox')).to_have_count(0)
    guest_photo_row.get_by_role('button', name=re.compile('を見る$')).click()
    expect(owner.locator('#memoryPreview')).to_be_visible()
    audience.select_option('private')
    expect(audience).to_have_value('private')
    wait_for_poll(owner, 'list')
    expect(guest_photo_row).to_have_count(0)
    expect(owner.locator('#memoryPreview')).to_be_hidden()
    assert owner.locator('#memoryImage').get_attribute('src') is None
    remove = guest_row.get_by_role('button', name='写真を削除')
    assert '保存済みの画像ファイルは残ります' in confirmed(guest, remove.click, accept=False)
    expect(guest_rows).to_have_count(2)
    assert '写真2' in confirmed(guest, remove.click)
    expect(guest_rows).to_have_count(1)
    assert second['photoId'] not in store.photos and first['photoId'] in store.photos
    assert second['photoId'] in store.files
    expect(guest.locator('#memoryPreview')).to_be_hidden()

    # Initial sharing requires confirmation too. A canceled upload leaves the picker intact.
    owner.locator('#memoryVisit').select_option(VISIT[:-1] + '1')
    confirmed(owner, owner.locator('#memoryUpload').click, accept=False)
    assert len(store.photos) == 3
    confirmed(owner, owner.locator('#memoryUpload').click)
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    shared = next(p for p in store.photos.values() if p['visibility'] == 'album')
    guest.locator('#memoryRefresh').click()
    shared_row = guest.locator('#memoryPhotos li').filter(has_text=shared['label'])
    expect(shared_row).to_contain_text('メンバーに共有中')
    expect(shared_row.get_by_role('combobox')).to_have_count(0)
    expect(shared_row.get_by_role('button', name='写真を削除')).to_have_count(0)
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
    first_album = owner.locator('#memoryAlbum').input_value()

    # Hiding from the guest's own list preserves everyone else's access, photos
    # and grants. Restore returns the identical shared album and its pictures.
    other = guest.locator('#memoryHideAlbum')
    prompt = confirmed(guest, other.click, accept=False)
    assert 'テストの思い出' in prompt
    expect(guest.locator('#memoryAlbum')).to_have_value(first_album)
    confirmed(guest, other.click)
    expect(guest.locator('#memoryAlbum option:not([value=""])')).to_have_count(0)
    expect(guest.locator('#memoryPreview')).to_be_hidden()
    assert EMAIL in store.albums[first_album]['members']
    owner.locator('#memoryRefresh').click()
    expect(owner.locator('#memoryAlbum')).to_have_value(first_album)
    expect(owner.locator('#memoryRoster')).to_contain_text(EMAIL)
    guest.locator('#memoryHiddenAlbums').select_option(first_album)
    guest.locator('#memoryRestoreAlbum').click()
    expect(guest.locator('#memoryAlbum')).to_have_value(first_album)
    open_image.click()
    expect(guest.locator('#memoryPreview')).to_be_visible()

    # A revoke action belongs to the chosen person in one specific album.
    owner.locator('#memoryVisibility').select_option('album')
    owner.locator('#memoryTitle').fill('別の日の思い出')
    owner.locator('#memoryCreateButton').click()
    expect(owner.locator('#memoryStatus')).to_contain_text('アルバムを作りました')
    expect(owner.locator('#memoryVisibility')).to_have_value('private')
    other_album = owner.locator('#memoryAlbum').input_value()
    assert other_album != first_album
    for invited in (ANOTHER, EMAIL):
        owner.locator('#memoryEmail').fill(invited)
        owner.locator('#memoryInvite').click()
        expect(owner.locator('#memoryRoster')).to_contain_text(invited)
    guest.locator('#memoryRefresh').click()
    expect(guest.locator('#memoryGroupCount')).to_have_text('2')
    expect(guest.locator('#memoryAlbum optgroup[label="招待されたアルバム"] option')).to_have_count(2)
    old_button = owner.locator('#memoryRoster li').filter(has_text=EMAIL).get_by_role('button').element_handle()
    owner.locator('#memoryAlbum').select_option(first_album)
    expect(owner.locator('#memoryRosterHeading')).to_contain_text('テストの思い出')
    stale_prompts = []
    def catch_stale_prompt(dialog):
        stale_prompts.append(dialog.message)
        dialog.dismiss()
    owner.on('dialog', catch_stale_prompt)
    old_button.evaluate('el => el.click()')
    owner.remove_listener('dialog', catch_stale_prompt)
    assert not stale_prompts
    owner.locator('#memoryEmail').fill(ANOTHER)
    owner.locator('#memoryInvite').click()
    expect(owner.locator('#memoryRoster')).to_contain_text(ANOTHER)
    revoke = owner.locator('#memoryRoster li').filter(has_text=EMAIL).get_by_role('button')
    prompt = confirmed(owner, revoke.click, accept=False)
    assert 'テストの思い出' in prompt and EMAIL in prompt
    expect(owner.locator('#memoryRoster')).to_contain_text(EMAIL)
    confirmed(owner, revoke.click)
    expect(owner.locator('#memoryRoster')).not_to_contain_text(EMAIL)
    assert set(store.albums[other_album]['members']) == {EMAIL, ANOTHER}
    assert set(store.albums[first_album]['members']) == {ANOTHER}
    wait_for_poll(guest, 'albums')
    expect(guest.locator('#memoryAlbum')).to_have_value(other_album)
    expect(guest.locator('#memoryPhotos button')).to_have_count(0)
    assert guest.locator('#memoryImage').get_attribute('src') is None
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
    open_album(owner)
    owner.locator('#memoryGroupTab').click()
    owner.locator('#memoryAlbum').select_option(first_album)
    owner.locator('#memoryPhotos button').first.click()
    expect(owner.locator('#memoryPreview')).to_be_visible()
    # A group's creator also removes it from their own list only.
    confirmed(owner, owner.locator('#memoryHideAlbum').click)
    expect(owner.locator('#memoryPreview')).to_be_hidden()
    assert first_album in store.albums and all(p['photoId'] in store.files for p in (owner_photo, first, second, shared))

    owner.locator('#memoryAlbum').select_option(other_album)
    expect(owner.locator('#memoryRoster')).to_contain_text(EMAIL)
    confirmed(owner, owner.locator('#memoryHideAlbum').click)
    expect(owner.locator('#memoryAlbum option:not([value=""])')).to_have_count(0)
    guest.locator('#memoryRefresh').click()
    expect(guest.locator('#memoryAlbum')).to_have_value(other_album)
    expect(guest.locator('#memoryParticipants')).to_contain_text('メンバー')
    guest.locator('#memoryTitle').fill('友達が作った共有アルバム')
    guest.locator('#memoryCreateButton').click()
    expect(guest.locator('#memoryAlbum option:checked')).to_have_text('友達が作った共有アルバム')
    assert store.albums[guest.locator('#memoryAlbum').input_value()]['owner'] == 'mock-guest'
    guest.locator('#memoryPersonalTab').click()
    expect(guest.locator('#memoryAlbum')).to_have_value(personal_id)
    expect(guest.locator('#memoryPhotos li')).to_have_count(1)
    prompt = confirmed(guest, guest.locator('#memoryDeleteAlbum').click)
    assert '自分のアルバム' in prompt
    expect(guest.locator('#memoryAlbum option:not([value=""])')).to_have_count(0)
    assert personal_id not in store.albums and personal_photo['photoId'] in store.files


if __name__ == '__main__':
    with sync_playwright() as pw:
        executable = os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium') or shutil.which('google-chrome')
        browser = pw.chromium.launch(executable_path=executable, headless=True)
        try:
            run(browser)
        finally:
            browser.close()
    print('Drive memories mobile browser checks passed.')
