(function installTaskPointsPhase2ResetHook(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core?.queueShadowDualWrite || !storage || global.__taskPointsPhase2ResetHookInstalled) return;

  function scheduleEmptySnapshotWhenStillRemoved(key) {
    const run = () => {
      try {
        // safeReplaceTaskPointsStorage temporarily removes the key before a
        // synchronous replacement write. Wait one microtask so that path does
        // not enqueue a false reset. The explicit Reset All flow leaves it
        // absent, so only that confirmed authoritative removal is mirrored.
        if (storage.getItem(key) === null) {
          try { core.clearPendingTaskMutations?.(); } catch (_) {}
          const operation = core.queueShadowDualWrite({}, { reset: true });
          operation?.catch?.((error) => {
            console.warn('TaskPointsCore: shadow reset failed; localStorage remains authoritative.', error);
          });
        }
      } catch (error) {
        console.warn('TaskPointsCore: could not mirror the confirmed localStorage reset.', error);
      }
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(run);
    else Promise.resolve().then(run);
  }

  const StorageCtor = global.Storage;
  if (StorageCtor?.prototype?.removeItem) {
    const prototype = StorageCtor.prototype;
    if (prototype.__taskPointsPhase2OriginalRemoveItem) return;
    const original = prototype.removeItem;
    Object.defineProperty(prototype, '__taskPointsPhase2OriginalRemoveItem', {
      value: original,
      configurable: true
    });
    prototype.removeItem = function taskPointsPhase2RemoveItem(key) {
      const normalizedKey = String(key);
      const matched = this === storage && normalizedKey === core.STORAGE_KEY;
      const result = original.call(this, normalizedKey);
      if (matched) scheduleEmptySnapshotWhenStillRemoved(normalizedKey);
      return result;
    };
  } else if (typeof storage.removeItem === 'function') {
    const original = storage.removeItem.bind(storage);
    storage.removeItem = function taskPointsPhase2RemoveItem(key) {
      const normalizedKey = String(key);
      const result = original(normalizedKey);
      if (normalizedKey === core.STORAGE_KEY) scheduleEmptySnapshotWhenStillRemoved(normalizedKey);
      return result;
    };
  }

  global.__taskPointsPhase2ResetHookInstalled = true;
})(typeof window !== 'undefined' ? window : globalThis);

// Install the catastrophic-overwrite guard from the always-loaded Phase 2
// safety floor. It must protect the mirror before Phase 4 or Phase 5A can run.
(function installTaskPointsStorageDataLossGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__storageDataLossGuardInstalled) return;
  core.__storageDataLossGuardInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const DIAG_KEY = 'taskpoints_storage_data_loss_guard_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const LEGACY_JOURNAL_MARKER_KEY = 'taskpoints_phase5b_journal_reconciled_v1';
  const VAULT_DB_NAME = 'taskpoints_safety_vault_v1';
  const VAULT_DB_VERSION = 1;
  const VAULT_STORE = 'snapshots';
  const VAULT_SLOT_IDS = ['latest', 'prev1', 'prev2', 'prev3'];
  const VAULT_ROTATION_MS = 6 * 60 * 60 * 1000;
  const VAULT_META_KEY = 'taskpoints_safety_vault_meta_v1';
  const CRITICAL_ARRAYS = [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders'
  ];
  const MAJOR_ARRAYS = ['tasks', 'completions', 'habits', 'players', 'gameHistory', 'matchups', 'seasonHistory'];

  let destructiveAllowanceDepth = 0;
  let vaultTail = Promise.resolve();
  let vaultDrainRunning = false;
  let pendingVaultCandidate = null;
  let alertShown = false;
  let rememberedRemovedRaw = null;
  let rememberedRemovalToken = 0;

  const clone = (value) => typeof global.structuredClone === 'function'
    ? global.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  const get = (key) => {
    try { return storage.getItem(key); }
    catch (_) { return null; }
  };
  const set = (key, value) => {
    try { storage.setItem(key, value); return true; }
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

  function stateHash(state) {
    try {
      return core.shadowSourceSummary?.(state || {})?.hashes?.state
        || (core.shadowCanonicalJson ? core.shadowCanonicalJson(state || {}) : JSON.stringify(state || {}));
    } catch (_) { return null; }
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
    try { storage.setItem(DIAG_KEY, JSON.stringify(value)); } catch (_) {}
  }

  function readVaultMeta() {
    try {
      const parsed = JSON.parse(get(VAULT_META_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      if (parsed.schemaVersion !== 1 || typeof parsed.latestRawHash !== 'string') return null;
      return parsed;
    } catch (_) { return null; }
  }

  function writeVaultMeta(record, source = 'vault-write') {
    if (!record?.rawHash) return false;
    const createdAtISO = record.createdAtISO || record.updatedAtISO || new Date().toISOString();
    const value = {
      schemaVersion: 1,
      latestRawHash: String(record.rawHash),
      latestCreatedAtISO: String(createdAtISO),
      updatedAtISO: new Date().toISOString(),
      source
    };
    try {
      storage.setItem(VAULT_META_KEY, JSON.stringify(value));
      return true;
    } catch (_) { return false; }
  }

  function vaultMetaSaysNoDatabaseNeeded(candidateHash, nowMs = Date.now()) {
    const meta = readVaultMeta();
    if (!meta) return false;
    if (meta.latestRawHash === candidateHash) return true;
    const latestMs = Date.parse(meta.latestCreatedAtISO || '');
    return Number.isFinite(latestMs) && nowMs - latestMs < VAULT_ROTATION_MS;
  }

  function suspiciousReplacement(previousRaw, candidateRaw) {
    if (!previousRaw) return null;
    const previousText = String(previousRaw);
    const candidateText = String(candidateRaw);
    if (previousText === candidateText) return null;
    // Normal saves are similarly sized. Only pay the decompression cost when a
    // candidate is dramatically smaller than the current authoritative state.
    if (candidateText.length >= previousText.length * 0.5) return null;

    const previousState = parseState(previousText);
    const candidateState = parseState(candidateText);
    const previous = summarize(previousState);
    const candidate = summarize(candidateState);
    if (previous.majorTotal < 50) return null;
    if (!candidateState) return { reason: 'candidate_unreadable', previous, candidate };

    const ratio = previous.majorTotal ? candidate.majorTotal / previous.majorTotal : 1;
    const nearlyEmpty = candidate.majorTotal <= Math.max(5, Math.floor(previous.majorTotal * 0.02));
    const catastrophicDrop = previous.majorTotal - candidate.majorTotal >= 100 && ratio < 0.05;
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

  function rememberRemovedAuthoritativeRaw(key) {
    if (String(key) !== STORAGE_KEY) return;
    const raw = get(STORAGE_KEY);
    if (!raw) return;
    rememberedRemovedRaw = raw;
    const token = ++rememberedRemovalToken;
    const clear = () => {
      if (token === rememberedRemovalToken) rememberedRemovedRaw = null;
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(clear);
    else Promise.resolve().then(clear);
  }

  function clearRememberedRaw() {
    rememberedRemovalToken += 1;
    rememberedRemovedRaw = null;
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

  async function readVaultLatest(db) {
    const tx = db.transaction(VAULT_STORE, 'readonly');
    const latest = await requestResult(tx.objectStore(VAULT_STORE).get('latest'));
    await transactionDone(tx);
    return latest || null;
  }

  async function readVaultPreviousSlots(db) {
    const tx = db.transaction(VAULT_STORE, 'readonly');
    const store = tx.objectStore(VAULT_STORE);
    const rows = await Promise.all(VAULT_SLOT_IDS.slice(1).map((id) => requestResult(store.get(id))));
    await transactionDone(tx);
    return rows;
  }

  async function writeVaultSnapshot(raw, reason = 'known-good-mirror', expectedHash = null) {
    let db;
    try {
      const candidateHash = expectedHash || rawHash(raw);
      const nowMs = Date.now();
      if (vaultMetaSaysNoDatabaseNeeded(candidateHash, nowMs)) {
        writeDiagnostics({
          lastVaultFastSkipAtISO: new Date(nowMs).toISOString(),
          lastVaultFastSkipReason: readVaultMeta()?.latestRawHash === candidateHash ? 'same_hash' : 'rotation_not_due'
        });
        return true;
      }

      db = await openVault();
      if (!db) return false;
      const latest = await readVaultLatest(db);
      if (latest?.rawHash) writeVaultMeta(latest, 'vault-read-repair');
      if (latest?.rawHash === candidateHash) return true;

      const latestMs = Date.parse(latest?.createdAtISO || latest?.updatedAtISO || '');
      if (latest && Number.isFinite(latestMs) && nowMs - latestMs < VAULT_ROTATION_MS) return true;

      const state = parseState(raw);
      const counts = summarize(state);
      if (!state || counts.majorTotal < 30) return false;

      const previousSlots = latest ? await readVaultPreviousSlots(db) : [];
      const slots = [latest, ...previousSlots];
      const timestamp = new Date(nowMs).toISOString();
      const records = [];
      for (let index = VAULT_SLOT_IDS.length - 1; index >= 1; index -= 1) {
        const prior = slots[index - 1];
        if (prior) records.push({ ...prior, id: VAULT_SLOT_IDS[index] });
      }
      const latestRecord = {
        id: 'latest',
        schemaVersion: 1,
        createdAtISO: timestamp,
        reason,
        raw: String(raw),
        rawHash: candidateHash,
        counts
      };
      records.push(latestRecord);

      const writeTx = db.transaction(VAULT_STORE, 'readwrite');
      const writeStore = writeTx.objectStore(VAULT_STORE);
      records.forEach((record) => writeStore.put(record));
      await transactionDone(writeTx);
      writeVaultMeta(latestRecord, 'vault-rotation');
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

  async function drainVaultQueue() {
    if (vaultDrainRunning) return true;
    vaultDrainRunning = true;
    try {
      while (pendingVaultCandidate) {
        const candidate = pendingVaultCandidate;
        pendingVaultCandidate = null;
        await writeVaultSnapshot(candidate.raw, candidate.reason, candidate.hash);
      }
    } finally { vaultDrainRunning = false; }
    return true;
  }

  function queueVaultSnapshot(raw, reason) {
    const candidateRaw = String(raw || '');
    const candidateHash = rawHash(candidateRaw);
    if (vaultMetaSaysNoDatabaseNeeded(candidateHash)) return Promise.resolve(true);

    // The first known-good state of a page/session is a recovery boundary. Do
    // not allow a later ordinary save to replace this candidate before it has
    // had a chance to establish/repair the vault's latest slot and metadata.
    if (reason === 'startup-known-good') {
      vaultTail = vaultTail
        .then(() => writeVaultSnapshot(candidateRaw, reason, candidateHash))
        .catch(() => false);
      return vaultTail;
    }

    // Coalesce a burst of ordinary saves. If a real vault check is due, keep
    // only the newest not-yet-processed state instead of scheduling a complete
    // IndexedDB pass for every write. This work is chained behind any startup
    // known-good capture already in progress.
    pendingVaultCandidate = { raw: candidateRaw, reason, hash: candidateHash };
    vaultTail = vaultTail.then(() => drainVaultQueue()).catch(() => false);
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

  function installStorageHooks() {
    let instanceInstalled = false;
    try {
      if (!storage.__taskpointsDataLossGuardInstanceHooks) {
        const priorSet = storage.setItem.bind(storage);
        const priorRemove = storage.removeItem.bind(storage);
        const guardedSet = function guardedTaskPointsInstanceSetItem(key, value) {
          const targetKey = String(key);
          const candidateRaw = String(value);
          if (targetKey === STORAGE_KEY && destructiveAllowanceDepth === 0) {
            const previousRaw = get(STORAGE_KEY) || rememberedRemovedRaw;
            const details = suspiciousReplacement(previousRaw, candidateRaw);
            if (details) blockReplacement(details);
          }
          const result = priorSet(key, value);
          if (targetKey === STORAGE_KEY) {
            clearRememberedRaw();
            queueVaultSnapshot(candidateRaw, 'verified-state-write');
          }
          return result;
        };
        const guardedRemove = function guardedTaskPointsInstanceRemoveItem(key) {
          rememberRemovedAuthoritativeRaw(key);
          return priorRemove(key);
        };
        storage.setItem = guardedSet;
        storage.removeItem = guardedRemove;
        if (storage.setItem === guardedSet && storage.removeItem === guardedRemove) {
          Object.defineProperty(storage, '__taskpointsDataLossGuardInstanceHooks', { value: true, configurable: true });
          instanceInstalled = true;
        }
      } else instanceInstalled = true;
    } catch (_) {}
    if (instanceInstalled) return;

    const prototype = global.Storage?.prototype;
    if (!prototype) return;
    if (prototype.setItem && !prototype.__taskpointsDataLossGuardSetItem) {
      const priorSet = prototype.setItem;
      Object.defineProperty(prototype, '__taskpointsDataLossGuardSetItem', { value: priorSet, configurable: true });
      prototype.setItem = function guardedTaskPointsSetItem(key, value) {
        const targetKey = String(key);
        const candidateRaw = String(value);
        if (this === storage && targetKey === STORAGE_KEY && destructiveAllowanceDepth === 0) {
          const previousRaw = get(STORAGE_KEY) || rememberedRemovedRaw;
          const details = suspiciousReplacement(previousRaw, candidateRaw);
          if (details) blockReplacement(details);
        }
        const result = priorSet.call(this, key, value);
        if (this === storage && targetKey === STORAGE_KEY) {
          clearRememberedRaw();
          queueVaultSnapshot(candidateRaw, 'verified-state-write');
        }
        return result;
      };
    }
    if (prototype.removeItem && !prototype.__taskpointsDataLossGuardRemoveItem) {
      const priorRemove = prototype.removeItem;
      Object.defineProperty(prototype, '__taskpointsDataLossGuardRemoveItem', { value: priorRemove, configurable: true });
      prototype.removeItem = function guardedTaskPointsRemoveItem(key) {
        if (this === storage) rememberRemovedAuthoritativeRaw(key);
        return priorRemove.call(this, key);
      };
    }
  }

  function applyLegacyOperation(state, operation) {
    if (operation?.type === 'merge' && typeof core.mergeState === 'function') {
      return core.mergeState(operation.patch || {}, {
        ...(operation.options || {}),
        storageKey: STORAGE_KEY,
        existing: state
      }).state;
    }
    if (operation?.type === 'fields') {
      const next = { ...(state || {}) };
      Object.entries(operation.set || {}).forEach(([key, value]) => { next[key] = clone(value); });
      (operation.delete || []).forEach((key) => { delete next[key]; });
      return typeof core.normalizeState === 'function' ? core.normalizeState(next) : next;
    }
    return state;
  }

  function reconcileLegacyPhase5BJournal() {
    const raw = get(LEGACY_JOURNAL_KEY);
    if (!raw) return { reconciled: false, reason: 'no_journal' };
    set(MODE_KEY, 'off');

    let record;
    try { record = JSON.parse(raw); }
    catch (_) { record = null; }
    if (!record || record.schemaVersion !== 1 || !Array.isArray(record.operations)) {
      writeDiagnostics({ legacyJournalStatus: 'preserved_invalid', legacyJournalError: 'invalid_format' });
      return { reconciled: false, reason: 'invalid_format' };
    }

    const journalHash = rawHash(raw);
    try {
      const marker = JSON.parse(get(LEGACY_JOURNAL_MARKER_KEY) || 'null');
      if (marker?.journalHash === journalHash) {
        storage.removeItem(LEGACY_JOURNAL_KEY);
        writeDiagnostics({ legacyJournalStatus: 'already_reconciled', legacyJournalRevision: Number(record.revision) || 0 });
        return { reconciled: true, reason: 'already_reconciled' };
      }
    } catch (_) {}

    try {
      const baseRaw = get(STORAGE_KEY);
      const base = parseState(baseRaw);
      if (!base || typeof core.writeTaskPointsStoredState !== 'function') throw new Error('required_storage_api_unavailable');
      let next = typeof core.normalizeState === 'function' ? core.normalizeState(clone(base)) : clone(base);
      record.operations.forEach((operation) => { next = applyLegacyOperation(next, operation); });

      core.writeTaskPointsStoredState(next, { storageKey: STORAGE_KEY });
      const verified = parseState(get(STORAGE_KEY));
      if (!verified) throw new Error('journal_replay_readback_failed');
      const expectedHash = stateHash(next);
      const verifiedHash = stateHash(verified);
      if (expectedHash && verifiedHash && expectedHash !== verifiedHash) throw new Error('journal_replay_verification_failed');

      set(LEGACY_JOURNAL_MARKER_KEY, JSON.stringify({
        schemaVersion: 1,
        journalHash,
        revision: Number(record.revision) || 0,
        reconciledAtISO: new Date().toISOString()
      }));
      storage.removeItem(LEGACY_JOURNAL_KEY);
      writeDiagnostics({
        legacyJournalStatus: 'reconciled',
        legacyJournalRevision: Number(record.revision) || 0,
        legacyJournalOperations: record.operations.length,
        legacyJournalReconciledAtISO: new Date().toISOString(),
        legacyJournalError: null
      });
      return { reconciled: true, reason: 'replayed' };
    } catch (error) {
      writeDiagnostics({
        legacyJournalStatus: 'preserved_for_recovery',
        legacyJournalRevision: Number(record.revision) || 0,
        legacyJournalError: String(error?.message || error)
      });
      if (!alertShown && typeof global.alert === 'function') {
        alertShown = true;
        try { global.alert('TaskPoints found pending edits from the disabled Phase 5B system. They were preserved for recovery, and IndexedDB Primary remains Off.'); } catch (_) {}
      }
      return { reconciled: false, reason: 'replay_failed' };
    }
  }

  core.PHASE5B_LIVE_BUNDLE_DISABLED = true;
  core.__phase5bDeferredMirrorInstalled = false;
  core.getPhase5BStatus = () => ({
    enabled: false,
    installed: false,
    disabledForSafety: true,
    reason: 'phase5b_disabled_after_empty_state_overwrite',
    journalPresent: Boolean(get(LEGACY_JOURNAL_KEY))
  });
  core.flushPhase5BNativeWrites = () => Promise.resolve();
  core.flushPhase5BMirrorCheckpoint = () => false;
  core.TASKPOINTS_SAFETY_VAULT_DB_NAME = VAULT_DB_NAME;
  core.TASKPOINTS_SAFETY_VAULT_STORE = VAULT_STORE;
  core.TASKPOINTS_SAFETY_VAULT_META_KEY = VAULT_META_KEY;
  core.withTaskPointsDestructiveWriteAllowed = (fn) => withAllowance(fn);
  core.flushTaskPointsSafetyVault = () => vaultTail.catch(() => undefined);
  core.getTaskPointsDataLossGuardStatus = () => ({
    installed: true,
    phase5bLiveBundleDisabled: true,
    destructiveAllowanceActive: destructiveAllowanceDepth > 0,
    vaultMeta: readVaultMeta(),
    vaultQueuePending: Boolean(pendingVaultCandidate || vaultDrainRunning),
    diagnostics: readDiagnostics()
  });

  wrapDestructiveEntryPoint('saveValidatedSnapshot');
  wrapDestructiveEntryPoint('saveStateSnapshot');

  if (get(HOLD_KEY)) set(MODE_KEY, 'off');
  const startupRaw = get(STORAGE_KEY);
  if (startupRaw) queueVaultSnapshot(startupRaw, 'startup-known-good');
  installStorageHooks();
  reconcileLegacyPhase5BJournal();
  writeDiagnostics({ installedAtISO: new Date().toISOString(), lastInstallError: null });
})(typeof window !== 'undefined' ? window : globalThis);
