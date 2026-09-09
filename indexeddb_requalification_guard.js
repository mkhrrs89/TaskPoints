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
    if (get(LEGACY_JOURNAL_KEY)) return { allowed: false, reason: 'older_recovery_changes_waiting' };
    const raw = get(STORAGE_KEY);
    if (!raw) return { allowed: false, reason: 'current_save_missing' };
    const gate = parse(get(GATE_KEY), {}) || {};
    const status = String(gate.status || '');
    const currentHash = rawHash(raw);
    const configuredMode = get(MODE_KEY) || 'off';
    const keepingCompletedFastMode = requested === 'indexeddb_primary'
      && status === 'fast_mode_enabled'
      && configuredMode === 'indexeddb_primary';
    const keepingActiveShortTest = requested === 'verify_primary_writes'
      && configuredMode === 'verify_primary_writes'
      && ['awaiting_smoke_test', 'ready_for_fast_mode'].includes(status);

    if (journalCount() > 0 && !keepingCompletedFastMode && !keepingActiveShortTest) {
      return { allowed: false, reason: 'habit_changes_waiting_to_save' };
    }

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

;(function installTaskPointsNpcScoreCap86(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__npcScoreCap86Installed) return;
  core.__npcScoreCap86Installed = true;

  const HIGH_START = 62;
  const OLD_HIGH_MAX = 85;
  const NEW_HIGH_MAX = 86;
  const LOW_START = 20;
  const LOW_MIN = 5;
  const OLD_HIGH_RANGE = OLD_HIGH_MAX - HIGH_START;
  const NEW_HIGH_RANGE = NEW_HIGH_MAX - HIGH_START;
  const roundScore = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;

  core.softCurbNpcScore = function softCurbNpcScore86(rawScore) {
    const score = Number(rawScore);
    if (!Number.isFinite(score)) return LOW_MIN;

    let cappedScore = score;
    if (score > HIGH_START) {
      const over = score - HIGH_START;
      cappedScore = HIGH_START + NEW_HIGH_RANGE * (over / (over + NEW_HIGH_RANGE));
    } else if (score < LOW_START) {
      const under = LOW_START - score;
      const lowRange = LOW_START - LOW_MIN;
      cappedScore = LOW_START - lowRange * (under / (under + lowRange));
    }

    cappedScore = Math.max(LOW_MIN, Math.min(NEW_HIGH_MAX, cappedScore));
    return roundScore(cappedScore);
  };

  function remapOldHighCurbTo86(value) {
    const score = Number(value);
    if (!Number.isFinite(score) || score <= HIGH_START) return score;
    if (score >= OLD_HIGH_MAX) return NEW_HIGH_MAX;

    const delta = score - HIGH_START;
    const denominator = OLD_HIGH_RANGE - delta;
    if (denominator <= 0) return NEW_HIGH_MAX;
    const estimatedOver = (OLD_HIGH_RANGE * delta) / denominator;
    return roundScore(HIGH_START + NEW_HIGH_RANGE * (estimatedOver / (estimatedOver + NEW_HIGH_RANGE)));
  }

  function installFinalSimulatorWrapper() {
    const current = core.simulateAiScoreForPlayerCore;
    if (typeof current !== 'function' || current.__taskPointsNpcScoreCap86Final) return;

    core.simulateAiScoreForPlayerCore = function npcScoreCap86Simulator(player, dateKey, options = {}) {
      const context = options?.context || {};
      const originalCapture = typeof context.captureEffects === 'function' ? context.captureEffects : null;
      let capturedEffects = null;
      const wrappedContext = {
        ...context,
        captureEffects(effects) { capturedEffects = effects || null; }
      };

      const oldFinalScore = Number(current(player, dateKey, { ...options, context: wrappedContext }));
      let newFinalScore = remapOldHighCurbTo86(oldFinalScore);
      let nextEffects = capturedEffects;

      if (capturedEffects && Number(capturedEffects.greedTelemetryVersion) >= 1) {
        const oldAppliedGreed = Number(capturedEffects.greedBonus) || 0;
        const oldBaseScore = oldFinalScore - oldAppliedGreed;
        const newBaseScore = remapOldHighCurbTo86(oldBaseScore);
        const potentialGreed = capturedEffects.greedPerformanceEligible === true
          ? Math.max(0, Number(capturedEffects.greedPotentialBonus) || 0)
          : 0;
        newFinalScore = roundScore(Math.min(NEW_HIGH_MAX, newBaseScore + potentialGreed));
        const newAppliedGreed = roundScore(Math.max(0, newFinalScore - newBaseScore));
        nextEffects = {
          ...capturedEffects,
          greedApplied: newAppliedGreed > 0,
          greedBonus: newAppliedGreed
        };
      }

      if (originalCapture) originalCapture(nextEffects || capturedEffects || {});
      return roundScore(Math.max(LOW_MIN, Math.min(NEW_HIGH_MAX, newFinalScore)));
    };
    core.simulateAiScoreForPlayerCore.__taskPointsNpcScoreCap86Final = true;
    core.simulateAiScoreForPlayerCore.__taskPointsOriginal = current;
  }

  if (typeof global.queueMicrotask === 'function') global.queueMicrotask(installFinalSimulatorWrapper);
  else Promise.resolve().then(installFinalSimulatorWrapper);
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsSeasonChampionGoldBonus(global) {
  'use strict';
  const document = global.document;
  if (!document?.head || document.querySelector?.('script[data-taskpoints-champion-gold]')) return;
  const script = document.createElement('script');
  script.src = 'season_champion_gold_bonus.js';
  script.defer = true;
  script.dataset.taskpointsChampionGold = 'true';
  document.head.appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsScoreAliasConsistency(global) {
  'use strict';
  const document = global.document;
  if (!document?.head || document.querySelector?.('script[data-taskpoints-score-alias-consistency]')) return;
  const script = document.createElement('script');
  script.src = 'score_alias_consistency.js';
  script.defer = true;
  script.dataset.taskpointsScoreAliasConsistency = 'true';
  document.head.appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsTaskDeleteFastPath(global) {
  'use strict';
  const document = global.document;
  if (!document?.head || document.querySelector?.('script[data-taskpoints-task-delete-fast-path]')) return;
  const script = document.createElement('script');
  script.src = 'task_delete_fast_path.js';
  script.defer = true;
  script.dataset.taskpointsTaskDeleteFastPath = 'true';
  document.head.appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsRecordsGoldTheftTab(global) {
  'use strict';
  const document = global.document;
  const path = String(global.location?.pathname || '');
  if (!/(^|\/)records(?:\.html)?$/i.test(path)) return;
  if (!document?.head || document.querySelector?.('script[data-taskpoints-records-gold-theft-tab]')) return;
  const script = document.createElement('script');
  script.src = 'records_gold_theft_tab.js';
  script.defer = true;
  script.dataset.taskpointsRecordsGoldTheftTab = 'true';
  document.head.appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsRecordsGoldTheftHistoryFix(global) {
  'use strict';
  const document = global.document;
  const path = String(global.location?.pathname || '');
  if (!/(^|\/)records(?:\.html)?$/i.test(path)) return;
  if (!document?.head || document.querySelector?.('script[data-taskpoints-records-gold-theft-history-fix]')) return;
  const script = document.createElement('script');
  script.src = 'records_gold_theft_history_fix.js';
  script.defer = true;
  script.dataset.taskpointsRecordsGoldTheftHistoryFix = 'true';
  document.head.appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);
