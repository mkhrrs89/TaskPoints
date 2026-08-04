from pathlib import Path
import re

INDEX = Path('index.html')
PHASE5C = Path('phase5b_deferred_mirror.js')
TEST = Path('tests/home_indexeddb_first_boot_contract.test.js')

index = INDEX.read_text(encoding='utf-8')
phase5c = PHASE5C.read_text(encoding='utf-8')

head_marker = """    })();
  </script>
  <title>TaskPoints — To-Do + Points Tracker</title>"""
head_replacement = """    })();
  </script>
  <script src=\"home_indexeddb_bootstrap.js\"></script>
  <title>TaskPoints — To-Do + Points Tracker</title>"""
if 'src="home_indexeddb_bootstrap.js"' not in index:
    if index.count(head_marker) != 1:
        raise SystemExit(f'Expected one Home head bootstrap marker, found {index.count(head_marker)}')
    index = index.replace(head_marker, head_replacement, 1)

state_pattern = re.compile(
    r"let state = \(\(\) => \{\n.*?\n\}\)\(\);\n\n  // ---------- Derived cache",
    re.DOTALL,
)
state_replacement = """let state = (() => {
  const nativeBoot = window.TaskPointsHomeNativeBoot;
  const nativeCandidate = nativeBoot?.takeReadyState?.() || null;

  if (nativeCandidate && window.TaskPointsCore?.prepareHomeNativeState) {
    if (__TP_PERF_BOOT) console.time('LOAD: IndexedDB native prepare');
    const prepared = TaskPointsCore.prepareHomeNativeState(nativeCandidate, {
      syncDerived: false,
      persistSync: false
    });
    if (__TP_PERF_BOOT) console.timeEnd('LOAD: IndexedDB native prepare');

    if (prepared?.ok && prepared.state) {
      const s = normalizeState(prepared.state);
      storageCache.parsed = s;
      storageCache.raw = null;
      window.__TP_HOME_BOOT_SOURCE = 'indexeddb-native';
      if (window.TP_DEBUG_PERF) {
        const completions = Array.isArray(s?.completions) ? s.completions.length : 0;
        console.log(`[TP home boot] source=indexeddb-native completions=${completions}`, nativeBoot.recordMeta || null);
      }
      return s;
    }
  }

  window.__TP_HOME_BOOT_SOURCE = `localStorage:${nativeBoot?.reason || nativeBoot?.status || 'native-unavailable'}`;
  if (__TP_PERF_BOOT) console.time('LOAD: normalizeState(load())');
  const s = normalizeState(load());
  if (__TP_PERF_BOOT) console.timeEnd('LOAD: normalizeState(load())');
  if (window.TP_DEBUG_PERF) {
    const completions = Array.isArray(s?.completions) ? s.completions.length : 0;
    console.log(`[TP home boot] source=${window.__TP_HOME_BOOT_SOURCE} completions=${completions}`);
  }
  return s;
})();

  // ---------- Derived cache"""
match = state_pattern.search(index)
if not match:
    raise SystemExit('Could not locate Home state initializer')
if "window.__TP_HOME_BOOT_SOURCE = 'indexeddb-native';" not in match.group(0):
    index = index[:match.start()] + state_replacement + index[match.end():]

verified_secondary = r'''(function installTaskPointsVerifiedSecondary(global) {
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
      while (pending !== null) {
        const raw = pending;
        pending = null;
        await mirror(raw);
      }
      return true;
    } finally { running = false; }
  }
  function flush() {
    if (running) return tail.then(() => pending !== null ? flush() : true);
    if (pending === null) return tail;
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

  function prepareHomeNativeState(sourceState) {
    try {
      if (!sourceState || typeof sourceState !== 'object' || Array.isArray(sourceState)) {
        return { ok: false, reason: 'native_state_invalid', state: null };
      }
      const pendingHabitDeltas = core.readPendingHabitDeltas?.() || [];
      if (pendingHabitDeltas.length) {
        return { ok: false, reason: 'pending_habit_journal', state: null };
      }
      let state = typeof core.normalizeState === 'function'
        ? core.normalizeState(sourceState)
        : sourceState;
      const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
      state.tasks = Array.isArray(state.tasks)
        ? state.tasks.filter((task) => {
            if (!task || task.status !== 'trashed') return true;
            const deletedMs = Date.parse(task.deletedAtISO || task.deletedAt || '');
            return Number.isFinite(deletedMs) && deletedMs >= cutoff;
          })
        : [];
      return {
        ok: true,
        reason: null,
        state,
        storageKeysFound: [KEY],
        pendingHabitDeltas: []
      };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error || 'native_prepare_failed'), state: null };
    }
  }

  core.PHASE5C_VERIFIED_SECONDARY_DB_NAME = DB;
  core.PHASE5C_VERIFIED_SECONDARY_STORE_NAME = STORE;
  core.HOME_NATIVE_SNAPSHOT_ID = HOME_NATIVE_ID;
  core.HOME_NATIVE_SNAPSHOT_FORMAT = HOME_NATIVE_FORMAT;
  core.prepareHomeNativeState = prepareHomeNativeState;
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
})(typeof window !== 'undefined' ? window : globalThis);'''

phase_pattern = re.compile(
    r"\(function installTaskPointsVerifiedSecondary\(global\) \{.*?\n\}\)\(typeof window !== 'undefined' \? window : globalThis\);\n\n(?=\(function installTaskPointsRecoveryWriteLockGuard)",
    re.DOTALL,
)
phase_match = phase_pattern.search(phase5c)
if not phase_match:
    raise SystemExit('Could not locate verified-secondary module')
if "const HOME_NATIVE_ID = 'home_native_latest';" not in phase_match.group(0):
    phase5c = phase5c[:phase_match.start()] + verified_secondary + '\n\n' + phase5c[phase_match.end():]

INDEX.write_text(index, encoding='utf-8')
PHASE5C.write_text(phase5c, encoding='utf-8')

TEST.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'home_indexeddb_bootstrap.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const phase5c = fs.readFileSync(path.join(root, 'phase5b_deferred_mirror.js'), 'utf8');

function hashRaw(raw) {
  const text = String(raw || '');
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function makeRecord(raw, revision = 'revision-one') {
  return {
    id: 'home_native_latest',
    schemaVersion: 1,
    snapshotFormat: 'home_structured_clone_v1',
    status: 'passed_verification',
    state: { tasks: [{ id: 'task-1' }], completions: [] },
    rawHash: hashRaw(raw),
    rawLength: raw.length,
    rawHead: raw.slice(0, 64),
    rawTail: raw.slice(-64),
    revision,
    verifiedAtISO: '2026-08-04T20:00:00.000Z',
    stateHash: 'state-hash'
  };
}

async function runBootstrap({ raw = 'compressed-authoritative-state', revision = 'revision-one', journal = '[]', record = null } = {}) {
  const values = new Map([
    ['taskpoints_v1', raw],
    ['taskpoints_state_revision_v1', revision],
    ['taskpoints_pending_habit_deltas_v1', journal]
  ]);
  const localStorage = {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); }
  };
  const storedRecord = record === null ? makeRecord(raw, revision) : record;
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains(name) { return name === 'snapshots'; } },
          transaction() {
            const transaction = {
              objectStore() {
                return {
                  get() {
                    const read = {};
                    queueMicrotask(() => {
                      read.result = storedRecord;
                      read.onsuccess?.();
                      queueMicrotask(() => transaction.oncomplete?.());
                    });
                    return read;
                  }
                };
              }
            };
            return transaction;
          },
          close() {}
        };
        request.onsuccess?.();
      });
      return request;
    }
  };
  const context = {
    window: null,
    globalThis: null,
    localStorage,
    indexedDB,
    location: { search: '' },
    performance: { now: (() => { let value = 0; return () => ++value; })() },
    URLSearchParams,
    Promise,
    JSON,
    String,
    Number,
    Object,
    Array,
    Math,
    Date,
    console,
    queueMicrotask
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(bootstrap, context);
  await context.TaskPointsHomeNativeBoot.promise;
  return { context, values };
}

test('Home starts the native IndexedDB read before the main app script', () => {
  const bootstrapAt = home.indexOf('<script src="home_indexeddb_bootstrap.js"></script>');
  const coreAt = home.indexOf('<script src="scoring_core.js"></script>');
  assert.ok(bootstrapAt >= 0);
  assert.ok(coreAt > bootstrapAt);
  assert.match(home, /const nativeCandidate = nativeBoot\?\.takeReadyState\?\.\(\) \|\| null;/);
  assert.match(home, /TaskPointsCore\.prepareHomeNativeState\(nativeCandidate/);
  assert.match(home, /window\.__TP_HOME_BOOT_SOURCE = 'indexeddb-native';/);
  assert.match(home, /const s = normalizeState\(load\(\)\);/);
});

test('a matching verified native snapshot is consumed without parsing the compressed mirror', async () => {
  const { context } = await runBootstrap();
  const api = context.TaskPointsHomeNativeBoot;
  assert.equal(api.status, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(api.takeReadyState())), {
    tasks: [{ id: 'task-1' }],
    completions: []
  });
  assert.equal(api.status, 'consumed');
});

test('a source change after the IndexedDB read forces the existing fallback path', async () => {
  const { context, values } = await runBootstrap();
  assert.equal(context.TaskPointsHomeNativeBoot.status, 'ready');
  values.set('taskpoints_v1', 'new-authoritative-state');
  assert.equal(context.TaskPointsHomeNativeBoot.takeReadyState(), null);
  assert.equal(context.TaskPointsHomeNativeBoot.status, 'fallback');
  assert.equal(context.TaskPointsHomeNativeBoot.reason, 'authoritative_changed_after_native_read');
});

test('pending habit journal prevents native state use', async () => {
  const { context } = await runBootstrap({ journal: '[{"id":"pending"}]' });
  assert.equal(context.TaskPointsHomeNativeBoot.status, 'fallback');
  assert.equal(context.TaskPointsHomeNativeBoot.reason, 'pending_habit_journal');
});

test('verified secondary atomically promotes a structured Home snapshot', () => {
  assert.match(phase5c, /const HOME_NATIVE_ID = 'home_native_latest';/);
  assert.match(phase5c, /snapshotFormat: HOME_NATIVE_FORMAT/);
  assert.match(phase5c, /store\.put\(\{[\s\S]*id: HOME_NATIVE_ID/);
  assert.match(phase5c, /request\(latestStore\.get\(HOME_NATIVE_ID\)\)/);
  assert.match(phase5c, /stateHash\(nativeLatest\.state\) !== sourceStateHash/);
  assert.match(phase5c, /core\.prepareHomeNativeState = prepareHomeNativeState;/);
  assert.match(phase5c, /core\.readPendingHabitDeltas\?\.\(\) \|\| \[\]/);
  assert.match(phase5c, /global\.requestIdleCallback\(backfill, \{ timeout: 5000 \}\)/);
});
''', encoding='utf-8')
