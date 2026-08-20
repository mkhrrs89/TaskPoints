(function installTaskPointsPhase5ANativeSnapshot(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase5aNativeSnapshotInstalled || typeof core.loadAppState !== 'function') return;
  if (typeof core.getPhase4StorageMode !== 'function' || typeof core.flushPhase4PrimaryWrites !== 'function') return;
  core.__phase5aNativeSnapshotInstalled = true;

  const ID = 'phase5a_native_snapshot';
  const FORMAT = 'metadata_structured_clone_v1';
  const META = 'metadata';
  const COMMIT_ID = core.PHASE4_PRIMARY_COMMIT_METADATA_ID || 'phase4_primary_commit';
  const STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];
  const DIAG_KEY = core.PHASE4_DIAGNOSTICS_KEY || 'taskpoints_phase4_diagnostics_v1';
  const HOME_LONG_QUIET_MS = 8000;
  const HOME_LONG_QUIET_POLL_MS = 250;
  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const homeLongQuietEnabled = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  const originalLoad = core.loadAppState;
  const originalFlush = core.flushPhase4PrimaryWrites.bind(core);
  const originalSetMode = core.setPhase4StorageMode?.bind(core);
  const originalClear = core.clearPhase4Caches?.bind(core);

  let cache = null;
  let writeTail = Promise.resolve();
  let writeRunning = false;
  let writeRevision = 0;
  let restorePromise = null;
  let serving = false;
  let backgroundWriteScheduled = false;
  let backgroundWriteTimer = 0;
  let backgroundWriteDeferred = false;

  const clone = (value) => typeof global.structuredClone === 'function'
    ? global.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  const get = (key) => { try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; } };
  const mode = () => core.getPhase4StorageMode?.() || 'off';
  const journalCount = () => { try { return Number(core.readPendingHabitDeltas?.().length) || 0; } catch (_) { return 1; } };
  const summary = (state) => core.shadowSourceSummary?.(state || {}) || { counts: null, hashes: { state: hash(state || {}) } };

  function hash(value) {
    const text = core.shadowCanonicalJson?.(value) ?? JSON.stringify(value);
    let result = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      result ^= text.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return `${(result >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  }

  function diagnostics(patch) {
    let current = {};
    try { current = JSON.parse(get(DIAG_KEY) || '{}') || {}; } catch (_) {}
    try {
      global.localStorage?.setItem?.(DIAG_KEY, JSON.stringify({
        ...current,
        ...patch,
        phase5aNativeSnapshotEnabled: true,
        phase5aNativeSnapshotFormat: FORMAT
      }));
    } catch (_) {}
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('phase5a_request_failed'));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('phase5a_transaction_aborted'));
      tx.onerror = () => undefined;
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(core.SHADOW_MIGRATION_DB_NAME, core.SHADOW_MIGRATION_DB_VERSION || 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        [...STORES, 'collections'].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
        });
        if (!db.objectStoreNames.contains('values')) db.createObjectStore('values', { keyPath: 'field' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('phase5a_open_failed'));
      request.onblocked = () => reject(new Error('phase5a_open_blocked'));
    });
  }

  async function readRows(db) {
    const tx = db.transaction(META, 'readonly');
    const store = tx.objectStore(META);
    const snapshotRequest = requestResult(store.get(ID));
    const commitRequest = requestResult(store.get(COMMIT_ID));
    const [snapshot, commit] = await Promise.all([snapshotRequest, commitRequest]);
    return { snapshot: snapshot || null, commit: commit || null };
  }

  async function removeSnapshot() {
    let db;
    try {
      db = await openDb();
      const tx = db.transaction(META, 'readwrite');
      tx.objectStore(META).delete(ID);
      await transactionDone(tx);
    } catch (_) {
      // Reset remains authoritative even when IndexedDB is unavailable.
    } finally { db?.close?.(); }
    cache = null;
  }

  function makeCache(record, mirrorRaw, restored) {
    const stateInfo = summary(record.state);
    return {
      schemaVersion: 1,
      sequence: Number(record.sequence) || 0,
      committedSequence: Number(record.sequence) || 0,
      state: clone(record.state),
      serializedState: null,
      stateHash: record.stateHash || stateInfo.hashes.state,
      sourceHash: record.stateHash || stateInfo.hashes.state,
      destinationHash: record.stateHash || stateInfo.hashes.state,
      sourceCounts: record.counts || stateInfo.counts,
      destinationCounts: record.counts || stateInfo.counts,
      mirrorRaw,
      mirrorHash: record.mirrorHash,
      status: 'passed_verification',
      verifiedAt: record.verifiedAt,
      nativeSnapshotFormat: FORMAT,
      restoredFromNativeIndexedDb: restored === true
    };
  }

  function valid(current, mirrorRaw) {
    return Boolean(current
      && current.status === 'passed_verification'
      && current.state && typeof current.state === 'object' && !Array.isArray(current.state)
      && mirrorRaw !== null && current.mirrorRaw === mirrorRaw
      && (Number(core.getPendingShadowDualWriteCount?.()) || 0) === 0
      && (Number(core.getPendingPhase4WriteCount?.()) || 0) === 0
      && journalCount() === 0);
  }

  function setCache(next) {
    cache = next || null;
    if (cache) core.setPhase4VerifiedPrimaryCache?.(cache, { persist: false });
    return cache;
  }

  async function writeSnapshot() {
    if (mode() === 'off') return false;
    const mirrorRaw = get(core.STORAGE_KEY);
    if (mirrorRaw === null) { await removeSnapshot(); return false; }
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0
      || (Number(core.getPendingPhase4WriteCount?.()) || 0) > 0
      || journalCount() > 0) return false;

    const phase4Cache = core.getPhase4VerifiedPrimaryCache?.();
    if (!phase4Cache || phase4Cache.status !== 'passed_verification' || phase4Cache.mirrorRaw !== mirrorRaw) return false;

    let db;
    try {
      db = await openDb();
      const { commit } = await readRows(db);
      const mirrorHash = hash(mirrorRaw);
      if (!commit || commit.status !== 'passed_verification') throw new Error('phase4_commit_missing');
      if (commit.mirrorHash && commit.mirrorHash !== mirrorHash) throw new Error('phase4_commit_mirror_mismatch');

      const state = clone(phase4Cache.state || {});
      const stateInfo = summary(state);
      const sequence = Number(commit.sequence) || Number(phase4Cache.committedSequence) || Number(phase4Cache.sequence) || 0;
      if (!sequence) throw new Error('phase5a_sequence_missing');
      const record = {
        id: ID,
        schemaVersion: 1,
        phase: 'phase5a_native_snapshot',
        snapshotFormat: FORMAT,
        status: 'candidate_written',
        sequence,
        state,
        stateHash: stateInfo.hashes.state,
        counts: stateInfo.counts,
        mirrorHash,
        verifiedAt: null
      };
      const writeTx = db.transaction(META, 'readwrite');
      writeTx.objectStore(META).put(record);
      await transactionDone(writeTx);

      const readTx = db.transaction(META, 'readonly');
      const readBack = await requestResult(readTx.objectStore(META).get(ID));
      if (!readBack?.state || readBack.snapshotFormat !== FORMAT) throw new Error('phase5a_readback_missing');
      if (summary(readBack.state).hashes.state !== stateInfo.hashes.state) throw new Error('phase5a_readback_mismatch');
      if (get(core.STORAGE_KEY) !== mirrorRaw || journalCount() > 0) throw new Error('phase5a_write_invalidated');

      const verified = { ...readBack, status: 'passed_verification', verifiedAt: new Date().toISOString() };
      const verifyTx = db.transaction(META, 'readwrite');
      verifyTx.objectStore(META).put(verified);
      await transactionDone(verifyTx);
      setCache(makeCache(verified, mirrorRaw, false));
      diagnostics({
        phase5aNativeSnapshotStatus: 'passed_verification',
        phase5aNativeSnapshotSequence: sequence,
        phase5aNativeSnapshotLastWriteAt: verified.verifiedAt,
        phase5aNativeSnapshotLastError: null
      });
      return true;
    } catch (error) {
      diagnostics({
        phase5aNativeSnapshotStatus: 'fallback',
        phase5aNativeSnapshotLastError: String(error?.message || error),
        phase5aNativeSnapshotLastFallbackAt: new Date().toISOString()
      });
      return false;
    } finally { db?.close?.(); }
  }

  async function restoreSnapshot() {
    if (mode() !== 'indexeddb_primary') return false;
    const mirrorRaw = get(core.STORAGE_KEY);
    if (mirrorRaw === null || journalCount() > 0
      || (Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0
      || (Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) return false;

    let db;
    try {
      db = await openDb();
      const { snapshot, commit } = await readRows(db);
      const mirrorHash = hash(mirrorRaw);
      if (!snapshot || snapshot.status !== 'passed_verification' || snapshot.snapshotFormat !== FORMAT) throw new Error('phase5a_snapshot_missing');
      if (!commit || commit.status !== 'passed_verification') throw new Error('phase4_commit_missing');
      if (Number(snapshot.sequence) !== Number(commit.sequence)) throw new Error('phase5a_sequence_mismatch');
      if (snapshot.mirrorHash !== mirrorHash || (commit.mirrorHash && commit.mirrorHash !== mirrorHash)) throw new Error('phase5a_mirror_mismatch');
      if (!snapshot.state || summary(snapshot.state).hashes.state !== snapshot.stateHash) throw new Error('phase5a_state_mismatch');
      if (get(core.STORAGE_KEY) !== mirrorRaw || journalCount() > 0) throw new Error('phase5a_restore_invalidated');
      setCache(makeCache(snapshot, mirrorRaw, true));
      diagnostics({
        phase5aNativeSnapshotStatus: 'restored',
        phase5aNativeSnapshotSequence: Number(snapshot.sequence) || 0,
        phase5aNativeSnapshotLastRestoreAt: new Date().toISOString(),
        phase5aNativeSnapshotLastError: null
      });
      return true;
    } catch (error) {
      cache = null;
      diagnostics({
        phase5aNativeSnapshotStatus: 'fallback',
        phase5aNativeSnapshotLastError: String(error?.message || error),
        phase5aNativeSnapshotLastFallbackAt: new Date().toISOString()
      });
      return false;
    } finally { db?.close?.(); }
  }

  async function runWrites() {
    try {
      while (mode() !== 'off') {
        const revision = writeRevision;
        await originalFlush();
        await writeSnapshot();
        if (revision === writeRevision) break;
      }
    } finally { writeRunning = false; }
  }

  function queueWrite() {
    if (mode() === 'off') return Promise.resolve(false);
    writeRevision += 1;
    if (writeRunning) return writeTail;
    writeRunning = true;
    writeTail = Promise.resolve().then(runWrites).catch(() => { writeRunning = false; });
    return writeTail;
  }

  function maintenanceStatus() {
    try {
      const value = core.getStorageMaintenanceIdleStatus?.();
      return value && typeof value === 'object' ? value : null;
    } catch (_) { return null; }
  }

  function homeLongQuietReady(status = maintenanceStatus()) {
    if (!homeLongQuietEnabled) return true;
    if (!status) return null;
    if (global.document?.visibilityState === 'hidden') return false;
    if (status.pageLeaving === true || status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= HOME_LONG_QUIET_MS;
  }

  function markBackgroundDeferred(status) {
    if (!homeLongQuietEnabled || backgroundWriteDeferred) return;
    backgroundWriteDeferred = true;
    try {
      global.TaskPointsPerf?.mark?.('phase5a.homeLongQuietDeferred', {
        requiredQuietMs: HOME_LONG_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0),
        navigationQuietForMs: Number(status?.navigationQuietForMs || 0),
        activeEditor: status?.activeEditor === true
      });
    } catch (_) {}
  }

  function markBackgroundReleased(status) {
    if (!homeLongQuietEnabled || !backgroundWriteDeferred) return;
    backgroundWriteDeferred = false;
    try {
      global.TaskPointsPerf?.mark?.('phase5a.homeLongQuietReleased', {
        requiredQuietMs: HOME_LONG_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0)
      });
    } catch (_) {}
  }

  function clearBackgroundTimer() {
    if (backgroundWriteTimer) global.clearTimeout?.(backgroundWriteTimer);
    backgroundWriteTimer = 0;
  }

  function cancelBackgroundWrite() {
    clearBackgroundTimer();
    backgroundWriteScheduled = false;
    backgroundWriteDeferred = false;
  }

  function scheduleBackgroundWrite() {
    if (mode() === 'off') return Promise.resolve(false);
    if (!homeLongQuietEnabled) return queueWrite();
    if (backgroundWriteScheduled) return Promise.resolve(true);
    backgroundWriteScheduled = true;

    const execute = () => {
      backgroundWriteTimer = 0;
      if (!backgroundWriteScheduled || mode() === 'off') {
        cancelBackgroundWrite();
        return false;
      }
      const status = maintenanceStatus();
      const ready = homeLongQuietReady(status);
      if (ready === false) {
        markBackgroundDeferred(status);
        backgroundWriteTimer = global.setTimeout?.(execute, HOME_LONG_QUIET_POLL_MS) || 0;
        return false;
      }
      if (ready === true) markBackgroundReleased(status);
      backgroundWriteScheduled = false;
      return queueWrite();
    };

    const gate = core.whenStorageMaintenanceQuiet;
    if (typeof gate === 'function') {
      Promise.resolve(gate(execute, { source: 'phase5a_native_snapshot_background' }))
        .catch(() => cancelBackgroundWrite());
    } else if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(execute, { timeout: 12000 });
    } else {
      backgroundWriteTimer = global.setTimeout?.(execute, 2500) || 0;
    }
    return Promise.resolve(true);
  }

  function flushWrites() {
    if (backgroundWriteScheduled) {
      cancelBackgroundWrite();
      return Promise.resolve(queueWrite()).then(() => writeTail).catch(() => writeTail);
    }
    return writeTail.catch(() => undefined);
  }

  function warm() {
    if (mode() !== 'indexeddb_primary') return Promise.resolve(false);
    if (valid(cache, get(core.STORAGE_KEY))) return Promise.resolve(true);
    if (restorePromise) return restorePromise;
    restorePromise = restoreSnapshot()
      .then(async (restored) => restored || (await originalFlush(), await writeSnapshot()))
      .catch(() => false)
      .finally(() => { restorePromise = null; });
    return restorePromise;
  }

  function loadNativeState(sourceState, options = {}) {
    let state = core.normalizeState(clone(sourceState || {}));
    const pendingHabitDeltas = [];
    const shouldSync = options.syncDerived !== false;
    const shouldPersist = options.persistSync !== false;
    let changed = false;

    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const beforeCount = state.tasks.length;
    state.tasks = state.tasks.filter((task) => {
      if (!task || task.status !== 'trashed') return true;
      const deletedMs = Date.parse(task.deletedAtISO || task.deletedAt || '');
      return (Number.isFinite(deletedMs) ? deletedMs : 0) >= cutoff;
    });
    if (state.tasks.length !== beforeCount) changed = true;

    if (shouldSync) {
      const derivedSync = core.syncDerivedPoints(state, { normalized: true });
      state = derivedSync.state;
      changed = changed || derivedSync.changed;

      const matchupSync = core.syncYouMatchups(state, { normalized: true });
      state = matchupSync.state;
      changed = changed || matchupSync.changed;

      const seasonRepair = core.repairSeasonChampionshipData(state, options);
      if (seasonRepair.ok) {
        const beforeSeasonRepair = JSON.stringify(state.currentSeason || null);
        state = seasonRepair.state;
        changed = changed || beforeSeasonRepair !== JSON.stringify(state.currentSeason || null);
      }
    }

    if (changed && shouldPersist) core.mergeAndSaveState(state, { storageKey: core.STORAGE_KEY });
    return { state, storageKeysFound: [core.STORAGE_KEY], pendingHabitDeltas };
  }

  function nativeLoad(args) {
    if (serving || mode() !== 'indexeddb_primary') return originalLoad.apply(core, args);
    const mirrorRaw = get(core.STORAGE_KEY);
    if (!valid(cache, mirrorRaw)) { cache = null; warm(); return originalLoad.apply(core, args); }

    const journalRaw = get(core.PENDING_HABIT_DELTAS_KEY);
    const options = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
      ? { ...args[0], persistSync: false }
      : { persistSync: false };

    serving = true;
    try {
      const result = loadNativeState(cache.state, options);
      if (get(core.STORAGE_KEY) !== mirrorRaw || get(core.PENDING_HABIT_DELTAS_KEY) !== journalRaw) {
        cache = null;
        warm();
        return originalLoad.apply(core, args);
      }
      diagnostics({
        effectiveSource: 'indexedDB_native',
        phase5aNativeSnapshotStatus: 'serving',
        phase5aNativeSnapshotLastReadAt: new Date().toISOString(),
        phase5aNativeSnapshotLastError: null
      });
      return result;
    } catch (_) {
      cache = null;
      warm();
      return originalLoad.apply(core, args);
    } finally { serving = false; }
  }

  function installHooks() {
    const storage = global.localStorage;
    if (!storage) return;

    try {
      if (!storage.__taskPointsPhase5AInstanceHookInstalled && typeof storage.setItem === 'function') {
        const set = storage.setItem.bind(storage);
        const remove = typeof storage.removeItem === 'function' ? storage.removeItem.bind(storage) : null;
        const wrappedSet = function phase5aSetItem(key, value) {
          const result = set(key, value);
          if (String(key) === core.STORAGE_KEY && mode() !== 'off') scheduleBackgroundWrite();
          return result;
        };
        const wrappedRemove = remove ? function phase5aRemoveItem(key) {
          const result = remove(key);
          if (String(key) === core.STORAGE_KEY) {
            cancelBackgroundWrite();
            removeSnapshot();
          }
          return result;
        } : null;
        storage.setItem = wrappedSet;
        if (wrappedRemove) storage.removeItem = wrappedRemove;
        if (storage.setItem === wrappedSet) {
          Object.defineProperty(storage, '__taskPointsPhase5AInstanceHookInstalled', { value: true, configurable: true });
          return;
        }
      }
    } catch (_) {}

    const prototype = global.Storage?.prototype;
    if (!prototype?.setItem || prototype.__taskPointsPhase5AOriginalSetItem) return;
    const set = prototype.setItem;
    Object.defineProperty(prototype, '__taskPointsPhase5AOriginalSetItem', { value: set, configurable: true });
    prototype.setItem = function phase5aSetItem(key, value) {
      const result = set.call(this, key, value);
      if (this === storage && String(key) === core.STORAGE_KEY && mode() !== 'off') scheduleBackgroundWrite();
      return result;
    };
    if (prototype.removeItem && !prototype.__taskPointsPhase5AOriginalRemoveItem) {
      const remove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsPhase5AOriginalRemoveItem', { value: remove, configurable: true });
      prototype.removeItem = function phase5aRemoveItem(key) {
        const result = remove.call(this, key);
        if (this === storage && String(key) === core.STORAGE_KEY) {
          cancelBackgroundWrite();
          removeSnapshot();
        }
        return result;
      };
    }
  }

  core.PHASE5A_NATIVE_SNAPSHOT_METADATA_ID = ID;
  core.PHASE5A_NATIVE_SNAPSHOT_FORMAT = FORMAT;
  core.getPhase5ANativeSnapshotCache = () => cache;
  core.clearPhase5ANativeSnapshotCache = () => { cache = null; };
  core.restorePhase5ANativeSnapshot = restoreSnapshot;
  core.queuePhase5ANativeSnapshotWrite = queueWrite;
  core.flushPhase5ANativeSnapshotWrites = flushWrites;
  core.getPhase5ANativeSnapshotStatus = () => ({
    enabled: true,
    format: FORMAT,
    cacheReady: valid(cache, get(core.STORAGE_KEY)),
    pendingWrite: writeRunning || backgroundWriteScheduled,
    backgroundWriteScheduled,
    homeLongQuietEnabled,
    requiredHomeQuietMs: homeLongQuietEnabled ? HOME_LONG_QUIET_MS : 0,
    restorePending: Boolean(restorePromise)
  });

  core.flushPhase4PrimaryWrites = async (...args) => {
    const result = await originalFlush(...args);
    if (mode() !== 'off') await queueWrite();
    return result;
  };
  if (originalSetMode) core.setPhase4StorageMode = (nextMode) => {
    const next = originalSetMode(nextMode);
    if (next === 'off') {
      cache = null;
      cancelBackgroundWrite();
    } else if (next === 'indexeddb_primary') warm();
    else queueWrite();
    return next;
  };
  if (originalClear) core.clearPhase4Caches = (...args) => { cache = null; return originalClear(...args); };
  core.loadAppState = (...args) => nativeLoad(args);

  installHooks();
  diagnostics({ phase5aNativeSnapshotStatus: 'installed', phase5aNativeSnapshotLastError: null });
  if (mode() === 'indexeddb_primary') warm();
  else if (mode() === 'verify_primary_writes') scheduleBackgroundWrite();
})(typeof window !== 'undefined' ? window : globalThis);
