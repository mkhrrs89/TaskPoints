(function installTaskPointsPhase5B(global) {
  'use strict';
  const core = global.TaskPointsCore;
  if (!core || core.__phase5bDeferredMirrorInstalled || !core.__phase5aNativeSnapshotInstalled) return;
  if (typeof core.queuePhase5ANativeSnapshotWrite !== 'function') return;
  core.__phase5bDeferredMirrorInstalled = true;

  const JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const DIAG_KEY = 'taskpoints_phase5b_diagnostics_v1';
  const MAX_JOURNAL = 512 * 1024;
  const CHECKPOINT_DELAY = 12000;
  const IDLE_TIMEOUT = 5000;

  const original = {
    load: core.loadAppState.bind(core),
    merge: core.mergeState.bind(core),
    saveApp: core.saveAppState.bind(core),
    mergeSave: core.mergeAndSaveState.bind(core),
    saveSnapshot: core.saveStateSnapshot.bind(core),
    saveValidated: core.saveValidatedSnapshot?.bind(core),
    readStored: core.readTaskPointsStoredState?.bind(core),
    writeStored: core.writeTaskPointsStoredState?.bind(core),
    safeReplace: core.safeReplaceTaskPointsStorage.bind(core),
    scoring: core.getScoringSettings?.bind(core),
    recovery: core.getRecoveryCandidate?.bind(core),
    restoreBackup: core.restoreBackupSlot?.bind(core)
  };

  let stateCache = null;
  let revision = 0;
  let nativeRevision = 0;
  let nativeTail = Promise.resolve();
  let nativeRunning = false;
  let timer = null;
  let idleId = null;
  let checkpointing = false;
  let loading = false;

  const clone = (value) => typeof global.structuredClone === 'function'
    ? global.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  const get = (key) => { try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; } };
  const set = (key, value) => { try { global.localStorage?.setItem?.(key, value); return true; } catch (_) { return false; } };
  const remove = (key) => { try { global.localStorage?.removeItem?.(key); } catch (_) {} };
  const mode = () => core.getPhase4StorageMode?.() || 'off';
  const now = () => new Date().toISOString();
  const habitDeltas = () => { try { return core.readPendingHabitDeltas?.() || []; } catch (_) { return [{ invalid: true }]; } };

  function rawHash(raw) {
    const text = String(raw || ''); let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return `${(hash >>> 0).toString(16)}:${text.length}`;
  }

  function readDiag() {
    try { const value = JSON.parse(get(DIAG_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; }
    catch (_) { return {}; }
  }

  function diag(patch) {
    set(DIAG_KEY, JSON.stringify({ schemaVersion: 1, enabled: true, configuredMode: mode(), ...readDiag(), ...patch }));
  }

  function journal() {
    try {
      const value = JSON.parse(get(JOURNAL_KEY) || 'null');
      return value?.schemaVersion === 1 && Array.isArray(value.operations) ? value : null;
    } catch (_) { return null; }
  }

  function sanitized(options = {}) {
    const keys = [
      'replaceCompletions', 'exactCompletions', 'assumeNormalized', 'allowStickyOverwrite',
      'allowStickyOverwriteKeys', 'allowHabitTagColorReset', 'allowProtectedHistoryOverwrite',
      'allowProtectedHistoryOverwriteKeys', 'deletedReminderIds', 'replaceReminders',
      'exactReminders', 'allowScoringSettingsOverwrite', 'dedupeDateKey', 'todayDateKey'
    ];
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(options, key)).map((key) => [key, clone(options[key])]));
  }

  function applyOperation(state, operation) {
    if (operation?.type === 'merge') {
      return original.merge(operation.patch || {}, { ...(operation.options || {}), storageKey: core.STORAGE_KEY, existing: state }).state;
    }
    if (operation?.type === 'fields') {
      const next = { ...(state || {}) };
      Object.entries(operation.set || {}).forEach(([key, value]) => { next[key] = clone(value); });
      (operation.delete || []).forEach((key) => { delete next[key]; });
      return core.normalizeState(next);
    }
    return state;
  }

  function applyJournal(base, record = journal()) {
    let state = core.normalizeState(clone(base || {}));
    for (const operation of record?.operations || []) state = applyOperation(state, operation);
    return state;
  }

  function stateHash(state) {
    return core.shadowSourceSummary?.(state || {})?.hashes?.state || null;
  }

  function current() {
    if (stateCache) return stateCache;
    const loaded = original.load({ persistSync: false });
    const record = journal();
    const diagnostics = readDiag();
    const native = core.getPhase5ANativeSnapshotCache?.();
    const journalAlreadyNative = Boolean(record
      && Number(diagnostics.lastNativeRevision) >= Number(record.revision)
      && native?.status === 'passed_verification'
      && native.mirrorRaw === get(core.STORAGE_KEY)
      && stateHash(loaded?.state)
      && stateHash(loaded?.state) === stateHash(native.state));
    stateCache = journalAlreadyNative
      ? core.normalizeState(clone(loaded?.state || {}))
      : applyJournal(loaded?.state || {}, record);
    revision = Math.max(revision, Number(record?.revision) || 0, Number(diagnostics.revision) || 0, Number(diagnostics.lastNativeRevision) || 0);
    return stateCache;
  }

  function appendJournal(operation) {
    const mirrorHash = rawHash(get(core.STORAGE_KEY));
    const existing = journal();
    const record = {
      schemaVersion: 1,
      baseMirrorHash: mirrorHash,
      revision: Math.max(revision, Number(existing?.revision) || 0, Number(readDiag().revision) || 0, Number(readDiag().lastNativeRevision) || 0) + 1,
      updatedAt: now(),
      operations: existing?.baseMirrorHash === mirrorHash ? existing.operations.concat(operation) : [operation]
    };
    let raw = JSON.stringify(record);
    if (raw.length > MAX_JOURNAL && stateCache) {
      if (!checkpoint('journal_limit')) return false;
      record.baseMirrorHash = rawHash(get(core.STORAGE_KEY));
      record.operations = [operation];
      raw = JSON.stringify(record);
    }
    if (raw.length > MAX_JOURNAL || !set(JOURNAL_KEY, raw)) return false;
    revision = record.revision;
    return true;
  }

  function validShape(state) {
    return state && typeof state === 'object' && !Array.isArray(state)
      && ['tasks', 'reminders', 'completions', 'habits', 'players', 'flexActions', 'gameHistory', 'matchups']
        .every((key) => Array.isArray(state[key]));
  }

  function saveLabel(options = {}) {
    return String(options.savePath || options.source || options.reason || options.caller || '');
  }

  function isHabitCompaction(options = {}) {
    return /(habit[-_ ]?journal|journal.*compaction|habit.*compaction)/i.test(saveLabel(options));
  }

  function bypass(options = {}) {
    if (mode() !== 'indexeddb_primary' || (options.storageKey || core.STORAGE_KEY) !== core.STORAGE_KEY) return true;
    if (options.phase5bBypass || options.forceLocalStorageMirror || options.allowDestructiveOverwrite || options.storageEmergencyCompaction) return true;
    return isHabitCompaction(options) || /(import|restore|reset|backup|recovery|migration|quarantine)/i.test(saveLabel(options));
  }

  function setAheadCache(state) {
    const mirrorRaw = get(core.STORAGE_KEY);
    const previous = core.getPhase4VerifiedPrimaryCache?.() || {};
    core.setPhase4VerifiedPrimaryCache?.({
      ...previous,
      state: clone(state),
      serializedState: mirrorRaw,
      mirrorRaw,
      status: 'passed_verification',
      phase5bNativeAhead: true,
      phase5bRevision: revision
    }, { persist: false });
  }

  async function writeNative(target) {
    if (habitDeltas().length) { diag({ lastNativeDeferredAt: now(), lastNativeError: 'pending_habit_journal' }); return; }
    const expected = clone(stateCache || current());
    const expectedHash = core.shadowSourceSummary?.(expected)?.hashes?.state;
    const mirrorRaw = get(core.STORAGE_KEY);
    setAheadCache(expected);
    await core.queuePhase5ANativeSnapshotWrite();
    await core.flushPhase5ANativeSnapshotWrites?.();
    const saved = core.getPhase5ANativeSnapshotCache?.();
    const savedHash = saved?.state ? core.shadowSourceSummary?.(saved.state)?.hashes?.state : null;
    const passed = saved?.status === 'passed_verification' && saved.mirrorRaw === mirrorRaw && (!expectedHash || expectedHash === savedHash);
    diag(passed
      ? { lastNativeWriteAt: now(), lastNativeRevision: target, lastNativeError: null, nativeAhead: true }
      : { lastNativeFailureAt: now(), lastNativeRevision: target, lastNativeError: 'verification_failed', nativeAhead: true });
  }

  async function runNative() {
    try {
      while (mode() === 'indexeddb_primary') {
        const target = nativeRevision;
        await writeNative(target);
        if (target === nativeRevision) break;
      }
    } finally { nativeRunning = false; }
  }

  function queueNative() {
    nativeRevision = Math.max(nativeRevision + 1, revision);
    if (nativeRunning) return nativeTail;
    nativeRunning = true;
    nativeTail = new Promise((resolve) => setTimeout(() => resolve(runNative()), 0)).catch((error) => {
      nativeRunning = false;
      diag({ lastNativeFailureAt: now(), lastNativeError: String(error?.message || error) });
    });
    return nativeTail;
  }

  function cancelCheckpoint() {
    if (timer != null) clearTimeout(timer);
    if (idleId != null && typeof global.cancelIdleCallback === 'function') global.cancelIdleCallback(idleId);
    timer = null; idleId = null;
  }

  function checkpoint(reason = 'manual') {
    if (checkpointing || !stateCache || mode() !== 'indexeddb_primary') return false;
    checkpointing = true; cancelCheckpoint();
    const state = clone(stateCache);
    if (habitDeltas().length && typeof core.applyPendingHabitDeltas === 'function') {
      try { core.applyPendingHabitDeltas(state, habitDeltas()); } catch (_) {}
    }
    const candidates = [state, core.compactStateForLocalStorage(state)];
    let error = null;
    try {
      for (let i = 0; i < candidates.length; i += 1) {
        try {
          const plan = core.buildOptimizedTaskPointsStorageRaw(candidates[i]);
          original.safeReplace(core.STORAGE_KEY, plan.chosenRaw);
          const persisted = core.parseTaskPointsStorageJson(get(core.STORAGE_KEY), {});
          if (!validShape(persisted)) throw new Error('checkpoint_verification_failed');
          const expectedHash = stateHash(candidates[i]);
          if (expectedHash && stateHash(persisted) !== expectedHash) throw new Error('checkpoint_hash_mismatch');
          remove(JOURNAL_KEY);
          diag({ lastCheckpointAt: now(), lastCheckpointReason: reason, lastCheckpointEncoding: plan.chosenEncoding, checkpointCompacted: i === 1, nativeAhead: false, lastCheckpointError: null });
          return true;
        } catch (caught) { error = caught; }
      }
      throw error || new Error('checkpoint_failed');
    } catch (caught) {
      diag({ lastCheckpointFailureAt: now(), lastCheckpointReason: reason, lastCheckpointError: String(caught?.message || caught), nativeAhead: true });
      return false;
    } finally { checkpointing = false; }
  }

  function ensureCheckpoint(reason) {
    if (!journal()) return true;
    if (!stateCache) current();
    return checkpoint(reason);
  }

  function scheduleCheckpoint(reason = 'idle_after_save') {
    cancelCheckpoint();
    timer = setTimeout(() => {
      timer = null;
      const run = () => { idleId = null; checkpoint(reason); };
      idleId = typeof global.requestIdleCallback === 'function'
        ? global.requestIdleCallback(run, { timeout: IDLE_TIMEOUT })
        : setTimeout(run, 0);
    }, CHECKPOINT_DELAY);
    timer?.unref?.();
  }

  function commit(state, operation, options) {
    if (!validShape(state) || !appendJournal(operation)) return null;
    stateCache = core.normalizeState(clone(state));
    setAheadCache(stateCache);
    queueNative(); scheduleCheckpoint();
    diag({ lastHandledSaveAt: now(), lastHandledPath: options.savePath || options.source || options.reason || 'unknown', revision, nativeAhead: true });
    return { state: stateCache, trimmed: false, encoding: 'indexeddb-native', deferredCompression: true, deferredMirror: true, phase5bRevision: revision };
  }

  function mergeSave(nextState, options = {}) {
    if (bypass(options)) return null;
    const merged = original.merge(nextState || {}, { ...options, storageKey: core.STORAGE_KEY, existing: clone(current()) });
    return commit(merged.state, { type: 'merge', patch: clone(nextState || {}), options: sanitized(options) }, options);
  }

  function same(a, b) {
    if (a === b) return true;
    try { return (core.shadowCanonicalJson || JSON.stringify)(a) === (core.shadowCanonicalJson || JSON.stringify)(b); }
    catch (_) { return false; }
  }

  function snapshotSave(state, options = {}) {
    if (bypass(options)) return null;
    const base = clone(current());
    const next = core.normalizeState(clone(state || {}));
    const setFields = {}; const deleted = [];
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (!Object.hasOwn(next, key)) deleted.push(key);
      else if (!same(base[key], next[key])) setFields[key] = clone(next[key]);
    }
    if (!Object.keys(setFields).length && !deleted.length) return { state: next, trimmed: false, encoding: 'indexeddb-native', deferredCompression: true, deferredMirror: true };
    return commit(next, { type: 'fields', set: setFields, delete: deleted }, options);
  }

  function preparedLoad(options = {}) {
    let state = core.normalizeState(clone(current()));
    const deltas = habitDeltas();
    if (deltas.length && typeof core.applyPendingHabitDeltas === 'function') {
      try { core.applyPendingHabitDeltas(state, deltas); } catch (_) {}
    }
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    state.tasks = state.tasks.filter((task) => task?.status !== 'trashed' || Date.parse(task.deletedAtISO || task.deletedAt || '') >= cutoff);
    if (options.syncDerived !== false) {
      state = core.syncDerivedPoints?.(state, { normalized: true })?.state || state;
      state = core.syncYouMatchups?.(state, { normalized: true })?.state || state;
      const repaired = core.repairSeasonChampionshipData?.(state, options);
      if (repaired?.ok) state = repaired.state;
    }
    return { state, storageKeysFound: [core.STORAGE_KEY], pendingHabitDeltas: deltas };
  }

  core.loadAppState = function phase5bLoad(options = {}) {
    if (loading || mode() !== 'indexeddb_primary') return original.load(options);
    loading = true;
    try { const loaded = preparedLoad({ ...(options || {}), persistSync: false }); diag({ lastReadAt: now(), effectiveSource: journal() ? 'indexedDB_native_plus_journal' : 'indexedDB_native' }); return loaded; }
    catch (error) { stateCache = null; diag({ lastFallbackAt: now(), lastFallbackReason: String(error?.message || error) }); return original.load(options); }
    finally { loading = false; }
  };

  core.saveAppState = function phase5bSaveApp(nextState, options = {}, maybeOptions = {}) {
    if (typeof nextState === 'string') return original.saveApp(nextState, options, maybeOptions);
    return mergeSave(nextState, options) || original.saveApp(nextState || {}, { ...options, existing: clone(current()) }, maybeOptions);
  };
  core.mergeAndSaveState = (nextState, options = {}) => mergeSave(nextState, options)
    || original.mergeSave(nextState || {}, { ...options, existing: clone(current()) });
  core.saveStateSnapshot = function phase5bSnapshot(state, options = {}) {
    const deferred = snapshotSave(state, options);
    if (deferred) return deferred;
    if (isHabitCompaction(options) && mode() === 'indexeddb_primary') {
      const latest = clone(current());
      const deltas = habitDeltas();
      if (deltas.length && typeof core.applyPendingHabitDeltas === 'function') core.applyPendingHabitDeltas(latest, deltas);
      return original.saveSnapshot(latest, { ...options, phase5bBypass: true, forceLocalStorageMirror: true });
    }
    if (!ensureCheckpoint('before_synchronous_snapshot')) return { state: clone(current()), blocked: true, reason: 'phase5b_checkpoint_failed', trimmed: false };
    return original.saveSnapshot(state, options);
  };

  if (original.saveValidated) core.saveValidatedSnapshot = function phase5bValidated(state, options = {}) {
    if (!ensureCheckpoint('before_validated_snapshot')) return { state: clone(current()), blocked: true, reason: 'phase5b_checkpoint_failed', trimmed: false };
    const result = original.saveValidated(state, { ...options, phase5bBypass: true, forceLocalStorageMirror: true });
    stateCache = result?.state ? core.normalizeState(clone(result.state)) : null;
    if (!result?.blocked) remove(JOURNAL_KEY);
    return result;
  };
  if (original.readStored) core.readTaskPointsStoredState = (key = core.STORAGE_KEY, fallback = null) => {
    if (key !== core.STORAGE_KEY || mode() !== 'indexeddb_primary') return original.readStored(key, fallback);
    const state = clone(current());
    const deltas = habitDeltas();
    if (deltas.length && typeof core.applyPendingHabitDeltas === 'function') core.applyPendingHabitDeltas(state, deltas);
    return state;
  };
  if (original.writeStored) core.writeTaskPointsStoredState = function phase5bWriteStored(state, options = {}) {
    if (!ensureCheckpoint('before_direct_storage_write')) throw new Error('Phase 5B rollback checkpoint failed; direct storage write was blocked.');
    const result = original.writeStored(state, options);
    if ((options.storageKey || core.STORAGE_KEY) === core.STORAGE_KEY) { stateCache = core.normalizeState(clone(state || {})); remove(JOURNAL_KEY); }
    return result;
  };
  core.mergeState = (next, options = {}) => (mode() === 'indexeddb_primary' && !options.existing && (options.storageKey || core.STORAGE_KEY) === core.STORAGE_KEY)
    ? original.merge(next, { ...options, existing: clone(current()) }) : original.merge(next, options);
  if (original.scoring) core.getScoringSettings = (value) => value == null && mode() === 'indexeddb_primary' ? original.scoring(current()) : original.scoring(value);
  if (original.recovery) core.getRecoveryCandidate = (options = {}) => ensureCheckpoint('before_recovery_check') ? original.recovery(options) : null;
  if (original.restoreBackup) core.restoreBackupSlot = (slot, options = {}) => {
    if (!ensureCheckpoint('before_backup_restore')) return { restored: false, reason: 'phase5b_checkpoint_failed' };
    const result = original.restoreBackup(slot, options); stateCache = null; if (result?.restored) remove(JOURNAL_KEY); return result;
  };

  function observed(key, value, removed = false) {
    if (String(key) === core.STORAGE_KEY && !checkpointing) { stateCache = null; remove(JOURNAL_KEY); cancelCheckpoint(); }
    if (String(key) === core.PENDING_HABIT_DELTAS_KEY && !habitDeltas().length && stateCache) { queueNative(); scheduleCheckpoint('habit_journal_cleared'); }
  }

  const storage = global.localStorage;
  let observerInstalled = false;
  try {
    const setItem = storage?.setItem?.bind(storage); const removeItem = storage?.removeItem?.bind(storage);
    if (setItem && !storage.__taskPointsPhase5BObserverInstalled) {
      const wrappedSet = function phase5bSet(key, value) { const result = setItem(key, value); observed(key, value, false); return result; };
      const wrappedRemove = removeItem ? function phase5bRemove(key) { const result = removeItem(key); observed(key, null, true); return result; } : null;
      storage.setItem = wrappedSet; if (wrappedRemove) storage.removeItem = wrappedRemove;
      observerInstalled = storage.setItem === wrappedSet;
      if (observerInstalled) Object.defineProperty(storage, '__taskPointsPhase5BObserverInstalled', { value: true, configurable: true });
    } else observerInstalled = Boolean(storage?.__taskPointsPhase5BObserverInstalled);
  } catch (_) {}
  if (!observerInstalled) {
    const prototype = global.Storage?.prototype;
    if (prototype?.setItem && !prototype.__taskPointsPhase5BOriginalSetItem) {
      const setItem = prototype.setItem; const removeItem = prototype.removeItem;
      Object.defineProperty(prototype, '__taskPointsPhase5BOriginalSetItem', { value: setItem, configurable: true });
      prototype.setItem = function phase5bSet(key, value) { const result = setItem.call(this, key, value); if (this === storage) observed(key, value, false); return result; };
      if (removeItem) {
        Object.defineProperty(prototype, '__taskPointsPhase5BOriginalRemoveItem', { value: removeItem, configurable: true });
        prototype.removeItem = function phase5bRemove(key) { const result = removeItem.call(this, key); if (this === storage) observed(key, null, true); return result; };
      }
    }
  }

  core.PHASE5B_JOURNAL_KEY = JOURNAL_KEY;
  core.PHASE5B_DIAGNOSTICS_KEY = DIAG_KEY;
  core.getPhase5BCurrentState = () => clone(current());
  core.getPhase5BStatus = () => ({ enabled: true, configuredMode: mode(), revision, nativeWritePending: nativeRunning, checkpointScheduled: timer != null || idleId != null, checkpointRunning: checkpointing, journalPresent: Boolean(journal()), journalOperations: journal()?.operations?.length || 0 });
  core.flushPhase5BNativeWrites = () => nativeTail.catch(() => undefined);
  core.flushPhase5BMirrorCheckpoint = (reason = 'manual') => checkpoint(reason);
  core.clearPhase5BState = () => { stateCache = null; remove(JOURNAL_KEY); cancelCheckpoint(); return true; };

  global.addEventListener?.('pagehide', () => checkpoint('pagehide'));
  global.addEventListener?.('visibilitychange', () => { if (global.document?.visibilityState === 'hidden') checkpoint('visibility_hidden'); });
  diag({ installedAt: now(), effectiveSource: 'indexedDB_native', lastError: null });
  if (mode() === 'indexeddb_primary' && journal()) { current(); queueNative(); scheduleCheckpoint('startup_recovery'); }
})(typeof window !== 'undefined' ? window : globalThis);
