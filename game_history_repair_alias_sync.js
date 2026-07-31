;(function installTaskPointsGameHistoryAliasSync(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const repair = global.TaskPointsGameHistoryReconciliationRepair;
  if (!core || !repair || core.__gameHistoryRepairAliasSyncInstalled) return;
  core.__gameHistoryRepairAliasSyncInstalled = true;

  const TOLERANCE = 0.05;
  const SAVE_PATH = 'audit-game-history-reconciliation-repair';
  const corrections = Array.isArray(repair.CONFIRMED_SCORE_CORRECTIONS)
    ? repair.CONFIRMED_SCORE_CORRECTIONS
    : [];

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  const finite = (value) => populated(value) && Number.isFinite(Number(value));

  const equalScore = (left, right) =>
    finite(left) && finite(right) && Math.abs(Number(left) - Number(right)) <= TOLERANCE;

  function dateKey(row) {
    const value = row?.dateKey || row?.date || row?.completedAtISO || row?.createdAtISO || '';
    return String(value || '').slice(0, 10);
  }

  function synchronizeApprovedLegacyAliases(state) {
    const rows = Array.isArray(state?.gameHistory) ? state.gameHistory : [];
    let synchronizedFields = 0;

    corrections.forEach((correction) => {
      rows.forEach((row) => {
        if (!row) return;
        if (dateKey(row) !== correction.dateKey) return;
        if (String(row.playerId || '') !== String(correction.playerId)) return;
        if (!equalScore(row.score, correction.matchupScore)) return;

        ['points', 'total'].forEach((field) => {
          if (!populated(row[field])) return;
          if (equalScore(row[field], correction.matchupScore)) return;
          row[field] = Number(correction.matchupScore);
          synchronizedFields += 1;
        });
      });
    });

    return { state, synchronizedFields };
  }

  if (typeof repair.applyGameHistoryRepair === 'function'
    && !repair.applyGameHistoryRepair.__taskPointsHistoryAliasSync) {
    const originalApply = repair.applyGameHistoryRepair.bind(repair);
    const wrappedApply = function applyGameHistoryRepairWithLegacyAliasSync(...args) {
      const result = originalApply(...args);
      if (result?.state) {
        const synchronized = synchronizeApprovedLegacyAliases(result.state);
        result.synchronizedLegacyFields = synchronized.synchronizedFields;
      }
      return result;
    };
    wrappedApply.__taskPointsHistoryAliasSync = true;
    wrappedApply.__taskPointsOriginal = originalApply;
    repair.applyGameHistoryRepair = wrappedApply;
    core.GameHistoryReconciliationRepair = repair;
  }

  if (typeof core.saveStateSnapshot === 'function'
    && !core.saveStateSnapshot.__taskPointsHistoryAliasSync) {
    const originalSave = core.saveStateSnapshot.bind(core);
    const wrappedSave = function saveStateSnapshotWithHistoryAliasSync(state, options = {}) {
      if (String(options?.savePath || '') === SAVE_PATH) {
        synchronizeApprovedLegacyAliases(state);
      }
      return originalSave(state, options);
    };
    wrappedSave.__taskPointsHistoryAliasSync = true;
    wrappedSave.__taskPointsOriginal = originalSave;
    core.saveStateSnapshot = wrappedSave;
  }

  const api = { synchronizeApprovedLegacyAliases };
  core.GameHistoryRepairAliasSync = api;
  global.TaskPointsGameHistoryRepairAliasSync = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
