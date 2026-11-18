import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlanSync} from '../web/named-sync.js';
import {saveNamedPlan} from '../web/storage.js';

const state = (date = '2026-11-19') => ({
  parkId:'land', settings:{date, entry:540, exit:1260, speed:70, budget:10000, selections:[]},
});

function memoryStorage() {
  const items = new Map();
  return {
    get length() { return items.size; },
    key:index => [...items.keys()][index],
    getItem:key => items.get(key) ?? null,
    setItem:(key,value) => items.set(key,value),
  };
}
function server() {
  const accounts = new Map();
  function docs(uid) {
    if (!accounts.has(uid)) accounts.set(uid,new Map());
    return accounts.get(uid);
  }
  return {
    list:async uid => structuredClone([...docs(uid).values()]),
    write:async (uid,id,expected,plan) => {
      const current = docs(uid).get(id) ?? null;
      if ((current?.revision ?? 0) !== expected) return {ok:false,current:structuredClone(current)};
      const revision = expected + 1;
      docs(uid).set(id,{id,revision,plan:structuredClone(plan)});
      return {ok:true,revision};
    },
  };
}
function device(remote, uid = 'a', storage = memoryStorage()) {
  const plans = createPlanSync({storage});
  plans.setAccount(uid,remote);
  return plans;
}

test('ログイン前はしおりを開かず、以前の端末のしおりは本人が取り込みを選んだときだけ扱う',async () => {
  const storage = memoryStorage(), remote = server();
  const legacy = saveNamedPlan('以前の予定',state(),{storage});
  const other = saveNamedPlan('同じ端末を使う家族の予定',state(),{storage});
  const plans = createPlanSync({storage});
  assert.throws(() => plans.list(),/ログイン/);
  plans.setAccount('a',remote);
  assert.deepEqual(plans.list(),[]);
  assert.equal(plans.guestCount(),2);
  await plans.syncNow();
  assert.deepEqual(await remote.list('a'),[]);
  assert.deepEqual(plans.availableGuestPlans().map(p => p.id).sort(),[legacy.id,other.id].sort());
  await assert.rejects(plans.importGuest([]),/選んで/);
  assert.equal(await plans.importGuest([legacy.id]),1);
  assert.equal(await plans.importGuest([legacy.id]),0);
  assert.deepEqual(plans.availableGuestPlans().map(p=>p.id),[other.id]);
  await plans.syncNow();
  const {id} = plans.list()[0];
  plans.setAccount(null);
  assert.throws(() => plans.load(id),/ログイン/);
  plans.setAccount('b',remote);
  assert.deepEqual(plans.list(),[]);
  assert.deepEqual(plans.availableGuestPlans().map(p=>p.id),[other.id]);
  assert.equal(await plans.importGuest([legacy.id]),0);
  assert.throws(() => plans.load(id),/見つかりません/);
  await plans.syncNow();
  assert.deepEqual(await remote.list('b'),[]);
  assert.equal(await plans.importGuest([other.id]),1);
  await plans.syncNow();
  assert.equal((await remote.list('b'))[0].plan.name,'同じ端末を使う家族の予定');
  plans.setAccount('a',remote);
  plans.remove(id);
  await plans.syncNow();
  assert.equal(plans.guestCount(),0);
});

test('2台の作成・名前変更・削除と、オフラインの保留を再起動後に同期する',async () => {
  const remote = server(), storage = memoryStorage(), one = device(remote), two = device(remote,'a',storage);
  const itinerary = state();
  itinerary.settings.history = [{raw:'手入力の履歴'}];
  itinerary.otherPark = {private:true};
  const {id} = one.save('海の予定',itinerary);
  await one.syncNow();
  await two.syncNow();
  assert.equal(two.list()[0].id,id);
  assert.equal(two.load(id).settings.history,undefined);
  assert.equal(two.load(id).otherPark,undefined);
  two.rename(id,'新しい名前');
  const reopened = device(null,'a',storage);
  assert.equal(reopened.list()[0].name,'新しい名前');
  await assert.rejects(reopened.syncNow());
  assert.equal(reopened.pendingCount(),1);
  reopened.setAccount('a',remote);
  await reopened.syncNow(); await one.syncNow();
  assert.equal(one.list()[0].name,'新しい名前');
  one.remove(id); await one.syncNow(); await reopened.syncNow();
  assert.deepEqual(reopened.list(),[]);
  assert.equal((await remote.list('a'))[0].plan,null);
});

test('2台の同時編集を別名で保存し、更新中に届いた編集も確定前に失わない',async () => {
  const remote = server(), first = device(remote), second = device(remote);
  const {id} = first.save('予定',state());
  await first.syncNow(); await second.syncNow();
  first.save('1台目',state('2026-11-20'),{id});
  second.save('2台目',state('2026-11-21'),{id});
  await first.syncNow();
  assert.equal((await second.syncNow()).conflicts,1);
  assert.equal(second.pendingCount(),0);
  await first.syncNow();
  assert.deepEqual(first.list().map(item=>item.date).sort(),['2026-11-20','2026-11-21']);
  const previous = first.load(id);
  second.rename(id,'別の端末で名称変更'); await second.syncNow(); await first.syncNow();
  const kept = first.save('編集していた予定',previous,{id});
  assert.equal(kept.conflict,true);
  assert.notEqual(kept.id,id);
  assert.equal(first.list().find(item=>item.id === id).name,'別の端末で名称変更');
});

test('応答の途絶後は確定済み書込みを重複させず、保存中に再編集しても最新の変更を送る',async () => {
  const remote = server(), plans = device(remote);
  const {id} = plans.save('最初',state());
  let acknowledged, resume;
  const waiting = new Promise(resolve => { acknowledged = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  const write = remote.write;
  remote.write = async (...args) => {
    const reply = await write(...args);
    acknowledged();
    await paused;
    throw Error('回線が切れました');
  };
  const pending = plans.syncNow();
  await waiting; resume();
  await assert.rejects(pending,/回線/);
  remote.write = write;
  await plans.syncNow();
  assert.equal(plans.list().length,1);
  assert.equal(plans.pendingCount(),0);
  plans.rename(id,'2');
  let edited = false;
  remote.write = async (...args) => {
    const reply = await write(...args);
    if (!edited) { edited = true; plans.rename(id,'3'); }
    return reply;
  };
  await plans.syncNow();
  assert.equal(plans.pendingCount(),0);
  assert.equal((await remote.list('a'))[0].plan.name,'3');
});

test('削除と編集が競合した場合は新しい内容を保持し、アカウント切替後の応答は捨てる',async () => {
  const remote = server(), one = device(remote), two = device(remote);
  const {id} = one.save('予定',state());
  await one.syncNow(); await two.syncNow();
  one.rename(id,'変更'); two.remove(id);
  await one.syncNow();
  assert.equal((await two.syncNow()).conflicts,1);
  assert.equal(two.list()[0].name,'変更');
  let complete;
  const response = new Promise(resolve => { complete = resolve; });
  two.setAccount('a',{list:() => response});
  const old = two.syncNow();
  two.setAccount('b',remote);
  complete(await remote.list('a'));
  await old;
  assert.deepEqual(two.list(),[]);
});

test('同期できない一件は端末に保持し、ほかのしおりは同期する',async () => {
  const remote = server(), plans = device(remote), write = remote.write;
  remote.write = async (...args) => {
    if (args[3]?.name === '大') throw Error('容量超過');
    return write(...args);
  };
  plans.save('大',state());
  plans.save('小',state());
  await assert.rejects(plans.syncNow(),/容量超過/);
  assert.equal(plans.pendingCount(),1);
  assert.equal(plans.list().length,2);
  assert.deepEqual((await remote.list('a')).map(row=>row.plan.name),['小']);
});


test('保存時は単独のしおりだけを書き、一覧を開いた際に他端末の変更を取得する',async () => {
  const remote = server(), plans = device(remote);
  let reads = 0;
  const list = remote.list;
  remote.list = async uid => { reads++; return list(uid); };
  plans.save('予定',state());
  await plans.syncNow({refresh:false});
  assert.equal(reads,0);
  await plans.syncNow();
  assert.equal(reads,1);
});
