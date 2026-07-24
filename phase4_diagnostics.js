(function installTaskPointsPhase4Diagnostics(global) {
  'use strict';
  const core = global.TaskPointsCore;
  if (!core || core.__phase4DiagnosticsInstalled) return;
  core.__phase4DiagnosticsInstalled = true;

  const originalStatus = core.getPhase4StorageStatus;
  core.getPhase4StorageStatus = function phase4StorageStatus(options = {}) {
    const status = typeof originalStatus === 'function' ? originalStatus.call(core, options) : {};
    return {
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      configuredMode: core.getPhase4StorageMode?.() || 'off',
      effectiveSource: 'localStorage',
      latestQueuedSequence: 0,
      latestPassedSequence: 0,
      pendingWrites: Number(core.getPendingPhase4WriteCount?.()) || 0,
      lastFallbackReason: null,
      cacheReadyThisPage: Boolean(core.getPhase4VerifiedPrimaryCache?.()),
      ...status
    };
  };
  core.refreshPhase4StorageStatus = async function refreshPhase4StorageStatus() {
    return core.getPhase4StorageStatus({ refresh: true });
  };
})(typeof window !== 'undefined' ? window : globalThis);
