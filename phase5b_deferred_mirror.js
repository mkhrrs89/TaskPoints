(function installTaskPointsPhase5BKillSwitch(global) {
  'use strict';
  const core = global.TaskPointsCore;
  if (!core) return;
  core.PHASE5B_LIVE_BUNDLE_DISABLED = true;
  core.__phase5bDeferredMirrorInstalled = false;
  core.getPhase5BStatus = () => ({
    enabled: false,
    installed: false,
    disabledForSafety: true,
    reason: 'phase5b_disabled_after_empty_state_overwrite',
    journalPresent: Boolean(global.localStorage?.getItem?.('taskpoints_phase5b_pending_changes_v1'))
  });
  core.flushPhase5BNativeWrites = () => Promise.resolve();
  core.flushPhase5BMirrorCheckpoint = () => false;
  if (!core.__storageDataLossGuardInstalled) {
    try { global.localStorage?.setItem?.('taskpoints_phase4_storage_mode_v1', 'off'); } catch (_) {}
    console.error('TaskPoints storage data-loss guard was not installed; IndexedDB Primary remains disabled.');
  }
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsVerifiedSecondary(global) {
  'use strict';
  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__phase5cVerifiedSecondaryInstalled || !core.__storageDataLossGuardInstalled) return;
  core.__phase5cVerifiedSecondaryInstalled = true;

  const KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const JOURNAL = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const REVISION = 'taskpoints_state_revision_v1';
  const DIAG = 'taskpoints_storage_data_loss_guard_v1';
  const DB = 'taskpoints_verified_secondary_v1';
  const STORE = 'snapshots';
  const HOME_NATIVE_ID = 'home_native_latest';
  const HOME_NATIVE_FORMAT = 'home_structured_clone_v1';
  const COUNT_KEYS = ['tasks','completions','habits','players','flexActions','gameHistory','matchups','schedule','seasonHistory','reminders','weightHistory','vo2MaxHistory'];
  const MAJOR_KEYS = ['tasks','completions','habits','players','gameHistory','matchups','seasonHistory'];
  let pending = null;
  let running = false;
  let scheduled = false;
  let activeRaw = null;
  let tail = Promise.resolve(false);

  const get = (key) => { try { return storage.getItem(key); } catch (_) { return null; } };
  const json = (raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } };
  const hash = (raw) => {
    const text = String(raw || '');
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  };
  const fingerprint = (raw) => {
    const text = String(raw || '');
    return {
      rawHash: hash(text),
      rawLength: text.length,
      rawHead: text.slice(0, 64),
      rawTail: text.slice(-64)
    };
  };
  const parse = (raw) => typeof core.parseTaskPointsStorageJson === 'function'
    ? core.parseTaskPointsStorageJson(raw, null)
    : JSON.parse(raw);
  const counts = (state) => {
    const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    const result = Object.fromEntries(COUNT_KEYS.map((key) => [key, Array.isArray(source[key]) ? source[key].length : 0]));
    result.total = COUNT_KEYS.reduce((sum, key) => sum + result[key], 0);
    result.majorTotal = MAJOR_KEYS.reduce((sum, key) => sum + result[key], 0);
    return result;
  };
  const stateHash = (state) => core.shadowSourceSummary?.(state || {})?.hashes?.state
    || core.shadowCanonicalJson?.(state || {})
    || JSON.stringify(state || {});
  const sameCounts = (a, b) => [...COUNT_KEYS, 'total', 'majorTotal']
    .every((key) => Number(a?.[key] || 0) === Number(b?.[key] || 0));
  const journalCount = () => {
    const raw = get(JOURNAL);
    if (!raw) return 0;
    const parsed = json(raw, null);
    if (Array.isArray(parsed)) return parsed.length;
    if (Array.isArray(parsed?.operations)) return parsed.operations.length;
    return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 1;
  };
  const status = (patch) => {
    const current = json(get(DIAG), {}) || {};
    const next = { ...current, phase5cEnabled: true, phase5cAuthoritativeSource: 'localStorage', phase5cIndexedDbReadsEnabled: false, phase5cIndexedDbWriteBackEnabled: false, ...patch };
    try { storage.setItem(DIAG, JSON.stringify(next)); } catch (_) {}
    return next;
  };
  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('secondary_request_failed'));
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('secondary_transaction_aborted'));
    tx.onerror = () => undefined;
  });
  const open = () => new Promise((resolve, reject) => {
    if (!global.indexedDB) { reject(new Error('secondary_indexeddb_unavailable')); return; }
    const req = global.indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('secondary_open_failed'));
    req.onblocked = () => reject(new Error('secondary_open_blocked'));
  });

  function promoteCandidate(db, candidate, raw, verifiedAtISO, nativeRecord) {
    return new Promise((resolve, reject) => {
      let intendedAbort = '';
      let promotedRevision = '';
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const latestRequest = store.get('latest');
      latestRequest.onerror = () => reject(latestRequest.error || new Error('secondary_latest_check_failed'));
      latestRequest.onsuccess = () => {
        const currentRaw = get(KEY);
        const pendingJournal = journalCount();
        if (currentRaw !== raw || pendingJournal) {
          intendedAbort = pendingJournal ? 'journal_pending' : 'authoritative_changed';
          try { transaction.abort(); } catch (_) {}
          return;
        }
        promotedRevision = String(get(REVISION) || '');
        store.put({ ...candidate, id: 'latest', status: 'passed_verification', verifiedAtISO });
        store.put({
          ...nativeRecord,
          id: HOME_NATIVE_ID,
          revision: promotedRevision,
          status: 'passed_verification',
          verifiedAtISO
        });
        store.delete(candidate.id);
      };
      transaction.oncomplete = () => resolve({ promoted: true, reason: '', revision: promotedRevision });
      transaction.onabort = () => intendedAbort
        ? resolve({ promoted: false, reason: intendedAbort, revision: '' })
        : reject(transaction.error || new Error('secondary_promotion_aborted'));
      transaction.onerror = () => undefined;
    });
  }

  async function mirror(raw) {
    if (!raw || get(KEY) !== raw) return false;
    const pendingJournal = journalCount();
    if (pendingJournal) {
      status({ phase5cLastStatus: 'waiting_for_habit_journal', phase5cPendingHabitJournalCount: pendingJournal, phase5cMirrorsCurrentSave: false, phase5cPendingWrite: false });
      return false;
    }
    let db;
    try {
      const state = parse(raw);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('secondary_unreadable');
      const sourceCounts = counts(state);
      const sourceFingerprint = fingerprint(raw);
      const sourceStateHash = stateHash(state);
      db = await open();
      const candidate = {
        id: 'candidate',
        status: 'candidate_written',
        raw,
        rawHash: sourceFingerprint.rawHash,
        stateHash: sourceStateHash,
        counts: sourceCounts,
        writtenAtISO: new Date().toISOString()
      };
      const writeTx = db.transaction(STORE, 'readwrite');
      writeTx.objectStore(STORE).put(candidate);
      await done(writeTx);

      const verifyTx = db.transaction(STORE, 'readonly');
      const verifyDone = done(verifyTx);
      const readBack = await request(verifyTx.objectStore(STORE).get('candidate'));
      await verifyDone;
      const readState = parse(readBack?.raw || '');
      if (!readBack
        || readBack.raw !== raw
        || readBack.rawHash !== sourceFingerprint.rawHash
        || stateHash(readState) !== sourceStateHash
        || !sameCounts(counts(readState), sourceCounts)) {
        throw new Error('secondary_candidate_verification_failed');
      }
      if (get(KEY) !== raw || journalCount()) throw new Error('secondary_candidate_invalidated');

      const verifiedAtISO = new Date().toISOString();
      const nativeRecord = {
        schemaVersion: 1,
        snapshotFormat: HOME_NATIVE_FORMAT,
        state: readState,
        stateHash: sourceStateHash,
        counts: sourceCounts,
        ...sourceFingerprint
      };
      const promotion = await promoteCandidate(db, readBack, raw, verifiedAtISO, nativeRecord);
      if (!promotion.promoted) {
        const currentRaw = get(KEY);
        const pendingJournal = journalCount();
        status({
          phase5cLastStatus: pendingJournal ? 'waiting_for_habit_journal' : 'passed_verification_stale',
          phase5cPendingHabitJournalCount: pendingJournal,
          phase5cMirrorsCurrentSave: false,
          phase5cPendingWrite: false,
          phase5cLastError: null
        });
        if (!pendingJournal && currentRaw) queue(currentRaw);
        return false;
      }

      const latestTx = db.transaction(STORE, 'readonly');
      const latestDone = done(latestTx);
      const latestStore = latestTx.objectStore(STORE);
      const [latest, nativeLatest] = await Promise.all([
        request(latestStore.get('latest')),
        request(latestStore.get(HOME_NATIVE_ID))
      ]);
      await latestDone;
      if (!latest
        || latest.raw !== raw
        || latest.rawHash !== sourceFingerprint.rawHash
        || latest.status !== 'passed_verification') {
        throw new Error('secondary_promotion_failed');
      }
      if (!nativeLatest
        || nativeLatest.status !== 'passed_verification'
        || nativeLatest.snapshotFormat !== HOME_NATIVE_FORMAT
        || nativeLatest.rawHash !== sourceFingerprint.rawHash
        || Number(nativeLatest.rawLength) !== sourceFingerprint.rawLength
        || String(nativeLatest.rawHead || '') !== sourceFingerprint.rawHead
        || String(nativeLatest.rawTail || '') !== sourceFingerprint.rawTail
        || String(nativeLatest.revision || '') !== String(promotion.revision || '')
        || stateHash(nativeLatest.state) !== sourceStateHash
        || !sameCounts(counts(nativeLatest.state), sourceCounts)) {
        throw new Error('home_native_promotion_failed');
      }
      const current = get(KEY) === raw && journalCount() === 0;
      status({
        phase5cLastStatus: current ? 'passed_verification' : 'passed_verification_stale',
        phase5cLastVerifiedAtISO: verifiedAtISO,
        phase5cLastVerifiedRawHash: sourceFingerprint.rawHash,
        phase5cLastVerifiedStateHash: sourceStateHash,
        phase5cLastVerifiedCounts: sourceCounts,
        phase5cMirrorsCurrentSave: current,
        phase5cPendingWrite: false,
        phase5cLastError: null,
        phase5cHomeNativeStatus: current ? 'passed_verification' : 'passed_verification_stale',
        phase5cHomeNativeVerifiedAtISO: verifiedAtISO,
        phase5cHomeNativeRawHash: sourceFingerprint.rawHash,
        phase5cHomeNativeRevision: promotion.revision || '',
        phase5cHomeNativeLastError: null
      });
      return true;
    } catch (error) {
      status({
        phase5cLastStatus: 'verification_failed',
        phase5cLastFailureAtISO: new Date().toISOString(),
        phase5cMirrorsCurrentSave: false,
        phase5cPendingWrite: false,
        phase5cLastError: String(error?.message || error),
        phase5cHomeNativeStatus: 'verification_failed',
        phase5cHomeNativeLastError: String(error?.message || error)
      });
      return false;
    } finally { try { db?.close?.(); } catch (_) {} }
  }

  async function run() {
    try {
      if (pending === null) return true;
      const raw = pending;
      pending = null;
      activeRaw = raw;
      await mirror(raw);
      return true;
    } finally {
      activeRaw = null;
      running = false;
      if (pending !== null) scheduleFlush();
    }
  }
  function flush() {
    scheduled = false;
    if (running) return tail.then(() => pending !== null ? flush() : true);
    if (pending === null) return tail;
    running = true;
    tail = Promise.resolve().then(run).catch(() => false);
    return tail;
  }
  function scheduleFlush() {
    if (scheduled || running || pending === null) return false;
    scheduled = true;
    const execute = () => {
      scheduled = false;
      return pending === null ? true : flush();
    };
    const launch = () => {
      if (pending === null) { scheduled = false; return; }
      if (typeof core.whenStorageMaintenanceQuiet === 'function') {
        Promise.resolve(core.whenStorageMaintenanceQuiet(execute, { source: 'phase5c_verified_secondary' }))
          .catch(() => { scheduled = false; });
        return;
      }
      if (typeof global.requestIdleCallback === 'function') {
        global.requestIdleCallback(execute, { timeout: 12000 });
      } else {
        global.setTimeout?.(execute, 2500);
      }
    };
    if (typeof global.setTimeout === 'function') global.setTimeout(launch, 0);
    else Promise.resolve().then(launch);
    return true;
  }
  function queue(raw) {
    const value = String(raw || '');
    if (!value || get(KEY) !== value) return false;
    if (pending === value || activeRaw === value) return true;
    const existing = json(get(DIAG), {}) || {};
    const alreadyVerified = existing.phase5cLastStatus === 'passed_verification'
      && existing.phase5cMirrorsCurrentSave === true
      && existing.phase5cLastVerifiedRawHash === hash(value)
      && journalCount() === 0;
    if (alreadyVerified) return false;
    pending = value;
    status({
      phase5cLastStatus: 'queued_waiting_for_idle',
      phase5cQueuedAtISO: new Date().toISOString(),
      phase5cMirrorsCurrentSave: false,
      phase5cPendingWrite: true,
      phase5cLastError: null
    });
    scheduleFlush();
    return true;
  }
  function handleJournalState() {
    const pendingJournal = journalCount();
    if (pendingJournal === 0) {
      const currentRaw = get(KEY);
      if (currentRaw) queue(currentRaw);
    } else {
      status({ phase5cLastStatus: 'waiting_for_habit_journal', phase5cPendingHabitJournalCount: pendingJournal, phase5cMirrorsCurrentSave: false, phase5cPendingWrite: false });
    }
  }
  function installHook() {
    try {
      const original = storage.setItem.bind(storage);
      const wrapped = function phase5cSetItem(key, value) {
        const result = original(key, value);
        const storageKey = String(key);
        if (storageKey === KEY && get(KEY) === String(value)) queue(String(value));
        else if (storageKey === JOURNAL) handleJournalState();
        return result;
      };
      storage.setItem = wrapped;
      if (storage.setItem === wrapped) return true;
    } catch (_) {}
    const prototype = global.Storage?.prototype;
    if (!prototype?.setItem || prototype.__taskPointsPhase5COriginalSetItem) return false;
    const original = prototype.setItem;
    Object.defineProperty(prototype, '__taskPointsPhase5COriginalSetItem', { value: original, configurable: true });
    prototype.setItem = function phase5cSetItem(key, value) {
      const result = original.call(this, key, value);
      if (this !== storage) return result;
      const storageKey = String(key);
      if (storageKey === KEY && get(KEY) === String(value)) queue(String(value));
      else if (storageKey === JOURNAL) handleJournalState();
      return result;
    };
    return true;
  }

  core.PHASE5C_VERIFIED_SECONDARY_DB_NAME = DB;
  core.PHASE5C_VERIFIED_SECONDARY_STORE_NAME = STORE;
  core.HOME_NATIVE_SNAPSHOT_ID = HOME_NATIVE_ID;
  core.HOME_NATIVE_SNAPSHOT_FORMAT = HOME_NATIVE_FORMAT;
  core.queuePhase5CVerifiedSecondaryWrite = () => { const raw = get(KEY); return raw ? queue(raw) : false; };
  core.flushPhase5CVerifiedSecondaryWrites = flush;
  core.getPhase5CVerifiedSecondaryStatus = () => {
    const d = json(get(DIAG), {}) || {};
    return {
      enabled: d.phase5cEnabled === true,
      installed: true,
      hookInstalled: d.phase5cHookInstalled === true,
      lastStatus: d.phase5cLastStatus || '',
      lastVerifiedAtISO: d.phase5cLastVerifiedAtISO || '',
      lastVerifiedRawHash: d.phase5cLastVerifiedRawHash || '',
      lastVerifiedCounts: d.phase5cLastVerifiedCounts || null,
      mirrorsCurrentSave: d.phase5cMirrorsCurrentSave === true,
      lastError: d.phase5cLastError || null,
      pendingWrite: running || pending !== null,
      authoritativeSource: 'localStorage',
      indexedDbReadsEnabled: false,
      indexedDbWriteBackEnabled: false,
      homeNativeStatus: d.phase5cHomeNativeStatus || '',
      homeNativeVerifiedAtISO: d.phase5cHomeNativeVerifiedAtISO || '',
      homeNativeRawHash: d.phase5cHomeNativeRawHash || '',
      homeNativeRevision: d.phase5cHomeNativeRevision || '',
      homeNativeLastError: d.phase5cHomeNativeLastError || null
    };
  };

  const hookInstalled = installHook();
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', (event) => {
      if (event?.storageArea && event.storageArea !== storage) return;
      if (event?.key === KEY && event.newValue && get(KEY) === event.newValue) queue(event.newValue);
      else if (event?.key === JOURNAL) handleJournalState();
    });
  }
  const existingStatus = json(get(DIAG), {}) || {};
  const currentRaw = get(KEY);
  const currentRawHash = currentRaw ? hash(currentRaw) : '';
  const verifiedStillCurrent = Boolean(hookInstalled
    && currentRaw
    && existingStatus.phase5cLastStatus === 'passed_verification'
    && existingStatus.phase5cMirrorsCurrentSave === true
    && existingStatus.phase5cLastVerifiedRawHash === currentRawHash
    && journalCount() === 0);
  const homeNativeKnownCurrent = Boolean(currentRaw
    && existingStatus.phase5cHomeNativeStatus === 'passed_verification'
    && existingStatus.phase5cHomeNativeRawHash === currentRawHash
    && journalCount() === 0);
  status({
    phase5cInstalledAtISO: new Date().toISOString(),
    phase5cHookInstalled: hookInstalled,
    phase5cLastStatus: hookInstalled
      ? (verifiedStillCurrent ? 'passed_verification' : 'waiting_for_successful_save')
      : 'hook_install_failed',
    phase5cMirrorsCurrentSave: verifiedStillCurrent,
    phase5cPendingWrite: false,
    phase5cLastError: hookInstalled ? null : 'secondary_write_hook_unavailable'
  });

  if (hookInstalled && currentRaw && !homeNativeKnownCurrent && journalCount() === 0) {
    const backfill = () => {
      const latestRaw = get(KEY);
      if (latestRaw && journalCount() === 0) queue(latestRaw);
    };
    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(backfill, { timeout: 5000 });
    } else {
      global.setTimeout?.(backfill, 2500);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);

(function installTaskPointsRecoveryWriteLockGuard(global) {
  'use strict';
  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__recoveryWriteLockGuardInstalled) return;
  core.__recoveryWriteLockGuardInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const LOCK_KEY = 'taskpoints_recovery_write_lock_v1';
  const PAGE_STARTED_AT_MS = Date.now();
  let alertShown = false;

  function readLock() {
    try {
      const lock = JSON.parse(storage.getItem(LOCK_KEY) || 'null');
      return lock && lock.active === true && lock.token ? lock : null;
    } catch (_) { return null; }
  }

  function thisPageMayWrite(lock) {
    const committedAtMs = Number(lock?.committedAtMs || 0);
    return committedAtMs > 0 && PAGE_STARTED_AT_MS >= committedAtMs;
  }

  function assertWriteAllowed(operation) {
    const lock = readLock();
    if (!lock || thisPageMayWrite(lock)) return;
    const error = new Error('TaskPoints blocked a save from a tab that was open before a confirmed recovery. Reload this tab before making changes.');
    error.code = 'TASKPOINTS_RECOVERY_WRITE_LOCKED';
    error.operation = operation;
    error.lock = lock;
    console.error(error.message, { operation, lock });
    if (!alertShown && typeof global.alert === 'function') {
      alertShown = true;
      try { global.alert(`${error.message}\n\nYour recovered data remains protected.`); } catch (_) {}
    }
    throw error;
  }

  function installInstanceHooks() {
    try {
      const priorSet = storage.setItem.bind(storage);
      const priorRemove = storage.removeItem.bind(storage);
      const guardedSet = function recoveryLockedSetItem(key, value) {
        if (String(key) === STORAGE_KEY) assertWriteAllowed('setItem');
        return priorSet(key, value);
      };
      const guardedRemove = function recoveryLockedRemoveItem(key) {
        if (String(key) === STORAGE_KEY) assertWriteAllowed('removeItem');
        return priorRemove(key);
      };
      storage.setItem = guardedSet;
      storage.removeItem = guardedRemove;
      return storage.setItem === guardedSet && storage.removeItem === guardedRemove;
    } catch (_) { return false; }
  }

  function installPrototypeHooks() {
    const prototype = global.Storage?.prototype;
    if (!prototype) return false;
    if (prototype.setItem && !prototype.__taskPointsRecoveryLockOriginalSetItem) {
      const priorSet = prototype.setItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryLockOriginalSetItem', { value: priorSet, configurable: true });
      prototype.setItem = function recoveryLockedSetItem(key, value) {
        if (this === storage && String(key) === STORAGE_KEY) assertWriteAllowed('setItem');
        return priorSet.call(this, key, value);
      };
    }
    if (prototype.removeItem && !prototype.__taskPointsRecoveryLockOriginalRemoveItem) {
      const priorRemove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsRecoveryLockOriginalRemoveItem', { value: priorRemove, configurable: true });
      prototype.removeItem = function recoveryLockedRemoveItem(key) {
        if (this === storage && String(key) === STORAGE_KEY) assertWriteAllowed('removeItem');
        return priorRemove.call(this, key);
      };
    }
    return true;
  }

  const installed = installInstanceHooks() || installPrototypeHooks();
  core.RECOVERY_WRITE_LOCK_KEY = LOCK_KEY;
  core.getRecoveryWriteLockStatus = () => ({
    installed,
    pageStartedAtMs: PAGE_STARTED_AT_MS,
    lock: readLock(),
    pageMayWrite: !readLock() || thisPageMayWrite(readLock())
  });
})(typeof window !== 'undefined' ? window : globalThis);
