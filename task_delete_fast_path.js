(function installTaskPointsTaskDeleteFastPath(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!core || !document || core.__taskDeleteFastPathInstalled || typeof core.saveStateSnapshot !== 'function') return;
  core.__taskDeleteFastPathInstalled = true;

  const originalSaveStateSnapshot = core.saveStateSnapshot;
  let armedTaskId = '';
  let fastPathHits = 0;
  let fallbackSaves = 0;

  function disarm() {
    armedTaskId = '';
  }

  function extractTaskId(button) {
    const dataId = String(button?.getAttribute?.('data-task-id') || '').trim();
    if (dataId) return dataId;
    const onclick = String(button?.getAttribute?.('onclick') || '');
    const match = onclick.match(/deleteTask\((['"])(.*?)\1\)/);
    return match ? String(match[2] || '') : '';
  }

  function clearAfterCurrentClick() {
    const clear = () => {
      if (armedTaskId) disarm();
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(clear);
    else Promise.resolve().then(clear);
  }

  document.addEventListener?.('click', (event) => {
    const target = event?.target;
    const button = typeof target?.closest === 'function'
      ? target.closest('[data-task-action="delete"][data-task-id], [data-task-action="task-delete"][data-task-id], [onclick*="deleteTask("]')
      : null;
    if (!button || button.disabled) return;

    const id = extractTaskId(button);
    if (!id) return;

    armedTaskId = id;
    clearAfterCurrentClick();
  }, true);

  core.saveStateSnapshot = function taskDeleteFastPathSaveStateSnapshot(state, options = {}) {
    if (!armedTaskId) return originalSaveStateSnapshot.call(core, state, options);

    const expectedId = armedTaskId;
    disarm();

    const tasks = Array.isArray(state?.tasks) ? state.tasks : null;
    const task = tasks?.find((entry) => String(entry?.id || '') === expectedId) || null;
    const status = String(task?.status || '').toLowerCase();
    const isTrashed = status === 'trashed' || Boolean(task?.deletedAtISO || task?.deletedAt);

    if (!task?.id || !isTrashed || typeof core.journalTaskMutation !== 'function') {
      fallbackSaves += 1;
      return originalSaveStateSnapshot.call(core, state, options);
    }

    try {
      core.assertTaskMutationJournalWritable?.();
      core.journalTaskMutation({ task });
      try { core.clearStateHotCache?.(); } catch (_) {}
      fastPathHits += 1;
      try {
        global.TaskPointsPerf?.mark?.('taskDelete.journaled', {
          taskId: task.id,
          deletedFrom: task.deletedFrom || null
        });
      } catch (_) {}

      return {
        state,
        taskDeleteFastPath: true,
        deferredFullSnapshot: true
      };
    } catch (error) {
      fallbackSaves += 1;
      try {
        global.TaskPointsPerf?.mark?.('taskDelete.fastPathFallback', {
          taskId: expectedId,
          message: String(error?.message || error || 'journal_failed')
        });
      } catch (_) {}
      return originalSaveStateSnapshot.call(core, state, options);
    }
  };

  core.getTaskDeleteFastPathStatus = () => ({
    installed: true,
    armed: Boolean(armedTaskId),
    fastPathHits,
    fallbackSaves
  });
})(typeof window !== 'undefined' ? window : globalThis);
