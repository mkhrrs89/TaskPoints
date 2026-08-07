(function installTaskPointsStateHotCache(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__stateHotCacheInstalled || typeof core.loadAppState !== 'function') return;
  core.__stateHotCacheInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const JOURNAL_KEY = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const REVISION_KEY = 'taskpoints_state_revision_v1';
  const TRACKED_KEYS = new Set([STORAGE_KEY, JOURNAL_KEY]);
  const originalLoad = core.loadAppState;
  let generation = 0;
  const cachedByMode = new Map();
  let hits = 0;
  let misses = 0;
  let invalidations = 0;
  let defaultHits = 0;
  let readOnlyHits = 0;

  const clone = (value) => {
    if (typeof global.structuredClone === 'function') return global.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  };

  function readSmall(key) {
    try { return storage.getItem(key) || ''; }
    catch (_) { return ''; }
  }

  function revisionToken() {
    return `${generation}|${readSmall(REVISION_KEY)}`;
  }

  function invalidate() {
    generation += 1;
    cachedByMode.clear();
    invalidations += 1;
  }

  function cacheMode(args) {
    if (args.length === 0) return 'default';
    if (args.length !== 1) return '';
    const options = args[0];
    if (!options || typeof options !== 'object' || Array.isArray(options)) return '';
    const keys = Object.keys(options);
    if (keys.some((key) => key !== 'syncDerived' && key !== 'persistSync')) return '';
    return options.syncDerived === false && options.persistSync === false ? 'read-only' : '';
  }

  function cloneResult(result) {
    if (!result || typeof result !== 'object') return result;
    try { return clone(result); }
    catch (_) { return null; }
  }

  core.loadAppState = function taskPointsHotCachedLoadAppState(...args) {
    const mode = cacheMode(args);
    if (!mode) return originalLoad.apply(core, args);

    const token = revisionToken();
    const cached = cachedByMode.get(mode) || null;
    if (cached && cached.token === token) {
      const copy = cloneResult(cached.result);
      if (copy !== null) {
        hits += 1;
        if (mode === 'default') defaultHits += 1;
        if (mode === 'read-only') readOnlyHits += 1;
        return copy;
      }
      cachedByMode.delete(mode);
    }

    misses += 1;
    const result = originalLoad.apply(core, args);
    const postToken = revisionToken();
    const snapshot = cloneResult(result);
    if (snapshot !== null) cachedByMode.set(mode, { token: postToken, result: snapshot });
    return result;
  };

  function installStorageInvalidation() {
    // Phase 2 may already have instance-level Storage wrappers. Wrap whatever
    // methods are active now so a successful authoritative write invalidates
    // this cache regardless of whether the browser uses instance or prototype
    // dispatch for Storage methods.
    try {
      if (!storage.__taskPointsStateHotCacheInstanceHooks) {
        const priorSet = storage.setItem.bind(storage);
        const priorRemove = storage.removeItem.bind(storage);
        const guardedSet = function taskPointsHotCacheInstanceSetItem(key, value) {
          const tracked = TRACKED_KEYS.has(String(key));
          const result = priorSet(key, value);
          if (tracked) invalidate();
          return result;
        };
        const guardedRemove = function taskPointsHotCacheInstanceRemoveItem(key) {
          const tracked = TRACKED_KEYS.has(String(key));
          const result = priorRemove(key);
          if (tracked) invalidate();
          return result;
        };
        storage.setItem = guardedSet;
        storage.removeItem = guardedRemove;
        if (storage.setItem === guardedSet && storage.removeItem === guardedRemove) {
          Object.defineProperty(storage, '__taskPointsStateHotCacheInstanceHooks', { value: true, configurable: true });
          return;
        }
      } else return;
    } catch (_) {}

    const prototype = global.Storage?.prototype;
    if (!prototype || prototype.__taskPointsStateHotCacheHooks) return;
    try {
      Object.defineProperty(prototype, '__taskPointsStateHotCacheHooks', { value: true, configurable: true });
    } catch (_) { return; }

    if (typeof prototype.setItem === 'function') {
      const priorSet = prototype.setItem;
      prototype.setItem = function taskPointsHotCacheSetItem(key, value) {
        const tracked = this === storage && TRACKED_KEYS.has(String(key));
        const result = priorSet.apply(this, arguments);
        if (tracked) invalidate();
        return result;
      };
    }

    if (typeof prototype.removeItem === 'function') {
      const priorRemove = prototype.removeItem;
      prototype.removeItem = function taskPointsHotCacheRemoveItem(key) {
        const tracked = this === storage && TRACKED_KEYS.has(String(key));
        const result = priorRemove.apply(this, arguments);
        if (tracked) invalidate();
        return result;
      };
    }
  }

  installStorageInvalidation();
  global.addEventListener?.('storage', (event) => {
    if (event?.storageArea && event.storageArea !== storage) return;
    if (event?.key === null || TRACKED_KEYS.has(String(event?.key || ''))) invalidate();
  });
  global.addEventListener?.('taskpoints:state-revision', invalidate);

  core.clearStateHotCache = invalidate;
  core.getStateHotCacheStatus = () => ({
    installed: true,
    cacheReady: cachedByMode.size > 0,
    cachedModes: Array.from(cachedByMode.keys()),
    generation,
    hits,
    defaultHits,
    readOnlyHits,
    misses,
    invalidations
  });
})(typeof window !== 'undefined' ? window : globalThis);
