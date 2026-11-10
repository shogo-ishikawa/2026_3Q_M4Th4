/* Clear records stay on this device; unavailable storage never blocks play. */
'use strict';
(function (root) {
  function createStore(storage, levelCount, key = 'world-definition-progress-v1', options = {}) {
    if (!options || typeof options !== 'object') options = {};
    let persistent = Boolean(storage);
    const lastIndex = Math.max(0, levelCount - 1);
    const initialUnlocked = Number.isInteger(options.initialUnlocked) ? Math.max(0, Math.min(lastIndex, options.initialUnlocked)) : 0;
    const initialStage = Number.isInteger(options.initialStage) ? Math.max(0, Math.min(initialUnlocked, options.initialStage)) : 0;
    const blank = () => ({ unlocked: initialUnlocked, lastStage: initialStage, best: {} });
    let data = blank();
    function readRecords(saved, count = levelCount) {
      const best = {};
      for (let index = 0; index < count; index++) {
        const record = saved.best?.[index];
        if (record && ['rules', 'shards', 'time'].every(name => Number.isFinite(record[name]) && record[name] >= 0)) {
          best[index] = { rules: Math.floor(record.rules), shards: Math.min(2, Math.floor(record.shards)), time: record.time };
        }
      }
      return best;
    }
    try {
      const raw = storage?.getItem(key);
      const saved = JSON.parse(raw || 'null');
      if (saved && typeof saved === 'object' && Number.isInteger(saved.unlocked)) {
        data.unlocked = Math.max(initialUnlocked, Math.min(lastIndex, saved.unlocked));
        data.lastStage = Number.isInteger(saved.lastStage) ? Math.max(0, Math.min(data.unlocked, saved.lastStage)) : initialStage;
        data.best = readRecords(saved);
        // v1.1 ended at stage 5. A recorded final clear also opens the new chapter.
        if (levelCount > 5 && data.unlocked === 4 && data.best[4]) data.unlocked = 5;
      } else if (!raw && typeof options.migrateKey === 'string' && options.migrateKey && options.migrateKey !== key) {
        // The old nine maps remain practice. Their records do not complete a new mystery.
        const previous = JSON.parse(storage?.getItem(options.migrateKey) || 'null');
        if (previous && typeof previous === 'object' && Number.isInteger(previous.unlocked)) {
          data.best = readRecords(previous, initialUnlocked);
          storage?.setItem(key, JSON.stringify(data));
        }
      }
    } catch (_) { persistent = false; }
    const snapshot = () => JSON.parse(JSON.stringify(data));
    function save() {
      if (!storage) return;
      try { storage.setItem(key, JSON.stringify(data)); persistent = true; }
      catch (_) { persistent = false; }
    }
    function select(index) {
      if (!Number.isInteger(index) || index < 0 || index > data.unlocked) return false;
      data.lastStage = index; save(); return true;
    }
    function recordClear(index, record) {
      if (!Number.isInteger(index) || index < 0 || index >= levelCount || index > data.unlocked || !record || !['rules', 'shards', 'time'].every(name => Number.isFinite(record[name]) && record[name] >= 0)) return false;
      const old = data.best[index];
      data.best[index] = {
        rules: Math.min(old?.rules ?? Infinity, Math.floor(record.rules)),
        shards: Math.max(old?.shards ?? 0, Math.min(2, Math.floor(record.shards))),
        time: Math.min(old?.time ?? Infinity, record.time)
      };
      data.unlocked = Math.min(levelCount - 1, Math.max(data.unlocked, index + 1));
      save(); return true;
    }
    return { snapshot, select, recordClear, get persistent() { return persistent; } };
  }
  const api = { createStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldDefinitionProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
