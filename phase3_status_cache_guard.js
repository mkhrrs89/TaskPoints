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
  const modeKey = core.PHASE3_READ_MODE_KEY || 'taskpoints_phase3_read_mode_v1';

  function clearBothCacheLayers() {
    try { core.clearPhase3ReadCache(); } catch (_) {}
  }

  core.getPhase3ReadStatus = function phase3GuardedGetStatus(options = {}) {
    if (core.getPhase3ReadMode() !== 'verified_indexeddb') clearBothCacheLayers();
    return originalGetStatus.call(core, options);
  };

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', (event) => {
      if (event?.storageArea && event.storageArea !== global.localStorage) return;
      if (event?.key === modeKey) clearBothCacheLayers();
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
