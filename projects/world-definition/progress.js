/* Clear records stay on this device; unavailable storage never blocks play. */
'use strict';
(function (root) {
  function createStore(storage, levelCount, key = 'world-definition-progress-v1') {
    let persistent = Boolean(storage);
    const blank = () => ({ unlocked: 0, lastStage: 0, best: {} });
    let data = blank();
    try {
      const saved = JSON.parse(storage?.getItem(key) || 'null');
      if (saved && typeof saved === 'object' && Number.isInteger(saved.unlocked)) {
        data.unlocked = Math.max(0, Math.min(levelCount - 1, saved.unlocked));
        data.lastStage = Number.isInteger(saved.lastStage) ? Math.max(0, Math.min(data.unlocked, saved.lastStage)) : 0;
        for (let index = 0; index < levelCount; index++) {
          const best = saved.best?.[index];
          if (best && ['rules', 'shards', 'time'].every(name => Number.isFinite(best[name]) && best[name] >= 0)) {
            data.best[index] = { rules: Math.floor(best.rules), shards: Math.min(2, Math.floor(best.shards)), time: best.time };
          }
        }
        // v1.1 ended at stage 5. A recorded final clear also opens the new chapter.
        if (levelCount > 5 && data.unlocked === 4 && data.best[4]) data.unlocked = 5;
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
