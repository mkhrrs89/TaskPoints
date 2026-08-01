;(function installHabitLedgerImpactAttestation(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__completeImpactChainAttestationInstalled || typeof planner.buildHabitLedgerRepairPlan !== 'function') return;
  planner.__completeImpactChainAttestationInstalled = true;
  const previousBuild = planner.buildHabitLedgerRepairPlan.bind(planner);
  const VERSION = '20260801-1';

  function hasPointRemovals(plan) {
    return (Array.isArray(plan?.failedDateRemovals) && plan.failedDateRemovals.length > 0)
      || (Array.isArray(plan?.duplicateRemovals) && plan.duplicateRemovals.length > 0);
  }

  function chainAvailable() {
    return Boolean(
      global.TaskPointsHabitLedgerMatchupImpact
      && global.TaskPointsCanonicalHabitLedgerMatchupImpact
      && global.TaskPointsHabitLedgerDateIsoImpact
      && global.TaskPointsHabitLedgerLegacyScoreFallback
    );
  }

  function attestImpact(plan) {
    const complete = chainAvailable();
    const existing = plan?.matchupImpact && typeof plan.matchupImpact === 'object'
      ? plan.matchupImpact
      : {
          days: [],
          blockingDays: [],
          resultChangingDays: [],
          affectedDays: 0,
          pointsRemoved: Number(plan?.pointsRemoved) || 0,
          hasBlockingImpact: false
        };

    if (complete || !hasPointRemovals(plan)) {
      return {
        ...existing,
        completeImpactChain: complete,
        impactChainVersion: complete ? VERSION : ''
      };
    }

    const failure = {
      dayKey: '',
      pointsRemoved: Number(plan?.pointsRemoved) || 0,
      matchupCount: 0,
      status: 'analysis-error',
      blocking: true,
      resultChanges: null,
      reason: 'The complete canonical matchup-impact chain did not load. Repair is blocked.'
    };
    const retained = (Array.isArray(existing.days) ? existing.days : [])
      .filter((day) => day?.status !== 'impact-chain-incomplete');
    const days = retained.concat({ ...failure, status: 'impact-chain-incomplete' });
    const blockingDays = days.filter((day) => day?.blocking);
    const resultChangingDays = blockingDays.filter((day) => day?.resultChanges === true);
    return {
      ...existing,
      days,
      blockingDays,
      resultChangingDays,
      affectedDays: days.length,
      hasBlockingImpact: true,
      completeImpactChain: false,
      impactChainVersion: ''
    };
  }

  planner.buildHabitLedgerRepairPlan = function attestedImpactBuild(stateInput) {
    const plan = previousBuild(stateInput);
    return {
      ...plan,
      matchupImpact: attestImpact(plan)
    };
  };

  global.TaskPointsHabitLedgerImpactAttestation = {
    VERSION,
    hasPointRemovals,
    chainAvailable,
    attestImpact
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerImpactAttestation;
  }
})(typeof window !== 'undefined' ? window : globalThis);
