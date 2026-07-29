(function connectTaskPointsRestartCheckerToSetup(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__indexedDbRequalificationSessionCompatInstalled) return;
  const readStatus = core.getIndexedDbBrowserSessionStatus;
  if (typeof readStatus !== 'function') return;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
  const HABIT_JOURNAL_KEY = core.PENDING_HABIT_DELTAS_KEY || 'taskpoints_pending_habit_deltas_v1';
  const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
  const storage = global.localStorage;
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
  const journalCount = (raw) => {
    if (!raw) return 0;
    const value = parse(raw, null);
    if (Array.isArray(value)) return value.length;
    if (Array.isArray(value?.operations)) return value.operations.length;
    return value && typeof value === 'object' ? Object.keys(value).length : 1;
  };

  core.__indexedDbRequalificationSessionCompatInstalled = true;
  core.getIndexedDbBrowserSessionStatus = function getCompatibleRestartStatus() {
    const status = readStatus.call(core) || {};
    return {
      ...status,
      broadcastSupported: status.lockSupported === true
    };
  };

  function installInterruptedTestWriteBridge(preservedGate) {
    const StorageCtor = global.Storage;
    const prototype = StorageCtor?.prototype;
    if (!prototype || typeof prototype.setItem !== 'function') return null;

    const originalSetItem = prototype.setItem;
    let active = true;
    const restore = () => {
      if (prototype.setItem === bridgedSetItem) prototype.setItem = originalSetItem;
    };
    function bridgedSetItem(key, value) {
      let nextValue = value;
      let finished = false;
      if (active && this === storage && String(key) === GATE_KEY) {
        const candidate = parse(String(value), null);
        if (candidate && candidate.status === 'awaiting_smoke_test') {
          const currentRaw = storage.getItem(STORAGE_KEY);
          const currentRawHash = rawHash(currentRaw);
          nextValue = JSON.stringify({
            ...candidate,
            authorizedAtISO: preservedGate.authorizedAtISO || candidate.authorizedAtISO,
            authorizedRawHash: candidate.authorizedRawHash || currentRawHash,
            baselineRawHash: preservedGate.baselineRawHash,
            baselineCounts: preservedGate.baselineCounts,
            baselineVerificationFailures: Number(preservedGate.baselineVerificationFailures || 0),
            baselineBlockedWrites: Number(preservedGate.baselineBlockedWrites || 0),
            preparedBrowserSessionId: preservedGate.preparedBrowserSessionId,
            hadRecoveryHold: preservedGate.hadRecoveryHold === true,
            previousRecoveryHoldRaw: preservedGate.previousRecoveryHoldRaw ?? null,
            preparedPageId: preservedGate.preparedPageId || candidate.preparedPageId,
            freshAppSessionId: preservedGate.freshAppSessionId,
            freshAppStartedAtISO: preservedGate.freshAppStartedAtISO || null,
            freshAppWitnessRawHash: preservedGate.freshAppWitnessRawHash || preservedGate.freshAppRawHash || null,
            freshAppRawHash: currentRawHash,
            freshAppPage: preservedGate.freshAppPage || null,
            exclusivePageLockConfirmed: preservedGate.exclusivePageLockConfirmed === true,
            testPreparedAtISO: preservedGate.testPreparedAtISO || candidate.testPreparedAtISO,
            preparedSequence: Number(preservedGate.preparedSequence || candidate.preparedSequence || 0),
            interruptedModeResumedAtISO: new Date().toISOString(),
            lastError: null
          });
          active = false;
          finished = true;
        }
      }
      const result = originalSetItem.call(this, key, nextValue);
      if (finished) {
        if (typeof global.queueMicrotask === 'function') global.queueMicrotask(restore);
        else global.setTimeout?.(restore, 0);
      }
      return result;
    }

    try {
      prototype.setItem = bridgedSetItem;
      if (prototype.setItem !== bridgedSetItem) return null;
      const restoreTimer = global.setTimeout?.(restore, 120000);
      restoreTimer?.unref?.();
      return { restore };
    } catch (_) {
      return null;
    }
  }

  // This helper is loaded only after the user deliberately presses Start or
  // Finish. If an already-proven test was reset to Off by an older build, resume
  // that same test instead of discarding its close-and-reopen witness and making
  // the user repeat the harmless edit.
  try {
    const gate = parse(storage?.getItem?.(GATE_KEY), {}) || {};
    const currentRaw = storage?.getItem?.(STORAGE_KEY);
    const currentRawHash = rawHash(currentRaw);
    const mode = storage?.getItem?.(MODE_KEY) || 'off';
    const reopenWasProven = Boolean(
      ['awaiting_smoke_test', 'ready_for_fast_mode'].includes(String(gate.status || ''))
      && gate.preparedBrowserSessionId
      && gate.freshAppSessionId
      && gate.freshAppSessionId !== gate.preparedBrowserSessionId
      && gate.exclusivePageLockConfirmed === true
      && gate.baselineRawHash
      && currentRaw
      && currentRawHash !== gate.baselineRawHash
    );
    const noBlockingWork = Boolean(
      !storage?.getItem?.(HOLD_KEY)
      && !storage?.getItem?.(ATTEMPT_LOCK_KEY)
      && journalCount(storage?.getItem?.(HABIT_JOURNAL_KEY)) === 0
      && !storage?.getItem?.(LEGACY_JOURNAL_KEY)
    );
    const vaultWasVerified = Boolean(global.__TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__);
    const interruptedTest = mode === 'off' && reopenWasProven && noBlockingWork && vaultWasVerified;

    const interruptedBridge = interruptedTest ? installInterruptedTestWriteBridge(gate) : null;
    if (interruptedBridge) {
      storage.setItem(GATE_KEY, JSON.stringify({
        ...gate,
        status: 'authorizing_test_mode',
        authorizedRawHash: currentRawHash,
        interruptedModeRepairPreparedAtISO: new Date().toISOString(),
        lastError: null
      }));
      const selected = core.setPhase4StorageMode?.('verify_primary_writes');
      if (selected !== 'verify_primary_writes') {
        interruptedBridge.restore();
        storage.setItem(MODE_KEY, 'off');
        storage.setItem(GATE_KEY, JSON.stringify(gate));
      }
      return;
    }

    // A genuine fresh-session witness remains valid even if TaskPoints performs
    // additional ordinary saves afterward. Refresh the comparison hash to the
    // current healthy working copy without changing the recorded session IDs or
    // the exclusive-lock proof that established the reopen.
    if (reopenWasProven && mode === 'verify_primary_writes' && gate.freshAppRawHash !== currentRawHash) {
      storage.setItem(GATE_KEY, JSON.stringify({
        ...gate,
        freshAppWitnessRawHash: gate.freshAppWitnessRawHash || gate.freshAppRawHash || null,
        freshAppRawHash: currentRawHash,
        reopenProofRefreshedAtISO: new Date().toISOString()
      }));
    }
  } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
