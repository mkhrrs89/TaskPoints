;(function installTaskPointsVerifiedSecondaryLogQuietGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__verifiedSecondaryLogQuietGuardInstalled) return;

  const REQUIRED_QUIET_MS = 8000;
  const POLL_MS = 250;
  const INSTALL_RETRY_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;
  let installAttempts = 0;
  let deferredRuns = 0;
  let releasedRuns = 0;
  const deferredByOperation = { phase5c: 0, phase2: 0, toolbar: 0 };
  const releasedByOperation = { phase5c: 0, phase2: 0, toolbar: 0 };

  function operationText(options) {
    if (typeof options === 'string') return options;
    if (!options || typeof options !== 'object') return '';
    return String(options.source || options.reason || options.action || options.caller || options.savePath || '');
  }

  function longMaintenanceKind(options) {
    const text = operationText(options);
    if (/phase5c_verified_secondary/i.test(text)) return 'phase5c';
    if (/phase2_dual_write_coalesced/i.test(text)) return 'phase2';
    if (/toolbar_background_maintenance/i.test(text)) return 'toolbar';
    return '';
  }

  function mark(name, detail) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function markDeferred(kind, detail) {
    mark('storage.logQuietGuardDeferred', { operation: kind, ...detail });
    if (kind === 'phase5c') mark('phase5c.logQuietGuardDeferred', detail);
    if (kind === 'phase2') mark('phase2.logQuietGuardDeferred', detail);
    if (kind === 'toolbar') mark('toolbar.logQuietGuardDeferred', detail);
  }

  function markReleased(kind, detail) {
    mark('storage.logQuietGuardReleased', { operation: kind, ...detail });
    if (kind === 'phase5c') mark('phase5c.logQuietGuardReleased', detail);
    if (kind === 'phase2') mark('phase2.logQuietGuardReleased', detail);
    if (kind === 'toolbar') mark('toolbar.logQuietGuardReleased', detail);
  }

  function statusReadyForLongMaintenance(status) {
    if (!status || typeof status !== 'object') return false;
    if (global.document?.visibilityState === 'hidden') return false;
    if (status.pageLeaving === true || status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
  }

  function install() {
    const original = core.whenStorageMaintenanceQuiet;
    if (typeof original !== 'function') {
      installAttempts += 1;
      if (installAttempts < MAX_INSTALL_ATTEMPTS) global.setTimeout?.(install, INSTALL_RETRY_MS);
      return false;
    }
    if (original.__taskpointsVerifiedSecondaryLogQuietGuard) {
      core.__verifiedSecondaryLogQuietGuardInstalled = true;
      return true;
    }

    const wrapped = function taskPointsVerifiedSecondaryLogQuietGuard(run, options = {}) {
      const kind = longMaintenanceKind(options);
      if (!kind) return original.call(this, run, options);
      if (typeof run !== 'function') return original.call(this, run, options);

      let markedDeferred = false;
      return new Promise((resolve, reject) => {
        const retry = () => {
          const idleStatus = core.getStorageMaintenanceIdleStatus?.();
          if (!statusReadyForLongMaintenance(idleStatus)) {
            if (!markedDeferred) {
              markedDeferred = true;
              deferredRuns += 1;
              deferredByOperation[kind] += 1;
              markDeferred(kind, {
                requiredQuietMs: REQUIRED_QUIET_MS,
                lastInteractionAgoMs: Number(idleStatus?.lastInteractionAgoMs || 0),
                navigationQuietForMs: Number(idleStatus?.navigationQuietForMs || 0)
              });
            }
            global.setTimeout?.(retry, POLL_MS);
            return;
          }

          releasedRuns += 1;
          releasedByOperation[kind] += 1;
          markReleased(kind, {
            requiredQuietMs: REQUIRED_QUIET_MS,
            lastInteractionAgoMs: Number(idleStatus?.lastInteractionAgoMs || 0)
          });
          Promise.resolve(original.call(this, run, options)).then(resolve, reject);
        };
        retry();
      });
    };

    Object.defineProperty(wrapped, '__taskpointsVerifiedSecondaryLogQuietGuard', { value: true });
    Object.defineProperty(wrapped, '__taskPointsOriginal', { value: original });
    core.whenStorageMaintenanceQuiet = wrapped;
    const getStatus = () => ({
      installed: true,
      requiredQuietMs: REQUIRED_QUIET_MS,
      pollMs: POLL_MS,
      guardedOperations: ['phase5c_verified_secondary', 'phase2_dual_write_coalesced', 'toolbar_background_maintenance'],
      deferredRuns,
      releasedRuns,
      deferredByOperation: { ...deferredByOperation },
      releasedByOperation: { ...releasedByOperation }
    });
    // Keep the original public status helper for compatibility while exposing
    // the broader meaning of the guard to diagnostics.
    core.getVerifiedSecondaryLogQuietGuardStatus = getStatus;
    core.getLogLongMaintenanceQuietGuardStatus = getStatus;
    core.__verifiedSecondaryLogQuietGuardInstalled = true;
    mark('phase5c.logQuietGuardInstalled', { requiredQuietMs: REQUIRED_QUIET_MS });
    mark('storage.logQuietGuardInstalled', {
      requiredQuietMs: REQUIRED_QUIET_MS,
      guardedOperations: ['phase5c', 'phase2', 'toolbar']
    });
    return true;
  }

  install();
})(typeof window !== 'undefined' ? window : globalThis);
