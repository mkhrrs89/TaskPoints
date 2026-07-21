(function installTaskPointsPhase3ReadPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase3ReadPathInstalled || typeof core.loadAppState !== 'function') return;
  core.__phase3ReadPathInstalled = true;

  const MODE_KEY = 'taskpoints_phase3_read_mode_v1';
  const DIAGNOSTICS_KEY = 'taskpoints_phase3_read_diagnostics_v1';
  const MODES = new Set(['off', 'compare', 'verified_indexeddb']);
  const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];
  const ORIGINAL_LOAD_APP_STATE = core.loadAppState;

  let verifiedCache = null;
  let refreshPromise = null;
  let refreshScheduled = false;
  let servingFromIndexedDb = false;

  function nowIso() {
    return new Date().toISOString();
  }

  function safeStorageGet(key) {
    try {
      return global.localStorage?.getItem?.(key) ?? null;
    } catch (_) {
      return null;
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
      configuredMode: getMode(),
      status: previous.status || 'off',
      comparePassesTotal: Number(previous.comparePassesTotal) || 0,
      compareFailuresTotal: Number(previous.compareFailuresTotal) || 0,
      indexedDbReadsTotal: Number(previous.indexedDbReadsTotal) || 0,
      fallbackReadsTotal: Number(previous.fallbackReadsTotal) || 0,
      ...previous,
      ...patch
    };
    try {
      global.localStorage?.setItem?.(DIAGNOSTICS_KEY, JSON.stringify(next));
    } catch (_) {}
    return next;
  }

  function getMode() {
    const value = safeStorageGet(MODE_KEY);
    return MODES.has(value) ? value : 'off';
  }

  function setMode(mode) {
    const nextMode = MODES.has(mode) ? mode : 'off';
    try {
      global.localStorage?.setItem?.(MODE_KEY, nextMode);
    } catch (_) {}
    verifiedCache = null;
    if (nextMode === 'off') {
      writeDiagnostics({ configuredMode: nextMode, status: 'off', effectiveSource: 'localStorage' });
    } else {
      writeDiagnostics({ configuredMode: nextMode, status: 'warming', effectiveSource: 'localStorage' });
      scheduleRefresh('mode_changed', { force: true });
    }
    return nextMode;
  }

  function cloneState(state) {
    if (typeof global.structuredClone === 'function') return global.structuredClone(state);
    return JSON.parse(JSON.stringify(state));
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  async function databaseExists(indexedDb, name) {
    if (typeof indexedDb?.databases !== 'function') return null;
    return (await indexedDb.databases()).some((entry) => entry.name === name);
  }

  async function openExistingShadowDb(indexedDb = global.indexedDB) {
    if (!indexedDb) throw new Error('indexeddb_unavailable');
    const exists = await databaseExists(indexedDb, core.SHADOW_MIGRATION_DB_NAME);
    if (exists === false) throw new Error('shadow_db_missing');

    return await new Promise((resolve, reject) => {
      const request = indexedDb.open(core.SHADOW_MIGRATION_DB_NAME);
      let rejectedUpgrade = false;
      request.onupgradeneeded = () => {
        rejectedUpgrade = true;
        try { request.transaction?.abort?.(); } catch (_) {}
      };
      request.onsuccess = () => {
        if (rejectedUpgrade) {
          request.result?.close?.();
          reject(new Error('shadow_db_missing'));
          return;
        }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error(rejectedUpgrade ? 'shadow_db_missing' : 'shadow_db_open_failed'));
    });
  }

  async function readShadowSnapshot(indexedDb = global.indexedDB) {
    const db = await openExistingShadowDb(indexedDb);
    try {
      const requiredStores = [...ARRAY_STORES, 'collections', 'values', 'metadata'];
      const missing = requiredStores.filter((name) => !db.objectStoreNames.contains(name));
      if (missing.length) throw new Error(`shadow_store_missing:${missing.join(',')}`);

      const tx = db.transaction(requiredStores, 'readonly');
      const arrayRequests = ARRAY_STORES.map((field) => requestPromise(tx.objectStore(field).getAll()));
      const collectionRequest = requestPromise(tx.objectStore('collections').getAll());
      const valuesRequest = requestPromise(tx.objectStore('values').getAll());
      const currentMetadataRequest = requestPromise(tx.objectStore('metadata').get('current'));
      const dualWriteMetadataRequest = requestPromise(tx.objectStore('metadata').get(core.SHADOW_DUAL_WRITE_METADATA_ID || 'dual_write'));

      const [arrayRows, collectionRows, valuesRows, currentMetadata, dualWriteMetadata] = await Promise.all([
        Promise.all(arrayRequests),
        collectionRequest,
        valuesRequest,
        currentMetadataRequest,
        dualWriteMetadataRequest
      ]);

      const state = {};
      ARRAY_STORES.forEach((field, index) => {
        state[field] = (arrayRows[index] || [])
          .slice()
          .sort((a, b) => Number(a.key) - Number(b.key))
          .map((row) => row.value);
      });
      (collectionRows || [])
        .filter((row) => row?.kind === 'manifest' && typeof row.field === 'string')
        .forEach((row) => { state[row.field] = []; });
      (collectionRows || [])
        .filter((row) => row?.kind === 'item' && typeof row.field === 'string')
        .sort((a, b) => String(a.field).localeCompare(String(b.field)) || Number(a.index) - Number(b.index))
        .forEach((row) => { (state[row.field] ||= [])[Number(row.index)] = row.value; });
      (valuesRows || []).forEach((row) => {
        if (row && typeof row.field === 'string') state[row.field] = row.value;
      });

      return { state, currentMetadata: currentMetadata || null, dualWriteMetadata: dualWriteMetadata || null };
    } finally {
      db.close?.();
    }
  }

  function summariesMatch(sourceState, destinationState, sourceSummary, destinationSummary) {
    const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
    const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
    const sourceLayout = core.shadowSourceLayout(sourceState);
    const destinationLayout = core.shadowSourceLayout(destinationState);
    const canonicalMatch = core.shadowCanonicalJson({ arrays: sourceLayout.arrays, collections: sourceLayout.collections, values: sourceLayout.values })
      === core.shadowCanonicalJson({ arrays: destinationLayout.arrays, collections: destinationLayout.collections, values: destinationLayout.values });
    const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary);
    return { countsMatch, hashesMatch, canonicalMatch, mismatches };
  }

  function controlledReason(error, fallback = 'read_verification_failed') {
    const message = String(error?.message || error || fallback);
    const allowed = [
      'indexeddb_unavailable', 'shadow_db_missing', 'shadow_db_open_failed',
      'phase1_not_verified', 'dual_write_not_verified', 'dual_write_pending',
      'authoritative_missing', 'authoritative_changed_during_refresh',
      'hash_mismatch', 'dual_write_hash_mismatch'
    ];
    if (allowed.includes(message)) return message;
    if (message.startsWith('shadow_store_missing:')) return message;
    return fallback;
  }

  async function refreshReadCache(options = {}) {
    if (refreshPromise) return refreshPromise;

    const operation = (async () => {
      const mode = options.mode || getMode();
      const verificationMode = mode === 'off' ? 'compare' : mode;
      if (mode === 'off' && options.force !== true) {
        verifiedCache = null;
        return writeDiagnostics({ status: 'off', effectiveSource: 'localStorage', configuredMode: mode });
      }

      const startedAt = nowIso();
      try {
        if (typeof core.flushShadowDualWrites === 'function') await core.flushShadowDualWrites();
        if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) throw new Error('dual_write_pending');

        const authoritativeRawBefore = safeStorageGet(core.STORAGE_KEY);
        if (authoritativeRawBefore === null) throw new Error('authoritative_missing');
        const authoritativeState = core.parseTaskPointsStorageJson(authoritativeRawBefore, {}) || {};
        const sourceSummary = core.shadowSourceSummary(authoritativeState);

        const snapshot = await readShadowSnapshot(options.indexedDB || global.indexedDB);
        if (snapshot.currentMetadata?.status !== 'passed_verification') throw new Error('phase1_not_verified');
        if (snapshot.dualWriteMetadata?.status !== 'passed_verification') throw new Error('dual_write_not_verified');

        const authoritativeRawAfter = safeStorageGet(core.STORAGE_KEY);
        if (authoritativeRawAfter === null) throw new Error('authoritative_missing');
        if (authoritativeRawAfter !== authoritativeRawBefore) throw new Error('authoritative_changed_during_refresh');
        if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) throw new Error('dual_write_pending');

        const destinationSummary = core.shadowSourceSummary(snapshot.state);
        const comparison = summariesMatch(authoritativeState, snapshot.state, sourceSummary, destinationSummary);
        if (!comparison.countsMatch || !comparison.hashesMatch || !comparison.canonicalMatch || comparison.mismatches.length) throw new Error('hash_mismatch');

        const dualSourceHash = snapshot.dualWriteMetadata?.verification?.source?.hashes?.state;
        const dualDestinationHash = snapshot.dualWriteMetadata?.verification?.destination?.hashes?.state;
        if (dualSourceHash !== sourceSummary.hashes.state || dualDestinationHash !== destinationSummary.hashes.state) {
          throw new Error('dual_write_hash_mismatch');
        }

        const serializedState = JSON.stringify(snapshot.state);
        verifiedCache = {
          authoritativeRaw: authoritativeRawBefore,
          serializedState,
          state: cloneState(snapshot.state),
          sourceHash: sourceSummary.hashes.state,
          destinationHash: destinationSummary.hashes.state,
          sourceCounts: sourceSummary.counts,
          destinationCounts: destinationSummary.counts,
          verifiedAt: nowIso()
        };

        const previous = readDiagnostics();
        return writeDiagnostics({
          configuredMode: mode,
          status: verificationMode === 'compare' ? 'compare_passed' : 'ready',
          effectiveSource: verificationMode === 'verified_indexeddb' ? 'indexedDB_ready' : 'localStorage',
          refreshStartedAt: startedAt,
          lastVerifiedAt: verifiedCache.verifiedAt,
          lastFallbackReason: null,
          sourceHash: verifiedCache.sourceHash,
          destinationHash: verifiedCache.destinationHash,
          sourceCounts: verifiedCache.sourceCounts,
          destinationCounts: verifiedCache.destinationCounts,
          countsMatch: true,
          hashesMatch: true,
          mismatches: [],
          comparePassesTotal: (Number(previous.comparePassesTotal) || 0) + 1
        });
      } catch (error) {
        verifiedCache = null;
        const reason = controlledReason(error);
        const previous = readDiagnostics();
        return writeDiagnostics({
          configuredMode: mode,
          status: 'fallback',
          effectiveSource: 'localStorage',
          refreshStartedAt: startedAt,
          lastFallbackAt: nowIso(),
          lastFallbackReason: reason,
          countsMatch: false,
          hashesMatch: false,
          mismatches: reason === 'hash_mismatch' ? [{ type: 'overall_state' }] : [],
          compareFailuresTotal: (Number(previous.compareFailuresTotal) || 0) + 1
        });
      }
    })();

    const tracked = operation.finally(() => {
      if (refreshPromise === tracked) refreshPromise = null;
    });
    refreshPromise = tracked;
    return tracked;
  }

  function scheduleRefresh(reason = 'load_fallback', options = {}) {
    if (getMode() === 'off' && options.force !== true) return null;
    if (refreshScheduled || refreshPromise) return refreshPromise;
    refreshScheduled = true;
    const schedule = typeof global.queueMicrotask === 'function'
      ? global.queueMicrotask.bind(global)
      : (callback) => Promise.resolve().then(callback);
    schedule(() => {
      refreshScheduled = false;
      refreshReadCache({ ...options, reason }).catch(() => undefined);
    });
    return null;
  }

  function withTemporaryAuthoritativeRaw(serializedState, callback) {
    const storage = global.localStorage;
    if (!storage || typeof storage.getItem !== 'function') return callback();

    const StorageCtor = global.Storage;
    if (StorageCtor?.prototype?.getItem) {
      const prototype = StorageCtor.prototype;
      const original = prototype.getItem;
      prototype.getItem = function phase3VerifiedGetItem(key) {
        if (this === global.localStorage && String(key) === core.STORAGE_KEY) return serializedState;
        return original.call(this, key);
      };
      try {
        return callback();
      } finally {
        prototype.getItem = original;
      }
    }

    const original = storage.getItem;
    storage.getItem = function phase3VerifiedGetItem(key) {
      if (String(key) === core.STORAGE_KEY) return serializedState;
      return original.call(storage, key);
    };
    try {
      return callback();
    } finally {
      storage.getItem = original;
    }
  }

  function recordFallback(reason) {
    const previous = readDiagnostics();
    writeDiagnostics({
      configuredMode: getMode(),
      status: previous.status === 'ready' ? 'ready' : (previous.status || 'warming'),
      effectiveSource: 'localStorage',
      lastFallbackAt: nowIso(),
      lastFallbackReason: reason,
      fallbackReadsTotal: (Number(previous.fallbackReadsTotal) || 0) + 1
    });
  }

  function wrappedLoadAppState(...args) {
    const mode = getMode();
    if (mode === 'off' || servingFromIndexedDb) return ORIGINAL_LOAD_APP_STATE.apply(core, args);

    const authoritativeRaw = safeStorageGet(core.STORAGE_KEY);
    const pendingWrites = Number(core.getPendingShadowDualWriteCount?.()) || 0;
    const canServe = mode === 'verified_indexeddb'
      && verifiedCache
      && authoritativeRaw !== null
      && authoritativeRaw === verifiedCache.authoritativeRaw
      && pendingWrites === 0;

    if (!canServe) {
      const reason = authoritativeRaw === null
        ? 'authoritative_missing'
        : pendingWrites > 0
          ? 'dual_write_pending'
          : verifiedCache
            ? 'authoritative_changed_since_verification'
            : 'cache_not_ready';
      const result = ORIGINAL_LOAD_APP_STATE.apply(core, args);
      if (mode === 'verified_indexeddb') recordFallback(reason);
      scheduleRefresh(reason);
      return result;
    }

    servingFromIndexedDb = true;
    try {
      const result = withTemporaryAuthoritativeRaw(verifiedCache.serializedState, () => ORIGINAL_LOAD_APP_STATE.apply(core, args));
      const previous = readDiagnostics();
      writeDiagnostics({
        configuredMode: mode,
        status: 'ready',
        effectiveSource: 'indexedDB',
        lastServedAt: nowIso(),
        lastFallbackReason: null,
        indexedDbReadsTotal: (Number(previous.indexedDbReadsTotal) || 0) + 1
      });
      const currentRaw = safeStorageGet(core.STORAGE_KEY);
      if (currentRaw !== verifiedCache.authoritativeRaw) {
        verifiedCache = null;
        scheduleRefresh('authoritative_changed_after_indexeddb_read');
      }
      return result;
    } catch (error) {
      verifiedCache = null;
      recordFallback('indexeddb_read_exception');
      scheduleRefresh('indexeddb_read_exception');
      return ORIGINAL_LOAD_APP_STATE.apply(core, args);
    } finally {
      servingFromIndexedDb = false;
    }
  }

  function getStatus(options = {}) {
    const finish = () => {
      const diagnostics = readDiagnostics();
      const authoritativeRaw = safeStorageGet(core.STORAGE_KEY);
      return {
        schemaVersion: 1,
        phase: 'read_path',
        configuredMode: getMode(),
        status: diagnostics.status || (getMode() === 'off' ? 'off' : 'warming'),
        effectiveSource: diagnostics.effectiveSource || 'localStorage',
        lastVerifiedAt: diagnostics.lastVerifiedAt || null,
        lastServedAt: diagnostics.lastServedAt || null,
        lastFallbackAt: diagnostics.lastFallbackAt || null,
        lastFallbackReason: diagnostics.lastFallbackReason || null,
        sourceHash: diagnostics.sourceHash || null,
        destinationHash: diagnostics.destinationHash || null,
        sourceCounts: diagnostics.sourceCounts || {},
        destinationCounts: diagnostics.destinationCounts || {},
        countsMatch: diagnostics.countsMatch === true,
        hashesMatch: diagnostics.hashesMatch === true,
        mismatches: Array.isArray(diagnostics.mismatches) ? diagnostics.mismatches : [],
        comparePassesTotal: Number(diagnostics.comparePassesTotal) || 0,
        compareFailuresTotal: Number(diagnostics.compareFailuresTotal) || 0,
        indexedDbReadsTotal: Number(diagnostics.indexedDbReadsTotal) || 0,
        fallbackReadsTotal: Number(diagnostics.fallbackReadsTotal) || 0,
        pendingWritesThisPage: Number(core.getPendingShadowDualWriteCount?.()) || 0,
        cacheReadyThisPage: Boolean(verifiedCache),
        currentRawMatchesCache: Boolean(verifiedCache && authoritativeRaw !== null && authoritativeRaw === verifiedCache.authoritativeRaw)
      };
    };

    if (options.refresh === true) return refreshReadCache({ ...options, force: true }).then(finish);
    return finish();
  }

  function clearCache() {
    verifiedCache = null;
    return true;
  }

  core.PHASE3_READ_MODE_KEY = MODE_KEY;
  core.PHASE3_READ_DIAGNOSTICS_KEY = DIAGNOSTICS_KEY;
  core.PHASE3_READ_MODES = [...MODES];
  core.getPhase3ReadMode = getMode;
  core.setPhase3ReadMode = setMode;
  core.refreshPhase3ReadCache = refreshReadCache;
  core.getPhase3ReadStatus = getStatus;
  core.clearPhase3ReadCache = clearCache;
  core.readPhase3ShadowSnapshot = readShadowSnapshot;
  core.__phase3OriginalLoadAppState = ORIGINAL_LOAD_APP_STATE;
  core.loadAppState = wrappedLoadAppState;

  if (getMode() !== 'off') scheduleRefresh('module_install');
})(typeof window !== 'undefined' ? window : globalThis);
