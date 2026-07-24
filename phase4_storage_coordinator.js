(function installTaskPointsPhase4StorageCoordinator(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase4StorageCoordinatorInstalled) return;
  core.__phase4StorageCoordinatorInstalled = true;

  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';
  const MODES = ['off', 'verify_primary_writes', 'indexeddb_primary'];
  const MODE_SET = new Set(MODES);
  const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];
  const CANDIDATE_ID = 'phase4_candidate';
  const PRIMARY_COMMIT_ID = 'phase4_primary_commit';

  let queueTail = Promise.resolve();
  let pendingCount = 0;
  let sequence = 0;
  let verifiedPrimaryCache = null;

  function nowIso() { return new Date().toISOString(); }
  function clone(value) {
    if (typeof global.structuredClone === 'function') return global.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
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
      configuredMode: getMode(),
      effectiveSource: previous.effectiveSource || 'localStorage',
      latestQueuedSequence: Number(previous.latestQueuedSequence) || 0,
      latestPassedSequence: Number(previous.latestPassedSequence) || 0,
      pendingWrites: pendingCount,
      indexedDbReadsTotal: Number(previous.indexedDbReadsTotal) || 0,
      fallbackReadsTotal: Number(previous.fallbackReadsTotal) || 0,
      verificationFailuresTotal: Number(previous.verificationFailuresTotal) || 0,
      lastFallbackReason: previous.lastFallbackReason || null,
      resetTombstone: previous.resetTombstone === true,
      ...previous,
      ...patch,
      pendingWrites: patch.pendingWrites == null ? pendingCount : patch.pendingWrites
    };
    try { global.localStorage?.setItem?.(DIAGNOSTICS_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }
  function getMode() {
    const value = safeGet(MODE_KEY);
    return MODE_SET.has(value) ? value : 'off';
  }
  function clearCaches() {
    verifiedPrimaryCache = null;
    try { core.clearPhase3ReadCache?.(); } catch (_) {}
    try { global.sessionStorage?.removeItem?.('taskpoints_phase4_verified_primary_cache_v1'); } catch (_) {}
    return true;
  }
  function setMode(mode) {
    const next = MODE_SET.has(mode) ? mode : 'off';
    try { global.localStorage?.setItem?.(MODE_KEY, next); } catch (_) {}
    if (next === 'off') clearCaches();
    writeDiagnostics({ configuredMode: next, effectiveSource: 'localStorage', lastFallbackReason: null });
    return next;
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }
  function transactionPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  }
  function hashValue(value) {
    const text = typeof core.shadowCanonicalJson === 'function'
      ? core.shadowCanonicalJson(value)
      : JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  }

  function openShadowDb(indexedDb = global.indexedDB) {
    if (!indexedDb) return Promise.reject(new Error('indexeddb_unavailable'));
    return new Promise((resolve, reject) => {
      const request = indexedDb.open(core.SHADOW_MIGRATION_DB_NAME, core.SHADOW_MIGRATION_DB_VERSION || 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        [...ARRAY_STORES, 'collections'].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
        });
        if (!db.objectStoreNames.contains('values')) db.createObjectStore('values', { keyPath: 'field' });
        if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('shadow_db_open_failed'));
    });
  }

  function layoutFor(state) {
    return core.shadowSourceLayout(state && typeof state === 'object' ? state : {});
  }

  async function writeCandidate(db, state, raw, writeSequence, journalCount) {
    const layout = layoutFor(state);
    const summary = core.shadowSourceSummary(state);
    const stores = [...ARRAY_STORES, 'collections', 'values', 'metadata'];
    const tx = db.transaction(stores, 'readwrite');

    [...ARRAY_STORES, 'collections'].forEach((name) => tx.objectStore(name).clear());
    tx.objectStore('values').clear();
    Object.entries(layout.arrays || {}).forEach(([field, rows]) => {
      (rows || []).forEach((value, index) => tx.objectStore(field).put({ key: index, value }));
    });
    Object.entries(layout.collections || {}).forEach(([field, rows]) => {
      tx.objectStore('collections').put({ key: `manifest:${field}`, kind: 'manifest', field });
      (rows || []).forEach((value, index) => {
        tx.objectStore('collections').put({ key: `item:${field}:${index}`, kind: 'item', field, index, value });
      });
    });
    Object.entries(layout.values || {}).forEach(([field, value]) => {
      tx.objectStore('values').put({ field, value });
    });
    tx.objectStore('metadata').put({
      id: CANDIDATE_ID,
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      status: 'candidate_written',
      sequence: writeSequence,
      startedAt: nowIso(),
      sourceCounts: summary.counts,
      sourceHashes: summary.hashes,
      mirrorHash: hashValue(raw),
      pendingJournalCount: journalCount,
      errors: []
    });
    await transactionPromise(tx);
    return summary;
  }

  async function readState(db) {
    const stores = [...ARRAY_STORES, 'collections', 'values', 'metadata'];
    const tx = db.transaction(stores, 'readonly');
    const arrayRequests = ARRAY_STORES.map((field) => requestPromise(tx.objectStore(field).getAll()));
    const collectionRequest = requestPromise(tx.objectStore('collections').getAll());
    const valuesRequest = requestPromise(tx.objectStore('values').getAll());
    const candidateRequest = requestPromise(tx.objectStore('metadata').get(CANDIDATE_ID));
    const [arrayRows, collectionRows, valuesRows, candidate] = await Promise.all([
      Promise.all(arrayRequests), collectionRequest, valuesRequest, candidateRequest
    ]);
    const state = {};
    ARRAY_STORES.forEach((field, index) => {
      state[field] = (arrayRows[index] || []).slice().sort((a, b) => Number(a.key) - Number(b.key)).map((row) => row.value);
    });
    (collectionRows || []).filter((row) => row?.kind === 'manifest').forEach((row) => { state[row.field] = []; });
    (collectionRows || []).filter((row) => row?.kind === 'item')
      .sort((a, b) => String(a.field).localeCompare(String(b.field)) || Number(a.index) - Number(b.index))
      .forEach((row) => { (state[row.field] ||= [])[Number(row.index)] = row.value; });
    (valuesRows || []).forEach((row) => { if (row && typeof row.field === 'string') state[row.field] = row.value; });
    return { state, candidate: candidate || null };
  }

  async function commitPrimary(db, metadata) {
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({ id: PRIMARY_COMMIT_ID, ...metadata });
    await transactionPromise(tx);
  }

  async function writeResetTombstone(indexedDb, writeSequence) {
    let db = null;
    try {
      db = await openShadowDb(indexedDb);
      const stores = [...ARRAY_STORES, 'collections', 'values', 'metadata'];
      const tx = db.transaction(stores, 'readwrite');
      [...ARRAY_STORES, 'collections'].forEach((name) => tx.objectStore(name).clear());
      tx.objectStore('values').clear();
      tx.objectStore('metadata').put({
        id: CANDIDATE_ID,
        schemaVersion: 1,
        phase: 'indexeddb_primary',
        status: 'reset_tombstone',
        sequence: writeSequence,
        completionTime: nowIso(),
        errors: []
      });
      tx.objectStore('metadata').delete(PRIMARY_COMMIT_ID);
      await transactionPromise(tx);
      clearCaches();
      return writeDiagnostics({
        effectiveSource: 'localStorage',
        latestQueuedSequence: writeSequence,
        lastFallbackAt: nowIso(),
        lastFallbackReason: 'authoritative_missing',
        resetTombstone: true
      });
    } finally { db?.close?.(); }
  }

  function journalCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; } catch (_) { return 1; }
  }

  async function performWrite(options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    const writeSequence = Number(options.sequence) || 0;
    const rawBefore = safeGet(core.STORAGE_KEY);
    if (rawBefore === null) return writeResetTombstone(indexedDb, writeSequence);

    const pendingJournalCount = journalCount();
    if (pendingJournalCount > 0) {
      clearCaches();
      return writeDiagnostics({
        effectiveSource: 'localStorage',
        latestQueuedSequence: writeSequence,
        lastFallbackAt: nowIso(),
        lastFallbackReason: 'pending_habit_journal',
        resetTombstone: false
      });
    }

    let db = null;
    try {
      const source = core.parseTaskPointsStorageJson(rawBefore, {}) || {};
      if (typeof core.flushShadowDualWrites === 'function') await core.flushShadowDualWrites();
      if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) throw new Error('dual_write_pending');
      db = await openShadowDb(indexedDb);
      const sourceSummary = await writeCandidate(db, source, rawBefore, writeSequence, pendingJournalCount);
      const rebuilt = await readState(db);
      const destinationSummary = core.shadowSourceSummary(rebuilt.state);
      const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
      const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
      const canonicalMatch = core.shadowCanonicalJson(layoutFor(source)) === core.shadowCanonicalJson(layoutFor(rebuilt.state));
      const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary) || [];
      const rawAfter = safeGet(core.STORAGE_KEY);
      if (rawAfter === null) throw new Error('authoritative_missing');
      if (rawAfter !== rawBefore) throw new Error('mirror_changed_during_verification');
      if (journalCount() > 0) throw new Error('pending_habit_journal');
      if (!countsMatch || !hashesMatch || !canonicalMatch || mismatches.length) throw new Error('verification_mismatch');
      if (Number(rebuilt.candidate?.sequence) !== writeSequence) throw new Error('candidate_sequence_mismatch');

      const completionTime = nowIso();
      const verification = {
        countsMatch,
        hashesMatch,
        canonicalMatch,
        mismatches,
        source: sourceSummary,
        destination: destinationSummary
      };
      await commitPrimary(db, {
        schemaVersion: 1,
        phase: 'indexeddb_primary',
        status: 'passed_verification',
        sequence: writeSequence,
        completionTime,
        mirrorHash: hashValue(rawBefore),
        verification,
        errors: []
      });
      verifiedPrimaryCache = {
        schemaVersion: 1,
        sequence: writeSequence,
        state: clone(rebuilt.state),
        serializedState: JSON.stringify(rebuilt.state),
        sourceHash: sourceSummary.hashes.state,
        destinationHash: destinationSummary.hashes.state,
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        mirrorRaw: rawBefore,
        mirrorHash: hashValue(rawBefore),
        status: 'passed_verification',
        verifiedAt: completionTime
      };
      return writeDiagnostics({
        configuredMode: getMode(),
        effectiveSource: getMode() === 'indexeddb_primary' ? 'indexedDB_ready' : 'localStorage',
        latestQueuedSequence: writeSequence,
        latestPassedSequence: writeSequence,
        lastCandidateWriteAt: completionTime,
        lastVerifiedAt: completionTime,
        lastFallbackReason: null,
        resetTombstone: false,
        countsMatch: true,
        hashesMatch: true,
        canonicalMatch: true,
        mismatches: []
      });
    } catch (error) {
      clearCaches();
      const previous = readDiagnostics();
      return writeDiagnostics({
        configuredMode: getMode(),
        effectiveSource: 'localStorage',
        latestQueuedSequence: writeSequence,
        lastFallbackAt: nowIso(),
        lastFallbackReason: String(error?.message || error || 'phase4_write_failed'),
        verificationFailuresTotal: (Number(previous.verificationFailuresTotal) || 0) + 1,
        resetTombstone: false
      });
    } finally { db?.close?.(); }
  }

  function queueWrite(options = {}) {
    if (getMode() === 'off' && options.force !== true) return Promise.resolve({ status: 'off' });
    const writeSequence = ++sequence;
    pendingCount += 1;
    writeDiagnostics({ latestQueuedSequence: writeSequence, pendingWrites: pendingCount });
    const operation = queueTail
      .catch(() => undefined)
      .then(() => performWrite({ ...options, sequence: writeSequence }))
      .finally(() => {
        pendingCount = Math.max(0, pendingCount - 1);
        writeDiagnostics({ pendingWrites: pendingCount });
      });
    queueTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  function flushWrites() { return queueTail.catch(() => undefined); }
  function getStatus() {
    const diagnostics = readDiagnostics();
    return {
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      configuredMode: getMode(),
      effectiveSource: diagnostics.effectiveSource || 'localStorage',
      latestQueuedSequence: Number(diagnostics.latestQueuedSequence) || 0,
      latestPassedSequence: Number(diagnostics.latestPassedSequence) || 0,
      pendingWrites: pendingCount,
      lastCandidateWriteAt: diagnostics.lastCandidateWriteAt || null,
      lastVerifiedAt: diagnostics.lastVerifiedAt || null,
      lastFallbackAt: diagnostics.lastFallbackAt || null,
      lastFallbackReason: diagnostics.lastFallbackReason || null,
      indexedDbReadsTotal: Number(diagnostics.indexedDbReadsTotal) || 0,
      fallbackReadsTotal: Number(diagnostics.fallbackReadsTotal) || 0,
      verificationFailuresTotal: Number(diagnostics.verificationFailuresTotal) || 0,
      countsMatch: diagnostics.countsMatch === true,
      hashesMatch: diagnostics.hashesMatch === true,
      canonicalMatch: diagnostics.canonicalMatch === true,
      mismatches: Array.isArray(diagnostics.mismatches) ? diagnostics.mismatches : [],
      resetTombstone: diagnostics.resetTombstone === true,
      cacheReadyThisPage: Boolean(verifiedPrimaryCache),
      currentMirrorMatchesCache: Boolean(verifiedPrimaryCache && safeGet(core.STORAGE_KEY) === verifiedPrimaryCache.mirrorRaw)
    };
  }

  function installStorageHooks() {
  const storage = global.localStorage;
  if (!storage) return;

  try {
    if (!storage.__taskPointsPhase4InstanceHookInstalled && typeof storage.setItem === 'function') {
      const originalSet = storage.setItem.bind(storage);
      const originalRemove = typeof storage.removeItem === 'function' ? storage.removeItem.bind(storage) : null;
      const wrappedSet = function phase4SetItem(key, value) {
        const result = originalSet(key, value);
        if (String(key) === core.STORAGE_KEY && getMode() !== 'off') queueWrite();
        return result;
      };
      const wrappedRemove = originalRemove ? function phase4RemoveItem(key) {
        const result = originalRemove(key);
        if (String(key) === core.STORAGE_KEY && getMode() !== 'off') queueWrite();
        return result;
      } : null;
      storage.setItem = wrappedSet;
      if (wrappedRemove) storage.removeItem = wrappedRemove;
      if (storage.setItem === wrappedSet) {
        Object.defineProperty(storage, '__taskPointsPhase4InstanceHookInstalled', { value: true, configurable: true });
        return;
      }
    }
  } catch (_) {}

  const StorageCtor = global.Storage;
  if (!StorageCtor?.prototype?.setItem) return;
  const prototype = StorageCtor.prototype;
  if (!prototype.__taskPointsPhase4OriginalSetItem) {
    const originalSet = prototype.setItem;
    Object.defineProperty(prototype, '__taskPointsPhase4OriginalSetItem', { value: originalSet, configurable: true });
    prototype.setItem = function phase4SetItem(key, value) {
      const result = originalSet.call(this, key, value);
      if (this === global.localStorage && String(key) === core.STORAGE_KEY && getMode() !== 'off') queueWrite();
      return result;
    };
  }
  if (prototype.removeItem && !prototype.__taskPointsPhase4OriginalRemoveItem) {
    const originalRemove = prototype.removeItem;
    Object.defineProperty(prototype, '__taskPointsPhase4OriginalRemoveItem', { value: originalRemove, configurable: true });
    prototype.removeItem = function phase4RemoveItem(key) {
      const result = originalRemove.call(this, key);
      if (this === global.localStorage && String(key) === core.STORAGE_KEY && getMode() !== 'off') queueWrite();
      return result;
    };
  }
}

  core.PHASE4_STORAGE_MODE_KEY = MODE_KEY;
  core.PHASE4_DIAGNOSTICS_KEY = DIAGNOSTICS_KEY;
  core.PHASE4_STORAGE_MODES = MODES.slice();
  core.PHASE4_CANDIDATE_METADATA_ID = CANDIDATE_ID;
  core.PHASE4_PRIMARY_COMMIT_METADATA_ID = PRIMARY_COMMIT_ID;
  core.getPhase4StorageMode = getMode;
  core.setPhase4StorageMode = setMode;
  core.queuePhase4PrimaryWrite = queueWrite;
  core.flushPhase4PrimaryWrites = flushWrites;
  core.getPendingPhase4WriteCount = () => pendingCount;
  core.getPhase4StorageStatus = getStatus;
  core.clearPhase4Caches = clearCaches;
  core.getPhase4VerifiedPrimaryCache = () => verifiedPrimaryCache;
  core.setPhase4VerifiedPrimaryCache = (value) => { verifiedPrimaryCache = value || null; return verifiedPrimaryCache; };

  installStorageHooks();
  writeDiagnostics({ configuredMode: getMode(), effectiveSource: 'localStorage', pendingWrites: 0 });
})(typeof window !== 'undefined' ? window : globalThis);
