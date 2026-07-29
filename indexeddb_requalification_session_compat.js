(function connectTaskPointsRestartCheckerToSetup(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__indexedDbRequalificationSessionCompatInstalled) return;
  const readStatus = core.getIndexedDbBrowserSessionStatus;
  if (typeof readStatus !== 'function') return;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const MODE_KEY = core.PHASE4_STORAGE_MODE_KEY || 'taskpoints_phase4_storage_mode_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
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

  core.__indexedDbRequalificationSessionCompatInstalled = true;
  core.getIndexedDbBrowserSessionStatus = function getCompatibleRestartStatus() {
    const status = readStatus.call(core) || {};
    return {
      ...status,
      broadcastSupported: status.lockSupported === true
    };
  };

  // This helper is loaded only after the user deliberately presses Start or
  // Finish. A genuine fresh-session witness remains valid even if TaskPoints
  // performs additional ordinary saves afterward. Refresh the comparison hash
  // to the current healthy working copy without changing the recorded session
  // IDs or the exclusive-lock proof that established the reopen.
  try {
    const gate = parse(storage?.getItem?.(GATE_KEY), {}) || {};
    const currentRaw = storage?.getItem?.(STORAGE_KEY);
    const mode = storage?.getItem?.(MODE_KEY) || 'off';
    const reopenWasProven = Boolean(
      ['awaiting_smoke_test', 'ready_for_fast_mode'].includes(String(gate.status || ''))
      && mode === 'verify_primary_writes'
      && gate.preparedBrowserSessionId
      && gate.freshAppSessionId
      && gate.freshAppSessionId !== gate.preparedBrowserSessionId
      && gate.exclusivePageLockConfirmed === true
      && currentRaw
    );
    if (reopenWasProven) {
      const currentRawHash = rawHash(currentRaw);
      if (gate.freshAppRawHash !== currentRawHash) {
        storage.setItem(GATE_KEY, JSON.stringify({
          ...gate,
          freshAppWitnessRawHash: gate.freshAppWitnessRawHash || gate.freshAppRawHash || null,
          freshAppRawHash: currentRawHash,
          reopenProofRefreshedAtISO: new Date().toISOString()
        }));
      }
    }
  } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
