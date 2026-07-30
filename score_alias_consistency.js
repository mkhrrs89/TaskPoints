;(function installTaskPointsScoreAliasConsistency(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__scoreAliasConsistencyInstalled) return;
  core.__scoreAliasConsistencyInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const TOLERANCE = 0.05;
  const MAX_SAMPLE_ROWS = 8;
  const originalSaveStateSnapshot = typeof core.saveStateSnapshot === 'function'
    ? core.saveStateSnapshot.bind(core)
    : null;

  const populated = (value) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = (value) => populated(value) && Number.isFinite(Number(value));
  const equalScore = (left, right) => finite(left) && finite(right) && Math.abs(Number(left) - Number(right)) <= TOLERANCE;
  const isYou = (playerId) => String(playerId || '').toUpperCase() === 'YOU';

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function dateKey(row) {
    if (!row || typeof row !== 'object') return '';
    const values = [row.dateKey, row.date, row.completedAtISO, row.finalizedAtISO, row.createdAtISO];
    for (const value of values) {
      if (!populated(value)) continue;
      const text = String(value);
      const direct = text.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    }
    return '';
  }

  function matchupId(row) {
    return String(row?.id || row?.matchupId || '').trim();
  }

  function contextKey(row) {
    if (!row || typeof row !== 'object') return '';
    const values = [
      row.seasonId,
      row.seriesId || row.seasonSeriesId,
      row.roundId,
      row.gameNumber || row.seriesGameNumber,
      row.matchupType
    ];
    return values.some(populated)
      ? values.map((value) => populated(value) ? String(value).trim() : '').join('|')
      : '';
  }

  function historyScore(row) {
    if (finite(row?.score)) return Number(row.score);
    if (!populated(row?.score) && finite(row?.points)) return Number(row.points);
    if (!populated(row?.score) && finite(row?.total)) return Number(row.total);
    return NaN;
  }

  function playerName(state, playerId) {
    if (isYou(playerId)) return state?.youName || 'You';
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((item) => item && String(item.id) === String(playerId));
    return player?.name || String(playerId || 'Unknown');
  }

  function sideFields(side) {
    return side === 'B'
      ? { primaryName: 'scoreB', aliasName: 'playerBScore', playerIdName: 'playerBId' }
      : { primaryName: 'scoreA', aliasName: 'playerAScore', playerIdName: 'playerAId' };
  }

  function sameMatchup(left, right) {
    if (!left || !right) return false;
    const leftId = matchupId(left);
    const rightId = matchupId(right);
    if (leftId && rightId) return leftId === rightId;
    if (dateKey(left) !== dateKey(right)) return false;
    if (String(left.playerAId || '') !== String(right.playerAId || '')) return false;
    if (String(left.playerBId || '') !== String(right.playerBId || '')) return false;
    const leftContext = contextKey(left);
    const rightContext = contextKey(right);
    return !leftContext || !rightContext || leftContext === rightContext;
  }

  function buildHistoryIndex(state) {
    const rows = Array.isArray(state?.gameHistory) ? state.gameHistory : [];
    const byPlayerDate = new Map();
    rows.forEach((row, index) => {
      if (!row || !populated(row.playerId)) return;
      const key = `${dateKey(row)}|${String(row.playerId)}`;
      if (!dateKey(row)) return;
      const item = {
        row,
        index,
        score: historyScore(row),
        matchupId: String(row.matchupId || '').trim(),
        context: contextKey(row)
      };
      if (!byPlayerDate.has(key)) byPlayerDate.set(key, []);
      byPlayerDate.get(key).push(item);
    });
    return byPlayerDate;
  }

  function chooseConfirmingHistory(matchup, playerId, primaryScore, aliasScore, historyIndex) {
    const key = `${dateKey(matchup)}|${String(playerId)}`;
    const candidates = (historyIndex.get(key) || []).filter((item) => Number.isFinite(item.score));
    if (!dateKey(matchup)) return { confirmed: false, reason: 'Matchup has no usable date.', candidates: 0 };
    if (!candidates.length) return { confirmed: false, reason: 'No matching game-history score was found.', candidates: 0 };

    const mid = matchupId(matchup);
    if (mid) {
      const explicit = candidates.filter((item) => item.matchupId && item.matchupId === mid);
      if (explicit.length === 1) {
        return equalScore(explicit[0].score, primaryScore)
          ? { confirmed: true, history: explicit[0], method: 'matchup ID' }
          : { confirmed: false, reason: 'The explicitly linked history row does not confirm the primary score.', candidates: explicit.length };
      }
      if (explicit.length > 1) return { confirmed: false, reason: 'Multiple history rows share the matchup ID.', candidates: explicit.length };
    }

    const context = contextKey(matchup);
    if (context) {
      const contextual = candidates.filter((item) => item.context && item.context === context);
      if (contextual.length === 1) {
        return equalScore(contextual[0].score, primaryScore)
          ? { confirmed: true, history: contextual[0], method: 'series/game context' }
          : { confirmed: false, reason: 'The context-matched history row does not confirm the primary score.', candidates: contextual.length };
      }
      if (contextual.length > 1) return { confirmed: false, reason: 'Multiple history rows share the same series/game context.', candidates: contextual.length };
    }

    const primaryMatches = candidates.filter((item) => equalScore(item.score, primaryScore));
    const aliasMatches = candidates.filter((item) => equalScore(item.score, aliasScore));
    if (primaryMatches.length === 1) {
      return { confirmed: true, history: primaryMatches[0], method: candidates.length === 1 ? 'unique date/player history' : 'unique primary-score match' };
    }
    if (primaryMatches.length > 1) return { confirmed: false, reason: 'More than one history row confirms the primary score.', candidates: primaryMatches.length };
    if (aliasMatches.length) return { confirmed: false, reason: 'Game history agrees with the alias instead of the primary score.', candidates: aliasMatches.length };
    return { confirmed: false, reason: 'Game history confirms neither stored score value.', candidates: candidates.length };
  }

  function buildScoreAliasRepairPlan(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const matchups = Array.isArray(state.matchups) ? state.matchups : [];
    const historyIndex = buildHistoryIndex(state);
    const confirmed = [];
    const uncertain = [];
    let scannedNpcSides = 0;
    let consistentAliasSides = 0;

    matchups.forEach((matchup, matchupIndex) => {
      if (!matchup) return;
      ['A', 'B'].forEach((side) => {
        const fields = sideFields(side);
        const playerId = matchup[fields.playerIdName];
        if (!playerId || isYou(playerId)) return;
        scannedNpcSides += 1;

        const primary = matchup[fields.primaryName];
        const alias = matchup[fields.aliasName];
        if (!populated(alias) || equalScore(primary, alias)) {
          consistentAliasSides += 1;
          return;
        }
        if (!finite(primary) || !finite(alias)) {
          uncertain.push({
            matchupIndex,
            matchupId: matchupId(matchup),
            side,
            playerId: String(playerId),
            playerName: playerName(state, playerId),
            primaryName: fields.primaryName,
            aliasName: fields.aliasName,
            primaryScore: primary,
            aliasScore: alias,
            reason: 'One or both score fields are nonnumeric.'
          });
          return;
        }

        const decision = chooseConfirmingHistory(matchup, playerId, Number(primary), Number(alias), historyIndex);
        const item = {
          matchupIndex,
          matchupId: matchupId(matchup),
          dateKey: dateKey(matchup),
          side,
          playerId: String(playerId),
          playerName: playerName(state, playerId),
          primaryName: fields.primaryName,
          aliasName: fields.aliasName,
          primaryScore: Number(primary),
          aliasScore: Number(alias),
          historyId: String(decision.history?.row?.id || ''),
          confirmationMethod: decision.method || '',
          reason: decision.reason || ''
        };
        if (decision.confirmed) confirmed.push(item);
        else uncertain.push(item);
      });
    });

    return {
      scannedNpcSides,
      consistentAliasSides,
      conflictSides: confirmed.length + uncertain.length,
      confirmed,
      uncertain
    };
  }

  function planFingerprint(plan) {
    return JSON.stringify((plan?.confirmed || []).map((item) => [
      item.matchupId || `#${item.matchupIndex}`,
      item.side,
      Number(item.primaryScore),
      Number(item.aliasScore),
      item.historyId || ''
    ]));
  }

  function updateScheduleCopies(state, sourceMatchup, side, score, options = {}) {
    const fields = sideFields(side);
    let copies = 0;
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => {
      (Array.isArray(day?.matchups) ? day.matchups : []).forEach((candidate) => {
        if (!sameMatchup(candidate, sourceMatchup)) return;
        if (options.updatePrimary === true) candidate[fields.primaryName] = score;
        candidate[fields.aliasName] = score;
        copies += 1;
      });
    });
    return copies;
  }

  function applyScoreAliasRepair(stateInput, planInput = null) {
    const state = clone(stateInput && typeof stateInput === 'object' ? stateInput : {});
    const plan = planInput || buildScoreAliasRepairPlan(state);
    const matchups = Array.isArray(state.matchups) ? state.matchups : [];
    const repairedMatchupIds = new Set();
    let repairedSides = 0;
    let scheduleCopies = 0;
    let skippedStale = 0;

    (plan.confirmed || []).forEach((item) => {
      let matchup = null;
      if (item.matchupId) matchup = matchups.find((candidate) => matchupId(candidate) === item.matchupId) || null;
      if (!matchup) matchup = matchups[item.matchupIndex] || null;
      if (!matchup) { skippedStale += 1; return; }

      const fields = sideFields(item.side);
      const primary = matchup[fields.primaryName];
      const alias = matchup[fields.aliasName];
      if (!equalScore(primary, item.primaryScore) || !equalScore(alias, item.aliasScore)) {
        skippedStale += 1;
        return;
      }

      matchup[fields.aliasName] = Number(primary);
      repairedSides += 1;
      repairedMatchupIds.add(matchupId(matchup) || `#${item.matchupIndex}`);
      scheduleCopies += updateScheduleCopies(state, matchup, item.side, Number(primary));
    });

    return {
      state,
      changed: repairedSides > 0,
      repairedSides,
      repairedMatchups: repairedMatchupIds.size,
      scheduleCopies,
      skippedStale,
      remainingPlan: buildScoreAliasRepairPlan(state)
    };
  }

  function readPersistedState() {
    try {
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return null;
      return core.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function synchronizeChangedEditedScores(stateInput, previousStateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const previous = previousStateInput && typeof previousStateInput === 'object' ? previousStateInput : {};
    const previousById = new Map((Array.isArray(previous.matchups) ? previous.matchups : [])
      .map((matchup, index) => [matchupId(matchup) || `#${index}`, matchup]));
    let synchronizedSides = 0;
    let scheduleCopies = 0;

    (Array.isArray(state.matchups) ? state.matchups : []).forEach((matchup, index) => {
      if (!matchup) return;
      const prior = previousById.get(matchupId(matchup) || `#${index}`);
      if (!prior) return;
      ['A', 'B'].forEach((side) => {
        const fields = sideFields(side);
        const playerId = matchup[fields.playerIdName];
        if (!playerId || isYou(playerId)) return;
        if (!finite(matchup[fields.primaryName]) || !finite(prior[fields.primaryName])) return;
        if (equalScore(matchup[fields.primaryName], prior[fields.primaryName])) return;
        const nextScore = Number(matchup[fields.primaryName]);
        matchup[fields.aliasName] = nextScore;
        synchronizedSides += 1;
        scheduleCopies += updateScheduleCopies(state, matchup, side, nextScore, { updatePrimary: true });
      });
    });

    return { state, changed: synchronizedSides > 0, synchronizedSides, scheduleCopies };
  }

  if (originalSaveStateSnapshot) {
    core.saveStateSnapshot = function saveStateSnapshotWithScoreAliasConsistency(state, options = {}) {
      if (String(options?.savePath || '') === 'matchups-edit-result') {
        const previous = readPersistedState();
        if (previous) synchronizeChangedEditedScores(state, previous);
      }
      return originalSaveStateSnapshot(state, options);
    };
    core.saveStateSnapshot.__taskPointsScoreAliasConsistency = true;
    core.saveStateSnapshot.__taskPointsOriginal = originalSaveStateSnapshot;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function loadCurrentState() {
    try {
      const loaded = core.loadAppState?.();
      return loaded?.state || loaded || readPersistedState() || {};
    } catch (_) {
      return readPersistedState() || {};
    }
  }

  function sampleList(rows, label) {
    if (!rows.length) return `<p class="muted text-sm">${escapeHtml(label)}: 0</p>`;
    const sample = rows.slice(0, MAX_SAMPLE_ROWS).map((item) => (
      `<li>${escapeHtml(item.dateKey || 'Unknown date')} · ${escapeHtml(item.playerName)} · side ${escapeHtml(item.side)}: ` +
      `${escapeHtml(item.aliasName)} ${escapeHtml(item.aliasScore)} → ${escapeHtml(item.primaryScore)}` +
      `${item.reason ? ` · ${escapeHtml(item.reason)}` : ''}</li>`
    )).join('');
    const omitted = rows.length > MAX_SAMPLE_ROWS
      ? `<li class="muted">… ${rows.length - MAX_SAMPLE_ROWS} additional row(s)</li>`
      : '';
    return `<div class="mt-3"><div class="text-sm font-semibold">${escapeHtml(label)} (${rows.length})</div><ul class="text-xs muted mt-2 space-y-1 list-disc pl-5">${sample}${omitted}</ul></div>`;
  }

  function installAuditRepairPanel() {
    const pathname = String(global.location?.pathname || '');
    if (!(pathname.endsWith('/audit.html') || pathname === 'audit.html')) return true;
    const document = global.document;
    if (!document?.createElement) return false;
    if (document.getElementById('scoreAliasRepairPanel')) return true;
    const checks = document.getElementById('auditChecks');
    const main = checks?.closest?.('main') || document.querySelector?.('main');
    if (!main) return false;

    const panel = document.createElement('section');
    panel.id = 'scoreAliasRepairPanel';
    panel.className = 'glass space-y-3';
    panel.innerHTML = `
      <div>
        <div class="text-lg font-semibold">NPC Score-Alias Repair</div>
        <p class="muted text-sm mt-1">Preview stale <code>playerAScore/playerBScore</code> values confirmed by matching game history. Actual matchup scores, history scores, winners, records, Gold, and Season results are never changed.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button id="previewScoreAliasRepairBtn" type="button" class="btn btn-teal">Preview Score-Alias Repair</button>
        <button id="repairScoreAliasesBtn" type="button" class="btn btn-ghost" disabled>Repair Confirmed Score Aliases</button>
      </div>
      <label class="flex items-start gap-2 text-sm">
        <input id="scoreAliasBackupConfirmed" type="checkbox" class="mt-1">
        <span>I exported a fresh full backup of the current phone data.</span>
      </label>
      <div id="scoreAliasRepairStatus" class="rounded-xl border border-zinc-800/60 bg-white/5 dark:bg-zinc-900/35 p-3 text-sm muted">Run the preview before making changes.</div>
    `;
    main.appendChild(panel);

    const previewButton = document.getElementById('previewScoreAliasRepairBtn');
    const repairButton = document.getElementById('repairScoreAliasesBtn');
    const backupCheckbox = document.getElementById('scoreAliasBackupConfirmed');
    const status = document.getElementById('scoreAliasRepairStatus');
    let previewFingerprint = '';
    let previewPlan = null;

    function updateRepairAvailability() {
      repairButton.disabled = !previewPlan?.confirmed?.length || backupCheckbox?.checked !== true;
    }

    function renderPreview(plan) {
      previewPlan = plan;
      previewFingerprint = planFingerprint(plan);
      status.innerHTML = `
        <div class="grid sm:grid-cols-3 gap-2">
          <div><strong>${plan.confirmed.length}</strong><br><span class="muted text-xs">confirmed alias repairs</span></div>
          <div><strong>${plan.uncertain.length}</strong><br><span class="muted text-xs">needs manual review</span></div>
          <div><strong>${plan.consistentAliasSides}</strong><br><span class="muted text-xs">already consistent or alias absent</span></div>
        </div>
        ${sampleList(plan.confirmed, 'Confirmed by game history')}
        ${sampleList(plan.uncertain, 'Skipped because confirmation is unclear')}
      `;
      updateRepairAvailability();
    }

    previewButton?.addEventListener('click', () => {
      renderPreview(buildScoreAliasRepairPlan(loadCurrentState()));
    });
    backupCheckbox?.addEventListener('change', updateRepairAvailability);

    repairButton?.addEventListener('click', () => {
      const currentState = loadCurrentState();
      const freshPlan = buildScoreAliasRepairPlan(currentState);
      if (planFingerprint(freshPlan) !== previewFingerprint) {
        previewPlan = null;
        updateRepairAvailability();
        status.textContent = 'The saved data changed after the preview. Run Preview Score-Alias Repair again before repairing.';
        return;
      }
      if (!freshPlan.confirmed.length) {
        renderPreview(freshPlan);
        return;
      }
      const confirmed = global.confirm?.(
        `Repair ${freshPlan.confirmed.length} confirmed NPC score alias(es)?\n\n` +
        'This keeps scoreA/scoreB and gameHistory unchanged and only replaces stale playerAScore/playerBScore values.'
      );
      if (confirmed === false) return;

      const result = applyScoreAliasRepair(currentState, freshPlan);
      const saved = core.saveStateSnapshot?.(result.state, {
        savePath: 'audit-score-alias-repair',
        userInitiated: true,
        interactive: true,
        immediateWrite: true
      });
      if (!saved || saved.skipped || saved.blockedByQuotaCircuit) {
        status.textContent = 'The repair was not saved. No success was recorded; check Storage Health before retrying.';
        return;
      }

      backupCheckbox.checked = false;
      const postState = saved.state || result.state;
      const postPlan = buildScoreAliasRepairPlan(postState);
      renderPreview(postPlan);
      status.insertAdjacentHTML('afterbegin', `<p class="text-emerald-400 font-semibold mb-2">Repaired ${result.repairedSides} aliases across ${result.repairedMatchups} matchups. Updated ${result.scheduleCopies} schedule copy/copies. Actual matchup scores changed: 0. Stale preview rows skipped: ${result.skippedStale}.</p>`);
      try { global.runAudit?.(); } catch (_) {}
    });

    return true;
  }

  core.buildScoreAliasRepairPlan = buildScoreAliasRepairPlan;
  core.applyScoreAliasRepair = applyScoreAliasRepair;
  core.synchronizeChangedEditedScores = synchronizeChangedEditedScores;
  global.TaskPointsScoreAliasConsistency = {
    buildScoreAliasRepairPlan,
    applyScoreAliasRepair,
    synchronizeChangedEditedScores,
    planFingerprint,
    installAuditRepairPanel
  };

  let installAttempts = 0;
  function installWhenReady() {
    if (installAuditRepairPanel()) return;
    installAttempts += 1;
    if (installAttempts < 120) global.setTimeout?.(installWhenReady, 50);
  }
  if (global.document?.readyState === 'loading') global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  else installWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);
