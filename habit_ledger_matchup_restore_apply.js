;(function installHabitLedgerStoredScoreRestoreApply(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__storedScoreRestoreApplyInstalled || typeof planner.applyHabitLedgerRepairPlan !== 'function') return;
  planner.__storedScoreRestoreApplyInstalled = true;
  const previousApply = planner.applyHabitLedgerRepairPlan.bind(planner);

  function restorationCount(impact) {
    return Array.isArray(impact?.restoringDays)
      ? impact.restoringDays.length
      : (Array.isArray(impact?.days)
          ? impact.days.filter((day) => day?.status === 'restores-stored-score').length
          : 0);
  }

  function impactFingerprint(impact) {
    const canonical = global.TaskPointsCanonicalHabitLedgerMatchupImpact;
    if (canonical && typeof canonical.impactFingerprint === 'function') {
      return canonical.impactFingerprint(impact);
    }
    return JSON.stringify((impact?.days || []).map((day) => ({
      dayKey: day?.dayKey || '',
      matchupId: day?.matchupId || '',
      storedUserScore: day?.storedUserScore,
      projectedUserScore: day?.projectedUserScore,
      opponentScore: day?.opponentScore,
      status: day?.status || '',
      blocking: Boolean(day?.blocking),
      beforeResult: day?.beforeResult || '',
      afterResult: day?.afterResult || ''
    })));
  }

  planner.applyHabitLedgerRepairPlan = function storedScoreRestoreApply(stateInput, previewPlan) {
    const previewImpact = previewPlan?.matchupImpact;
    const hasRestorations = restorationCount(previewImpact) > 0;
    if (!hasRestorations) return previousApply(stateInput, previewPlan);

    if (previewImpact?.completeImpactChain !== true || previewImpact?.hasBlockingImpact) {
      throw new Error('The stored-score restoration preview is incomplete or blocked. No habit rows were changed.');
    }
    if (typeof planner.__habitLedgerBaseApply !== 'function') {
      throw new Error('The base habit-ledger repair function is unavailable. No habit rows were changed.');
    }

    const livePlan = planner.buildHabitLedgerRepairPlan(stateInput);
    const liveImpact = livePlan?.matchupImpact;
    if (liveImpact?.completeImpactChain !== true || liveImpact?.hasBlockingImpact) {
      throw new Error('The live stored-score restoration is incomplete or blocked. No habit rows were changed.');
    }
    if (restorationCount(liveImpact) !== restorationCount(previewImpact)) {
      throw new Error('The stored-score restoration set changed after preview. Run the preview again. No habit rows were changed.');
    }
    if (impactFingerprint(liveImpact) !== impactFingerprint(previewImpact)) {
      throw new Error('The stored-score restoration impact changed after preview. Run the preview again. No habit rows were changed.');
    }

    return planner.__habitLedgerBaseApply(stateInput, previewPlan);
  };

  global.TaskPointsHabitLedgerStoredScoreRestoreApply = { restorationCount, impactFingerprint };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerStoredScoreRestoreApply;
  }
})(typeof window !== 'undefined' ? window : globalThis);
