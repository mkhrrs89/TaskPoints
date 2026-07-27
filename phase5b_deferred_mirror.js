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
  const DIAG = 'taskpoints_storage_data_loss_guard_v1';
  const DB = 'taskpoints_verified_secondary_v1';
  const STORE = 'snapshots';
  const COUNT_KEYS = ['tasks','completions','habits','players','flexActions','gameHistory','matchups','schedule','seasonHistory','reminders','weightHistory','vo2MaxHistory'];
  const MAJOR_KEYS = ['tasks','completions','habits','players','gameHistory','matchups','seasonHistory'];
  let pending = null;
  let running = false;
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

  async function mirror(raw) {
    if (!raw || get(KEY) !== raw) return false;
    const pendingJournal = journalCount();
    if (pendingJournal) {
      status({ phase5cLastStatus: 'waiting_for_habit_journal', phase5cPendingHabitJournalCount: pendingJournal, phase5cPendingWrite: false });
      return false;
    }
    let db;
    try {
      const state = parse(raw);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('secondary_unreadable');
      const sourceCounts = counts(state);
      const rawHash = hash(raw);
      const sourceStateHash = stateHash(state);
      db = await open();
      const candidate = { id: 'candidate', status: 'candidate_written', raw, rawHash, stateHash: sourceStateHash, counts: sourceCounts, writtenAtISO: new Date().toISOString() };
      const writeTx = db.transaction(STORE, 'readwrite');
      writeTx.objectStore(STORE).put(candidate);
      await done(writeTx);

      const verifyTx = db.transaction(STORE, 'readonly');
      const verifyDone = done(verifyTx);
      const readBack = await request(verifyTx.objectStore(STORE).get('candidate'));
      await verifyDone;
      const readState = parse(readBack?.raw || '');
      if (!readBack || readBack.raw !== raw || readBack.rawHash !== rawHash || stateHash(readState) !== sourceStateHash || !sameCounts(counts(readState), sourceCounts)) {
        throw new Error('secondary_candidate_verification_failed');
      }
      if (get(KEY) !== raw || journalCount()) throw new Error('secondary_candidate_invalidated');

      const verifiedAtISO = new Date().toISOString();
      const promoteTx = db.transaction(STORE, 'readwrite');
      const store = promoteTx.objectStore(STORE);
      store.put({ ...readBack, id: 'latest', status: 'passed_verification', verifiedAtISO });
      store.delete('candidate');
      await done(promoteTx);

      const latestTx = db.transaction(STORE, 'readonly');
      const latestDone = done(latestTx);
      const latest = await request(latestTx.objectStore(STORE).get('latest'));
      await latestDone;
      if (!latest || latest.raw !== raw || latest.rawHash !== rawHash || latest.status !== 'passed_verification') throw new Error('secondary_promotion_failed');
      const current = get(KEY) === raw && journalCount() === 0;
      status({ phase5cLastStatus: current ? 'passed_verification' : 'passed_verification_stale', phase5cLastVerifiedAtISO: verifiedAtISO, phase5cLastVerifiedRawHash: rawHash, phase5cLastVerifiedStateHash: sourceStateHash, phase5cLastVerifiedCounts: sourceCounts, phase5cMirrorsCurrentSave: current, phase5cPendingWrite: false, phase5cLastError: null });
      return true;
    } catch (error) {
      status({ phase5cLastStatus: 'verification_failed', phase5cLastFailureAtISO: new Date().toISOString(), phase5cMirrorsCurrentSave: false, phase5cPendingWrite: false, phase5cLastError: String(error?.message || error) });
      return false;
    } finally { try { db?.close?.(); } catch (_) {} }
  }

  async function run() {
    try {
      while (pending !== null) {
        const raw = pending;
        pending = null;
        await mirror(raw);
      }
      return true;
    } finally { running = false; }
  }
  function flush() {
    if (running || pending === null) return tail;
    running = true;
    tail = Promise.resolve().then(run).catch(() => false);
    return tail;
  }
  function queue(raw) {
    const value = String(raw || '');
    if (!value || get(KEY) !== value) return false;
    pending = value;
    status({ phase5cLastStatus: 'queued', phase5cQueuedAtISO: new Date().toISOString(), phase5cPendingWrite: true, phase5cLastError: null });
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(flush);
    else Promise.resolve().then(flush);
    return true;
  }
  function installHook() {
    try {
      const original = storage.setItem.bind(storage);
      const wrapped = function phase5cSetItem(key, value) {
        const result = original(key, value);
        if (String(key) === KEY && get(KEY) === String(value)) queue(String(value));
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
      if (this === storage && String(key) === KEY && get(KEY) === String(value)) queue(String(value));
      return result;
    };
    return true;
  }

  core.PHASE5C_VERIFIED_SECONDARY_DB_NAME = DB;
  core.PHASE5C_VERIFIED_SECONDARY_STORE_NAME = STORE;
  core.queuePhase5CVerifiedSecondaryWrite = () => { const raw = get(KEY); return raw ? queue(raw) : false; };
  core.flushPhase5CVerifiedSecondaryWrites = flush;
  core.getPhase5CVerifiedSecondaryStatus = () => {
    const d = json(get(DIAG), {}) || {};
    return { enabled: d.phase5cEnabled === true, installed: true, hookInstalled: d.phase5cHookInstalled === true, lastStatus: d.phase5cLastStatus || '', lastVerifiedAtISO: d.phase5cLastVerifiedAtISO || '', lastVerifiedRawHash: d.phase5cLastVerifiedRawHash || '', lastVerifiedCounts: d.phase5cLastVerifiedCounts || null, mirrorsCurrentSave: d.phase5cMirrorsCurrentSave === true, lastError: d.phase5cLastError || null, pendingWrite: running || pending !== null, authoritativeSource: 'localStorage', indexedDbReadsEnabled: false, indexedDbWriteBackEnabled: false };
  };

  const hookInstalled = installHook();
  status({ phase5cInstalledAtISO: new Date().toISOString(), phase5cHookInstalled: hookInstalled, phase5cLastStatus: hookInstalled ? 'waiting_for_successful_save' : 'hook_install_failed', phase5cPendingWrite: false, phase5cLastError: hookInstalled ? null : 'secondary_write_hook_unavailable' });
})(typeof window !== 'undefined' ? window : globalThis);
