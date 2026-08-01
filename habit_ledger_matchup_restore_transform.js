;(function installHabitLedgerStoredScoreRestoreTransform(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__storedScoreRestoreTransformInstalled || typeof planner.buildHabitLedgerRepairPlan !== 'function') return;
  planner.__storedScoreRestoreTransformInstalled = true;
  const previousBuild = planner.buildHabitLedgerRepairPlan.bind(planner);
  const EPSILON = 0.0001;

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = (value) => populated(value) && Number.isFinite(Number(value));

  function classifyRestorations(impact) {
    if (!impact || !Array.isArray(impact.days)) return impact;
    const days = impact.days.map((day) => {
      const restoresStoredScore = Number(day?.matchupCount) === 1
        && finite(day?.storedUserScore)
        && finite(day?.projectedUserScore)
        && finite(day?.opponentScore)
        && Math.abs(Number(day.projectedUserScore) - Number(day.storedUserScore)) <= EPSILON;
      if (!restoresStoredScore) return day;

      const beforeResult = day.beforeResult || '';
      const afterResult = day.afterResult || '';
      const resultUnchanged = beforeResult
        && afterResult
        && beforeResult !== 'Unknown'
        && afterResult !== 'Unknown'
        && beforeResult === afterResult;
      if (!resultUnchanged) return day;

      return {
        ...day,
        status: 'restores-stored-score',
        blocking: false,
        resultChanges: false,
        restoresStoredScore: true,
        reason: 'The cleanup restores the canonical daily score to the already-finalized matchup score; the stored result remains unchanged.'
      };
    });

    const blockingDays = days.filter((day) => day?.blocking);
    const resultChangingDays = blockingDays.filter((day) => day?.resultChanges === true);
    const restoringDays = days.filter((day) => day?.status === 'restores-stored-score');
    return {
      ...impact,
      days,
      blockingDays,
      resultChangingDays,
      restoringDays,
      restoredScoreDays: restoringDays.length,
      affectedDays: days.length,
      hasBlockingImpact: blockingDays.length > 0
    };
  }

  planner.buildHabitLedgerRepairPlan = function storedScoreRestoreBuild(stateInput) {
    const plan = previousBuild(stateInput);
    const matchupImpact = classifyRestorations(plan?.matchupImpact);
    global.__latestHabitLedgerMatchupImpact = matchupImpact;
    return { ...plan, matchupImpact };
  };

  global.TaskPointsHabitLedgerStoredScoreRestore = { classifyRestorations };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerStoredScoreRestore;
  }
})(typeof window !== 'undefined' ? window : globalThis);
