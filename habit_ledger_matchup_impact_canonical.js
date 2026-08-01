;(function installCanonicalHabitLedgerMatchupImpact(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  const core = global.TaskPointsCore || {};
  if (!planner || planner.__canonicalMatchupImpactInstalled) return;
  planner.__canonicalMatchupImpactInstalled = true;

  const previousBuild = planner.buildHabitLedgerRepairPlan.bind(planner);
  const previousApply = planner.applyHabitLedgerRepairPlan.bind(planner);
  const EPSILON = 0.0001;

  const finite = (value) => Number.isFinite(Number(value));

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
    for (const value of [row.date, row.completedAtISO, row.createdAtISO, row.finalizedAtISO]) {
      if (value == null || value === '') continue;
      const key = localDateKey(value);
      if (key) return key;
    }
    return '';
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

  function canonicalScore(state, dayKey) {
    if (typeof core.buildDaySnapshot !== 'function' || typeof core.computeDayTotals !== 'function') {
      throw new Error('The canonical TaskPoints day scorer is unavailable.');
    }
    const snapshot = core.buildDaySnapshot(dayKey, state);
    const totals = core.computeDayTotals(snapshot);
    if (!finite(totals?.total)) throw new Error(`No canonical score was produced for ${dayKey}.`);
    return Number(totals.total);
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
    const hasConfirmedChanges = changeRows.length > 0;
    const directByDay = new Map();
    changeRows.forEach((item) => {
      if (!validDayKey(item?.dayKey)) return;
      if (!directByDay.has(item.dayKey)) directByDay.set(item.dayKey, { pointsRemoved: 0, changeCount: 0 });
      const entry = directByDay.get(item.dayKey);
      if (finite(item.points)) entry.pointsRemoved += Number(item.points);
      entry.changeCount += 1;
    });

    if (!hasConfirmedChanges) {
      return {
        days: [], blockingDays: [], resultChangingDays: [], affectedDays: 0,
        pointsRemoved: 0, hasBlockingImpact: false, canonical: true
      };
    }

    if (typeof core.buildDaySnapshot !== 'function' || typeof core.computeDayTotals !== 'function') {
      const failure = {
        dayKey: '', pointsRemoved: Number(plan?.pointsRemoved) || 0, matchupCount: 0,
        status: 'analysis-error', blocking: true, resultChanges: null,
        reason: 'The canonical TaskPoints day scorer is unavailable.'
      };
      return {
        days: [failure], blockingDays: [failure], resultChangingDays: [], affectedDays: 1,
        pointsRemoved: Number(plan?.pointsRemoved) || 0, hasBlockingImpact: true, canonical: false
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
      let currentScore;
      let projectedScore;
      try {
        currentScore = canonicalScore(state, dayKey);
        projectedScore = canonicalScore(projectedState, dayKey);
      } catch (error) {
        const failure = {
          dayKey,
          pointsRemoved: Number(directByDay.get(dayKey)?.pointsRemoved || 0),
          matchupCount: matchups.length,
          status: 'analysis-error',
          blocking: true,
          resultChanges: null,
          reason: error.message || String(error)
        };
        days.push(failure);
        matchupImpactDates.add(dayKey);
        return;
      }
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
      const scoreA = matchup.scoreA ?? matchup.playerAScore;
      const scoreB = matchup.scoreB ?? matchup.playerBScore;
      const storedUserScore = youAreA ? scoreA : scoreB;
      const opponentScore = youAreA ? scoreB : scoreA;
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
          reason: 'The stored matchup does not contain two finite final scores.'
        });
        return;
      }
      const beforeResult = resultLabel(storedUserScore, opponentScore);
      const afterResult = resultLabel(projectedScore, opponentScore);
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
        resultChanges: beforeResult !== afterResult,
        baselineDifference: Number((currentScore - Number(storedUserScore)).toFixed(4)),
        baselineMatchesStoredScore: Math.abs(currentScore - Number(storedUserScore)) <= 0.05,
        status: beforeResult !== afterResult ? 'result-change' : 'stored-score-change',
        blocking: true,
        reason: beforeResult !== afterResult
          ? 'The canonical post-repair score would change the matchup result.'
          : 'The result stays the same, but the canonical post-repair score would differ from the stored matchup score.'
      });
    });

    directByDay.forEach((direct, dayKey) => {
      if (matchupImpactDates.has(dayKey) || matchupsByDay.has(dayKey)) return;
      let currentScore = null;
      let projectedScore = null;
      try {
        currentScore = canonicalScore(state, dayKey);
        projectedScore = canonicalScore(projectedState, dayKey);
      } catch (_) {}
      days.push({
        dayKey,
        pointsRemoved: Number(direct.pointsRemoved.toFixed(4)),
        canonicalScoreChange: finite(currentScore) && finite(projectedScore)
          ? Number((Number(currentScore) - Number(projectedScore)).toFixed(4))
          : null,
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
      canonical: true
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
      throw new Error('The canonical score or matchup state changed after preview. Run the preview again. No habit rows were changed.');
    }
    if (livePlan.matchupImpact.hasBlockingImpact) {
      throw new Error(`${livePlan.matchupImpact.blockingDays.length} canonical matchup impact(s) block this repair. No habit rows were changed.`);
    }
    return previousApply(stateInput, previewPlan);
  };

  planner.buildCanonicalHabitLedgerMatchupImpact = buildCanonicalImpact;
  planner.canonicalHabitLedgerImpactFingerprint = impactFingerprint;

  global.TaskPointsCanonicalHabitLedgerMatchupImpact = {
    buildCanonicalImpact,
    buildProjectedState,
    canonicalScore,
    impactFingerprint
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsCanonicalHabitLedgerMatchupImpact;
  }
})(typeof window !== 'undefined' ? window : globalThis);
