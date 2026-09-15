(function installTaskPointsPhase2DualWrite(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase2DualWriteInstalled) return;
  core.__phase2DualWriteInstalled = true;

  const METADATA_ID = 'dual_write';
  const SNAPSHOT_ID = 'phase2_dual_write_snapshot';
  const SNAPSHOT_FORMAT = 'metadata_raw_v1';
  const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];
  const COALESCE_DELAY_MS = 900;
  const INTERACTION_RECHECK_MS = 250;
  const HOME_LONG_QUIET_MS = 8000;
  const INTERNAL_DETACHED_SOURCE = Symbol('taskpointsPhase2DetachedSource');
  const INTERNAL_SOURCE_SUMMARY = Symbol('taskpointsPhase2SourceSummary');
  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const homeLongQuietEnabled = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  let queueTail = Promise.resolve();
  let pendingCount = 0;
  let sequence = 0;
  let pendingSerializedBatch = null;
  let pendingSerializedTimer = null;
  let pendingQuietGate = null;
  let homeLongQuietDeferred = false;
  let sourceCloneCount = 0;
  let detachedSourceReuseCount = 0;
  let metadataSnapshotWriteCount = 0;
  let legacyRowWriteCount = 0;
  let sharedSourceReuseCount = 0;
  let sharedSourceFallbackCount = 0;

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    });
  }

  function cloneState(state) {
    sourceCloneCount += 1;
    if (typeof global.structuredClone === 'function') return global.structuredClone(state);
    return JSON.parse(JSON.stringify(state));
  }

  function exactSharedSourcePackage(raw) {
    try {
      const sourcePackage = core.getSharedSaveSourcePackage?.(raw);
      if (sourcePackage
        && sourcePackage.raw === raw
        && sourcePackage.state
        && typeof sourcePackage.state === 'object'
        && !Array.isArray(sourcePackage.state)
        && sourcePackage.summary?.hashes?.state) {
        sharedSourceReuseCount += 1;
        return sourcePackage;
      }
    } catch (_) {}
    sharedSourceFallbackCount += 1;
    return null;
  }

  function openShadowDb(indexedDb = global.indexedDB) {
    if (!indexedDb) return Promise.reject(new Error('IndexedDB is not available.'));
    return new Promise((resolve, reject) => {
      const request = indexedDb.open(core.SHADOW_MIGRATION_DB_NAME, core.SHADOW_MIGRATION_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        [...ARRAY_STORES, 'collections'].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
        });
        if (!db.objectStoreNames.contains('values')) db.createObjectStore('values', { keyPath: 'field' });
        if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open shadow state database.'));
    });
  }

  async function readMetadata(db, id) {
    const tx = db.transaction('metadata', 'readonly');
    return (await requestPromise(tx.objectStore('metadata').get(id))) || null;
  }

  async function putMetadata(db, id, metadata) {
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({ id, ...metadata });
    await transactionPromise(tx);
  }

  async function writeStores(db, source) {
    const layout = core.shadowSourceLayout(source);
    const stores = [...ARRAY_STORES, 'collections', 'values'];
    const tx = db.transaction(stores, 'readwrite');

    // All IndexedDB requests are created synchronously before awaiting. This is
    // intentional for Safari transaction-lifecycle compatibility.
    [...ARRAY_STORES, 'collections'].forEach((name) => tx.objectStore(name).clear());
    tx.objectStore('values').clear();
    Object.entries(layout.arrays).forEach(([field, rows]) => {
      rows.forEach((value, index) => tx.objectStore(field).put({ key: index, value }));
    });
    Object.entries(layout.collections).forEach(([field, rows]) => {
      tx.objectStore('collections').put({ key: `manifest:${field}`, kind: 'manifest', field });
      rows.forEach((value, index) => {
        tx.objectStore('collections').put({ key: `item:${field}:${index}`, kind: 'item', field, index, value });
      });
    });
    Object.entries(layout.values).forEach(([field, value]) => {
      tx.objectStore('values').put({ field, value });
    });
    await transactionPromise(tx);
  }

  async function readStores(db) {
    const stores = [...ARRAY_STORES, 'collections', 'values'];
    const tx = db.transaction(stores, 'readonly');

    // Create every request before the first await so Safari cannot deactivate
    // the transaction between asynchronous continuations.
    const arrayReads = Object.fromEntries(ARRAY_STORES.map((field) => [
      field,
      requestPromise(tx.objectStore(field).getAll())
    ]));
    const collectionRead = requestPromise(tx.objectStore('collections').getAll());
    const valuesRead = requestPromise(tx.objectStore('values').getAll());
    const [arrayRows, collectionRows, valuesRows] = await Promise.all([
      Promise.all(ARRAY_STORES.map((field) => arrayReads[field])),
      collectionRead,
      valuesRead
    ]);

    const rebuilt = {};
    ARRAY_STORES.forEach((field, index) => {
      rebuilt[field] = arrayRows[index]
        .sort((a, b) => a.key - b.key)
        .map((row) => row.value);
    });
    collectionRows
      .filter((row) => row.kind === 'manifest')
      .forEach((row) => { rebuilt[row.field] = []; });
    collectionRows
      .filter((row) => row.kind === 'item')
      .forEach((row) => { (rebuilt[row.field] ||= [])[row.index] = row.value; });
    valuesRows.forEach((row) => { rebuilt[row.field] = row.value; });
    return rebuilt;
  }

  async function writeMetadataSnapshotCandidate(db, serializedState, sourceSummary, startedAt, writeSequence) {
    const snapshot = {
      id: SNAPSHOT_ID,
      schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
      phase: 'dual_write',
      snapshotFormat: SNAPSHOT_FORMAT,
      status: 'candidate_written',
      sequence: writeSequence,
      startedAt,
      completionTime: null,
      serializedState,
      stateHash: sourceSummary.hashes.state,
      sourceCounts: sourceSummary.counts,
      errors: []
    };
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({
      id: METADATA_ID,
      schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
      phase: 'dual_write',
      status: 'running',
      startedAt,
      completionTime: null,
      sequence: writeSequence,
      snapshotId: SNAPSHOT_ID,
      snapshotFormat: SNAPSHOT_FORMAT,
      errors: [],
      sourceCounts: sourceSummary.counts,
      destinationCounts: {},
      verification: null
    });
    tx.objectStore('metadata').put(snapshot);
    metadataSnapshotWriteCount += 1;
    await transactionPromise(tx);
    return snapshot;
  }

  async function readMetadataSnapshot(db) {
    const tx = db.transaction('metadata', 'readonly');
    return (await requestPromise(tx.objectStore('metadata').get(SNAPSHOT_ID))) || null;
  }

  async function finalizeMetadataSnapshot(db, snapshot, metadata) {
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({
      ...snapshot,
      status: metadata.status,
      completionTime: metadata.completionTime,
      errors: metadata.errors || []
    });
    tx.objectStore('metadata').put({ id: METADATA_ID, ...metadata });
    await transactionPromise(tx);
  }

  function failedMetadata(error, startedAt, writeSequence) {
    return {
      schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
      phase: 'dual_write',
      status: 'failed',
      startedAt,
      completionTime: new Date().toISOString(),
      sequence: writeSequence,
      errors: [error?.message || String(error)],
      sourceCounts: {},
      destinationCounts: {},
      verification: null
    };
  }

  async function writeSnapshot(state, options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    const sourceInput = state && typeof state === 'object' ? state : {};
    const source = options[INTERNAL_DETACHED_SOURCE] === true
      ? (detachedSourceReuseCount += 1, sourceInput)
      : cloneState(sourceInput);
    const startedAt = new Date().toISOString();
    const writeSequence = Number(options.sequence) || 0;
    let db = null;

    try {
      db = await openShadowDb(indexedDb);
      const migration = await readMetadata(db, 'current');
      if (options.requireVerified !== false && migration?.status !== 'passed_verification') {
        return {
          schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
          phase: 'dual_write',
          status: 'skipped_not_verified'
        };
      }

      const reusableSummary = options[INTERNAL_SOURCE_SUMMARY];
      const sourceSummary = reusableSummary?.hashes?.state
        ? reusableSummary
        : core.shadowSourceSummary(source);
      const serializedState = typeof options.serializedSourceRaw === 'string'
        ? options.serializedSourceRaw
        : JSON.stringify(source);
      const snapshotCandidate = await writeMetadataSnapshotCandidate(
        db,
        serializedState,
        sourceSummary,
        startedAt,
        writeSequence
      );
      const readBack = await readMetadataSnapshot(db);
      if (!readBack
        || readBack.snapshotFormat !== SNAPSHOT_FORMAT
        || typeof readBack.serializedState !== 'string'
        || Number(readBack.sequence) !== writeSequence) {
        throw new Error('dual_write_snapshot_readback_missing');
      }
      const rebuilt = core.parseTaskPointsStorageJson(readBack.serializedState, null);
      if (!rebuilt || typeof rebuilt !== 'object' || Array.isArray(rebuilt)) {
        throw new Error('dual_write_snapshot_readback_unreadable');
      }
      const destinationSummary = core.shadowSourceSummary(rebuilt);
      const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary);
      const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
      const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
      const rawMatches = readBack.serializedState === serializedState;
      const status = countsMatch && hashesMatch && rawMatches ? 'passed_verification' : 'failed';
      const metadata = {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status,
        startedAt,
        completionTime: new Date().toISOString(),
        sequence: writeSequence,
        snapshotId: SNAPSHOT_ID,
        snapshotFormat: SNAPSHOT_FORMAT,
        errors: status === 'failed' ? ['Dual-write verification did not pass.'] : [],
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        verification: {
          countsMatch,
          hashesMatch,
          rawMatches,
          source: {
            counts: sourceSummary.counts,
            hashes: sourceSummary.hashes,
            hashDetails: sourceSummary.hashDetails
          },
          destination: {
            counts: destinationSummary.counts,
            hashes: destinationSummary.hashes,
            hashDetails: destinationSummary.hashDetails
          },
          mismatches
        }
      };
      await finalizeMetadataSnapshot(db, snapshotCandidate, metadata);
      return metadata;
    } catch (error) {
      const metadata = failedMetadata(error, startedAt, writeSequence);
      try {
        const errorDb = db || await openShadowDb(indexedDb);
        await putMetadata(errorDb, METADATA_ID, metadata);
        if (!db) errorDb.close?.();
      } catch (_) {}
      return metadata;
    } finally {
      db?.close?.();
    }
  }

  function sourceForExactRaw(raw) {
    const normalizedRaw = typeof raw === 'string' && raw ? raw : '{}';
    const shared = exactSharedSourcePackage(normalizedRaw);
    if (shared) {
      return {
        state: shared.state,
        raw: normalizedRaw,
        summary: shared.summary
      };
    }
    return {
      state: normalizedRaw === '{}' ? {} : core.parseTaskPointsStorageJson(normalizedRaw, {}),
      raw: normalizedRaw,
      summary: null
    };
  }

  function sourceFromLatestStoredRaw(capturedRaw) {
    try {
      const latestRaw = global.localStorage?.getItem?.(core.STORAGE_KEY);
      // A confirmed missing authoritative key represents an empty state. Never
      // fall back to an older captured payload, which could resurrect data
      // after Reset All in this page or another open TaskPoints tab.
      if (latestRaw === null) return { state: {}, raw: '{}', summary: null };
      if (typeof latestRaw === 'string') return sourceForExactRaw(latestRaw);
    } catch (_) {
      // If localStorage cannot be read, the captured successful setItem payload
      // is the safest fallback available for this single write.
    }
    return sourceForExactRaw(capturedRaw);
  }

  function queueWrite(state, options = {}) {
    const snapshot = state && typeof state === 'object' ? cloneState(state) : null;
    const writeSequence = ++sequence;
    pendingCount += 1;
    const operation = queueTail
      .catch(() => undefined)
      .then(() => {
        const resolved = snapshot
          ? { state: snapshot, raw: null, summary: null }
          : sourceFromLatestStoredRaw(options.serializedCandidate);
        // Both branches above are already detached from caller-owned/live state:
        // `snapshot` was cloned when queued, while the raw path was freshly parsed.
        // Reuse that private snapshot instead of cloning the entire multi-megabyte
        // state a second time immediately before the shadow write.
        return writeSnapshot(resolved.state, {
          ...options,
          sequence: writeSequence,
          serializedSourceRaw: resolved.raw,
          [INTERNAL_SOURCE_SUMMARY]: resolved.summary,
          [INTERNAL_DETACHED_SOURCE]: true
        });
      })
      .finally(() => {
        pendingCount = Math.max(0, pendingCount - 1);
      });

    // Keep the internal queue alive after a failed operation. Callers still get
    // the operation result, while localStorage remains authoritative.
    queueTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function maintenanceStatus() {
    try {
      const status = core.getStorageMaintenanceIdleStatus?.();
      return status && typeof status === 'object' ? status : null;
    } catch (_) { return null; }
  }

  function interactionBusy(status = maintenanceStatus()) {
    if (!status) return false;
    const requiredQuietMs = homeLongQuietEnabled
      ? HOME_LONG_QUIET_MS
      : Number(status.quietMs || 0);
    return status.pageLeaving === true
      || status.activeEditor === true
      || Number(status.navigationQuietForMs || 0) > 0
      || Number(status.lastInteractionAgoMs || 0) < requiredQuietMs;
  }

  function markHomeLongQuietDeferred(status) {
    if (!homeLongQuietEnabled || homeLongQuietDeferred) return;
    homeLongQuietDeferred = true;
    try {
      global.TaskPointsPerf?.mark?.('phase2.homeLongQuietDeferred', {
        requiredQuietMs: HOME_LONG_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0),
        navigationQuietForMs: Number(status?.navigationQuietForMs || 0),
        activeEditor: status?.activeEditor === true
      });
    } catch (_) {}
  }

  function markHomeLongQuietReleased(status) {
    if (!homeLongQuietEnabled || !homeLongQuietDeferred) return;
    homeLongQuietDeferred = false;
    try {
      global.TaskPointsPerf?.mark?.('phase2.homeLongQuietReleased', {
        requiredQuietMs: HOME_LONG_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0)
      });
    } catch (_) {}
  }

  function scheduleFallbackRecheck() {
    if (pendingSerializedTimer) global.clearTimeout?.(pendingSerializedTimer);
    pendingSerializedTimer = global.setTimeout?.(() => {
      pendingSerializedTimer = null;
      runScheduledSerializedWrite(false);
    }, INTERACTION_RECHECK_MS);
  }

  function waitForSharedMaintenanceQuiet() {
    if (pendingQuietGate || !pendingSerializedBatch) return pendingQuietGate;
    const gate = core.whenStorageMaintenanceQuiet;
    if (typeof gate !== 'function') return null;

    pendingQuietGate = Promise.resolve(gate(() => {
      pendingQuietGate = null;
      if (!pendingSerializedBatch) return true;
      const status = maintenanceStatus();
      if (interactionBusy(status)) {
        markHomeLongQuietDeferred(status);
        scheduleFallbackRecheck();
        return false;
      }
      markHomeLongQuietReleased(status);
      return runScheduledSerializedWrite(true);
    }, { reason: 'phase2_dual_write_coalesced' })).catch(() => {
      pendingQuietGate = null;
      if (pendingSerializedBatch) scheduleFallbackRecheck();
      return undefined;
    });
    return pendingQuietGate;
  }

  function runScheduledSerializedWrite(force = false) {
    const batch = pendingSerializedBatch;
    if (!batch) return Promise.resolve(true);
    if (!force) {
      if (waitForSharedMaintenanceQuiet()) return batch.promise;
      if (interactionBusy()) {
        markHomeLongQuietDeferred(maintenanceStatus());
        scheduleFallbackRecheck();
        return batch.promise;
      }
    }

    if (pendingSerializedTimer) global.clearTimeout?.(pendingSerializedTimer);
    pendingSerializedTimer = null;
    // Detach this batch before starting the expensive write. A save that lands
    // while this verification is running will create a distinct newer batch
    // instead of being resolved by the older operation.
    pendingSerializedBatch = null;
    const operation = queueWrite(null, {
      serializedCandidate: batch.raw,
      coalescedAuthoritativeWrite: true
    });
    operation.then(batch.resolve, (error) => batch.resolve({ status: 'failed', error: String(error?.message || error) }));
    return operation;
  }

  function scheduleFromStoredRaw(serializedCandidate) {
    try {
      if (!pendingSerializedBatch) {
        let resolveBatch;
        const promise = new Promise((resolve) => { resolveBatch = resolve; });
        pendingSerializedBatch = {
          raw: String(serializedCandidate),
          promise,
          resolve: resolveBatch
        };
      } else {
        pendingSerializedBatch.raw = String(serializedCandidate);
      }
      if (pendingSerializedTimer) global.clearTimeout?.(pendingSerializedTimer);
      pendingSerializedTimer = global.setTimeout?.(() => {
        pendingSerializedTimer = null;
        runScheduledSerializedWrite(false);
      }, COALESCE_DELAY_MS);
      return pendingSerializedBatch.promise;
    } catch (error) {
      console.warn('TaskPointsCore: could not queue IndexedDB dual-write; localStorage remains authoritative.', error);
      return null;
    }
  }

  async function getStatus(options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    if (!indexedDb) {
      return {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status: 'unavailable'
      };
    }
    let db = null;
    try {
      if (typeof indexedDb.databases === 'function') {
        const exists = (await indexedDb.databases()).some((entry) => entry.name === core.SHADOW_MIGRATION_DB_NAME);
        if (!exists) {
          return {
            schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
            phase: 'dual_write',
            status: 'not_started'
          };
        }
      }
      db = await openShadowDb(indexedDb);
      return (await readMetadata(db, METADATA_ID)) || {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status: 'not_started'
      };
    } catch (error) {
      return failedMetadata(error, new Date().toISOString(), 0);
    } finally {
      db?.close?.();
    }
  }

  function flush() {
    if (pendingSerializedBatch) {
      return Promise.resolve(runScheduledSerializedWrite(true))
        .then(() => queueTail)
        .catch(() => queueTail);
    }
    return queueTail.catch(() => undefined);
  }

  function installStorageHook() {
    if (global.__taskPointsPhase2StorageHookInstalled) return;
    const storage = global.localStorage;
    if (!storage || typeof storage.setItem !== 'function') return;

    const StorageCtor = global.Storage;
    if (StorageCtor?.prototype?.setItem) {
      const prototype = StorageCtor.prototype;
      if (prototype.__taskPointsPhase2OriginalSetItem) return;
      const original = prototype.setItem;
      Object.defineProperty(prototype, '__taskPointsPhase2OriginalSetItem', {
        value: original,
        configurable: true
      });
      prototype.setItem = function taskPointsPhase2SetItem(key, value) {
        const result = original.call(this, key, value);
        if (this === global.localStorage && String(key) === core.STORAGE_KEY) {
          scheduleFromStoredRaw(String(value));
        }
        return result;
      };
    } else {
      const original = storage.setItem.bind(storage);
      storage.setItem = function taskPointsPhase2SetItem(key, value) {
        const result = original(key, value);
        if (String(key) === core.STORAGE_KEY) scheduleFromStoredRaw(String(value));
        return result;
      };
    }
    global.__taskPointsPhase2StorageHookInstalled = true;
  }

  core.SHADOW_DUAL_WRITE_METADATA_ID = METADATA_ID;
  core.SHADOW_DUAL_WRITE_SNAPSHOT_ID = SNAPSHOT_ID;
  core.SHADOW_DUAL_WRITE_SNAPSHOT_FORMAT = SNAPSHOT_FORMAT;
  core.writeShadowDualWriteSnapshot = writeSnapshot;
  core.queueShadowDualWrite = queueWrite;
  core.flushShadowDualWrites = flush;
  core.getShadowDualWriteStatus = getStatus;
  core.getPendingShadowDualWriteCount = () => pendingCount + (pendingSerializedBatch ? 1 : 0);
  core.getShadowDualWriteQueueStatus = () => ({
    pendingImmediate: pendingCount,
    pendingCoalesced: Boolean(pendingSerializedBatch),
    waitingForMaintenanceQuiet: Boolean(pendingQuietGate),
    coalesceDelayMs: COALESCE_DELAY_MS,
    homeLongQuietEnabled,
    homeLongQuietMs: homeLongQuietEnabled ? HOME_LONG_QUIET_MS : 0,
    homeLongQuietDeferred,
    sourceCloneCount,
    detachedSourceReuseCount,
    metadataSnapshotWriteCount,
    legacyRowWriteCount,
    sharedSourceReuseCount,
    sharedSourceFallbackCount
  });
  core.scheduleShadowDualWriteFromSerializedState = (storageKey, raw) => (
    storageKey === core.STORAGE_KEY ? scheduleFromStoredRaw(raw) : null
  );

  installStorageHook();
})(typeof window !== 'undefined' ? window : globalThis);