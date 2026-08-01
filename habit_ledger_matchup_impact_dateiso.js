;(function installHabitLedgerDateIsoImpact(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__dateIsoMatchupImpactInstalled || typeof planner.buildHabitLedgerRepairPlan !== 'function') return;
  planner.__dateIsoMatchupImpactInstalled = true;
  const previousBuild = planner.buildHabitLedgerRepairPlan.bind(planner);

  function verifyDateIsoCoverage(plan) {
    const impact = plan?.matchupImpact;
    if (!impact || typeof impact !== 'object') return impact;
    if (impact.includesDateISO === true && impact.batchedScoreMaps === true) return impact;

    const failure = {
      dayKey: '',
      pointsRemoved: Number(plan?.pointsRemoved) || 0,
      matchupCount: 0,
      status: 'dateiso-analysis-incomplete',
      blocking: true,
      resultChanges: null,
      reason: 'The batched canonical matcher did not attest legacy dateISO coverage.'
    };
    const days = (Array.isArray(impact.days) ? impact.days : [])
      .filter((day) => day?.status !== failure.status)
      .concat(failure);
    const blockingDays = days.filter((day) => day?.blocking);
    const resultChangingDays = blockingDays.filter((day) => day?.resultChanges === true);
    return {
      ...impact,
      days,
      blockingDays,
      resultChangingDays,
      affectedDays: days.length,
      hasBlockingImpact: true,
      includesDateISO: false
    };
  }

  planner.buildHabitLedgerRepairPlan = function dateIsoCoverageBuild(stateInput) {
    const plan = previousBuild(stateInput);
    return {
      ...plan,
      matchupImpact: verifyDateIsoCoverage(plan)
    };
  };

  global.TaskPointsHabitLedgerDateIsoImpact = { verifyDateIsoCoverage };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerDateIsoImpact;
  }
})(typeof window !== 'undefined' ? window : globalThis);
