(function installTaskPointsTaskMutationJournal(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__taskMutationJournalInstalled) return;
  core.__taskMutationJournalInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const JOURNAL_KEY = 'taskpoints_pending_task_mutations_v1';
  const SAVE_PATH = 'task-mutation-journal-compaction';
  const RETRY_BASE_DELAY_MS = 1500;
  const RETRY_MAX_DELAY_MS = 15000;
  const MAX_RETRIES = 5;
  // The shared storage gate considers 1.4 s of inactivity quiet enough for
  // ordinary maintenance. Full-state LZ compression can still block the main
  // thread for ~0.6-1.0 s on large histories, so task-journal compaction gets
  // an additional sustained-quiet grace period before it may start.
  const COMPACTION_EXTRA_QUIET_MS = 3000;

  const originalReadStored = typeof core.readTaskPointsStoredState === 'function'
    ? core.readTaskPointsStoredState.bind(core)
    : null;
  const originalLoadAppState = typeof core.loadAppState === 'function'
    ? core.loadAppState.bind(core)
    : null;
  const originalSaveStateSnapshot = typeof core.saveStateSnapshot === 'function'
    ? core.saveStateSnapshot.bind(core)
    : null;

  let compactionScheduled = false;
  let compactionRunning = false;
  let retryTimer = 0;
  let retryCount = 0;
  let preflightDeferrals = 0;
  let compactionsStarted = 0;
  let compactionsCompleted = 0;

  function emptyRecord() {
    return { schemaVersion: 1, tasks: [], completionUpserts: [], completionDeletes: [], updatedAtISO: null };
  }

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.schemaVersion !== 1) return null;
    const tasks = Array.isArray(value.tasks)
      ? value.tasks.filter((task) => task && typeof task === 'object' && !Array.isArray(task) && task.id).map(clone)
      : [];
    const completionUpserts = Array.isArray(value.completionUpserts)
      ? value.completionUpserts.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id).map(clone)
      : [];
    const completionDeletes = Array.isArray(value.completionDeletes)
      ? [...new Set(value.completionDeletes.map((id) => String(id || '')).filter(Boolean))]
      : [];
    return {
      schemaVersion: 1,
      tasks,
      completionUpserts,
      completionDeletes,
      updatedAtISO: typeof value.updatedAtISO === 'string' ? value.updatedAtISO : null
    };
  }

  function readRecord() {
    const raw = storage.getItem(JOURNAL_KEY);
    if (!raw) return { raw: '', malformed: false, record: emptyRecord() };
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { return { raw, malformed: true, record: emptyRecord() }; }
    const record = normalizeRecord(parsed);
    return record ? { raw, malformed: false, record } : { raw, malformed: true, record: emptyRecord() };
  }

  function isEmpty(record) {
    return !record.tasks.length && !record.completionUpserts.length && !record.completionDeletes.length;
  }

  function recoveryWriteAllowed() {
    const recoveryGuard = global.TaskPointsRecoveryJournalWriteLockGuard;
    const recoveryLock = recoveryGuard?.readLock?.() || null;
    if (recoveryLock && recoveryGuard?.pageMayWrite?.(recoveryLock) !== true) return false;
    const recoveryAttempt = global.TaskPointsRecoveryAttemptWriteLockGuard?.readAttemptLock?.() || null;
    return !recoveryAttempt;
  }

  function invalidateReadCaches() {
    try { core.clearStateHotCache?.(); } catch (_) {}
  }

  function assertJournalWritable() {
    if (!recoveryWriteAllowed()) {
      const error = new Error('TaskPoints paused task changes while recovery protection is active.');
      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_WRITE_LOCKED';
      throw error;
    }
    const current = readRecord();
    if (current.malformed) {
      const error = new Error('Pending task mutation journal is malformed and was preserved.');
      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_MALFORMED';
      throw error;
    }
    return current;
  }

  function writeRecord(record) {
    if (!recoveryWriteAllowed()) {
      const error = new Error('TaskPoints paused task changes while recovery protection is active.');
      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_WRITE_LOCKED';
      throw error;
    }
    const normalized = normalizeRecord(record) || emptyRecord();
    if (isEmpty(normalized)) storage.removeItem(JOURNAL_KEY);
    else storage.setItem(JOURNAL_KEY, JSON.stringify(normalized));
    invalidateReadCaches();
    return normalized;
  }

  function mergeById(rows, row) {
    const id = String(row?.id || '');
    if (!id) return rows;
    const next = rows.filter((item) => String(item?.id || '') !== id);
    next.push(clone(row));
    return next;
  }

  function journalMutation(mutation = {}) {
    const current = assertJournalWritable();
    let record = current.record;
    if (mutation.task?.id) record.tasks = mergeById(record.tasks, mutation.task);
    if (mutation.completionUpsert?.id) {
      const id = String(mutation.completionUpsert.id);
      record.completionUpserts = mergeById(record.completionUpserts, mutation.completionUpsert);
      record.completionDeletes = record.completionDeletes.filter((entryId) => entryId !== id);
    }
    if (mutation.completionDeleteId) {
      const id = String(mutation.completionDeleteId);
      record.completionUpserts = record.completionUpserts.filter((entry) => String(entry?.id || '') !== id);
      if (!record.completionDeletes.includes(id)) record.completionDeletes.push(id);
    }
    record.updatedAtISO = new Date().toISOString();
    const saved = writeRecord(record);
    try { core.noteStorageUserInteraction?.(); } catch (_) {}
    scheduleCompaction('mutation');
    return saved;
  }

  function applyRecord(sourceState, suppliedRecord = null) {
    const state = sourceState && typeof sourceState === 'object' && !Array.isArray(sourceState)
      ? { ...sourceState }
      : {};
    const record = suppliedRecord || readRecord().record;

    const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
    for (const patch of record.tasks) {
      const id = String(patch.id);
      const at = tasks.findIndex((task) => String(task?.id || '') === id);
      if (at >= 0) tasks[at] = clone(patch); else tasks.push(clone(patch));
    }
    state.tasks = tasks;

    const deleteIds = new Set(record.completionDeletes.map(String));
    const completions = (Array.isArray(state.completions) ? state.completions : [])
      .filter((entry) => !deleteIds.has(String(entry?.id || '')))
      .map((entry) => entry);
    for (const patch of record.completionUpserts) {
      const id = String(patch.id);
      const at = completions.findIndex((entry) => String(entry?.id || '') === id);
      if (at >= 0) completions[at] = clone(patch);
      else completions.unshift(clone(patch));
    }
    state.completions = completions;
    return state;
  }

  function valueMatches(savedValue, patchValue) {
    try { return JSON.stringify(savedValue) === JSON.stringify(patchValue); }
    catch (_) { return false; }
  }

  function snapshotVerified(savedState, record) {
    if (!savedState || typeof savedState !== 'object') return false;
    for (const patch of record.tasks) {
      const saved = (savedState.tasks || []).find((task) => String(task?.id || '') === String(patch.id));
      if (!saved) return false;
      for (const [key, value] of Object.entries(patch)) {
        if (!valueMatches(saved[key], value)) return false;
      }
    }
    for (const patch of record.completionUpserts) {
      const saved = (savedState.completions || []).find((entry) => String(entry?.id || '') === String(patch.id));
      if (!saved) return false;
      for (const [key, value] of Object.entries(patch)) {
        if (!valueMatches(saved[key], value)) return false;
      }
    }
    for (const id of record.completionDeletes) {
      if ((savedState.completions || []).some((entry) => String(entry?.id || '') === String(id))) return false;
    }
    return true;
  }

  function sameRow(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch (_) { return false; }
  }

  function clearVerifiedSnapshot(snapshot) {
    const current = readRecord();
    if (current.malformed) return false;
    const record = current.record;
    record.tasks = record.tasks.filter((row) => !snapshot.tasks.some((saved) => String(saved.id) === String(row.id) && sameRow(saved, row)));
    record.completionUpserts = record.completionUpserts.filter((row) => !snapshot.completionUpserts.some((saved) => String(saved.id) === String(row.id) && sameRow(saved, row)));
    record.completionDeletes = record.completionDeletes.filter((id) => !snapshot.completionDeletes.includes(id));
    record.updatedAtISO = new Date().toISOString();
    writeRecord(record);
    return true;
  }

  function persistedState() {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    if (typeof core.parseTaskPointsStorageJson === 'function') return core.parseTaskPointsStorageJson(raw, {}) || {};
    return JSON.parse(raw) || {};
  }

  function persistPending(reason = 'quiet') {
    if (compactionRunning || !originalSaveStateSnapshot) return false;
    const current = readRecord();
    if (current.malformed || isEmpty(current.record)) return false;
    compactionRunning = true;
    compactionsStarted += 1;
    try { global.TaskPointsPerf?.mark?.('taskMutation.compactionStart', { reason }); } catch (_) {}
    const snapshot = clone(current.record);
    try {
      const candidate = applyRecord(persistedState(), snapshot);
      const result = originalSaveStateSnapshot(candidate, {
        storageKey: STORAGE_KEY,
        immediateWrite: true,
        replaceCompletions: true,
        allowGeneratedCacheClear: true,
        storageEmergencyCompaction: true,
        savePath: SAVE_PATH,
        taskMutationReason: reason
      });
      if (result?.skipped || result?.blockedByQuotaCircuit || !result?.state) throw new Error('Task mutation journal compaction was not committed.');
      const saved = persistedState();
      if (!snapshotVerified(saved, snapshot)) throw new Error('Task mutation journal compaction verification failed.');
      clearVerifiedSnapshot(snapshot);
      retryCount = 0;
      compactionsCompleted += 1;
      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionComplete', { reason }); } catch (_) {}
      return true;
    } catch (error) {
      console.warn('TaskPoints retained pending task changes for a later compaction retry.', error);
      return false;
    } finally {
      compactionRunning = false;
    }
  }

  function scheduleRetry() {
    if (retryTimer || retryCount >= MAX_RETRIES) return;
    const delay = Math.min(RETRY_BASE_DELAY_MS * (2 ** retryCount), RETRY_MAX_DELAY_MS);
    retryCount += 1;
    retryTimer = global.setTimeout?.(() => {
      retryTimer = 0;
      scheduleCompaction('retry');
    }, delay) || 0;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      if (typeof global.setTimeout === 'function') global.setTimeout(resolve, Math.max(0, Number(ms) || 0));
      else resolve();
    });
  }

  function maintenanceStillQuiet() {
    try {
      return typeof core.isStorageMaintenanceQuiet !== 'function' || core.isStorageMaintenanceQuiet() === true;
    } catch (_) {
      return false;
    }
  }

  function runInIdleSlot(run) {
    return new Promise((resolve) => {
      const invoke = () => {
        if (!maintenanceStillQuiet()) {
          preflightDeferrals += 1;
          try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'idle-preflight' }); } catch (_) {}
          resolve(false);
          return;
        }
        resolve(run());
      };
      if (typeof global.requestIdleCallback === 'function') {
        global.requestIdleCallback(invoke, { timeout: 1200 });
      } else if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(() => global.setTimeout?.(invoke, 0));
      } else {
        global.setTimeout?.(invoke, 0);
      }
    });
  }

  async function runWhenQuiet(reason) {
    const gate = core.whenStorageMaintenanceQuiet;
    if (typeof gate === 'function') {
      const gateReady = await Promise.resolve(gate(() => true, { reason: SAVE_PATH }));
      if (gateReady !== true) return false;
    } else {
      await delay(1500);
      if (!maintenanceStillQuiet()) return false;
    }

    // Do not launch a long, non-yielding compression immediately after the
    // generic 1.4 s gate. Give the user a wider chance to keep interacting,
    // then verify quiet again immediately before entering compression.
    await delay(COMPACTION_EXTRA_QUIET_MS);
    if (!maintenanceStillQuiet()) {
      preflightDeferrals += 1;
      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'sustained-quiet' }); } catch (_) {}
      return false;
    }
    return runInIdleSlot(() => persistPending(reason));
  }

  function scheduleCompaction(reason = 'scheduled') {
    if (compactionScheduled || compactionRunning) return false;
    const current = readRecord();
    if (current.malformed || isEmpty(current.record)) return false;
    compactionScheduled = true;
    global.setTimeout?.(() => {
      runWhenQuiet(reason)
        .then((ok) => { if (!ok && !isEmpty(readRecord().record)) scheduleRetry(); })
        .catch(() => scheduleRetry())
        .finally(() => { compactionScheduled = false; });
    }, 0);
    return true;
  }

  if (originalReadStored) {
    core.readTaskPointsStoredState = function readTaskPointsStoredStateWithTaskJournal(...args) {
      const state = originalReadStored(...args);
      const current = readRecord();
      if (current.malformed || isEmpty(current.record) || !state) return state;
      return applyRecord(state, current.record);
    };
  }

  if (originalLoadAppState) {
    core.loadAppState = function loadAppStateWithTaskJournal(...args) {
      const result = originalLoadAppState(...args);
      const current = readRecord();
      if (current.malformed || isEmpty(current.record) || !result?.state) return result;
      return { ...result, state: applyRecord(result.state, current.record), pendingTaskMutations: current.record.tasks.length + current.record.completionUpserts.length + current.record.completionDeletes.length };
    };
  }

  if (originalSaveStateSnapshot) {
    core.saveStateSnapshot = function saveStateSnapshotWithTaskJournal(state, options = {}) {
      const current = readRecord();
      const candidate = current.malformed || isEmpty(current.record) ? state : applyRecord(state, current.record);
      const result = originalSaveStateSnapshot(candidate, options);
      if (!current.malformed && !isEmpty(current.record) && !result?.skipped && !result?.blockedByQuotaCircuit && result?.state) {
        try {
          const saved = persistedState();
          if (snapshotVerified(saved, current.record)) clearVerifiedSnapshot(current.record);
        } catch (_) {}
      }
      return result;
    };
  }

  core.readPendingTaskMutations = () => readRecord();
  core.applyPendingTaskMutations = applyRecord;
  core.assertTaskMutationJournalWritable = assertJournalWritable;
  core.journalTaskMutation = journalMutation;
  core.schedulePendingTaskMutationCompaction = scheduleCompaction;
  core.flushPendingTaskMutations = () => persistPending('explicit-flush');
  core.clearPendingTaskMutations = () => {
    storage.removeItem(JOURNAL_KEY);
    invalidateReadCaches();
    return true;
  };
  core.getTaskMutationJournalStatus = () => {
    const current = readRecord();
    return {
      installed: true,
      malformed: current.malformed,
      tasks: current.record.tasks.length,
      completionUpserts: current.record.completionUpserts.length,
      completionDeletes: current.record.completionDeletes.length,
      compactionScheduled,
      compactionRunning,
      retryCount,
      extraQuietMs: COMPACTION_EXTRA_QUIET_MS,
      preflightDeferrals,
      compactionsStarted,
      compactionsCompleted
    };
  };

  global.setTimeout?.(() => scheduleCompaction('startup-replay'), 0);
})(typeof window !== 'undefined' ? window : globalThis);
