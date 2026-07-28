(function keepTaskPointsRequalificationChecksReadOnly(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!core || !document || core.__indexedDbRequalificationReadOnlyGuardInstalled) return;
  core.__indexedDbRequalificationReadOnlyGuardInstalled = true;

  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const flushNames = [
    'flushPhase5CVerifiedSecondaryWrites',
    'flushPhase4PrimaryWrites',
    'flushPhase5ANativeSnapshotWrites'
  ];
  const originals = new Map();
  const scopedButtons = [];
  let permittedCalls = 0;
  let activeActionToken = '';
  let permissionTimer = null;
  let activationWasAccepted = false;

  const get = (key) => { try { return global.localStorage?.getItem?.(key) ?? null; } catch (_) { return null; } };
  const parse = (raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } };

  function configuredMode() {
    try { return core.getPhase4StorageMode?.() || get(MODE_KEY) || 'off'; }
    catch (_) { return get(MODE_KEY) || 'off'; }
  }

  const originalSetMode = typeof core.setPhase4StorageMode === 'function'
    ? core.setPhase4StorageMode.bind(core)
    : null;

  if (originalSetMode) {
    core.setPhase4StorageMode = function preserveExplicitOffDuringActivationRollback(mode) {
      const requested = String(mode || 'off');
      const beforeMode = configuredMode();
      const gateStatus = String((parse(get(GATE_KEY), {}) || {}).status || '');

      if (requested === 'verify_primary_writes'
        && activationWasAccepted
        && beforeMode === 'off'
        && gateStatus === 'ready_for_fast_mode') {
        activationWasAccepted = false;
        return 'off';
      }

      const result = originalSetMode(requested);
      if (requested === 'indexeddb_primary') {
        activationWasAccepted = result === 'indexeddb_primary';
      } else if (requested === 'off' || (requested === 'verify_primary_writes' && result === 'verify_primary_writes')) {
        activationWasAccepted = false;
      }
      return result;
    };
  }

  function revokeExplicitAction(token = '') {
    if (token && token !== activeActionToken) return false;
    permittedCalls = 0;
    activeActionToken = '';
    if (permissionTimer != null) clearTimeout(permissionTimer);
    permissionTimer = null;
    return true;
  }

  function beginExplicitAction(actionId) {
    revokeExplicitAction();
    activeActionToken = `${String(actionId || 'action')}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    permittedCalls = originals.size;
    const token = activeActionToken;
    permissionTimer = setTimeout(() => revokeExplicitAction(token), 30000);
    return token;
  }

  flushNames.forEach((name) => {
    const original = core[name];
    if (typeof original !== 'function') return;
    originals.set(name, original);
    core[name] = function guardedExplicitFlush(...args) {
      if (!activeActionToken || permittedCalls <= 0) return Promise.resolve(false);
      permittedCalls -= 1;
      return original.apply(core, args);
    };
  });

  function scopeNextRuntimeClickListener(buttonId) {
    const button = document.getElementById(buttonId);
    const originalAddEventListener = button?.addEventListener;
    if (!button || typeof originalAddEventListener !== 'function') return false;
    let intercepted = false;

    function scopedAddEventListener(type, listener, options) {
      if (!intercepted && type === 'click' && listener) {
        intercepted = true;
        try { button.addEventListener = originalAddEventListener; } catch (_) {}
        const wrappedListener = function runExplicitActionInReadOnlyScope(...args) {
          const token = beginExplicitAction(buttonId);
          let result;
          try {
            result = typeof listener === 'function'
              ? listener.apply(this, args)
              : listener.handleEvent.apply(listener, args);
          } catch (error) {
            revokeExplicitAction(token);
            throw error;
          }
          return Promise.resolve(result).finally(() => revokeExplicitAction(token));
        };
        return originalAddEventListener.call(button, type, wrappedListener, options);
      }
      return originalAddEventListener.call(button, type, listener, options);
    }

    try {
      button.addEventListener = scopedAddEventListener;
      return button.addEventListener === scopedAddEventListener;
    } catch (_) {
      return false;
    }
  }

  ['startTestBtn', 'finishTestBtn'].forEach((buttonId) => {
    if (scopeNextRuntimeClickListener(buttonId)) scopedButtons.push(buttonId);
  });

  core.revokeIndexedDbRequalificationExplicitAction = revokeExplicitAction;
  core.getIndexedDbRequalificationReadOnlyStatus = () => ({
    installed: true,
    protectedFlushes: [...originals.keys()],
    scopedActionListeners: [...scopedButtons],
    actionActive: Boolean(activeActionToken),
    explicitCallsRemaining: permittedCalls,
    activationRollbackProtected: Boolean(originalSetMode)
  });
})(typeof window !== 'undefined' ? window : globalThis);
