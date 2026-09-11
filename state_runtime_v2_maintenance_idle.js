(function installTaskPointsStateRuntimeV2MaintenanceIdle(global) {
  'use strict';

  const runtime = global?.TaskPointsStateRuntimeV2;
  const core = global?.TaskPointsCore;
  if (!global || !runtime || !core || global.TaskPointsStateRuntimeV2MaintenanceIdle?.installed) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  const DEEP_QUIET_MS = 20000;
  const DEEP_QUIET_POLL_MS = 250;
  const INTERACTION_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'beforeinput', 'input', 'focusin'];
  const mutationMethods = [
    ['enqueueHabitDelta', 'completion'],
    ['enqueueHabitOrderOverlay', 'order'],
    ['enqueueHabitEditFromLegacy', 'edit'],
    ['enqueueHabitPresenceFromLegacy', 'presence']
  ];

  const lanes = new Map();
  let scheduled = 0;
  let executed = 0;
  let coalesced = 0;
  let skipped = 0;
  let failures = 0;
  let deepQuietDeferrals = 0;
  let deepQuietReleases = 0;
  let deepQuietPending = 0;
  let deepQuietPreemptions = 0;
  let interactionRevision = 0;
  let lastInteractionAtMs = null;
  let installedInteractionObservers = 0;
  let lastKind = null;
  let lastSource = null;
  let lastError = null;
  let lastDurationMs = 0;
  let installedMutationHooks = 0;

  const now = () => global.performance?.now?.() ?? Date.now();

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function duration(name, ms, detail = {}) {
    try { global.TaskPointsPerf?.duration?.(name, ms, detail); } catch (_) {}
  }

  function isDarkEnabled() {
    try {
      const stored = global.localStorage?.getItem?.(DARK_MODE_KEY);
      if (stored !== null && stored !== undefined) return stored === '1';
    } catch (_) {}
    try {
      const getter = runtime.getStatus;
      const base = typeof getter?.__taskPointsOriginal === 'function'
        ? getter.__taskPointsOriginal.call(runtime)
        : getter?.call(runtime);
      return base?.darkEnabled === true;
    } catch (_) {
      return false;
    }
  }

  function getLane(kind) {
    let lane = lanes.get(kind);
    if (!lane) {
      lane = { requested: 0, completed: 0, promise: null, lastResult: null };
      lanes.set(kind, lane);
    }
    return lane;
  }

  function idleCoordinatorAvailable() {
    return typeof core.whenStorageMaintenanceQuiet === 'function';
  }

  function idleStatus() {
    try {
      const value = core.getStorageMaintenanceIdleStatus?.();
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function deepQuietReady(status = idleStatus()) {
    if (!status) return null;
    if (global.document?.visibilityState === 'hidden') return false;
    if (status.pageLeaving === true || status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= DEEP_QUIET_MS;
  }

  function noteInteraction(event) {
    if (event?.isTrusted === false) return;
    interactionRevision += 1;
    lastInteractionAtMs = now();
  }

  function installInteractionObservers() {
    const document = global.document;
    if (!document?.addEventListener) return 0;
    let count = 0;
    INTERACTION_EVENTS.forEach((eventName) => {
      try {
        document.addEventListener(eventName, noteInteraction, true);
        count += 1;
      } catch (_) {}
    });
    installedInteractionObservers = count;
    return count;
  }

  function waitForDeepQuiet(kind, source) {
    const current = idleStatus();
    const ready = deepQuietReady(current);
    if (ready === null || ready === true) return Promise.resolve({ waited: false, status: current, preemptionCount: 0 });
    if (typeof global.setTimeout !== 'function') {
      mark(`stateV2.maintenance.${kind}.deepQuietBypassed`, {
        kind,
        source,
        reason: 'timer_unavailable',
        foregroundBlocking: false
      });
      return Promise.resolve({ waited: false, bypassed: true, status: current, preemptionCount: 0 });
    }

    deepQuietDeferrals += 1;
    deepQuietPending += 1;
    const interactionRevisionAtDeferral = interactionRevision;
    let observedInteractionRevision = interactionRevisionAtDeferral;
    let preemptionCount = 0;
    mark(`stateV2.maintenance.${kind}.deepDeferred`, {
      kind,
      source,
      requiredQuietMs: DEEP_QUIET_MS,
      lastInteractionAgoMs: Number(current?.lastInteractionAgoMs || 0),
      navigationQuietForMs: Number(current?.navigationQuietForMs || 0),
      activeEditor: current?.activeEditor === true,
      interactionRevision: interactionRevisionAtDeferral,
      foregroundBlocking: false
    });

    return new Promise((resolve) => {
      const retry = () => {
        const next = idleStatus();
        if (interactionRevision > observedInteractionRevision) {
          const newlyObserved = interactionRevision - observedInteractionRevision;
          observedInteractionRevision = interactionRevision;
          preemptionCount += newlyObserved;
          deepQuietPreemptions += newlyObserved;
          mark(`stateV2.maintenance.${kind}.preempted`, {
            kind,
            source,
            newlyObserved,
            preemptionCount,
            interactionRevision,
            requiredQuietMs: DEEP_QUIET_MS,
            lastInteractionAgoMs: Number(next?.lastInteractionAgoMs || 0),
            foregroundBlocking: false
          });
        }
        const nextReady = deepQuietReady(next);
        if (nextReady === false) {
          global.setTimeout(retry, DEEP_QUIET_POLL_MS);
          return;
        }
        deepQuietPending = Math.max(0, deepQuietPending - 1);
        deepQuietReleases += 1;
        mark(`stateV2.maintenance.${kind}.deepReleased`, {
          kind,
          source,
          requiredQuietMs: DEEP_QUIET_MS,
          lastInteractionAgoMs: Number(next?.lastInteractionAgoMs || 0),
          statusUnavailable: nextReady === null,
          preemptionCount,
          interactionRevisionAtDeferral,
          interactionRevisionAtRelease: interactionRevision,
          foregroundBlocking: false
        });
        resolve({ waited: true, status: next, preemptionCount });
      };
      global.setTimeout(retry, DEEP_QUIET_POLL_MS);
    });
  }

  function originalRuntimeMethod(name) {
    const method = runtime?.[name];
    if (typeof method !== 'function') return null;
    return typeof method.__taskPointsOriginal === 'function' ? method.__taskPointsOriginal : method;
  }

  async function runWhenQuiet(kind, source, runner) {
    if (!idleCoordinatorAvailable()) {
      skipped += 1;
      mark(`stateV2.maintenance.${kind}.idleSkipped`, {
        kind,
        source,
        foregroundBlocking: false,
        reason: 'idle_coordinator_unavailable'
      });
      return { skipped: true, reason: 'idle_coordinator_unavailable' };
    }

    scheduled += 1;
    mark(`stateV2.maintenance.${kind}.scheduled`, {
      kind,
      source,
      foregroundBlocking: false
    });

    await waitForDeepQuiet(kind, source);

    return core.whenStorageMaintenanceQuiet(async () => {
      const started = now();
      executed += 1;
      lastKind = kind;
      lastSource = source;
      mark(`stateV2.maintenance.${kind}.start`, {
        kind,
        source,
        foregroundBlocking: false,
        scheduled: true
      });
      try {
        const result = await runner();
        const ms = now() - started;
        lastDurationMs = Number(ms.toFixed(2));
        duration(`stateV2.maintenance.${kind}`, ms, {
          kind,
          source,
          foregroundBlocking: false,
          scheduled: true
        });
        mark(`stateV2.maintenance.${kind}.finish`, {
          kind,
          source,
          foregroundBlocking: false,
          scheduled: true
        });
        return result;
      } catch (error) {
        const ms = now() - started;
        failures += 1;
        lastError = String(error?.code || error?.message || error);
        duration(`stateV2.maintenance.${kind}`, ms, {
          kind,
          source,
          foregroundBlocking: false,
          scheduled: true,
          failed: true,
          error: lastError
        });
        throw error;
      }
    }, { reason: `state_v2_background_${kind}` });
  }

  function scheduleLane(kind, source, runner) {
    const lane = getLane(kind);
    lane.requested += 1;
    const requestedAtCall = lane.requested;

    if (lane.promise) {
      coalesced += 1;
      mark(`stateV2.maintenance.${kind}.coalesced`, {
        kind,
        source,
        requested: lane.requested,
        completed: lane.completed,
        foregroundBlocking: false
      });
      return lane.promise;
    }

    lane.promise = (async () => {
      while (lane.completed < lane.requested) {
        let targetRequest = lane.completed;
        lane.lastResult = await runWhenQuiet(kind, source, async () => {
          targetRequest = lane.requested;
          return runner();
        });
        if (lane.lastResult?.skipped === true && targetRequest <= lane.completed) {
          lane.completed = lane.requested;
          break;
        }
        lane.completed = targetRequest;
      }
      return lane.lastResult;
    })().finally(() => {
      lane.promise = null;
    });

    mark(`stateV2.maintenance.${kind}.laneOpened`, {
      kind,
      source,
      request: requestedAtCall,
      foregroundBlocking: false
    });
    return lane.promise;
  }

  function scheduleParityVerification(options = {}) {
    if (!isDarkEnabled()) {
      skipped += 1;
      return Promise.resolve({ skipped: true, reason: 'dark_disabled' });
    }
    const source = String(options.source || 'v2-mutation');
    const verify = originalRuntimeMethod('verifyParity');
    if (!verify) {
      skipped += 1;
      return Promise.resolve({ skipped: true, reason: 'parity_api_unavailable' });
    }
    return scheduleLane('parity', source, () => verify.call(runtime));
  }

  function scheduleCompatibilitySnapshot(options = {}) {
    if (!isDarkEnabled()) {
      skipped += 1;
      return Promise.resolve({ skipped: true, reason: 'dark_disabled' });
    }
    const source = String(options.source || 'v2-checkpoint');
    const build = originalRuntimeMethod('buildCompatibilitySnapshot');
    if (!build) {
      skipped += 1;
      return Promise.resolve({ skipped: true, reason: 'compatibility_api_unavailable' });
    }
    return scheduleLane('compatibility', source, () => build.call(runtime));
  }

  function wrapMutationEnqueue(name, kind) {
    const original = runtime[name];
    if (typeof original !== 'function' || original.__taskPointsV2IdleMaintenanceWrapped) return false;

    const wrapped = function taskPointsV2IdleMaintenanceMutationHook() {
      const result = original.apply(this, arguments);
      if (!isDarkEnabled()) return result;
      Promise.resolve(result).then(
        () => {
          Promise.resolve(scheduleParityVerification({ source: `mutation:${kind}` })).catch((error) => {
            failures += 1;
            lastError = String(error?.code || error?.message || error);
          });
        },
        () => undefined
      );
      return result;
    };

    Object.defineProperties(wrapped, {
      __taskPointsV2IdleMaintenanceWrapped: { value: true },
      __taskPointsOriginal: { value: original }
    });
    runtime[name] = wrapped;
    installedMutationHooks += 1;
    return true;
  }

  installInteractionObservers();
  mutationMethods.forEach(([name, kind]) => wrapMutationEnqueue(name, kind));

  const api = {
    installed: true,
    version: 3,
    scheduleParityVerification,
    scheduleCompatibilitySnapshot,
    getStatus() {
      const laneStatus = {};
      for (const [kind, lane] of lanes) {
        laneStatus[kind] = {
          requested: lane.requested,
          completed: lane.completed,
          active: Boolean(lane.promise)
        };
      }
      return {
        installed: true,
        darkEnabled: isDarkEnabled(),
        idleCoordinatorAvailable: idleCoordinatorAvailable(),
        deepQuietMs: DEEP_QUIET_MS,
        deepQuietPollMs: DEEP_QUIET_POLL_MS,
        deepQuietDeferrals,
        deepQuietReleases,
        deepQuietPending,
        deepQuietPreemptions,
        interactionRevision,
        lastInteractionAtMs,
        installedInteractionObservers,
        installedMutationHooks,
        scheduled,
        executed,
        coalesced,
        skipped,
        failures,
        lastKind,
        lastSource,
        lastError,
        lastDurationMs,
        lanes: laneStatus
      };
    }
  };

  global.TaskPointsStateRuntimeV2MaintenanceIdle = api;
  mark('stateV2.maintenanceIdleInstalled', {
    version: api.version,
    installedMutationHooks,
    installedInteractionObservers,
    idleCoordinatorAvailable: idleCoordinatorAvailable(),
    deepQuietMs: DEEP_QUIET_MS
  });

  if (isDarkEnabled()) {
    Promise.resolve(scheduleParityVerification({ source: 'maintenance-module-install' })).catch((error) => {
      failures += 1;
      lastError = String(error?.code || error?.message || error);
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
