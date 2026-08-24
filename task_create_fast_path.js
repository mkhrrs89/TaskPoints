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

// Inbox population currently lives in toolbar.js, which loads after the shared
// scoring bundle on most pages. Keep this as a separate, narrowly-scoped IIFE:
// it changes only the one full-state load performed by TaskPointsInbox.populate.
(function installTaskPointsInboxPopulationFastPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__inboxPopulationFastPathInstalled || typeof core.loadAppState !== 'function') return;
  core.__inboxPopulationFastPathInstalled = true;

  let fastLoads = 0;
  let populateCalls = 0;
  let lastLoadMs = 0;
  let lastPopulateMs = 0;

  const now = () => Number(global.performance?.now?.() || Date.now());
  const mark = (name, detail) => {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  };

  function patchInboxApi(api) {
    if (!api || typeof api !== 'object' || typeof api.populate !== 'function') return api;
    if (api.populate.__tpInboxPopulationFastPath) return api;

    const originalPopulate = api.populate;

    function inboxPopulationFastPath(options) {
      populateCalls += 1;
      const populateStartedAt = now();
      const originalLoadAppState = core.loadAppState;
      let intercepted = false;

      // One-shot interception: toolbar's Inbox generator currently asks for a
      // full derive + persist before doing its own read-only scan. Replace only
      // that exact first request, then immediately restore the real load method.
      core.loadAppState = function inboxPopulationLoadOnce(loadOptions = {}) {
        core.loadAppState = originalLoadAppState;
        const shouldUseFastLoad = loadOptions
          && loadOptions.syncDerived === true
          && loadOptions.persistSync === true;

        if (!shouldUseFastLoad) {
          return originalLoadAppState.apply(core, arguments);
        }

        intercepted = true;
        const loadStartedAt = now();
        const result = originalLoadAppState.call(core, {
          ...loadOptions,
          syncDerived: false,
          persistSync: false
        });
        lastLoadMs = Math.max(0, now() - loadStartedAt);
        fastLoads += 1;
        mark('inbox.populate.fastLoad', {
          durationMs: Math.round(lastLoadMs * 100) / 100,
          syncDerived: false,
          persistSync: false
        });
        return result;
      };

      try {
        const result = originalPopulate.apply(this, arguments);
        lastPopulateMs = Math.max(0, now() - populateStartedAt);
        mark('inbox.populate.fastPath', {
          durationMs: Math.round(lastPopulateMs * 100) / 100,
          intercepted,
          changed: Boolean(result?.changed),
          skipped: Boolean(result?.skipped)
        });
        return result;
      } finally {
        if (core.loadAppState !== originalLoadAppState) {
          core.loadAppState = originalLoadAppState;
        }
      }
    }

    inboxPopulationFastPath.__tpInboxPopulationFastPath = true;
    api.populate = inboxPopulationFastPath;
    return api;
  }

  function installOnAssignment() {
    const existing = global.TaskPointsInbox;
    if (existing && typeof existing === 'object') {
      global.TaskPointsInbox = patchInboxApi(existing);
      return true;
    }

    let pendingValue;
    try {
      Object.defineProperty(global, 'TaskPointsInbox', {
        configurable: true,
        enumerable: true,
        get() { return pendingValue; },
        set(value) {
          const patched = patchInboxApi(value);
          pendingValue = patched;
          Object.defineProperty(global, 'TaskPointsInbox', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: patched
          });
        }
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  core.getInboxPopulationFastPathStatus = () => ({
    installed: true,
    fastLoads,
    populateCalls,
    lastLoadMs,
    lastPopulateMs
  });

  installOnAssignment();
})(typeof window !== 'undefined' ? window : globalThis);
