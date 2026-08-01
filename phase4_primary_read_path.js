(function installTaskPointsPhase4PrimaryReadPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase4PrimaryReadPathInstalled || typeof core.loadAppState !== 'function') return;
  core.__phase4PrimaryReadPathInstalled = true;

  const ORIGINAL_LOAD = core.loadAppState;
  const ORIGINAL_SET_MODE = core.setPhase4StorageMode;
  const ORIGINAL_GET_STATUS = core.getPhase4StorageStatus;
  const DIAGNOSTICS_KEY = core.PHASE4_DIAGNOSTICS_KEY || 'taskpoints_phase4_diagnostics_v1';
  const SESSION_CACHE_KEY = core.PHASE4_SESSION_CACHE_KEY || 'taskpoints_phase4_verified_primary_cache_v1';
  let servingPrimary = false;
  let warmupPromise = null;
  let warmupScheduled = false;

  function nowIso() { return new Date().toISOString(); }
  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; }
  }
  function safeSessionGet() {
    try { return global.sessionStorage?.getItem?.(SESSION_CACHE_KEY) ?? null; } catch (_) { return null; }
  }
  function clearSessionCache() {
    try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
  }
  function readDiagnostics() {
    try {
      const value = JSON.parse(safeGet(DIAGNOSTICS_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }
  function writeDiagnostics(patch = {}) {
    const previous = readDiagnostics();
    const next = {
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      configuredMode: core.getPhase4StorageMode?.() || 'off',
      effectiveSource: previous.effectiveSource || 'localStorage',
      indexedDbReadsTotal: Number(previous.indexedDbReadsTotal) || 0,
      fallbackReadsTotal: Number(previous.fallbackReadsTotal) || 0,
      ...previous,
      ...patch
    };
    try { global.localStorage?.setItem?.(DIAGNOSTICS_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }
  function cache() { return core.getPhase4VerifiedPrimaryCache?.() || null; }
  function clearCache() {
    warmupScheduled = false;
    try { return core.clearPhase4Caches?.() ?? true; } catch (_) { clearSessionCache(); return true; }
  }
  function journalCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; } catch (_) { return 1; }
  }
  function verifiedCacheRecordIsUsable(primaryCache) {
    if (!primaryCache || typeof primaryCache !== 'object' || Array.isArray(primaryCache)) return false;
    if (primaryCache.status !== 'passed_verification') return false;
    if (!Number.isFinite(Number(primaryCache.sequence)) || Number(primaryCache.sequence) < 1) return false;
    if (!primaryCache.state || typeof primaryCache.state !== 'object' || Array.isArray(primaryCache.state)) return false;
    if (primaryCache.sourceHash && primaryCache.destinationHash
      && primaryCache.sourceHash !== primaryCache.destinationHash) return false;
    return true;
  }
  function cacheSerializedState(primaryCache) {
    if (typeof primaryCache?.serializedState === 'string') return primaryCache.serializedState;
    return typeof primaryCache?.mirrorRaw === 'string' ? primaryCache.mirrorRaw : null;
  }
  function cacheMatchesMirror(primaryCache, mirrorRaw) {
    if (!verifiedCacheRecordIsUsable(primaryCache) || mirrorRaw === null) return false;
    // The cache was fully verified when it was created. During ordinary reads,
    // compare the exact saved bytes instead of reparsing, rehashing, and
    // canonicalizing the entire application state again. Native Phase 5A
    // caches intentionally omit serializedState, so their verified mirrorRaw
    // is the exact byte source used by the fallback reader.
    if (primaryCache.mirrorRaw !== mirrorRaw || cacheSerializedState(primaryCache) !== mirrorRaw) return false;
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) return false;
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) return false;
    if (journalCount() > 0) return false;
    return true;
  }
  function validateSessionRecord(record, mirrorRaw) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.schemaVersion !== 1 || record.status !== 'passed_verification') return null;
    if (!record.state || typeof record.state !== 'object' || Array.isArray(record.state)) return null;
    if (!Number.isFinite(Number(record.sequence)) || Number(record.sequence) < 1) return null;
    const candidate = {
      ...record,
      sequence: Number(record.sequence),
      serializedState: typeof record.serializedState === 'string'
        ? record.serializedState
        : JSON.stringify(record.state),
      restoredFromSession: true
    };
    return cacheMatchesMirror(candidate, mirrorRaw) ? candidate : null;
  }
  function restoreSessionCache() {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return false;
    const raw = safeSessionGet();
    if (raw === null) return false;
    let record = null;
    try { record = JSON.parse(raw); } catch (_) { record = null; }
    const restored = validateSessionRecord(record, safeGet(core.STORAGE_KEY));
    if (!restored) {
      clearCache();
      return false;
    }
    core.setPhase4VerifiedPrimaryCache?.(restored, { persist: false });
    writeDiagnostics({
      configuredMode: 'indexeddb_primary',
      effectiveSource: 'indexedDB_ready',
      lastFallbackReason: null,
      cacheRestoredFromSession: true
    });
    return true;
  }
  function recordFallback(reason) {
    const previous = readDiagnostics();
    writeDiagnostics({
      configuredMode: core.getPhase4StorageMode?.() || 'off',
      effectiveSource: 'localStorage',
      lastFallbackAt: nowIso(),
      lastFallbackReason: reason,
      fallbackReadsTotal: (Number(previous.fallbackReadsTotal) || 0) + 1
    });
  }

  async function warmPrimaryCache(reason = 'primary_cache_warmup') {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return false;
    const mirrorRaw = safeGet(core.STORAGE_KEY);
    if (cacheMatchesMirror(cache(), mirrorRaw)) {
      writeDiagnostics({ effectiveSource: 'indexedDB_ready', lastFallbackReason: null });
      return true;
    }
    if (restoreSessionCache() && cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY))) return true;
    if (warmupPromise) return warmupPromise;

    let restoreFailureReason = null;
    warmupPromise = Promise.resolve()
      .then(() => core.restorePhase4CommittedPrimary?.({ reason }))
      .then((outcome) => {
        if (outcome?.restored === true && cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY))) return true;
        restoreFailureReason = outcome?.reason || null;
        return Promise.resolve(core.queuePhase4PrimaryWrite?.({ reason }))
          .then(() => core.flushPhase4PrimaryWrites?.())
          .then(() => cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)));
      })
      .then((ready) => {
        const currentStatus = core.getPhase4StorageStatus?.() || {};
        const specificFailure = currentStatus.lastFallbackReason && currentStatus.lastFallbackReason !== 'cache_not_ready'
          ? currentStatus.lastFallbackReason
          : restoreFailureReason;
        writeDiagnostics({
          effectiveSource: ready ? 'indexedDB_ready' : 'localStorage',
          lastFallbackReason: ready ? null : (specificFailure || 'cache_warmup_failed'),
          cacheWarmupFailureDetail: ready ? null : (specificFailure || 'cache_warmup_failed')
        });
        return ready;
      })
      .catch((error) => {
        const currentStatus = core.getPhase4StorageStatus?.() || {};
        const specificFailure = currentStatus.lastFallbackReason || restoreFailureReason || error?.message || 'cache_warmup_failed';
        writeDiagnostics({
          effectiveSource: 'localStorage',
          lastFallbackReason: specificFailure,
          cacheWarmupFailureDetail: specificFailure
        });
        return false;
      })
      .finally(() => { warmupPromise = null; });
    return warmupPromise;
  }
  function schedulePrimaryWarmup(reason = 'cache_not_ready') {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary' || warmupScheduled || warmupPromise) return;
    if (global.document?.visibilityState === 'hidden') return;
    warmupScheduled = true;
    const schedule = typeof global.queueMicrotask === 'function'
      ? global.queueMicrotask.bind(global)
      : (callback) => Promise.resolve().then(callback);
    schedule(() => {
      warmupScheduled = false;
      warmPrimaryCache(reason);
    });
  }

  function withTemporaryPrimary(expectedMirrorRaw, expectedJournalRaw, serializedState, callback) {
    const storage = global.localStorage;
    if (!storage || typeof storage.getItem !== 'function') {
      return { result: callback(), usedPrimary: false, mirrorChanged: true, journalChanged: true };
    }
    let usedPrimary = false;
    let mirrorChanged = false;
    let journalChanged = false;
    const substitute = (readLive, key) => {
      const normalized = String(key);
      if (normalized === core.STORAGE_KEY) {
        const live = readLive();
        if (live === expectedMirrorRaw) { usedPrimary = true; return serializedState; }
        mirrorChanged = true;
        return live;
      }
      if (normalized === core.PENDING_HABIT_DELTAS_KEY) {
        const live = readLive();
        if (live === expectedJournalRaw) return expectedJournalRaw;
        journalChanged = true;
        return null;
      }
      return readLive();
    };

    const StorageCtor = global.Storage;
    if (StorageCtor?.prototype?.getItem) {
      const prototype = StorageCtor.prototype;
      const original = prototype.getItem;
      prototype.getItem = function phase4PrimaryGetItem(key) {
        if (this !== global.localStorage) return original.call(this, key);
        return substitute(() => original.call(this, key), key);
      };
      try {
        const result = callback();
        return { result, usedPrimary, mirrorChanged, journalChanged };
      } finally { prototype.getItem = original; }
    }

    const original = storage.getItem;
    storage.getItem = function phase4PrimaryGetItem(key) {
      return substitute(() => original.call(storage, key), key);
    };
    try {
      const result = callback();
      return { result, usedPrimary, mirrorChanged, journalChanged };
    } finally { storage.getItem = original; }
  }

  function loadWithPolicy(args) {
    const mode = core.getPhase4StorageMode?.() || 'off';
    if (servingPrimary || mode !== 'indexeddb_primary') return ORIGINAL_LOAD.apply(core, args);

    const mirrorRaw = safeGet(core.STORAGE_KEY);
    if (mirrorRaw === null) {
      clearCache();
      recordFallback('authoritative_missing');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) {
      recordFallback('dual_write_pending');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) {
      recordFallback('phase4_write_pending');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if (journalCount() > 0) {
      recordFallback('pending_habit_journal');
      return ORIGINAL_LOAD.apply(core, args);
    }

    const primaryCache = cache();
    if (!primaryCache) {
      recordFallback('cache_not_ready');
      schedulePrimaryWarmup('cache_not_ready');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if (!cacheMatchesMirror(primaryCache, mirrorRaw)) {
      clearCache();
      recordFallback('mirror_mismatch');
      schedulePrimaryWarmup('mirror_mismatch');
      return ORIGINAL_LOAD.apply(core, args);
    }

    const journalRaw = safeGet(core.PENDING_HABIT_DELTAS_KEY);
    servingPrimary = true;
    try {
      const originalOptions = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : null;
      const primaryOptions = originalOptions ? { ...originalOptions, persistSync: false } : { persistSync: false };
      const attempt = withTemporaryPrimary(
        mirrorRaw,
        journalRaw,
        cacheSerializedState(primaryCache),
        () => ORIGINAL_LOAD.call(core, primaryOptions)
      );
      const mirrorAfter = safeGet(core.STORAGE_KEY);
      const journalAfter = safeGet(core.PENDING_HABIT_DELTAS_KEY);
      if (attempt.journalChanged || journalAfter !== journalRaw) {
        clearCache();
        recordFallback('journal_changed_during_primary_read');
        schedulePrimaryWarmup('journal_changed_during_primary_read');
        return ORIGINAL_LOAD.apply(core, args);
      }
      if (attempt.mirrorChanged || !attempt.usedPrimary || mirrorAfter !== mirrorRaw) {
        clearCache();
        recordFallback('mirror_changed_during_primary_read');
        schedulePrimaryWarmup('mirror_changed_during_primary_read');
        return ORIGINAL_LOAD.apply(core, args);
      }
      const previous = readDiagnostics();
      writeDiagnostics({
        configuredMode: mode,
        effectiveSource: 'indexedDB',
        lastIndexedDbReadAt: nowIso(),
        lastFallbackReason: null,
        indexedDbReadsTotal: (Number(previous.indexedDbReadsTotal) || 0) + 1
      });
      return attempt.result;
    } catch (_) {
      clearCache();
      recordFallback('primary_read_exception');
      schedulePrimaryWarmup('primary_read_exception');
      return ORIGINAL_LOAD.apply(core, args);
    } finally { servingPrimary = false; }
  }

  core.loadAppState = function phase4LoadAppState(...args) { return loadWithPolicy(args); };
  if (typeof ORIGINAL_GET_STATUS === 'function') {
    core.getPhase4StorageStatus = function phase4PrimaryGetStatus(...args) {
      const value = ORIGINAL_GET_STATUS.apply(core, args) || {};
      return {
        ...value,
        sessionCachePresent: safeSessionGet() !== null,
        cacheRestoredFromSession: Boolean(cache()?.restoredFromSession),
        cacheWarmupPending: Boolean(warmupPromise || warmupScheduled)
      };
    };
  }
  if (typeof ORIGINAL_SET_MODE === 'function') {
    core.setPhase4StorageMode = function phase4SetStorageMode(mode) {
      const next = ORIGINAL_SET_MODE.call(core, mode);
      if (next === 'off') {
        clearCache();
      } else if (next === 'indexeddb_primary') {
        const mirrorRaw = safeGet(core.STORAGE_KEY);
        if (cacheMatchesMirror(cache(), mirrorRaw)) {
          writeDiagnostics({ effectiveSource: 'indexedDB_ready', lastFallbackReason: null });
        } else if (!restoreSessionCache()) {
          schedulePrimaryWarmup('mode_changed');
        }
      }
      return next;
    };
  }

  core.restorePhase4PrimaryCache = restoreSessionCache;
  core.warmPhase4PrimaryCache = warmPrimaryCache;

  global.addEventListener?.('storage', (event) => {
    if (event?.storageArea && event.storageArea !== global.localStorage) return;
    if (![core.STORAGE_KEY, core.PENDING_HABIT_DELTAS_KEY, core.PHASE4_STORAGE_MODE_KEY].includes(event?.key)) return;
    clearCache();
    if ((core.getPhase4StorageMode?.() || 'off') === 'indexeddb_primary') schedulePrimaryWarmup('storage_changed');
  });
  global.addEventListener?.('pageshow', () => {
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return;
    if (!cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)) && !restoreSessionCache()) {
      schedulePrimaryWarmup('pageshow');
    }
  });
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document.visibilityState !== 'visible') return;
    if ((core.getPhase4StorageMode?.() || 'off') !== 'indexeddb_primary') return;
    if (!cacheMatchesMirror(cache(), safeGet(core.STORAGE_KEY)) && !restoreSessionCache()) {
      schedulePrimaryWarmup('visibility_restored');
    }
  });

  if ((core.getPhase4StorageMode?.() || 'off') === 'indexeddb_primary') {
    if (!restoreSessionCache()) schedulePrimaryWarmup('module_install');
  }
})(typeof window !== 'undefined' ? window : globalThis);
