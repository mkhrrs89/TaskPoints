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
  // a minimum sustained-idle interval before it may start.
  const COMPACTION_MIN_IDLE_MS = 7000;

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
  // Advances on every new user journal mutation. A pending preflight captures
  // this generation so a newer mutation can invalidate an older countdown.
  let mutationGeneration = 0;
  let journalWritesVerified = 0;
  let journalWritesUnverified = 0;
  let journalSourceConflicts = 0;

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

  // The V1 Task journal is an authoritative pending-write record. On a
  // reload, parsing must be lossless: normalizeRecord used to drop malformed
  // rows, unexpected fields and missing arrays, and the next edit could then
  // overwrite the original bytes with a silently reduced journal.
  // Preserve, quarantine and report unsupported shapes instead.
  function validStoredTaskJournal(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1
      || !Array.isArray(value.tasks)
      || !Array.isArray(value.completionUpserts)
      || !Array.isArray(value.completionDeletes)) return false;
    const known = new Set([
      'schemaVersion','tasks','completionUpserts',
      'completionDeletes','updatedAtISO'
    ]);
    if (Object.keys(value).some((key) => !known.has(key))) return false;
    if (value.updatedAtISO !== undefined && value.updatedAtISO !== null
      && typeof value.updatedAtISO !== 'string') return false;
    const validRow = row => row && typeof row === 'object'
      && !Array.isArray(row) && row.id != null
      && Boolean(row.id) && String(row.id).trim() !== '';
    if (!value.tasks.every(validRow)
      || !value.completionUpserts.every(validRow)) return false;
    if (value.completionDeletes.some(id =>
      typeof id !== 'string' || !id.trim())) return false;
    return true;
  }

  function readRecord() {
    const raw = storage.getItem(JOURNAL_KEY);
    // Only a genuinely absent key is an empty journal. A present but empty
    // string (or a nonstandard storage shim returning undefined) is
    // unreadable evidence: treating it as absent would let the next Task tap
    // overwrite potentially interrupted/corrupt pending work.
    if (raw === null) return { raw: '', malformed: false, record: emptyRecord() };
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { return { raw, malformed: true, record: emptyRecord() }; }
    if (!validStoredTaskJournal(parsed))
      return { raw, malformed: true, record: emptyRecord() };
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

  function writeRecord(record, alreadyNormalized = false, expectedPriorRaw = undefined) {
    if (!recoveryWriteAllowed()) {
      const error = new Error('TaskPoints paused task changes while recovery protection is active.');
      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_WRITE_LOCKED';
      throw error;
    }
    // Both internal callers receive a fresh, fully normalized copy from
    // readRecord(). Re-normalizing here cloned every pending Task and
    // completion a second time on EACH foreground Work/Task interaction.
    // Keep the original validation path for any future untrusted caller.
    const normalized = alreadyNormalized ? record : (normalizeRecord(record) || emptyRecord());
    // Source-byte admission is checked synchronously immediately before the
    // write. This refuses a known peer edit between readRecord() and writeRecord()
    // without waiting on an asynchronous lock (foreground Tasks remain pre-paint).
    // localStorage is NOT compare-and-swap: a different tab can still race
    // after this observation, so this cannot certify global V2 writer fencing.
    if (expectedPriorRaw !== undefined) {
      let sourceRaw;
      try { sourceRaw = storage.getItem(JOURNAL_KEY); }
      catch (error) {
        journalSourceConflicts += 1;
        const refused = new Error('Task mutation source cannot be rechecked before write.');
        refused.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_SOURCE_UNREADABLE';
        throw refused;
      }
      if ((sourceRaw === null ? '' : sourceRaw) !== expectedPriorRaw) {
        journalSourceConflicts += 1;
        const refused = new Error('Another tab changed pending Task data before this edit could be saved.');
        refused.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_SOURCE_CHANGED';
        throw refused;
      }
    }
    const expectedRaw = isEmpty(normalized) ? null : JSON.stringify(normalized);
    if (expectedRaw === null) storage.removeItem(JOURNAL_KEY);
    else storage.setItem(JOURNAL_KEY, expectedRaw);

    // Browsers normally throw on denied storage writes, but some shims,
    // injected storage implementations and interrupted recovery paths can
    // acknowledge setItem/removeItem while silently retaining old bytes.
    // Task completions must not appear durable until the exact synchronous
    // V1 Task journal key has been read back successfully, before UI paint.
    let actualRaw;
    try { actualRaw = storage.getItem(JOURNAL_KEY); }
    catch (_) { actualRaw = undefined; }
    if (actualRaw !== expectedRaw) {
      journalWritesUnverified += 1;
      const error = new Error('Task mutation journal write could not be verified; the edit was not acknowledged.');
      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_WRITE';
      throw error;
    }
    journalWritesVerified += 1;
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
    if (mutation.task?.id && typeof mutation.task === 'object'
      && !Array.isArray(mutation.task)) {
      record.tasks = mergeById(record.tasks, mutation.task);
    }
    if (mutation.completionUpsert?.id && typeof mutation.completionUpsert === 'object'
      && !Array.isArray(mutation.completionUpsert)) {
      const id = String(mutation.completionUpsert.id);
      record.completionUpserts = mergeById(record.completionUpserts, mutation.completionUpsert);
      record.completionDeletes = record.completionDeletes.filter((entryId) => entryId !== id);
    }
    // One foreground Work/SCWM action can affect several completion rows.
    // Prepare and validate the WHOLE action before the single synchronous
    // journal setItem: a kill or quota error cannot leave only the first row
    // of this logical action acknowledged as durable.
    if (Object.prototype.hasOwnProperty.call(mutation, 'completionUpserts')) {
      const rows = mutation.completionUpserts;
      const seen = new Set();
      if (!Array.isArray(rows) || !rows.length || rows.length > 64
        || rows.some((row) => {
          const id = String(row?.id || '');
          if (!row || typeof row !== 'object' || Array.isArray(row) || !id
            || seen.has(id)) return true;
          seen.add(id);
          return false;
        })) {
        const error = new Error('Invalid atomic Task completion batch; no rows were saved.');
        error.code = 'TASKPOINTS_TASK_COMPLETION_BATCH_INVALID';
        throw error;
      }
      // Replace every batch ID in one pass instead of scanning the entire
      // pending journal once per changed row (up to 64 times per action).
      // Removing ALL old matches matches mergeById's duplicate cleanup, and
      // appending the validated rows retains its previous final ordering.
      record.completionUpserts = record.completionUpserts.filter(
        (entry) => !seen.has(String(entry?.id || ''))
      );
      for (const row of rows) record.completionUpserts.push(clone(row));
      record.completionDeletes = record.completionDeletes.filter(
        (entryId) => !seen.has(entryId)
      );
    }
    if (mutation.completionDeleteId) {
      const id = String(mutation.completionDeleteId);
      record.completionUpserts = record.completionUpserts.filter((entry) => String(entry?.id || '') !== id);
      if (!record.completionDeletes.includes(id)) record.completionDeletes.push(id);
    }
    record.updatedAtISO = new Date().toISOString();
    const saved = writeRecord(record, true, current.raw);
    mutationGeneration += 1;
    try { core.noteStorageUserInteraction?.(); } catch (_) {}
    // saved is the exact successfully written normalized journal; avoid
    // immediately re-reading and deep-cloning all pending rows just to
    // schedule an idle compaction. persistPending() still reloads at execution.
    scheduleCompaction('mutation', saved);
    // Observe successful live V1 Task interactions on preview hosts only.
    // The V2 preview side runs after deep idle, never before the synchronous
    // journal write or before the UI can show the saved Task.
    const taskRelevant = Boolean(mutation.task?.id
      || mutation.completionUpsert?.taskId
      || mutation.completionDeleteId
      || (Array.isArray(mutation.completionUpserts)
        && mutation.completionUpserts.some(row => row?.taskId)));
    if (taskRelevant) {
      try { global.TaskPointsStateRuntimeV2?.queueObservedLegacyTaskJournal?.(); }
      catch (_) {}
    }
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
    if (record.completionUpserts.length < 8) {
      // Single-row interaction replays stay cheap; indexing the entire
      // completion history would cost more than a handful of lookups.
      for (const patch of record.completionUpserts) {
        const id = String(patch.id);
        const at = completions.findIndex((entry) => String(entry?.id || '') === id);
        if (at >= 0) completions[at] = clone(patch);
        else completions.unshift(clone(patch));
      }
      state.completions = completions;
    } else {
      // When an un-compacted journal contains many completion edits,
      // findIndex for every patch repeatedly scans the full history.
      // Record the FIRST existing index so duplicate legacy IDs behave
      // exactly like findIndex, and hold new IDs in a front buffer so we
      // never shift the large array for each insertion.
      const existingIndex = new Map();
      for (let i = 0; i < completions.length; i += 1) {
        const id = String(completions[i]?.id || '');
        if (!existingIndex.has(id)) existingIndex.set(id, i);
      }
      const front = [];
      const frontIndex = new Map();
      for (const patch of record.completionUpserts) {
        const id = String(patch.id);
        if (frontIndex.has(id)) {
          front[frontIndex.get(id)] = clone(patch);
        } else if (existingIndex.has(id)) {
          completions[existingIndex.get(id)] = clone(patch);
        } else {
          frontIndex.set(id, front.length);
          front.push(clone(patch));
        }
      }
      // Legacy unshift order is newest unseen ID first. Repeated IDs
      // replace their prior first insertion rather than duplicating it.
      state.completions = front.length ? front.reverse().concat(completions) : completions;
    }
    return state;
  }

  function valueMatches(savedValue, patchValue) {
    try { return JSON.stringify(savedValue) === JSON.stringify(patchValue); }
    catch (_) { return false; }
  }

  function rowMatchesExpected(saved, expected) {
    if (!saved || !expected) return false;
    for (const [key, value] of Object.entries(expected)) {
      if (!valueMatches(saved[key], value)) return false;
    }
    return true;
  }

  function compactedTaskOmissionMatches(saved, key, expectedValue, compactedStorage) {
    if (!compactedStorage || Object.prototype.hasOwnProperty.call(saved, key)) return false;
    if (key === 'originalDueDateISO') return valueMatches(saved.dueDateISO, expectedValue);
    if (key === 'recurrence') return valueMatches(expectedValue, { mode: 'none' });
    if (key === 'tags' || key === 'skipDates') return Array.isArray(expectedValue) && expectedValue.length === 0;
    if (key === 'skills') {
      return valueMatches(expectedValue, [{ skill: '', pts: '' }, { skill: '', pts: '' }]);
    }
    if (key === 'hidden') return expectedValue === false;
    if (key === 'deletedAt' || key === 'deletedFrom' || key === 'prevStatus' || key === 'completedAtISO') {
      return expectedValue == null;
    }
    if (key === 'postponedDays') return Number(expectedValue) === 0;
    return false;
  }

  function taskPatchVerified(saved, patch, normalizedExpectedState, compactedStorage = false) {
    if (!saved || !patch) return false;
    const id = String(patch.id || '');
    const normalized = normalizedExpectedState
      ? (normalizedExpectedState.tasks || []).find((task) => String(task?.id || '') === id)
      : null;
    if (normalizedExpectedState && !normalized) return false;
    for (const [key, patchValue] of Object.entries(patch)) {
      // `deletedAt` is a legacy alias. The canonical save path may retain only
      // `deletedAtISO`; that omission is safe only when the normalized output
      // still carries the canonical deletion timestamp.
      if (key === 'deletedAt' && normalized && !Object.prototype.hasOwnProperty.call(normalized, key)) {
        if (!Object.prototype.hasOwnProperty.call(normalized, 'deletedAtISO')) return false;
        continue;
      }
      const expectedValue = normalized && Object.prototype.hasOwnProperty.call(normalized, key)
        ? normalized[key]
        : patchValue;
      if (valueMatches(saved[key], expectedValue)) continue;
      // Large snapshots are intentionally compacted before localStorage write.
      // That representation omits only canonical defaults that the load path
      // reconstructs (empty arrays, false/null defaults, zero postponements,
      // and originalDueDateISO when it equals dueDateISO). Treat only those
      // documented omissions as equivalent; every substantive field remains
      // mandatory for journal verification.
      if (compactedTaskOmissionMatches(saved, key, expectedValue, compactedStorage)) continue;
      return false;
    }
    return true;
  }

  function snapshotVerified(savedState, record, normalizedExpectedState = null) {
    if (!savedState || typeof savedState !== 'object') return false;
    const compactedStorage = Number(savedState.__storageCompactVersion) === 1;
    for (const patch of record.tasks) {
      const id = String(patch.id);
      const saved = (savedState.tasks || []).find((task) => String(task?.id || '') === id);
      if (!taskPatchVerified(saved, patch, normalizedExpectedState, compactedStorage)) return false;
    }
    for (const patch of record.completionUpserts) {
      const id = String(patch.id);
      const saved = (savedState.completions || []).find((entry) => String(entry?.id || '') === id);
      if (!rowMatchesExpected(saved, patch)) return false;
    }
    for (const id of record.completionDeletes) {
      if ((savedState.completions || []).some((entry) => String(entry?.id || '') === String(id))) return false;
      if (normalizedExpectedState && (normalizedExpectedState.completions || []).some((entry) => String(entry?.id || '') === String(id))) return false;
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
    writeRecord(record, true, current.raw);
    return true;
  }

  function persistedState() {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    if (typeof core.parseTaskPointsStorageJson === 'function') return core.parseTaskPointsStorageJson(raw, {}) || {};
    return JSON.parse(raw) || {};
  }

  function isoToMs(value) {
    if (!value) return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  function taskVersionMs(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return 0;
    return Math.max(
      isoToMs(task.updatedAtISO),
      isoToMs(task.createdAtISO),
      isoToMs(task.completedAtISO),
      isoToMs(task.deletedAtISO)
    );
  }

  function protectNewerPersistedTaskRows(candidateState, options = {}, suppliedSavedState = null) {
    if (options.allowDestructiveOverwrite === true) return candidateState;
    if ((options.storageKey || STORAGE_KEY) !== STORAGE_KEY) return candidateState;
    if (!candidateState || typeof candidateState !== 'object' || !Array.isArray(candidateState.tasks)) return candidateState;

    let savedState = suppliedSavedState;
    if (!savedState) {
      try { savedState = persistedState(); }
      catch (_) { return candidateState; }
    }
    if (!Array.isArray(savedState?.tasks) || savedState.tasks.length === 0) return candidateState;

    const savedById = new Map();
    savedState.tasks.forEach((task) => {
      const id = String(task?.id || '');
      if (id) savedById.set(id, task);
    });

    let protectedCount = 0;
    const tasks = candidateState.tasks.map((task) => {
      const id = String(task?.id || '');
      if (!id) return task;
      const saved = savedById.get(id);
      if (!saved) return task;

      // A delayed full-state save may have been captured before a journaled
      // task edit (+1 Day, Edit Save, Won't Do) compacted successfully. Once
      // the journal clears, that older snapshot must not roll the task back.
      // Preserve only strictly newer persisted rows; equal/newer incoming rows
      // still win, and destructive import/restore explicitly bypasses this.
      if (taskVersionMs(saved) > taskVersionMs(task)) {
        protectedCount += 1;
        return clone(saved);
      }
      return task;
    });

    if (!protectedCount) return candidateState;
    try {
      global.TaskPointsPerf?.mark?.('taskMutation.staleTaskRowsProtected', {
        count: protectedCount,
        savePath: options.savePath || options.source || options.reason || ''
      });
    } catch (_) {}
    return { ...candidateState, tasks };
  }

  // The Home screen may hold an older in-memory snapshot while another
  // journal compacts (or another tab commits an SCWM entry). Once that
  // journal clears, a delayed Home season/score save must not delete the
  // newer, already-persisted metric completion. Protect only recently
  // persisted *missing IDs*, not edits or explicit import/reset operations.
  function protectRecentScwmRowsFromStaleHomeSave(candidateState, savedState, options = {}) {
    if (options.allowDestructiveOverwrite === true
      || options.allowScwmCompletionRemoval === true
      || (options.storageKey || STORAGE_KEY) !== STORAGE_KEY) return candidateState;
    const pathname = String(global.location?.pathname || '');
    const homePage = pathname === '/' || pathname === '' || pathname.endsWith('/index.html');
    const savePath = String(options.savePath || options.source || options.reason || '');
    if (!homePage && !savePath.startsWith('home-')) return candidateState;
    if (!Array.isArray(candidateState?.completions) || !Array.isArray(savedState?.completions)) return candidateState;

    const currentIds = new Set(candidateState.completions
      .filter((entry) => entry?.id != null)
      .map((entry) => String(entry.id)));
    const protectedRows = [];
    const cutoff = Date.now() - 14 * 86400000;
    const isScwm = (entry) => {
      const title = String(entry?.title || '');
      return title.startsWith('Sleep Score') || title.startsWith('Mood Score')
        || title.startsWith('Work Score') || title.startsWith('Calories');
    };
    // Do not restore an older entry deliberately replaced by another record
    // of the same category and day (or an explicit SCWM deletion).
    const categoryDay = (entry) => {
      const title = String(entry?.title || '');
      const category = title.startsWith('Sleep Score') ? 'sleep'
        : title.startsWith('Mood Score') ? 'mood'
        : title.startsWith('Work Score') ? 'work'
        : title.startsWith('Calories') ? 'calories' : '';
      const date = String(entry?.completedAtISO || '').slice(0, 10);
      return category && /^\d{4}-\d{2}-\d{2}$/.test(date) ? category + ':' + date : '';
    };
    const currentCategoryDays = new Set(candidateState.completions.map(categoryDay).filter(Boolean));
    for (const entry of savedState.completions) {
      const id = String(entry?.id || '');
      if (!id || !isScwm(entry) || currentIds.has(id)) continue;
      const at = Date.parse(entry?.completedAtISO || '');
      if (!Number.isFinite(at) || at < cutoff || at > Date.now() + 86400000) continue;
      const slot = categoryDay(entry);
      if (slot && currentCategoryDays.has(slot)) continue;
      currentIds.add(id);
      if (slot) currentCategoryDays.add(slot);
      protectedRows.push(clone(entry));
    }
    if (!protectedRows.length) return candidateState;
    try {
      global.TaskPointsPerf?.mark?.('taskMutation.staleScwmRowsProtected', {
        count: protectedRows.length,
        savePath
      });
    } catch (_) {}
    return { ...candidateState, completions: [...protectedRows, ...candidateState.completions] };
  }

  // V2-only containment for the stale-Home save race observed during the
  // rapid Habit WAL interruption test. These two background maintenance paths
  // do not edit Habits or completion records. They must not replace those
  // authoritative collections using an old in-memory Home snapshot.
  // A fresh journal overlay is applied *after* the newest stored snapshot,
  // so a tap that has not yet compacted still wins (including off/failed).
  function preserveHabitPilotOnHomeMaintenance(candidateState, savedState, options = {}) {
    const savePath = String(options.savePath || options.source || options.reason || '');
    if (savePath !== 'home-season-slate-idle-materialization'
      && savePath !== 'home-live-diff-capture') return candidateState;
    if (options.allowDestructiveOverwrite === true
      || options.allowHabitCompletionRemoval === true
      || (options.storageKey || STORAGE_KEY) !== STORAGE_KEY) return candidateState;
    if (!candidateState || typeof candidateState !== 'object'
      || !Array.isArray(candidateState.completions)
      || !Array.isArray(savedState?.completions)) {
      throw new Error('Latest persisted Habit pilot unavailable; background save blocked');
    }
    // Older snapshots may legitimately omit the Habits key when the user
    // has no Habits at all. Only block a missing *persisted* Habit collection
    // when the candidate actually claims Habit data could be lost.
    const candidateHabits = Array.isArray(candidateState.habits) ? candidateState.habits : [];
    const savedHabits = Array.isArray(savedState.habits) ? savedState.habits : [];
    if (candidateHabits.length && !Array.isArray(savedState.habits)) {
      throw new Error('Latest persisted Habits collection unavailable; background save blocked');
    }

    // A malformed nonempty Habit journal is evidence of an unresolved write.
    // Never discard that evidence by running another full-state maintenance save.
    const pending = typeof core.readPendingHabitDeltas === 'function'
      ? core.readPendingHabitDeltas()
      : [];
    if (pending.length && typeof core.applyPendingHabitDeltas !== 'function') {
      throw new Error('Habit journal replay unavailable; stale Home maintenance save blocked');
    }
    // Keep nonpilot candidate completions (SCWM, Tasks, Flex, manual etc.)
    // untouched. Only Habit/Vice completion records are owned by this guard.
    // Preserve saved pilot ordering even if the old Home snapshot has fewer
    // pilot entries; never duplicate a restored completion.
    const isPilot = (row) => Boolean(row?.habitId)
      && (row.source === 'habit' || row.source === 'vice');
    const savedPilot = savedState.completions.filter(isPilot).map(clone);
    const merged = [];
    let position = 0;
    candidateState.completions.forEach((row) => {
      if (!isPilot(row)) {
        merged.push(row);
      } else if (position < savedPilot.length) {
        merged.push(savedPilot[position]);
        position += 1;
      }
    });
    const missingSavedPilot = savedPilot.slice(position);
    const authoritative = {
      habits: clone(savedHabits),
      completions: missingSavedPilot.concat(merged)
    };
    if (pending.length) core.applyPendingHabitDeltas(authoritative, pending);
    try {
      global.TaskPointsPerf?.mark?.('stateV2.legacyHabitMaintenanceRebased', {
        savePath,
        pendingDeltas: pending.length,
        savedHabits: authoritative.habits.length,
        savedCompletions: authoritative.completions.length
      });
    } catch (_) {}
    return { ...candidateState, habits: authoritative.habits, completions: authoritative.completions };
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
      // Another tab may finish a Task edit or compact/clear its journal
      // while this tab decodes the full V1 snapshot. Refuse to overwrite
      // that peer's newer snapshot using a candidate based on older journal
      // evidence. This check narrows a known race; localStorage cannot
      // provide an atomic cross-tab compare-and-swap or certify V2 ownership.
      let latestJournalRaw;
      try { latestJournalRaw = storage.getItem(JOURNAL_KEY); }
      catch (_) { latestJournalRaw = undefined; }
      if (latestJournalRaw === undefined
        || (latestJournalRaw === null ? '' : latestJournalRaw) !== current.raw) {
        journalSourceConflicts += 1;
        throw new Error('Task journal changed during compaction preparation; older snapshot was not saved.');
      }
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
      // saveStateSnapshot may intentionally normalize task rows. Verify the
      // canonical snapshot against the normalized state it actually committed,
      // rather than requiring byte-for-byte equality with the pre-save patch.
      if (!snapshotVerified(saved, snapshot, result.state)) throw new Error('Task mutation journal compaction verification failed.');
      // The underlying V1 snapshot can be correct while a peer/reset has
      // replaced the pending journal with malformed or newer evidence.
      // Decline completion unless cleanup explicitly succeeded; an older
      // "false" return must never become an acknowledged compacted edit.
      if (clearVerifiedSnapshot(snapshot) !== true)
        throw new Error('Task mutation journal cleanup could not be confirmed; pending changes retained.');
      retryCount = 0;
      compactionsCompleted += 1;
      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionComplete', { reason }); } catch (_) {}
      return true;
    } catch (error) {
      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionFailed', { reason, message: String(error?.message || error) }); } catch (_) {}
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

  function runInIdleSlot(run, scheduledGeneration) {
    return new Promise((resolve) => {
      const invoke = () => {
        if (scheduledGeneration !== mutationGeneration) {
          preflightDeferrals += 1;
          try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'journal-mutated' }); } catch (_) {}
          resolve(false);
          return;
        }
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

  async function runWhenQuiet(reason, scheduledGeneration) {
    const gate = core.whenStorageMaintenanceQuiet;
    if (typeof gate === 'function') {
      const gateReady = await Promise.resolve(gate(() => true, { reason: SAVE_PATH }));
      if (gateReady !== true) return false;
    } else {
      await delay(1500);
      if (!maintenanceStillQuiet()) return false;
    }

    // Do not launch a long, non-yielding compression immediately after the
    // generic 1.4 s gate. Require a full 7 s since the most recent interaction,
    // then verify quiet again immediately before entering compression. A new
    // journal mutation also invalidates this countdown even if an older
    // startup-replay attempt had already passed the generic quiet gate.
    const idleStatus = core.getStorageMaintenanceIdleStatus?.() || null;
    const idleAgo = Math.max(0, Number(idleStatus?.lastInteractionAgoMs) || 0);
    await delay(Math.max(0, COMPACTION_MIN_IDLE_MS - idleAgo));
    const finalIdleStatus = core.getStorageMaintenanceIdleStatus?.() || null;
    const finalIdleAgo = Math.max(0, Number(finalIdleStatus?.lastInteractionAgoMs) || 0);
    if (scheduledGeneration !== mutationGeneration) {
      preflightDeferrals += 1;
      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'journal-mutated' }); } catch (_) {}
      return false;
    }
    if (!maintenanceStillQuiet() || finalIdleAgo < COMPACTION_MIN_IDLE_MS) {
      preflightDeferrals += 1;
      try { global.TaskPointsPerf?.mark?.('taskMutation.compactionDeferred', { stage: 'sustained-quiet' }); } catch (_) {}
      return false;
    }
    return runInIdleSlot(() => persistPending(reason), scheduledGeneration);
  }

  function scheduleCompaction(reason = 'scheduled', knownJustWrittenRecord = null) {
    if (compactionScheduled || compactionRunning) return false;
    // Foreground mutations already wrote and validated this exact journal
    // synchronously. Startup, retries and other callers still read durable
    // storage here. Actual idle compaction ALWAYS re-reads the current bytes.
    if (knownJustWrittenRecord !== null) {
      if (isEmpty(knownJustWrittenRecord)) return false;
    } else {
      const current = readRecord();
      if (current.malformed || isEmpty(current.record)) return false;
    }
    compactionScheduled = true;
    const scheduledGeneration = mutationGeneration;
    global.setTimeout?.(() => {
      runWhenQuiet(reason, scheduledGeneration)
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
      // Read the persisted snapshot once for both stale-task and stale-SCWM
      // guards; large TaskPoints datasets should not be parsed twice.
      let savedForProtection = null;
      try { savedForProtection = persistedState(); } catch (_) {}
      const protectedTasks = protectNewerPersistedTaskRows(state, options, savedForProtection);
      const protectedState = protectRecentScwmRowsFromStaleHomeSave(protectedTasks, savedForProtection, options);
      let habitSafeState;
      try {
        habitSafeState = preserveHabitPilotOnHomeMaintenance(protectedState, savedForProtection, options);
      } catch (error) {
        // Home's save() catch branch has an unguarded last-ditch writer.
        // Return a skipped save instead of throwing into that fallback.
        console.warn('V2 Habit authority guard postponed Home maintenance save.', error);
        try {
          global.TaskPointsPerf?.mark?.('stateV2.legacyHabitMaintenanceBlocked', {
            savePath: options.savePath || options.source || options.reason || ''
          });
        } catch (_) {}
        return { state, skipped: true, blockedByHabitJournal: true };
      }
      const candidate = current.malformed || isEmpty(current.record)
        ? habitSafeState
        : applyRecord(habitSafeState, current.record);
      // Keep deletion intent attached to this *specific*, already-read
      // durable Task journal. The core's ordinary sticky-array rescue must
      // not reinterpret a valid final empty completions array as accidental
      // corruption, nor drop unrelated completions from newer tabs.
      const pendingTaskCompletionDeleteIds = !current.malformed
        && current.record.completionDeletes.length
        ? [...current.record.completionDeletes] : null;
      const protectedSaveOptions = pendingTaskCompletionDeleteIds
        ? { ...options, pendingTaskCompletionDeleteIds }
        : options;
      const result = originalSaveStateSnapshot(candidate, protectedSaveOptions);
      if (!current.malformed && !isEmpty(current.record) && !result?.skipped && !result?.blockedByQuotaCircuit && result?.state) {
        try {
          const saved = persistedState();
          if (snapshotVerified(saved, current.record, result.state)) clearVerifiedSnapshot(current.record);
        } catch (_) {}
      }
      return result;
    };
  }

  core.readPendingTaskMutations = () => readRecord();
  core.applyPendingTaskMutations = applyRecord;
  core.assertTaskMutationJournalWritable = assertJournalWritable;
  core.journalTaskMutation = journalMutation;
  // V2-branch migration stepping stone. This remains an ordinary V1
  // synchronous journal until real multi-context writer admission is proven.
  // Older journalTaskMutation callers and all recovery formats stay intact.
  core.journalTaskCompletionBatch = (rows) => journalMutation({ completionUpserts: rows });
  core.schedulePendingTaskMutationCompaction = scheduleCompaction;
  core.flushPendingTaskMutations = () => persistPending('explicit-flush');
  core.clearPendingTaskMutations = () => {
    storage.removeItem(JOURNAL_KEY);
    // Reset/recovery callers must never report a cleared Task journal while
    // stale pending edits can still replay after a later app restart.
    let remaining;
    try { remaining = storage.getItem(JOURNAL_KEY); }
    catch (_) { remaining = undefined; }
    if (remaining !== null) {
      journalWritesUnverified += 1;
      const error = new Error('Task mutation journal cleanup was not verified; pending changes were preserved.');
      error.code = 'TASKPOINTS_TASK_MUTATION_JOURNAL_UNVERIFIED_CLEAR';
      throw error;
    }
    journalWritesVerified += 1;
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
      minIdleBeforeCompactionMs: COMPACTION_MIN_IDLE_MS,
      preflightDeferrals,
      compactionsStarted,
      compactionsCompleted,
      mutationGeneration,
      journalWritesVerified,
      journalWritesUnverified,
      journalSourceConflicts
    };
  };

  global.setTimeout?.(() => scheduleCompaction('startup-replay'), 0);
})(typeof window !== 'undefined' ? window : globalThis);
