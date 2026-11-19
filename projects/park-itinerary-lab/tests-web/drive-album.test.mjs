import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../drive-album/Code.gs', import.meta.url), 'utf8');
const uidHash = uid => createHash('sha256').update(uid).digest('hex');
const owner = {uid:'synthetic-owner', email:'owner@example.test'};
const guest = {uid:'synthetic-guest', email:'guest@example.test'};
const visitor = {uid:'synthetic-visitor', email:'visitor@example.test'};
const folderType = 'application/vnd.google-apps.folder';
const payload = (albumId, photoId = randomUUID()) => ({albumId, photoId, jpeg:'QUJD', label:'一回目', visitKey:'2026-11-19:sea:test:1'});
function tokenFor(actor, overrides) {
  const now = Math.floor(Date.now()/1000);
  const claims = {iss:'https://securetoken.google.com/tdroute-399c1', aud:'tdroute-399c1', sub:actor.uid,
    exp:now+3600, iat:now, auth_time:now-60, email:actor.email, email_verified:true, firebase:{sign_in_provider:'google.com'}, ...overrides};
  return 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
}
function backend() {
  const props = new Map(), tokens = new Map(), files = new Map();
  const token = a => {
    const t = tokenFor(a);
    tokens.set(t,{localId:a.uid,email:a.email,emailVerified:true,providerUserInfo:[{providerId:'google.com'}]});
    return t;
  };
  const flags = {lostUpload:false, busy:false, driveCalls:0};
  const store = {getKeys:() => [...props.keys()], getProperties:() => Object.fromEntries(props), getProperty:k=>props.get(k)||null,
    setProperty:(k,v)=>props.set(k,v), deleteProperty:k=>{
      if (k === flags.failPropertyDelete) { flags.failPropertyDelete = null; throw new Error('property unavailable'); }
      props.delete(k);
    }};
  const response = (status, data) => ({getResponseCode:()=>status,getContentText:()=>JSON.stringify(data),getContent:()=>data});
  function fetch(url, options) {
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=')) {
      const account = tokens.get(JSON.parse(options.payload).idToken);
      return account ? response(200,{users:[account]}) : response(400,{});
    }
    assert.ok(url.startsWith('https://www.googleapis.com/drive/v3/files/'));
    flags.driveCalls++;
    const u = new URL(url), file = files.get(u.pathname.split('/').at(-1));
    if (!file) return response(404,{});
    assert.equal(options?.method || 'get','get','album operations must never delete or trash the originals');
    if (u.searchParams.get('alt') === 'media' && flags.onRead) {
      const onRead = flags.onRead;
      flags.onRead = null;
      onRead();
    }
    return response(200,u.searchParams.has('alt') ? file.bytes : file);
  }
  function listFolders({q, pageSize, pageToken}) {
    flags.driveCalls++;
    const parent = q.match(/'([^']+)' in parents/)?.[1];
    assert.ok(parent && q.includes(folderType) && /trashed\s*=\s*false/.test(q));
    const matches = [...files.values()].filter(f => !f.trashed && f.mimeType === folderType && f.parents?.includes(parent));
    const start = Number(pageToken || 0), end = start + Math.min(pageSize || 100, flags.pageSize || 100);
    return {files:matches.slice(start,end), incompleteSearch:!!flags.incompleteSearch,
      nextPageToken:end < matches.length ? String(end) : undefined};
  }
  const ctx = vm.createContext({
    PropertiesService:{getScriptProperties:()=>store},
    LockService:{getScriptLock:()=>({tryLock:()=>!flags.busy, releaseLock(){}})}, ScriptApp:{getOAuthToken:()=>'owner-OAuth-fixture'},
    UrlFetchApp:{fetch, fetchAll:requests=>requests.map(r=>fetch(r.url,r))},
    Drive:{Files:{list:listFolders,generateIds:()=>({ids:[randomUUID()]}),create:(meta,blob)=>{
      flags.driveCalls++;
      assert.equal(files.has(meta.id),false);
      const file = {...meta,bytes:blob?.bytes,trashed:false,shared:false};
      files.set(meta.id,file);
      if (blob && flags.lostUpload) { flags.lostUpload=false; throw new Error('lost acknowledgement'); }
      if (meta.mimeType === folderType && flags.lostFolder === meta.name) {
        flags.lostFolder = null; throw new Error('lost folder acknowledgement');
      }
      return file;
    }}},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'}, computeDigest:(alg,data)=>Array.from(createHash(alg).update(typeof data==='string'?data:Buffer.from(data)).digest()),
      base64Decode:s=>Array.from(Buffer.from(s,'base64')), base64DecodeWebSafe:s=>Array.from(Buffer.from(s,'base64url')),
      base64Encode:a=>Buffer.from(a).toString('base64'), newBlob:bytes=>({bytes,getDataAsString:()=>Buffer.from(bytes).toString('utf8')})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType:()=>s})},
    // JPEG marker parsing and byte-preservation have dedicated tests in drive-jpeg.test.mjs.
    sanitizeJpeg_:b=>b
  });
  vm.runInContext(source.replace(/const OWNER_HASH_ = '[a-f0-9]{64}';/,`const OWNER_HASH_ = '${uidHash(owner.uid)}';`),ctx);
  const call = (a,action,data={})=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify({action,idToken:typeof a==='string'?a:token(a),...data})}}));
  const create = (title='旅行') => {const albumId=randomUUID(); assert.deepEqual(call(owner,'create',{albumId,title}),{ok:true});return albumId;};
  return {call,create,props,files,flags,tokens,token};
}

function foldersFor(files, photo) {
  let file = [...files.values()].find(f => f.appProperties?.photo === photo.photoId);
  assert.ok(file, 'the original must exist');
  const folders = [];
  while (file.parents?.length) {
    assert.equal(file.parents.length,1);
    file = files.get(file.parents[0]);
    assert.equal(file?.mimeType,folderType);
    assert.ok(!folders.includes(file));
    folders.unshift(file);
  }
  return folders;
}

test('visit date, authenticated uploader and stored album determine the private folder tree',()=>{
  const {call,create,files,flags} = backend();
  const album = create(), namesake = create(), other = create('誕生日');
  const day = '2024-02-29', nextDay = '2024-03-01', nextYear = '2025-02-28';
  assert.equal(call(owner,'member',{albumId:album,email:guest.email,remove:false}).ok,true);
  function upload(actor, albumId, date) {
    const p = {...payload(albumId), visitKey:date + ':land:free:1',
      folder:'arbitrary', parentId:'arbitrary', uid:visitor.uid, albumTitle:'別の名前', date:'2001-01-01'};
    assert.deepEqual(call(actor,'upload',p),{ok:true});
    return foldersFor(files,p);
  }
  const first = upload(owner,album,day);
  assert.deepEqual(first.map(f=>f.name),['TDRoute 夢の思い出','2024','02','29',uidHash(owner.uid),'旅行']);
  assert.ok(first.every(f=>!f.trashed && !f.shared));
  assert.deepEqual(upload(owner,album,day),first);
  const guestPath = upload(guest,album,day);
  assert.deepEqual(guestPath.slice(0,4),first.slice(0,4));
  assert.deepEqual(guestPath.slice(4).map(f=>f.name),[uidHash(guest.uid),'旅行']);
  assert.notEqual(guestPath[5].id, first[5].id);
  flags.pageSize = 1;
  const duplicate = upload(owner,namesake,day);
  assert.deepEqual(duplicate.slice(0,5),first.slice(0,5));
  assert.notEqual(duplicate[5].id,first[5].id);
  assert.match(duplicate[5].name,/旅行/);
  assert.deepEqual(upload(owner,namesake,day),duplicate);
  assert.equal(upload(owner,other,day)[5].name,'誕生日');
  assert.deepEqual(upload(owner,album,nextDay).slice(1,4).map(f=>f.name),['2024','03','01']);
  assert.deepEqual(upload(owner,album,nextYear).slice(1,4).map(f=>f.name),['2025','02','28']);
});

test('invalid visit dates cannot create files or reserve an upload',()=>{
  const {call,create,flags,props} = backend(), albumId = create(), p = payload(albumId);
  const originalKeys = [...props.keys()];
  for (const visitKey of ['2026-02-29:sea:test:1','2026-04-31:sea:test:1','2026-00-01:land:free:1',
    '2026-12-00:sea:free:1','2026-2-01:sea:test:1','2026-11-19','free']) {
    assert.equal(call(owner,'upload',{...p,visitKey}).error,'invalid',visitKey);
  }
  assert.equal(flags.driveCalls,0);
  assert.deepEqual([...props.keys()],originalKeys);
  assert.deepEqual(call(owner,'upload',p),{ok:true});
});

test('a partial folder listing or an unrelated same-name date folder cannot redirect a photo',()=>{
  const {call,create,files,flags} = backend(), albumId = create(), p = payload(albumId);
  assert.deepEqual(call(owner,'upload',p),{ok:true});
  const month = foldersFor(files,p)[2];
  const external = randomUUID();
  files.set(external,{id:external,name:'20',parents:[month.id],mimeType:folderType,shared:false,trashed:false});
  const initialCount = files.size, next = {...payload(albumId),visitKey:'2026-11-20:sea:free:1'};
  flags.pageSize = 1;
  flags.incompleteSearch = true;
  assert.equal(call(owner,'upload',next).error,'offline');
  flags.incompleteSearch = false;
  assert.equal(call(owner,'upload',next).error,'conflict');
  assert.equal(files.size,initialCount);
  assert.deepEqual(call(owner,'list',{albumId}).photos.map(photo=>photo.id),[p.photoId]);
  files.get(external).name = '別の日';
  assert.deepEqual(call(owner,'upload',next),{ok:true});
  const created = foldersFor(files,next)[3];
  assert.equal(created.name,'20');
  assert.notEqual(created.id,external);
});

test('validated Google identity and private named invitations govern every album operation',()=>{
  const {call,create,flags} = backend(), albumId = create(), p = {...payload(albumId), visibility:'album'};
  assert.deepEqual(call(guest,'albums').albums,[]);
  for (const action of ['create','member','list','image','upload','delete','archivePhoto','deleteAlbum','archiveAlbum','setVisibility']) {
    assert.equal(call(guest,action,{...p,title:'旅行',email:guest.email,remove:false}).error,'forbidden',action);
  }
  assert.equal(flags.driveCalls,0);
  assert.equal(call(owner,'member',{albumId,email:'  GUEST@EXAMPLE.TEST ',remove:false}).ok,true);
  assert.deepEqual(call(guest,'albums').albums,[{id:albumId,title:'旅行',owner:false}]);
  assert.equal(call(guest,'upload',p).ok,true);
  assert.deepEqual(call(guest,'list',{albumId}).photos,[{id:p.photoId,visitKey:p.visitKey,label:p.label,visibility:'album',canDelete:true,canSetVisibility:true}]);
  assert.deepEqual(call(owner,'image',p),{ok:true,jpeg:'QUJD'});
  call(owner,'member',{albumId,email:visitor.email,remove:false});
  assert.equal(call(visitor,'list',{albumId}).photos[0].canDelete,false);
  assert.equal(call(visitor,'delete',p).error,'forbidden');
  assert.equal(call(owner,'member',{albumId,email:guest.email,remove:true}).ok,true);
  assert.equal(call(guest,'image',p).error,'forbidden');
  assert.equal(call(guest,'upload',p).error,'forbidden');
  assert.deepEqual(call(guest,'albums').albums,[]);
  assert.equal(call(owner,'albums').albums[0].owner,true);
});

test('each invited author can keep a photo private, share it and retract it',()=>{
  const {call,create,flags} = backend(), albumId = create(), p = payload(albumId);
  for (const a of [guest, visitor]) call(owner,'member',{albumId,email:a.email,remove:false});
  assert.equal(call(guest,'albums').visibilityVersion,1);
  assert.equal(call(guest,'albums').archiveVersion,1);
  assert.equal(call(guest,'upload',p).ok,true);
  assert.equal(call(guest,'image',p).jpeg,p.jpeg);
  assert.deepEqual(call(guest,'list',{albumId}).photos,[{
    id:p.photoId, label:p.label, visitKey:p.visitKey, visibility:'private', canDelete:true, canSetVisibility:true
  }]);
  for (const other of [owner, visitor]) {
    const start = flags.driveCalls;
    assert.deepEqual(call(other,'list',{albumId}).photos,[]);
    assert.equal(call(other,'image',p).error,'not-found');
    assert.equal(call(other,'setVisibility',{...p,visibility:'album'}).error,'not-found');
    assert.deepEqual(call(other,'delete',p),call(other,'delete',payload(albumId)));
    assert.equal(flags.driveCalls,start,'hidden photos are not accessed on Drive');
  }
  assert.equal(call(guest,'setVisibility',{...p,visibility:'album'}).ok,true);
  assert.equal(call(guest,'setVisibility',{...p,visibility:'album'}).ok,true);
  for (const other of [owner, visitor]) {
    assert.equal(call(other,'image',p).jpeg,p.jpeg);
    assert.deepEqual(call(other,'list',{albumId}).photos,[{
      id:p.photoId, label:p.label, visitKey:p.visitKey, visibility:'album', canDelete:other===owner, canSetVisibility:false
    }]);
    assert.equal(call(other,'setVisibility',{...p,visibility:'private'}).error,'forbidden');
  }
  assert.equal(call(guest,'setVisibility',{...p,visibility:'private'}).ok,true);
  assert.deepEqual(call(visitor,'list',{albumId}).photos,[]);
  assert.equal(call(owner,'image',p).error,'not-found');
  assert.equal(call(guest,'delete',p).ok,true);
  assert.equal(call(guest,'image',p).error,'not-found');
});

test('unknown visibility never grants access and upload retries preserve later audience choices',()=>{
  const {call,create,flags,props} = backend(), albumId = create(), p = {...payload(albumId),visibility:'album'};
  call(owner,'member',{albumId,email:guest.email,remove:false});
  for (const value of [null, false, 0, '', 'public']) {
    assert.equal(call(guest,'upload',{...p,visibility:value}).error,'invalid');
  }
  flags.lostUpload = true;
  assert.equal(call(guest,'upload',p).error,'offline');
  assert.equal(call(guest,'upload',{...p,visibility:'private'}).error,'conflict');
  assert.equal(call(guest,'upload',p).ok,true);
  assert.equal(call(guest,'setVisibility',{...p,visibility:'private'}).ok,true);
  assert.equal(call(guest,'upload',p).error,'conflict');
  assert.equal(call(owner,'image',p).error,'not-found');
  assert.equal(call(guest,'setVisibility',{...p,visibility:undefined}).error,'invalid');
  const key = 'photo:' + albumId + ':' + p.photoId;
  const record = JSON.parse(props.get(key));
  for (const oldValue of [undefined,'public',null]) {
    props.set(key,JSON.stringify({...record,visibility:oldValue}));
    assert.deepEqual(call(owner,'list',{albumId}).photos,[]);
    assert.equal(call(owner,'image',p).error,'not-found');
    assert.equal(call(guest,'list',{albumId}).photos[0].visibility,'private');
  }
  assert.equal(call(guest,'upload',{...p,visibility:undefined}).ok,true);
  assert.equal(call(guest,'setVisibility',p).ok,true);
  assert.equal(call(owner,'image',p).jpeg,p.jpeg);
});

test('membership and photo visibility are rechecked after reading the Drive image',()=>{
  const {call,create,flags} = backend(), albumId = create(), p = {...payload(albumId),visibility:'album'};
  for (const a of [guest, visitor]) call(owner,'member',{albumId,email:a.email,remove:false});
  assert.equal(call(guest,'upload',p).ok,true);
  flags.onRead = () => assert.equal(call(guest,'setVisibility',{...p,visibility:'private'}).ok,true);
  assert.deepEqual(call(owner,'image',p),{ok:false,error:'not-found'});
  assert.equal(call(guest,'setVisibility',p).ok,true);
  flags.onRead = () => assert.equal(call(owner,'member',{albumId,email:visitor.email,remove:true}).ok,true);
  assert.deepEqual(call(visitor,'image',p),{ok:false,error:'forbidden'});
  flags.onRead = () => assert.deepEqual(call(guest,'archivePhoto',p),{ok:true});
  assert.deepEqual(call(guest,'image',p),{ok:false,error:'not-found'});
});

test('an author can change a single picture while the other pictures retain their audiences',()=>{
  const {call,create} = backend(), albumId = create();
  const shared = {...payload(albumId),visibility:'album'}, personal = payload(albumId);
  assert.deepEqual(call(owner,'member',{albumId,email:guest.email,remove:false}),{ok:true});
  for (const p of [shared,personal]) assert.deepEqual(call(owner,'upload',p),{ok:true});
  const memberPhotoIds = () => call(guest,'list',{albumId}).photos.map(p=>p.id).sort();
  assert.deepEqual(memberPhotoIds(),[shared.photoId]);
  assert.deepEqual(call(owner,'setVisibility',{...personal,visibility:'album'}),{ok:true});
  assert.deepEqual(memberPhotoIds(),[personal.photoId,shared.photoId].sort());
  assert.deepEqual(call(owner,'setVisibility',{...shared,visibility:'private'}),{ok:true});
  assert.deepEqual(memberPhotoIds(),[personal.photoId]);
  assert.equal(call(guest,'image',shared).error,'not-found');
  assert.equal(call(guest,'image',personal).jpeg,personal.jpeg);
});

test('legacy flat photos remain readable and unfinished uploads can resume in their original folder',()=>{
  const {call,create,files,props} = backend(), albumId = create(), root = randomUUID();
  files.set(root,{id:root,name:'TDRoute 夢の思い出',mimeType:folderType,appProperties:{app:'TDRoute-memories'},
    shared:false,trashed:false});
  props.set('folder',root);
  assert.deepEqual(call(owner,'member',{albumId,email:guest.email,remove:false}),{ok:true});
  for (const [state,exists] of [['ready',true],['saving',true],['saving',false]]) {
    // The original API allowed keys without a date and allocated the Drive ID before writing bytes.
    const p = {...payload(albumId),visitKey:'legacy'}, id = randomUUID();
    const bytes = Buffer.from(p.jpeg,'base64');
    props.set('photo:' + albumId + ':' + p.photoId,JSON.stringify({state, file:id, author:uidHash(owner.uid),
      visitKey:p.visitKey, label:p.label, checksum:createHash('sha256').update(bytes).digest('hex'), created:1}));
    if (exists) files.set(id,{id,name:p.photoId + '.jpg',mimeType:'image/jpeg',parents:[root],appProperties:{photo:p.photoId},
      bytes:[...bytes],shared:false,trashed:false});
    assert.deepEqual(call(owner,'upload',p),{ok:true},state);
    assert.deepEqual(call(owner,'image',p),{ok:true,jpeg:p.jpeg});
    assert.equal(call(guest,'image',p).error,'not-found','legacy visibility defaults to private');
    assert.deepEqual([...files.get(id).parents],[root]);
    assert.deepEqual(call(owner,'archivePhoto',p),{ok:true});
    assert.equal(call(owner,'image',p).error,'not-found');
    assert.equal(files.get(id).trashed,false);
  }
});

test('checks signed token with Identity Toolkit, exact project and recent Google authentication',()=>{
  const {call,token,tokens,flags} = backend();
  assert.equal(call('nonsense','albums').error,'auth');
  const t = token(owner), row=tokens.get(t);
  for (const claims of [{aud:'another-project'},{iss:'https://securetoken.google.com/other'},{firebase:{sign_in_provider:'password'}},
    {exp:1},{email_verified:false},{sub:'another-user'},{email:'other@example.test'}]) {
    const other=tokenFor(owner,claims);
    tokens.set(other,row);
    assert.equal(call(other,'albums').error,'auth');
  }
  assert.equal(call(t.replace(/\.signature$/,'.forged'),'albums').error,'auth');
  for (const change of [{disabled:true},{emailVerified:false},{validSince:Math.floor(Date.now()/1000)},{providerUserInfo:[]}]) {
    tokens.set(t,{...row,...change}); assert.equal(call(t,'albums').error,'auth');
  }
  assert.equal(flags.driveCalls,0);
});

test('retry recovers the same private file after uncertain Drive upload, and prior deletions win',()=>{
  const {call,create,files,flags,props} = backend(), albumId=create(), p=payload(albumId);
  flags.busy=true; assert.equal(call(owner,'upload',p).error,'busy'); flags.busy=false;
  flags.lostFolder='11'; assert.equal(call(owner,'upload',p).error,'offline');
  flags.lostUpload=true; assert.equal(call(owner,'upload',p).error,'offline');
  assert.equal(files.size,7,'one JPEG, one root and five nested folders');
  assert.deepEqual(call(owner,'list',{albumId}).photos,[]);
  assert.equal(call(owner,'upload',p).ok,true);
  assert.equal(call(owner,'upload',p).ok,true);
  assert.equal(files.size,7);
  assert.equal(call(owner,'upload',{...p,jpeg:'QEJD'}).error,'conflict');
  const orphan=payload(albumId);
  flags.lostUpload=true; call(owner,'upload',orphan);
  assert.ok([...props.values()].some(v=>v.includes('saving')));
  const beforeRemoval = flags.driveCalls;
  assert.equal(call(owner,'archivePhoto',orphan).ok,true);
  assert.equal(call(owner,'archivePhoto',p).ok,true);
  assert.equal(call(owner,'image',p).error,'not-found');
  assert.deepEqual(call(owner,'delete',p),{ok:true});
  assert.equal(call(owner,'upload',p).error,'conflict');
  assert.equal(call(owner,'upload',orphan).error,'conflict');
  assert.equal(call(owner,'setVisibility',{...p,visibility:'album'}).error,'not-found');
  assert.equal(flags.driveCalls,beforeRemoval);
  const originals = [...files.values()].filter(f=>f.mimeType==='image/jpeg' && !f.trashed);
  assert.equal(originals.length,2);
  for (const image of originals) assert.deepEqual(Buffer.from(image.bytes),Buffer.from(p.jpeg,'base64'));
  assert.deepEqual(call(owner,'list',{albumId}).photos,[]);
});

test('removing an album revokes access first and a retry preserves private and shared originals',()=>{
  const {call,create,files,flags,props} = backend(), id=create(), other=create();
  call(owner,'member',{albumId:id,email:guest.email,remove:false});
  const p={...payload(id),visibility:'album'}, personal=payload(id), keep=payload(other);
  for (const [actor,photo] of [[owner,p],[guest,personal],[owner,keep]]) assert.deepEqual(call(actor,'upload',photo),{ok:true});
  flags.failPropertyDelete='photo:' + id + ':' + personal.photoId;
  const beforeRemoval = flags.driveCalls;
  assert.equal(call(owner,'archiveAlbum',{albumId:id}).error,'offline');
  assert.equal(call(guest,'image',p).error,'forbidden');
  assert.deepEqual(call(guest,'albums').albums,[]);
  assert.equal(call(owner,'upload',p).error,'conflict');
  assert.equal(call(owner,'deleteAlbum',{albumId:id}).ok,true);
  assert.equal(call(owner,'deleteAlbum',{albumId:id}).ok,true);
  assert.equal(call(owner,'create',{albumId:id,title:'旅行'}).error,'conflict');
  assert.equal(call(owner,'image',personal).ok,false);
  assert.equal(call(guest,'image',personal).ok,false);
  assert.equal(flags.driveCalls,beforeRemoval);
  assert.equal(call(owner,'image',keep).ok,true);
  assert.equal([...files.values()].filter(f=>f.mimeType==='image/jpeg' && !f.trashed).length,3);
  assert.equal([...props.keys()].filter(k=>k.startsWith('album:')).length,1);
});

test('refuses new uploads if any folder in the existing path is shared',()=>{
  const {call,create,files} = backend(), id=create(), p=payload(id);
  assert.equal(call(owner,'upload',p).ok,true);
  const firstSize = files.size;
  for (const folder of foldersFor(files,p)) {
    folder.shared=true;
    assert.equal(call(owner,'upload',payload(id)).error,'offline',folder.name);
    assert.equal(files.size,firstSize);
    folder.shared=false;
  }
});
