;(function installHabitLedgerDateIsoImpact(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  const core = global.TaskPointsCore || {};
  if (!planner || planner.__dateIsoMatchupImpactInstalled || typeof planner.buildHabitLedgerRepairPlan !== 'function') return;
  planner.__dateIsoMatchupImpactInstalled = true;
  const previousBuild = planner.buildHabitLedgerRepairPlan.bind(planner);

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finitePopulated = (value) => populated(value) && Number.isFinite(Number(value));

  function validDayKey(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function localDateKey(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    if (typeof core.dateKey === 'function') {
      try {
        const shared = core.dateKey(parsed);
        if (validDayKey(shared)) return shared;
      } catch (_) {}
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function normalMatchupDay(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dateKey, row.dayKey]) {
      const direct = typeof value === 'string' ? value.slice(0, 10) : '';
      if (validDayKey(direct)) return direct;
    }
    if (validDayKey(row.date)) return row.date;
    for (const value of [row.date, row.completedAtISO, row.finalizedAtISO]) {
      if (!populated(value)) continue;
      const key = localDateKey(value);
      if (key) return key;
    }
    return '';
  }

  function inclusiveMatchupDay(row) {
    return normalMatchupDay(row) || (populated(row?.dateISO) ? localDateKey(row.dateISO) : '');
  }

  function scoreValue(primary, alias) {
    if (finitePopulated(primary)) return Number(primary);
    if (finitePopulated(alias)) return Number(alias);
    return null;
  }

  function resultLabel(userScore, opponentScore) {
    if (!finitePopulated(userScore) || !finitePopulated(opponentScore)) return 'Unknown';
    const user = Number(userScore);
    const opponent = Number(opponentScore);
    if (user === opponent) return 'Tie';
    return user > opponent ? 'Win' : 'Loss';
  }

  function playerName(state, playerId) {
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((item) => item && String(item.id) === String(playerId));
    return String(player?.name || player?.playerName || playerId || 'Unknown opponent');
  }

  function pointsRemovedForDay(plan, dayKey) {
    return Number([]
      .concat(Array.isArray(plan?.failedDateRemovals) ? plan.failedDateRemovals : [])
      .concat(Array.isArray(plan?.duplicateRemovals) ? plan.duplicateRemovals : [])
      .filter((item) => item?.dayKey === dayKey && finitePopulated(item?.points))
      .reduce((sum, item) => sum + Number(item.points), 0)
      .toFixed(4));
  }

  function addDateIsoImpacts(state, plan) {
    const impact = plan?.matchupImpact;
    const canonical = global.TaskPointsCanonicalHabitLedgerMatchupImpact;
    if (!impact || !Array.isArray(impact.days) || !canonical) return impact;

    const matchups = (Array.isArray(state?.matchups) ? state.matchups : [])
      .filter((matchup) => matchup && (matchup.playerAId === 'YOU' || matchup.playerBId === 'YOU'));
    const legacyDays = new Set(
      matchups
        .filter((matchup) => !normalMatchupDay(matchup) && populated(matchup.dateISO))
        .map(inclusiveMatchupDay)
        .filter(Boolean)
    );
    if (!legacyDays.size) return impact;

    const projectedState = canonical.buildProjectedState(state, plan);
    let days = impact.days.slice();

    legacyDays.forEach((dayKey) => {
      let currentScore;
      let projectedScore;
      try {
        currentScore = canonical.canonicalScore(state, dayKey);
        projectedScore = canonical.canonicalScore(projectedState, dayKey);
      } catch (error) {
        days = days.filter((day) => !(day?.dayKey === dayKey && day?.status === 'no-matchup'));
        days.push({
          dayKey,
          pointsRemoved: pointsRemovedForDay(plan, dayKey),
          matchupCount: 0,
          status: 'analysis-error',
          blocking: true,
          resultChanges: null,
          reason: error.message || String(error)
        });
        return;
      }
      if (Math.abs(Number(currentScore) - Number(projectedScore)) <= 0.0001) return;

      const candidates = matchups.filter((matchup) => inclusiveMatchupDay(matchup) === dayKey);
      days = days.filter((day) => !(day?.dayKey === dayKey && day?.status === 'no-matchup'));
      if (candidates.length !== 1) {
        days.push({
          dayKey,
          pointsRemoved: pointsRemovedForDay(plan, dayKey),
          canonicalScoreChange: Number((Number(currentScore) - Number(projectedScore)).toFixed(4)),
          currentCompletionScore: Number(currentScore),
          projectedCompletionScore: Number(projectedScore),
          matchupCount: candidates.length,
          status: 'ambiguous-matchups',
          blocking: true,
          resultChanges: null,
          reason: `${candidates.length} stored matchups involving You exist for this date after including legacy dateISO records.`
        });
        return;
      }

      const matchup = candidates[0];
      const youAreA = matchup.playerAId === 'YOU';
      const aScore = scoreValue(matchup.scoreA, matchup.playerAScore);
      const bScore = scoreValue(matchup.scoreB, matchup.playerBScore);
      const storedUserScore = youAreA ? aScore : bScore;
      const opponentScore = youAreA ? bScore : aScore;
      const opponentId = youAreA ? matchup.playerBId : matchup.playerAId;
      const base = {
        dayKey,
        pointsRemoved: pointsRemovedForDay(plan, dayKey),
        canonicalScoreChange: Number((Number(currentScore) - Number(projectedScore)).toFixed(4)),
        currentCompletionScore: Number(currentScore),
        projectedCompletionScore: Number(projectedScore),
        projectedUserScore: Number(projectedScore),
        matchupCount: 1,
        matchupId: String(matchup.id || matchup.matchupId || ''),
        opponentId,
        opponentName: playerName(state, opponentId),
        storedUserScore,
        opponentScore,
        blocking: true
      };

      if (!finitePopulated(storedUserScore) || !finitePopulated(opponentScore)) {
        days.push({
          ...base,
          storedUserScore: finitePopulated(storedUserScore) ? Number(storedUserScore) : null,
          opponentScore: finitePopulated(opponentScore) ? Number(opponentScore) : null,
          beforeResult: 'Unknown',
          afterResult: finitePopulated(opponentScore) ? resultLabel(projectedScore, opponentScore) : 'Unknown',
          status: 'missing-matchup-score',
          resultChanges: null,
          reason: 'The legacy dateISO matchup does not contain two finite final scores after checking aliases.'
        });
        return;
      }

      const beforeResult = resultLabel(storedUserScore, opponentScore);
      const afterResult = resultLabel(projectedScore, opponentScore);
      days.push({
        ...base,
        storedUserScore: Number(storedUserScore),
        opponentScore: Number(opponentScore),
        beforeResult,
        afterResult,
        resultChanges: beforeResult !== afterResult,
        status: beforeResult !== afterResult ? 'result-change' : 'stored-score-change',
        reason: beforeResult !== afterResult
          ? 'The canonical post-repair score would change the legacy dateISO matchup result.'
          : 'The result stays the same, but the canonical post-repair score would differ from the legacy dateISO matchup score.'
      });
    });

    days.sort((left, right) => String(left?.dayKey || '').localeCompare(String(right?.dayKey || '')));
    const blockingDays = days.filter((day) => day?.blocking);
    const resultChangingDays = blockingDays.filter((day) => day?.resultChanges === true);
    return {
      ...impact,
      days,
      blockingDays,
      resultChangingDays,
      affectedDays: days.length,
      hasBlockingImpact: blockingDays.length > 0
    };
  }

  planner.buildHabitLedgerRepairPlan = function dateIsoSafeBuild(stateInput) {
    const plan = previousBuild(stateInput);
    return {
      ...plan,
      matchupImpact: addDateIsoImpacts(stateInput, plan)
    };
  };

  global.TaskPointsHabitLedgerDateIsoImpact = {
    normalMatchupDay,
    inclusiveMatchupDay,
    addDateIsoImpacts
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerDateIsoImpact;
  }
})(typeof window !== 'undefined' ? window : globalThis);
