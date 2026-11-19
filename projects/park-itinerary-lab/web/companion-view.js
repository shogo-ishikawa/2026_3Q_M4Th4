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
    watchInbox(uid, next, error) {
      return listen(uid,(sdk,db) => sdk.collection(db,'tripInboxes',address(uid),'invitations'),
        result => next(result && result.docs.map(d => ({...d.data(),key:d.id}))), error);
    },
    watchView(uid, invite, next, error) {
      return listen(uid,(sdk,db) => viewRef(sdk,db,invite.owner,invite.planId),
        result => next(result?.exists() ? JSON.parse(result.data().view) : null), error);
    },
    async changeMember(uid, planId, input, add) {
      const email = companionEmail(input);
      if (email === address(uid)) throw new Error('同行者のGoogleアカウントを指定してください。');
      const {sdk,db} = await store();
      const ref = audienceRef(sdk,db,uid,planId);
      await sdk.runTransaction(db, async transaction => {
        requireAccount(uid);
        const [audience, saved] = await Promise.all([
          transaction.get(ref), transaction.get(sdk.doc(db,'users',uid,'plans',planId))
        ]);
        requireAccount(uid);
        const members = audience.data()?.members || [];
        if (members.includes(email) === add) return;
        if (add && members.length >= 12) throw new Error('同行者は1つの計画につき12人までです。');
        const invite = inboxRef(sdk,db,email,uid,planId);
        const changed = add ? [...members,email] : members.filter(item => item !== email);
        if (changed.length) transaction.set(ref,{members:changed});
        else transaction.delete(ref);
        if (add) {
          if (!saved.data()?.payload) throw new Error('計画を保存して同期してから、もう一度招待してください。');
          const plan = JSON.parse(saved.data().payload);
          transaction.set(viewRef(sdk,db,uid,planId),{view:timetablePayload(plan)});
          transaction.set(invite,{owner:uid,planId,name:plan.name});
        } else {
          transaction.delete(invite);
          if (!changed.length) transaction.delete(viewRef(sdk,db,uid,planId));
        }
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
      if (plan) tx.set(view,{view:timetablePayload(plan)});
      else { tx.delete(ref); tx.delete(view); }
      if (!plan || previous?.name !== plan.name) {
        for (const email of members) {
          const invite = inboxRef(sdk,db,email,uid,id);
          if (plan) tx.set(invite,{owner:uid,planId:id,name:plan.name});
          else tx.delete(invite);
        }
      }
    }
  };
}
