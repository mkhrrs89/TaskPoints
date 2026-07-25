(function installTaskPointsPhase4CacheGuard(global) {
  'use strict';
  const core = global.TaskPointsCore;
  if (!core || core.__phase4CacheGuardInstalled) return;
  core.__phase4CacheGuardInstalled = true;

  const RECOVERY_CHECK_MS = 250;
  const RECOVERY_SETTLE_MS = 350;
  const RECOVERY_MAX_CHECKS = 40;
  let recoveryTimer = null;
  let recoveryChecks = 0;
  let compactionRequested = false;
  let sawPendingJournal = false;

  function invalidate(reason = 'cache_invalidated') {
    try { core.clearPhase4Caches?.(); } catch (_) {}
    return reason;
  }

  function getMode() {
    try { return core.getPhase4StorageMode?.() || 'off'; } catch (_) { return 'off'; }
  }

  function getJournalCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; } catch (_) { return 1; }
  }

  function getStatus() {
    try { return core.getPhase4StorageStatus?.() || {}; } catch (_) { return {}; }
  }

  function hasDeferredGap(status = getStatus()) {
    return status.lastFallbackReason === 'pending_habit_journal'
      || (Number(status.latestQueuedSequence) || 0) > (Number(status.latestPassedSequence) || 0);
  }

  function requestJournalCompaction() {
    if (compactionRequested || getJournalCount() <= 0) return;
    if (typeof core.schedulePendingHabitDeltaCompaction !== 'function') return;
    let raw = null;
    try { raw = global.localStorage?.getItem?.(core.STORAGE_KEY) ?? null; } catch (_) { raw = null; }
    if (raw == null) return;
    try {
      const state = core.parseTaskPointsStorageJson?.(raw, {}) || {};
      compactionRequested = true;
      core.schedulePendingHabitDeltaCompaction(state, {
        storageKey: core.STORAGE_KEY,
        delayMs: 0
      });
    } catch (_) {
      compactionRequested = false;
    }
  }

  function stopRecovery() {
    if (recoveryTimer != null) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    recoveryChecks = 0;
    compactionRequested = false;
    sawPendingJournal = false;
  }

  function scheduleRecovery(delay = 100) {
    if (getMode() === 'off' || recoveryTimer != null) return;

    const check = () => {
      recoveryTimer = null;
      if (getMode() === 'off') { stopRecovery(); return; }

      const journalCount = getJournalCount();
      if (journalCount > 0) {
        sawPendingJournal = true;
        recoveryChecks += 1;
        requestJournalCompaction();
        if (recoveryChecks < RECOVERY_MAX_CHECKS) recoveryTimer = setTimeout(check, RECOVERY_CHECK_MS);
        return;
      }

      compactionRequested = false;
      const status = getStatus();
      if (!hasDeferredGap(status)) { stopRecovery(); return; }

      if (sawPendingJournal) {
        sawPendingJournal = false;
        recoveryTimer = setTimeout(check, RECOVERY_SETTLE_MS);
        return;
      }

      recoveryChecks += 1;
      const queued = core.queuePhase4PrimaryWrite?.({ reason: 'cross_page_habit_journal_recovery' });
      Promise.resolve(queued).finally(() => stopRecovery());
    };

    recoveryTimer = setTimeout(check, delay);
  }

  global.addEventListener?.('storage', (event) => {
    if (event?.storageArea && event.storageArea !== global.localStorage) return;
    if ([core.STORAGE_KEY, core.PENDING_HABIT_DELTAS_KEY, core.PHASE4_STORAGE_MODE_KEY].includes(event?.key)) {
      invalidate(event?.newValue == null ? 'storage_removed' : 'storage_changed');
      scheduleRecovery();
    }
  });
  global.addEventListener?.('pageshow', (event) => {
    if (event?.persisted) invalidate('bfcache_restore');
    scheduleRecovery();
  });

  core.invalidatePhase4PrimaryCache = invalidate;
  core.resumePhase4DeferredWrite = scheduleRecovery;
  scheduleRecovery();
})(typeof window !== 'undefined' ? window : globalThis);
