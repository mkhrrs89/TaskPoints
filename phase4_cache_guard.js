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
(function installTaskPointsIndexedDbRequalificationGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  if (!core || !storage || core.__indexedDbRequalificationGuardInstalled || typeof core.setPhase4StorageMode !== 'function') return;
  core.__indexedDbRequalificationGuardInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const DIAG_KEY = 'taskpoints_indexeddb_requalification_diagnostics_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
  const HABIT_JOURNAL_KEY = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const originalSetMode = core.setPhase4StorageMode.bind(core);

  const get = (key) => { try { return storage.getItem(key); } catch (_) { return null; } };
  const parse = (raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } };
  const rawHash = (raw) => {
    const text = String(raw || '');
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  };
  const journalCount = () => {
    const raw = get(HABIT_JOURNAL_KEY);
    if (!raw) return 0;
    const value = parse(raw, null);
    if (Array.isArray(value)) return value.length;
    if (Array.isArray(value?.operations)) return value.operations.length;
    return value && typeof value === 'object' ? Object.keys(value).length : 1;
  };
  const writeDiagnostic = (patch) => {
    const previous = parse(get(DIAG_KEY), {}) || {};
    try {
      storage.setItem(DIAG_KEY, JSON.stringify({ schemaVersion: 1, ...previous, ...patch }));
    } catch (_) {}
  };

  function permission(mode) {
    const requested = String(mode || 'off');
    if (requested === 'off') return { allowed: true, reason: '' };
    if (get(HOLD_KEY)) return { allowed: false, reason: 'recovery_hold_active' };
    if (get(ATTEMPT_LOCK_KEY)) return { allowed: false, reason: 'recovery_attempt_active' };
    if (journalCount() > 0) return { allowed: false, reason: 'habit_changes_waiting_to_save' };
    if (get(LEGACY_JOURNAL_KEY)) return { allowed: false, reason: 'older_recovery_changes_waiting' };
    const raw = get(STORAGE_KEY);
    if (!raw) return { allowed: false, reason: 'current_save_missing' };
    const gate = parse(get(GATE_KEY), {}) || {};
    const status = String(gate.status || '');
    const currentHash = rawHash(raw);
    const configuredMode = get(MODE_KEY) || 'off';

    if (requested === 'verify_primary_writes') {
      const allowedStatuses = new Set(['authorizing_test_mode', 'awaiting_smoke_test', 'ready_for_fast_mode', 'fast_mode_enabled']);
      if (!allowedStatuses.has(status)) return { allowed: false, reason: 'safety_check_not_started' };
      if (status === 'authorizing_test_mode' && gate.authorizedRawHash !== currentHash) {
        return { allowed: false, reason: 'current_save_changed_before_test' };
      }
      return { allowed: true, reason: '', gate, currentHash };
    }

    if (requested === 'indexeddb_primary') {
      if (status === 'fast_mode_enabled') {
        if (configuredMode === 'indexeddb_primary') return { allowed: true, reason: '', gate, currentHash };
        return { allowed: false, reason: 'fresh_reauthorization_required' };
      }
      if (status !== 'ready_for_fast_mode') return { allowed: false, reason: 'short_test_not_finished' };
      if (configuredMode !== 'verify_primary_writes') return { allowed: false, reason: 'storage_mode_changed_before_enable' };
      if (gate.lastVerifiedRawHash !== currentHash) return { allowed: false, reason: 'current_save_changed_after_final_check' };
      return { allowed: true, reason: '', gate, currentHash };
    }

    return { allowed: false, reason: 'unknown_storage_mode' };
  }

  core.getIndexedDbRequalificationPermission = permission;
  core.getIndexedDbRequalificationStatus = () => ({
    gate: parse(get(GATE_KEY), {}) || {},
    configuredMode: get(MODE_KEY) || 'off',
    recoveryHoldActive: Boolean(get(HOLD_KEY)),
    recoveryAttemptActive: Boolean(get(ATTEMPT_LOCK_KEY)),
    pendingHabitChanges: journalCount(),
    legacyChangesPresent: Boolean(get(LEGACY_JOURNAL_KEY))
  });

  core.setPhase4StorageMode = function guardedPhase4StorageMode(mode) {
    const requested = String(mode || 'off');
    const decision = permission(requested);
    if (!decision.allowed) {
      const result = originalSetMode('off');
      writeDiagnostic({
        lastBlockedAtISO: new Date().toISOString(),
        requestedMode: requested,
        blockedReason: decision.reason,
        resultingMode: result
      });
      return result;
    }
    const result = originalSetMode(requested);
    writeDiagnostic({
      lastAllowedAtISO: new Date().toISOString(),
      requestedMode: requested,
      blockedReason: null,
      resultingMode: result
    });
    return result;
  };

  const currentMode = core.getPhase4StorageMode?.() || get(MODE_KEY) || 'off';
  if (currentMode !== 'off' && !permission(currentMode).allowed) originalSetMode('off');
})(typeof window !== 'undefined' ? window : globalThis);
(function installTaskPointsIndexedDbRestartWitness(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const storage = global.localStorage;
  const session = global.sessionStorage;
  if (!core || !storage || !session || core.__indexedDbRestartWitnessInstalled) return;
  core.__indexedDbRestartWitnessInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const SESSION_KEY = 'taskpoints_indexeddb_browser_session_v1';
  const PAGE_LOCK_NAME = 'taskpoints_active_page_v1';
  const HABIT_JOURNAL_KEY = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const EXCLUDED_PAGES = new Set([
    'indexeddb_requalification.html',
    'phase4_storage_status.html',
    'storage_health.html',
    'verified_secondary_recovery.html',
    'verified_secondary_restore.html',
    'emergency_recovery.html',
    'dual_write_status.html',
    'phase3_read_status.html',
    'settings.html',
    'storage_diagnostics.html'
  ]);

  const parse = (raw, fallback = null) => { try { return JSON.parse(raw); } catch (_) { return fallback; } };
  const get = (key) => { try { return storage.getItem(key); } catch (_) { return null; } };
  const journalCount = (key) => {
    const raw = get(key);
    if (!raw) return 0;
    const value = parse(raw, null);
    if (Array.isArray(value)) return value.length;
    if (Array.isArray(value?.operations)) return value.operations.length;
    return value && typeof value === 'object' ? Object.keys(value).length : 1;
  };
  const hash = (raw) => {
    const text = String(raw || '');
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
  };
  const makeId = () => global.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let sessionId = '';
  let sessionWasNew = false;
  let sessionStorageAvailable = true;
  try {
    sessionId = session.getItem(SESSION_KEY) || '';
    if (!sessionId) {
      sessionWasNew = true;
      sessionId = makeId();
      session.setItem(SESSION_KEY, sessionId);
    }
  } catch (_) {
    sessionStorageAvailable = false;
  }

  const locks = global.navigator?.locks;
  const lockSupported = Boolean(locks && typeof locks.request === 'function');
  let sharedLockRequested = false;
  function holdSharedPageLock() {
    if (!lockSupported || sharedLockRequested) return;
    sharedLockRequested = true;
    Promise.resolve(locks.request(PAGE_LOCK_NAME, { mode: 'shared' }, async (lock) => {
      if (!lock) return;
      await new Promise(() => {});
    })).catch(() => undefined);
  }

  core.getIndexedDbBrowserSessionStatus = () => ({
    sessionId,
    sessionWasNew,
    sessionStorageAvailable,
    lockSupported
  });

  const pageName = String(global.location?.pathname || '').split('/').pop() || 'index.html';
  const navigationType = global.performance?.getEntriesByType?.('navigation')?.[0]?.type || '';
  const canAttemptWitness = Boolean(
    sessionStorageAvailable
    && lockSupported
    && sessionWasNew
    && !EXCLUDED_PAGES.has(pageName)
    && navigationType !== 'reload'
  );
  if (!canAttemptWitness) {
    holdSharedPageLock();
    return;
  }

  async function attemptWitness(attempt = 0) {
    const gate = parse(get(GATE_KEY), {}) || {};
    if (gate.status !== 'awaiting_smoke_test'
      || !gate.preparedBrowserSessionId
      || gate.preparedBrowserSessionId === sessionId
      || (get(MODE_KEY) || 'off') !== 'verify_primary_writes'
      || journalCount(HABIT_JOURNAL_KEY) > 0
      || get(LEGACY_JOURNAL_KEY)
      || !get(STORAGE_KEY)) {
      holdSharedPageLock();
      return;
    }

    let shouldRetry = false;
    const outcome = await locks.request(PAGE_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return { exclusive: false, recorded: false };
      const lockedGate = parse(get(GATE_KEY), {}) || {};
      const currentRaw = get(STORAGE_KEY);
      if (lockedGate.status !== 'awaiting_smoke_test'
        || lockedGate.preparedBrowserSessionId !== gate.preparedBrowserSessionId
        || lockedGate.preparedBrowserSessionId === sessionId
        || lockedGate.freshAppSessionId
        || (get(MODE_KEY) || 'off') !== 'verify_primary_writes'
        || journalCount(HABIT_JOURNAL_KEY) > 0
        || get(LEGACY_JOURNAL_KEY)
        || !currentRaw) {
        return { exclusive: true, recorded: false };
      }

      const result = await core.restorePhase4CommittedPrimary?.();
      if (result?.restored !== true) return { exclusive: true, recorded: false, retry: true };
      const latestGate = parse(get(GATE_KEY), {}) || {};
      const latestRaw = get(STORAGE_KEY);
      if (latestGate.status !== 'awaiting_smoke_test'
        || latestGate.preparedBrowserSessionId !== gate.preparedBrowserSessionId
        || latestGate.freshAppSessionId
        || !latestRaw
        || latestRaw !== currentRaw) {
        return { exclusive: true, recorded: false };
      }
      storage.setItem(GATE_KEY, JSON.stringify({
        ...latestGate,
        freshAppSessionId: sessionId,
        freshAppStartedAtISO: new Date().toISOString(),
        freshAppRawHash: hash(latestRaw),
        freshAppPage: pageName,
        exclusivePageLockConfirmed: true
      }));
      return { exclusive: true, recorded: true };
    });

    shouldRetry = Boolean((!outcome?.exclusive || outcome?.retry) && attempt < 11);
    if (shouldRetry) {
      setTimeout(() => attemptWitness(attempt + 1).catch(() => holdSharedPageLock()), 350);
      return;
    }
    holdSharedPageLock();
  }

  setTimeout(() => attemptWitness().catch(() => holdSharedPageLock()), 250);
})(typeof window !== 'undefined' ? window : globalThis);