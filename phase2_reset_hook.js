(function installTaskPointsPhase2ResetHook(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core?.queueShadowDualWrite || !storage || global.__taskPointsPhase2ResetHookInstalled) return;

  function scheduleEmptySnapshotWhenStillRemoved(key) {
    const run = () => {
      try {
        // safeReplaceTaskPointsStorage temporarily removes the key before a
        // synchronous replacement write. Wait one microtask so that path does
        // not enqueue a false reset. The explicit Reset All flow leaves it
        // absent, so only that confirmed authoritative removal is mirrored.
        if (storage.getItem(key) === null) {
          const operation = core.queueShadowDualWrite({}, { reset: true });
          operation?.catch?.((error) => {
            console.warn('TaskPointsCore: shadow reset failed; localStorage remains authoritative.', error);
          });
        }
      } catch (error) {
        console.warn('TaskPointsCore: could not mirror the confirmed localStorage reset.', error);
      }
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(run);
    else Promise.resolve().then(run);
  }

  const StorageCtor = global.Storage;
  if (StorageCtor?.prototype?.removeItem) {
    const prototype = StorageCtor.prototype;
    if (prototype.__taskPointsPhase2OriginalRemoveItem) return;
    const original = prototype.removeItem;
    Object.defineProperty(prototype, '__taskPointsPhase2OriginalRemoveItem', {
      value: original,
      configurable: true
    });
    prototype.removeItem = function taskPointsPhase2RemoveItem(key) {
      const normalizedKey = String(key);
      const matched = this === storage && normalizedKey === core.STORAGE_KEY;
      const result = original.call(this, normalizedKey);
      if (matched) scheduleEmptySnapshotWhenStillRemoved(normalizedKey);
      return result;
    };
  } else if (typeof storage.removeItem === 'function') {
    const original = storage.removeItem.bind(storage);
    storage.removeItem = function taskPointsPhase2RemoveItem(key) {
      const normalizedKey = String(key);
      const result = original(normalizedKey);
      if (normalizedKey === core.STORAGE_KEY) scheduleEmptySnapshotWhenStillRemoved(normalizedKey);
      return result;
    };
  }

  global.__taskPointsPhase2ResetHookInstalled = true;
})(typeof window !== 'undefined' ? window : globalThis);
