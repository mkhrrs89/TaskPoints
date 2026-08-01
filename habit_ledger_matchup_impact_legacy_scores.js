;(function installHabitLedgerLegacyScoreFallback(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  const core = global.TaskPointsCore || {};
  if (!planner || planner.__legacyMatchupScoreFallbackInstalled || typeof planner.buildHabitLedgerRepairPlan !== 'function') return;
  planner.__legacyMatchupScoreFallbackInstalled = true;
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

  function matchupDay(row) {
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

  function repairLegacyImpactScores(state, impact) {
    if (!impact || !Array.isArray(impact.days)) return impact;
    const matchups = Array.isArray(state?.matchups) ? state.matchups : [];
    const days = impact.days.map((day) => {
      if (!validDayKey(day?.dayKey) || Number(day?.matchupCount) !== 1) return day;
      const candidates = matchups.filter((matchup) =>
        matchup && matchupDay(matchup) === day.dayKey
        && (matchup.playerAId === 'YOU' || matchup.playerBId === 'YOU')
      );
      if (candidates.length !== 1) return day;
      const matchup = candidates[0];
      const youAreA = matchup.playerAId === 'YOU';
      const aScore = scoreValue(matchup.scoreA, matchup.playerAScore);
      const bScore = scoreValue(matchup.scoreB, matchup.playerBScore);
      const storedUserScore = youAreA ? aScore : bScore;
      const opponentScore = youAreA ? bScore : aScore;
      const opponentId = youAreA ? matchup.playerBId : matchup.playerAId;

      if (!finitePopulated(storedUserScore) || !finitePopulated(opponentScore)) {
        return {
          ...day,
          matchupId: String(matchup.id || matchup.matchupId || day.matchupId || ''),
          opponentId,
          opponentName: playerName(state, opponentId),
          storedUserScore: finitePopulated(storedUserScore) ? Number(storedUserScore) : null,
          opponentScore: finitePopulated(opponentScore) ? Number(opponentScore) : null,
          beforeResult: 'Unknown',
          afterResult: finitePopulated(day.projectedUserScore) && finitePopulated(opponentScore)
            ? resultLabel(day.projectedUserScore, opponentScore)
            : 'Unknown',
          status: 'missing-matchup-score',
          blocking: true,
          resultChanges: null,
          reason: 'The stored matchup does not contain two finite final scores after checking compatibility aliases.'
        };
      }

      const beforeResult = resultLabel(storedUserScore, opponentScore);
      const afterResult = resultLabel(day.projectedUserScore, opponentScore);
      const resultChanges = beforeResult !== afterResult;
      return {
        ...day,
        matchupId: String(matchup.id || matchup.matchupId || day.matchupId || ''),
        opponentId,
        opponentName: playerName(state, opponentId),
        storedUserScore: Number(storedUserScore),
        opponentScore: Number(opponentScore),
        beforeResult,
        afterResult,
        resultChanges,
        status: resultChanges ? 'result-change' : 'stored-score-change',
        blocking: true,
        reason: resultChanges
          ? 'The canonical post-repair score would change the matchup result.'
          : 'The result stays the same, but the canonical post-repair score would differ from the stored matchup score.'
      };
    });

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

  planner.buildHabitLedgerRepairPlan = function legacyScoreSafeBuild(stateInput) {
    const plan = previousBuild(stateInput);
    return {
      ...plan,
      matchupImpact: repairLegacyImpactScores(stateInput, plan?.matchupImpact)
    };
  };

  global.TaskPointsHabitLedgerLegacyScoreFallback = {
    scoreValue,
    repairLegacyImpactScores,
    matchupDay
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsHabitLedgerLegacyScoreFallback;
  }
})(typeof window !== 'undefined' ? window : globalThis);
