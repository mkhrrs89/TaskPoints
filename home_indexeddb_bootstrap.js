(function installTaskPointsHomeNativeBoot(global) {
  'use strict';

  if (!global || global.TaskPointsHomeNativeBoot) return;

  const STORAGE_KEY = 'taskpoints_v1';
  const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
  const REVISION_KEY = 'taskpoints_state_revision_v1';
  const DB_NAME = 'taskpoints_verified_secondary_v1';
  const STORE_NAME = 'snapshots';
  const RECORD_ID = 'home_native_latest';
  const SNAPSHOT_FORMAT = 'home_structured_clone_v1';
  const startedAt = global.performance?.now?.() ?? Date.now();
  const perfEnabled = Boolean(
    global.TP_DEBUG_PERF
    || (() => {
      try { return new URLSearchParams(global.location?.search || '').has('perf'); }
      catch (_) { return false; }
    })()
  );

  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

  const api = {
    status: 'warming',
    reason: null,
    state: null,
    revision: '',
    authoritativeRaw: null,
    recordMeta: null,
    elapsedMs: 0,
    promise: readyPromise,
    takeReadyState: null
  };
  global.TaskPointsHomeNativeBoot = api;

  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; }
    catch (_) { return null; }
  }

  function pendingJournalIsEmpty(raw) {
    if (!raw) return true;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length === 0;
      if (Array.isArray(parsed?.operations)) return parsed.operations.length === 0;
      return parsed && typeof parsed === 'object'
        ? Object.keys(parsed).length === 0
        : false;
    } catch (_) {
      return false;
    }
  }

  function hashRaw(raw) {
    const text = String(raw || '');
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  }

  function fingerprint(raw) {
    const text = String(raw || '');
    return {
      rawHash: hashRaw(text),
      rawLength: text.length,
      rawHead: text.slice(0, 64),
      rawTail: text.slice(-64)
    };
  }

  function finish(status, reason = null, patch = {}) {
    api.status = status;
    api.reason = reason;
    Object.assign(api, patch);
    api.elapsedMs = (global.performance?.now?.() ?? Date.now()) - startedAt;
    if (status !== 'ready') {
      api.state = null;
      api.authoritativeRaw = null;
    }
    if (perfEnabled) {
      console.log('[TP home native boot]', {
        status: api.status,
        reason: api.reason,
        elapsedMs: Number(api.elapsedMs.toFixed?.(1) ?? api.elapsedMs),
        recordMeta: api.recordMeta
      });
    }
    resolveReady(api);
    return api;
  }

  function currentSourceStillMatches() {
    const currentRaw = safeGet(STORAGE_KEY);
    if (currentRaw === null || currentRaw !== api.authoritativeRaw) return false;
    if (!pendingJournalIsEmpty(safeGet(JOURNAL_KEY))) return false;
    const currentRevision = String(safeGet(REVISION_KEY) || '');
    if ((api.revision || currentRevision) && currentRevision !== api.revision) return false;
    return true;
  }

  api.takeReadyState = function takeReadyState() {
    if (api.status !== 'ready' || !api.state) return null;
    if (!currentSourceStillMatches()) {
      finish('fallback', 'authoritative_changed_after_native_read');
      return null;
    }
    const state = api.state;
    api.state = null;
    api.authoritativeRaw = null;
    api.status = 'consumed';
    return state;
  };

  const authoritativeRaw = safeGet(STORAGE_KEY);
  if (authoritativeRaw === null) {
    finish('fallback', 'authoritative_missing');
    return;
  }
  if (!pendingJournalIsEmpty(safeGet(JOURNAL_KEY))) {
    finish('fallback', 'pending_habit_journal');
    return;
  }
  if (!global.indexedDB) {
    finish('fallback', 'indexeddb_unavailable');
    return;
  }

  api.authoritativeRaw = authoritativeRaw;
  api.revision = String(safeGet(REVISION_KEY) || '');

  let databaseWasMissing = false;
  let request;
  try {
    // No version is supplied: opening an existing database is allowed, while a
    // missing database is detected and its creation transaction is aborted.
    request = global.indexedDB.open(DB_NAME);
  } catch (_) {
    finish('fallback', 'indexeddb_open_exception');
    return;
  }

  request.onupgradeneeded = () => {
    databaseWasMissing = true;
    try { request.transaction?.abort?.(); } catch (_) {}
  };
  request.onblocked = () => finish('fallback', 'indexeddb_open_blocked');
  request.onerror = () => finish(
    'fallback',
    databaseWasMissing ? 'native_database_missing' : 'indexeddb_open_failed'
  );
  request.onsuccess = () => {
    const db = request.result;
    if (!db?.objectStoreNames?.contains?.(STORE_NAME)) {
      try { db?.close?.(); } catch (_) {}
      finish('fallback', 'native_store_missing');
      return;
    }

    let transaction;
    try {
      transaction = db.transaction(STORE_NAME, 'readonly');
    } catch (_) {
      try { db?.close?.(); } catch (_) {}
      finish('fallback', 'native_transaction_failed');
      return;
    }

    const readRequest = transaction.objectStore(STORE_NAME).get(RECORD_ID);
    readRequest.onerror = () => finish('fallback', 'native_record_read_failed');
    readRequest.onsuccess = () => {
      const record = readRequest.result;
      const sourceFingerprint = fingerprint(authoritativeRaw);
      const revisionMatches = !((record?.revision || api.revision)
        && String(record?.revision || '') !== api.revision);
      const recordMatches = Boolean(
        record
        && record.id === RECORD_ID
        && record.schemaVersion === 1
        && record.snapshotFormat === SNAPSHOT_FORMAT
        && record.status === 'passed_verification'
        && record.state
        && typeof record.state === 'object'
        && !Array.isArray(record.state)
        && record.rawHash === sourceFingerprint.rawHash
        && Number(record.rawLength) === sourceFingerprint.rawLength
        && String(record.rawHead || '') === sourceFingerprint.rawHead
        && String(record.rawTail || '') === sourceFingerprint.rawTail
        && revisionMatches
      );

      if (!recordMatches) {
        finish('fallback', record ? 'native_snapshot_stale' : 'native_snapshot_missing');
        return;
      }

      finish('ready', null, {
        state: record.state,
        recordMeta: {
          verifiedAtISO: record.verifiedAtISO || '',
          rawHash: record.rawHash,
          stateHash: record.stateHash || '',
          revision: record.revision || ''
        }
      });
    };
    transaction.oncomplete = () => { try { db.close(); } catch (_) {} };
    transaction.onabort = () => {
      try { db.close(); } catch (_) {}
      if (api.status === 'warming') finish('fallback', 'native_transaction_aborted');
    };
    transaction.onerror = () => undefined;
  };
})(typeof window !== 'undefined' ? window : globalThis);
