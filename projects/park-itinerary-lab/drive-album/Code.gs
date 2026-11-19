// Google Apps Script web app. Only doPost is exposed. Drive IDs stay on the server.
const PROJECT_ = 'tdroute-399c1';
const FIREBASE_KEY_ = 'AIzaSyA4_oJPeS2kZ2LJJyKcx14R8IV7FMSIiy4'; // Public web app configuration.
const OWNER_HASH_ = '59a9ddcef0808ba4c057a9015e2cbd352cd8fd39cb53d8490d90644d1153efba';
const MAX_ALBUMS_ = 12, MAX_MEMBERS_ = 12, MAX_PHOTOS_ = 40, MAX_BYTES_ = 1000000;
const MAX_STORED_ALBUMS_ = 120, MAX_DAILY_UPLOADS_ = 40, MAX_DAILY_TOTAL_ = 300;
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
// Albums written before per-person ownership belonged to the original operator.
function creator_(album) { return album.creator || OWNER_HASH_; }
function kind_(album) { return album.kind || 'shared'; }
function memberKey_(album, actor) {
  if (!album) return null;
  if (actor.uid === creator_(album)) return 'creator';
  return kind_(album) === 'shared' && album.members.includes(actor.email) ? actor.email : null;
}
function allowed_(album, actor) {
  const member = memberKey_(album, actor);
  return member && !album.deleting && !(album.hidden || []).includes(member);
}
function alias_(value) {
  if (typeof value !== 'string' || /[@＠\x00-\x1f\x7f]/.test(value) || value.trim().length > 24) fail_('invalid');
  return value.trim();
}
function participants_(album, actor) {
  const self = memberKey_(album, actor);
  return ['creator', ...album.members].map((key,index) => ({
    role:index ? 'member' : 'creator', self:key === self, label:album.aliases?.[key] || (index ? 'メンバー' + index : '作成者')
  }));
}
function usageDay_() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10); }
function checkStorageRoom_(store, entries) {
  // Expired budgets must not prevent admission after yesterday's peak.
  const today = usageDay_();
  for (const key of Object.keys(entries).filter(k => k.startsWith('upload-day:'))) {
    if (JSON.parse(entries[key]).day !== today) {
      store.deleteProperty(key);
      delete entries[key];
    }
  }
  // Keep room within the 500 KiB Script Properties store for withdrawals and in-flight writes.
  if (encodeURIComponent(JSON.stringify(entries)).replace(/%[0-9A-F]{2}/g,'x').length > 450 * 1024) fail_('limit');
}
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
  if (request.action === 'archivePhoto') request.action = 'delete';
  // Cached clients use both old names. All three always act on the caller's own library.
  if (['archiveAlbum','deleteAlbum'].includes(request.action)) request.action = 'dismissAlbum';
  if (request.action === 'albums') {
    const albums = [], hiddenAlbums = [];
    const entries = store.getProperties();
    for (const key of Object.keys(entries).filter(k => k.startsWith('album:'))) {
      const album = JSON.parse(entries[key]), member = memberKey_(album, actor);
      if (!member || album.deleting) continue;
      const list = (album.hidden || []).includes(member) ? hiddenAlbums : albums;
      list.push({id:key.slice(6), title:album.title, kind:kind_(album), owner:member === 'creator'});
    }
    return {albums, hiddenAlbums, visibilityVersion:1, archiveVersion:1, albumVersion:2};
  }
  const id = uuid_(request.albumId);
  if (['create','member','dismissAlbum','restoreAlbum','setAlbumAlias'].includes(request.action))
    return locked_(() => manage_(store, id, request, actor));
  if (request.action === 'list') {
    const prefix = photoKey_(id, '');
    const props = store.getProperties();
    const album = props[albumKey_(id)] && JSON.parse(props[albumKey_(id)]);
    if (!allowed_(album, actor)) fail_('forbidden');
    const creator = actor.uid === creator_(album);
    const photos = Object.keys(props).filter(k => k.startsWith(prefix)).map(k => ({id: k.slice(prefix.length), p: JSON.parse(props[k])}))
      .filter(row => row.p.state === 'ready' && canViewPhoto_(row.p, actor))
      .sort((a,b) => a.p.created - b.p.created || a.id.localeCompare(b.id))
      .map(({id: photoId, p}) => ({id: photoId, visitKey: p.visitKey, label: p.label, visibility: visibility_(p),
        canDelete: creator || actor.uid === p.author, canSetVisibility: actor.uid === p.author}));
    // Pre-v2.5 invitations have only an address hash. Restore their display label
    // from the signed-in invitee once, without changing or regranting membership.
    if (!creator && !props[inviteKey_(id, actor.email)]) {
      locked_(() => {
        participant_(store, id, actor);
        store.setProperty(inviteKey_(id, actor.email), actor.address);
      });
    }
    if (kind_(album) === 'private') return {photos};
    const participants = participants_(album, actor);
    if (!creator) return {photos, participants};
    const addresses = album.members.map(member => props[inviteKey_(id, member)]).filter(Boolean).sort();
    return {photos, participants, invitations:{addresses, unidentified:album.members.length - addresses.length}};
  }
  participant_(store, id, actor);
  const photoId = uuid_(request.photoId);
  const key = photoKey_(id, photoId);
  if (request.action === 'image') {
    const p = readablePhoto_(store, key, actor);
    const image = photoBytes_(p.file);
    participant_(store, id, actor);
    if (readablePhoto_(store, key, actor).file !== p.file) fail_('not-found');
    return {jpeg: Utilities.base64Encode(image)};
  }
  if (request.action === 'setVisibility') {
    const visibility = requestedVisibility_(request.visibility);
    return locked_(() => {
      const album = participant_(store, id, actor);
      if (kind_(album) === 'private' && visibility !== 'private') fail_('invalid');
      const photo = readablePhoto_(store, key, actor);
      if (photo.author !== actor.uid) fail_('forbidden');
      if (visibility !== visibility_(photo)) put_(store, key, Object.assign({}, photo, {visibility}));
      return {};
    });
  }
  if (request.action === 'delete') {
    return locked_(() => {
      const album = participant_(store, id, actor);
      const photo = prop_(store, key);
      // An invisible photo and an absent photo have the same delete response.
      if (!canViewPhoto_(photo, actor)) return {};
      if (actor.uid !== creator_(album) && actor.uid !== photo.author) fail_('forbidden');
      if (photo.state !== 'deleting') put_(store, key, Object.assign({}, photo, {state:'deleting'}));
      // Keep a bounded record of completed deletes so a delayed retry won't recreate a photo.
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
    if (kind_(album) === 'private' && visibility !== 'private') fail_('invalid');
    if (album.recentDeletes.includes(photoId)) fail_('conflict');
    let p = prop_(store, key);
    if (p) {
      if (actor.uid !== p.author || checksum !== p.checksum || p.label !== label || p.visitKey !== visitKey || p.state === 'deleting') fail_('conflict');
      // An upload retry must not change or misreport the audience chosen since the first upload.
      if (visibility !== visibility_(p)) fail_('conflict');
      if (p.state === 'ready') return {};
    } else if (store.getKeys().filter(k => k.startsWith(photoKey_(id, ''))).length >= MAX_PHOTOS_) fail_('limit');
    // A saving record from the flat layout may already have written its JPEG there.
    const date = !p || p.folder ? visitDate_(visitKey) : null;
    const entries = store.getProperties();
    if (!p) checkStorageRoom_(store,entries);
    const charge = uploadBudget_(entries, actor.uid, p?.file);
    const root = privateFolder_(store);
    const folder = date ? photoFolder_(store, root, date, actor.uid, id, album.title) : root;
    if (p?.folder && p.folder !== folder) fail_('conflict');
    if (!p) {
      p = {file:newFileId_(), folder, author: actor.uid, visibility, visitKey, label, checksum, created: Date.now(), state: 'saving'};
      put_(store, key, p);
    }
    // A saved reservation has a stable Drive ID. A lost response consumes only one daily slot.
    if (charge) {
      charge.value.files.push(p.file);
      put_(store, charge.key, charge.value);
    }
    savePhoto_(p.file, photoId, bytes, folder);
    p.state = 'ready';
    put_(store, key, p);
    return {};
  });
}

function uploadBudget_(entries, uid, file) {
  const today = usageDay_();
  const key = 'upload-day:' + uid;
  let files = [], total = 0;
  for (const name of Object.keys(entries).filter(k => k.startsWith('upload-day:'))) {
    const entry = JSON.parse(entries[name]);
    if (entry.day === today) {
      total += entry.files.length;
      if (name === key) files = entry.files;
    }
  }
  if (files.includes(file)) return null;
  if (files.length >= MAX_DAILY_UPLOADS_ || total >= MAX_DAILY_TOTAL_) fail_('limit');
  return {key, value:{day:today,files}};
}

function createAlbum_(store, id, request, actor, album) {
  // A cached pre-v2.6 creator screen was available only for the original operator.
  if (request.kind === undefined && !actor.owner) fail_('forbidden');
  const kind = request.kind === undefined ? 'shared' : request.kind;
  if (!['private','shared'].includes(kind)) fail_('invalid');
  const title = title_(request.title,80), alias = alias_(request.alias === undefined ? '' : request.alias);
  if (album) {
    if (creator_(album) !== actor.uid) fail_('forbidden');
    if (album.title !== title || kind_(album) !== kind || album.deleting) fail_('conflict');
    return {};
  }
  if ((prop_(store, 'deleted-albums') || []).some(marker => marker === id || marker.startsWith(id + ':'))) fail_('conflict');
  const entries = store.getProperties(), keys = Object.keys(entries).filter(k => k.startsWith('album:'));
  const owned = keys.map(k => JSON.parse(entries[k])).filter(a => creator_(a) === actor.uid);
  if (keys.length >= MAX_STORED_ALBUMS_ || owned.length >= MAX_ALBUMS_ * 2 ||
      owned.filter(a => !(a.hidden || []).includes('creator')).length >= MAX_ALBUMS_) fail_('limit');
  checkStorageRoom_(store,entries);
  const record = {creator:actor.uid, kind, title, members:[], recentDeletes:[]};
  if (alias && kind === 'shared') record.aliases = {creator:alias};
  put_(store, albumKey_(id), record);
  return {};
}

function deletePrivateAlbum_(store, id, album) {
  const key = albumKey_(id);
  if (!album.deleting) put_(store, key, Object.assign({}, album, {deleting:true}));
  const photos = photoKey_(id, ''), invitations = inviteKey_(id, '');
  for (const k of store.getKeys().filter(k => k.startsWith(photos) || k.startsWith(invitations))) store.deleteProperty(k);
  const deleted = prop_(store, 'deleted-albums') || [];
  const marker = id + ':' + creator_(album);
  put_(store, 'deleted-albums', [marker,...deleted.filter(item => item !== marker)].slice(0,80));
  store.deleteProperty(key);
}

function manage_(store, id, request, actor) {
  const key = albumKey_(id), album = prop_(store, key);
  if (request.action === 'create') return createAlbum_(store,id,request,actor,album);
  if (!album && request.action === 'dismissAlbum') {
    const deleted = prop_(store, 'deleted-albums') || [];
    if (deleted.includes(id + ':' + actor.uid) || (actor.owner && deleted.includes(id))) return {};
  }
  const self = memberKey_(album,actor);
  if (!self) fail_('forbidden');
  const kind = kind_(album);
  if (request.action === 'dismissAlbum' && self === 'creator' && (kind === 'private' || album.deleting)) {
    // A v2.5 global removal already marked 'deleting' can finish without resurrecting its data.
    deletePrivateAlbum_(store,id,album);
    return {};
  }
  if (album.deleting) fail_('forbidden');
  if (['restoreAlbum','dismissAlbum'].includes(request.action)) {
    if (kind !== 'shared') fail_('invalid');
    const hidden = (album.hidden || []).filter(member => member !== self);
    if (request.action === 'dismissAlbum') hidden.push(self);
    album.hidden = hidden;
    put_(store,key,album);
    return {};
  }
  if (!allowed_(album,actor) || kind !== 'shared') fail_('forbidden');
  if (request.action === 'setAlbumAlias') {
    const label = alias_(request.alias);
    album.aliases = album.aliases || {};
    if (label) album.aliases[self] = label;
    else delete album.aliases[self];
    put_(store,key,album);
    return {};
  }
  if (self !== 'creator') fail_('forbidden');
  const address = email_(request.email), member = hash_(address), label = inviteKey_(id, member);
  if (member === actor.email || typeof request.remove !== 'boolean') fail_('invalid');
  if (request.remove) {
    album.members = album.members.filter(hash => hash !== member);
    if (album.hidden) album.hidden = album.hidden.filter(hash => hash !== member);
    if (album.aliases) delete album.aliases[member];
    put_(store, key, album);
    store.deleteProperty(label);
  } else {
    const alias = alias_(request.alias === undefined ? '' : request.alias);
    if (!album.members.includes(member)) {
      if (album.members.length >= MAX_MEMBERS_) fail_('limit');
      album.members.push(member);
      if (alias) {
        album.aliases = album.aliases || {};
        album.aliases[member] = alias;
      }
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
