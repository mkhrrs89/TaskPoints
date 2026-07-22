(function installTaskPointsPhase3StatusCacheGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase3StatusCacheGuardInstalled) return;
  if (typeof core.getPhase3ReadStatus !== 'function'
    || typeof core.getPhase3ReadMode !== 'function'
    || typeof core.clearPhase3ReadCache !== 'function'
    || !core.__phase3NavigationCacheInstalled) return;

  core.__phase3StatusCacheGuardInstalled = true;
  const originalGetStatus = core.getPhase3ReadStatus;

  core.getPhase3ReadStatus = function phase3GuardedGetStatus(options = {}) {
    if (core.getPhase3ReadMode() !== 'verified_indexeddb') {
      try { core.clearPhase3ReadCache(); } catch (_) {}
    }
    return originalGetStatus.call(core, options);
  };
})(typeof window !== 'undefined' ? window : globalThis);
