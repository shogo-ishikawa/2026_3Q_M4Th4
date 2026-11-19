import {baseVisitId, isRepeatVisit} from './repeat-visits.js?v=2.6.1';

const MEMORIES_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwfjkYRgpGxZl7PlUazqT9vMS0BACICgo__EigzhXwqX9enley0_ZPJRgJYTyp0o9jp/exec';
const DEPLOYMENT = /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/;
const MAX_BYTES = 1000000;
const MAX_SIDE = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errorText = {
  auth:'ログインし直してください。', forbidden:'このアルバムへのアクセス権がありません。',
  'not-found':'アルバムまたは写真が見つかりません。', invalid:'入力内容を確認してください。',
  limit:'アルバムの上限に達しました。', busy:'混み合っています。少し待ってから再度お試しください。',
  offline:'接続できません。通信状況を確認して、もう一度お試しください。',
  version:'保存先と公開範囲を確認できないため、アルバムを開けません。',
  conflict:'内容が変更されました。アルバムを更新してください。',
  file:'この写真を読み込めません。JPEG または PNG 形式でお試しください。',
  size:'写真が大きすぎます。小さくしてから選び直してください。'
};
const failure = code => Object.assign(new Error(code), {code});
const assertActive = signal => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); };

export function makeAlbumClient(endpoint, getIdToken, send = fetch) {
  if (!DEPLOYMENT.test(endpoint)) throw failure('invalid');
  return async (action, fields, signal) => {
    assertActive(signal);
    let idToken;
    try { idToken = await getIdToken(); } catch { throw failure('auth'); }
    assertActive(signal);
    if (!idToken) throw failure('auth');
    const response = await send(endpoint, {method:'POST', credentials:'omit', referrerPolicy:'no-referrer',
      cache:'no-store', headers:{'Content-Type':'text/plain;charset=UTF-8'}, signal,
      body:JSON.stringify({...fields, action, idToken})});
    if (!response.ok) throw failure('offline');
    const body = await response.json();
    assertActive(signal);
    if (body?.ok !== true) throw failure(Object.hasOwn(errorText, body?.error) ? body.error : 'offline');
    if (action === 'albums' && (body.visibilityVersion !== 1 || body.albumVersion !== 2)) throw failure('version');
    return body;
  };
}

export function photoVisits(state, park) {
  const date = state?.settings?.date;
  const parkId = park?.id;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['land','sea'].includes(parkId) || state.parkId !== parkId) return [];
  const choices = [{visitKey:date + ':' + parkId + ':free:1', label:date + ' 自由な思い出'}];
  const prefix = date + ':' + parkId + ':';
  const seen = new Set();
  const facilities = new Map((park.activities || []).map(a => [a.id, a.name]));
  function add(id) {
    const base = baseVisitId(id);
    if (seen.has(id) || !facilities.has(base) || !/^[A-Za-z0-9_-]+$/.test(base)) return;
    seen.add(id);
    const occurrence = isRepeatVisit(id) ? 2 : 1;
    const visitKey = prefix + base + ':' + occurrence;
    if (visitKey.length > 128) return;
    choices.push({visitKey, label:(date + ' ' + facilities.get(base) + (occurrence === 2 ? '（2回目）' : '')).slice(0,100)});
  }
  const plan = state.result;
  if (plan?.settings?.date === date && plan.parkId === parkId) {
    for (const visit of plan.visits || []) add(visit.activityId || visit.id);
  }
  const progress = state.settings.dayProgress;
  if (progress?.date === date && progress.parkId === parkId) {
    for (const [id, record] of Object.entries(progress.visits || {})) {
      if (['done','queue','riding'].includes(record?.status)) add(id);
    }
  }
  return choices;
}

export function canViewPhoto(photo) {
  if (!photo || !UUID.test(photo.id) || typeof photo.label !== 'string' || typeof photo.canSetVisibility !== 'boolean') return false;
  return photo.visibility === 'album' || (photo.visibility === 'private' && photo.canSetVisibility);
}

function readBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(failure('file'));
    reader.readAsDataURL(blob);
  });
}

export async function photoJpeg(file, signal) {
  if (!file || !file.size || file.type === 'image/svg+xml') throw failure('file');
  if (file.size > 32 * 1024 * 1024) throw failure('size');
  assertActive(signal);
  const source = URL.createObjectURL(file);
  const canvas = document.createElement('canvas');
  try {
    const img = new Image();
    img.src = source;
    try { await img.decode(); } catch { throw failure('file'); }
    assertActive(signal);
    const {naturalWidth:width, naturalHeight:height} = img;
    if (!width || !height || width * height > 65000000) throw failure('size');
    let scale = Math.min(1, MAX_SIDE / Math.max(width,height));
    // Re-encode pixels only. Filenames, EXIF and location data never leave the device.
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1,Math.round(width * scale));
      canvas.height = Math.max(1,Math.round(height * scale));
      const ctx = canvas.getContext('2d', {alpha:false});
      ctx.fillStyle = '#fff';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .84));
      assertActive(signal);
      if (!jpeg || jpeg.type !== 'image/jpeg') throw failure('file');
      if (jpeg.size <= MAX_BYTES) return await readBase64(jpeg);
      scale *= .72;
    }
    throw failure('size');
  } finally {
    canvas.width = canvas.height = 1;
    URL.revokeObjectURL(source);
  }
}

function button(title, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = title;
  el.addEventListener('click',onClick);
  return el;
}

export function mountDriveMemories({getIdToken, getState, getPark}) {
  if (!MEMORIES_ENDPOINT) return;
  const request = makeAlbumClient(MEMORIES_ENDPOINT, getIdToken);
  const panel = document.getElementById('driveMemories');
  const dialog = panel.closest('dialog');
  const albumButtons = document.querySelectorAll('[data-open-album]');
  const el = suffix => document.getElementById('memory' + suffix);
  const preview = el('Preview');
  const life = new AbortController();
  const listen = (target,type,fn) => target.addEventListener(type,fn,{signal:life.signal});
  let active = null, albums = [], hiddenAlbums = [], uploadDraft, albumDraft, refreshTimer;
  let kind = 'private', pickedKind = false, pickerSignature, peopleSignature;
  const lastAlbum = {private:'',shared:''};
  const currentAlbum = () => albums.find(a => a.id === el('Album').value && a.kind === kind);
  let backgroundRequest, visiblePhoto, renderedGallery, displayedRoster, canArchive = false;
  function clearPreview() {
    visiblePhoto = null;
    el('Image').removeAttribute('src');
    el('Image').alt = '';
    el('Caption').textContent = '';
    preview.hidden = true;
    if (preview.parentElement !== el('Edit')) el('Edit').append(preview);
  }
  function clearAlbum() {
    clearPreview();
    renderedGallery = null;
    el('Photos').replaceChildren();
    clearRoster();
    el('Visit').replaceChildren();
    el('File').value = el('Email').value = el('InviteAlias').value = el('Alias').value = '';
    peopleSignature = null;
    el('Participants').replaceChildren();
    el('People').hidden = el('HideAlbum').hidden = el('DeleteAlbum').hidden = true;
    el('Visibility').value = 'private';
    el('Members').hidden = el('Edit').hidden = true;
    uploadDraft = null;
  }
  function clearPicker() {
    albums = [];
    hiddenAlbums = [];
    pickerSignature = null;
    canArchive = false;
    el('Create').hidden = el('Hidden').hidden = true;
    el('Album').replaceChildren();
    el('HiddenAlbums').replaceChildren();
    el('PersonalCount').textContent = el('GroupCount').textContent = '';
  }
  function reset() {
    clearTimeout(refreshTimer);
    active?.abort();
    active = null;
    clearAlbum();
    clearPicker();
    el('Title').value = el('Status').textContent = '';
    el('Controls').disabled = false;
    albumDraft = null;
  }
  function visitOptions() {
    const choices = photoVisits(getState(),getPark());
    const field = el('Visit'), selected = field.value;
    if (field.length === choices.length && choices.every((c,i) => field.options[i].value === c.visitKey && field.options[i].text === c.label)) return choices;
    field.replaceChildren(...choices.map(c => new Option(c.label, c.visitKey)));
    if (choices.some(c => c.visitKey === selected)) field.value = selected;
    return choices;
  }
  function showing() {
    return panel.open && (!dialog || dialog.open) && !panel.closest('[hidden]') && !document.hidden && !life.signal.aborted;
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (showing() && navigator.onLine) refreshTimer = setTimeout(() => refresh(true),60000);
  }
  async function run(work, initial = '読み込み中…', background = false) {
    if (!showing()) return;
    if (active) {
      if (background || active !== backgroundRequest) return;
      active.abort();
    }
    clearTimeout(refreshTimer);
    const controller = new AbortController(), {signal} = controller;
    active = controller;
    const previousGallery = renderedGallery;
    const timeout = setTimeout(() => {
      if (active !== controller) return;
      controller.abort();
      clearPreview();
      el('Status').textContent = errorText.offline;
    },background ? 25000 : 90000);
    if (background) backgroundRequest = controller;
    else {
      el('Controls').disabled = true;
      el('Status').textContent = initial;
    }
    try {
      const message = await work(signal);
      assertActive(signal);
      if (!background || previousGallery !== renderedGallery || Object.values(errorText).includes(el('Status').textContent))
        el('Status').textContent = message || '';
    } catch (error) {
      if (signal.aborted) return;
      clearPreview();
      if (['auth','forbidden','not-found','version'].includes(error.code)) {
        clearAlbum();
        clearPicker();
      }
      el('Status').textContent = errorText[error.code] || errorText.offline;
    } finally {
      clearTimeout(timeout);
      if (active === controller) {
        el('Controls').disabled = false;
        active = null;
        backgroundRequest = null;
        scheduleRefresh();
      }
    }
  }
  function confirmShare(albumId,label) {
    const album = albums.find(a => a.id === albumId);
    return album && window.confirm('「' + label + '」を「' + album.title + '」のメンバーに共有しますか？');
  }
  function photoRow(album,photo,title) {
    const albumId = album.id;
    const li = document.createElement('li');
    li.append(button(title + ' を見る', () => run(async s => {
      clearPreview();
      const {jpeg} = await request('image',{albumId,photoId:photo.id},s);
      assertActive(s);
      if (typeof jpeg !== 'string' || jpeg.length > Math.ceil(MAX_BYTES / 3) * 4 || !jpeg.startsWith('/9j/')) throw failure('file');
      visiblePhoto = {albumId,id:photo.id};
      el('Image').src = 'data:image/jpeg;base64,' + jpeg;
      el('Image').alt = title;
      el('Caption').textContent = title;
      li.append(preview);
      preview.hidden = false;
      requestAnimationFrame(() => { if (!preview.hidden) el('CloseImage').focus(); });
    })));
    if (album.kind === 'shared' && photo.canSetVisibility) {
      const label = document.createElement('label');
      label.textContent = 'この写真の公開範囲';
      const select = document.createElement('select');
      select.append(...Array.from(el('Visibility').options, option => new Option(option.text, option.value)));
      select.value = photo.visibility;
      select.id = 'memoryAudience-' + photo.id;
      select.setAttribute('aria-label', 'この写真の公開範囲（' + title + '）');
      select.addEventListener('change', () => {
        const visibility = select.value;
        select.value = photo.visibility;
        if (visibility === photo.visibility || (visibility === 'album' && !confirmShare(albumId,title))) return;
        const focused = document.activeElement === select;
        void run(async s => {
          // A lost response may mean the audience changed on the server. Recheck before showing it.
          renderedGallery = null;
          const unknown = new Option('更新して確認', '', false, true);
          select.add(unknown);
          select.disabled = true;
          await request('setVisibility',{albumId,photoId:photo.id,visibility},s);
          photo.visibility = select.value = visibility;
          unknown.remove();
          select.disabled = false;
          await listPhotos(albumId,s);
          return visibility === 'private' ? 'この写真を自分だけに戻しました。' : 'この写真をアルバムのメンバーに共有しました。';
        }).then(() => {
          if (focused && document.activeElement === document.body) document.getElementById(select.id)?.focus({preventScroll:true});
        });
      });
      label.append(select);
      li.append(label);
    } else {
      const status = document.createElement('span');
      status.textContent = album.kind === 'private' ? '自分だけ' : 'メンバーに共有中';
      li.append(status);
    }
    if (canArchive && photo.canDelete === true) li.append(button('写真を削除', () => {
      if (!window.confirm('「' + title + '」の写真をアプリから削除しますか？ 保存済みの画像ファイルは残ります。')) return;
      void run(async s => {
        await request('archivePhoto',{albumId,photoId:photo.id},s);
        if (visiblePhoto?.id === photo.id) clearPreview();
        await listPhotos(albumId,s);
        return '写真をアプリから削除しました。';
      });
    }));
    if (visiblePhoto?.id === photo.id && visiblePhoto.albumId === albumId) {
      el('Image').alt = el('Caption').textContent = title;
      li.append(preview);
    }
    return li;
  }
  async function listPhotos(albumId, signal) {
    const result = await request('list',{albumId},signal);
    assertActive(signal);
    const album = currentAlbum();
    if (album?.id !== albumId) return '';
    const photos = result.photos.filter(p => canViewPhoto(p) && (album.kind === 'shared' || p.visibility === 'private'));
    if (visiblePhoto && (visiblePhoto.albumId !== albumId || !photos.some(p => p.id === visiblePhoto.id))) clearPreview();
    // Leave the open photo, focused button and file picker alone when the album has not changed.
    const gallery = JSON.stringify([albumId,canArchive,photos.map(p => [p.id,p.label,p.canDelete,p.visibility,p.canSetVisibility])]);
    if (renderedGallery !== gallery) {
      const counts = new Map(), seen = new Map();
      for (const photo of photos) counts.set(photo.label, (counts.get(photo.label) || 0) + 1);
      const rows = photos.map(photo => {
        const index = (seen.get(photo.label) || 0) + 1;
        seen.set(photo.label,index);
        const title = counts.get(photo.label) > 1 ? photo.label + '（写真' + index + '）' : photo.label;
        return photoRow(album,photo,title);
      });
      el('Photos').replaceChildren(...rows);
      renderedGallery = gallery;
    }
    el('Edit').hidden = false;
    const shared = album.kind === 'shared';
    el('VisibilityField').hidden = !shared;
    el('People').hidden = !shared;
    if (shared) showPeople(album, result.participants);
    el('Members').hidden = !(shared && album.owner);
    if (shared && album.owner) showRoster(album, result.invitations);
    el('DeleteAlbum').hidden = !canArchive || shared || !album.owner;
    el('HideAlbum').hidden = !canArchive || !shared;
    visitOptions();
    return photos.length ? photos.length + '枚の写真' : '写真はまだありません。';
  }
  function albumOptions(entries) {
    const titles = new Set(), duplicates = new Set();
    for (const a of entries) {
      if (titles.has(a.title)) duplicates.add(a.title);
      titles.add(a.title);
    }
    const groups = new Map();
    for (const album of entries) {
      const label = album.owner ? '自分が作成' : '招待されたアルバム';
      if (!groups.has(label)) {
        const group = document.createElement('optgroup');
        group.label = label;
        groups.set(label,group);
      }
      const title = duplicates.has(album.title) ? album.title + '（' + album.id.slice(-6) + '）' : album.title;
      groups.get(label).append(new Option(title,album.id));
    }
    return groups.values();
  }
  function renderPicker() {
    const signature = JSON.stringify([kind,albums,hiddenAlbums]);
    if (signature === pickerSignature) return;
    pickerSignature = signature;
    const entries = albums.filter(a => a.kind === kind);
    el('PersonalCount').textContent = String(albums.filter(a => a.kind === 'private').length);
    el('GroupCount').textContent = String(albums.filter(a => a.kind === 'shared').length);
    const personal = kind === 'private';
    const tab = personal ? el('PersonalTab') : el('GroupTab');
    for (const item of [el('PersonalTab'),el('GroupTab')]) {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    el('TabPanel').setAttribute('aria-labelledby',tab.id);
    el('CreateButton').textContent = personal ? '自分だけのアルバムを作る' : '共有アルバムを作る';
    el('Album').replaceChildren(...albumOptions(entries));
    if (!entries.length) el('Album').add(new Option('アルバムはまだありません',''));
    el('Album').disabled = !entries.length;
    const oldHidden = el('HiddenAlbums').value;
    el('HiddenAlbums').replaceChildren(...albumOptions(hiddenAlbums));
    if (hiddenAlbums.some(a => a.id === oldHidden)) el('HiddenAlbums').value = oldHidden;
    el('Hidden').hidden = personal || !hiddenAlbums.length;
  }
  async function selectAlbum(signal, preferred, previous) {
    renderPicker();
    const chooser = el('Album');
    if (albums.some(a => a.kind === kind && a.id === preferred)) chooser.value = preferred;
    const id = chooser.value;
    if (!id || id !== previous) clearAlbum();
    lastAlbum[kind] = id;
    if (!id) return 'この種類のアルバムはまだありません。';
    return await listPhotos(id,signal);
  }
  async function readAlbums(signal, preferred) {
    const result = await request('albums',{},signal);
    assertActive(signal);
    const valid = a => a && UUID.test(a.id) && typeof a.title === 'string' && typeof a.owner === 'boolean' &&
      (a.kind === 'shared' || (a.kind === 'private' && a.owner));
    if (!Array.isArray(result.albums) || !Array.isArray(result.hiddenAlbums) ||
        !result.albums.every(valid) || !result.hiddenAlbums.every(a => valid(a) && a.kind === 'shared')) throw failure('version');
    const previous = el('Album').value;
    canArchive = result.archiveVersion === 1;
    albums = result.albums;
    hiddenAlbums = result.hiddenAlbums;
    if (!pickedKind && (albums.length || hiddenAlbums.length)) {
      kind = albums.some(a => a.kind === 'private') ? 'private' : 'shared';
      pickedKind = true;
    }
    el('Create').hidden = false;
    return await selectAlbum(signal, preferred || lastAlbum[kind], previous);
  }
  function chooseKind(next) {
    if (el('Create').hidden) return;
    pickedKind = true;
    if (next === kind) return;
    kind = next;
    pickerSignature = null;
    albumDraft = null;
    el('Title').value = '';
    clearAlbum();
    void run(s => selectAlbum(s,lastAlbum[kind],''));
  }
  for (const [id,next] of [['PersonalTab','private'],['GroupTab','shared']]) {
    const tab = el(id);
    listen(tab,'click',() => chooseKind(next));
    listen(tab,'keydown',event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const personal = event.key === 'Home' || (event.key !== 'End' && kind === 'shared');
      (personal ? el('PersonalTab') : el('GroupTab')).focus();
      chooseKind(personal ? 'private' : 'shared');
    });
  }
  function refresh(background = false) {
    if (!navigator.onLine) { reset(); el('Status').textContent = errorText.offline; return; }
    const selected = el('Album').value;
    return run(s => readAlbums(s,selected),undefined,background);
  }
  listen(el('Refresh'),'click',() => refresh());
  listen(el('Album'),'change',() => {
    clearAlbum();
    const album = currentAlbum();
    if (album) {
      lastAlbum[kind] = album.id;
      void run(s => listPhotos(album.id,s));
    }
  });
  listen(el('CloseImage'),'click',() => {
    const openButton = preview.closest('li')?.querySelector('button');
    clearPreview();
    openButton?.focus();
  });
  function dismissAlbum(expectedKind) {
    const album = currentAlbum();
    if (!canArchive || album?.kind !== expectedKind) return;
    const shared = album.kind === 'shared';
    const title = el('Album').selectedOptions[0].text;
    const question = shared ? '「' + title + '」を自分の一覧から外しますか？ 他のメンバーは引き続き使えます。' :
      '「' + title + '」と中の写真をアプリから削除しますか？ 保存済みの画像ファイルは残ります。';
    if (!window.confirm(question)) return;
    void run(async s => {
      clearAlbum();
      await request('dismissAlbum',{albumId:album.id},s);
      await readAlbums(s);
      return shared ? '自分の一覧から外しました。' : 'アルバムをアプリから削除しました。';
    });
  }
  listen(el('DeleteAlbum'),'click',() => dismissAlbum('private'));
  listen(el('HideAlbum'),'click',() => dismissAlbum('shared'));
  listen(el('RestoreAlbum'),'click',() => {
    const albumId = el('HiddenAlbums').value;
    if (kind !== 'shared' || !hiddenAlbums.some(a => a.id === albumId)) return;
    void run(async s => {
      await request('restoreAlbum',{albumId},s);
      await readAlbums(s,albumId);
      return '自分の一覧に戻しました。';
    });
  });
  listen(el('CreateButton'),'click',() => {
    const title = el('Title').value.trim();
    if (!title) { el('Title').focus(); return; }
    if (el('Create').hidden) return;
    pickedKind = true;
    if (albumDraft?.title !== title || albumDraft.kind !== kind) albumDraft = {albumId:crypto.randomUUID(),title,kind};
    void run(async s => {
      const draft = albumDraft;
      await request('create',draft,s);
      await readAlbums(s,draft.albumId);
      el('Title').value = '';
      albumDraft = null;
      return 'アルバムを作りました。';
    });
  });
  function showPeople(album, participants) {
    const people = Array.isArray(participants) ? participants.filter(p => p && typeof p.label === 'string' &&
      ['creator','member'].includes(p.role) && typeof p.self === 'boolean') : [];
    const signature = JSON.stringify([album.id,people]);
    if (signature === peopleSignature) return;
    peopleSignature = signature;
    const rows = people.map(p => {
      const li = document.createElement('li');
      li.append(document.createTextNode(p.label));
      const tags = [p.role === 'creator' && p.label !== '作成者' && '作成者',p.self && '自分'].filter(Boolean);
      if (tags.length) {
        const role = document.createElement('small');
        role.textContent = tags.join('・');
        li.append(role);
      }
      return li;
    });
    el('Participants').replaceChildren(...rows);
  }
  listen(el('SetAlias'),'click',() => {
    const album = currentAlbum(), alias = el('Alias').value.trim();
    if (album?.kind !== 'shared' || !el('Alias').reportValidity()) return;
    void run(async s => {
      await request('setAlbumAlias',{albumId:album.id,alias},s);
      await listPhotos(album.id,s);
      el('Alias').value = '';
      return alias ? 'このアルバムでの呼び名を保存しました。' : 'このアルバムでの呼び名を元に戻しました。';
    });
  });
  function clearRoster() {
    displayedRoster = null;
    el('Roster').replaceChildren();
    el('RosterHeading').textContent = el('RosterNote').textContent = '';
  }
  function showRoster(album, roster) {
    const signature = JSON.stringify([album.id, album.title, roster]);
    if (signature === displayedRoster) return;
    clearRoster();
    displayedRoster = signature;
    el('RosterHeading').textContent = '「' + album.title + '」の招待先';
    const known = Array.isArray(roster?.addresses) && Number.isInteger(roster.unidentified);
    el('Revoke').hidden = known && !roster.unidentified;
    if (!known) {
      el('RosterNote').textContent = '招待先の一覧を取得できませんでした。';
      return;
    }
    for (const address of roster.addresses) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = address;
      const remove = button('招待を取り消す', () => changeMember(album,address,true));
      remove.setAttribute('aria-label', address + ' の招待を取り消す');
      li.append(name,remove);
      el('Roster').append(li);
    }
    if (roster.unidentified) {
      el('RosterNote').textContent = '以前の招待が' + roster.unidentified + '件あります。相手がアルバムを開くか、同じアドレスをもう一度招待すると表示されます。';
    } else if (!roster.addresses.length) {
      el('RosterNote').textContent = 'まだ誰も招待していません。';
    }
  }
  function changeMember(album, email, remove) {
    if (!album?.owner || album.kind !== 'shared' || album.id !== currentAlbum()?.id) return;
    const title = el('Album').selectedOptions[0].text;
    if (remove && !window.confirm('「' + title + '」の ' + email + ' への招待を取り消しますか？')) return;
    if (!remove && !el('InviteAlias').reportValidity()) return;
    const alias = remove ? '' : el('InviteAlias').value.trim();
    void run(async s => {
      await request('member',{albumId:album.id,email,remove,...(alias ? {alias} : {})},s);
      assertActive(s);
      if (el('Email').value.trim() === email) el('Email').value = el('InviteAlias').value = '';
      await listPhotos(album.id,s);
      return remove ? '招待を取り消しました。' : '「' + album.title + '」に招待しました。友達にTDRouteのリンクを知らせてください。';
    });
  }
  for (const [id,remove] of [['Invite',false],['Revoke',true]]) {
    listen(el(id),'click',() => {
      const field = el('Email'), email = field.value.trim();
      if (!email || !field.reportValidity()) { field.focus(); return; }
      changeMember(currentAlbum(),email,remove);
    });
  }
  listen(el('Visit'),'focus',visitOptions);
  listen(el('File'),'change',() => {
    uploadDraft = null;
    el('Visibility').value = 'private';
  });
  listen(el('Upload'),'click',() => {
    const file = el('File').files[0], albumId = el('Album').value, key = el('Visit').value;
    const visit = visitOptions().find(v => v.visitKey === key);
    if (!visit || !file) { el('Status').textContent = 'しおりの体験と写真を選んでください。'; return; }
    const album = currentAlbum();
    if (!album) return;
    const visibility = album.kind === 'private' ? 'private' : el('Visibility').value;
    if (visibility !== 'private' && (visibility !== 'album' || !confirmShare(albumId,visit.label))) return;
    if (!uploadDraft || uploadDraft.visitKey !== key || uploadDraft.file !== file || uploadDraft.albumId !== albumId)
      uploadDraft = {file,albumId,visitKey:key,id:crypto.randomUUID()};
    const photoId = uploadDraft.id;
    void run(async s => {
      const jpeg = await photoJpeg(file,s);
      await request('upload',{albumId,photoId,...visit,visibility,jpeg},s);
      assertActive(s);
      el('File').value = '';
      el('Visibility').value = 'private';
      uploadDraft = null;
      await listPhotos(albumId,s);
      return '写真を追加しました。';
    },'写真を小さくして追加しています…');
  });
  listen(panel,'toggle',() => { if (showing()) void refresh(); else reset(); });
  listen(document,'visibilitychange',() => {
    if (showing()) { void refresh(); return; }
    // A phone's photo picker may background the page. Keep the local draft, then recheck access.
    clearTimeout(refreshTimer);
    active?.abort();
    active = null;
    clearPreview();
    el('Photos').replaceChildren();
    clearRoster();
    peopleSignature = null;
    el('Participants').replaceChildren();
    el('People').hidden = true;
    renderedGallery = null;
    el('Edit').hidden = el('Members').hidden = true;
    el('Controls').disabled = true;
  });
  listen(window,'online',() => { if (showing()) void refresh(); });
  listen(window,'offline',() => { reset(); if (showing()) el('Status').textContent = errorText.offline; });
  listen(window,'pagehide',reset);
  const workflow = document.getElementById('workflowSchedule');
  const observer = new MutationObserver(() => { if (showing()) void refresh(); else reset(); });
  if (!dialog && workflow) observer.observe(workflow,{attributes:true,attributeFilter:['hidden']});
  el('Create').hidden = true;
  panel.hidden = false;
  for (const opener of albumButtons) opener.hidden = false;
  return () => {
    life.abort();
    observer.disconnect();
    reset();
    el('Create').hidden = true;
    panel.hidden = true;
    panel.open = false;
    for (const opener of albumButtons) opener.hidden = true;
    if (dialog?.open) dialog.close();
  };
}
