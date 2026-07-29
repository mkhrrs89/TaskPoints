(function installTaskPointsFlexActionFastPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || global.__taskPointsFlexActionFastPathInstalled) return;
  global.__taskPointsFlexActionFastPathInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const JOURNAL_KEY = 'taskpoints_pending_flex_completions_v1';
  const SAVE_PATH = 'flex-completion-fast-path';
  const MAX_INSTALL_ATTEMPTS = 120;
  const RETRY_DELAY_MS = 1000;
  const originalLoadAppState = typeof core.loadAppState === 'function' ? core.loadAppState.bind(core) : null;
  const originalSaveStateSnapshot = typeof core.saveStateSnapshot === 'function' ? core.saveStateSnapshot.bind(core) : null;

  let installAttempts = 0;
  let uiInstalled = false;
  let savePending = false;
  let saveRunning = false;
  let saveRaf = 0;
  let saveTimer = 0;
  let retryTimer = 0;
  let malformedWarningShown = false;
  let originalLogFlexCompletion = null;
  let originalHomeSave = null;
  let originalAddCompletion = null;
  let originalRenderAll = null;
  let originalRenderFlexActions = null;
  let originalResetAll = null;

  function parse(raw, fallback = null) {
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  function normalizeEntry(entry) {
    if (!entry || entry.source !== 'flex' || !entry.id || !entry.flexId || !entry.completedAtISO) return null;
    return {
      ...entry,
      id: String(entry.id),
      flexId: String(entry.flexId),
      taskId: entry.taskId == null ? null : entry.taskId,
      title: String(entry.title || '[Flex]'),
      points: Number(entry.points) || 0,
      completedAtISO: String(entry.completedAtISO),
      source: 'flex'
    };
  }

  function readJournalRecord() {
    const raw = storage.getItem(JOURNAL_KEY);
    if (!raw) return { raw: '', malformed: false, entries: [] };
    const parsed = parse(raw, null);
    if (!Array.isArray(parsed)) return { raw, malformed: true, entries: [] };
    const byId = new Map();
    parsed.forEach((entry) => {
      const normalized = normalizeEntry(entry);
      if (normalized) byId.set(normalized.id, normalized);
    });
    return { raw, malformed: false, entries: [...byId.values()] };
  }

  function readJournal() {
    return readJournalRecord().entries;
  }

  function warnMalformedJournal() {
    if (malformedWarningShown) return;
    malformedWarningShown = true;
    const message = 'TaskPoints preserved a malformed pending Flex Action journal instead of overwriting it. No new Flex Action was recorded.';
    console.error(message);
    try { global.alert?.(message); } catch (_) {}
  }

  function recoveryWriteAllowed() {
    const recoveryGuard = global.TaskPointsRecoveryJournalWriteLockGuard;
    const recoveryLock = recoveryGuard?.readLock?.() || null;
    if (recoveryLock && recoveryGuard?.pageMayWrite?.(recoveryLock) !== true) return false;
    const recoveryAttempt = global.TaskPointsRecoveryAttemptWriteLockGuard?.readAttemptLock?.() || null;
    return !recoveryAttempt;
  }

  function writeJournal(entries) {
    if (!recoveryWriteAllowed()) {
      const error = new Error('TaskPoints paused Flex Action changes while recovery protection is active.');
      error.code = 'TASKPOINTS_FLEX_JOURNAL_WRITE_LOCKED';
      throw error;
    }
    const existing = readJournalRecord();
    if (existing.malformed) {
      warnMalformedJournal();
      const error = new Error('Pending Flex Action journal is malformed and was preserved.');
      error.code = 'TASKPOINTS_FLEX_JOURNAL_MALFORMED';
      throw error;
    }
    const normalized = (entries || []).map(normalizeEntry).filter(Boolean);
    if (!normalized.length) {
      storage.removeItem(JOURNAL_KEY);
      return [];
    }
    storage.setItem(JOURNAL_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function appendJournal(entry) {
    const normalized = normalizeEntry(entry);
    if (!normalized) return null;
    const record = readJournalRecord();
    if (record.malformed) {
      warnMalformedJournal();
      const error = new Error('Pending Flex Action journal is malformed and was preserved.');
      error.code = 'TASKPOINTS_FLEX_JOURNAL_MALFORMED';
      throw error;
    }
    const entries = record.entries;
    const at = entries.findIndex((item) => item.id === normalized.id);
    if (at >= 0) entries[at] = normalized;
    else entries.push(normalized);
    writeJournal(entries);
    return normalized;
  }

  function applyJournalToState(sourceState, entries = readJournal()) {
    const state = sourceState && typeof sourceState === 'object' && !Array.isArray(sourceState)
      ? sourceState
      : {};
    const completions = Array.isArray(state.completions) ? state.completions : [];
    const existingIds = new Set(completions.map((entry) => entry?.id).filter(Boolean));
    const additions = entries
      .map(normalizeEntry)
      .filter((entry) => entry && !existingIds.has(entry.id))
      .sort((a, b) => String(b.completedAtISO).localeCompare(String(a.completedAtISO)));
    if (!additions.length && Array.isArray(state.completions)) return state;
    return { ...state, completions: [...additions, ...completions] };
  }

  function storedCompletionIds(storageKey = STORAGE_KEY) {
    const raw = storage.getItem(storageKey);
    if (!raw) return new Set();
    try {
      const saved = typeof core.parseTaskPointsStorageJson === 'function'
        ? core.parseTaskPointsStorageJson(raw, {})
        : JSON.parse(raw);
      return new Set((Array.isArray(saved?.completions) ? saved.completions : []).map((entry) => entry?.id).filter(Boolean));
    } catch (_) {
      return new Set();
    }
  }

  function clearVerifiedJournal(storageKey = STORAGE_KEY) {
    const record = readJournalRecord();
    if (record.malformed || !record.entries.length) return 0;
    const savedIds = storedCompletionIds(storageKey);
    const remaining = record.entries.filter((entry) => !savedIds.has(entry.id));
    if (remaining.length === record.entries.length) return 0;
    try {
      writeJournal(remaining);
      return record.entries.length - remaining.length;
    } catch (error) {
      console.warn('TaskPoints saved the Flex Action completion but retained its journal for a later verification retry.', error);
      return 0;
    }
  }

  if (originalLoadAppState) {
    core.loadAppState = function loadAppStateWithPendingFlex(...args) {
      const result = originalLoadAppState(...args);
      const record = readJournalRecord();
      if (record.malformed || !record.entries.length || !result?.state) return result;
      return { ...result, state: applyJournalToState(result.state, record.entries), pendingFlexCompletions: record.entries.length };
    };
  }

  if (originalSaveStateSnapshot) {
    core.saveStateSnapshot = function saveStateSnapshotWithPendingFlex(state, options = {}) {
      const record = readJournalRecord();
      const candidate = record.malformed || !record.entries.length ? state : applyJournalToState(state, record.entries);
      const result = originalSaveStateSnapshot(candidate, options);
      if (!result?.skipped && !result?.blockedByQuotaCircuit && result?.state && record.entries.length) {
        clearVerifiedJournal(options.storageKey || STORAGE_KEY);
      }
      return result;
    };
  }

  function cancelScheduledSave() {
    if (saveRaf && typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(saveRaf);
    if (saveTimer) global.clearTimeout?.(saveTimer);
    saveRaf = 0;
    saveTimer = 0;
  }

  function scheduleRetry() {
    if (retryTimer || !readJournal().length) return;
    retryTimer = global.setTimeout?.(() => {
      retryTimer = 0;
      savePending = true;
      persistNow('retry');
    }, RETRY_DELAY_MS) || 0;
  }

  function requestFullRender() {
    if (typeof originalRenderAll !== 'function') return;
    if (typeof global.scheduleRender === 'function') global.scheduleRender(originalRenderAll);
    else if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(() => originalRenderAll());
    else global.setTimeout?.(() => originalRenderAll(), 0);
  }

  function persistNow(reason = 'background') {
    if (saveRunning) {
      savePending = true;
      return false;
    }
    cancelScheduledSave();
    const record = readJournalRecord();
    if (record.malformed) return false;
    if (!savePending && !record.entries.length) return false;
    if (typeof originalHomeSave !== 'function') return false;

    savePending = false;
    saveRunning = true;
    try {
      originalHomeSave(SAVE_PATH, {
        userInitiated: true,
        interactive: true,
        deferCompression: true,
        flexFastPathReason: reason
      });
    } catch (error) {
      console.warn('TaskPoints Flex Action background save failed; the pending completion journal was retained.', error);
    } finally {
      saveRunning = false;
      requestFullRender();
    }

    const remaining = readJournal().length;
    if (remaining) scheduleRetry();
    return remaining === 0;
  }

  function scheduleSaveAfterPaint() {
    savePending = true;
    if (saveRaf || saveTimer || saveRunning) return;
    const queueTimer = () => {
      saveRaf = 0;
      saveTimer = global.setTimeout?.(() => {
        saveTimer = 0;
        persistNow('after-paint');
      }, 0) || 0;
    };
    if (typeof global.requestAnimationFrame === 'function') saveRaf = global.requestAnimationFrame(queueTimer);
    else queueTimer();
  }

  function findFlexRow(id) {
    const buttons = global.document?.querySelectorAll?.('[data-act="flex-do"][data-id]') || [];
    for (const button of buttons) {
      if (button.getAttribute?.('data-id') === id) return button.closest?.('.flex-action-row') || null;
    }
    return null;
  }

  function showInstantDot(id) {
    const row = findFlexRow(id);
    const usage = row?.querySelector?.('.flex-action-usage');
    if (!usage || typeof global.document?.createElement !== 'function') return false;
    let dots = usage.querySelector?.('.flex-action-dots');
    if (!dots) {
      dots = global.document.createElement('span');
      dots.className = 'flex-action-dots';
      usage.appendChild(dots);
    }
    const dot = global.document.createElement('span');
    dot.className = 'flex-action-dot flex-action-dot--pop';
    dots.appendChild(dot);
    const count = dots.querySelectorAll?.('.flex-action-dot')?.length || 1;
    const flexDayLabel = typeof global.isViewingFlexYesterday === 'function' && global.isViewingFlexYesterday()
      ? 'yesterday'
      : 'today';
    dots.setAttribute?.('aria-label', `${count} time${count === 1 ? '' : 's'} used ${flexDayLabel}`);
    return true;
  }

  function installFlushBridge() {
    const current = core.flushPendingSaves;
    if (typeof current !== 'function') return false;
    if (current.__taskPointsFlexActionFastPath) return true;
    const wrapped = function flushPendingSavesWithFlex(...args) {
      const result = current.apply(this, args);
      persistNow('core-flush');
      return result;
    };
    wrapped.__taskPointsFlexActionFastPath = true;
    wrapped.__taskPointsOriginal = current;
    core.flushPendingSaves = wrapped;
    return true;
  }

  function installUiPatch() {
    if (uiInstalled) {
      installFlushBridge();
      return true;
    }
    if (typeof global.logFlexCompletion !== 'function'
      || typeof global.save !== 'function'
      || typeof global.addCompletion !== 'function'
      || typeof global.renderFlexActions !== 'function') return false;

    originalLogFlexCompletion = global.logFlexCompletion;
    originalHomeSave = global.save;
    originalAddCompletion = global.addCompletion;
    originalRenderAll = typeof global.renderAll === 'function' ? global.renderAll : null;
    originalRenderFlexActions = global.renderFlexActions;
    originalResetAll = typeof global.resetAll === 'function' ? global.resetAll : null;

    const fastLogFlexCompletion = function taskPointsFastLogFlexCompletion(...args) {
      const id = String(args[0] || '');
      let saveRequested = false;
      let fullRenderRequested = false;
      const priorSave = global.save;
      const priorAddCompletion = global.addCompletion;
      const priorRenderAll = global.renderAll;
      const priorRenderFlexActions = global.renderFlexActions;

      const suppressedSave = function suppressedFlexSave() {
        saveRequested = true;
      };
      const journaledAddCompletion = function journaledFlexAddCompletion(entry) {
        if (entry?.source === 'flex' && entry?.flexId) appendJournal(entry);
        return originalAddCompletion.call(this, entry);
      };
      const deferredRenderAll = function deferredFlexRenderAll() {
        fullRenderRequested = true;
      };
      const instantFlexRender = function instantFlexRender() {
        fullRenderRequested = true;
        if (!showInstantDot(id)) return originalRenderFlexActions.call(this);
        return undefined;
      };

      global.save = suppressedSave;
      global.addCompletion = journaledAddCompletion;
      if (typeof priorRenderAll === 'function') global.renderAll = deferredRenderAll;
      global.renderFlexActions = instantFlexRender;

      let result;
      try {
        result = originalLogFlexCompletion.apply(this, args);
      } finally {
        if (global.save === suppressedSave) global.save = priorSave;
        if (global.addCompletion === journaledAddCompletion) global.addCompletion = priorAddCompletion;
        if (global.renderAll === deferredRenderAll) global.renderAll = priorRenderAll;
        if (global.renderFlexActions === instantFlexRender) global.renderFlexActions = priorRenderFlexActions;
      }

      if (fullRenderRequested) savePending = true;
      if (saveRequested || readJournal().length) scheduleSaveAfterPaint();
      return result;
    };

    fastLogFlexCompletion.__taskPointsFlexActionFastPath = true;
    fastLogFlexCompletion.__taskPointsOriginal = originalLogFlexCompletion;
    global.logFlexCompletion = fastLogFlexCompletion;

    if (originalResetAll && !originalResetAll.__taskPointsFlexActionFastPath) {
      const resetWithFlexFlush = function resetAllWithPendingFlex(...args) {
        persistNow('before-reset');
        const priorConfirm = global.confirm;
        let resetConfirmed = false;
        if (typeof priorConfirm === 'function') {
          global.confirm = function flexAwareResetConfirm(...confirmArgs) {
            const accepted = priorConfirm.apply(this, confirmArgs);
            if (accepted) resetConfirmed = true;
            return accepted;
          };
        }
        try {
          return originalResetAll.apply(this, args);
        } finally {
          if (global.confirm !== priorConfirm) global.confirm = priorConfirm;
          if (resetConfirmed) {
            try { storage.removeItem(JOURNAL_KEY); } catch (_) {}
          }
        }
      };
      resetWithFlexFlush.__taskPointsFlexActionFastPath = true;
      resetWithFlexFlush.__taskPointsOriginal = originalResetAll;
      global.resetAll = resetWithFlexFlush;
    }

    installFlushBridge();
    uiInstalled = true;

    if (readJournal().length) scheduleSaveAfterPaint();
    return true;
  }

  function installWhenReady() {
    const installed = installUiPatch();
    installAttempts += 1;
    if ((!installed || !installFlushBridge()) && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, 50);
    }
  }

  global.addEventListener?.('pagehide', () => persistNow('pagehide'));
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document.visibilityState === 'hidden') persistNow('visibility-hidden');
  });

  core.PENDING_FLEX_COMPLETIONS_KEY = JOURNAL_KEY;
  core.readPendingFlexCompletions = readJournal;
  core.applyPendingFlexCompletions = applyJournalToState;
  core.getPendingFlexCompletionCount = () => readJournal().length;
  core.flushPendingFlexCompletions = () => persistNow('explicit-flush');
  global.TaskPointsFlexActionFastPath = {
    journalKey: JOURNAL_KEY,
    installUiPatch,
    persistNow,
    scheduleSaveAfterPaint,
    readJournal,
    readJournalRecord,
    showInstantDot
  };

  if (global.document?.readyState === 'loading') global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  else installWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);
