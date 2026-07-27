(function installTaskPointsStorageDataLossGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__storageDataLossGuardInstalled) return;
  core.__storageDataLossGuardInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const DIAG_KEY = 'taskpoints_storage_data_loss_guard_v1';
  const VAULT_DB_NAME = 'taskpoints_safety_vault_v1';
  const VAULT_DB_VERSION = 1;
  const VAULT_STORE = 'snapshots';
  const VAULT_SLOT_IDS = ['latest', 'prev1', 'prev2', 'prev3'];
  const VAULT_ROTATION_MS = 6 * 60 * 60 * 1000;
  const CRITICAL_ARRAYS = [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders'
  ];
  const MAJOR_ARRAYS = ['tasks', 'completions', 'habits', 'players', 'gameHistory', 'matchups', 'seasonHistory'];

  let destructiveAllowanceDepth = 0;
  let vaultTail = Promise.resolve();
  let alertShown = false;

  const storage = global.localStorage;
  const get = (key) => {
    try { return storage?.getItem?.(key) ?? null; }
    catch (_) { return null; }
  };
  const directSet = (key, value) => {
    try { storage?.setItem?.(key, value); return true; }
    catch (_) { return false; }
  };

  function parseState(raw) {
    if (!raw) return null;
    try { return core.parseTaskPointsStorageJson?.(String(raw), null) ?? JSON.parse(String(raw)); }
    catch (_) { return null; }
  }

  function summarize(state) {
    const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    const counts = Object.fromEntries(CRITICAL_ARRAYS.map((key) => [key, Array.isArray(source[key]) ? source[key].length : 0]));
    counts.majorTotal = MAJOR_ARRAYS.reduce((total, key) => total + counts[key], 0);
    counts.total = CRITICAL_ARRAYS.reduce((total, key) => total + counts[key], 0);
    return counts;
  }

  function rawHash(raw) {
    const text = String(raw || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  }

  function readDiagnostics() {
    try {
      const parsed = JSON.parse(get(DIAG_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }

  function writeDiagnostics(patch) {
    const value = {
      schemaVersion: 1,
      enabled: true,
      phase5bLiveBundleDisabled: true,
      ...readDiagnostics(),
      ...patch
    };
    try {
      storage?.setItem?.(DIAG_KEY, JSON.stringify(value));
    } catch (_) {}
  }

  function suspiciousReplacement(previousRaw, candidateRaw) {
    if (!previousRaw || String(previousRaw) === String(candidateRaw)) return null;
    const previousState = parseState(previousRaw);
    const candidateState = parseState(candidateRaw);
    const previous = summarize(previousState);
    const candidate = summarize(candidateState);

    if (previous.majorTotal < 50) return null;
    if (!candidateState) return { reason: 'candidate_unreadable', previous, candidate };

    const majorLoss = previous.majorTotal - candidate.majorTotal;
    const majorRatio = previous.majorTotal ? candidate.majorTotal / previous.majorTotal : 1;
    const nearlyEmpty = candidate.majorTotal <= Math.max(5, Math.floor(previous.majorTotal * 0.02));
    const catastrophicDrop = majorLoss >= 100 && majorRatio < 0.05;
    const criticalHistoryCollapse = (
      (previous.completions >= 100 && candidate.completions < previous.completions * 0.05)
      || (previous.matchups >= 100 && candidate.matchups < previous.matchups * 0.05)
      || (previous.gameHistory >= 100 && candidate.gameHistory < previous.gameHistory * 0.05)
      || (previous.players >= 10 && candidate.players === 0)
    );

    if (!nearlyEmpty && !catastrophicDrop && !criticalHistoryCollapse) return null;
    return {
      reason: nearlyEmpty ? 'candidate_nearly_empty' : (criticalHistoryCollapse ? 'critical_history_collapse' : 'catastrophic_record_drop'),
      previous,
      candidate
    };
  }

  function blockReplacement(details) {
    const error = new Error('TaskPoints blocked a suspicious destructive state overwrite. The previous saved data was preserved.');
    error.code = 'TASKPOINTS_SUSPICIOUS_STATE_OVERWRITE_BLOCKED';
    error.details = details;
    writeDiagnostics({
      lastBlockedAtISO: new Date().toISOString(),
      lastBlockedReason: details?.reason || 'unknown',
      previousCounts: details?.previous || null,
      candidateCounts: details?.candidate || null,
      blockedWritesTotal: Number(readDiagnostics().blockedWritesTotal || 0) + 1
    });
    console.error(error.message, details);
    if (!alertShown && typeof global.alert === 'function') {
      alertShown = true;
      try { global.alert(`${error.message}\n\nDo not reset or import anything until Storage Health is checked.`); } catch (_) {}
    }
    throw error;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Safety vault request failed.'));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Safety vault transaction aborted.'));
      tx.onerror = () => undefined;
    });
  }

  function openVault() {
    if (!global.indexedDB) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Safety vault could not be opened.'));
      request.onblocked = () => reject(new Error('Safety vault is blocked.'));
    });
  }

  async function writeVaultSnapshot(raw, reason = 'known-good-mirror') {
    const state = parseState(raw);
    const counts = summarize(state);
    if (!state || counts.majorTotal < 30) return false;

    let db;
    try {
      db = await openVault();
      if (!db) return false;
      const readTx = db.transaction(VAULT_STORE, 'readonly');
      const readStore = readTx.objectStore(VAULT_STORE);
      const slots = await Promise.all(VAULT_SLOT_IDS.map((id) => requestResult(readStore.get(id))));
      const latest = slots[0] || null;
      const candidateHash = rawHash(raw);
      if (latest?.rawHash === candidateHash) return true;

      const nowMs = Date.now();
      const latestMs = Date.parse(latest?.createdAtISO || latest?.updatedAtISO || '');
      if (latest && Number.isFinite(latestMs) && nowMs - latestMs < VAULT_ROTATION_MS) return true;

      const timestamp = new Date(nowMs).toISOString();
      const nextRecords = [];
      for (let index = VAULT_SLOT_IDS.length - 1; index >= 1; index -= 1) {
        const prior = slots[index - 1];
        if (prior) nextRecords.push({ ...prior, id: VAULT_SLOT_IDS[index] });
      }
      nextRecords.push({
        id: 'latest',
        schemaVersion: 1,
        createdAtISO: timestamp,
        reason,
        raw: String(raw),
        rawHash: candidateHash,
        counts
      });

      const writeTx = db.transaction(VAULT_STORE, 'readwrite');
      const writeStore = writeTx.objectStore(VAULT_STORE);
      nextRecords.forEach((record) => writeStore.put(record));
      await transactionDone(writeTx);
      writeDiagnostics({
        lastVaultWriteAtISO: timestamp,
        lastVaultReason: reason,
        lastVaultCounts: counts,
        lastVaultError: null
      });
      return true;
    } catch (error) {
      writeDiagnostics({
        lastVaultFailureAtISO: new Date().toISOString(),
        lastVaultError: String(error?.message || error)
      });
      return false;
    } finally { db?.close?.(); }
  }

  function queueVaultSnapshot(raw, reason) {
    vaultTail = vaultTail.then(() => writeVaultSnapshot(raw, reason)).catch(() => false);
    return vaultTail;
  }

  function shouldAllowDestructiveOptions(options = {}) {
    if (options.storageSafetyBypass === true) return true;
    if (options.allowDestructiveOverwrite !== true) return false;
    const label = String(options.source || options.savePath || options.reason || options.caller || '');
    return /(import|restore|reset|backup|recovery|migration|quarantine)/i.test(label);
  }

  function withAllowance(fn) {
    destructiveAllowanceDepth += 1;
    try { return fn(); }
    finally { destructiveAllowanceDepth -= 1; }
  }

  function wrapDestructiveEntryPoint(name) {
    const original = core[name];
    if (typeof original !== 'function' || original.__taskpointsDataLossGuardWrapped) return;
    const wrapped = function guardedDestructiveEntryPoint(state, options = {}) {
      if (!shouldAllowDestructiveOptions(options)) return original.call(core, state, options);
      return withAllowance(() => original.call(core, state, options));
    };
    wrapped.__taskpointsDataLossGuardWrapped = true;
    core[name] = wrapped;
  }

  function installStorageHook() {
    if (!storage) return;

    try {
      if (!storage.__taskpointsDataLossGuardInstanceSetItem && typeof storage.setItem === 'function') {
        const previousSetItem = storage.setItem.bind(storage);
        const wrapped = function guardedTaskPointsInstanceSetItem(key, value) {
          const targetKey = String(key);
          const candidateRaw = String(value);
          if (targetKey === STORAGE_KEY && destructiveAllowanceDepth === 0) {
            const details = suspiciousReplacement(get(STORAGE_KEY), candidateRaw);
            if (details) blockReplacement(details);
          }
          const result = previousSetItem(key, value);
          if (targetKey === STORAGE_KEY) queueVaultSnapshot(candidateRaw, 'verified-state-write');
          return result;
        };
        storage.setItem = wrapped;
        if (storage.setItem === wrapped) {
          Object.defineProperty(storage, '__taskpointsDataLossGuardInstanceSetItem', { value: true, configurable: true });
          return;
        }
      }
    } catch (_) {}

    const prototype = global.Storage?.prototype;
    if (prototype?.setItem && !prototype.__taskpointsDataLossGuardSetItem) {
      const previousSetItem = prototype.setItem;
      Object.defineProperty(prototype, '__taskpointsDataLossGuardSetItem', { value: previousSetItem, configurable: true });
      prototype.setItem = function guardedTaskPointsSetItem(key, value) {
        const targetKey = String(key);
        const candidateRaw = String(value);
        if (this === storage && targetKey === STORAGE_KEY && destructiveAllowanceDepth === 0) {
          const details = suspiciousReplacement(get(STORAGE_KEY), candidateRaw);
          if (details) blockReplacement(details);
        }
        const result = previousSetItem.call(this, key, value);
        if (this === storage && targetKey === STORAGE_KEY) queueVaultSnapshot(candidateRaw, 'verified-state-write');
        return result;
      };
    }
  }

  core.PHASE5B_LIVE_BUNDLE_DISABLED = true;
  core.__phase5bDeferredMirrorInstalled = false;
  core.getPhase5BStatus = () => ({
    enabled: false,
    installed: false,
    disabledForSafety: true,
    reason: 'phase5b_disabled_after_empty_state_overwrite',
    journalPresent: Boolean(get('taskpoints_phase5b_pending_changes_v1'))
  });
  core.flushPhase5BNativeWrites = () => Promise.resolve();
  core.flushPhase5BMirrorCheckpoint = () => false;
  core.TASKPOINTS_SAFETY_VAULT_DB_NAME = VAULT_DB_NAME;
  core.TASKPOINTS_SAFETY_VAULT_STORE = VAULT_STORE;
  core.withTaskPointsDestructiveWriteAllowed = (fn) => withAllowance(fn);
  core.flushTaskPointsSafetyVault = () => vaultTail.catch(() => undefined);
  core.getTaskPointsDataLossGuardStatus = () => ({
    installed: true,
    phase5bLiveBundleDisabled: true,
    destructiveAllowanceActive: destructiveAllowanceDepth > 0,
    diagnostics: readDiagnostics()
  });

  wrapDestructiveEntryPoint('saveValidatedSnapshot');
  wrapDestructiveEntryPoint('saveStateSnapshot');
  installStorageHook();

  if (get(HOLD_KEY)) directSet(MODE_KEY, 'off');
  const currentRaw = get(STORAGE_KEY);
  if (currentRaw) queueVaultSnapshot(currentRaw, 'startup-known-good');
  writeDiagnostics({ installedAtISO: new Date().toISOString(), lastInstallError: null });
})(typeof window !== 'undefined' ? window : globalThis);
