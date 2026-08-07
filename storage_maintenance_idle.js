(function installTaskPointsStorageMaintenanceIdle(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__storageMaintenanceIdleInstalled) return;
  core.__storageMaintenanceIdleInstalled = true;

  const QUIET_MS = 1400;
  const POLL_MS = 180;
  let lastInteractionAt = 0;
  let deferredCalls = 0;
  let executedCalls = 0;

  const now = () => global.performance?.now?.() ?? Date.now();
  const markInteraction = () => { lastInteractionAt = now(); };

  function activeEditor() {
    const element = global.document?.activeElement;
    if (!element) return false;
    const tag = String(element.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
  }

  function quietEnough() {
    if (global.document?.visibilityState === 'hidden') return true;
    if (activeEditor()) return false;
    return now() - lastInteractionAt >= QUIET_MS;
  }

  function explicitOperation(args) {
    const first = args?.[0];
    const text = typeof first === 'string'
      ? first
      : first && typeof first === 'object'
        ? String(first.reason || first.source || first.action || first.caller || '')
        : '';
    return /(manual|recovery|import|reset|smoke|test|explicit|user_requested)/i.test(text);
  }

  function whenQuiet(run) {
    if (quietEnough()) return Promise.resolve().then(run);
    deferredCalls += 1;
    return new Promise((resolve, reject) => {
      const retry = () => {
        if (!quietEnough()) {
          global.setTimeout?.(retry, POLL_MS);
          return;
        }
        Promise.resolve()
          .then(run)
          .then(resolve, reject);
      };
      global.setTimeout?.(retry, POLL_MS);
    });
  }

  function wrapAsyncMaintenance(name) {
    const original = core[name];
    if (typeof original !== 'function' || original.__taskpointsIdleMaintenanceWrapped) return;
    const wrapped = function taskPointsIdleMaintenanceWrapper(...args) {
      if (explicitOperation(args)) return original.apply(this, args);
      return whenQuiet(() => {
        executedCalls += 1;
        return original.apply(this, args);
      });
    };
    Object.defineProperty(wrapped, '__taskpointsIdleMaintenanceWrapped', { value: true });
    core[name] = wrapped;
  }

  // These are cache/requalification maintenance operations. Authoritative
  // localStorage saves are not wrapped and remain synchronous as before.
  [
    'restorePhase4CommittedPrimary',
    'queuePhase4PrimaryWrite',
    'readPhase3ShadowSnapshot',
    'refreshPhase3ReadCache'
  ].forEach(wrapAsyncMaintenance);

  const events = ['pointerdown', 'touchstart', 'keydown', 'beforeinput', 'input', 'focusin', 'click'];
  events.forEach((name) => global.document?.addEventListener?.(name, markInteraction, { capture: true, passive: true }));

  core.noteStorageUserInteraction = markInteraction;
  core.getStorageMaintenanceIdleStatus = () => ({
    installed: true,
    quietMs: QUIET_MS,
    lastInteractionAgoMs: Math.max(0, Math.round(now() - lastInteractionAt)),
    activeEditor: activeEditor(),
    deferredCalls,
    executedCalls
  });
})(typeof window !== 'undefined' ? window : globalThis);
