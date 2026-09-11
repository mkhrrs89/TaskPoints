(function installTaskPointsStateRuntimeV2HabitStructureBridge(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2HabitStructureBridge?.__installedModule) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  let installed = false;
  let installAttempts = 0;
  let presenceRequests = 0;
  let retireEditRequests = 0;
  let hotPresenceSnapshotRequests = 0;
  let hotRetireSnapshotRequests = 0;
  let legacyFallbackRequests = 0;
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

  function liveHabits() {
    const current = liveState();
    return Array.isArray(current?.habits) ? current.habits : [];
  }

  function liveHabitIds() {
    return new Set(liveHabits().map((habit) => String(habit?.id || '')).filter(Boolean));
  }

  function liveHabit(habitId) {
    const id = String(habitId || '');
    return liveHabits().find((habit) => String(habit?.id || '') === id) || null;
  }

  function captureHotPresenceSnapshot(habitIdInput, options = {}) {
    const started = now();
    const habitId = String(habitIdInput || '').trim();
    if (!habitId) return null;
    const habits = liveHabits();
    const habitIndex = habits.findIndex((habit) => String(habit?.id || '') === habitId);
    const exists = habitIndex >= 0;
    const snapshot = {
      version: 1,
      habitId,
      exists,
      source: String(options.source || 'hot-habit-presence'),
      capturedAtISO: new Date().toISOString(),
      habitIndex: exists ? habitIndex : null,
      habit: exists ? cloneSmall(habits[habitIndex]) : null
    };
    const ms = now() - started;
    duration('stateV2.capture.presence.sync', ms, {
      kind: 'presence',
      foregroundBlocking: true,
      habitId,
      exists,
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

  function installHotPresenceEnqueue() {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitPresenceFromLegacy || !runtime?.applyHabitPresenceSnapshot) return false;
    const candidate = runtime.enqueueHabitPresenceFromLegacy;
    if (candidate.__tpStateV2HotPresenceEnqueueWrapped === true) return true;
    const original = candidate;
    const wrapped = function taskPointsStateV2HotPresenceEnqueue(habitId, options = {}) {
      const hotSnapshot = options?.hotSnapshot;
      if (!hotSnapshot) return original.apply(this, arguments);
      const expectedGeneration = runtime.getStatus?.().currentGeneration || undefined;
      return sharedHotQueue().enqueue('presence', async () => {
        try {
          return await runtime.applyHabitPresenceSnapshot(hotSnapshot, { expectedGeneration });
        } catch (error) {
          if (error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT') {
            return runtime.applyHabitPresenceSnapshot(hotSnapshot, { expectedGeneration });
          }
          throw error;
        }
      });
    };
    Object.defineProperties(wrapped, {
      __tpStateV2HotPresenceEnqueueWrapped: { value: true },
      __tpStateV2OriginalPresenceEnqueue: { value: original }
    });
    runtime.enqueueHabitPresenceFromLegacy = wrapped;
    return runtime.enqueueHabitPresenceFromLegacy === wrapped;
  }

  function queuePresence(habitId, source) {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitPresenceFromLegacy) {
      lastReason = 'presence_api_unavailable';
      return false;
    }
    presenceRequests += 1;
    let hotSnapshot = null;
    try { hotSnapshot = captureHotPresenceSnapshot(habitId, { source }); }
    catch (_) { hotSnapshot = null; }
    const options = { source };
    if (hotSnapshot && installHotPresenceEnqueue()) {
      options.hotSnapshot = hotSnapshot;
      hotPresenceSnapshotRequests += 1;
      lastReason = 'presence_hot_snapshot_queued';
    } else {
      legacyFallbackRequests += 1;
      lastReason = 'presence_legacy_fallback_queued';
    }
    Promise.resolve(runtime.enqueueHabitPresenceFromLegacy(String(habitId), options))
      .catch((error) => {
        failures += 1;
        lastReason = 'presence_queue_failed';
        mark('stateV2.habitPresenceQueueFailed', {
          habitId: String(habitId),
          source,
          message: String(error?.code || error?.message || error)
        });
        console.warn('TaskPoints V2 Habit structure mirror request failed; production state remains authoritative.', error);
      });
    mark('stateV2.habitPresenceQueued', {
      habitId: String(habitId),
      source,
      hotSnapshot: Boolean(options.hotSnapshot)
    });
    return true;
  }

  function queueRetireEdit(habitId) {
    const runtime = global.TaskPointsStateRuntimeV2;
    if (!runtime?.enqueueHabitEditFromLegacy) {
      lastReason = 'edit_api_unavailable';
      return false;
    }
    retireEditRequests += 1;
    const source = 'home-retireHabit';
    let hotSnapshot = null;
    try {
      const editBridge = global.TaskPointsStateRuntimeV2HabitEditBridge;
      editBridge?.installHotEditEnqueue?.();
      hotSnapshot = editBridge?.captureHotEditSnapshot?.(habitId, { source }) || null;
    } catch (_) {
      hotSnapshot = null;
    }
    const options = { source };
    if (hotSnapshot) {
      options.hotSnapshot = hotSnapshot;
      hotRetireSnapshotRequests += 1;
      lastReason = 'retire_edit_hot_snapshot_queued';
    } else {
      legacyFallbackRequests += 1;
      lastReason = 'retire_edit_legacy_fallback_queued';
    }
    Promise.resolve(runtime.enqueueHabitEditFromLegacy(String(habitId), options))
      .catch((error) => {
        failures += 1;
        lastReason = 'retire_edit_queue_failed';
        mark('stateV2.habitRetireQueueFailed', {
          habitId: String(habitId),
          message: String(error?.code || error?.message || error)
        });
        console.warn('TaskPoints V2 Habit retire mirror request failed; production state remains authoritative.', error);
      });
    mark('stateV2.habitRetireQueued', {
      habitId: String(habitId),
      hotSnapshot: Boolean(options.hotSnapshot)
    });
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
    const wrapped = function taskPointsStateRuntimeV2HabitRetireBridge(habitId) {
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

    installHotPresenceEnqueue();
    global.TaskPointsStateRuntimeV2HabitEditBridge?.installHotEditEnqueue?.();

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
      hotPresenceSnapshotRequests,
      hotRetireSnapshotRequests,
      legacyFallbackRequests,
      skippedNoChange,
      failures,
      lastReason,
      wrappedMethods: Array.from(wrappers.keys()).sort()
    };
  }

  function loadPerfInstrumentation() {
    if (!isEnabled() || global.TaskPointsStateRuntimeV2Perf?.installed || !global.document?.createElement) return false;
    if (global.document.querySelector?.('script[data-taskpoints-state-v2-perf]')) return true;
    const script = global.document.createElement('script');
    script.src = '/state_runtime_v2_perf.js?v=20260911-5';
    script.defer = true;
    script.dataset.taskpointsStateV2Perf = 'true';
    (global.document.head || global.document.documentElement)?.appendChild?.(script);
    return true;
  }

  function loadLiveTraceReview() {
    if (!isEnabled() || global.TaskPointsStateRuntimeV2LiveReview?.installed || !global.document?.createElement) return false;
    if (global.document.querySelector?.('script[data-taskpoints-state-v2-live-review]')) return true;
    const script = global.document.createElement('script');
    script.src = '/state_runtime_v2_live_review.js?v=20260911-4';
    script.defer = true;
    script.dataset.taskpointsStateV2LiveReview = 'true';
    (global.document.head || global.document.documentElement)?.appendChild?.(script);
    return true;
  }

  const api = {
    __installedModule: true,
    install,
    getStatus,
    loadPerfInstrumentation,
    loadLiveTraceReview,
    captureHotPresenceSnapshot,
    installHotPresenceEnqueue
  };
  global.TaskPointsStateRuntimeV2HabitStructureBridge = api;

  const installAfterHomeScript = () => {
    loadPerfInstrumentation();
    loadLiveTraceReview();
    return install();
  };
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
