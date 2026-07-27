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

    if (requested === 'verify_primary_writes') {
      const allowedStatuses = new Set(['authorizing_test_mode', 'awaiting_smoke_test', 'ready_for_fast_mode', 'fast_mode_enabled']);
      if (!allowedStatuses.has(status)) return { allowed: false, reason: 'safety_check_not_started' };
      if (status === 'authorizing_test_mode' && gate.authorizedRawHash !== currentHash) {
        return { allowed: false, reason: 'current_save_changed_before_test' };
      }
      return { allowed: true, reason: '', gate, currentHash };
    }

    if (requested === 'indexeddb_primary') {
      if (status === 'fast_mode_enabled') return { allowed: true, reason: '', gate, currentHash };
      if (status !== 'ready_for_fast_mode') return { allowed: false, reason: 'short_test_not_finished' };
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
