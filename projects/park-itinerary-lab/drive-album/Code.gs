// Google Apps Script web app. Only doPost is exposed. Drive IDs stay on the server.
const PROJECT_ = 'tdroute-399c1';
const FIREBASE_KEY_ = 'AIzaSyA4_oJPeS2kZ2LJJyKcx14R8IV7FMSIiy4'; // Public web app configuration.
const OWNER_HASH_ = '59a9ddcef0808ba4c057a9015e2cbd352cd8fd39cb53d8490d90644d1153efba';
const MAX_ALBUMS_ = 12, MAX_MEMBERS_ = 12, MAX_PHOTOS_ = 40, MAX_BYTES_ = 1000000;
const UUID_ = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FOLDER_TYPE_ = 'application/vnd.google-apps.folder';

function fail_(code) { throw Object.assign(new Error('Album request failed'), {albumError: code}); }

function doPost(e) {
  let answer;
  try {
    const body = e && e.postData && e.postData.contents;
    if (typeof body !== 'string' || body.length > 1370000) fail_('invalid');
    let request;
    try { request = JSON.parse(body); } catch (_) { fail_('invalid'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail_('invalid');
    const actor = authenticate_(request.idToken);
    answer = Object.assign({ok: true}, handle_(request, actor));
  } catch (err) {
    // Return only the public error code, never provider responses or personal data.
    answer = {ok: false, error: err && err.albumError || 'offline'};
  }
  return ContentService.createTextOutput(JSON.stringify(answer)).setMimeType(ContentService.MimeType.JSON);
}

function hex_(bytes) { return bytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }
function hash_(value) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)); }

function email_(value) {
  if (typeof value !== 'string') fail_('invalid');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) fail_('invalid');
  return email;
}

function authenticate_(token) {
  if (typeof token !== 'string' || token.length > 10000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) fail_('auth');
  let claims;
  try { claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString('UTF-8')); }
  catch (_) { fail_('auth'); }
  const now = Math.floor(Date.now() / 1000);
  if (!claims || claims.aud !== PROJECT_ || claims.iss !== 'https://securetoken.google.com/' + PROJECT_ ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 || !Number.isInteger(claims.exp) ||
      claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60 ||
      !Number.isInteger(claims.auth_time) || claims.auth_time > now + 60 || claims.email_verified !== true ||
      !claims.firebase || claims.firebase.sign_in_provider !== 'google.com' || claims.firebase.tenant) fail_('auth');
  // Google validates the original signed token. Locally decoded claims alone grant no access.
  const result = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_KEY_, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({idToken: token}), muteHttpExceptions: true
  });
  const status = result.getResponseCode();
  if (status !== 200) fail_(status >= 500 || status === 429 ? 'offline' : 'auth');
  const users = JSON.parse(result.getContentText()).users;
  const record = Array.isArray(users) && users.length === 1 && users[0];
  if (!record || record.disabled || record.localId !== claims.sub || !record.emailVerified || !claims.email ||
      !record.email || email_(record.email) !== email_(claims.email) || Number(record.validSince || 0) > claims.auth_time ||
      !(record.providerUserInfo || []).some(p => p.providerId === 'google.com')) fail_('auth');
  const uid = hash_(claims.sub);
  const address = email_(record.email);
  return {uid, email: hash_(address), address, owner: uid === OWNER_HASH_};
}

function uuid_(value) {
  if (typeof value !== 'string' || !UUID_.test(value)) fail_('invalid');
  return value;
}
function title_(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) fail_('invalid');
  return value.trim();
}
function prop_(store, key) {
  const value = store.getProperty(key);
  return value ? JSON.parse(value) : null;
}
function put_(store, key, value) { store.setProperty(key, JSON.stringify(value)); }
function albumKey_(id) { return 'album:' + id; }
function inviteKey_(album, member) { return 'invite-address:' + album + ':' + member; }
function photoKey_(album, id) { return 'photo:' + album + ':' + id; }
function allowed_(album, actor) { return !!album && (actor.owner || (!album.deleting && album.members.includes(actor.email))); }
function participant_(store, albumId, actor) {
  const album = prop_(store, albumKey_(albumId));
  if (!allowed_(album, actor)) fail_('forbidden');
  return album;
}
function requestedVisibility_(value) {
  if (value !== 'private' && value !== 'album') fail_('invalid');
  return value;
}
function visibility_(photo) { return photo.visibility === 'album' ? 'album' : 'private'; }
function canViewPhoto_(photo, actor) {
  return !!photo && (photo.author === actor.uid || visibility_(photo) === 'album');
}
function readablePhoto_(store, key, actor) {
  const photo = prop_(store, key);
  if (!canViewPhoto_(photo, actor) || photo.state !== 'ready') fail_('not-found');
  return photo;
}
function locked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) fail_('busy');
  try { return fn(); } finally { lock.releaseLock(); }
}

function handle_(request, actor) {
  const store = PropertiesService.getScriptProperties();
  // New clients use separate action names so they cannot request a trash operation on an older server.
  if (request.action === 'archivePhoto') request.action = 'delete';
  if (request.action === 'archiveAlbum') request.action = 'deleteAlbum';
  if (request.action === 'albums') {
    const albums = [];
    const entries = store.getProperties();
    for (const key of Object.keys(entries).filter(k => k.startsWith('album:'))) {
      const album = JSON.parse(entries[key]);
      if (allowed_(album, actor)) albums.push({id: key.slice(6), title: album.title, owner: actor.owner});
    }
    return {albums, visibilityVersion: 1, archiveVersion: 1};
  }
  const id = uuid_(request.albumId);
  if (['create', 'member', 'deleteAlbum'].includes(request.action)) {
    if (!actor.owner) fail_('forbidden');
    return locked_(() => manage_(store, id, request));
  }
  if (request.action === 'list') {
    const prefix = photoKey_(id, '');
    const props = store.getProperties();
    const album = props[albumKey_(id)] && JSON.parse(props[albumKey_(id)]);
    if (!allowed_(album, actor)) fail_('forbidden');
    if (album.deleting) return {photos: []};
    const photos = Object.keys(props).filter(k => k.startsWith(prefix)).map(k => ({id: k.slice(prefix.length), p: JSON.parse(props[k])}))
      .filter(row => row.p.state === 'ready' && canViewPhoto_(row.p, actor))
      .sort((a,b) => a.p.created - b.p.created || a.id.localeCompare(b.id))
      .map(({id: photoId, p}) => ({id: photoId, visitKey: p.visitKey, label: p.label, visibility: visibility_(p),
        canDelete: actor.owner || actor.uid === p.author, canSetVisibility: actor.uid === p.author}));
    // Pre-v2.5 invitations have only an address hash. Restore their display label
    // from the signed-in invitee once, without changing or regranting membership.
    if (!actor.owner && !props[inviteKey_(id, actor.email)]) {
      locked_(() => {
        if (participant_(store, id, actor).deleting) fail_('forbidden');
        store.setProperty(inviteKey_(id, actor.email), actor.address);
      });
    }
    if (!actor.owner) return {photos};
    const addresses = album.members.map(member => props[inviteKey_(id, member)]).filter(Boolean).sort();
    return {photos, invitations:{addresses, unidentified:album.members.length - addresses.length}};
  }
  if (participant_(store, id, actor).deleting) fail_('conflict');
  const photoId = uuid_(request.photoId);
  const key = photoKey_(id, photoId);
  if (request.action === 'image') {
    const p = readablePhoto_(store, key, actor);
    const image = photoBytes_(p.file);
    if (participant_(store, id, actor).deleting) fail_('not-found');
    if (readablePhoto_(store, key, actor).file !== p.file) fail_('not-found');
    return {jpeg: Utilities.base64Encode(image)};
  }
  if (request.action === 'setVisibility') {
    const visibility = requestedVisibility_(request.visibility);
    return locked_(() => {
      if (participant_(store, id, actor).deleting) fail_('conflict');
      const photo = readablePhoto_(store, key, actor);
      if (photo.author !== actor.uid) fail_('forbidden');
      if (visibility !== visibility_(photo)) put_(store, key, Object.assign({}, photo, {visibility}));
      return {};
    });
  }
  if (request.action === 'delete') {
    return locked_(() => {
      if (participant_(store, id, actor).deleting) fail_('conflict');
      const photo = prop_(store, key);
      // An invisible photo and an absent photo have the same delete response.
      if (!canViewPhoto_(photo, actor)) return {};
      if (!actor.owner && actor.uid !== photo.author) fail_('forbidden');
      if (photo.state !== 'deleting') put_(store, key, Object.assign({}, photo, {state:'deleting'}));
      // Keep a bounded record of completed deletes so a delayed retry won't recreate a photo.
      const album = participant_(store, id, actor);
      album.recentDeletes = [photoId, ...album.recentDeletes.filter(item => item !== photoId)].slice(0, 80);
      put_(store, albumKey_(id), album);
      store.deleteProperty(key);
      return {};
    });
  }
  if (request.action !== 'upload') fail_('invalid');
  const visibility = request.visibility === undefined ? 'private' : requestedVisibility_(request.visibility);
  const label = title_(request.label, 100), visitKey = request.visitKey;
  if (typeof visitKey !== 'string' || !/^[\w.:-]{1,128}$/.test(visitKey)) fail_('invalid');
  const input = request.jpeg;
  if (typeof input !== 'string' || !input || input.length > 4 * Math.ceil(MAX_BYTES_ / 3) ||
      input.length % 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(input)) fail_('invalid');
  let bytes;
  try { bytes = Utilities.base64Decode(input); } catch (_) { fail_('invalid'); }
  if (bytes.length > MAX_BYTES_) fail_('invalid');
  bytes = sanitizeJpeg_(bytes);
  const checksum = hash_(bytes);
  return locked_(() => {
    const album = participant_(store, id, actor);
    if (album.deleting || album.recentDeletes.includes(photoId)) fail_('conflict');
    let p = prop_(store, key);
    if (p) {
      if (actor.uid !== p.author || checksum !== p.checksum || p.label !== label || p.visitKey !== visitKey || p.state === 'deleting') fail_('conflict');
      // An upload retry must not change or misreport the audience chosen since the first upload.
      if (visibility !== visibility_(p)) fail_('conflict');
      if (p.state === 'ready') return {};
    } else if (store.getKeys().filter(k => k.startsWith(photoKey_(id, ''))).length >= MAX_PHOTOS_) fail_('limit');
    // A saving record from the flat layout may already have written its JPEG there.
    const date = !p || p.folder ? visitDate_(visitKey) : null;
    const root = privateFolder_(store);
    const folder = date ? photoFolder_(store, root, date, actor.uid, id, album.title) : root;
    if (p?.folder && p.folder !== folder) fail_('conflict');
    if (!p) {
      p = {file: newFileId_(), folder, author: actor.uid, visibility, visitKey, label, checksum, created: Date.now(), state: 'saving'};
      put_(store, key, p);
    }
    savePhoto_(p.file, photoId, bytes, folder);
    p.state = 'ready';
    put_(store, key, p);
    return {};
  });
}

function manage_(store, id, request) {
  const key = albumKey_(id);
  const album = prop_(store, key);
  if (request.action === 'deleteAlbum') {
    if (!album) return {};
    if (!album.deleting) put_(store, key, Object.assign({}, album, {deleting: true}));
    // Revoke app access first. Retain all original Drive files and folders, including legacy ones.
    const photos = photoKey_(id, ''), invitations = inviteKey_(id, '');
    for (const k of store.getKeys().filter(k => k.startsWith(photos) || k.startsWith(invitations))) store.deleteProperty(k);
    const deleted = prop_(store, 'deleted-albums') || [];
    put_(store, 'deleted-albums', [id, ...deleted.filter(item => item !== id)].slice(0, 80));
    store.deleteProperty(key);
    return {};
  }
  if (album?.deleting) fail_('conflict');
  if (request.action === 'create') {
    if ((prop_(store, 'deleted-albums') || []).includes(id)) fail_('conflict');
    const title = title_(request.title, 80);
    if (album) {
      if (album.title !== title) fail_('conflict');
      return {};
    }
    if (store.getKeys().filter(k => k.startsWith('album:')).length >= MAX_ALBUMS_) fail_('limit');
    put_(store, key, {title, members: [], recentDeletes: []});
    return {};
  }
  if (!album) fail_('not-found');
  const address = email_(request.email), member = hash_(address), label = inviteKey_(id, member);
  if (typeof request.remove !== 'boolean') fail_('invalid');
  if (request.remove) {
    album.members = album.members.filter(hash => hash !== member);
    put_(store, key, album);
    store.deleteProperty(label);
  } else {
    if (!album.members.includes(member)) {
      if (album.members.length >= MAX_MEMBERS_) fail_('limit');
      album.members.push(member);
    }
    store.setProperty(label, address);
    put_(store, key, album);
  }
  return {};
}

// All file IDs here are allocated by Drive, retained in Script Properties and never accepted from callers.
function newFileId_() { return Drive.Files.generateIds({count: 1, space:'drive'}).ids[0]; }
function resource_(id) {
  const result = driveFetch_(id + '?fields=id,mimeType,trashed,shared,parents,appProperties');
  if (result.getResponseCode() === 404) return null;
  checkDrive_(result);
  return JSON.parse(result.getContentText());
}
function driveFetch_(path, options) {
  return UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + path, Object.assign({
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()}, muteHttpExceptions: true
  }, options));
}
function checkDrive_(result) {
  if (result.getResponseCode() < 200 || result.getResponseCode() >= 300) fail_('offline');
}
function privateFolder_(store) {
  let id = store.getProperty('folder');
  if (!id) {
    id = newFileId_();
    store.setProperty('folder', id);
  }
  const found = resource_(id);
  if (found) {
    if (found.shared || found.trashed || found.mimeType !== FOLDER_TYPE_ || found.appProperties?.app !== 'TDRoute-memories') fail_('offline');
  } else {
    Drive.Files.create({id, name:'TDRoute 夢の思い出', mimeType:FOLDER_TYPE_, appProperties:{app:'TDRoute-memories'}});
  }
  return id;
}

function visitDate_(visitKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2}):/.exec(visitKey);
  if (!match || match[1] === '0000') fail_('invalid');
  const iso = match[0].slice(0, 10), day = new Date(iso + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== iso) fail_('invalid');
  return match.slice(1);
}

function childFolders_(parent) {
  const folders = [];
  const options = {q:"'" + parent + "' in parents and mimeType = '" + FOLDER_TYPE_ + "' and trashed = false",
    spaces:'drive', fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,trashed,shared,parents,appProperties)', pageSize:100};
  do {
    const page = Drive.Files.list(options);
    if (page.incompleteSearch) fail_('offline');
    folders.push(...(page.files || []));
    options.pageToken = page.nextPageToken;
  } while (options.pageToken);
  return folders;
}

function checkChild_(folder, parent, key) {
  if (folder.shared || folder.trashed || folder.mimeType !== FOLDER_TYPE_ || !folder.parents?.includes(parent) ||
      folder.appProperties?.tdroutePath !== key) fail_('offline');
}

// Called under the upload lock. Drive metadata identifies the folder even if its display name changes.
function childFolder_(store, parent, key, name, isAlbum) {
  const path = hash_(parent + ':' + key);
  // Bound the hints independently of the number of dates, people and archived albums.
  const slot = 'folder-hint:' + (parseInt(path.slice(0, 2), 16) % 48);
  let hint = prop_(store, slot);
  if (hint?.path === path) {
    const found = resource_(hint.id);
    if (found) { checkChild_(found, parent, key); return found.id; }
  } else {
    const siblings = childFolders_(parent);
    const matches = siblings.filter(f => f.appProperties?.tdroutePath === key);
    if (matches.length > 1) fail_('conflict');
    if (matches.length) {
      const found = matches[0];
      checkChild_(found, parent, key);
      put_(store, slot, {path, id:found.id, name:found.name});
      return found.id;
    }
    if (siblings.some(f => f.name === name)) {
      if (!isAlbum) fail_('conflict');
      const stem = name + ' (' + key + ')';
      name = stem;
      for (let n = 2; siblings.some(f => f.name === name); n++) name = stem + ' ' + n;
    }
    hint = {path, id:newFileId_(), name};
    // Reserve the ID before create so a lost response can use the same folder.
    put_(store, slot, hint);
  }
  Drive.Files.create({id:hint.id, name:hint.name, mimeType:FOLDER_TYPE_, parents:[parent], appProperties:{tdroutePath:key}});
  return hint.id;
}

function photoFolder_(store, root, date, author, albumId, title) {
  let parent = root;
  for (const part of [...date, author]) parent = childFolder_(store, parent, part, part, false);
  const name = title.replace(/\//g, '／').replace(/\\/g, '＼').replace(/^\.{1,2}$/, dots => '．'.repeat(dots.length));
  return childFolder_(store, parent, albumId, name, true);
}
function savePhoto_(id, photoId, bytes, folder) {
  const existing = resource_(id);
  if (existing) {
    if (existing.shared || existing.trashed || existing.mimeType !== 'image/jpeg' || !existing.parents?.includes(folder) || existing.appProperties?.photo !== photoId) fail_('conflict');
    return;
  }
  const name = photoId + '.jpg';
  Drive.Files.create({id, name, mimeType:'image/jpeg', parents:[folder], appProperties:{photo:photoId}},
    Utilities.newBlob(bytes, 'image/jpeg', name), {fields:'id'});
}
function photoBytes_(id) {
  const result = driveFetch_(id + '?alt=media');
  checkDrive_(result);
  const bytes = result.getContent();
  if (!bytes.length || bytes.length > MAX_BYTES_) fail_('invalid');
  return bytes;
}
