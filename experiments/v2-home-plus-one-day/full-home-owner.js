/* Loaded by the synthetic full-Home harness on its dedicated loopback origin. */
(() => {
  'use strict';
  if (!['localhost','127.0.0.1'].includes(location.hostname)
    || location.pathname !== '/experiments/v2-home-plus-one-day/full/index.html'
    || window.__TASKPOINTS_OWNED_TASK_SYNTHETIC__ !== true) return;

  const marker = 'taskpoints_isolated_task_fixture_v1';
  const taskId = 't1';
  let selected = false, verified = null, error = '', read = null;
  let repaint, pending = null, writing = null;
  // Latch selection for this document. Losing the marker during an open
  // session must not send the next button press back to the V1 journal.
  function isEnabled() {
    selected ||= localStorage.getItem(marker) !== null;
    return selected;
  }

  function refresh(onChange) {
    if (onChange) repaint = onChange;
    if (!isEnabled()) return Promise.resolve();
    if (read) return read;
    read = (async () => {
      try {
        const result = await TaskPointsStateRuntimeV2.readIsolatedOwnedTasks();
        if (result.meta.homeTaskId !== taskId || !result.rows.some(row => row.id === taskId))
          throw Error('Home ownership evidence does not match the selected Task');
        verified = result;
        error = result.sourceDrift ? 'Competing or unreadable V1 Task evidence. Further edits are paused.' : '';
      } catch (cause) {
        verified = null;
        error = `V2 Task unavailable. ${cause.message}`;
      }
    })().finally(() => { read = null; repaint?.(); });
    return read;
  }

  function taskView(legacy) {
    const legacyTasks = Array.isArray(legacy?.tasks) ? legacy.tasks : [];
    const tasks = legacyTasks.filter(task => task.id !== taskId);
    if (verified) {
      const row = verified.rows.find(candidate => candidate.id === taskId);
      const index = legacyTasks.findIndex(task => task.id === taskId);
      tasks.splice(index < 0 ? tasks.length : index, 0, structuredClone(row.value));
    }
    return { ...legacy, tasks };
  }

  async function commit(advance) {
    window.ownerOutcome = null;
    try {
      if (!verified) throw Error('V2 Task unavailable');
      const row = verified.rows.find(candidate => candidate.id === taskId);
      pending ||= {
        actionId: crypto.randomUUID(), operation: 'home-plus-one-day', taskId,
        generation: verified.meta.generation, expectedRevision: row.ownerRevision, expectedTask: row.value
      };
      const result = await TaskPointsStateRuntimeV2.commitIsolatedOwnedTask({ ...pending, mutate: advance });
      if (read) await read;
      await refresh();
      if (!verified || verified.sourceDrift || verified.meta.revision < result.receipt.revision) throw Error('V2 Task refresh could not confirm the saved revision');
      pending = null;
      window.ownerOutcome = {ok: result.confirmedDurable, date: result.task.dueDateISO};
      return result;
    } catch (cause) {
      await refresh();
      window.ownerOutcome = {ok: false, error: cause.message};
      throw cause;
    }
  }

  window.addEventListener('storage', event => {
    if (event.storageArea === localStorage && (event.key === null || [
      marker, 'taskpoints_v1', 'taskpoints_pending_task_mutations_v1', 'taskpoints_state_v2_generation_v1',
      'taskpoints_storage_guard_incident_v1', 'taskpoints_recovery_write_lock_v1',
      'taskpoints_recovery_attempt_lock_v1', 'taskpoints_emergency_recovery_hold_v1', 'taskpoints_phase5b_pending_changes_v1'
    ].includes(event.key))) refresh();
  });

  window.TaskPointsOwnedTaskExperiment = Object.freeze({
    isEnabled, owns: id => id === taskId, displayOnly: true, refresh, taskView,
    onRender(onChange) {
      repaint = onChange;
      if (!verified && !error) refresh();
      return error || (!verified ? 'Reading the V2 Task…' : '');
    },
    commitPlusOneDay(id, _legacyTask, advance) {
      if (id !== taskId) return Promise.reject(Error('Task is outside Home ownership'));
      writing ||= commit(advance).finally(() => { writing = null; });
      return writing;
    }
  });
})();
