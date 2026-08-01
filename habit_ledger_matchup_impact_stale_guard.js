;(function installHabitLedgerMatchupImpactStaleGuard(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__matchupImpactStaleGuardInstalled || typeof planner.applyHabitLedgerRepairPlan !== 'function') return;
  planner.__matchupImpactStaleGuardInstalled = true;
  const originalApply = planner.applyHabitLedgerRepairPlan.bind(planner);

  function fingerprint(impact) {
    return JSON.stringify((impact?.days || []).map((day) => ({
      dayKey: day.dayKey,
      pointsRemoved: day.pointsRemoved,
      matchupCount: day.matchupCount,
      matchupId: day.matchupId || '',
      storedUserScore: day.storedUserScore,
      projectedUserScore: day.projectedUserScore,
      opponentScore: day.opponentScore,
      status: day.status,
      blocking: day.blocking,
      beforeResult: day.beforeResult || '',
      afterResult: day.afterResult || ''
    })));
  }

  planner.applyHabitLedgerRepairPlan = function staleProtectedHabitLedgerApply(stateInput, previewPlan) {
    const livePlan = planner.buildHabitLedgerRepairPlan(stateInput);
    const liveImpact = livePlan?.matchupImpact;
    const previewImpact = previewPlan?.matchupImpact;
    if ((liveImpact?.affectedDays || 0) > 0 && !previewImpact) {
      throw new Error('The matchup-impact preview is missing. No habit rows were changed.');
    }
    if (previewImpact && fingerprint(liveImpact) !== fingerprint(previewImpact)) {
      throw new Error(
        'The stored matchup state changed after the preview. Run the preview again. No habit rows were changed.'
      );
    }
    return originalApply(stateInput, previewPlan);
  };

  global.TaskPointsHabitLedgerMatchupImpactStaleGuard = { fingerprint };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerMatchupImpactStaleGuard;
  }
})(typeof window !== 'undefined' ? window : globalThis);
