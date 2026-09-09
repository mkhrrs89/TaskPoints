(function installTaskPointsStateRuntimeV2Perf(global) {
  'use strict';

  const runtime = global?.TaskPointsStateRuntimeV2;
  if (!global || !runtime || global.TaskPointsStateRuntimeV2Perf?.installed) return;

  const now = () => global.performance?.now?.() ?? Date.now();
  const counters = {
    syncEnqueues: 0,
    asyncMutations: 0,
    parityChecks: 0,
    compatibilityBuilds: 0,
    totalSyncEnqueueMs: 0,
    maxSyncEnqueueMs: 0,
    totalMutationMs: 0,
    maxMutationMs: 0,
    lastMutation: null
  };

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function duration(name, ms, detail = {}) {
    try { global.TaskPointsPerf?.duration?.(name, ms, detail); } catch (_) {}
  }

  function keepMobileTraceUiCompact() {
    if (global.matchMedia?.('(max-width: 768px)')?.matches !== true || !global.document?.createElement) return;
    if (global.document.getElementById('tp-v2-mobile-perf-panel-guard')) return;
    const style = global.document.createElement('style');
    style.id = 'tp-v2-mobile-perf-panel-guard';
    style.textContent = '#tp-perf-panel{display:none!important}';
    (global.document.head || global.document.documentElement)?.appendChild?.(style);
  }

  function loadSerializationGuard() {
    if (global.TaskPointsStateRuntimeV2SerializationGuard?.installed || !global.document?.createElement) return true;
    if (global.document.querySelector?.('script[data-taskpoints-state-v2-serialization-guard]')) return true;
    const script = global.document.createElement('script');
    script.src = '/state_runtime_v2_serialization_guard.js';
    script.defer = true;
    script.dataset.taskpointsStateV2SerializationGuard = 'true';
    (global.document.head || global.document.documentElement)?.appendChild?.(script);
    return true;
  }

  function loadIdleMaintenanceScheduler() {
    if (global.TaskPointsStateRuntimeV2MaintenanceIdle?.installed || !global.document?.createElement) return true;
    if (global.document.querySelector?.('script[data-taskpoints-state-v2-maintenance-idle]')) return true;
    const script = global.document.createElement('script');
    script.src = '/state_runtime_v2_maintenance_idle.js';
    script.defer = true;
    script.dataset.taskpointsStateV2MaintenanceIdle = 'true';
    (global.document.head || global.document.documentElement)?.appendChild?.(script);
    return true;
  }

  keepMobileTraceUiCompact();

  function mutationShape(kind, args, result) {
    const input = args?.[0] || {};
    const base = {
      kind,
      committed: result?.committed === true,
      duplicate: result?.duplicate === true,
      revision: Number.isFinite(Number(result?.revision)) ? Number(result.revision) : null
    };
    if (kind === 'completion') {
      return { ...base, storesTouched: 3, estimatedRowsTouched: 3, habitId: String(input?.habitId || ''), dayKey: String(input?.dayKey || '') };
    }
    if (kind === 'order') {
      const count = Array.isArray(input?.orders) ? input.orders.length : Object.keys(input?.orders || {}).length;
      return { ...base, storesTouched: 3, estimatedRowsTouched: Math.max(2, count + 2), habitCount: count };
    }
    if (kind === 'edit') {
      const completionRows = Array.isArray(input?.completionRows) ? input.completionRows.length
        : Array.isArray(input?.completions) ? input.completions.length : 0;
      return { ...base, storesTouched: completionRows ? 4 : 3, estimatedRowsTouched: 3 + completionRows, completionRows };
    }
    if (kind === 'presence') {
      return { ...base, storesTouched: 3, estimatedRowsTouched: 3, exists: input?.exists !== false };
    }
    return base;
  }

  function wrapAsyncMethod(name, kind) {
    const original = runtime[name];
    if (typeof original !== 'function' || original.__taskPointsV2PerfWrapped) return;
    const wrapped = async function (...args) {
      const started = now();
      mark(`stateV2.txn.${kind}.start`, { kind });
      try {
        const result = await original.apply(this, args);
        const ms = now() - started;
        const detail = mutationShape(kind, args, result);
        counters.asyncMutations += 1;
        counters.totalMutationMs += ms;
        counters.maxMutationMs = Math.max(counters.maxMutationMs, ms);
        counters.lastMutation = { ...detail, durationMs: Number(ms.toFixed(2)) };
        duration(`stateV2.txn.${kind}`, ms, detail);
        mark(`stateV2.txn.${kind}.finish`, detail);
        return result;
      } catch (error) {
        const ms = now() - started;
        duration(`stateV2.txn.${kind}`, ms, { kind, failed: true, error: String(error?.code || error?.message || error) });
        throw error;
      }
    };
    wrapped.__taskPointsV2PerfWrapped = true;
    wrapped.__taskPointsOriginal = original;
    runtime[name] = wrapped;
  }

  function wrapSyncEnqueue(name, kind) {
    const original = runtime[name];
    if (typeof original !== 'function' || original.__taskPointsV2PerfWrapped) return;
    const wrapped = function (...args) {
      const started = now();
      const result = original.apply(this, args);
      const ms = now() - started;
      counters.syncEnqueues += 1;
      counters.totalSyncEnqueueMs += ms;
      counters.maxSyncEnqueueMs = Math.max(counters.maxSyncEnqueueMs, ms);
      duration(`stateV2.enqueue.${kind}.sync`, ms, {
        kind,
        foregroundBlocking: true,
        promiseReturned: Boolean(result && typeof result.then === 'function')
      });
      mark(`stateV2.enqueue.${kind}.queued`, { kind, synchronousMs: Number(ms.toFixed(2)) });
      return result;
    };
    wrapped.__taskPointsV2PerfWrapped = true;
    wrapped.__taskPointsOriginal = original;
    runtime[name] = wrapped;
  }

  function wrapMaintenance(name, label, counterKey) {
    const original = runtime[name];
    if (typeof original !== 'function' || original.__taskPointsV2PerfWrapped) return;
    const wrapped = async function (...args) {
      const started = now();
      mark(`stateV2.maintenance.${label}.start`, { foregroundBlocking: true });
      try {
        const result = await original.apply(this, args);
        const ms = now() - started;
        counters[counterKey] += 1;
        duration(`stateV2.maintenance.${label}`, ms, { foregroundBlocking: true });
        return result;
      } catch (error) {
        const ms = now() - started;
        duration(`stateV2.maintenance.${label}`, ms, { foregroundBlocking: true, failed: true });
        throw error;
      }
    };
    wrapped.__taskPointsV2PerfWrapped = true;
    wrapped.__taskPointsOriginal = original;
    runtime[name] = wrapped;
  }

  wrapAsyncMethod('applyHabitDelta', 'completion');
  wrapAsyncMethod('applyHabitOrderOverlay', 'order');
  wrapAsyncMethod('applyHabitEditSnapshot', 'edit');
  wrapAsyncMethod('applyHabitPresenceSnapshot', 'presence');

  wrapSyncEnqueue('enqueueHabitDelta', 'completion');
  wrapSyncEnqueue('enqueueHabitOrderOverlay', 'order');
  wrapSyncEnqueue('enqueueHabitEditFromLegacy', 'edit');
  wrapSyncEnqueue('enqueueHabitPresenceFromLegacy', 'presence');

  wrapMaintenance('verifyParity', 'parity', 'parityChecks');
  wrapMaintenance('buildCompatibilitySnapshot', 'compatibility', 'compatibilityBuilds');
  loadSerializationGuard();
  loadIdleMaintenanceScheduler();

  const api = {
    installed: true,
    version: 2,
    getStatus() {
      return {
        installed: true,
        syncEnqueues: counters.syncEnqueues,
        asyncMutations: counters.asyncMutations,
        parityChecks: counters.parityChecks,
        compatibilityBuilds: counters.compatibilityBuilds,
        averageSyncEnqueueMs: counters.syncEnqueues ? Number((counters.totalSyncEnqueueMs / counters.syncEnqueues).toFixed(2)) : 0,
        maxSyncEnqueueMs: Number(counters.maxSyncEnqueueMs.toFixed(2)),
        averageMutationMs: counters.asyncMutations ? Number((counters.totalMutationMs / counters.asyncMutations).toFixed(2)) : 0,
        maxMutationMs: Number(counters.maxMutationMs.toFixed(2)),
        lastMutation: counters.lastMutation
      };
    }
  };

  function safeSubsystemStatus(value) {
    try { return value?.getStatus?.() || null; }
    catch (error) { return { error: String(error?.message || error) }; }
  }

  function installRuntimeTraceStatusBridge() {
    const original = runtime.getStatus;
    if (typeof original !== 'function' || original.__taskPointsV2TraceStatusBridge) return false;
    const wrapped = function taskPointsV2TraceStatusBridge() {
      const base = original.apply(this, arguments);
      const status = base && typeof base === 'object' ? { ...base } : { value: base ?? null };
      status.traceDiagnostics = {
        perf: api.getStatus(),
        maintenanceIdle: safeSubsystemStatus(global.TaskPointsStateRuntimeV2MaintenanceIdle),
        serialization: safeSubsystemStatus(global.TaskPointsStateRuntimeV2SerializationGuard)
      };
      return status;
    };
    Object.defineProperties(wrapped, {
      __taskPointsV2TraceStatusBridge: { value: true },
      __taskPointsOriginal: { value: original }
    });
    runtime.getStatus = wrapped;
    return true;
  }

  global.TaskPointsStateRuntimeV2Perf = api;
  installRuntimeTraceStatusBridge();
  mark('stateV2.perfInstrumentationInstalled', { version: api.version });
})(typeof window !== 'undefined' ? window : globalThis);
