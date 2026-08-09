(function installTaskPointsPhase4StorageCoordinator(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase4StorageCoordinatorInstalled) return;
  core.__phase4StorageCoordinatorInstalled = true;

  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';
  const SESSION_CACHE_KEY = 'taskpoints_phase4_verified_primary_cache_v1';
  const MODES = ['off', 'verify_primary_writes', 'indexeddb_primary'];
  const MODE_SET = new Set(MODES);
  const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];
  const CANDIDATE_ID = 'phase4_candidate';
  const PRIMARY_SNAPSHOT_ID = 'phase4_primary_snapshot';
  const PRIMARY_COMMIT_ID = 'phase4_primary_commit';

  let queueTail = Promise.resolve();
  let pendingCount = 0;
  let sequence = 0;
  let verifiedPrimaryCache = null;
  let writeLoopRunning = false;
  let requestedWriteRevision = 0;
  let latestWriteOptions = {};
  let backgroundWriteScheduled = false;
  let backgroundWriteGatePromise = null;
  let pendingBackgroundOptions = {};
  const MAX_RETRYABLE_ATTEMPTS = 2;
  const RETRY_BASE_DELAY_MS = 250;
  const TRANSACTION_TIMEOUT_MS = 20000;
  const RETRYABLE_WRITE_REASONS = new Set([
    'indexeddb_request_failed',
    'indexeddb_request_timeout',
    'indexeddb_transaction_aborted',
    'indexeddb_transaction_timeout',
    'indexeddb_open_failed',
    'indexeddb_open_blocked',
    'indexeddb_open_timeout',
    'TransactionInactiveError',
    'UnknownError',
    'AbortError',
    'forced_transaction_failure'
  ]);

  function nowIso() { return new Date().toISOString(); }
  function clone(value) {
    if (typeof global.structuredClone === 'function') return global.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; }
  }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function storageError(code, cause = null) {
    const error = new Error(code);
    error.code = code;
    error.cause = cause || null;
    return error;
  }
  function normalizedErrorReason(error) {
    const code = String(error?.code || '').trim();
    if (code) return code;
    const name = String(error?.name || '').trim();
    if (name && name !== 'Error') return name;
    return String(error?.message || error || 'phase4_write_failed');
  }
  function isRetryableWriteReason(reason) {
    return RETRYABLE_WRITE_REASONS.has(String(reason || ''));
  }
  function persistVerifiedPrimaryCache(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = {
      schemaVersion: 1,
      sequence: Number(value.sequence) || 0,
      state: value.state,
      serializedState: value.serializedState || JSON.stringify(value.state || {}),
      sourceHash: value.sourceHash || null,
      destinationHash: value.destinationHash || null,
      sourceCounts: value.sourceCounts || null,
      destinationCounts: value.destinationCounts || null,
      mirrorRaw: value.mirrorRaw ?? null,
      mirrorHash: value.mirrorHash || null,
      status: value.status || null,
      verifiedAt: value.verifiedAt || null
    };
    try {
      global.sessionStorage?.setItem?.(SESSION_CACHE_KEY, JSON.stringify(record));
      return true;
    } catch (_) {
      try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
      return false;
    }
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
      deferredWritesTotal: Number(previous.deferredWritesTotal) || 0,
      lastFallbackReason: previous.lastFallbackReason || null,
      resetTombstone: previous.resetTombstone === true,
      ...previous,
      ...patch,
      pendingWrites: patch.pendingWrites == null ? pendingCount : patch.pendingWrites
    };
    next.latestPassedSequence = Math.max(
      Number(previous.latestPassedSequence) || 0,
      Number(next.latestPassedSequence) || 0
    );
    next.latestQueuedSequence = Math.max(
      Number(previous.latestQueuedSequence) || 0,
      Number(previous.latestPassedSequence) || 0,
      Number(next.latestQueuedSequence) || 0,
      Number(next.latestPassedSequence) || 0
    );
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
    try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
    return true;
  }
  function setMode(mode) {
    const next = MODE_SET.has(mode) ? mode : 'off';
    try { global.localStorage?.setItem?.(MODE_KEY, next); } catch (_) {}
    if (next === 'off') {
      clearCaches();
      backgroundWriteScheduled = false;
      backgroundWriteGatePromise = null;
      pendingBackgroundOptions = {};
    }
    writeDiagnostics({ configuredMode: next, effectiveSource: 'localStorage', lastFallbackReason: null });
    return next;
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, storageError('indexeddb_request_timeout')), TRANSACTION_TIMEOUT_MS);
      request.onsuccess = () => finish(resolve, request.result);
      request.onerror = () => finish(reject, storageError('indexeddb_request_failed', request.error));
    });
  }
  function transactionPromise(tx) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        try { tx.abort?.(); } catch (_) {}
        finish(reject, storageError('indexeddb_transaction_timeout', tx.error));
      }, TRANSACTION_TIMEOUT_MS);
      tx.oncomplete = () => finish(resolve);
      tx.onabort = () => finish(reject, storageError('indexeddb_transaction_aborted', tx.error));
      // Safari can emit a bubbled error before the transaction reaches its
      // terminal abort or complete event. Wait for that terminal event.
      tx.onerror = () => undefined;
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
    if (!indexedDb) return Promise.reject(storageError('indexeddb_open_failed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, storageError('indexeddb_open_timeout')), TRANSACTION_TIMEOUT_MS);
      const request = indexedDb.open(core.SHADOW_MIGRATION_DB_NAME, core.SHADOW_MIGRATION_DB_VERSION || 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        [...ARRAY_STORES, 'collections'].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
        });
        if (!db.objectStoreNames.contains('values')) db.createObjectStore('values', { keyPath: 'field' });
        if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'id' });
      };
      request.onsuccess = () => finish(resolve, request.result);
      request.onerror = () => finish(reject, storageError('indexeddb_open_failed', request.error));
      request.onblocked = () => finish(reject, storageError('indexeddb_open_blocked'));
    });
  }

  function layoutFor(state) {
    return core.shadowSourceLayout(state && typeof state === 'object' ? state : {});
  }

  async function writeCandidate(db, state, raw, writeSequence, journalCount) {
    const summary = core.shadowSourceSummary(state);
    const serializedState = typeof raw === 'string' ? raw : JSON.stringify(state || {});
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({
      id: PRIMARY_SNAPSHOT_ID,
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      status: 'candidate_written',
      sequence: writeSequence,
      startedAt: nowIso(),
      serializedState,
      stateHash: summary.hashes.state,
      sourceCounts: summary.counts,
      mirrorHash: hashValue(serializedState),
      pendingJournalCount: journalCount,
      errors: []
    });
    tx.objectStore('metadata').put({
      id: CANDIDATE_ID,
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      status: 'candidate_written',
      sequence: writeSequence,
      startedAt: nowIso(),
      snapshotId: PRIMARY_SNAPSHOT_ID,
      snapshotFormat: 'metadata_raw_v1',
      sourceCounts: summary.counts,
      sourceHashes: summary.hashes,
      mirrorHash: hashValue(serializedState),
      pendingJournalCount: journalCount,
      errors: []
    });
    await transactionPromise(tx);
    return summary;
  }

  async function readLegacyState(db, candidate, primaryCommit) {
    const stores = [...ARRAY_STORES, 'collections', 'values'];
    const tx = db.transaction(stores, 'readonly');
    const arrayRequests = ARRAY_STORES.map((field) => requestPromise(tx.objectStore(field).getAll()));
    const collectionRequest = requestPromise(tx.objectStore('collections').getAll());
    const valuesRequest = requestPromise(tx.objectStore('values').getAll());
    const [arrayRows, collectionRows, valuesRows] = await Promise.all([
      Promise.all(arrayRequests), collectionRequest, valuesRequest
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
    return { state, candidate: candidate || null, primaryCommit: primaryCommit || null, snapshot: null, snapshotFormat: 'legacy_rows_v1' };
  }

  async function readState(db) {
    const tx = db.transaction('metadata', 'readonly');
    const snapshotRequest = requestPromise(tx.objectStore('metadata').get(PRIMARY_SNAPSHOT_ID));
    const candidateRequest = requestPromise(tx.objectStore('metadata').get(CANDIDATE_ID));
    const primaryCommitRequest = requestPromise(tx.objectStore('metadata').get(PRIMARY_COMMIT_ID));
    const [snapshot, candidate, primaryCommit] = await Promise.all([
      snapshotRequest, candidateRequest, primaryCommitRequest
    ]);
    if (snapshot?.serializedState && typeof snapshot.serializedState === 'string') {
      let state;
      try { state = core.parseTaskPointsStorageJson(snapshot.serializedState, {}) || {}; }
      catch (error) { throw storageError('primary_snapshot_parse_failed', error); }
      return {
        state,
        candidate: candidate || null,
        primaryCommit: primaryCommit || null,
        snapshot,
        snapshotFormat: 'metadata_raw_v1'
      };
    }
    return readLegacyState(db, candidate, primaryCommit);
  }

  async function restoreVerifiedPrimaryFromIndexedDb(options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    const rawBefore = safeGet(core.STORAGE_KEY);
    if (rawBefore === null) return { restored: false, reason: 'authoritative_missing' };
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) return { restored: false, reason: 'dual_write_pending' };
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) return { restored: false, reason: 'phase4_write_pending' };
    if (journalCount() > 0) return { restored: false, reason: 'pending_habit_journal' };

    let db = null;
    try {
      db = await openShadowDb(indexedDb);
      const rebuilt = await readState(db);
      const commit = rebuilt.primaryCommit;
      if (!commit || commit.status !== 'passed_verification') throw new Error('primary_commit_missing');

      const rawAfter = safeGet(core.STORAGE_KEY);
      if (rawAfter === null) throw new Error('authoritative_missing');
      if (rawAfter !== rawBefore) throw new Error('mirror_changed_during_restore');
      if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) throw new Error('dual_write_pending');
      if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) throw new Error('phase4_write_pending');
      if (journalCount() > 0) throw new Error('pending_habit_journal');

      const source = core.parseTaskPointsStorageJson(rawBefore, {}) || {};
      const sourceSummary = core.shadowSourceSummary(source);
      const destinationSummary = core.shadowSourceSummary(rebuilt.state);
      const countsMatch = core.shadowCanonicalJson(sourceSummary.counts) === core.shadowCanonicalJson(destinationSummary.counts);
      const hashesMatch = sourceSummary.hashes.state === destinationSummary.hashes.state;
      const canonicalMatch = core.shadowCanonicalJson(layoutFor(source)) === core.shadowCanonicalJson(layoutFor(rebuilt.state));
      const mismatches = core.shadowVerificationMismatches(sourceSummary, destinationSummary) || [];
      if (commit.mirrorHash && commit.mirrorHash !== hashValue(rawBefore)) throw new Error('committed_mirror_mismatch');
      if (rebuilt.snapshot) {
        if (Number(rebuilt.snapshot.sequence) !== Number(commit.sequence)) throw new Error('committed_snapshot_sequence_mismatch');
        if (rebuilt.snapshot.mirrorHash && rebuilt.snapshot.mirrorHash !== hashValue(rawBefore)) throw new Error('committed_snapshot_mirror_mismatch');
        if (rebuilt.snapshot.stateHash && rebuilt.snapshot.stateHash !== destinationSummary.hashes.state) throw new Error('committed_snapshot_hash_mismatch');
      }
      const committedSourceHash = commit.verification?.source?.hashes?.state;
      const committedDestinationHash = commit.verification?.destination?.hashes?.state;
      if (committedSourceHash && committedSourceHash !== sourceSummary.hashes.state) throw new Error('committed_source_hash_mismatch');
      if (committedDestinationHash && committedDestinationHash !== destinationSummary.hashes.state) throw new Error('committed_destination_hash_mismatch');
      if (!countsMatch || !hashesMatch || !canonicalMatch || mismatches.length) throw new Error('committed_primary_mismatch');

      const diagnostics = readDiagnostics();
      const verifiedAt = nowIso();
      const reconciledSequence = Math.max(
        Number(diagnostics.latestQueuedSequence) || 0,
        Number(diagnostics.latestPassedSequence) || 0,
        Number(commit.sequence) || 0,
        1
      );
      verifiedPrimaryCache = {
        schemaVersion: 1,
        sequence: reconciledSequence,
        committedSequence: Number(commit.sequence) || 0,
        state: clone(rebuilt.state),
        serializedState: rawBefore,
        sourceHash: sourceSummary.hashes.state,
        destinationHash: destinationSummary.hashes.state,
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        mirrorRaw: rawBefore,
        mirrorHash: hashValue(rawBefore),
        status: 'passed_verification',
        verifiedAt,
        restoredFromIndexedDb: true
      };
      persistVerifiedPrimaryCache(verifiedPrimaryCache);
      writeDiagnostics({
        configuredMode: getMode(),
        effectiveSource: getMode() === 'indexeddb_primary' ? 'indexedDB_ready' : 'localStorage',
        latestQueuedSequence: reconciledSequence,
        latestPassedSequence: reconciledSequence,
        lastVerifiedAt: verifiedAt,
        lastFallbackReason: null,
        cacheRestoredFromIndexedDb: true,
        countsMatch: true,
        hashesMatch: true,
        canonicalMatch: true,
        mismatches: [],
        cacheRestoredFromIndexedDb: false
      });
      return { restored: true, cache: verifiedPrimaryCache };
    } catch (error) {
      return { restored: false, reason: normalizedErrorReason(error) };
    } finally { db?.close?.(); }
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
      tx.objectStore('metadata').delete(PRIMARY_SNAPSHOT_ID);
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

  function nextSequence() {
    const diagnostics = readDiagnostics();
    sequence = Math.max(
      sequence,
      Number(diagnostics.latestQueuedSequence) || 0,
      Number(diagnostics.latestPassedSequence) || 0
    ) + 1;
    return sequence;
  }

  function queueAfterJournalCleared() {
    if (getMode() === 'off') return;
    if (journalCount() > 0) return;
    if (safeGet(core.STORAGE_KEY) === null) return;
    scheduleBackgroundWrite({ reason: 'habit_journal_cleared' });
  }

  async function performWrite(options = {}) {
    const indexedDb = options.indexedDB || global.indexedDB;
    const writeSequence = Number(options.sequence) || 0;
    const rawBefore = safeGet(core.STORAGE_KEY);
    if (rawBefore === null) return writeResetTombstone(indexedDb, writeSequence);

    const pendingJournalCount = journalCount();
    if (pendingJournalCount > 0) {
      clearCaches();
      const previous = readDiagnostics();
      return writeDiagnostics({
        effectiveSource: 'localStorage',
        latestQueuedSequence: writeSequence,
        lastFallbackAt: nowIso(),
        lastFallbackReason: 'pending_habit_journal',
        deferredWritesTotal: (Number(previous.deferredWritesTotal) || 0) + 1,
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
      if (Number(rebuilt.snapshot?.sequence) !== writeSequence) throw new Error('snapshot_sequence_mismatch');

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
        snapshotId: PRIMARY_SNAPSHOT_ID,
        snapshotFormat: 'metadata_raw_v1',
        verification,
        errors: []
      });
      verifiedPrimaryCache = {
        schemaVersion: 1,
        sequence: writeSequence,
        state: clone(rebuilt.state),
        serializedState: rawBefore,
        sourceHash: sourceSummary.hashes.state,
        destinationHash: destinationSummary.hashes.state,
        sourceCounts: sourceSummary.counts,
        destinationCounts: destinationSummary.counts,
        mirrorRaw: rawBefore,
        mirrorHash: hashValue(rawBefore),
        status: 'passed_verification',
        verifiedAt: completionTime
      };
      persistVerifiedPrimaryCache(verifiedPrimaryCache);
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
      const reason = normalizedErrorReason(error);
      const retryAttempt = Number(options.retryAttempt) || 0;
      const willRetry = isRetryableWriteReason(reason) && retryAttempt < MAX_RETRYABLE_ATTEMPTS;
      const deferred = willRetry || new Set([
        'pending_habit_journal',
        'dual_write_pending',
        'mirror_changed_during_verification'
      ]).has(reason);
      return writeDiagnostics({
        configuredMode: getMode(),
        effectiveSource: 'localStorage',
        latestQueuedSequence: writeSequence,
        lastFallbackAt: nowIso(),
        lastFallbackReason: reason,
        verificationFailuresTotal: (Number(previous.verificationFailuresTotal) || 0) + (deferred ? 0 : 1),
        deferredWritesTotal: (Number(previous.deferredWritesTotal) || 0) + (deferred ? 1 : 0),
        resetTombstone: false
      });
    } finally { db?.close?.(); }
  }

  async function runWriteLoop() {
    let retryAttempt = 0;
    try {
      while (getMode() !== 'off') {
        const targetRevision = requestedWriteRevision;
        const writeSequence = nextSequence();
        writeDiagnostics({ latestQueuedSequence: writeSequence, pendingWrites: 1 });
        const result = await performWrite({
          ...latestWriteOptions,
          sequence: writeSequence,
          retryAttempt
        });
        const reason = result?.lastFallbackReason || null;
        if (isRetryableWriteReason(reason) && retryAttempt < MAX_RETRYABLE_ATTEMPTS && getMode() !== 'off') {
          retryAttempt += 1;
          await delay(RETRY_BASE_DELAY_MS * retryAttempt);
          continue;
        }
        retryAttempt = 0;
        if (requestedWriteRevision === targetRevision) break;
      }
    } finally {
      pendingCount = 0;
      writeLoopRunning = false;
      writeDiagnostics({ pendingWrites: backgroundWriteScheduled ? 1 : 0 });
    }
  }

  function queueWrite(options = {}) {
    if (getMode() === 'off' && options.force !== true) return Promise.resolve({ status: 'off' });
    requestedWriteRevision += 1;
    latestWriteOptions = { ...latestWriteOptions, ...options };
    if (writeLoopRunning) return queueTail;

    writeLoopRunning = true;
    pendingCount = 1;
    writeDiagnostics({ pendingWrites: 1 });
    queueTail = Promise.resolve()
      .then(runWriteLoop)
      .catch((error) => {
        const previous = readDiagnostics();
        writeDiagnostics({
          effectiveSource: 'localStorage',
          lastFallbackAt: nowIso(),
          lastFallbackReason: normalizedErrorReason(error),
          verificationFailuresTotal: (Number(previous.verificationFailuresTotal) || 0) + 1
        });
      });
    return queueTail;
  }

  function backgroundReason(options = {}) {
    return String(options.reason || options.source || options.action || options.caller || 'authoritative_storage_write');
  }

  function scheduleBackgroundWrite(options = {}) {
    if (getMode() === 'off' && options.force !== true) return Promise.resolve({ status: 'off' });
    pendingBackgroundOptions = { ...pendingBackgroundOptions, ...options };
    if (backgroundWriteScheduled) return backgroundWriteGatePromise || Promise.resolve(true);

    backgroundWriteScheduled = true;
    writeDiagnostics({ pendingWrites: pendingCount + 1 });

    const run = () => {
      if (!backgroundWriteScheduled) return true;
      const queuedOptions = pendingBackgroundOptions;
      backgroundWriteScheduled = false;
      backgroundWriteGatePromise = null;
      pendingBackgroundOptions = {};
      return queueWrite(queuedOptions);
    };
    const gateOptions = { reason: `phase4_primary_write_${backgroundReason(options)}` };
    const startThroughGate = () => {
      const gate = core.whenStorageMaintenanceQuiet;
      return typeof gate === 'function' ? gate(run, gateOptions) : run();
    };

    if (typeof core.whenStorageMaintenanceQuiet === 'function') {
      backgroundWriteGatePromise = Promise.resolve(startThroughGate());
    } else if (typeof global.setTimeout === 'function') {
      backgroundWriteGatePromise = new Promise((resolve) => global.setTimeout(resolve, 0))
        .then(startThroughGate);
    } else {
      backgroundWriteGatePromise = Promise.resolve().then(run);
    }

    backgroundWriteGatePromise = backgroundWriteGatePromise.catch((error) => {
      backgroundWriteScheduled = false;
      backgroundWriteGatePromise = null;
      pendingBackgroundOptions = {};
      const previous = readDiagnostics();
      writeDiagnostics({
        pendingWrites: pendingCount,
        lastFallbackAt: nowIso(),
        lastFallbackReason: normalizedErrorReason(error),
        deferredWritesTotal: (Number(previous.deferredWritesTotal) || 0) + 1
      });
      return false;
    });
    return backgroundWriteGatePromise;
  }

  function flushWrites() {
    if (backgroundWriteScheduled) {
      const queuedOptions = pendingBackgroundOptions;
      backgroundWriteScheduled = false;
      backgroundWriteGatePromise = null;
      pendingBackgroundOptions = {};
      return Promise.resolve(queueWrite({
        ...queuedOptions,
        reason: queuedOptions.reason || 'flush_pending_background'
      })).then(() => queueTail).catch(() => queueTail);
    }
    return queueTail.catch(() => undefined);
  }

  function pendingWriteCount() {
    return pendingCount + (backgroundWriteScheduled ? 1 : 0);
  }

  function getStatus() {
    const diagnostics = readDiagnostics();
    return {
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      configuredMode: getMode(),
      effectiveSource: diagnostics.effectiveSource || 'localStorage',
      latestQueuedSequence: Number(diagnostics.latestQueuedSequence) || 0,
      latestPassedSequence: Number(diagnostics.latestPassedSequence) || 0,
      pendingWrites: pendingWriteCount(),
      lastCandidateWriteAt: diagnostics.lastCandidateWriteAt || null,
      lastVerifiedAt: diagnostics.lastVerifiedAt || null,
      lastFallbackAt: diagnostics.lastFallbackAt || null,
      lastFallbackReason: diagnostics.lastFallbackReason || null,
      indexedDbReadsTotal: Number(diagnostics.indexedDbReadsTotal) || 0,
      fallbackReadsTotal: Number(diagnostics.fallbackReadsTotal) || 0,
      verificationFailuresTotal: Number(diagnostics.verificationFailuresTotal) || 0,
      deferredWritesTotal: Number(diagnostics.deferredWritesTotal) || 0,
      countsMatch: diagnostics.countsMatch === true,
      hashesMatch: diagnostics.hashesMatch === true,
      canonicalMatch: diagnostics.canonicalMatch === true,
      mismatches: Array.isArray(diagnostics.mismatches) ? diagnostics.mismatches : [],
      resetTombstone: diagnostics.resetTombstone === true,
      cacheReadyThisPage: Boolean(verifiedPrimaryCache),
      currentMirrorMatchesCache: Boolean(verifiedPrimaryCache && safeGet(core.STORAGE_KEY) === verifiedPrimaryCache.mirrorRaw),
      cacheRestoredFromIndexedDb: diagnostics.cacheRestoredFromIndexedDb === true || Boolean(verifiedPrimaryCache?.restoredFromIndexedDb)
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
          const normalizedKey = String(key);
          if (normalizedKey === core.STORAGE_KEY && getMode() !== 'off') {
            scheduleBackgroundWrite({ reason: 'authoritative_storage_set' });
          } else if (normalizedKey === core.PENDING_HABIT_DELTAS_KEY) {
            queueAfterJournalCleared();
          }
          return result;
        };
        const wrappedRemove = originalRemove ? function phase4RemoveItem(key) {
          const result = originalRemove(key);
          const normalizedKey = String(key);
          if (normalizedKey === core.STORAGE_KEY && getMode() !== 'off') {
            scheduleBackgroundWrite({ reason: 'authoritative_storage_remove' });
          } else if (normalizedKey === core.PENDING_HABIT_DELTAS_KEY) {
            queueAfterJournalCleared();
          }
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
        if (this === global.localStorage) {
          const normalizedKey = String(key);
          if (normalizedKey === core.STORAGE_KEY && getMode() !== 'off') {
            scheduleBackgroundWrite({ reason: 'authoritative_storage_set' });
          } else if (normalizedKey === core.PENDING_HABIT_DELTAS_KEY) {
            queueAfterJournalCleared();
          }
        }
        return result;
      };
    }
    if (prototype.removeItem && !prototype.__taskPointsPhase4OriginalRemoveItem) {
      const originalRemove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsPhase4OriginalRemoveItem', { value: originalRemove, configurable: true });
      prototype.removeItem = function phase4RemoveItem(key) {
        const result = originalRemove.call(this, key);
        if (this === global.localStorage) {
          const normalizedKey = String(key);
          if (normalizedKey === core.STORAGE_KEY && getMode() !== 'off') {
            scheduleBackgroundWrite({ reason: 'authoritative_storage_remove' });
          } else if (normalizedKey === core.PENDING_HABIT_DELTAS_KEY) {
            queueAfterJournalCleared();
          }
        }
        return result;
      };
    }
  }

  core.PHASE4_STORAGE_MODE_KEY = MODE_KEY;
  core.PHASE4_DIAGNOSTICS_KEY = DIAGNOSTICS_KEY;
  core.PHASE4_SESSION_CACHE_KEY = SESSION_CACHE_KEY;
  core.PHASE4_STORAGE_MODES = MODES.slice();
  core.PHASE4_CANDIDATE_METADATA_ID = CANDIDATE_ID;
  core.PHASE4_PRIMARY_SNAPSHOT_METADATA_ID = PRIMARY_SNAPSHOT_ID;
  core.PHASE4_PRIMARY_COMMIT_METADATA_ID = PRIMARY_COMMIT_ID;
  core.getPhase4StorageMode = getMode;
  core.setPhase4StorageMode = setMode;
  core.queuePhase4PrimaryWrite = queueWrite;
  core.flushPhase4PrimaryWrites = flushWrites;
  core.getPendingPhase4WriteCount = pendingWriteCount;
  core.getPhase4StorageStatus = getStatus;
  core.clearPhase4Caches = clearCaches;
  core.getPhase4VerifiedPrimaryCache = () => verifiedPrimaryCache;
  core.persistPhase4VerifiedPrimaryCache = persistVerifiedPrimaryCache;
  core.restorePhase4CommittedPrimary = restoreVerifiedPrimaryFromIndexedDb;
  core.setPhase4VerifiedPrimaryCache = (value, options = {}) => {
    verifiedPrimaryCache = value || null;
    if (!verifiedPrimaryCache) {
      if (options.clearSession !== false) {
        try { global.sessionStorage?.removeItem?.(SESSION_CACHE_KEY); } catch (_) {}
      }
    } else if (options.persist !== false) {
      persistVerifiedPrimaryCache(verifiedPrimaryCache);
    }
    return verifiedPrimaryCache;
  };

  installStorageHooks();
  writeDiagnostics({ configuredMode: getMode(), effectiveSource: 'localStorage', pendingWrites: 0 });
})(typeof window !== 'undefined' ? window : globalThis);
