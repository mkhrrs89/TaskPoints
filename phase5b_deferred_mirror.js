(function installTaskPointsPhase5BKillSwitch(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core) return;

  core.PHASE5B_LIVE_BUNDLE_DISABLED = true;
  core.__phase5bDeferredMirrorInstalled = false;
  core.getPhase5BStatus = () => ({
    enabled: false,
    installed: false,
    disabledForSafety: true,
    reason: 'phase5b_disabled_after_empty_state_overwrite',
    journalPresent: Boolean(global.localStorage?.getItem?.('taskpoints_phase5b_pending_changes_v1'))
  });
  core.flushPhase5BNativeWrites = () => Promise.resolve();
  core.flushPhase5BMirrorCheckpoint = () => false;

  // The real guard is installed earlier from phase2_reset_hook.js. This late
  // compatibility slot must never reactivate deferred saves. If the early guard
  // is unexpectedly absent, fail closed by keeping IndexedDB Primary disabled.
  if (!core.__storageDataLossGuardInstalled) {
    try { global.localStorage?.setItem?.('taskpoints_phase4_storage_mode_v1', 'off'); } catch (_) {}
    console.error('TaskPoints storage data-loss guard was not installed; IndexedDB Primary remains disabled.');
  }
})(typeof window !== 'undefined' ? window : globalThis);
