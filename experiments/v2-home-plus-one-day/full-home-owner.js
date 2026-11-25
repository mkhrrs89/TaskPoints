/* Loaded by the synthetic Home and Week harness on its dedicated loopback origin. */
(() => {
  'use strict';
  if (!['localhost','127.0.0.1'].includes(location.hostname)
    || !/^\/experiments\/v2-home-plus-one-day\/full\/(index|week)\.html$/.test(location.pathname)
    || window.__TASKPOINTS_OWNED_TASK_SYNTHETIC__ !== true) return;

  const marker = 'taskpoints_isolated_task_fixture_v1';
  const seedTaskId = 't1';
  const bumpOperation = 'home-plus-one-day';
  const titleOperation = 'home-task-title-edit';
  const classificationOperation = 'home-task-classification-edit';
  const pointsOperation = 'home-task-points-edit';
  const dueOperation = 'home-task-due-date-edit';
  const repeatOperation = 'home-task-repeat-edit';
  let selected = false, verified = null, error = '', read = null;
  let repaint, pending = null, writing = null, editor = null;
  let createSelected = false, createPending = null;
  let scheduleWriting = false, scheduleNotice = '';
  function createKeys() {
    const prefix = TaskPointsCore.ISOLATED_TASK_CREATE_PENDING_PREFIX;
    return Object.keys(localStorage).filter(key=>key.startsWith(prefix)).sort();
  }
  function createFixture() {
    return JSON.parse(localStorage.getItem(marker));
  }
  function usesTaskCreation() {
    try { createSelected ||= createFixture()?.taskCreate === true || createKeys().length > 0; }
    catch (_) { createSelected = true; }
    return createSelected;
  }
  function owns(id) {
    return id === seedTaskId || (usesTaskCreation() && TaskPointsCore.isIsolatedCreatedTaskId(id));
  }

  function recoverTaskCreation() {
    if (!createPending) {
      const fixture = createFixture();
      const key = createKeys()[0];
      if (!key) return null;
      const raw = localStorage.getItem(key);
      if (raw === null) throw Error('The pending Add Task changed. Reopen Add Task to check its outcome.');
      const saved = JSON.parse(raw);
      if (fixture?.taskCreate !== true || saved?.fixtureId !== fixture.id
        || !TaskPointsCore.isIsolatedCreatedTaskId('v2-task-'+saved.intent?.actionId)
        || !TaskPointsCore.isIsolatedCreatedTaskId(saved.intent.taskId)
        || key !== TaskPointsCore.ISOLATED_TASK_CREATE_PENDING_PREFIX+saved.intent.actionId
        || !saved.intent.fields)
        throw Error('An unreadable Add Task attempt was preserved. Task creation is paused.');
      createPending = {key,raw,intent:saved.intent};
    }
    return createPending.intent.fields;
  }

  async function commitTaskCreation(fields) {
    window.ownerOutcome = null;
    if (!createPending) {
      await refresh();
      const fixture = createFixture();
      if (fixture?.taskCreate !== true || !verified || verified.sourceDrift || verified.meta.mode !== 'owned')
        throw Error('Verified V2 Task creation is unavailable.');
      const intent = {actionId:crypto.randomUUID(),taskId:'v2-task-'+crypto.randomUUID(),
        generation:verified.meta.generation,fields};
      const key = TaskPointsCore.ISOLATED_TASK_CREATE_PENDING_PREFIX+intent.actionId;
      const raw = JSON.stringify({fixtureId:fixture.id,intent});
      await navigator.locks.request(key, () => {
        if (localStorage.getItem(key) !== null) throw Error('Add Task action identity is already reserved.');
        // Record the exact intent before opening the write transaction. This
        // draft is recoverable even if the tab never gets a commit response.
        localStorage.setItem(key,raw);
        if (localStorage.getItem(key) !== raw) throw Error('The pending Add Task could not be verified.');
        createPending = {key,raw,intent};
      });
    }
    const {key,raw,intent} = createPending;
    if (JSON.stringify(fields) !== JSON.stringify(intent.fields))
      throw Error('Retry the original pending Add Task without changing its fields.');
    const savedDraft = localStorage.getItem(key);
    if (savedDraft !== null && savedDraft !== raw)
      throw Error('The pending Add Task no longer matches its original draft.');
    // A peer may have acknowledged and cleared the same draft. Its
    // verified receipt can be returned, but this tab cannot start a write
    // when the durable retry envelope is missing.
    const result = await TaskPointsStateRuntimeV2.commitIsolatedOwnedTaskCreation(intent,{replayOnly:savedDraft===null});
    if (read) await read;
    await refresh();
    if (!result.confirmedDurable || !verified || verified.sourceDrift
      || !verified.journal.some(row=>JSON.stringify(row) === JSON.stringify(result.receipt)))
      throw Error('The saved Task could not be confirmed. Retry the same Add Task.');
    window.ownerOutcome = {ok:true, taskId:result.receipt.taskId, replayed:result.replayed};
    return result;
  }

  async function finishTaskCreation() {
    const {key,raw} = createPending;
    await navigator.locks.request(key, () => {
      const current = localStorage.getItem(key);
      if (current !== null && current !== raw)
        throw Error('The pending Add Task was changed and has been preserved.');
      localStorage.removeItem(key);
      if (localStorage.getItem(key) !== null) throw Error('The pending Add Task could not be cleared.');
      createPending = null;
    });
  }
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
        if (result.meta.homeTaskId !== seedTaskId || !result.ownedIds.includes(seedTaskId))
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
    const owned = new Map(verified?.tasks.filter(task=>verified.ownedIds.includes(task.id))
      .map(task=>[task.id,structuredClone(task)]));
    const tasks = legacyTasks.flatMap(task=>owns(task.id) ? (owned.has(task.id) ? [owned.get(task.id)] : []) : [task]);
    for (const task of [...owned.values()].reverse()) {
      if (!legacyTasks.some(row=>row.id===task.id)) {
        if (task.id===seedTaskId) tasks.push(task);
        else tasks.unshift(task);
      }
    }
    return { ...legacy, tasks };
  }

  function currentIntent(taskId) {
    const row = verified?.rows.find(candidate => candidate.id === taskId);
    if (!row || !verified.ownedIds.includes(taskId)) throw Error('V2 Task unavailable');
    return {taskId, generation: verified.meta.generation,
      expectedRevision: row.ownerRevision, expectedTask: structuredClone(row.value)};
  }

  function pendingSchedule() {
    return localStorage.getItem(TaskPointsCore.ISOLATED_TASK_SCHEDULE_PENDING_KEY) !== null;
  }

  async function runSchedule(request, applyLegacy) {
    if (scheduleWriting) return;
    scheduleWriting = true;
    window.ownerScheduleOutcome = null;
    scheduleNotice = '';
    const key = TaskPointsCore.ISOLATED_TASK_SCHEDULE_PENDING_KEY;
    try {
      return await navigator.locks.request(key,{ifAvailable:true},async lock => {
        if (!lock) throw Error('A scheduling action is already being checked in another Home tab.');
        let raw = localStorage.getItem(key);
        const isRetry = raw !== null;
        if (!isRetry && !request) return;
        const fixtureId = createFixture()?.id;
        let intent, legacyIds;
        if (isRetry) {
          const saved = JSON.parse(raw);
          ({intent,legacyIds} = saved || {});
          if (saved?.fixtureId !== fixtureId || !intent?.choice || !Array.isArray(intent.bases) || !Array.isArray(legacyIds))
            throw Error('An unreadable scheduling attempt was preserved.');
          if (request && (intent.choice.kind !== request.choice.kind || intent.choice.date !== request.choice.date
            || (request.choice.kind !== 'postpone-all' && intent.bases[0]?.taskId !== request.bases[0]?.taskId)))
            throw Error('Check the pending schedule before starting a different action.');
        } else {
          const {bases,choice} = request;
          ({legacyIds} = request);
          if (!fixtureId || !bases.length || bases.some(row=>row.generation !== bases[0].generation))
            throw Error('The selected V2 Tasks could not be verified.');
          intent = {actionId:crypto.randomUUID(),generation:bases[0].generation,bases,choice};
          raw = JSON.stringify({fixtureId,intent,legacyIds});
          localStorage.setItem(key,raw);
          if (localStorage.getItem(key) !== raw) throw Error('The scheduling retry could not be recorded.');
        }
        const commit = TaskPointsStateRuntimeV2.commitIsolatedTaskScheduling;
        let result, recovered = isRetry;
        try { result = await commit(intent,{replayOnly:!request}); }
        catch (error) {
          // Read the original receipt after a lost response. A clean read
          // with no receipt does not authorize another write on its own.
          result = await commit(intent,{replayOnly:true}).catch(()=>null);
          if (!result?.confirmedDurable) throw error;
          recovered = true;
        }
        if (!result.confirmedDurable && !result.unchanged && !(result.notCommitted && !request))
          throw Error('The scheduling result could not be confirmed.');
        if (read) await read;
        await refresh();
        if (result.confirmedDurable && (!verified || verified.sourceDrift
          || !result.receipts.every(receipt=>verified.journal.some(row=>row.id===receipt.id))))
          throw Error('The committed scheduling receipts could not be confirmed.');
        // The legacy group uses its own journal only during the original
        // confirmed run. After interruption, never reapply that group blindly.
        if (localStorage.getItem(key) !== raw) throw Error('The pending scheduling evidence changed.');
        const legacyReviewRequired = legacyIds.length > 0
          && (recovered || intent.choice.day !== TaskPointsCore.todayKey() || !applyLegacy?.());
        if (legacyReviewRequired) {
          scheduleNotice = result.confirmedDurable
            ? 'V2 dates were saved. Review the remaining overdue V1 Tasks before running Postpone all again.'
            : 'The interrupted scheduling action did not commit in V2. Review the overdue list before trying again.';
        } else if (!request) {
          scheduleNotice = result.notCommitted ? 'The interrupted scheduling action did not commit. You can try again.'
            : 'The previous scheduling action was verified.';
        }
        if (localStorage.getItem(key) !== raw) throw Error('The pending scheduling evidence changed.');
        // Leave a partial outcome discoverable after restart until Home
        // explicitly checks it. The V1 phase will never be replayed here.
        if (!legacyReviewRequired || !request) {
          localStorage.removeItem(key);
          if (localStorage.getItem(key) !== null) throw Error('The scheduling outcome could not be cleared.');
        }
        window.ownerScheduleOutcome = {ok:!result.notCommitted,...result,legacyReviewRequired};
        return result;
      });
    } catch (error) {
      scheduleNotice = error.message;
      window.ownerScheduleOutcome = {ok:false,error:error.message};
      throw error;
    } finally { scheduleWriting = false; repaint?.(); }
  }

  async function commitTrash(intent) {
    window.ownerOutcome = null;
    try {
      const result = await TaskPointsCore.runIsolatedTaskTrash(intent);
      if (read) await read;
      await refresh();
      if (!result.confirmedDurable || verified?.sourceDrift || !verified?.journal.some(row=>row.id===result.receipt.id))
        throw Error('The saved Task change could not be confirmed.');
      window.ownerOutcome = {ok:true,taskId:intent.taskId,receipt:result.receipt};
      return result;
    } catch (error) {
      await refresh();
      window.ownerOutcome = {ok:false,error:error.message};
      throw error;
    }
  }

  function matchesPending(operation, taskId, payloadKey) {
    return pending?.intent.operation === operation && pending.intent.taskId === taskId && pending.payloadKey === payloadKey;
  }

  async function commit(operation, taskId, basis, payload, payloadKey, mutate) {
    window.ownerOutcome = null;
    try {
      if (pending && !matchesPending(operation, taskId, payloadKey)) {
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

  function submit(operation, taskId, basis, payload, mutate) {
    const payloadKey = JSON.stringify(payload);
    if (writing) {
      if (matchesPending(operation, taskId, payloadKey)) return writing;
      return Promise.reject(Error('A Task save is already in progress.'));
    }
    writing = commit(operation, taskId, basis, payload, payloadKey, mutate).finally(() => { writing = null; });
    return writing;
  }

  window.addEventListener('storage', event => {
    if (event.storageArea === localStorage && (event.key === null || [
      marker, 'taskpoints_v1', 'taskpoints_pending_task_mutations_v1', 'taskpoints_state_v2_generation_v1',
      'taskpoints_storage_guard_incident_v1', 'taskpoints_recovery_write_lock_v1',
      'taskpoints_recovery_attempt_lock_v1', 'taskpoints_emergency_recovery_hold_v1', 'taskpoints_phase5b_pending_changes_v1'
    ].includes(event.key))) refresh();
    if (event.storageArea === localStorage && event.key === window.TaskPointsCore?.ISOLATED_TASK_SCHEDULE_PENDING_KEY) repaint?.();
  });

  window.TaskPointsOwnedTaskExperiment = Object.freeze({
    isEnabled, owns, displayOnly: true, refresh, taskView,
    usesTaskCreation, recoverTaskCreation, commitTaskCreation, finishTaskCreation,
    currentScheduleBasis(id) {
      if (!TaskPointsCore.usesIsolatedTaskDone(id)) throw Error('Verified V2 scheduling is unavailable.');
      return currentIntent(id);
    },
    scheduleReady: () => Boolean(TaskPointsCore.usesIsolatedTaskDone() && verified && !verified.sourceDrift && verified.meta.mode === 'owned'),
    pendingSchedule,
    scheduleNotice: () => scheduleNotice,
    recoverSchedule: () => runSchedule(null),
    commitSchedule: (kind,day,bases,legacyIds=[],date,applyLegacy) => runSchedule({
      bases,legacyIds,choice:{kind,day,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,...(date !== undefined ? {date} : {})}
    },applyLegacy),
    recentTrash() {
      if (!verified || verified.sourceDrift || verified.meta.mode !== 'owned' || !TaskPointsCore.usesIsolatedTaskDone()) return [];
      const now = Date.now();
      return verified.deletions.filter(row=>{
        if (row.intent?.operation !== 'home-move-to-trash') return false;
        const elapsed = now - Date.parse(row.committedAtISO);
        return elapsed >= 0 && elapsed < TaskPointsStateRuntimeV2.OWNED_TRASH_UNDO_MS;
      });
    },
    taskTrashIntent(id) {
      if (!TaskPointsCore.usesIsolatedTaskDone(id)) return null;
      const {taskId,generation,expectedRevision} = currentIntent(id);
      return {operation:'home-move-to-trash',taskId,generation,expectedRevision};
    },
    changeStatus: commitTrash,
    moveToTrash: commitTrash,
    undoTrash(deletion) {
      return commitTrash({operation:'home-undo-trash',taskId:deletion.taskId,generation:deletion.generation,
        expectedRevision:deletion.revision,deletionId:deletion.id});
    },
    onRender(onChange) {
      repaint = onChange;
      if (!verified && !error) refresh();
      return error || (!verified ? 'Reading the V2 Task…' : '');
    },
    beginTaskEdit(id) {
      if (writing) throw Error('A Task save is already in progress.');
      const basis = currentIntent(id);
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
      if (id !== editor?.basis.taskId) return Promise.reject(Error('Open the V2 Task editor before saving.'));
      // Use the Task and revision seen at editor open, even if a refresh has
      // since loaded a newer value underneath the draft.
      if (Object.hasOwn(fields, 'recurrence')) return submit(repeatOperation, id, () => editor.basis, {fields});
      if (Object.hasOwn(fields, 'dueDateISO')) return submit(dueOperation, id, () => editor.basis, {fields});
      if (Object.hasOwn(fields, 'points')) return submit(pointsOperation, id, () => editor.basis, {fields});
      if (Object.hasOwn(fields, 'importance') || Object.hasOwn(fields, 'tags')) {
        return submit(classificationOperation, id, () => editor.basis, {fields});
      }
      return submit(titleOperation, id, () => editor.basis, {title: fields.title});
    },
    commitPlusOneDay(id, _legacyTask, advance) {
      return submit(bumpOperation, id, () => currentIntent(id), {}, advance);
    }
  });
})();
