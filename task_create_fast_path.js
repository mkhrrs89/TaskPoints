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
