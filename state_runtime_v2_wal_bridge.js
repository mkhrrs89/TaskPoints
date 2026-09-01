(function installTaskPointsStateRuntimeV2WalBridge(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2WalBridge?.__installedModule) return;

  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  let hookInstalled = false;
  let resetBoundaryHookInstalled = false;
  let replacementHooksInstalled = false;
  let generationSubscriptionInstalled = false;
  let originalWritePendingHabitDelta = null;
  let confirmationAttempts = 0;
  let confirmationsCleared = 0;
  let replayAttempts = 0;
  let replayCleared = 0;
  let staleRowsPreserved = 0;
  let generationSynchronizations = 0;
  let failures = 0;
  let lastError = null;
  let lastMutationId = null;
  let replayPromise = null;
  let generationSyncTail = Promise.resolve();
  let resetCheckPending = false;
  let replacementCallDepth = 0;

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
      wal: global.TaskPointsStateRuntimeV2Wal || null,
      generation: global.TaskPointsStateRuntimeV2Generation || null
    };
  }

  function rememberFailure(error, phase, mutationId = null) {
    failures += 1;
    lastError = String(error?.message || error || 'unknown');
    mark('stateV2.walBridgeFailed', { phase, mutationId, message: lastError });
  }

  function ensureGeneration() {
    const { generation } = deps();
    const result = generation?.ensure?.();
    return result?.generation || generation?.read?.() || null;
  }

  function currentGeneration() {
    const { generation } = deps();
    return generation?.read?.() || null;
  }

  function scheduleGenerationSync(reason = 'generation-change') {
    const { runtime } = deps();
    if (!runtime?.seedFromLegacy) return generationSyncTail;
    generationSyncTail = generationSyncTail
      .then(async () => {
        generationSynchronizations += 1;
        await runtime.seedFromLegacy({ force: true });
        mark('stateV2.generationSynchronized', { reason, generation: currentGeneration() });
      })
      .catch((error) => {
        rememberFailure(error, 'generation_sync');
      });
    return generationSyncTail;
  }

  function installGenerationSubscription() {
    if (!isEnabled()) return false;
    if (generationSubscriptionInstalled) return true;
    const { generation } = deps();
    if (typeof generation?.subscribe !== 'function') return false;
    generation.subscribe((event) => {
      scheduleGenerationSync(event?.reason || 'generation-change');
    });
    generationSubscriptionInstalled = true;
    return true;
  }

  function scheduleResetGenerationCheck(storageKey) {
    if (resetCheckPending) return;
    resetCheckPending = true;
    const run = () => {
      resetCheckPending = false;
      try {
        const { generation } = deps();
        if (!isEnabled() || !generation?.rotate) return;
        if (global.localStorage?.getItem?.(storageKey) === null) {
          generation.rotate('reset-all');
          mark('stateV2.resetGenerationRotated', { storageKey });
        }
      } catch (error) {
        rememberFailure(error, 'reset_generation');
      }
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(run);
    else Promise.resolve().then(run);
  }

  function installResetBoundaryHook() {
    if (!isEnabled()) return false;
    if (resetBoundaryHookInstalled) return true;
    const { core } = deps();
    const storage = global.localStorage;
    const storageKey = core?.STORAGE_KEY || 'taskpoints_v1';
    if (!storage?.removeItem) return false;

    const StorageCtor = global.Storage;
    if (StorageCtor?.prototype?.removeItem) {
      const prototype = StorageCtor.prototype;
      if (!prototype.__taskPointsV2GenerationOriginalRemoveItem) {
        const original = prototype.removeItem;
        Object.defineProperty(prototype, '__taskPointsV2GenerationOriginalRemoveItem', {
          value: original,
          configurable: true
        });
        prototype.removeItem = function taskPointsV2GenerationRemoveItem(key) {
          const normalizedKey = String(key);
          const matched = this === storage && normalizedKey === storageKey;
          const result = original.call(this, normalizedKey);
          if (matched) scheduleResetGenerationCheck(normalizedKey);
          return result;
        };
      }
    } else {
      const original = storage.removeItem.bind(storage);
      storage.removeItem = function taskPointsV2GenerationRemoveItem(key) {
        const normalizedKey = String(key);
        const result = original(normalizedKey);
        if (normalizedKey === storageKey) scheduleResetGenerationCheck(normalizedKey);
        return result;
      };
    }

    resetBoundaryHookInstalled = true;
    return true;
  }

  function replacementReason(options = {}) {
    if (options?.allowDestructiveOverwrite !== true) return '';
    const source = String(options?.source || '');
    if (!/(^|[-_])(import|restore|recovery)([-_]|$)/i.test(source)) return '';
    return source || 'authorized-replacement';
  }

  function rotateAfterReplacement(reason) {
    const { generation } = deps();
    if (!isEnabled() || !generation?.rotate || !reason) return null;
    const result = generation.rotate(reason);
    mark('stateV2.replacementGenerationRotated', { reason, generation: result?.generation || null });
    return result;
  }

  function wrapSnapshotReplacement(core, methodName) {
    const original = core?.[methodName];
    if (typeof original !== 'function' || original.__taskPointsV2GenerationWrapped) return false;

    function wrappedSnapshotReplacement() {
      const options = arguments[1] || {};
      const reason = replacementReason(options);
      replacementCallDepth += 1;
      let result;
      let succeeded = false;
      try {
        result = original.apply(this, arguments);
        succeeded = true;
        return result;
      } finally {
        replacementCallDepth = Math.max(0, replacementCallDepth - 1);
        if (succeeded && reason && replacementCallDepth === 0) rotateAfterReplacement(reason);
      }
    }
    Object.defineProperty(wrappedSnapshotReplacement, '__taskPointsV2GenerationWrapped', { value: true });
    core[methodName] = wrappedSnapshotReplacement;
    return true;
  }

  function wrapEmergencyRecoveryReplacement(core) {
    const original = core?.safeReplaceTaskPointsStorage;
    if (typeof original !== 'function' || original.__taskPointsV2GenerationWrapped) return false;

    function wrappedSafeReplaceTaskPointsStorage(storageKey, serializedCandidate) {
      const result = original.apply(this, arguments);
      try {
        const pathname = String(global.location?.pathname || '');
        const authoritativeKey = core.STORAGE_KEY || 'taskpoints_v1';
        if (
          isEnabled()
          && /(^|\/)emergency_recovery(?:\.html)?$/i.test(pathname)
          && String(storageKey) === String(authoritativeKey)
          && global.localStorage?.getItem?.(authoritativeKey) === String(serializedCandidate)
        ) {
          rotateAfterReplacement('emergency-recovery');
        }
      } catch (error) {
        rememberFailure(error, 'emergency_recovery_generation');
      }
      return result;
    }
    Object.defineProperty(wrappedSafeReplaceTaskPointsStorage, '__taskPointsV2GenerationWrapped', { value: true });
    core.safeReplaceTaskPointsStorage = wrappedSafeReplaceTaskPointsStorage;
    return true;
  }

  function installReplacementHooks() {
    if (!isEnabled()) return false;
    if (replacementHooksInstalled) return true;
    const { core } = deps();
    if (!core) return false;
    wrapSnapshotReplacement(core, 'saveValidatedSnapshot');
    wrapSnapshotReplacement(core, 'saveStateSnapshot');
    wrapEmergencyRecoveryReplacement(core);
    replacementHooksInstalled = true;
    return true;
  }

  async function verifyAndClear(delta, mutationId, phase = 'confirm', expectedGeneration = null) {
    const { runtime, wal } = deps();
    if (!runtime?.applyHabitDelta || !wal?.removeMutation || !wal?.mutationIdForDelta) {
      throw new Error('state_runtime_v2_wal_bridge_dependencies_unavailable');
    }

    const generation = String(expectedGeneration || '');
    if (!generation) throw new Error(`state_runtime_v2_wal_generation_missing:${String(mutationId)}`);
    const durableGeneration = currentGeneration();
    if (!durableGeneration || String(durableGeneration) !== generation) {
      return { cleared: false, stale: true, reason: 'stale_generation', expectedGeneration: generation, currentGeneration: durableGeneration };
    }

    const expectedMutationId = wal.mutationIdForDelta(delta, generation);
    if (expectedMutationId !== String(mutationId)) {
      throw new Error(`state_runtime_v2_wal_identity_mismatch:${String(mutationId)}`);
    }

    const result = await runtime.applyHabitDelta(delta, { expectedGeneration: generation });
    if (result?.committed !== true && result?.duplicate !== true) {
      return { cleared: false, reason: result?.reason || 'mutation_not_verified', result };
    }

    if (String(currentGeneration() || '') !== generation) {
      return { cleared: false, stale: true, reason: 'generation_changed_after_commit', result };
    }

    const removal = wal.removeMutation(mutationId);
    if (removal?.removed === true || removal?.reason === 'not_found') {
      lastMutationId = mutationId;
      if (phase === 'replay') replayCleared += 1;
      else confirmationsCleared += 1;
      mark('stateV2.walBridgeCleared', { phase, mutationId, generation, duplicate: result?.duplicate === true });
      return { cleared: true, mutationId, generation, result, removal };
    }

    return { cleared: false, reason: removal?.reason || 'wal_cleanup_unverified', result, removal };
  }

  function scheduleConfirmation(delta, mutationId, generation) {
    const run = async () => {
      confirmationAttempts += 1;
      try {
        await verifyAndClear(delta, mutationId, 'confirm', generation);
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
          scheduleConfirmation(appended?.row?.delta || durableDelta, appended.mutationId, appended?.row?.generation || appended.generation);
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
    if (!isEnabled()) return { replayed: false, reason: 'dark_disabled', attempted: 0, cleared: 0, stale: 0 };
    const { wal } = deps();
    if (!wal?.getPendingRows) return { replayed: false, reason: 'wal_unavailable', attempted: 0, cleared: 0, stale: 0 };

    const pending = wal.getPendingRows();
    if (!pending?.ok) {
      rememberFailure(new Error(pending?.error || 'state_runtime_v2_wal_unreadable'), 'replay_read');
      return { replayed: false, reason: 'wal_unreadable', attempted: 0, cleared: 0, stale: 0 };
    }

    const durableGeneration = currentGeneration() || ensureGeneration();
    let attempted = 0;
    let cleared = 0;
    let stale = 0;
    for (const row of pending.rows || []) {
      if (row?.type !== 'habit-completion-set' || !row?.id || !row?.delta) {
        rememberFailure(new Error('state_runtime_v2_wal_replay_invalid_row'), 'replay_row', row?.id || null);
        break;
      }

      if (!row.generation || String(row.generation) !== String(durableGeneration)) {
        stale += 1;
        staleRowsPreserved += 1;
        mark('stateV2.walStalePreserved', { mutationId: row.id, rowGeneration: row.generation || null, currentGeneration: durableGeneration });
        continue;
      }

      attempted += 1;
      replayAttempts += 1;
      try {
        const result = await verifyAndClear(row.delta, row.id, 'replay', row.generation);
        if (result?.stale) {
          stale += 1;
          staleRowsPreserved += 1;
          continue;
        }
        if (!result?.cleared) break;
        cleared += 1;
      } catch (error) {
        rememberFailure(error, 'replay_apply', row.id);
        break;
      }
    }

    return { replayed: true, attempted, cleared, stale };
  }

  function installGenerationHooks() {
    if (!isEnabled()) return false;
    ensureGeneration();
    installGenerationSubscription();
    installResetBoundaryHook();
    installReplacementHooks();
    return true;
  }

  function start() {
    if (!isEnabled()) return Promise.resolve(getStatus());
    installGenerationHooks();
    installHook();
    if (!replayPromise) {
      replayPromise = Promise.resolve()
        .then(() => scheduleGenerationSync('startup'))
        .then(() => replayPending())
        .finally(() => { replayPromise = null; });
    }
    return replayPromise.then(() => getStatus());
  }

  function getStatus() {
    const { wal, generation } = deps();
    return {
      installed: true,
      enabled: isEnabled(),
      hookInstalled,
      resetBoundaryHookInstalled,
      replacementHooksInstalled,
      generationSubscriptionInstalled,
      confirmationAttempts,
      confirmationsCleared,
      replayAttempts,
      replayCleared,
      staleRowsPreserved,
      generationSynchronizations,
      failures,
      lastError,
      lastMutationId,
      generationStatus: generation?.getStatus?.() || null,
      walStatus: wal?.getStatus?.() || null
    };
  }

  const api = {
    __installedModule: true,
    DARK_MODE_KEY,
    installHook,
    installGenerationHooks,
    replayPending,
    start,
    getStatus
  };

  global.TaskPointsStateRuntimeV2WalBridge = api;

  // Install immediately while the V2 runtime's deferred dark-mode hook is still pending.
  // This makes the eventual call order: V1 durable journal -> V2 WAL -> async V2 IndexedDB.
  if (isEnabled()) {
    installGenerationHooks();
    installHook();
  }

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
