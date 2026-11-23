/* Loaded by the synthetic full-Home harness on its dedicated loopback origin. */
(() => {
  'use strict';
  if (!['localhost','127.0.0.1'].includes(location.hostname)
    || location.pathname !== '/experiments/v2-home-plus-one-day/full/index.html'
    || window.__TASKPOINTS_OWNED_TASK_SYNTHETIC__ !== true) return;

  const marker = 'taskpoints_isolated_task_fixture_v1';
  const taskId = 't1';
  const bumpOperation = 'home-plus-one-day';
  const titleOperation = 'home-task-title-edit';
  const classificationOperation = 'home-task-classification-edit';
  const pointsOperation = 'home-task-points-edit';
  const dueOperation = 'home-task-due-date-edit';
  const repeatOperation = 'home-task-repeat-edit';
  let selected = false, verified = null, error = '', read = null;
  let repaint, pending = null, writing = null, editor = null;
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

  function currentIntent() {
    if (!verified) throw Error('V2 Task unavailable');
    const row = verified.rows.find(candidate => candidate.id === taskId);
    return {taskId, generation: verified.meta.generation,
      expectedRevision: row.ownerRevision, expectedTask: structuredClone(row.value)};
  }

  function matchesPending(operation, payloadKey) {
    return pending?.intent.operation === operation && pending.payloadKey === payloadKey;
  }

  async function commit(operation, basis, payload, payloadKey, mutate) {
    window.ownerOutcome = null;
    try {
      if (pending && !matchesPending(operation, payloadKey)) {
        throw Error('Retry the unchanged pending Task action, or reopen Home to verify its outcome.');
      }
      pending ||= {
        intent: {actionId: crypto.randomUUID(), operation, ...basis(), ...structuredClone(payload)},
        payloadKey
      };
      const result = await TaskPointsStateRuntimeV2.commitIsolatedOwnedTask({ ...pending.intent, mutate });
      if (read) await read;
      await refresh();
      if (!verified || verified.sourceDrift || verified.meta.revision < result.receipt.revision) {
        throw Error('V2 Task refresh could not confirm the saved revision');
      }
      pending = null;
      window.ownerOutcome = {ok: result.confirmedDurable, date: result.task.dueDateISO,
        ...(operation !== bumpOperation ? {title: result.task.title} : {}),
        ...(operation === classificationOperation || operation === pointsOperation || operation === dueOperation || operation === repeatOperation
          ? {importance: result.task.importance, tags: result.task.tags} : {}),
        ...(operation === pointsOperation || operation === dueOperation || operation === repeatOperation ? {points: result.task.points} : {}),
        ...(operation === repeatOperation ? {recurrence: result.task.recurrence} : {})};
      return result;
    } catch (cause) {
      // A stale, uncommitted intent may be abandoned by closing the editor.
      // Uncertain outcomes keep their original ID and payload across retries.
      if ((cause.message === 'owned_task_stale_edit' && operation !== bumpOperation)
        || ([dueOperation,repeatOperation].includes(operation) && cause.message === 'invalid_owned_task_intent')) pending = null;
      await refresh();
      window.ownerOutcome = {ok: false, error: cause.message};
      throw cause;
    }
  }

  function submit(operation, basis, payload, mutate) {
    const payloadKey = JSON.stringify(payload);
    if (writing) {
      if (matchesPending(operation, payloadKey)) return writing;
      return Promise.reject(Error('A Task save is already in progress.'));
    }
    writing = commit(operation, basis, payload, payloadKey, mutate).finally(() => { writing = null; });
    return writing;
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
    beginTaskEdit() {
      if (writing) throw Error('A Task save is already in progress.');
      const basis = currentIntent();
      const task = basis.expectedTask;
      const recurrence = task.recurrence || {};
      const original = {
        title: task.title,
        due: task.dueDateISO || '',
        repeat: ['daily','everyWeekday','weekly','monthly','yearly','custom'].includes(recurrence.mode) ? recurrence.mode : 'none',
        repeatCustomCount: String(Number.isFinite(recurrence.customCount) && recurrence.customCount > 0 ? recurrence.customCount : 1),
        repeatCustomUnit: ['week','month','year'].includes(recurrence.customUnit) ? recurrence.customUnit : 'day',
        points: Number(task.points) || 0,
        importance: ['Low','Medium','High','Critical'].includes(task.importance) ? task.importance : 'Low',
        tags: Array.isArray(task.tags) ? task.tags : []
      };
      editor = {basis, original, draft: {...original, points: String(original.points), tags: original.tags.join(', ')}};
    },
    taskEditor: () => editor && {
      original: editor.original,
      draft: editor.draft,
      dueTouched: editor.dueTouched,
      dueBadInput: editor.dueBadInput,
      saving: Boolean(writing),
      pending: Boolean(pending && pending.intent.operation !== bumpOperation)
    },
    rememberTaskDraft(key, value, invalid = false) {
      if (editor && Object.hasOwn(editor.draft, key)) {
        editor.draft[key] = value;
        if (key === 'due') {
          editor.dueTouched = true;
          editor.dueBadInput = invalid;
        }
      }
    },
    endTaskEdit() { editor = null; },
    commitTaskEdit(id, fields) {
      if (id !== taskId || !editor) return Promise.reject(Error('Open the V2 Task editor before saving.'));
      // Use the Task and revision seen at editor open, even if a refresh has
      // since loaded a newer value underneath the draft.
      if (Object.hasOwn(fields, 'recurrence')) return submit(repeatOperation, () => editor.basis, {fields});
      if (Object.hasOwn(fields, 'dueDateISO')) return submit(dueOperation, () => editor.basis, {fields});
      if (Object.hasOwn(fields, 'points')) return submit(pointsOperation, () => editor.basis, {fields});
      if (Object.hasOwn(fields, 'importance') || Object.hasOwn(fields, 'tags')) {
        return submit(classificationOperation, () => editor.basis, {fields});
      }
      return submit(titleOperation, () => editor.basis, {title: fields.title});
    },
    commitPlusOneDay(id, _legacyTask, advance) {
      if (id !== taskId) return Promise.reject(Error('Task is outside Home ownership'));
      return submit(bumpOperation, currentIntent, {}, advance);
    }
  });
})();
