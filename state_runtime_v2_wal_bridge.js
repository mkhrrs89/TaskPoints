(function installTaskPointsStateRuntimeV2WalBridge(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2WalBridge?.__installedModule) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  let hookInstalled = false;
  let originalWritePendingHabitDelta = null;
  let confirmationAttempts = 0;
  let confirmationsCleared = 0;
  let replayAttempts = 0;
  let replayCleared = 0;
  let failures = 0;
  let lastError = null;
  let lastMutationId = null;
  let replayPromise = null;

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function isEnabled() {
    try { return global.localStorage?.getItem?.(DARK_MODE_KEY) === '1'; }
    catch (_) { return false; }
  }

  function deps() {
    return {
      core: global.TaskPointsCore || null,
      runtime: global.TaskPointsStateRuntimeV2 || null,
      wal: global.TaskPointsStateRuntimeV2Wal || null
    };
  }

  function rememberFailure(error, phase, mutationId = null) {
    failures += 1;
    lastError = String(error?.message || error || 'unknown');
    mark('stateV2.walBridgeFailed', { phase, mutationId, message: lastError });
  }

  async function verifyAndClear(delta, mutationId, phase = 'confirm') {
    const { runtime, wal } = deps();
    if (!runtime?.applyHabitDelta || !wal?.removeMutation) {
      throw new Error('state_runtime_v2_wal_bridge_dependencies_unavailable');
    }

    const result = await runtime.applyHabitDelta(delta);
    if (result?.committed !== true && result?.duplicate !== true) {
      return { cleared: false, reason: result?.reason || 'mutation_not_verified', result };
    }

    const removal = wal.removeMutation(mutationId);
    if (removal?.removed === true || removal?.reason === 'not_found') {
      lastMutationId = mutationId;
      if (phase === 'replay') replayCleared += 1;
      else confirmationsCleared += 1;
      mark('stateV2.walBridgeCleared', { phase, mutationId, duplicate: result?.duplicate === true });
      return { cleared: true, mutationId, result, removal };
    }

    return { cleared: false, reason: removal?.reason || 'wal_cleanup_unverified', result, removal };
  }

  function scheduleConfirmation(delta, mutationId) {
    const run = async () => {
      confirmationAttempts += 1;
      try {
        await verifyAndClear(delta, mutationId, 'confirm');
      } catch (error) {
        rememberFailure(error, 'confirm', mutationId);
      }
    };

    if (typeof global.setTimeout === 'function') global.setTimeout(run, 0);
    else Promise.resolve().then(run);
  }

  function installHook() {
    if (!isEnabled()) return false;
    if (hookInstalled) return true;

    const { core, wal } = deps();
    if (typeof core?.writePendingHabitDelta !== 'function' || typeof wal?.appendHabitDelta !== 'function') return false;

    originalWritePendingHabitDelta = core.writePendingHabitDelta.bind(core);
    core.writePendingHabitDelta = function taskPointsV2WalProtectedHabitDelta(delta) {
      const result = originalWritePendingHabitDelta(...arguments);
      const durableDelta = result || delta;

      try {
        const appended = wal.appendHabitDelta(durableDelta);
        if (appended?.mutationId) {
          lastMutationId = appended.mutationId;
          scheduleConfirmation(appended?.row?.delta || durableDelta, appended.mutationId);
        }
      } catch (error) {
        // V1 already persisted successfully. Never break production because the preview-only V2 WAL failed.
        rememberFailure(error, 'append');
      }

      return result;
    };

    hookInstalled = true;
    mark('stateV2.walBridgeHookInstalled');
    return true;
  }

  async function replayPending() {
    if (!isEnabled()) return { replayed: false, reason: 'dark_disabled', attempted: 0, cleared: 0 };
    const { wal } = deps();
    if (!wal?.getPendingRows) return { replayed: false, reason: 'wal_unavailable', attempted: 0, cleared: 0 };

    const pending = wal.getPendingRows();
    if (!pending?.ok) {
      rememberFailure(new Error(pending?.error || 'state_runtime_v2_wal_unreadable'), 'replay_read');
      return { replayed: false, reason: 'wal_unreadable', attempted: 0, cleared: 0 };
    }

    let attempted = 0;
    let cleared = 0;
    for (const row of pending.rows || []) {
      if (row?.type !== 'habit-completion-set' || !row?.id || !row?.delta) {
        rememberFailure(new Error('state_runtime_v2_wal_replay_invalid_row'), 'replay_row', row?.id || null);
        break;
      }

      attempted += 1;
      replayAttempts += 1;
      try {
        const result = await verifyAndClear(row.delta, row.id, 'replay');
        if (!result?.cleared) break;
        cleared += 1;
      } catch (error) {
        rememberFailure(error, 'replay_apply', row.id);
        break;
      }
    }

    return { replayed: true, attempted, cleared };
  }

  function start() {
    if (!isEnabled()) return Promise.resolve(getStatus());
    installHook();
    if (!replayPromise) {
      replayPromise = Promise.resolve()
        .then(() => replayPending())
        .finally(() => { replayPromise = null; });
    }
    return replayPromise.then(() => getStatus());
  }

  function getStatus() {
    const { wal } = deps();
    return {
      installed: true,
      enabled: isEnabled(),
      hookInstalled,
      confirmationAttempts,
      confirmationsCleared,
      replayAttempts,
      replayCleared,
      failures,
      lastError,
      lastMutationId,
      walStatus: wal?.getStatus?.() || null
    };
  }

  const api = {
    __installedModule: true,
    DARK_MODE_KEY,
    installHook,
    replayPending,
    start,
    getStatus
  };

  global.TaskPointsStateRuntimeV2WalBridge = api;

  // Install immediately while the V2 runtime's deferred dark-mode hook is still pending.
  // This makes the eventual call order: V1 durable journal -> V2 WAL -> async V2 IndexedDB.
  if (isEnabled()) installHook();

  if (isEnabled()) {
    if (global.document?.readyState === 'loading') {
      global.document.addEventListener?.('DOMContentLoaded', () => start(), { once: true });
    } else if (typeof global.setTimeout === 'function') {
      global.setTimeout(() => start(), 0);
    } else {
      start();
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
