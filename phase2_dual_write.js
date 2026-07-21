(function installTaskPointsPhase2DualWrite(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase2DualWriteInstalled) return;
  core.__phase2DualWriteInstalled = true;

  const METADATA_ID = 'dual_write';
  const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];
  let queueTail = Promise.resolve();
  let pendingCount = 0;
  let sequence = 0;

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
    if (typeof global.structuredClone === 'function') return global.structuredClone(state);
    return JSON.parse(JSON.stringify(state));
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
    const source = cloneState(state && typeof state === 'object' ? state : {});
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

      const sourceSummary = core.shadowSourceSummary(source);
      await putMetadata(db, METADATA_ID, {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status: 'running',
        startedAt,
        completionTime: null,
        sequence: writeSequence,
        errors: [],
        sourceCounts: sourceSummary.counts,
        destinationCounts: {},
        verification: null
      });

      await writeStores(db, source);
      const rebuilt = await readStores(db);
      const destinationSummary = core.shadowSourceSummary(rebuilt);
      const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary);
      const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
      const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
      const status = countsMatch && hashesMatch ? 'passed_verification' : 'failed';
      const metadata = {
        schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
        phase: 'dual_write',
        status,
        startedAt,
        completionTime: new Date().toISOString(),
        sequence: writeSequence,
        errors: status === 'failed' ? ['Dual-write verification did not pass.'] : [],
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        verification: {
          countsMatch,
          hashesMatch,
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
      await putMetadata(db, METADATA_ID, metadata);
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

  function stateFromLatestStoredRaw(capturedRaw) {
    try {
      const latestRaw = global.localStorage?.getItem?.(core.STORAGE_KEY);
      // A confirmed missing authoritative key represents an empty state. Never
      // fall back to an older captured payload, which could resurrect data
      // after Reset All in this page or another open TaskPoints tab.
      if (latestRaw === null) return {};
      if (typeof latestRaw === 'string') {
        return latestRaw ? core.parseTaskPointsStorageJson(latestRaw, {}) : {};
      }
    } catch (_) {
      // If localStorage cannot be read, the captured successful setItem payload
      // is the safest fallback available for this single write.
    }
    return capturedRaw ? core.parseTaskPointsStorageJson(capturedRaw, {}) : {};
  }

  function queueWrite(state, options = {}) {
    const snapshot = state && typeof state === 'object' ? cloneState(state) : null;
    const writeSequence = ++sequence;
    pendingCount += 1;

    const operation = queueTail
      .catch(() => undefined)
      .then(() => {
        const source = snapshot || stateFromLatestStoredRaw(options.serializedCandidate);
        return writeSnapshot(source, { ...options, sequence: writeSequence });
      })
      .finally(() => {
        pendingCount = Math.max(0, pendingCount - 1);
      });

    // Keep the internal queue alive after a failed operation. Callers still get
    // the operation result, while localStorage remains authoritative.
    queueTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function scheduleFromStoredRaw(serializedCandidate) {
    try {
      const operation = queueWrite(null, { serializedCandidate });
      operation.catch((error) => {
        console.warn('TaskPointsCore: IndexedDB dual-write failed; localStorage remains authoritative.', error);
      });
      return operation;
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
  core.writeShadowDualWriteSnapshot = writeSnapshot;
  core.queueShadowDualWrite = queueWrite;
  core.flushShadowDualWrites = flush;
  core.getShadowDualWriteStatus = getStatus;
  core.getPendingShadowDualWriteCount = () => pendingCount;
  core.scheduleShadowDualWriteFromSerializedState = (storageKey, raw) => (
    storageKey === core.STORAGE_KEY ? scheduleFromStoredRaw(raw) : null
  );

  installStorageHook();
})(typeof window !== 'undefined' ? window : globalThis);
