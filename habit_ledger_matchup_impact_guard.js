;(function installHabitLedgerMatchupImpactGuard(global) {
  'use strict';

  const planner = global.TaskPointsHabitLedgerRepair;
  if (!planner || planner.__matchupImpactGuardInstalled) return;
  planner.__matchupImpactGuardInstalled = true;

  const core = global.TaskPointsCore || {};
  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const TOLERANCE = 0.05;
  const MAX_SAMPLE_ROWS = 24;
  const originalBuild = planner.buildHabitLedgerRepairPlan.bind(planner);
  const originalApply = planner.applyHabitLedgerRepairPlan.bind(planner);

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  const finite = (value) => populated(value) && Number.isFinite(Number(value));

  function validDayKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
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
    const key = `${year}-${month}-${day}`;
    return validDayKey(key) ? key : '';
  }

  function rowDay(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dayKey, row.dateKey]) {
      const direct = typeof value === 'string' ? value.slice(0, 10) : '';
      if (validDayKey(direct)) return direct;
    }
    if (typeof row.date === 'string' && validDayKey(row.date)) return row.date;
    for (const value of [row.date, row.completedAtISO, row.createdAtISO, row.finalizedAtISO]) {
      if (!populated(value)) continue;
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
    if (playerId === 'YOU') return String(state?.youName || 'You');
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((item) => item && String(item.id) === String(playerId));
    return String(player?.name || player?.playerName || playerId || 'Unknown opponent');
  }

  function completionTotalForDay(state, dayKey) {
    return Number((Array.isArray(state?.completions) ? state.completions : [])
      .reduce((sum, row) => {
        if (rowDay(row) !== dayKey || !finite(row?.points)) return sum;
        return sum + Number(row.points);
      }, 0).toFixed(4));
  }

  function buildHabitLedgerMatchupImpact(stateInput, planInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const plan = planInput && typeof planInput === 'object' ? planInput : {};
    const removals = []
      .concat(Array.isArray(plan.failedDateRemovals) ? plan.failedDateRemovals : [])
      .concat(Array.isArray(plan.duplicateRemovals) ? plan.duplicateRemovals : [])
      .filter((item) => validDayKey(item?.dayKey) && finite(item?.points) && Math.abs(Number(item.points)) > TOLERANCE);

    const byDay = new Map();
    removals.forEach((item) => {
      const dayKey = item.dayKey;
      if (!byDay.has(dayKey)) {
        byDay.set(dayKey, {
          dayKey,
          pointsRemoved: 0,
          removalCount: 0,
          completionIds: [],
          removalTypes: []
        });
      }
      const day = byDay.get(dayKey);
      day.pointsRemoved += Number(item.points);
      day.removalCount += 1;
      day.completionIds.push(String(item.completionId || ''));
      day.removalTypes.push(
        (plan.failedDateRemovals || []).includes(item) ? 'failed-date' : 'duplicate'
      );
    });

    const matchups = Array.isArray(state.matchups) ? state.matchups : [];
    const days = [...byDay.values()].map((day) => {
      day.pointsRemoved = Number(day.pointsRemoved.toFixed(4));
      const candidates = matchups.filter((matchup) =>
        matchup && rowDay(matchup) === day.dayKey
        && (matchup.playerAId === 'YOU' || matchup.playerBId === 'YOU')
      );
      const currentCompletionScore = completionTotalForDay(state, day.dayKey);
      const projectedCompletionScore = Number((currentCompletionScore - day.pointsRemoved).toFixed(4));

      if (!candidates.length) {
        return {
          ...day,
          currentCompletionScore,
          projectedCompletionScore,
          matchupCount: 0,
          status: 'no-matchup',
          blocking: false,
          resultChanges: false,
          reason: 'No stored matchup involving You exists for this date; win/loss records are unaffected.'
        };
      }

      if (candidates.length !== 1) {
        return {
          ...day,
          currentCompletionScore,
          projectedCompletionScore,
          matchupCount: candidates.length,
          status: 'ambiguous-matchups',
          blocking: true,
          resultChanges: null,
          reason: `${candidates.length} stored matchups involving You exist for this date.`
        };
      }

      const matchup = candidates[0];
      const youAreA = matchup.playerAId === 'YOU';
      const scoreA = populated(matchup.scoreA) ? matchup.scoreA : matchup.playerAScore;
      const scoreB = populated(matchup.scoreB) ? matchup.scoreB : matchup.playerBScore;
      const userScore = youAreA ? scoreA : scoreB;
      const opponentScore = youAreA ? scoreB : scoreA;
      const opponentId = youAreA ? matchup.playerBId : matchup.playerAId;
      if (!finite(userScore) || !finite(opponentScore)) {
        return {
          ...day,
          currentCompletionScore,
          projectedCompletionScore,
          matchupCount: 1,
          matchupId: String(matchup.id || matchup.matchupId || ''),
          opponentId,
          opponentName: playerName(state, opponentId),
          storedUserScore: finite(userScore) ? Number(userScore) : null,
          opponentScore: finite(opponentScore) ? Number(opponentScore) : null,
          status: 'missing-matchup-score',
          blocking: true,
          resultChanges: null,
          reason: 'The stored matchup does not contain two finite final scores.'
        };
      }

      const storedUserScore = Number(userScore);
      const storedOpponentScore = Number(opponentScore);
      const projectedUserScore = Number((storedUserScore - day.pointsRemoved).toFixed(4));
      const beforeResult = resultLabel(storedUserScore, storedOpponentScore);
      const afterResult = resultLabel(projectedUserScore, storedOpponentScore);
      const resultChanges = beforeResult !== afterResult;
      const baselineDifference = Number((currentCompletionScore - storedUserScore).toFixed(4));

      return {
        ...day,
        currentCompletionScore,
        projectedCompletionScore,
        matchupCount: 1,
        matchupId: String(matchup.id || matchup.matchupId || ''),
        opponentId,
        opponentName: playerName(state, opponentId),
        storedUserScore,
        projectedUserScore,
        opponentScore: storedOpponentScore,
        beforeResult,
        afterResult,
        resultChanges,
        baselineDifference,
        baselineMatchesStoredScore: Math.abs(baselineDifference) <= TOLERANCE,
        status: resultChanges ? 'result-change' : 'stored-score-change',
        blocking: true,
        reason: resultChanges
          ? 'Removing these completion points would change the matchup result.'
          : 'The result stays the same, but the stored matchup score would no longer match the corrected daily score.'
      };
    }).sort((left, right) => left.dayKey.localeCompare(right.dayKey));

    const blockingDays = days.filter((day) => day.blocking);
    const resultChangingDays = blockingDays.filter((day) => day.resultChanges === true);
    return {
      days,
      blockingDays,
      resultChangingDays,
      affectedDays: days.length,
      pointsRemoved: Number(days.reduce((sum, day) => sum + day.pointsRemoved, 0).toFixed(4)),
      hasBlockingImpact: blockingDays.length > 0
    };
  }

  planner.buildHabitLedgerRepairPlan = function guardedBuild(stateInput) {
    const plan = originalBuild(stateInput);
    return {
      ...plan,
      matchupImpact: buildHabitLedgerMatchupImpact(stateInput, plan)
    };
  };

  planner.applyHabitLedgerRepairPlan = function guardedApply(stateInput, previewPlan) {
    const liveBasePlan = originalBuild(stateInput);
    const impact = buildHabitLedgerMatchupImpact(stateInput, liveBasePlan);
    if (impact.hasBlockingImpact) {
      throw new Error(
        `${impact.blockingDays.length} matchup day(s) would have a stored-score or win/loss impact. ` +
        'No habit rows were changed.'
      );
    }
    return originalApply(stateInput, previewPlan);
  };

  planner.buildHabitLedgerMatchupImpact = buildHabitLedgerMatchupImpact;

  function readStoredState(fallback = null) {
    if (typeof core.readTaskPointsStoredState === 'function') {
      const decoded = core.readTaskPointsStoredState(STORAGE_KEY, fallback);
      return decoded && typeof decoded === 'object' ? decoded : fallback;
    }
    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    if (typeof core.parseTaskPointsStorageJson === 'function') {
      const decoded = core.parseTaskPointsStorageJson(raw, fallback || {});
      return decoded && typeof decoded === 'object' ? decoded : fallback;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.__taskpointsStorageEncoding || parsed?.__taskpointsPacked) {
      throw new Error('Optimized TaskPoints storage requires the shared storage decoder.');
    }
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatScore(value) {
    return finite(value) ? String(Number(Number(value).toFixed(2))) : 'unknown';
  }

  function installImpactPanel() {
    const panel = global.document?.getElementById('habitLedgerRepairPanel');
    if (!panel || global.document.getElementById('habitLedgerMatchupImpact')) return false;
    const repairButton = panel.querySelector('#applyHabitLedgerRepairBtn');
    const previewButton = panel.querySelector('#previewHabitLedgerRepairBtn');
    const backupCheckbox = panel.querySelector('#habitLedgerBackupConfirmed');
    const status = panel.querySelector('#habitLedgerRepairStatus');
    const pointsImpact = panel.querySelector('#habitLedgerPointsImpact');
    if (!repairButton || !previewButton || !backupCheckbox || !status) return false;

    const wrapper = global.document.createElement('div');
    wrapper.id = 'habitLedgerMatchupImpact';
    wrapper.innerHTML = `
      <div id="habitLedgerMatchupImpactCount" class="font-semibold">Matchup-impact check: run the preview.</div>
      <div id="habitLedgerMatchupImpactStatus" class="muted text-sm mt-1">
        Proposed point removals will be compared with stored matchups involving You.
      </div>
      <div id="habitLedgerMatchupImpactRows"></div>
    `;
    if (pointsImpact?.parentNode) pointsImpact.parentNode.insertBefore(wrapper, pointsImpact.nextSibling);
    else panel.appendChild(wrapper);

    let latestImpact = null;
    const impactCount = wrapper.querySelector('#habitLedgerMatchupImpactCount');
    const impactStatus = wrapper.querySelector('#habitLedgerMatchupImpactStatus');
    const impactRows = wrapper.querySelector('#habitLedgerMatchupImpactRows');

    function enforceBlocking() {
      const blocked = Boolean(latestImpact?.hasBlockingImpact);
      repairButton.dataset.matchupImpactBlocked = blocked ? 'true' : 'false';
      if (blocked) repairButton.disabled = true;
    }

    function renderImpact(impact) {
      latestImpact = impact;
      impactCount.textContent =
        `Matchup-impact check: ${impact.affectedDays} score-changing day(s), ` +
        `${impact.blockingDays.length} blocked, ${impact.resultChangingDays.length} result change(s)`;

      if (!impact.days.length) {
        impactStatus.textContent = 'No proposed cleanup changes completion points, so matchup scores and records are unaffected.';
        impactRows.innerHTML = '<div class="muted text-sm mt-1">None.</div>';
        enforceBlocking();
        return;
      }

      impactStatus.textContent = impact.hasBlockingImpact
        ? 'Repair is blocked. Resolve every stored-matchup impact before removing completion points.'
        : 'No stored matchup involving You is affected; the listed daily score history can be corrected without changing W/L records.';

      const shown = impact.days.slice(0, MAX_SAMPLE_ROWS).map((day) => {
        if (day.status === 'no-matchup') {
          return `<li><strong>${escapeHtml(day.dayKey)}</strong>: remove ${formatScore(day.pointsRemoved)} point(s); ` +
            `completion total ${formatScore(day.currentCompletionScore)} → ${formatScore(day.projectedCompletionScore)}. ` +
            'No stored matchup involving You; W/L unaffected.</li>';
        }
        if (day.status === 'ambiguous-matchups') {
          return `<li><strong>${escapeHtml(day.dayKey)}</strong>: remove ${formatScore(day.pointsRemoved)} point(s); ` +
            `${day.matchupCount} stored matchups involving You. <strong>BLOCKED</strong>.</li>`;
        }
        if (day.status === 'missing-matchup-score') {
          return `<li><strong>${escapeHtml(day.dayKey)}</strong> vs ${escapeHtml(day.opponentName)}: ` +
            `remove ${formatScore(day.pointsRemoved)} point(s), but the stored matchup score is incomplete. <strong>BLOCKED</strong>.</li>`;
        }
        const resultText = day.resultChanges
          ? `${escapeHtml(day.beforeResult)} → ${escapeHtml(day.afterResult)}`
          : `${escapeHtml(day.beforeResult)} remains ${escapeHtml(day.afterResult)}`;
        const baseline = day.baselineMatchesStoredScore
          ? ''
          : ` Completion ledger currently differs from stored score by ${formatScore(day.baselineDifference)}.`;
        return `<li><strong>${escapeHtml(day.dayKey)}</strong> vs ${escapeHtml(day.opponentName)}: ` +
          `stored score ${formatScore(day.storedUserScore)} → ${formatScore(day.projectedUserScore)}, ` +
          `opponent ${formatScore(day.opponentScore)}; result ${resultText}. ` +
          `<strong>BLOCKED</strong>.${escapeHtml(baseline)}</li>`;
      }).join('');
      const omitted = impact.days.length > MAX_SAMPLE_ROWS
        ? `<li class="muted">… ${impact.days.length - MAX_SAMPLE_ROWS} more</li>`
        : '';
      impactRows.innerHTML =
        `<ul class="text-sm space-y-1 mt-2" style="padding-left:1.25rem;list-style:disc">${shown}${omitted}</ul>`;
      enforceBlocking();
    }

    function refreshImpact() {
      try {
        const state = readStoredState(null);
        if (!state) throw new Error('No TaskPoints state was found in storage.');
        const plan = planner.buildHabitLedgerRepairPlan(state);
        renderImpact(plan.matchupImpact || buildHabitLedgerMatchupImpact(state, plan));
        if (latestImpact.hasBlockingImpact) {
          status.textContent =
            `Preview blocked: ${latestImpact.blockingDays.length} matchup day(s) would have a stored-score impact; ` +
            `${latestImpact.resultChangingDays.length} would change a win/loss/tie result. No repair can run yet.`;
        }
      } catch (error) {
        latestImpact = {
          days: [], blockingDays: [{ reason: String(error?.message || error) }],
          resultChangingDays: [], affectedDays: 0, hasBlockingImpact: true
        };
        impactCount.textContent = 'Matchup-impact check failed';
        impactStatus.textContent = `Repair is blocked: ${error.message || error}`;
        impactRows.innerHTML = '';
        enforceBlocking();
      }
    }

    previewButton.addEventListener('click', () => {
      latestImpact = null;
      repairButton.dataset.matchupImpactBlocked = 'pending';
      repairButton.disabled = true;
      global.queueMicrotask ? global.queueMicrotask(refreshImpact) : setTimeout(refreshImpact, 0);
    });

    backupCheckbox.addEventListener('change', () => {
      global.queueMicrotask ? global.queueMicrotask(enforceBlocking) : setTimeout(enforceBlocking, 0);
    });

    repairButton.addEventListener('click', (event) => {
      if (!latestImpact?.hasBlockingImpact) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      repairButton.disabled = true;
      status.textContent =
        `Repair blocked: ${latestImpact.blockingDays.length} matchup day(s) require a separate score/result decision first.`;
    }, true);

    return true;
  }

  const tryInstall = () => installImpactPanel();
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', tryInstall, { once: true });
  } else if (global.document) {
    tryInstall();
  }

  const api = {
    buildHabitLedgerMatchupImpact,
    resultLabel,
    rowDay,
    installImpactPanel
  };
  global.TaskPointsHabitLedgerMatchupImpact = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
