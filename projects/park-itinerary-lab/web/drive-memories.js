import {baseVisitId, isRepeatVisit} from './repeat-visits.js?v=2.3.0';

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
  version:'公開範囲を確認できないため、アルバムを開けません。',
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
    if (action === 'albums' && body.visibilityVersion !== 1) throw failure('version');
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

export function mountDriveMemories({getIdToken, isOwner, getState, getPark}) {
  if (!MEMORIES_ENDPOINT) return;
  const request = makeAlbumClient(MEMORIES_ENDPOINT, getIdToken);
  const panel = document.getElementById('driveMemories');
  const el = suffix => document.getElementById('memory' + suffix);
  const life = new AbortController();
  const listen = (target,type,fn) => target.addEventListener(type,fn,{signal:life.signal});
  let active = null, albums = [], uploadDraft, albumDraft, refreshTimer;
  let backgroundRequest, visiblePhoto, renderedGallery;
  function clearPreview() {
    visiblePhoto = null;
    el('Image').removeAttribute('src');
    el('Image').alt = '';
    el('Caption').textContent = '';
    el('Preview').hidden = true;
  }
  function clearAlbum() {
    clearPreview();
    renderedGallery = null;
    el('Photos').replaceChildren();
    el('Visit').replaceChildren();
    el('File').value = el('Email').value = '';
    el('Visibility').value = 'private';
    el('Members').hidden = el('Edit').hidden = true;
    uploadDraft = null;
  }
  function reset() {
    clearTimeout(refreshTimer);
    active?.abort();
    active = null;
    clearAlbum();
    albums = [];
    el('Album').replaceChildren();
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
  function showing() { return panel.open && !panel.closest('[hidden]') && !document.hidden && !life.signal.aborted; }
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
        albums = [];
        el('Album').replaceChildren();
        if (error.code === 'version') el('Create').hidden = true;
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
  function photoRow(albumId,photo) {
    const li = document.createElement('li');
    li.append(button(photo.label + ' を見る', () => run(async s => {
      clearPreview();
      const {jpeg} = await request('image',{albumId,photoId:photo.id},s);
      assertActive(s);
      if (typeof jpeg !== 'string' || jpeg.length > Math.ceil(MAX_BYTES / 3) * 4 || !jpeg.startsWith('/9j/')) throw failure('file');
      visiblePhoto = {albumId,id:photo.id};
      el('Image').src = 'data:image/jpeg;base64,' + jpeg;
      el('Image').alt = photo.label;
      el('Caption').textContent = photo.label;
      el('Preview').hidden = false;
      requestAnimationFrame(() => { if (!el('Preview').hidden) el('CloseImage').focus(); });
    })));
    const shared = photo.visibility === 'album';
    const status = document.createElement('span');
    status.textContent = shared ? 'メンバーに共有中' : '自分だけ';
    li.append(status);
    if (photo.canSetVisibility) li.append(button(shared ? '自分だけに戻す' : 'メンバーに共有', () => {
      if (!shared && !confirmShare(albumId,photo.label)) return;
      void run(async s => {
        const visibility = shared ? 'private' : 'album';
        await request('setVisibility',{albumId,photoId:photo.id,visibility},s);
        await listPhotos(albumId,s);
        return shared ? '公開範囲を自分だけに戻しました。' : 'このアルバムのメンバーに共有しました。';
      });
    }));
    if (photo.canDelete === true) li.append(button('削除', () => {
      if (!window.confirm('「' + photo.label + '」の写真を削除しますか？')) return;
      void run(async s => {
        await request('delete',{albumId,photoId:photo.id},s);
        await listPhotos(albumId,s);
        return '写真を削除しました。';
      });
    }));
    return li;
  }
  async function listPhotos(albumId, signal) {
    const result = await request('list',{albumId},signal);
    assertActive(signal);
    const photos = result.photos.filter(canViewPhoto);
    if (visiblePhoto && (visiblePhoto.albumId !== albumId || !photos.some(p => p.id === visiblePhoto.id))) clearPreview();
    // Leave the open photo, focused button and file picker alone when the album has not changed.
    const gallery = JSON.stringify([albumId,photos.map(p => [p.id,p.label,p.canDelete,p.visibility,p.canSetVisibility])]);
    if (renderedGallery !== gallery) {
      el('Photos').replaceChildren(...photos.map(photo => photoRow(albumId,photo)));
      renderedGallery = gallery;
    }
    el('Edit').hidden = false;
    el('Members').hidden = !albums.some(a => a.id === albumId && a.owner);
    visitOptions();
    return photos.length ? photos.length + '枚の写真' : '写真はまだありません。';
  }
  async function readAlbums(signal, preferred) {
    const result = await request('albums',{},signal);
    assertActive(signal);
    el('Create').hidden = !isOwner;
    albums = result.albums.filter(a => UUID.test(a.id) && typeof a.title === 'string');
    const chooser = el('Album'), previouslyShown = chooser.value;
    if (chooser.length !== albums.length || albums.some((a,i) => a.id !== chooser.options[i].value || a.title !== chooser.options[i].text))
      chooser.replaceChildren(...albums.map(a => new Option(a.title,a.id)));
    if (chooser.value !== preferred && albums.some(a => a.id === preferred)) chooser.value = preferred;
    const id = chooser.value;
    if (!id) {clearAlbum(); return '開けるアルバムはまだありません。';}
    if (id !== previouslyShown) clearAlbum();
    return await listPhotos(id,signal);
  }
  function refresh(background = false) {
    if (!navigator.onLine) { reset(); el('Status').textContent = errorText.offline; return; }
    const selected = el('Album').value;
    return run(s => readAlbums(s,selected),undefined,background);
  }
  listen(el('Refresh'),'click',() => refresh());
  listen(el('Album'),'change',() => {
    clearAlbum();
    void run(s => listPhotos(el('Album').value,s));
  });
  listen(el('CloseImage'),'click',clearPreview);
  listen(el('DeleteAlbum'),'click',() => {
    const album = albums.find(a => a.id === el('Album').value && a.owner);
    if (!album || !window.confirm('「' + album.title + '」とアルバム内のすべての写真を削除しますか？')) return;
    void run(async s => {
      await request('deleteAlbum',{albumId:album.id},s);
      clearAlbum();
      await readAlbums(s);
      return 'アルバムを削除しました。';
    });
  });
  listen(el('CreateButton'),'click',() => {
    const title = el('Title').value.trim();
    if (!title) { el('Title').focus(); return; }
    if (albumDraft?.title !== title) albumDraft = {albumId:crypto.randomUUID(),title};
    void run(async s => {
      const draft = albumDraft;
      await request('create',draft,s);
      await readAlbums(s,draft.albumId);
      el('Title').value = '';
      albumDraft = null;
      return 'アルバムを作りました。';
    });
  });
  for (const [id,remove] of [['Invite',false],['Revoke',true]]) {
    listen(el(id),'click',() => {
      const field = el('Email'), email = field.value.trim(), albumId = el('Album').value;
      if (!email || !field.reportValidity()) { field.focus(); return; }
      if (remove && !window.confirm('このアカウントの招待を取り消しますか？')) return;
      void run(async s => {
        await request('member',{albumId,email,remove},s);
        assertActive(s);
        field.value = '';
        return remove ? '招待を取り消しました。' : '招待しました。同じアカウントでアルバムを開けます。';
      });
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
    const visibility = el('Visibility').value;
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
    renderedGallery = null;
    el('Edit').hidden = el('Members').hidden = true;
    el('Controls').disabled = true;
  });
  listen(window,'online',() => { if (showing()) void refresh(); });
  listen(window,'offline',() => { reset(); if (showing()) el('Status').textContent = errorText.offline; });
  listen(window,'pagehide',reset);
  const workflow = document.getElementById('workflowSchedule');
  const observer = new MutationObserver(() => { if (showing()) void refresh(); else reset(); });
  observer.observe(workflow,{attributes:true,attributeFilter:['hidden']});
  el('Create').hidden = true;
  panel.hidden = false;
  return () => {
    life.abort();
    observer.disconnect();
    reset();
    el('Create').hidden = true;
    panel.hidden = true;
    panel.open = false;
  };
}
