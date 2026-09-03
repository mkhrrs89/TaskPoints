(function installTaskPointsStateRuntimeV2HabitEditBridge(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2HabitEditBridge?.__installedModule) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  let installed = false;
  let installAttempts = 0;
  let mirroredEditRequests = 0;
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

  function liveHabitUpdatedAt(habitId) {
    try {
      if (typeof state === 'undefined' || !Array.isArray(state?.habits)) return null;
      const habit = state.habits.find((candidate) => String(candidate?.id || '') === String(habitId || ''));
      return habit?.updatedAtISO || null;
    } catch (_) {
      return null;
    }
  }

  function queuePersistedEdit(habitId) {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitEditFromLegacy) {
      lastReason = 'runtime_edit_api_unavailable';
      return false;
    }
    mirroredEditRequests += 1;
    lastReason = 'edit_queued';
    Promise.resolve(runtime.enqueueHabitEditFromLegacy(String(habitId), {
      source: 'home-saveHabitEdit'
    })).catch((error) => {
      failures += 1;
      lastReason = 'edit_queue_failed';
      console.warn('TaskPoints V2 Habit edit mirror request failed; production state remains authoritative.', error);
    });
    mark('stateV2.habitEditQueued', { habitId: String(habitId) });
    return true;
  }

  function install() {
    installAttempts += 1;
    if (!isEnabled()) {
      lastReason = 'dark_disabled';
      return getStatus();
    }

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
      skippedUnchanged,
      failures,
      lastReason,
      originalAvailable: typeof originalSaveHabitEdit === 'function'
    };
  }

  const api = {
    __installedModule: true,
    install,
    getStatus
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
