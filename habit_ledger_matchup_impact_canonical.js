;(function installCanonicalHabitLedgerMatchupImpact(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  const core = global.TaskPointsCore || {};
  if (!planner || planner.__canonicalMatchupImpactInstalled) return;
  planner.__canonicalMatchupImpactInstalled = true;

  const previousBuild = planner.buildHabitLedgerRepairPlan.bind(planner);
  const previousApply = planner.applyHabitLedgerRepairPlan.bind(planner);
  const EPSILON = 0.0001;

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = (value) => populated(value) && Number.isFinite(Number(value));

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

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

  function rowDay(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dayKey, row.dateKey]) {
      const direct = typeof value === 'string' ? value.slice(0, 10) : '';
      if (validDayKey(direct)) return direct;
    }
    if (validDayKey(row.date)) return row.date;
    for (const value of [
      row.date,
      row.dateISO,
      row.completedAtISO,
      row.createdAtISO,
      row.finalizedAtISO
    ]) {
      if (!populated(value)) continue;
      const key = localDateKey(value);
      if (key) return key;
    }
    return '';
  }

  function scoreValue(primary, alias) {
    if (finite(primary)) return Number(primary);
    if (finite(alias)) return Number(alias);
    return null;
  }

  function resultLabel(userScore, opponentScore) {
    if (!finite(userScore) || !finite(opponentScore)) return 'Unknown';
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

  function buildProjectedState(stateInput, plan) {
    const state = clone(stateInput || {});
    const rows = Array.isArray(state.completions) ? state.completions : [];
    const removals = new Set(
      []
        .concat(Array.isArray(plan?.failedDateRemovals) ? plan.failedDateRemovals : [])
        .concat(Array.isArray(plan?.duplicateRemovals) ? plan.duplicateRemovals : [])
        .map((item) => item?.completionIndex)
        .filter(Number.isInteger)
    );
    const sourceUpdates = new Map(
      (Array.isArray(plan?.sourceUpdates) ? plan.sourceUpdates : [])
        .filter((item) => Number.isInteger(item?.completionIndex))
        .map((item) => [item.completionIndex, item.toSource])
    );
    state.completions = rows.flatMap((row, index) => {
      if (removals.has(index)) return [];
      if (!sourceUpdates.has(index)) return [row];
      return [{ ...row, source: sourceUpdates.get(index) }];
    });
    return state;
  }

  function buildCanonicalScoreMap(state) {
    if (typeof core.youDailyTotalsWithInertia !== 'function') {
      throw new Error('The canonical TaskPoints batch day scorer is unavailable.');
    }
    const totals = core.youDailyTotalsWithInertia(state || {});
    if (!totals || typeof totals !== 'object') {
      throw new Error('The canonical TaskPoints batch day scorer returned no totals.');
    }
    const map = new Map();
    Object.entries(totals).forEach(([dayKey, value]) => {
      if (validDayKey(dayKey) && finite(value)) map.set(dayKey, Number(value));
    });
    return map;
  }

  function scoreFromMap(map, dayKey) {
    if (!validDayKey(dayKey)) throw new Error(`Invalid score date ${dayKey || '(blank)'}.`);
    const value = map.get(dayKey);
    return finite(value) ? Number(value) : 0;
  }

  function buildCanonicalScoreMaps(state, projectedState) {
    return {
      live: buildCanonicalScoreMap(state),
      projected: buildCanonicalScoreMap(projectedState)
    };
  }

  function canonicalScore(state, dayKey) {
    return scoreFromMap(buildCanonicalScoreMap(state), dayKey);
  }

  function impactFingerprint(impact) {
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

  function buildCanonicalImpact(stateInput, plan) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const projectedState = buildProjectedState(state, plan);
    const changeRows = []
      .concat(Array.isArray(plan?.failedDateRemovals) ? plan.failedDateRemovals : [])
      .concat(Array.isArray(plan?.duplicateRemovals) ? plan.duplicateRemovals : [])
      .concat(Array.isArray(plan?.sourceUpdates) ? plan.sourceUpdates : []);
    const directByDay = new Map();

    changeRows.forEach((item) => {
      if (!validDayKey(item?.dayKey)) return;
      if (!directByDay.has(item.dayKey)) {
        directByDay.set(item.dayKey, { pointsRemoved: 0, changeCount: 0 });
      }
      const entry = directByDay.get(item.dayKey);
      if (finite(item.points)) entry.pointsRemoved += Number(item.points);
      entry.changeCount += 1;
    });

    if (!changeRows.length) {
      return {
        days: [],
        blockingDays: [],
        resultChangingDays: [],
        affectedDays: 0,
        pointsRemoved: 0,
        hasBlockingImpact: false,
        canonical: true,
        batchedScoreMaps: true,
        includesDateISO: true
      };
    }

    let scoreMaps;
    try {
      scoreMaps = buildCanonicalScoreMaps(state, projectedState);
    } catch (error) {
      const failure = {
        dayKey: '',
        pointsRemoved: Number(plan?.pointsRemoved) || 0,
        matchupCount: 0,
        status: 'analysis-error',
        blocking: true,
        resultChanges: null,
        reason: error.message || String(error)
      };
      return {
        days: [failure],
        blockingDays: [failure],
        resultChangingDays: [],
        affectedDays: 1,
        pointsRemoved: Number(plan?.pointsRemoved) || 0,
        hasBlockingImpact: true,
        canonical: false,
        batchedScoreMaps: false,
        includesDateISO: true
      };
    }

    const matchupsByDay = new Map();
    (Array.isArray(state.matchups) ? state.matchups : []).forEach((matchup) => {
      if (!matchup || (matchup.playerAId !== 'YOU' && matchup.playerBId !== 'YOU')) return;
      const dayKey = rowDay(matchup);
      if (!dayKey) return;
      if (!matchupsByDay.has(dayKey)) matchupsByDay.set(dayKey, []);
      matchupsByDay.get(dayKey).push(matchup);
    });

    const days = [];
    const matchupImpactDates = new Set();

    matchupsByDay.forEach((matchups, dayKey) => {
      const currentScore = scoreFromMap(scoreMaps.live, dayKey);
      const projectedScore = scoreFromMap(scoreMaps.projected, dayKey);
      if (Math.abs(currentScore - projectedScore) <= EPSILON) return;

      matchupImpactDates.add(dayKey);
      const direct = directByDay.get(dayKey) || { pointsRemoved: 0, changeCount: 0 };
      if (matchups.length !== 1) {
        days.push({
          dayKey,
          pointsRemoved: Number(direct.pointsRemoved.toFixed(4)),
          canonicalScoreChange: Number((currentScore - projectedScore).toFixed(4)),
          currentCompletionScore: currentScore,
          projectedCompletionScore: projectedScore,
          matchupCount: matchups.length,
          status: 'ambiguous-matchups',
          blocking: true,
          resultChanges: null,
          reason: `${matchups.length} stored matchups involving You exist for this date.`
        });
        return;
      }

      const matchup = matchups[0];
      const youAreA = matchup.playerAId === 'YOU';
      const aScore = scoreValue(matchup.scoreA, matchup.playerAScore);
      const bScore = scoreValue(matchup.scoreB, matchup.playerBScore);
      const storedUserScore = youAreA ? aScore : bScore;
      const opponentScore = youAreA ? bScore : aScore;
      const opponentId = youAreA ? matchup.playerBId : matchup.playerAId;

      if (!finite(storedUserScore) || !finite(opponentScore)) {
        days.push({
          dayKey,
          pointsRemoved: Number(direct.pointsRemoved.toFixed(4)),
          canonicalScoreChange: Number((currentScore - projectedScore).toFixed(4)),
          currentCompletionScore: currentScore,
          projectedCompletionScore: projectedScore,
          matchupCount: 1,
          matchupId: String(matchup.id || matchup.matchupId || ''),
          opponentId,
          opponentName: playerName(state, opponentId),
          storedUserScore: finite(storedUserScore) ? Number(storedUserScore) : null,
          projectedUserScore: projectedScore,
          opponentScore: finite(opponentScore) ? Number(opponentScore) : null,
          status: 'missing-matchup-score',
          blocking: true,
          resultChanges: null,
          reason: 'The stored matchup does not contain two finite final scores after checking aliases.'
        });
        return;
      }

      const beforeResult = resultLabel(storedUserScore, opponentScore);
      const afterResult = resultLabel(projectedScore, opponentScore);
      const resultChanges = beforeResult !== afterResult;
      days.push({
        dayKey,
        pointsRemoved: Number(direct.pointsRemoved.toFixed(4)),
        canonicalScoreChange: Number((currentScore - projectedScore).toFixed(4)),
        currentCompletionScore: currentScore,
        projectedCompletionScore: projectedScore,
        matchupCount: 1,
        matchupId: String(matchup.id || matchup.matchupId || ''),
        opponentId,
        opponentName: playerName(state, opponentId),
        storedUserScore: Number(storedUserScore),
        projectedUserScore: projectedScore,
        opponentScore: Number(opponentScore),
        beforeResult,
        afterResult,
        resultChanges,
        baselineDifference: Number((currentScore - Number(storedUserScore)).toFixed(4)),
        baselineMatchesStoredScore: Math.abs(currentScore - Number(storedUserScore)) <= 0.05,
        status: resultChanges ? 'result-change' : 'stored-score-change',
        blocking: true,
        reason: resultChanges
          ? 'The canonical post-repair score would change the matchup result.'
          : 'The result stays the same, but the canonical post-repair score would differ from the stored matchup score.'
      });
    });

    directByDay.forEach((direct, dayKey) => {
      if (matchupImpactDates.has(dayKey) || matchupsByDay.has(dayKey)) return;
      const currentScore = scoreFromMap(scoreMaps.live, dayKey);
      const projectedScore = scoreFromMap(scoreMaps.projected, dayKey);
      if (Math.abs(currentScore - projectedScore) <= EPSILON) return;
      days.push({
        dayKey,
        pointsRemoved: Number(direct.pointsRemoved.toFixed(4)),
        canonicalScoreChange: Number((currentScore - projectedScore).toFixed(4)),
        currentCompletionScore: currentScore,
        projectedCompletionScore: projectedScore,
        matchupCount: 0,
        status: 'no-matchup',
        blocking: false,
        resultChanges: false,
        reason: 'No stored matchup involving You exists for this date; direct W/L records are unaffected.'
      });
    });

    days.sort((left, right) => String(left.dayKey).localeCompare(String(right.dayKey)));
    const blockingDays = days.filter((day) => day.blocking);
    const resultChangingDays = blockingDays.filter((day) => day.resultChanges === true);
    return {
      days,
      blockingDays,
      resultChangingDays,
      affectedDays: days.length,
      pointsRemoved: Number(plan?.pointsRemoved) || 0,
      hasBlockingImpact: blockingDays.length > 0,
      canonical: true,
      batchedScoreMaps: true,
      includesDateISO: true
    };
  }

  planner.buildHabitLedgerRepairPlan = function canonicalImpactBuild(stateInput) {
    const plan = previousBuild(stateInput);
    return { ...plan, matchupImpact: buildCanonicalImpact(stateInput, plan) };
  };

  planner.applyHabitLedgerRepairPlan = function canonicalImpactApply(stateInput, previewPlan) {
    const livePlan = planner.buildHabitLedgerRepairPlan(stateInput);
    const previewImpact = previewPlan?.matchupImpact;
    if (!previewImpact) {
      throw new Error('The canonical matchup-impact preview is missing. No habit rows were changed.');
    }
    if (impactFingerprint(livePlan.matchupImpact) !== impactFingerprint(previewImpact)) {
      throw new Error(
        'The canonical score or matchup state changed after preview. Run the preview again. No habit rows were changed.'
      );
    }
    if (livePlan.matchupImpact.hasBlockingImpact) {
      throw new Error(
        `${livePlan.matchupImpact.blockingDays.length} canonical matchup impact(s) block this repair. No habit rows were changed.`
      );
    }
    return previousApply(stateInput, previewPlan);
  };

  planner.buildCanonicalHabitLedgerMatchupImpact = buildCanonicalImpact;
  planner.canonicalHabitLedgerImpactFingerprint = impactFingerprint;

  global.TaskPointsCanonicalHabitLedgerMatchupImpact = {
    buildCanonicalImpact,
    buildProjectedState,
    buildCanonicalScoreMap,
    buildCanonicalScoreMaps,
    scoreFromMap,
    canonicalScore,
    impactFingerprint,
    rowDay
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsCanonicalHabitLedgerMatchupImpact;
  }
})(typeof window !== 'undefined' ? window : globalThis);
