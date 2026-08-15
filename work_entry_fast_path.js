;(function installTaskPointsWorkEntryFastPath(global) {
  'use strict';

  if (global.TaskPointsWorkEntryFastPath?.installed) return;

  const VERSION = 2;
  const MAX_INSTALL_ATTEMPTS = 240;
  const INSTALL_RETRY_MS = 50;
  const POST_COMMIT_QUIET_MS = 3200;
  const QUIET_PULSE_MS = 450;
  const RECONCILE_RECHECK_MS = 650;
  const RECONCILE_IDLE_TIMEOUT_MS = 12000;
  const core = global.TaskPointsCore;

  if (!core) return;

  const originals = {};
  const wrapped = new Set();
  const counters = {
    installs: 0,
    fastCommits: 0,
    suppressedFullSaves: 0,
    journaledCompletionUpserts: 0,
    unchangedCommits: 0,
    fallbacks: 0,
    fallbackFullSaves: 0,
    maintenanceQuietPulses: 0,
    targetedRenders: 0,
    renderFallbacks: 0,
    canonicalReconciles: 0,
    canonicalReconcileDeferrals: 0
  };

  let installed = false;
  let installAttempts = 0;
  let installTimer = null;
  let quietTimer = null;
  let quietUntil = 0;
  let reconcileTimer = null;
  let reconcileIdleId = null;
  let reconcileIdleUsesTimeout = false;
  let canonicalReconcilePending = false;

  function now() {
    return Number(global.performance?.now?.()) || Date.now();
  }

  function perfMark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function homeState() {
    if (global.__tpWorkEntryStateForTest && typeof global.__tpWorkEntryStateForTest === 'object') {
      return global.__tpWorkEntryStateForTest;
    }
    if (global.state && typeof global.state === 'object') return global.state;
    try {
      return typeof global.eval === 'function'
        ? global.eval('typeof state !== "undefined" ? state : null')
        : null;
    } catch (_) {
      return null;
    }
  }

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function isWorkCompletion(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return entry.source === 'work' || String(entry.title || '').startsWith('Work Score');
  }

  function fingerprint(entry) {
    try { return JSON.stringify(entry); }
    catch (_) { return null; }
  }

  function snapshotWorkRows() {
    const state = homeState();
    if (!state || !Array.isArray(state.completions)) return null;
    const rows = new Map();
    for (const entry of state.completions) {
      if (!isWorkCompletion(entry) || entry.id == null) continue;
      rows.set(String(entry.id), fingerprint(entry));
    }
    return rows;
  }

  function changedWorkRows(before) {
    const state = homeState();
    if (!before || !state || !Array.isArray(state.completions)) return [];
    const changed = [];
    for (const entry of state.completions) {
      if (!isWorkCompletion(entry) || entry.id == null) continue;
      const id = String(entry.id);
      if (!before.has(id) || before.get(id) !== fingerprint(entry)) changed.push(entry);
    }
    return changed;
  }

  function noteInteraction() {
    try { core.noteStorageUserInteraction?.(); } catch (_) {}
    try { global.TaskPointsHomeIdleQueue?.noteInteraction?.(); } catch (_) {}
    counters.maintenanceQuietPulses += 1;
  }

  function stopQuietGuard() {
    if (quietTimer != null) global.clearTimeout?.(quietTimer);
    quietTimer = null;
    quietUntil = 0;
  }

  function holdMaintenanceQuiet() {
    stopQuietGuard();
    quietUntil = now() + POST_COMMIT_QUIET_MS;
    const pulse = () => {
      quietTimer = null;
      noteInteraction();
      const remaining = quietUntil - now();
      if (remaining <= 0) {
        quietUntil = 0;
        return;
      }
      quietTimer = global.setTimeout?.(pulse, Math.min(QUIET_PULSE_MS, Math.max(40, remaining))) || null;
    };
    pulse();
  }

  function workEditorVisible() {
    const modal = global.document?.getElementById?.('workEditModal');
    if (!modal) return false;
    if (modal.hidden === true || modal.classList?.contains?.('hidden')) return false;
    return modal.getAttribute?.('aria-hidden') !== 'true';
  }

  function maintenanceQuiet() {
    if (workEditorVisible()) return false;
    try {
      return typeof core.isStorageMaintenanceQuiet !== 'function'
        || core.isStorageMaintenanceQuiet() === true;
    } catch (_) {
      return false;
    }
  }

  function cancelCanonicalReconcile() {
    if (reconcileTimer != null) global.clearTimeout?.(reconcileTimer);
    reconcileTimer = null;
    if (reconcileIdleId != null) {
      if (reconcileIdleUsesTimeout) global.clearTimeout?.(reconcileIdleId);
      else global.cancelIdleCallback?.(reconcileIdleId);
    }
    reconcileIdleId = null;
    reconcileIdleUsesTimeout = false;
  }

  function runCanonicalReconcile() {
    reconcileIdleId = null;
    reconcileIdleUsesTimeout = false;
    if (!canonicalReconcilePending || global.document?.hidden) return false;
    if (!maintenanceQuiet()) {
      counters.canonicalReconcileDeferrals += 1;
      reconcileTimer = global.setTimeout?.(attemptCanonicalReconcile, RECONCILE_RECHECK_MS) || null;
      return false;
    }

    canonicalReconcilePending = false;
    const control = global.TaskPointsHomeTargetedRenderControl;
    if (typeof control?.reconcileNow !== 'function') return false;
    try {
      control.reconcileNow();
      counters.canonicalReconciles += 1;
      perfMark('workEntry.canonicalStatsReconciled', {});
      return true;
    } catch (error) {
      canonicalReconcilePending = true;
      counters.canonicalReconcileDeferrals += 1;
      reconcileTimer = global.setTimeout?.(attemptCanonicalReconcile, RECONCILE_RECHECK_MS) || null;
      return false;
    }
  }

  function attemptCanonicalReconcile() {
    reconcileTimer = null;
    if (!canonicalReconcilePending || global.document?.hidden) return false;
    if (!maintenanceQuiet()) {
      counters.canonicalReconcileDeferrals += 1;
      reconcileTimer = global.setTimeout?.(attemptCanonicalReconcile, RECONCILE_RECHECK_MS) || null;
      return false;
    }

    if (typeof global.requestIdleCallback === 'function') {
      reconcileIdleUsesTimeout = false;
      reconcileIdleId = global.requestIdleCallback(runCanonicalReconcile, { timeout: RECONCILE_IDLE_TIMEOUT_MS });
    } else {
      reconcileIdleUsesTimeout = true;
      reconcileIdleId = global.setTimeout?.(runCanonicalReconcile, 0) || null;
    }
    return true;
  }

  function scheduleCanonicalReconcile() {
    canonicalReconcilePending = true;
    cancelCanonicalReconcile();
    reconcileTimer = global.setTimeout?.(attemptCanonicalReconcile, POST_COMMIT_QUIET_MS) || null;
  }

  function refreshWorkUi() {
    try {
      if (typeof global.refreshScoreV2UI === 'function') {
        global.refreshScoreV2UI();
      } else {
        if (typeof global.renderScoreDashboardV2_Skeleton !== 'function' || typeof global.renderScoreV2RecentGrid !== 'function') {
          throw new Error('SCWM renderers unavailable');
        }
        global.renderScoreDashboardV2_Skeleton();
        global.renderScoreV2RecentGrid();
      }

      const control = global.TaskPointsHomeTargetedRenderControl;
      if (typeof control?.refreshLiveScorePanels !== 'function') throw new Error('targeted Home score refresh unavailable');
      if (control.refreshLiveScorePanels({ includeYesterday: true }) === false) {
        throw new Error('targeted Home score refresh failed');
      }

      scheduleCanonicalReconcile();
      counters.targetedRenders += 1;
      perfMark('workEntry.targetedRender', {});
      return true;
    } catch (error) {
      counters.renderFallbacks += 1;
      perfMark('workEntry.targetedRenderFallback', { message: String(error?.message || error) });
      return false;
    }
  }

  function fastPathReady() {
    if (typeof global.save !== 'function') return false;
    if (typeof core.journalTaskMutation !== 'function') return false;
    if (typeof core.assertTaskMutationJournalWritable !== 'function') return false;
    return Boolean(snapshotWorkRows());
  }

  function saveFallback(originalSave, reason) {
    counters.fallbacks += 1;
    perfMark('workEntry.fastPathFallback', { reason });
    if (typeof originalSave !== 'function') return false;
    try {
      originalSave.call(global, 'work-entry-fast-path-fallback', {
        userInitiated: true,
        immediateWrite: true,
        workEntryFastPathFallbackReason: reason
      });
      counters.fallbackFullSaves += 1;
      return true;
    } catch (error) {
      console.error('TaskPoints Work entry fallback save failed', error);
      return false;
    }
  }

  function journalRows(rows) {
    for (const entry of rows) {
      core.journalTaskMutation({ completionUpsert: clone(entry) });
      counters.journaledCompletionUpserts += 1;
    }
  }

  function runFastCommit(name, original, thisArg, args) {
    let before;
    try {
      core.assertTaskMutationJournalWritable();
      before = snapshotWorkRows();
    } catch (_) {
      return original.apply(thisArg, args);
    }
    if (!before) return original.apply(thisArg, args);

    const priorSave = global.save;
    const priorRenderAll = global.renderAll;
    if (typeof priorSave !== 'function') return original.apply(thisArg, args);

    let saveCalls = 0;
    let commitResolved = false;
    let fastCommitSucceeded = false;
    let directRenderRequested = false;

    const suppressedSave = function suppressedWorkEntryFullSave() {
      saveCalls += 1;
      counters.suppressedFullSaves += 1;
      return undefined;
    };

    const targetedRender = function targetedWorkEntryRender() {
      if (!commitResolved) {
        directRenderRequested = true;
        return undefined;
      }
      if (fastCommitSucceeded && refreshWorkUi()) return true;
      return typeof priorRenderAll === 'function' ? priorRenderAll.apply(this, arguments) : undefined;
    };

    perfMark('workEntry.fastCommitStart', { name });
    noteInteraction();
    global.save = suppressedSave;
    if (typeof priorRenderAll === 'function') global.renderAll = targetedRender;

    let result;
    try {
      result = original.apply(thisArg, args);
    } catch (error) {
      if (global.save === suppressedSave) global.save = priorSave;
      if (global.renderAll === targetedRender) global.renderAll = priorRenderAll;
      throw error;
    } finally {
      if (global.save === suppressedSave) global.save = priorSave;
      if (global.renderAll === targetedRender) global.renderAll = priorRenderAll;
    }

    // Validation exits do not call save(). Leave them completely unchanged.
    if (!saveCalls) {
      commitResolved = true;
      if (directRenderRequested && typeof priorRenderAll === 'function') priorRenderAll.call(global);
      return result;
    }

    const changed = changedWorkRows(before);
    if (!changed.length) {
      counters.unchangedCommits += 1;
      counters.fastCommits += 1;
      fastCommitSucceeded = true;
      commitResolved = true;
      holdMaintenanceQuiet();
      perfMark('workEntry.fastCommitNoop', { name, suppressedSaveCalls: saveCalls });
      if (directRenderRequested) targetedRender.call(global);
      return result;
    }

    try {
      journalRows(changed);
      counters.fastCommits += 1;
      fastCommitSucceeded = true;
      holdMaintenanceQuiet();
      perfMark('workEntry.fastCommitJournaled', {
        name,
        changedRows: changed.length,
        suppressedSaveCalls: saveCalls
      });
    } catch (error) {
      console.warn('TaskPoints could not journal the Work entry; falling back to the normal full save.', error);
      saveFallback(priorSave, 'journal-write-failed');
    }

    commitResolved = true;
    if (directRenderRequested) targetedRender.call(global);
    return result;
  }

  function wrapCommit(name) {
    if (wrapped.has(name)) return true;
    const fn = global[name];
    if (typeof fn !== 'function') return false;
    if (fn.__taskPointsWorkEntryFastPath) {
      wrapped.add(name);
      return true;
    }

    originals[name] = fn;
    const wrappedCommit = function taskPointsWorkEntryFastCommit() {
      if (!fastPathReady()) return fn.apply(this, arguments);
      return runFastCommit(name, fn, this, Array.from(arguments));
    };
    wrappedCommit.__taskPointsWorkEntryFastPath = true;
    wrappedCommit.__taskPointsOriginal = fn;
    global[name] = wrappedCommit;
    wrapped.add(name);
    return true;
  }

  function install() {
    const ready = typeof global.save === 'function'
      && typeof core.journalTaskMutation === 'function'
      && typeof core.assertTaskMutationJournalWritable === 'function';

    const editWrapped = ready && wrapCommit('submitWorkEditModal');
    const addWrapped = ready && wrapCommit('saveWorkScore');

    if (editWrapped || addWrapped) {
      if (!installed) {
        installed = true;
        counters.installs += 1;
        perfMark('workEntry.fastPathInstalled', { version: VERSION });
      }
    }

    if ((!editWrapped || !addWrapped) && ++installAttempts < MAX_INSTALL_ATTEMPTS && installTimer == null) {
      installTimer = global.setTimeout?.(() => {
        installTimer = null;
        install();
      }, INSTALL_RETRY_MS) || null;
    }

    return installed;
  }

  function stopDeferredWork() {
    stopQuietGuard();
    cancelCanonicalReconcile();
  }

  global.addEventListener?.('pagehide', stopDeferredWork, { capture: true });
  global.document?.addEventListener?.('visibilitychange', () => {
    if (global.document?.visibilityState === 'hidden') stopDeferredWork();
    else if (canonicalReconcilePending && reconcileTimer == null && reconcileIdleId == null) {
      reconcileTimer = global.setTimeout?.(attemptCanonicalReconcile, RECONCILE_RECHECK_MS) || null;
    }
  });

  global.TaskPointsWorkEntryFastPath = {
    installed: true,
    version: VERSION,
    install,
    getStatus() {
      return {
        active: installed,
        wrapped: Array.from(wrapped),
        quietGuardActive: quietUntil > now(),
        canonicalReconcilePending,
        counters: { ...counters }
      };
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsWorkEntryFastPath;
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', install, { once: true });
  } else {
    global.setTimeout?.(install, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
