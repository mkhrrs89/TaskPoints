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

  function operationText(options) {
    if (typeof options === 'string') return options;
    if (!options || typeof options !== 'object') return '';
    return String(options.source || options.reason || options.action || options.caller || options.savePath || '');
  }

  function isVerifiedSecondaryRequest(options) {
    return /phase5c_verified_secondary/i.test(operationText(options));
  }

  function mark(name, detail) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
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
      if (!isVerifiedSecondaryRequest(options)) return original.call(this, run, options);
      if (typeof run !== 'function') return original.call(this, run, options);

      let markedDeferred = false;
      return new Promise((resolve, reject) => {
        const retry = () => {
          const idleStatus = core.getStorageMaintenanceIdleStatus?.();
          if (!statusReadyForLongMaintenance(idleStatus)) {
            if (!markedDeferred) {
              markedDeferred = true;
              deferredRuns += 1;
              mark('phase5c.logQuietGuardDeferred', {
                requiredQuietMs: REQUIRED_QUIET_MS,
                lastInteractionAgoMs: Number(idleStatus?.lastInteractionAgoMs || 0),
                navigationQuietForMs: Number(idleStatus?.navigationQuietForMs || 0)
              });
            }
            global.setTimeout?.(retry, POLL_MS);
            return;
          }

          releasedRuns += 1;
          mark('phase5c.logQuietGuardReleased', {
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
    core.getVerifiedSecondaryLogQuietGuardStatus = () => ({
      installed: true,
      requiredQuietMs: REQUIRED_QUIET_MS,
      pollMs: POLL_MS,
      deferredRuns,
      releasedRuns
    });
    core.__verifiedSecondaryLogQuietGuardInstalled = true;
    mark('phase5c.logQuietGuardInstalled', { requiredQuietMs: REQUIRED_QUIET_MS });
    return true;
  }

  install();
})(typeof window !== 'undefined' ? window : globalThis);
