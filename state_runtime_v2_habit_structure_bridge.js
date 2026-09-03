(function installTaskPointsStateRuntimeV2HabitStructureBridge(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2HabitStructureBridge?.__installedModule) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  let installed = false;
  let installAttempts = 0;
  let presenceRequests = 0;
  let retireEditRequests = 0;
  let skippedNoChange = 0;
  let failures = 0;
  let lastReason = 'not_installed';
  const originals = new Map();
  const wrappers = new Map();

  function isEnabled() {
    try { return global.localStorage?.getItem?.(DARK_MODE_KEY) === '1'; }
    catch (_) { return false; }
  }

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function liveHabits() {
    try {
      return typeof state !== 'undefined' && Array.isArray(state?.habits) ? state.habits : [];
    } catch (_) {
      return [];
    }
  }

  function liveHabitIds() {
    return new Set(liveHabits().map((habit) => String(habit?.id || '')).filter(Boolean));
  }

  function liveHabit(habitId) {
    const id = String(habitId || '');
    return liveHabits().find((habit) => String(habit?.id || '') === id) || null;
  }

  function queuePresence(habitId, source) {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitPresenceFromLegacy) {
      lastReason = 'presence_api_unavailable';
      return false;
    }
    presenceRequests += 1;
    lastReason = 'presence_queued';
    Promise.resolve(runtime.enqueueHabitPresenceFromLegacy(String(habitId), { source }))
      .catch((error) => {
        failures += 1;
        lastReason = 'presence_queue_failed';
        console.warn('TaskPoints V2 Habit structure mirror request failed; production state remains authoritative.', error);
      });
    mark('stateV2.habitPresenceQueued', { habitId: String(habitId), source });
    return true;
  }

  function queueRetireEdit(habitId) {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitEditFromLegacy) {
      lastReason = 'edit_api_unavailable';
      return false;
    }
    retireEditRequests += 1;
    lastReason = 'retire_edit_queued';
    Promise.resolve(runtime.enqueueHabitEditFromLegacy(String(habitId), { source: 'home-retireHabit' }))
      .catch((error) => {
        failures += 1;
        lastReason = 'retire_edit_queue_failed';
        console.warn('TaskPoints V2 Habit retire mirror request failed; production state remains authoritative.', error);
      });
    mark('stateV2.habitRetireQueued', { habitId: String(habitId) });
    return true;
  }

  function wrapAdd(methodName) {
    const candidate = global[methodName];
    if (typeof candidate !== 'function') return false;
    if (candidate.__tpStateV2HabitStructureWrapped === true) {
      originals.set(methodName, candidate.__tpStateV2OriginalHabitStructure);
      wrappers.set(methodName, candidate);
      return true;
    }

    const original = candidate;
    const wrapped = function taskPointsStateV2HabitAddBridge() {
      const before = liveHabitIds();
      const result = original.apply(this, arguments);
      if (!isEnabled()) return result;
      const after = liveHabitIds();
      const added = Array.from(after).filter((id) => !before.has(id));
      if (!added.length) {
        skippedNoChange += 1;
        lastReason = 'add_no_change';
        return result;
      }
      added.forEach((habitId) => queuePresence(habitId, `home-${methodName}`));
      return result;
    };
    Object.defineProperties(wrapped, {
      __tpStateV2HabitStructureWrapped: { value: true },
      __tpStateV2OriginalHabitStructure: { value: original }
    });
    global[methodName] = wrapped;
    originals.set(methodName, original);
    wrappers.set(methodName, wrapped);
    return global[methodName] === wrapped;
  }

  function wrapDelete() {
    const methodName = 'deleteHabit';
    const candidate = global[methodName];
    if (typeof candidate !== 'function') return false;
    if (candidate.__tpStateV2HabitStructureWrapped === true) {
      originals.set(methodName, candidate.__tpStateV2OriginalHabitStructure);
      wrappers.set(methodName, candidate);
      return true;
    }

    const original = candidate;
    const wrapped = function taskPointsStateV2HabitDeleteBridge(habitId) {
      const existedBefore = Boolean(liveHabit(habitId));
      const result = original.apply(this, arguments);
      if (!isEnabled()) return result;
      const existsAfter = Boolean(liveHabit(habitId));
      if (!existedBefore || existsAfter) {
        skippedNoChange += 1;
        lastReason = 'delete_no_change';
        return result;
      }
      queuePresence(habitId, 'home-deleteHabit');
      return result;
    };
    Object.defineProperties(wrapped, {
      __tpStateV2HabitStructureWrapped: { value: true },
      __tpStateV2OriginalHabitStructure: { value: original }
    });
    global[methodName] = wrapped;
    originals.set(methodName, original);
    wrappers.set(methodName, wrapped);
    return global[methodName] === wrapped;
  }

  function wrapRetire() {
    const methodName = 'retireHabit';
    const candidate = global[methodName];
    if (typeof candidate !== 'function') return false;
    if (candidate.__tpStateV2HabitStructureWrapped === true) {
      originals.set(methodName, candidate.__tpStateV2OriginalHabitStructure);
      wrappers.set(methodName, candidate);
      return true;
    }

    const original = candidate;
    const wrapped = function taskPointsStateV2HabitRetireBridge(habitId) {
      const before = liveHabit(habitId);
      const beforeUpdatedAt = before?.updatedAtISO || null;
      const beforeRetired = before?.retired === true;
      const result = original.apply(this, arguments);
      if (!isEnabled()) return result;
      const after = liveHabit(habitId);
      const changed = Boolean(
        after
        && (after.updatedAtISO || null) !== beforeUpdatedAt
        && after.retired === true
        && beforeRetired !== true
      );
      if (!changed) {
        skippedNoChange += 1;
        lastReason = 'retire_no_change';
        return result;
      }
      queueRetireEdit(habitId);
      return result;
    };
    Object.defineProperties(wrapped, {
      __tpStateV2HabitStructureWrapped: { value: true },
      __tpStateV2OriginalHabitStructure: { value: original }
    });
    global[methodName] = wrapped;
    originals.set(methodName, original);
    wrappers.set(methodName, wrapped);
    return global[methodName] === wrapped;
  }

  function install() {
    installAttempts += 1;
    if (!isEnabled()) {
      lastReason = 'dark_disabled';
      return getStatus();
    }

    const results = [
      wrapAdd('addHabit'),
      wrapAdd('addVice'),
      wrapDelete(),
      wrapRetire()
    ];
    installed = results.every(Boolean);
    lastReason = installed ? 'installed' : 'home_methods_unavailable';
    if (installed) mark('stateV2.habitStructureBridgeInstalled');
    return getStatus();
  }

  function getStatus() {
    return {
      installed,
      enabled: isEnabled(),
      installAttempts,
      presenceRequests,
      retireEditRequests,
      skippedNoChange,
      failures,
      lastReason,
      wrappedMethods: Array.from(wrappers.keys()).sort()
    };
  }

  const api = {
    __installedModule: true,
    install,
    getStatus
  };
  global.TaskPointsStateRuntimeV2HabitStructureBridge = api;

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
