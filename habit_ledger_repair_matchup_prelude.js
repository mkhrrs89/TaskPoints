;(function installHabitLedgerRepairMatchupPrelude(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__matchupImpactPreludeInstalled || typeof planner.applyHabitLedgerRepairPlan !== 'function') return;
  planner.__matchupImpactPreludeInstalled = true;
  const originalApply = planner.applyHabitLedgerRepairPlan.bind(planner);
  planner.__habitLedgerBaseApply = originalApply;

  function hasPointRemovals(plan) {
    return (Array.isArray(plan?.failedDateRemovals) && plan.failedDateRemovals.length > 0)
      || (Array.isArray(plan?.duplicateRemovals) && plan.duplicateRemovals.length > 0);
  }

  planner.applyHabitLedgerRepairPlan = function failClosedHabitLedgerApply(stateInput, previewPlan) {
    if (hasPointRemovals(previewPlan) && previewPlan?.matchupImpact?.completeImpactChain !== true) {
      throw new Error(
        'The complete canonical matchup-impact preview is unavailable. No habit rows were changed.'
      );
    }
    return originalApply(stateInput, previewPlan);
  };

  global.TaskPointsHabitLedgerRepairMatchupPrelude = { hasPointRemovals };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerRepairMatchupPrelude;
  }
})(typeof window !== 'undefined' ? window : globalThis);
