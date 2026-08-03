;(function installHabitLedgerScoreReconciliation(global) {
  'use strict';

  if (global.TaskPointsHabitLedgerScoreReconciliation?.installed) return;

  const EPSILON = 0.0001;
  const STORAGE_KEY = global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const SCORE_FIELDS = new Set([
    'scoreA', 'scoreB', 'playerAScore', 'playerBScore',
    'score', 'points', 'total'
  ]);

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = (value) => populated(value) && Number.isFinite(Number(value));
  const isYou = (value) => String(value || '').toUpperCase() === 'YOU';

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function validDayKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function localDayKey(value, core = global.TaskPointsCore || {}) {
    if (!populated(value)) return '';
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

  function rowDay(row, core = global.TaskPointsCore || {}) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dayKey, row.dateKey]) {
      if (validDayKey(value)) return value;
    }
    if (validDayKey(row.date)) return row.date;
    for (const value of [
      row.date,
      row.dateISO,
      row.completedAtISO,
      row.finalizedAtISO,
      row.createdAtISO,
      row.recordedAtISO
    ]) {
      const key = localDayKey(value, core);
      if (key) return key;
    }
    return '';
  }

  function matchupId(row) {
    return String(row?.matchupId || row?.id || row?.gameId || '').trim();
  }

  function seriesId(row) {
    return String(row?.seasonSeriesId || row?.seriesId || '').trim();
  }

  function gameNumber(row) {
    const value = Number(row?.seriesGameNumber || row?.gameNumber || row?.game);
    return Number.isFinite(value) ? value : null;
  }

  function sideScore(row, side) {
    const primary = row?.[side === 'B' ? 'scoreB' : 'scoreA'];
    const alias = row?.[side === 'B' ? 'playerBScore' : 'playerAScore'];
    if (finite(primary)) return Number(primary);
    if (finite(alias)) return Number(alias);
    return null;
  }

  function resultLabel(userScore, opponentScore) {
    if (!finite(userScore) || !finite(opponentScore)) return 'Unknown';
    const user = Number(userScore);
    const opponent = Number(opponentScore);
    if (Math.abs(user - opponent) <= EPSILON) return 'Tie';
    return user > opponent ? 'Win' : 'Loss';
  }

  function sameMatchup(left, right, core = global.TaskPointsCore || {}) {
    if (!left || !right) return false;
    const leftId = matchupId(left);
    const rightId = matchupId(right);
    if (leftId && rightId) return leftId === rightId;
    if (rowDay(left, core) !== rowDay(right, core)) return false;
    if (String(left.playerAId || '') !== String(right.playerAId || '')) return false;
    if (String(left.playerBId || '') !== String(right.playerBId || '')) return false;
    const leftSeries = seriesId(left);
    const rightSeries = seriesId(right);
    if (leftSeries && rightSeries && leftSeries !== rightSeries) return false;
    const leftGame = gameNumber(left);
    const rightGame = gameNumber(right);
    return leftGame == null || rightGame == null || leftGame === rightGame;
  }

  function canonicalTotals(state, core = global.TaskPointsCore || {}) {
    if (typeof core.youDailyTotalsWithInertia !== 'function') {
      throw new Error('The canonical TaskPoints day scorer is unavailable.');
    }
    const raw = core.youDailyTotalsWithInertia(state || {});
    if (!raw || typeof raw !== 'object') {
      throw new Error('The canonical TaskPoints day scorer returned no totals.');
    }
    const totals = new Map();
    Object.entries(raw).forEach(([dayKey, value]) => {
      if (validDayKey(dayKey) && finite(value)) totals.set(dayKey, Number(value));
    });
    return totals;
  }

  function scoreFromMap(map, dayKey) {
    const value = map.get(dayKey);
    return finite(value) ? Number(value) : 0;
  }

  function simulateFullRepair(state, fullPlan, dependencies = {}) {
    const planner = dependencies.planner || global.TaskPointsHabitLedgerRepair;
    const repair = dependencies.repair || global.TaskPointsCompletionBackedHabitRepair;
    if (!planner || !repair || typeof repair.applyPlan !== 'function') {
      throw new Error('The full Habit-Ledger repair is unavailable.');
    }
    if (typeof planner.__habitLedgerBaseApply !== 'function') {
      throw new Error('The verified base Habit-Ledger apply function is unavailable.');
    }

    const wrappedApply = planner.applyHabitLedgerRepairPlan;
    try {
      planner.applyHabitLedgerRepairPlan = planner.__habitLedgerBaseApply;
      return repair.applyPlan(state, fullPlan);
    } finally {
      planner.applyHabitLedgerRepairPlan = wrappedApply;
    }
  }

  function historyRowsForMatchup(state, matchup, core) {
    const rows = Array.isArray(state?.gameHistory) ? state.gameHistory : [];
    const mid = matchupId(matchup);
    const dayKey = rowDay(matchup, core);
    const opponentId = isYou(matchup.playerAId) ? matchup.playerBId : matchup.playerAId;
    const matches = [];
    const seen = new Set();

    rows.forEach((row) => {
      if (!isYou(row?.playerId)) return;
      const rowMatchupId = String(row?.matchupId || '').trim();
      const explicitMatch = Boolean(mid && rowMatchupId === mid);
      const compatibleLegacy = !rowMatchupId
        && rowDay(row, core) === dayKey
        && (!populated(row?.opponentId)
          || !populated(opponentId)
          || String(row.opponentId) === String(opponentId));
      if (!explicitMatch && !compatibleLegacy) return;
      if (seen.has(row)) return;
      seen.add(row);
      matches.push(row);
    });

    return matches;
  }

  function projectedChangeRows(state, projectedState, dependencies = {}) {
    const core = dependencies.core || global.TaskPointsCore || {};
    const liveTotals = canonicalTotals(state, core);
    const projectedTotals = canonicalTotals(projectedState, core);
    const days = [...new Set([...liveTotals.keys(), ...projectedTotals.keys()])].sort();
    return days
      .map((dayKey) => ({
        dayKey,
        fromScore: scoreFromMap(liveTotals, dayKey),
        toScore: scoreFromMap(projectedTotals, dayKey)
      }))
      .filter((row) => Math.abs(row.fromScore - row.toScore) > EPSILON);
  }

  function buildReconciliationPlan(stateInput, dependencies = {}) {
    const core = dependencies.core || global.TaskPointsCore || {};
    const repair = dependencies.repair || global.TaskPointsCompletionBackedHabitRepair;
    if (!repair || typeof repair.buildPlan !== 'function') {
      throw new Error('The full completion-backed Habit-Ledger repair is unavailable.');
    }

    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const fullPlan = repair.buildPlan(state);
    const projectedResult = simulateFullRepair(clone(state), fullPlan, dependencies);
    const projectedState = projectedResult?.state;
    if (!projectedState) throw new Error('The full Habit-Ledger repair preview produced no state.');

    const changes = projectedChangeRows(state, projectedState, dependencies);
    const matchups = Array.isArray(state.matchups) ? state.matchups : [];
    const scoreUpdates = [];
    const noMatchupDays = [];
    const blockingIssues = [];

    changes.forEach((change) => {
      const candidates = matchups.filter((row) =>
        row && rowDay(row, core) === change.dayKey
        && (isYou(row.playerAId) || isYou(row.playerBId))
      );
      if (!candidates.length) {
        noMatchupDays.push(change);
        return;
      }
      if (candidates.length !== 1) {
        blockingIssues.push({
          dayKey: change.dayKey,
          type: 'ambiguous-matchups',
          reason: `${candidates.length} stored matchups involving You exist for this date.`
        });
        return;
      }

      const matchup = candidates[0];
      const side = isYou(matchup.playerAId) ? 'A' : 'B';
      const opponentSide = side === 'A' ? 'B' : 'A';
      const storedUserScore = sideScore(matchup, side);
      const opponentScore = sideScore(matchup, opponentSide);
      const beforeResult = resultLabel(storedUserScore, opponentScore);
      const afterResult = resultLabel(change.toScore, opponentScore);
      const mid = matchupId(matchup);

      if (!mid || !finite(storedUserScore) || !finite(opponentScore)) {
        blockingIssues.push({
          dayKey: change.dayKey,
          matchupId: mid,
          type: 'incomplete-matchup',
          reason: 'The stored matchup is missing a stable ID or two finite scores.'
        });
        return;
      }
      if (beforeResult === 'Unknown' || afterResult === 'Unknown' || beforeResult !== afterResult) {
        blockingIssues.push({
          dayKey: change.dayKey,
          matchupId: mid,
          type: 'result-change',
          reason: `The stored result would change from ${beforeResult} to ${afterResult}.`
        });
        return;
      }

      const historyRows = historyRowsForMatchup(state, matchup, core);
      if (historyRows.length > 1) {
        blockingIssues.push({
          dayKey: change.dayKey,
          matchupId: mid,
          type: 'ambiguous-history',
          reason: `${historyRows.length} You gameHistory rows match this matchup.`
        });
        return;
      }

      scoreUpdates.push({
        dayKey: change.dayKey,
        matchupId: mid,
        playerAId: matchup.playerAId,
        playerBId: matchup.playerBId,
        seriesId: seriesId(matchup),
        gameNumber: gameNumber(matchup),
        side,
        fromScore: Number(storedUserScore),
        liveCanonicalScore: Number(change.fromScore),
        toScore: Number(change.toScore),
        opponentScore: Number(opponentScore),
        beforeResult,
        afterResult,
        historyRowCount: historyRows.length
      });
    });

    const fingerprint = JSON.stringify({
      fullPlan: typeof repair.fingerprint === 'function' ? repair.fingerprint(fullPlan) : fullPlan,
      changes,
      scoreUpdates,
      noMatchupDays,
      blockingIssues
    });

    return {
      fullPlan,
      projectedState,
      projectedResult,
      scoreChanges: changes,
      scoreUpdates,
      noMatchupDays,
      blockingIssues,
      affectedDays: changes.length,
      matchupDays: scoreUpdates.length,
      noMatchupDayCount: noMatchupDays.length,
      resultChanges: blockingIssues.filter((item) => item.type === 'result-change').length,
      canApply: blockingIssues.length === 0,
      fingerprint
    };
  }

  function setYouScore(row, sourceMatchup, newScore) {
    if (!row || typeof row !== 'object') return { row, changed: false };
    const side = isYou(sourceMatchup.playerAId) ? 'A' : 'B';
    const next = { ...row };
    if (side === 'A') {
      next.scoreA = Number(newScore);
      next.playerAScore = Number(newScore);
    } else {
      next.scoreB = Number(newScore);
      next.playerBScore = Number(newScore);
    }
    return { row: next, changed: true };
  }

  function updateHistoryRow(row, newScore) {
    const next = { ...row, score: Number(newScore) };
    if (Object.prototype.hasOwnProperty.call(row, 'points')) next.points = Number(newScore);
    if (Object.prototype.hasOwnProperty.call(row, 'total')) next.total = Number(newScore);
    return next;
  }

  function updateSeasonRecord(row, sourceMatchup, newScore) {
    if (!row || typeof row !== 'object') return row;
    const side = isYou(sourceMatchup.playerAId) ? 'A' : 'B';
    const scoreKey = side === 'A' ? 'scoreA' : 'scoreB';
    const aliasKey = side === 'A' ? 'playerAScore' : 'playerBScore';
    if (!Object.prototype.hasOwnProperty.call(row, scoreKey)
      && !Object.prototype.hasOwnProperty.call(row, aliasKey)) return row;
    return { ...row, [scoreKey]: Number(newScore), [aliasKey]: Number(newScore) };
  }

  function updateSeasonTree(value, sourceMatchup, newScore, core, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return { value, changed: 0 };
    if (seen.has(value)) return { value, changed: 0 };
    seen.add(value);

    if (Array.isArray(value)) {
      let changed = 0;
      const next = value.map((item) => {
        const updated = updateSeasonTree(item, sourceMatchup, newScore, core, seen);
        changed += updated.changed;
        return updated.value;
      });
      return { value: changed ? next : value, changed };
    }

    if ((populated(value.playerAId) || populated(value.playerBId))
      && sameMatchup(value, sourceMatchup, core)) {
      const updated = updateSeasonRecord(value, sourceMatchup, newScore);
      if (updated !== value) return { value: updated, changed: 1 };
    }

    let changed = 0;
    const next = { ...value };
    Object.keys(value).forEach((key) => {
      const child = value[key];
      if (!child || typeof child !== 'object') return;
      const updated = updateSeasonTree(child, sourceMatchup, newScore, core, seen);
      if (updated.changed) {
        next[key] = updated.value;
        changed += updated.changed;
      }
    });
    return { value: changed ? next : value, changed };
  }

  function stripAllowedScoreChanges(value, path = '') {
    if (Array.isArray(value)) return value.map((item, index) => stripAllowedScoreChanges(item, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return value;
    const next = {};
    Object.keys(value).sort().forEach((key) => {
      const top = path.split(/[.[\]]/).filter(Boolean)[0] || key;
      const ledgerDomain = top === 'habits' || top === 'completions';
      if (ledgerDomain) return;
      const scoreDomain = ['matchups', 'gameHistory', 'schedule', 'currentSeason', 'seasonHistory'].includes(top);
      if (scoreDomain && SCORE_FIELDS.has(key)) return;
      next[key] = stripAllowedScoreChanges(value[key], path ? `${path}.${key}` : key);
    });
    return next;
  }

  function applyReconciliationPlan(stateInput, preview, dependencies = {}) {
    const core = dependencies.core || global.TaskPointsCore || {};
    if (!preview?.canApply) throw new Error('The reconciliation preview contains blocking issues.');

    const livePreview = buildReconciliationPlan(stateInput, dependencies);
    if (livePreview.fingerprint !== preview.fingerprint) {
      throw new Error('The habit, score, or matchup state changed after preview. Run the preview again.');
    }

    const beforeProtected = JSON.stringify(stripAllowedScoreChanges(stateInput));
    const habitResult = simulateFullRepair(clone(stateInput), preview.fullPlan, dependencies);
    let state = clone(habitResult.state);
    const totals = canonicalTotals(state, core);
    let matchupRowsUpdated = 0;
    let scheduleCopiesUpdated = 0;
    let historyRowsUpdated = 0;
    let seasonCopiesUpdated = 0;

    preview.scoreUpdates.forEach((update) => {
      const canonical = scoreFromMap(totals, update.dayKey);
      if (Math.abs(canonical - update.toScore) > EPSILON) {
        throw new Error(`The canonical score for ${update.dayKey} changed after preview.`);
      }

      const indexes = [];
      (state.matchups || []).forEach((row, index) => {
        if (matchupId(row) === update.matchupId) indexes.push(index);
      });
      if (indexes.length !== 1) {
        throw new Error(`Expected one authoritative matchup ${update.matchupId}; found ${indexes.length}.`);
      }
      const source = state.matchups[indexes[0]];
      const side = isYou(source.playerAId) ? 'A' : 'B';
      const opponentSide = side === 'A' ? 'B' : 'A';
      const beforeResult = resultLabel(sideScore(source, side), sideScore(source, opponentSide));
      const afterResult = resultLabel(update.toScore, sideScore(source, opponentSide));
      if (beforeResult !== afterResult || beforeResult !== update.beforeResult) {
        throw new Error(`Updating ${update.dayKey} would change its stored result.`);
      }
      state.matchups[indexes[0]] = setYouScore(source, source, update.toScore).row;
      matchupRowsUpdated += 1;

      state.schedule = (state.schedule || []).map((day) => {
        if (!Array.isArray(day?.matchups)) return day;
        let changed = false;
        const rows = day.matchups.map((candidate) => {
          if (!sameMatchup(candidate, source, core)) return candidate;
          changed = true;
          scheduleCopiesUpdated += 1;
          return setYouScore(candidate, source, update.toScore).row;
        });
        return changed ? { ...day, matchups: rows } : day;
      });

      const historyRows = historyRowsForMatchup(state, source, core);
      if (historyRows.length > 1) {
        throw new Error(`More than one You gameHistory row matches ${update.matchupId}.`);
      }
      if (historyRows.length === 1) {
        const target = historyRows[0];
        state.gameHistory = (state.gameHistory || []).map((row) => {
          if (row !== target) return row;
          historyRowsUpdated += 1;
          return updateHistoryRow(row, update.toScore);
        });
      }

      if (state.currentSeason) {
        const updated = updateSeasonTree(state.currentSeason, source, update.toScore, core);
        state.currentSeason = updated.value;
        seasonCopiesUpdated += updated.changed;
      }
      if (Array.isArray(state.seasonHistory)) {
        const updated = updateSeasonTree(state.seasonHistory, source, update.toScore, core);
        state.seasonHistory = updated.value;
        seasonCopiesUpdated += updated.changed;
      }
    });

    const afterProtected = JSON.stringify(stripAllowedScoreChanges(state));
    if (beforeProtected !== afterProtected) {
      throw new Error('The reconciliation attempted an unapproved change outside Habit-Ledger and score fields.');
    }

    const postTotals = canonicalTotals(state, core);
    preview.scoreUpdates.forEach((update) => {
      const row = (state.matchups || []).find((item) => matchupId(item) === update.matchupId);
      const side = isYou(row?.playerAId) ? 'A' : 'B';
      const actual = sideScore(row, side);
      if (!finite(actual) || Math.abs(Number(actual) - update.toScore) > EPSILON) {
        throw new Error(`The authoritative matchup score for ${update.dayKey} did not reconcile.`);
      }
      if (Math.abs(scoreFromMap(postTotals, update.dayKey) - update.toScore) > EPSILON) {
        throw new Error(`The canonical score for ${update.dayKey} did not persist in the repaired state.`);
      }
    });

    return {
      ...habitResult,
      state,
      scoreDaysChanged: preview.affectedDays,
      matchupRowsUpdated,
      scheduleCopiesUpdated,
      historyRowsUpdated,
      seasonCopiesUpdated
    };
  }

  function readStoredState(core = global.TaskPointsCore || {}, fallback = null) {
    if (typeof core.readTaskPointsStoredState === 'function') {
      return core.readTaskPointsStoredState(STORAGE_KEY, fallback);
    }
    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return typeof core.parseTaskPointsStorageJson === 'function'
      ? core.parseTaskPointsStorageJson(raw, fallback || {})
      : JSON.parse(raw);
  }

  function installPanel() {
    const core = global.TaskPointsCore;
    const repair = global.TaskPointsCompletionBackedHabitRepair;
    const planner = global.TaskPointsHabitLedgerRepair;
    const parent = global.document?.getElementById('completionBackedHabitRepair');
    if (!core || !repair || !planner || !parent) return false;
    if (global.document.getElementById('habitLedgerScoreReconciliation')) return true;

    const backup = global.document.getElementById('habitLedgerBackupConfirmed');
    if (!backup) return false;

    const section = global.document.createElement('div');
    section.id = 'habitLedgerScoreReconciliation';
    section.className = 'border-t border-zinc-700/60 pt-4 mt-4 space-y-3';
    section.innerHTML = `
      <div class="font-semibold">Habit + historical score reconciliation</div>
      <p class="muted text-sm">
        Applies the full Habit-Ledger cleanup and synchronizes every affected historical
        You score, including later inertia changes. Opponent scores and W/L/tie results
        must remain unchanged or the repair stays blocked.
      </p>
      <div class="flex flex-wrap gap-2">
        <button id="previewHabitScoreReconciliationBtn" type="button" class="btn btn-primary">Preview Habit + Score Repair</button>
        <button id="applyHabitScoreReconciliationBtn" type="button" class="btn btn-ghost" disabled>Apply Habit + Score Repair</button>
      </div>
      <div id="habitScoreReconciliationStatus" class="muted text-sm">Run this preview after exporting a fresh backup.</div>
      <div id="habitScoreReconciliationSummary" class="text-sm"></div>
      <div id="habitScoreReconciliationRows" class="text-sm"></div>
    `;
    parent.appendChild(section);

    const previewButton = section.querySelector('#previewHabitScoreReconciliationBtn');
    const applyButton = section.querySelector('#applyHabitScoreReconciliationBtn');
    const status = section.querySelector('#habitScoreReconciliationStatus');
    const summary = section.querySelector('#habitScoreReconciliationSummary');
    const rows = section.querySelector('#habitScoreReconciliationRows');
    let preview = null;

    const escapeHtml = (value) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const displayScore = (value) => Number(Number(value).toFixed(2));
    const updateEnabled = () => {
      applyButton.disabled = !(preview?.canApply && backup.checked && (repair.totalCount?.(preview.fullPlan) || 0) > 0);
    };

    previewButton.addEventListener('click', () => {
      preview = null;
      backup.checked = false;
      updateEnabled();
      try {
        const state = readStoredState(core, null);
        if (!state) throw new Error('No TaskPoints state was found.');
        preview = buildReconciliationPlan(state, { core, planner, repair });
        summary.innerHTML =
          `Habit-Ledger changes: <strong>${repair.totalCount?.(preview.fullPlan) || 0}</strong><br>`
          + `Canonical score-changing days: <strong>${preview.affectedDays}</strong><br>`
          + `Stored matchup scores to synchronize: <strong>${preview.matchupDays}</strong><br>`
          + `Days without a stored You matchup: <strong>${preview.noMatchupDayCount}</strong><br>`
          + `Result changes: <strong>${preview.resultChanges}</strong><br>`
          + `Blocking issues: <strong>${preview.blockingIssues.length}</strong>`;
        const samples = preview.scoreUpdates.slice(0, 24).map((item) =>
          `<li><strong>${escapeHtml(item.dayKey)}</strong>: ${displayScore(item.fromScore)} → ${displayScore(item.toScore)}; ${escapeHtml(item.beforeResult)} remains unchanged.</li>`
        ).join('');
        const omitted = preview.scoreUpdates.length > 24
          ? `<li class="muted">… ${preview.scoreUpdates.length - 24} more matchup score update(s)</li>`
          : '';
        const blockers = preview.blockingIssues.map((item) =>
          `<li><strong>${escapeHtml(item.dayKey || 'Unknown date')}</strong>: ${escapeHtml(item.reason)}</li>`
        ).join('');
        rows.innerHTML = blockers
          ? `<div class="font-semibold mt-2">Blocked</div><ul class="space-y-1 mt-1">${blockers}</ul>`
          : `<div class="font-semibold mt-2">Stored score updates</div><ul class="space-y-1 mt-1">${samples}${omitted}</ul>`;
        status.textContent = preview.canApply
          ? 'Preview verified: all affected stored matchup results remain unchanged. Confirm the fresh backup to apply everything together.'
          : 'Preview blocked. At least one affected matchup cannot be reconciled safely.';
      } catch (error) {
        status.textContent = `Preview failed: ${error.message || error}`;
        summary.innerHTML = '';
        rows.innerHTML = '';
      }
      updateEnabled();
    });

    backup.addEventListener('change', updateEnabled);

    applyButton.addEventListener('click', () => {
      if (!preview?.canApply || !backup.checked) return;
      applyButton.disabled = true;
      try {
        const liveState = readStoredState(core, null);
        if (!liveState) throw new Error('No TaskPoints state was found.');
        const result = applyReconciliationPlan(liveState, preview, { core, planner, repair });
        const saved = core.saveStateSnapshot(result.state, {
          savePath: 'audit-habit-ledger-score-reconciliation',
          source: 'audit-habit-ledger-score-reconciliation',
          userInitiated: true,
          interactive: true,
          immediateWrite: true,
          replaceCompletions: true,
          allowDestructiveOverwrite: true
        });
        if (saved?.blocked || saved?.ok === false || saved?.skipped
          || saved?.blockedByQuotaCircuit || !saved?.state) {
          throw new Error(saved?.reason || saved?.error || 'The reconciled state could not be saved.');
        }

        const persisted = readStoredState(core, null);
        if (!persisted) throw new Error('The reconciled state could not be verified.');
        const remaining = repair.buildPlan(persisted);
        const remainingCount = repair.totalCount?.(remaining) || 0;
        if (remainingCount) throw new Error(`${remainingCount} deterministic Habit-Ledger change(s) did not persist.`);

        result.state.matchups.forEach((expected) => {
          const id = matchupId(expected);
          if (!id || (!isYou(expected.playerAId) && !isYou(expected.playerBId))) return;
          const actual = (persisted.matchups || []).find((row) => matchupId(row) === id);
          if (!actual) return;
          const side = isYou(expected.playerAId) ? 'A' : 'B';
          if (Math.abs(Number(sideScore(expected, side)) - Number(sideScore(actual, side))) > EPSILON) {
            throw new Error(`The persisted score for matchup ${id} did not verify.`);
          }
        });

        status.textContent =
          `Repair saved: ${result.scoreDaysChanged} canonical score-changing day(s), `
          + `${result.matchupRowsUpdated} matchup score(s), ${result.historyRowsUpdated} history row(s), `
          + `${result.scheduleCopiesUpdated} schedule copy/copies, and ${result.seasonCopiesUpdated} Season copy/copies reconciled. Rerun the Audit.`;
        preview = null;
        backup.checked = false;
        summary.innerHTML = '';
        rows.innerHTML = '';
        if (typeof global.runAudit === 'function') {
          try { global.runAudit(); } catch (_) {}
        }
      } catch (error) {
        status.textContent = `Repair failed: ${error.message || error}`;
      }
      updateEnabled();
    });

    return true;
  }

  const api = {
    installed: true,
    buildReconciliationPlan,
    applyReconciliationPlan,
    simulateFullRepair,
    projectedChangeRows,
    sameMatchup,
    rowDay,
    installPanel
  };
  global.TaskPointsHabitLedgerScoreReconciliation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  let attempts = 0;
  const install = () => {
    if (installPanel()) return;
    if (++attempts < 180) global.setTimeout?.(install, 50);
  };
  install();
})(typeof window !== 'undefined' ? window : globalThis);
