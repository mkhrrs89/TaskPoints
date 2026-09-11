(function installTaskPointsStateRuntimeV2HabitEditBridge(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2HabitEditBridge?.__installedModule) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  let installed = false;
  let installAttempts = 0;
  let mirroredEditRequests = 0;
  let hotSnapshotRequests = 0;
  let legacyFallbackRequests = 0;
  let skippedUnchanged = 0;
  let failures = 0;
  let lastReason = 'not_installed';
  let originalSaveHabitEdit = null;
  let wrappedSaveHabitEdit = null;

  function isEnabled() {
    try { return global.localStorage?.getItem?.(DARK_MODE_KEY) === '1'; }
    catch (_) { return false; }
  }

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function duration(name, ms, detail = {}) {
    try { global.TaskPointsPerf?.duration?.(name, ms, detail); } catch (_) {}
  }

  function now() {
    return global.performance?.now?.() ?? Date.now();
  }

  function cloneSmall(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function liveState() {
    try {
      if (typeof state !== 'undefined' && state && typeof state === 'object') return state;
    } catch (_) {}
    return global.state && typeof global.state === 'object' ? global.state : null;
  }

  function liveHabitUpdatedAt(habitId) {
    const current = liveState();
    if (!Array.isArray(current?.habits)) return null;
    const habit = current.habits.find((candidate) => String(candidate?.id || '') === String(habitId || ''));
    return habit?.updatedAtISO || null;
  }

  function captureHotEditSnapshot(habitIdInput, options = {}) {
    const started = now();
    const habitId = String(habitIdInput || '').trim();
    const current = liveState();
    if (!habitId || !current || !Array.isArray(current.habits)) return null;
    const habitIndex = current.habits.findIndex((habit) => String(habit?.id || '') === habitId);
    if (habitIndex < 0) return null;
    const completions = Array.isArray(current.completions) ? current.completions : [];
    const completionEntries = [];
    completions.forEach((completion, index) => {
      if (String(completion?.habitId || '') !== habitId) return;
      const storageId = completion?.id != null
        ? String(completion.id)
        : `__tp_v2_missing_completion_id__:${index}`;
      completionEntries.push({
        storageId,
        sequence: completions.length - index,
        value: cloneSmall(completion)
      });
    });
    const snapshot = {
      version: 1,
      habitId,
      source: String(options.source || 'hot-habit-edit'),
      capturedAtISO: new Date().toISOString(),
      habitIndex,
      habit: cloneSmall(current.habits[habitIndex]),
      completionEntries
    };
    const ms = now() - started;
    duration('stateV2.capture.edit.sync', ms, {
      kind: 'edit',
      foregroundBlocking: true,
      habitId,
      completionEntries: completionEntries.length,
      source: snapshot.source
    });
    return snapshot;
  }

  function sharedHotQueue() {
    if (global.TaskPointsStateRuntimeV2HotMirrorQueue?.enqueue) return global.TaskPointsStateRuntimeV2HotMirrorQueue;
    let tail = Promise.resolve();
    let queued = 0;
    let completed = 0;
    let failuresCount = 0;
    const queue = {
      installed: true,
      version: 1,
      enqueue(kind, runner) {
        queued += 1;
        const run = tail.then(() => runner());
        tail = run.then(
          (value) => { completed += 1; return value; },
          (error) => { failuresCount += 1; throw error; }
        ).catch(() => undefined);
        return run;
      },
      getStatus() { return { installed: true, queued, completed, failures: failuresCount }; }
    };
    global.TaskPointsStateRuntimeV2HotMirrorQueue = queue;
    return queue;
  }

  function installHotEditEnqueue() {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitEditFromLegacy || !runtime?.applyHabitEditSnapshot) return false;
    const candidate = runtime.enqueueHabitEditFromLegacy;
    if (candidate.__tpStateV2HotEditEnqueueWrapped === true) return true;
    const original = candidate;
    const wrapped = function taskPointsStateV2HotEditEnqueue(habitId, options = {}) {
      const hotSnapshot = options?.hotSnapshot;
      if (!hotSnapshot) return original.apply(this, arguments);
      const expectedGeneration = runtime.getStatus?.().currentGeneration || undefined;
      return sharedHotQueue().enqueue('edit', async () => {
        try {
          return await runtime.applyHabitEditSnapshot(hotSnapshot, { expectedGeneration });
        } catch (error) {
          if (error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT') {
            return runtime.applyHabitEditSnapshot(hotSnapshot, { expectedGeneration });
          }
          throw error;
        }
      });
    };
    Object.defineProperties(wrapped, {
      __tpStateV2HotEditEnqueueWrapped: { value: true },
      __tpStateV2OriginalEditEnqueue: { value: original }
    });
    runtime.enqueueHabitEditFromLegacy = wrapped;
    return runtime.enqueueHabitEditFromLegacy === wrapped;
  }

  function queuePersistedEdit(habitId) {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitEditFromLegacy) {
      lastReason = 'runtime_edit_api_unavailable';
      return false;
    }
    mirroredEditRequests += 1;
    const source = 'home-saveHabitEdit';
    let hotSnapshot = null;
    try { hotSnapshot = captureHotEditSnapshot(habitId, { source }); }
    catch (_) { hotSnapshot = null; }
    const options = { source };
    if (hotSnapshot && installHotEditEnqueue()) {
      options.hotSnapshot = hotSnapshot;
      hotSnapshotRequests += 1;
      lastReason = 'edit_hot_snapshot_queued';
    } else {
      legacyFallbackRequests += 1;
      lastReason = 'edit_legacy_fallback_queued';
    }
    Promise.resolve(runtime.enqueueHabitEditFromLegacy(String(habitId), options)).catch((error) => {
      failures += 1;
      lastReason = 'edit_queue_failed';
      console.warn('TaskPoints V2 Habit edit mirror request failed; production state remains authoritative.', error);
    });
    mark('stateV2.habitEditQueued', {
      habitId: String(habitId),
      hotSnapshot: Boolean(options.hotSnapshot)
    });
    return true;
  }

  function install() {
    installAttempts += 1;
    if (!isEnabled()) {
      lastReason = 'dark_disabled';
      return getStatus();
    }

    installHotEditEnqueue();

    if (wrappedSaveHabitEdit && global.saveHabitEdit === wrappedSaveHabitEdit) {
      installed = true;
      lastReason = 'installed';
      return getStatus();
    }

    const candidate = global.saveHabitEdit;
    if (typeof candidate !== 'function') {
      installed = false;
      lastReason = 'saveHabitEdit_unavailable';
      return getStatus();
    }

    if (candidate.__tpStateV2HabitEditWrapped === true && typeof candidate.__tpStateV2OriginalHabitEdit === 'function') {
      wrappedSaveHabitEdit = candidate;
      originalSaveHabitEdit = candidate.__tpStateV2OriginalHabitEdit;
      installed = true;
      lastReason = 'installed';
      return getStatus();
    }

    originalSaveHabitEdit = candidate;
    wrappedSaveHabitEdit = function taskPointsStateV2HabitEditBridge(habitId) {
      const beforeUpdatedAt = liveHabitUpdatedAt(habitId);
      const result = originalSaveHabitEdit.apply(this, arguments);
      if (!isEnabled()) return result;

      const afterUpdatedAt = liveHabitUpdatedAt(habitId);
      if (beforeUpdatedAt !== null && afterUpdatedAt === beforeUpdatedAt) {
        skippedUnchanged += 1;
        lastReason = 'edit_unchanged_or_cancelled';
        return result;
      }

      queuePersistedEdit(habitId);
      return result;
    };

    Object.defineProperties(wrappedSaveHabitEdit, {
      __tpStateV2HabitEditWrapped: { value: true },
      __tpStateV2OriginalHabitEdit: { value: originalSaveHabitEdit }
    });

    global.saveHabitEdit = wrappedSaveHabitEdit;
    installed = global.saveHabitEdit === wrappedSaveHabitEdit;
    lastReason = installed ? 'installed' : 'assignment_failed';
    if (installed) mark('stateV2.habitEditBridgeInstalled');
    return getStatus();
  }

  function getStatus() {
    return {
      installed,
      enabled: isEnabled(),
      installAttempts,
      mirroredEditRequests,
      hotSnapshotRequests,
      legacyFallbackRequests,
      skippedUnchanged,
      failures,
      lastReason,
      originalAvailable: typeof originalSaveHabitEdit === 'function'
    };
  }

  const api = {
    __installedModule: true,
    install,
    getStatus,
    captureHotEditSnapshot,
    installHotEditEnqueue
  };
  global.TaskPointsStateRuntimeV2HabitEditBridge = api;

  const installAfterHomeScript = () => install();
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installAfterHomeScript, { once: true });
  } else if (typeof global.setTimeout === 'function') {
    global.setTimeout(installAfterHomeScript, 0);
  } else {
    installAfterHomeScript();
  }
  global.addEventListener?.('pageshow', installAfterHomeScript);

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
