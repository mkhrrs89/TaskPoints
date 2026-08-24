(function installTaskPointsTaskCreateFastPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!core || !document || core.__taskCreateFastPathInstalled || typeof core.saveStateSnapshot !== 'function') return;
  core.__taskCreateFastPathInstalled = true;

  // This module is loaded immediately after task_mutation_journal.js. Capture
  // that fully guarded save path so every non-create save, and every fallback,
  // still uses the existing persistence/recovery machinery unchanged.
  const originalSaveStateSnapshot = core.saveStateSnapshot;
  let armed = false;
  let armedTitle = '';
  let fastPathHits = 0;
  let fallbackSaves = 0;

  function enableUserZoom() {
    const viewport = document.querySelector?.('meta[name="viewport"]');
    if (!viewport?.getAttribute || !viewport?.setAttribute) return false;
    const existing = String(viewport.getAttribute('content') || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^(?:maximum-scale|user-scalable)\s*=/i.test(part));
    existing.push('maximum-scale=5', 'user-scalable=yes');
    viewport.setAttribute('content', existing.join(', '));
    return true;
  }

  function enhanceAddTaskModal() {
    const addButton = document.getElementById?.('addBtn');
    if (!addButton) return false;

    let current = addButton;
    let previous = null;
    let overlay = null;
    let panel = null;

    while (current && current !== document.body) {
      let style = null;
      try { style = typeof global.getComputedStyle === 'function' ? global.getComputedStyle(current) : null; }
      catch (_) {}
      if (style?.position === 'fixed') {
        overlay = current;
        panel = previous;
        break;
      }
      previous = current;
      current = current.parentElement;
    }

    if (!overlay || !panel?.style) return false;

    // Keep the modal inside the actually usable iPhone viewport. The bottom
    // toolbar remains untouched; the modal panel itself becomes the scroll area.
    if (overlay.style) {
      overlay.style.boxSizing = 'border-box';
      overlay.style.paddingTop = 'max(8px, env(safe-area-inset-top, 0px))';
      overlay.style.paddingBottom = 'calc(var(--tp-toolbar-stack-height, 68px) + env(safe-area-inset-bottom, 0px) + 8px)';
      overlay.style.overflowY = 'auto';
      overlay.style.webkitOverflowScrolling = 'touch';
      overlay.style.touchAction = 'pan-y pinch-zoom';
    }

    panel.style.maxHeight = '100%';
    panel.style.overflowY = 'auto';
    panel.style.overflowX = 'hidden';
    panel.style.webkitOverflowScrolling = 'touch';
    panel.style.overscrollBehavior = 'contain';
    panel.style.touchAction = 'pan-y pinch-zoom';
    panel.style.scrollPaddingBottom = '24px';
    panel.setAttribute?.('data-taskpoints-scrollable-add-modal', 'true');
    return true;
  }

  enableUserZoom();
  if (!enhanceAddTaskModal()) {
    document.addEventListener?.('DOMContentLoaded', enhanceAddTaskModal, { once: true });
    global.setTimeout?.(enhanceAddTaskModal, 0);
  }

  function disarm() {
    armed = false;
    armedTitle = '';
  }

  function clearAfterCurrentClick() {
    const clear = () => {
      if (armed) disarm();
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(clear);
    else Promise.resolve().then(clear);
  }

  // Arm only for the actual Add Task submit button, and only for the current
  // synchronous click turn. If validation exits before save(), the microtask
  // clears the flag so an unrelated later save can never inherit it.
  document.addEventListener?.('click', (event) => {
    const target = event?.target;
    const button = typeof target?.closest === 'function' ? target.closest('#addBtn') : null;
    if (!button || button.disabled) return;

    const title = String(document.getElementById?.('titleInput')?.value || '').trim();
    if (!title) return;

    armed = true;
    armedTitle = title;
    clearAfterCurrentClick();
  }, true);

  core.saveStateSnapshot = function taskCreateFastPathSaveStateSnapshot(state, options = {}) {
    if (!armed) return originalSaveStateSnapshot.call(core, state, options);

    const expectedTitle = armedTitle;
    disarm(); // one shot: never intercept a second save from the same click

    const tasks = Array.isArray(state?.tasks) ? state.tasks : null;
    const task = tasks?.[0] || null;
    const taskTitle = String(task?.title || '').trim();

    // addTask() unshifts the newly constructed task immediately before save().
    // Require the exact title from the clicked form as an inexpensive guard so
    // this optimization cannot swallow a different save path.
    if (!task?.id || !expectedTitle || taskTitle !== expectedTitle || typeof core.journalTaskMutation !== 'function') {
      fallbackSaves += 1;
      return originalSaveStateSnapshot.call(core, state, options);
    }

    try {
      core.assertTaskMutationJournalWritable?.();
      core.journalTaskMutation({ task });
      try { core.clearStateHotCache?.(); } catch (_) {}
      fastPathHits += 1;
      try {
        global.TaskPointsPerf?.mark?.('taskCreate.journaled', {
          taskId: task.id,
          recurrenceMode: task?.recurrence?.mode || 'none'
        });
      } catch (_) {}

      // Home's save() only needs the authoritative in-memory state back. The
      // task itself is now crash-safe in the journal; the existing journal
      // compactor performs the full verified snapshot after sustained idle.
      return {
        state,
        taskCreateFastPath: true,
        deferredFullSnapshot: true
      };
    } catch (error) {
      fallbackSaves += 1;
      try {
        global.TaskPointsPerf?.mark?.('taskCreate.fastPathFallback', {
          message: String(error?.message || error || 'journal_failed')
        });
      } catch (_) {}
      return originalSaveStateSnapshot.call(core, state, options);
    }
  };

  core.getTaskCreateFastPathStatus = () => ({
    installed: true,
    armed,
    fastPathHits,
    fallbackSaves
  });
})(typeof window !== 'undefined' ? window : globalThis);

// Inbox auto-population is invoked both through window.TaskPointsInbox.populate
// and directly by toolbar background maintenance. Intercept only loadAppState
// calls whose stack proves they originate inside autoPopulateTaskPointsInbox.
(function installTaskPointsInboxPopulationFastPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__inboxPopulationFastPathInstalled || typeof core.loadAppState !== 'function') return;
  core.__inboxPopulationFastPathInstalled = true;

  const originalLoadAppState = core.loadAppState;
  let fastLoads = 0;
  let backgroundLoads = 0;
  let pageLoads = 0;
  let lastLoadMs = 0;
  let lastPopulateMs = 0;
  let lastGenerationMs = 0;
  let lastSaveMs = 0;

  const now = () => Number(global.performance?.now?.() || Date.now());
  const mark = (name, detail) => {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  };
  const queueMicrotaskSafe = (callback) => {
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(callback);
    else Promise.resolve().then(callback);
  };

  function inboxCallerDetails() {
    let stack = '';
    try { stack = String(new Error().stack || ''); } catch (_) {}
    if (!stack.includes('autoPopulateTaskPointsInbox')) return null;
    const source = stack.includes('runTaskPointsToolbarMaintenance')
      ? 'toolbar-background'
      : 'inbox-page-or-api';
    return { stack, source };
  }

  function installSaveTiming(loadEndedAt, source) {
    const originalMergeAndSave = core.mergeAndSaveState;
    if (typeof originalMergeAndSave !== 'function') return () => {};

    function timedInboxMergeAndSave(nextState, options = {}) {
      if (options?.savePath !== 'inbox-auto-populate') {
        return originalMergeAndSave.apply(core, arguments);
      }

      lastGenerationMs = Math.max(0, now() - loadEndedAt);
      const saveStartedAt = now();
      let outcome = 'return';
      try {
        return originalMergeAndSave.apply(core, arguments);
      } catch (error) {
        outcome = 'throw';
        throw error;
      } finally {
        lastSaveMs = Math.max(0, now() - saveStartedAt);
        mark('inbox.populate.generateAndSave', {
          source,
          generationMs: Math.round(lastGenerationMs * 100) / 100,
          saveMs: Math.round(lastSaveMs * 100) / 100,
          totalSinceLoadMs: Math.round((lastGenerationMs + lastSaveMs) * 100) / 100,
          outcome
        });
      }
    }

    core.mergeAndSaveState = timedInboxMergeAndSave;
    return () => {
      if (core.mergeAndSaveState === timedInboxMergeAndSave) {
        core.mergeAndSaveState = originalMergeAndSave;
      }
    };
  }

  core.loadAppState = function inboxPopulationLoadAppState(options = {}) {
    if (!options || options.syncDerived !== true) {
      return originalLoadAppState.apply(core, arguments);
    }

    const caller = inboxCallerDetails();
    if (!caller) return originalLoadAppState.apply(core, arguments);

    const populateStartedAt = now();
    const loadStartedAt = now();
    const result = originalLoadAppState.call(core, {
      ...options,
      syncDerived: false,
      persistSync: false
    });
    const loadEndedAt = now();
    lastLoadMs = Math.max(0, loadEndedAt - loadStartedAt);
    fastLoads += 1;
    if (caller.source === 'toolbar-background') backgroundLoads += 1;
    else pageLoads += 1;

    mark('inbox.populate.fastLoad', {
      source: caller.source,
      durationMs: Math.round(lastLoadMs * 100) / 100,
      originalSyncDerived: options.syncDerived === true,
      originalPersistSync: options.persistSync === true,
      syncDerived: false,
      persistSync: false
    });

    const restoreMergeAndSave = installSaveTiming(loadEndedAt, caller.source);
    queueMicrotaskSafe(() => {
      restoreMergeAndSave();
      lastPopulateMs = Math.max(0, now() - populateStartedAt);
      mark('inbox.populate.fastPath', {
        source: caller.source,
        durationMs: Math.round(lastPopulateMs * 100) / 100,
        fastLoadMs: Math.round(lastLoadMs * 100) / 100,
        postLoadMs: Math.round(Math.max(0, lastPopulateMs - lastLoadMs) * 100) / 100
      });
    });

    return result;
  };

  core.getInboxPopulationFastPathStatus = () => ({
    installed: true,
    fastLoads,
    backgroundLoads,
    pageLoads,
    lastLoadMs,
    lastPopulateMs,
    lastGenerationMs,
    lastSaveMs
  });
})(typeof window !== 'undefined' ? window : globalThis);
