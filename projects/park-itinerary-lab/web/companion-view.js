import {encodeJoint, decodeJoint} from './joint-planning.js?v=2.6.0';

// Only the visit day, timetable and recorded experience status leave the owner's private plan.
export const progressLabels = {
  queue:'並んでいる', riding:'体験中', done:'体験済み', pending:'あとで体験', skipped:'今回は見送り'
};

export function companionEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/u.test(email)) {
    throw new Error('ログインに使うGoogleアカウントのメールアドレスを入力してください。');
  }
  return email;
}

export function timetablePayload({name, state, updatedAt}) {
  const settings = state.settings;
  const progress = settings.dayProgress;
  const visits = progress?.date === settings.date && progress.parkId === state.parkId ? progress.visits : {};
  const records = Object.entries(visits || {}).filter(([,v]) => Object.hasOwn(progressLabels,v.status))
    .map(([id,v]) => ({id, status:v.status, start:v.startedAt ?? null, end:v.endsAt ?? null}));
  const rows = (state.result?.status === 'feasible' ? state.result.rows : []).map(row => ({
    name:row.name, start:row.start, end:row.end
  }));
  const view = {name, date:settings.date, park:state.parkId, updatedAt, dirty:!!state.resultDirty, records, rows};
  const json = JSON.stringify(view);
  // Large imported plans must still be saved privately even when too large for the sharing view.
  return new TextEncoder().encode(json).length <= 140000 ? json :
    JSON.stringify({...view, records:[], rows:[], tooLarge:true});
}

// Connections are scoped to the active Firebase account. SDK credentials never enter the view.
export function companionStore({store, requireAccount, current}) {
  const address = uid => {
    requireAccount(uid);
    if (!current()?.emailVerified) throw new Error('確認済みのGoogleアカウントでログインしてください。');
    return companionEmail(current().email);
  };
  const inboxRef = (sdk,db,email,owner,plan) => sdk.doc(db,'tripInboxes',email,'invitations',owner + '~' + plan);
  const audienceRef = (sdk,db,uid,plan) => sdk.doc(db,'users',uid,'livePlanAudiences',plan);
  const viewRef = (sdk,db,uid,plan) => sdk.doc(db,'users',uid,'liveTimetables',plan);
  const editorsRef = (sdk,db,uid,plan) => sdk.doc(db,'users',uid,'liveEditors',plan);
  const workspaceRef = (sdk,db,uid,plan) => sdk.doc(db,'users',uid,'liveWorkspaces',plan);
  function listen(uid, build, next, error) {
    let active = true, unsubscribe;
    (async () => {
      requireAccount(uid);
      const {sdk,db} = await store();
      if (!active) return;
      requireAccount(uid);
      unsubscribe = sdk.onSnapshot(build(sdk,db), {includeMetadataChanges:true}, snapshot => {
        if (!active) return;
        try {
          requireAccount(uid);
          next(snapshot.metadata.fromCache ? null : snapshot);
        } catch (cause) { error(cause); }
      }, cause => { if (active) error(cause); });
    })().catch(cause => { if (active) error(cause); });
    return () => { active = false; unsubscribe?.(); };
  }
  return {
    watchAudiences(uid, next, error) {
      return listen(uid,(sdk,db) => sdk.collection(db,'users',uid,'livePlanAudiences'),
        result => next(result && new Map(result.docs.map(d => [d.id, d.data().members]))), error);
    },
    watchEditors(uid, next, error) {
      return listen(uid,(sdk,db) => sdk.collection(db,'users',uid,'liveEditors'),
        result => next(result && new Map(result.docs.map(d=>[d.id,d.data().members]))),error);
    },
    watchWorkspace(uid, invite, next, error) {
      return listen(uid,(sdk,db) => workspaceRef(sdk,db,invite.owner,invite.planId),
        snapshot => next(snapshot ? (snapshot.exists() ? decodeJoint(snapshot.data()) : false) : null),error);
    },
    async commitWorkspace(uid, invite, revision, state) {
      requireAccount(uid);
      const draft = encodeJoint(state);
      const view = timetablePayload({name:invite.name,state:JSON.parse(draft),updatedAt:new Date().toISOString()});
      const {sdk,db} = await store();
      const ref = workspaceRef(sdk,db,invite.owner,invite.planId);
      const result = await sdk.runTransaction(db, async tx => {
        requireAccount(uid);
        const current = await tx.get(ref);
        requireAccount(uid);
        if (!current.exists()) throw new Error('この共同計画は削除されました。');
        if (current.data().revision !== revision) return {ok:false,current:decodeJoint(current.data())};
        tx.set(ref,{revision:revision+1,draft,view});
        tx.set(viewRef(sdk,db,invite.owner,invite.planId),{view});
        return {ok:true, revision:revision+1};
      });
      requireAccount(uid);
      return result;
    },
    watchInbox(uid, next, error) {
      return listen(uid,(sdk,db) => sdk.collection(db,'tripInboxes',address(uid),'invitations'),
        result => next(result && result.docs.map(d => ({...d.data(),key:d.id}))), error);
    },
    watchView(uid, invite, next, error) {
      return listen(uid,(sdk,db) => viewRef(sdk,db,invite.owner,invite.planId),
        result => next(result?.exists() ? JSON.parse(result.data().view) : null), error);
    },
    async changeMember(uid, planId, input, add, role = 'viewer') {
      const email = companionEmail(input);
      if (!['viewer','editor'].includes(role)) throw new Error('招待する権限を選んでください。');
      if (email === address(uid)) throw new Error('同行者のGoogleアカウントを指定してください。');
      const {sdk,db} = await store();
      const ref = audienceRef(sdk,db,uid,planId), roles = editorsRef(sdk,db,uid,planId);
      const workspace = workspaceRef(sdk,db,uid,planId);
      await sdk.runTransaction(db, async transaction => {
        requireAccount(uid);
        const [audience, editors, saved, joint] = await Promise.all([
          transaction.get(ref),transaction.get(roles),transaction.get(sdk.doc(db,'users',uid,'plans',planId)),
          transaction.get(workspace)
        ]);
        requireAccount(uid);
        const members = audience.data()?.members || [], oldEditors = editors.data()?.members || [];
        const hasMember = members.includes(email);
        if (!hasMember && !add) return;
        if (add && !hasMember && members.length >= 12) throw new Error('同行者は1つの計画につき12人までです。');
        const changed = add ? [...new Set([...members,email])] : members.filter(item => item !== email);
        const editing = add && role === 'editor';
        const newEditors = editing ? [...new Set([...oldEditors,email])] : oldEditors.filter(item => item !== email);
        const invite = inboxRef(sdk,db,email,uid,planId);
        const target = viewRef(sdk,db,uid,planId);
        if (changed.length) transaction.set(ref,{members:changed}); else transaction.delete(ref);
        // An empty roster marks a previous collaborative workspace while viewers remain.
        if (newEditors.length || (joint.exists() && changed.length)) transaction.set(roles,{members:newEditors});
        else if (editors.exists()) transaction.delete(roles);
        if (!add) {
          transaction.delete(invite);
          if (!changed.length) { transaction.delete(target); if (joint.exists()) transaction.delete(workspace); }
          return;
        }
        if (!saved.data()?.payload) throw new Error('計画を保存して同期してから、もう一度招待してください。');
        const plan = JSON.parse(saved.data().payload);
        if (!joint.exists()) {
          if (editing) {
            const draft = encodeJoint(plan.state);
            const view = timetablePayload({...plan,state:JSON.parse(draft)});
            transaction.set(workspace,{revision:1,draft,view}); transaction.set(target,{view});
          } else transaction.set(target,{view:timetablePayload(plan)});
        }
        const grant = {owner:uid,planId,name:plan.name};
        if (editing) grant.role = 'editor';
        transaction.set(invite,grant);
      });
      requireAccount(uid);
    },
    // Run inside the same transaction as the versioned private save or deletion.
    async updateSharedCopy(sdk,db,tx,uid,id,previous,plan) {
      const ref = audienceRef(sdk,db,uid,id);
      const members = (await tx.get(ref)).data()?.members || [];
      requireAccount(uid);
      if (!members.length) return;
      const view = viewRef(sdk,db,uid,id);
      const roles = editorsRef(sdk,db,uid,id);
      const editors = await tx.get(roles);
      requireAccount(uid);
      if (plan && !editors.exists()) tx.set(view,{view:timetablePayload(plan)});
      if (!plan) {
        tx.delete(ref); tx.delete(view);
        if (editors.exists()) { tx.delete(roles); tx.delete(workspaceRef(sdk,db,uid,id)); }
      }
      if (!plan || previous?.name !== plan.name) {
        for (const email of members) {
          const invite = inboxRef(sdk,db,email,uid,id);
          if (plan) {
            const grant = {owner:uid,planId:id,name:plan.name};
            if (editors.data()?.members.includes(email)) grant.role = 'editor';
            tx.set(invite,grant);
          }
          else tx.delete(invite);
        }
      }
    }
  };
}
