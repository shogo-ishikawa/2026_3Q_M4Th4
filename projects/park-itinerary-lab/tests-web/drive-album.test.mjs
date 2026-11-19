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
  const store = {getKeys:() => [...props.keys()], getProperties:() => Object.fromEntries(props), getProperty:k=>props.get(k)||null,
    setProperty:(k,v)=>props.set(k,v), deleteProperty:k=>props.delete(k)};
  const flags = {lostUpload:false, failDelete:false, busy:false, driveCalls:0};
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
    if (options?.method === 'patch') {
      if (flags.failDelete) { flags.failDelete = false; return response(503,{}); }
      file.trashed = JSON.parse(options.payload).trashed;
    }
    return response(200,u.searchParams.has('alt') ? file.bytes : file);
  }
  const ctx = vm.createContext({
    PropertiesService:{getScriptProperties:()=>store},
    LockService:{getScriptLock:()=>({tryLock:()=>!flags.busy, releaseLock(){}})}, ScriptApp:{getOAuthToken:()=>'owner-OAuth-fixture'},
    UrlFetchApp:{fetch, fetchAll:requests=>requests.map(r=>fetch(r.url,r))},
    Drive:{Files:{generateIds:()=>({ids:[randomUUID()]}),create:(meta,blob)=>{
      assert.equal(files.has(meta.id),false);
      files.set(meta.id,{...meta,bytes:blob?.bytes,trashed:false});
      if (blob && flags.lostUpload) { flags.lostUpload=false; throw new Error('lost acknowledgement'); }
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
  const create = () => {const albumId=randomUUID(); assert.deepEqual(call(owner,'create',{albumId,title:'旅行'}),{ok:true});return albumId;};
  return {call,create,props,files,flags,tokens,token};
}

test('validated Google identity and private named invitations govern every album operation',()=>{
  const {call,create,flags} = backend(), albumId = create(), p = payload(albumId);
  assert.deepEqual(call(guest,'albums').albums,[]);
  for (const action of ['create','member','list','image','upload','delete','deleteAlbum']) {
    assert.equal(call(guest,action,{...p,title:'旅行',email:guest.email,remove:false}).error,'forbidden',action);
  }
  assert.equal(flags.driveCalls,0);
  assert.equal(call(owner,'member',{albumId,email:'  GUEST@EXAMPLE.TEST ',remove:false}).ok,true);
  assert.deepEqual(call(guest,'albums').albums,[{id:albumId,title:'旅行',owner:false}]);
  assert.equal(call(guest,'upload',p).ok,true);
  assert.deepEqual(call(guest,'list',{albumId}).photos,[{id:p.photoId,visitKey:p.visitKey,label:p.label,canDelete:true}]);
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
  flags.lostUpload=true; assert.equal(call(owner,'upload',p).error,'offline');
  assert.equal(files.size,2);
  assert.deepEqual(call(owner,'list',{albumId}).photos,[]);
  assert.equal(call(owner,'upload',p).ok,true);
  assert.equal(call(owner,'upload',p).ok,true);
  assert.equal(files.size,2);
  assert.equal(call(owner,'upload',{...p,jpeg:'QEJD'}).error,'conflict');
  const orphan=payload(albumId);
  flags.lostUpload=true; call(owner,'upload',orphan);
  assert.ok([...props.values()].some(v=>v.includes('saving')));
  assert.equal(call(owner,'delete',orphan).ok,true);
  flags.failDelete=true; assert.equal(call(owner,'delete',p).error,'offline');
  assert.equal(call(owner,'image',p).error,'not-found');
  assert.deepEqual(call(owner,'delete',p),{ok:true});
  assert.deepEqual(call(owner,'delete',p),{ok:true});
  assert.equal(call(owner,'upload',p).error,'conflict');
  assert.equal([...files.values()].filter(f=>f.mimeType==='image/jpeg' && !f.trashed).length,0);
  assert.deepEqual(call(owner,'list',{albumId}).photos,[]);
});

test('deleting a whole album revokes membership before trash and can resume after failure',()=>{
  const {call,create,files,flags,props} = backend(), id=create(), other=create();
  call(owner,'member',{albumId:id,email:guest.email,remove:false});
  const p=payload(id), keep=payload(other);
  call(owner,'upload',p); call(owner,'upload',keep);
  flags.failDelete=true;
  assert.equal(call(owner,'deleteAlbum',{albumId:id}).error,'offline');
  assert.equal(call(guest,'image',p).error,'forbidden');
  assert.deepEqual(call(guest,'albums').albums,[]);
  assert.equal(call(owner,'upload',p).error,'conflict');
  assert.equal(call(owner,'deleteAlbum',{albumId:id}).ok,true);
  assert.equal(call(owner,'deleteAlbum',{albumId:id}).ok,true);
  assert.equal(call(owner,'create',{albumId:id,title:'旅行'}).error,'conflict');
  assert.equal(call(owner,'image',keep).ok,true);
  assert.equal([...files.values()].filter(f=>f.mimeType==='image/jpeg' && !f.trashed).length,1);
  assert.equal([...props.keys()].filter(k=>k.startsWith('album:')).length,1);
});

test('refuses new uploads if the operator shared the private Drive folder',()=>{
  const {call,create,files} = backend(), id=create();
  assert.equal(call(owner,'upload',payload(id)).ok,true);
  const folder = [...files.values()].find(file=>file.mimeType==='application/vnd.google-apps.folder');
  folder.shared=true;
  assert.equal(call(owner,'upload',payload(id)).error,'offline');
  assert.equal(files.size,2);
});
