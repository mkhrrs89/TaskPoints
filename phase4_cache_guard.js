(function installTaskPointsPhase4CacheGuard(global) {
  'use strict';
  const core = global.TaskPointsCore;
  if (!core || core.__phase4CacheGuardInstalled) return;
  core.__phase4CacheGuardInstalled = true;

  function invalidate(reason = 'cache_invalidated') {
    try { core.clearPhase4Caches?.(); } catch (_) {}
    return reason;
  }

  global.addEventListener?.('storage', (event) => {
    if (event?.storageArea && event.storageArea !== global.localStorage) return;
    if ([core.STORAGE_KEY, core.PENDING_HABIT_DELTAS_KEY, core.PHASE4_STORAGE_MODE_KEY].includes(event?.key)) {
      invalidate(event?.newValue == null ? 'storage_removed' : 'storage_changed');
    }
  });
  global.addEventListener?.('pageshow', (event) => {
    if (event?.persisted) invalidate('bfcache_restore');
  });

  core.invalidatePhase4PrimaryCache = invalidate;
})(typeof window !== 'undefined' ? window : globalThis);
