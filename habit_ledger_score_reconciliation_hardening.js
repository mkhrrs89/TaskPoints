;(function installHabitLedgerScoreReconciliationHardening(global) {
  'use strict';

  if (global.TaskPointsHabitLedgerScoreReconciliationCopyDomainHardening?.installed) return;

  const EPSILON = 0.0001;
  const STORAGE_KEY = global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = (value) => populated(value) && Number.isFinite(Number(value));
  const isYou = (value) => String(value || '').toUpperCase() === 'YOU';

  function stable(value, seen = new WeakSet()) {
    if (Array.isArray(value)) return value.map((item) => stable(item, seen));
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    Object.keys(value).sort().forEach((key) => {
      const child = value[key];
      if (typeof child !== 'function' && child !== undefined) out[key] = stable(child, seen);
    });
    seen.delete(value);
    return out;
  }

  function matchupId(row) {
    return String(row?.matchupId || row?.id || row?.gameId || '').trim();
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

  function participantContext(value, inherited = null) {
    if (!value || typeof value !== 'object') return inherited;
    const playerAId = String(value.playerAId || '').trim();
    const playerBId = String(value.playerBId || '').trim();
    return playerAId || playerBId ? { playerAId, playerBId } : inherited;
  }

  function sameParticipants(context, matchup) {
    const a = String(context?.playerAId || '').trim();
    const b = String(context?.playerBId || '').trim();
    const sourceA = String(matchup?.playerAId || '').trim();
    const sourceB = String(matchup?.playerBId || '').trim();
    if (!a || !b || !sourceA || !sourceB) return false;
    return (a === sourceA && b === sourceB) || (a === sourceB && b === sourceA);
  }

  function playerlessSeasonRecordMatches(row, matchup, context) {
    if (!row || typeof row !== 'object') return false;
    if (populated(row.playerAId) || populated(row.playerBId)) return false;
    const rowId = String(row.matchupId || '').trim();
    const sourceId = matchupId(matchup);
    return Boolean(rowId && sourceId && rowId === sourceId && sameParticipants(context, matchup));
  }

  function seasonSide(row, matchup, context) {
    if (isYou(row?.playerAId)) return 'A';
    if (isYou(row?.playerBId)) return 'B';
    if (isYou(context?.playerAId)) return 'A';
    if (isYou(context?.playerBId)) return 'B';
    return isYou(matchup?.playerAId) ? 'A' : 'B';
  }

  function hasWritableSeasonScore(row, side) {
    const primary = side === 'B' ? 'scoreB' : 'scoreA';
    const alias = side === 'B' ? 'playerBScore' : 'playerAScore';
    return Object.prototype.hasOwnProperty.call(row || {}, primary)
      || Object.prototype.hasOwnProperty.call(row || {}, alias);
  }

  function collectSeasonCopies(value, matchup, api, core, domain, path, output, seen = new WeakSet(), inherited = null) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => collectSeasonCopies(
        item, matchup, api, core, domain, `${path}[${index}]`, output, seen, inherited
      ));
      return;
    }

    const context = participantContext(value, inherited);
    const hasOwnParticipants = populated(value.playerAId) || populated(value.playerBId);
    const matches = hasOwnParticipants
      ? api.sameMatchup(value, matchup, core)
      : playerlessSeasonRecordMatches(value, matchup, context);
    const side = seasonSide(value, matchup, context);

    if (matches && hasWritableSeasonScore(value, side)) {
      output.push({
        domain,
        path,
        side,
        participants: stable(context || {}),
        record: stable(value)
      });
      return;
    }

    Object.keys(value).sort().forEach((key) => {
      const child = value[key];
      if (!child || typeof child !== 'object') return;
      collectSeasonCopies(child, matchup, api, core, domain, `${path}.${key}`, output, seen, context);
    });
  }

  function historyRowsForSnapshot(state, matchup, api, core) {
    const rows = Array.isArray(state?.gameHistory) ? state.gameHistory : [];
    const id = matchupId(matchup);
    const dayKey = api.rowDay(matchup, core);
    const opponentId = isYou(matchup.playerAId) ? matchup.playerBId : matchup.playerAId;
    return rows.flatMap((row, index) => {
      if (!isYou(row?.playerId)) return [];
      const rowId = String(row?.matchupId || '').trim();
      const exact = Boolean(id && rowId === id);
      const legacy = !rowId
        && api.rowDay(row, core) === dayKey
        && (!populated(row?.opponentId)
          || !populated(opponentId)
          || String(row.opponentId) === String(opponentId));
      return exact || legacy ? [{ domain: 'gameHistory', path: `gameHistory[${index}]`, record: stable(row) }] : [];
    });
  }

  function collectCopyDomainSnapshot(state, scoreUpdates, api, core) {
    const snapshots = [];
    const matchups = Array.isArray(state?.matchups) ? state.matchups : [];

    (scoreUpdates || []).forEach((update) => {
      const sourceIndex = matchups.findIndex((row) => matchupId(row) === update.matchupId);
      const source = sourceIndex >= 0 ? matchups[sourceIndex] : null;
      const copies = [];

      if (source) {
        copies.push({ domain: 'matchups', path: `matchups[${sourceIndex}]`, record: stable(source) });

        (state.schedule || []).forEach((day, dayIndex) => {
          (day?.matchups || []).forEach((row, rowIndex) => {
            if (!api.sameMatchup(row, source, core)) return;
            copies.push({
              domain: 'schedule',
              path: `schedule[${dayIndex}].matchups[${rowIndex}]`,
              record: stable(row)
            });
          });
        });

        copies.push(...historyRowsForSnapshot(state, source, api, core));
        if (state.currentSeason) {
          collectSeasonCopies(state.currentSeason, source, api, core, 'currentSeason', 'currentSeason', copies);
        }
        if (Array.isArray(state.seasonHistory)) {
          collectSeasonCopies(state.seasonHistory, source, api, core, 'seasonHistory', 'seasonHistory', copies);
        }
      }

      snapshots.push({
        matchupId: update.matchupId,
        dayKey: update.dayKey,
        toScore: Number(update.toScore),
        copies: copies.sort((left, right) => left.path.localeCompare(right.path))
      });
    });

    return snapshots.sort((left, right) =>
      String(left.matchupId).localeCompare(String(right.matchupId))
      || String(left.dayKey).localeCompare(String(right.dayKey))
    );
  }

  function copyOutcomeBlockers(copySnapshot) {
    const blockers = [];
    (copySnapshot || []).forEach((entry) => {
      entry.copies.forEach((copy) => {
        if (copy.domain !== 'currentSeason' && copy.domain !== 'seasonHistory') return;
        const side = copy.side;
        const opponentSide = side === 'A' ? 'B' : 'A';
        const userScore = sideScore(copy.record, side);
        const opponentScore = sideScore(copy.record, opponentSide);
        const before = resultLabel(userScore, opponentScore);
        const after = resultLabel(entry.toScore, opponentScore);

        if (before === 'Unknown' || after === 'Unknown') {
          blockers.push({
            dayKey: entry.dayKey,
            matchupId: entry.matchupId,
            type: 'incomplete-season-copy',
            reason: `${copy.path} is missing two finite scores and cannot be reconciled safely.`
          });
        } else if (before !== after) {
          blockers.push({
            dayKey: entry.dayKey,
            matchupId: entry.matchupId,
            type: 'season-copy-result-change',
            reason: `${copy.path} would change from ${before} to ${after}.`
          });
        }
      });
    });
    return blockers;
  }

  function readStoredState(core, fallback = null) {
    if (typeof core?.readTaskPointsStoredState === 'function') {
      return core.readTaskPointsStoredState(STORAGE_KEY, fallback);
    }
    const raw = global.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return typeof core?.parseTaskPointsStorageJson === 'function'
      ? core.parseTaskPointsStorageJson(raw, fallback || {})
      : JSON.parse(raw);
  }

  function installPanel(api) {
    const document = global.document;
    const core = global.TaskPointsCore;
    const repair = global.TaskPointsCompletionBackedHabitRepair;
    const previewOriginal = document?.getElementById?.('previewHabitScoreReconciliationBtn');
    const applyOriginal = document?.getElementById?.('applyHabitScoreReconciliationBtn');
    const backup = document?.getElementById?.('habitLedgerBackupConfirmed');
    const status = document?.getElementById?.('habitScoreReconciliationStatus');
    const summary = document?.getElementById?.('habitScoreReconciliationSummary');
    const rows = document?.getElementById?.('habitScoreReconciliationRows');
    if (!previewOriginal || !applyOriginal || !backup || !status || !summary || !rows || !core || !repair) return false;
    if (previewOriginal.dataset.copyDomainHardened === 'true') return true;

    const previewButton = previewOriginal.cloneNode(true);
    const applyButton = applyOriginal.cloneNode(true);
    previewButton.dataset.copyDomainHardened = 'true';
    applyButton.dataset.copyDomainHardened = 'true';
    previewOriginal.replaceWith(previewButton);
    applyOriginal.replaceWith(applyButton);
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
        preview = api.buildReconciliationPlan(state, {
          core,
          planner: global.TaskPointsHabitLedgerRepair,
          repair
        });
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
          ? 'Preview verified: authoritative and copied Season results remain unchanged. Confirm the fresh backup to apply everything together.'
          : 'Preview blocked. At least one authoritative or copied result cannot be reconciled safely.';
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
        const result = api.applyReconciliationPlan(liveState, preview, {
          core,
          planner: global.TaskPointsHabitLedgerRepair,
          repair
        });
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

  function install() {
    const api = global.TaskPointsHabitLedgerScoreReconciliation;
    if (!api?.installed) return false;
    if (api.__copyDomainHardeningInstalled) return installPanel(api);

    const originalBuild = api.buildReconciliationPlan.bind(api);
    const originalApply = api.applyReconciliationPlan.bind(api);

    api.buildReconciliationPlan = function hardenedBuild(stateInput, dependencies = {}) {
      const base = originalBuild(stateInput, dependencies);
      const core = dependencies.core || global.TaskPointsCore || {};
      const copyDomainSnapshot = collectCopyDomainSnapshot(
        stateInput,
        base.scoreUpdates,
        api,
        core
      );
      const copyBlockers = copyOutcomeBlockers(copyDomainSnapshot);
      const blockingIssues = [...(base.blockingIssues || []), ...copyBlockers];
      const baseFingerprint = base.fingerprint;
      const fingerprint = JSON.stringify(stable({
        baseFingerprint,
        copyDomainSnapshot
      }));
      return {
        ...base,
        baseFingerprint,
        copyDomainSnapshot,
        blockingIssues,
        resultChanges: (Number(base.resultChanges) || 0)
          + copyBlockers.filter((item) => item.type === 'season-copy-result-change').length,
        canApply: blockingIssues.length === 0,
        fingerprint
      };
    };

    api.applyReconciliationPlan = function hardenedApply(stateInput, preview, dependencies = {}) {
      if (!preview?.canApply) throw new Error('The reconciliation preview contains blocking issues.');
      const live = api.buildReconciliationPlan(stateInput, dependencies);
      if (live.fingerprint !== preview.fingerprint) {
        throw new Error('A copied matchup, schedule, history, or Season record changed after preview. Run the preview again.');
      }
      const basePreview = {
        ...preview,
        fingerprint: preview.baseFingerprint,
        blockingIssues: (preview.blockingIssues || []).filter((item) =>
          item.type !== 'season-copy-result-change' && item.type !== 'incomplete-season-copy'
        ),
        canApply: true
      };
      return originalApply(stateInput, basePreview, dependencies);
    };

    api.__copyDomainHardeningInstalled = true;
    api.collectCopyDomainSnapshot = (state, updates, core = global.TaskPointsCore || {}) =>
      collectCopyDomainSnapshot(state, updates, api, core);
    api.validateCopiedSeasonOutcomes = copyOutcomeBlockers;

    global.TaskPointsHabitLedgerScoreReconciliationCopyDomainHardening = {
      installed: true,
      collectCopyDomainSnapshot: api.collectCopyDomainSnapshot,
      validateCopiedSeasonOutcomes: copyOutcomeBlockers,
      installPanel: () => installPanel(api)
    };
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = global.TaskPointsHabitLedgerScoreReconciliationCopyDomainHardening;
    }
    return installPanel(api);
  }

  let attempts = 0;
  const retry = () => {
    if (install()) return;
    if (++attempts < 240) global.setTimeout?.(retry, 50);
  };
  retry();
})(typeof window !== 'undefined' ? window : globalThis);
