(function installTaskPointsPhase4PrimaryReadPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase4PrimaryReadPathInstalled || typeof core.loadAppState !== 'function') return;
  core.__phase4PrimaryReadPathInstalled = true;

  const ORIGINAL_LOAD = core.loadAppState;
  const ORIGINAL_SET_MODE = core.setPhase4StorageMode;
  const DIAGNOSTICS_KEY = core.PHASE4_DIAGNOSTICS_KEY || 'taskpoints_phase4_diagnostics_v1';
  let servingPrimary = false;

  function nowIso() { return new Date().toISOString(); }
  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; }
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
  function clearCache() { return core.clearPhase4Caches?.() ?? true; }
  function journalCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; } catch (_) { return 1; }
  }
  function summariesMatch(mirrorState, primaryState, primaryCache) {
    try {
      const mirrorSummary = core.shadowSourceSummary(mirrorState);
      const primarySummary = core.shadowSourceSummary(primaryState);
      const mismatch = core.shadowVerificationMismatches(mirrorSummary, primarySummary) || [];
      return primaryCache?.status === 'passed_verification'
        && mirrorSummary.hashes.state === primarySummary.hashes.state
        && primaryCache.sourceHash === mirrorSummary.hashes.state
        && primaryCache.destinationHash === primarySummary.hashes.state
        && mismatch.length === 0
        && core.shadowCanonicalJson(mirrorState) === core.shadowCanonicalJson(primaryState);
    } catch (_) { return false; }
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
      return ORIGINAL_LOAD.apply(core, args);
    }
    let mirrorState;
    try { mirrorState = core.parseTaskPointsStorageJson(mirrorRaw, {}) || {}; }
    catch (_) {
      clearCache();
      recordFallback('mirror_parse_failed');
      return ORIGINAL_LOAD.apply(core, args);
    }
    if (primaryCache.mirrorRaw !== mirrorRaw || !summariesMatch(mirrorState, primaryCache.state, primaryCache)) {
      clearCache();
      recordFallback('mirror_mismatch');
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
        primaryCache.serializedState || JSON.stringify(primaryCache.state || {}),
        () => ORIGINAL_LOAD.call(core, primaryOptions)
      );
      const mirrorAfter = safeGet(core.STORAGE_KEY);
      const journalAfter = safeGet(core.PENDING_HABIT_DELTAS_KEY);
      if (attempt.journalChanged || journalAfter !== journalRaw) {
        clearCache();
        recordFallback('journal_changed_during_primary_read');
        return ORIGINAL_LOAD.apply(core, args);
      }
      if (attempt.mirrorChanged || !attempt.usedPrimary || mirrorAfter !== mirrorRaw) {
        clearCache();
        recordFallback('mirror_changed_during_primary_read');
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
      return ORIGINAL_LOAD.apply(core, args);
    } finally { servingPrimary = false; }
  }

  core.loadAppState = function phase4LoadAppState(...args) { return loadWithPolicy(args); };
  if (typeof ORIGINAL_SET_MODE === 'function') {
    core.setPhase4StorageMode = function phase4SetStorageMode(mode) {
      const next = ORIGINAL_SET_MODE.call(core, mode);
      if (next === 'off') clearCache();
      return next;
    };
  }

  global.addEventListener?.('storage', (event) => {
    if (event?.storageArea && event.storageArea !== global.localStorage) return;
    if ([core.STORAGE_KEY, core.PENDING_HABIT_DELTAS_KEY, core.PHASE4_STORAGE_MODE_KEY].includes(event?.key)) clearCache();
  });
})(typeof window !== 'undefined' ? window : globalThis);
