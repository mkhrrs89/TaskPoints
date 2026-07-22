(function installTaskPointsPhase3NavigationCache(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase3NavigationCacheInstalled || typeof core.loadAppState !== 'function') return;
  const requiredPhase3Apis = [
    'getPhase3ReadMode',
    'getPhase3ReadStatus',
    'refreshPhase3ReadCache',
    'setPhase3ReadMode',
    'clearPhase3ReadCache',
    'readPhase3ShadowSnapshot'
  ];
  if (requiredPhase3Apis.some((name) => typeof core[name] !== 'function')) return;
  core.__phase3NavigationCacheInstalled = true;

  const MODE_KEY = core.PHASE3_READ_MODE_KEY || 'taskpoints_phase3_read_mode_v1';
  const DIAGNOSTICS_KEY = core.PHASE3_READ_DIAGNOSTICS_KEY || 'taskpoints_phase3_read_diagnostics_v1';
  const SESSION_CACHE_KEY = 'taskpoints_phase3_verified_session_cache_v1';
  const VERIFIED_MODE = 'verified_indexeddb';
  const PHASE3_LOAD_APP_STATE = core.loadAppState;
  const PHASE3_GET_STATUS = core.getPhase3ReadStatus;
  const PHASE3_REFRESH_CACHE = core.refreshPhase3ReadCache;
  const PHASE3_SET_MODE = core.setPhase3ReadMode;
  const PHASE3_CLEAR_CACHE = core.clearPhase3ReadCache;
  const PHASE3_TEST_READ = core.testPhase3VerifiedRead;

  let navigationCache = null;
  let sessionRestoreMismatchPending = false;
  let servingFromNavigationCache = false;
  let refreshScheduled = false;
  let refreshPromise = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function safeLocalGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; }
  }

  function safeSessionGet() {
    try { return global.sessionStorage?.getItem?.(SESSION_CACHE_KEY) ?? null; } catch (_) { return null; }
  }

  function clearSessionCache() {
    try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
  }

  function clearNavigationCache() {
    navigationCache = null;
    clearSessionCache();
  }

  function handleModeStorageEvent(event) {
    if (event?.storageArea && event.storageArea !== global.localStorage) return;
    if (event?.key !== MODE_KEY && event?.key !== null) return;
    const observedMode = event?.key === MODE_KEY ? event.newValue : core.getPhase3ReadMode();
    if (observedMode !== VERIFIED_MODE) {
      clearNavigationCache();
      sessionRestoreMismatchPending = false;
    }
  }

  function readDiagnostics() {
    try {
      const raw = global.localStorage?.getItem?.(DIAGNOSTICS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeDiagnostics(patch = {}) {
    const previous = readDiagnostics();
    const next = {
      schemaVersion: 1,
      phase: 'read_path',
      configuredMode: core.getPhase3ReadMode(),
      status: previous.status || 'off',
      comparePassesTotal: Number(previous.comparePassesTotal) || 0,
      compareFailuresTotal: Number(previous.compareFailuresTotal) || 0,
      indexedDbReadsTotal: Number(previous.indexedDbReadsTotal) || 0,
      fallbackReadsTotal: Number(previous.fallbackReadsTotal) || 0,
      ...previous,
      ...patch
    };
    try { global.localStorage?.setItem?.(DIAGNOSTICS_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }

  function canonicalEqual(left, right) {
    return core.shadowCanonicalJson(left) === core.shadowCanonicalJson(right);
  }

  function summariesMatch(sourceState, destinationState, sourceSummary, destinationSummary) {
    const countsMatch = canonicalEqual(sourceSummary.counts, destinationSummary.counts);
    const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
    const sourceLayout = core.shadowSourceLayout(sourceState);
    const destinationLayout = core.shadowSourceLayout(destinationState);
    const canonicalMatch = canonicalEqual(
      { arrays: sourceLayout.arrays, collections: sourceLayout.collections, values: sourceLayout.values },
      { arrays: destinationLayout.arrays, collections: destinationLayout.collections, values: destinationLayout.values }
    );
    const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary);
    return { countsMatch, hashesMatch, canonicalMatch, mismatches };
  }

  function pendingHabitCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; } catch (_) { return 1; }
  }

  function validateRecord(record, authoritativeRaw) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== 1) return null;
    if (!record.state || typeof record.state !== 'object' || Array.isArray(record.state)) return null;
    if (authoritativeRaw === null) return null;
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0 || pendingHabitCount() > 0) return null;

    let authoritativeState;
    try { authoritativeState = core.parseTaskPointsStorageJson(authoritativeRaw, {}) || {}; } catch (_) { return null; }
    const destinationState = record.state;
    const sourceSummary = core.shadowSourceSummary(authoritativeState);
    const destinationSummary = core.shadowSourceSummary(destinationState);
    const comparison = summariesMatch(authoritativeState, destinationState, sourceSummary, destinationSummary);
    if (!comparison.countsMatch || !comparison.hashesMatch || !comparison.canonicalMatch || comparison.mismatches.length) return null;
    if (record.sourceHash !== sourceSummary.hashes.state || record.destinationHash !== destinationSummary.hashes.state) return null;
    if (!canonicalEqual(record.sourceCounts, sourceSummary.counts) || !canonicalEqual(record.destinationCounts, destinationSummary.counts)) return null;

    let serializedState;
    try { serializedState = JSON.stringify(destinationState); } catch (_) { return null; }
    return {
      authoritativeRaw,
      serializedState,
      sourceHash: sourceSummary.hashes.state,
      destinationHash: destinationSummary.hashes.state,
      sourceCounts: sourceSummary.counts,
      destinationCounts: destinationSummary.counts,
      verifiedAt: typeof record.verifiedAt === 'string' ? record.verifiedAt : nowIso(),
      restoredFromSession: true
    };
  }

  function restoreSessionCache() {
    if (core.getPhase3ReadMode() !== VERIFIED_MODE) {
      clearNavigationCache();
      return false;
    }
    const rawRecord = safeSessionGet();
    if (rawRecord === null) return false;
    let record;
    try { record = JSON.parse(rawRecord); } catch (_) { record = null; }
    let restored = null;
    try { restored = validateRecord(record, safeLocalGet(core.STORAGE_KEY)); } catch (_) { restored = null; }
    if (!restored) {
      clearNavigationCache();
      sessionRestoreMismatchPending = true;
      return false;
    }
    navigationCache = restored;
    sessionRestoreMismatchPending = false;
    return true;
  }

  function persistSessionRecord(state, cache) {
    const record = {
      schemaVersion: 1,
      state,
      sourceHash: cache.sourceHash,
      destinationHash: cache.destinationHash,
      sourceCounts: cache.sourceCounts,
      destinationCounts: cache.destinationCounts,
      verifiedAt: cache.verifiedAt
    };
    try {
      global.sessionStorage?.setItem?.(SESSION_CACHE_KEY, JSON.stringify(record));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function rebuildNavigationCache() {
    if (core.getPhase3ReadMode() !== VERIFIED_MODE || typeof core.readPhase3ShadowSnapshot !== 'function') {
      clearNavigationCache();
      return false;
    }
    const authoritativeRawBefore = safeLocalGet(core.STORAGE_KEY);
    if (authoritativeRawBefore === null) {
      clearNavigationCache();
      return false;
    }
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0 || pendingHabitCount() > 0) {
      clearNavigationCache();
      return false;
    }

    try {
      const snapshot = await core.readPhase3ShadowSnapshot();
      const authoritativeRawAfter = safeLocalGet(core.STORAGE_KEY);
      if (authoritativeRawAfter === null || authoritativeRawAfter !== authoritativeRawBefore) throw new Error('authoritative_changed');
      if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0 || pendingHabitCount() > 0) throw new Error('pending_write');
      if (snapshot?.currentMetadata?.status !== 'passed_verification') throw new Error('phase1_not_verified');
      if (snapshot?.dualWriteMetadata?.status !== 'passed_verification') throw new Error('dual_write_not_verified');

      const authoritativeState = core.parseTaskPointsStorageJson(authoritativeRawBefore, {}) || {};
      const destinationState = snapshot.state || {};
      const sourceSummary = core.shadowSourceSummary(authoritativeState);
      const destinationSummary = core.shadowSourceSummary(destinationState);
      const comparison = summariesMatch(authoritativeState, destinationState, sourceSummary, destinationSummary);
      if (!comparison.countsMatch || !comparison.hashesMatch || !comparison.canonicalMatch || comparison.mismatches.length) throw new Error('state_mismatch');
      const dualSourceHash = snapshot.dualWriteMetadata?.verification?.source?.hashes?.state;
      const dualDestinationHash = snapshot.dualWriteMetadata?.verification?.destination?.hashes?.state;
      if (dualSourceHash !== sourceSummary.hashes.state || dualDestinationHash !== destinationSummary.hashes.state) throw new Error('dual_hash_mismatch');

      const cache = {
        authoritativeRaw: authoritativeRawBefore,
        serializedState: JSON.stringify(destinationState),
        sourceHash: sourceSummary.hashes.state,
        destinationHash: destinationSummary.hashes.state,
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        verifiedAt: nowIso(),
        restoredFromSession: false
      };
      navigationCache = cache;
      sessionRestoreMismatchPending = false;
      persistSessionRecord(destinationState, cache);
      return true;
    } catch (_) {
      clearNavigationCache();
      return false;
    }
  }

  function scheduleNavigationRefresh(reason = 'navigation_cache_not_ready') {
    if (core.getPhase3ReadMode() !== VERIFIED_MODE || refreshScheduled || refreshPromise) return;
    refreshScheduled = true;
    const schedule = typeof global.queueMicrotask === 'function'
      ? global.queueMicrotask.bind(global)
      : (callback) => Promise.resolve().then(callback);
    schedule(() => {
      refreshScheduled = false;
      refreshPromise = Promise.resolve(PHASE3_REFRESH_CACHE?.call(core, { force: true, reason }))
        .then(() => rebuildNavigationCache())
        .catch(() => false)
        .finally(() => { refreshPromise = null; });
    });
  }

  function recordFallback(reason) {
    const previous = readDiagnostics();
    writeDiagnostics({
      configuredMode: core.getPhase3ReadMode(),
      status: previous.status === 'ready' ? 'ready' : (previous.status || 'warming'),
      effectiveSource: 'localStorage',
      lastFallbackAt: nowIso(),
      lastFallbackReason: reason,
      fallbackReadsTotal: (Number(previous.fallbackReadsTotal) || 0) + 1
    });
  }

  function withTemporaryReads(replacements, callback) {
    const storage = global.localStorage;
    if (!storage || typeof storage.getItem !== 'function') return { result: callback(), changed: true, usedState: false };
    let changed = false;
    let usedState = false;
    const substitute = (readLive, key) => {
      const normalized = String(key);
      if (normalized === MODE_KEY) return 'off';
      if (normalized === core.STORAGE_KEY && Object.prototype.hasOwnProperty.call(replacements, 'stateRaw')) {
        const live = readLive();
        if (live !== replacements.expectedAuthoritativeRaw) {
          changed = true;
          return live;
        }
        usedState = true;
        return replacements.stateRaw;
      }
      if (normalized === core.PENDING_HABIT_DELTAS_KEY && Object.prototype.hasOwnProperty.call(replacements, 'journalRaw')) {
        const live = readLive();
        if (live !== replacements.expectedJournalRaw) {
          changed = true;
          return null;
        }
        return replacements.journalRaw;
      }
      return readLive();
    };

    const StorageCtor = global.Storage;
    if (StorageCtor?.prototype?.getItem) {
      const prototype = StorageCtor.prototype;
      const original = prototype.getItem;
      prototype.getItem = function phase3NavigationGetItem(key) {
        if (this !== global.localStorage) return original.call(this, key);
        return substitute(() => original.call(this, key), key);
      };
      try { return { result: callback(), changed, usedState }; }
      finally { prototype.getItem = original; }
    }

    const original = storage.getItem;
    storage.getItem = function phase3NavigationGetItem(key) {
      return substitute(() => original.call(storage, key), key);
    };
    try { return { result: callback(), changed, usedState }; }
    finally { storage.getItem = original; }
  }

  function callAuthoritativeLoader(args) {
    return withTemporaryReads({}, () => PHASE3_LOAD_APP_STATE.apply(core, args)).result;
  }

  function refused(reason) {
    return { __phase3VerifiedReadTestRefused: true, reason };
  }

  function loadWithNavigationPolicy(args, noNormalFallback = false) {
    const mode = core.getPhase3ReadMode();
    if (servingFromNavigationCache) return noNormalFallback ? refused('recursive_load') : callAuthoritativeLoader(args);
    if (mode !== VERIFIED_MODE) {
      clearNavigationCache();
      sessionRestoreMismatchPending = false;
      return noNormalFallback ? refused('mode_not_verified') : PHASE3_LOAD_APP_STATE.apply(core, args);
    }

    const authoritativeRaw = safeLocalGet(core.STORAGE_KEY);
    const pendingJournalRaw = safeLocalGet(core.PENDING_HABIT_DELTAS_KEY);
    if (!navigationCache) {
      const internalStatus = PHASE3_GET_STATUS.call(core);
      if (internalStatus?.cacheReadyThisPage === true && internalStatus?.currentRawMatchesCache === true) {
        return noNormalFallback
          ? (PHASE3_TEST_READ ? PHASE3_TEST_READ.call(core) : refused('navigation_cache_not_ready'))
          : PHASE3_LOAD_APP_STATE.apply(core, args);
      }
    }
    const pendingWrites = Number(core.getPendingShadowDualWriteCount?.()) || 0;
    const pendingHabits = pendingHabitCount();
    const canServe = navigationCache
      && authoritativeRaw !== null
      && authoritativeRaw === navigationCache.authoritativeRaw
      && pendingWrites === 0
      && pendingHabits === 0;

    if (!canServe) {
      const reason = authoritativeRaw === null
        ? 'authoritative_missing'
        : pendingWrites > 0
          ? 'dual_write_pending'
          : pendingHabits > 0
            ? 'pending_habit_journal'
            : navigationCache
              ? 'authoritative_changed_since_verification'
              : sessionRestoreMismatchPending
                ? 'session_cache_mismatch'
                : 'cache_not_ready';
      sessionRestoreMismatchPending = false;
      if (navigationCache) clearNavigationCache();
      if (noNormalFallback) return refused(reason);
      recordFallback(reason);
      scheduleNavigationRefresh(reason);
      return callAuthoritativeLoader(args);
    }

    servingFromNavigationCache = true;
    try {
      const loadOptions = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? { ...args[0] } : {};
      loadOptions.persistSync = false;
      const attempt = withTemporaryReads({
        expectedAuthoritativeRaw: navigationCache.authoritativeRaw,
        stateRaw: navigationCache.serializedState,
        expectedJournalRaw: pendingJournalRaw,
        journalRaw: pendingJournalRaw
      }, () => PHASE3_LOAD_APP_STATE.call(core, loadOptions));
      const currentRaw = safeLocalGet(core.STORAGE_KEY);
      const currentJournalRaw = safeLocalGet(core.PENDING_HABIT_DELTAS_KEY);
      if (attempt.changed || !attempt.usedState || currentRaw !== navigationCache.authoritativeRaw || currentJournalRaw !== pendingJournalRaw) {
        clearNavigationCache();
        const reason = 'authoritative_changed_during_indexeddb_read';
        if (noNormalFallback) return refused(reason);
        recordFallback(reason);
        scheduleNavigationRefresh(reason);
        return callAuthoritativeLoader(args);
      }

      const previous = readDiagnostics();
      writeDiagnostics({
        configuredMode: mode,
        status: 'ready',
        effectiveSource: 'indexedDB',
        lastServedAt: nowIso(),
        lastFallbackReason: null,
        indexedDbReadsTotal: (Number(previous.indexedDbReadsTotal) || 0) + 1
      });
      return attempt.result;
    } catch (error) {
      clearNavigationCache();
      const reason = 'indexeddb_read_exception';
      if (noNormalFallback) return refused(reason);
      recordFallback(reason);
      scheduleNavigationRefresh(reason);
      return callAuthoritativeLoader(args);
    } finally {
      servingFromNavigationCache = false;
    }
  }

  function decorateStatus(status) {
    const value = status && typeof status === 'object' ? { ...status } : {};
    const authoritativeRaw = safeLocalGet(core.STORAGE_KEY);
    const ready = Boolean(navigationCache);
    value.cacheReadyThisPage = ready || value.cacheReadyThisPage === true;
    value.currentRawMatchesCache = ready
      ? authoritativeRaw !== null && authoritativeRaw === navigationCache.authoritativeRaw
      : value.currentRawMatchesCache === true;
    value.navigationCacheReadyThisPage = ready;
    value.navigationCacheRestoredFromSession = Boolean(navigationCache?.restoredFromSession);
    value.sessionCachePresent = safeSessionGet() !== null;
    return value;
  }

  core.loadAppState = function phase3NavigationLoadAppState(...args) {
    return loadWithNavigationPolicy(args, false);
  };

  core.getPhase3ReadStatus = function phase3NavigationGetStatus(options = {}) {
    const result = PHASE3_GET_STATUS.call(core, options);
    if (!options || options.refresh !== true) return decorateStatus(result);
    return Promise.resolve(result).then(async (status) => {
      if (core.getPhase3ReadMode() === VERIFIED_MODE && status?.status === 'ready') await rebuildNavigationCache();
      else if (core.getPhase3ReadMode() !== VERIFIED_MODE) clearNavigationCache();
      return decorateStatus(PHASE3_GET_STATUS.call(core));
    });
  };

  core.refreshPhase3ReadCache = function phase3NavigationRefresh(...args) {
    return Promise.resolve(PHASE3_REFRESH_CACHE.apply(core, args)).then(async (status) => {
      if (core.getPhase3ReadMode() === VERIFIED_MODE && status?.status === 'ready') await rebuildNavigationCache();
      else if (core.getPhase3ReadMode() !== VERIFIED_MODE || status?.status === 'fallback') clearNavigationCache();
      return status;
    });
  };

  core.setPhase3ReadMode = function phase3NavigationSetMode(mode) {
    clearNavigationCache();
    sessionRestoreMismatchPending = false;
    const result = PHASE3_SET_MODE.call(core, mode);
    if (result === VERIFIED_MODE) scheduleNavigationRefresh('mode_changed');
    return result;
  };

  core.clearPhase3ReadCache = function phase3NavigationClearCache() {
    clearNavigationCache();
    sessionRestoreMismatchPending = false;
    return PHASE3_CLEAR_CACHE.call(core);
  };

  core.testPhase3VerifiedRead = function phase3NavigationTestRead() {
    const before = decorateStatus(PHASE3_GET_STATUS.call(core));
    const outcome = loadWithNavigationPolicy([{ persistSync: false }], true);
    const status = decorateStatus(PHASE3_GET_STATUS.call(core));
    const served = status.indexedDbReadsTotal > before.indexedDbReadsTotal;
    if (served) return { served: true, reason: null, status };
    if (outcome?.__phase3VerifiedReadTestRefused) return { served: false, reason: outcome.reason, status };
    if (outcome && typeof outcome.served === 'boolean') return { ...outcome, status };
    return { served: false, reason: status.lastFallbackReason, status };
  };

  core.PHASE3_SESSION_CACHE_KEY = SESSION_CACHE_KEY;
  core.restorePhase3NavigationCache = restoreSessionCache;
  core.rebuildPhase3NavigationCache = rebuildNavigationCache;

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', handleModeStorageEvent);
  }

  if (core.getPhase3ReadMode() === VERIFIED_MODE) {
    if (!restoreSessionCache()) scheduleNavigationRefresh('module_install');
  } else {
    clearNavigationCache();
  }
})(typeof window !== 'undefined' ? window : globalThis);
