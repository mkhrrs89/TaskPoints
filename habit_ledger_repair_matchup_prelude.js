;(function installHabitLedgerRepairMatchupPrelude(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__matchupImpactPreludeInstalled || typeof planner.applyHabitLedgerRepairPlan !== 'function') return;
  planner.__matchupImpactPreludeInstalled = true;
  const originalApply = planner.applyHabitLedgerRepairPlan.bind(planner);

  const finiteNonzero = (value) => Number.isFinite(Number(value)) && Math.abs(Number(value)) > 0.0001;

  function hasPointRemovals(plan) {
    return []
      .concat(Array.isArray(plan?.failedDateRemovals) ? plan.failedDateRemovals : [])
      .concat(Array.isArray(plan?.duplicateRemovals) ? plan.duplicateRemovals : [])
      .some((item) => finiteNonzero(item?.points));
  }

  planner.applyHabitLedgerRepairPlan = function failClosedHabitLedgerApply(stateInput, previewPlan) {
    if (hasPointRemovals(previewPlan) && !previewPlan?.matchupImpact) {
      throw new Error(
        'The matchup-impact preview is unavailable. No habit rows were changed.'
      );
    }
    return originalApply(stateInput, previewPlan);
  };

  global.TaskPointsHabitLedgerRepairMatchupPrelude = { hasPointRemovals };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerRepairMatchupPrelude;
  }
})(typeof window !== 'undefined' ? window : globalThis);
