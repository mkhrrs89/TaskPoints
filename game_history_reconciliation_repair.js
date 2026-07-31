;(function installTaskPointsGameHistoryRepair(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__gameHistoryReconciliationRepairInstalled) return;
  core.__gameHistoryReconciliationRepairInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const TOLERANCE = 0.05;
  const MAX_SAMPLE_ROWS = 14;

  const CONFIRMED_SCORE_CORRECTIONS = Object.freeze([
    Object.freeze({
      dateKey: '2026-06-14',
      playerId: '358b982e-c494-4c58-815a-d59953742997',
      playerName: 'Verrick',
      storedScore: 62.8,
      matchupScore: 43.2
    }),
    Object.freeze({
      dateKey: '2026-06-24',
      playerId: '05354bdf-f433-4824-981f-45f0d21b0d80',
      playerName: 'Sloane',
      storedScore: 41,
      matchupScore: 27.56
    })
  ]);

  const populated = (value) =>
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');

  const finite = (value) => {
    if (!populated(value)) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric);
  };

  const equalScore = (left, right) =>
    finite(left) && finite(right) && Math.abs(Number(left) - Number(right)) <= TOLERANCE;

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
      const direct = String(value).slice(0, 10);
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

  function sideScore(matchup, side) {
    const primary = matchup?.[side === 'B' ? 'scoreB' : 'scoreA'];
    const alias = matchup?.[side === 'B' ? 'playerBScore' : 'playerAScore'];
    if (finite(primary)) return Number(primary);
    if (!populated(primary) && finite(alias)) return Number(alias);
    return NaN;
  }

  function historyScore(row) {
    if (finite(row?.score)) return Number(row.score);
    if (!populated(row?.score) && finite(row?.points)) return Number(row.points);
    if (!populated(row?.score) && finite(row?.total)) return Number(row.total);
    return NaN;
  }

  function finalized(matchup) {
    if (!matchup) return false;
    if (
      populated(matchup.finalizedAtISO)
      || populated(matchup.completedAtISO)
      || populated(matchup.winnerId)
      || populated(matchup.loserId)
      || populated(matchup.result)
    ) return true;
    return finite(sideScore(matchup, 'A')) && finite(sideScore(matchup, 'B'));
  }

  function playerName(state, playerId) {
    if (isYou(playerId)) return state?.youName || 'You';
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((item) => item && String(item.id) === String(playerId));
    return player?.name || String(playerId || 'Unknown');
  }

  function matchupLabel(matchup, index) {
    const context = [
      matchup?.seasonId,
      matchup?.seriesId || matchup?.seasonSeriesId,
      matchup?.roundId,
      matchup?.gameNumber || matchup?.seriesGameNumber,
      matchup?.matchupType
    ].filter(populated).join(' ');
    return `Matchup ${context || matchupId(matchup) || `#${index + 1}`}`;
  }

  function stableHistoryId(expected) {
    return `audit-history-repair:${expected.matchupId}:${expected.playerId}`;
  }

  function groupByBase(items) {
    const groups = new Map();
    items.forEach((item) => {
      const key = `${item.dateKey}|${item.playerId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return groups;
  }

  function correctionFor(expected, found) {
    return CONFIRMED_SCORE_CORRECTIONS.find((correction) =>
      correction.dateKey === expected.dateKey
      && correction.playerId === expected.playerId
      && equalScore(correction.storedScore, found.score)
      && equalScore(correction.matchupScore, expected.score)
    ) || null;
  }

  function buildGameHistoryRepairPlan(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const expectations = [];
    const histories = [];
    const uncertain = [];
    const duplicateHistoryIds = new Set();
    const seenHistoryIds = new Set();

    (Array.isArray(state.matchups) ? state.matchups : []).forEach((matchup, matchupIndex) => {
      if (!finalized(matchup)) return;
      const day = dateKey(matchup);
      ['A', 'B'].forEach((side) => {
        const playerId = String(matchup?.[side === 'B' ? 'playerBId' : 'playerAId'] || '');
        if (!playerId || isYou(playerId)) return;
        const score = sideScore(matchup, side);
        const opponentId = String(matchup?.[side === 'B' ? 'playerAId' : 'playerBId'] || '');
        const mid = matchupId(matchup);
        const label = `${matchupLabel(matchup, matchupIndex)} side ${side}`;

        if (!day || !finite(score) || !mid || !opponentId) {
          uncertain.push({
            type: 'unusable-matchup',
            dateKey: day,
            playerId,
            playerName: playerName(state, playerId),
            matchupId: mid,
            label,
            reason: 'A finalized NPC matchup side is missing a usable date, score, matchup ID, or opponent.'
          });
          return;
        }

        expectations.push({
          matchup,
          matchupIndex,
          matchupId: mid,
          dateKey: day,
          playerId,
          playerName: playerName(state, playerId),
          opponentId,
          opponentName: playerName(state, opponentId),
          side,
          score: Number(score),
          label,
          context: contextKey(matchup)
        });
      });
    });

    (Array.isArray(state.gameHistory) ? state.gameHistory : []).forEach((row, historyIndex) => {
      if (!row || !populated(row.playerId) || isYou(row.playerId)) return;
      const id = String(row.id || '').trim();
      if (id) {
        if (seenHistoryIds.has(id)) duplicateHistoryIds.add(id);
        seenHistoryIds.add(id);
      }
      histories.push({
        row,
        historyIndex,
        historyId: id,
        matchupId: String(row.matchupId || '').trim(),
        dateKey: dateKey(row),
        playerId: String(row.playerId),
        playerName: playerName(state, row.playerId),
        opponentId: String(row.opponentId || ''),
        score: historyScore(row),
        context: contextKey(row)
      });
    });

    duplicateHistoryIds.forEach((historyId) => {
      uncertain.push({
        type: 'duplicate-history-id',
        historyId,
        reason: `More than one gameHistory row uses ID ${historyId}.`
      });
    });

    const expectedGroups = groupByBase(expectations);
    const historyGroups = groupByBase(histories.filter((item) => item.dateKey));
    const usedHistories = new Set();
    const matched = [];
    const missingRows = [];
    const ambiguousBases = new Set();
    const reportedIdConflicts = new Set();

    function consume(expected, found, method) {
      usedHistories.add(found);
      matched.push({ expected, found, method });
    }

    new Set([...expectedGroups.keys(), ...historyGroups.keys()]).forEach((key) => {
      const expectedRows = expectedGroups.get(key) || [];
      const historyRows = historyGroups.get(key) || [];
      const remainingExpected = new Set(expectedRows);
      const remainingHistory = new Set(historyRows);

      function reportIdConflict(expected, found) {
        const conflictKey = `${expected.matchupId}|${found.matchupId}|${expected.playerId}|${expected.dateKey}`;
        if (reportedIdConflicts.has(conflictKey)) return;
        reportedIdConflicts.add(conflictKey);
        uncertain.push({
          type: 'explicit-id-conflict',
          dateKey: expected.dateKey,
          playerId: expected.playerId,
          playerName: expected.playerName,
          matchupId: expected.matchupId,
          historyId: found.historyId,
          historyMatchupId: found.matchupId,
          reason: 'The matchup and history row have different explicit matchup IDs.'
        });
      }

      function pair(expected, found, method) {
        if (!remainingExpected.has(expected) || !remainingHistory.has(found)) return false;
        if (expected.matchupId && found.matchupId && expected.matchupId !== found.matchupId) {
          reportIdConflict(expected, found);
          return false;
        }
        remainingExpected.delete(expected);
        remainingHistory.delete(found);
        consume(expected, found, method);
        return true;
      }

      expectedRows.forEach((expected) => {
        if (!remainingExpected.has(expected)) return;
        const idMatches = [...remainingHistory]
          .filter((found) => found.matchupId && found.matchupId === expected.matchupId);
        if (idMatches.length === 1) pair(expected, idMatches[0], 'matchup ID');
        else if (idMatches.length > 1) {
          uncertain.push({
            type: 'duplicate-explicit-link',
            dateKey: expected.dateKey,
            playerId: expected.playerId,
            playerName: expected.playerName,
            matchupId: expected.matchupId,
            reason: `${idMatches.length} gameHistory rows share this matchup ID.`
          });
          remainingExpected.delete(expected);
          idMatches.forEach((found) => {
            remainingHistory.delete(found);
            usedHistories.add(found);
          });
        }
      });

      function matchUnique(predicate, method) {
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const expected of [...remainingExpected]) {
            const candidates = [...remainingHistory].filter((found) => predicate(expected, found));
            if (candidates.length !== 1) continue;
            const candidate = candidates[0];
            const reverse = [...remainingExpected].filter((other) => predicate(other, candidate));
            if (reverse.length !== 1) continue;
            if (pair(expected, candidate, method)) progressed = true;
          }
        }
      }

      matchUnique(
        (expected, found) => Boolean(expected.context && found.context && expected.context === found.context),
        'series/game context'
      );
      matchUnique(
        (expected, found) =>
          Boolean(expected.opponentId && found.opponentId && expected.opponentId === found.opponentId),
        'opponent'
      );
      matchUnique(
        (expected, found) => finite(found.score) && equalScore(expected.score, found.score),
        'unique score'
      );

      if (remainingExpected.size === 1 && remainingHistory.size === 1) {
        const expected = [...remainingExpected][0];
        const found = [...remainingHistory][0];
        if (!pair(expected, found, 'single remaining row')
          && expected.matchupId && found.matchupId && expected.matchupId !== found.matchupId) {
          remainingExpected.delete(expected);
        }
      }

      if (remainingExpected.size && remainingHistory.size) {
        ambiguousBases.add(key);
        uncertain.push({
          type: 'ambiguous-player-date',
          dateKey: key.split('|')[0],
          playerId: key.slice(key.indexOf('|') + 1),
          playerName: expectedRows[0]?.playerName || historyRows[0]?.playerName || '',
          reason: `${remainingExpected.size} matchup side(s) and ${remainingHistory.size} history row(s) remain ambiguous for the same player/date.`
        });
        return;
      }

      if (remainingExpected.size && !remainingHistory.size) {
        remainingExpected.forEach((expected) => {
          missingRows.push({
            ...expected,
            historyId: stableHistoryId(expected),
            source: 'audit-game-history-repair'
          });
        });
      }
    });

    const confirmedScoreUpdates = [];
    matched.forEach(({ expected, found, method }) => {
      if (!finite(found.score) || equalScore(expected.score, found.score)) return;
      const correction = correctionFor(expected, found);
      if (!correction) {
        uncertain.push({
          type: 'unconfirmed-score-mismatch',
          dateKey: expected.dateKey,
          playerId: expected.playerId,
          playerName: expected.playerName,
          matchupId: expected.matchupId,
          historyId: found.historyId,
          historyIndex: found.historyIndex,
          storedScore: found.score,
          matchupScore: expected.score,
          method,
          reason: 'This mismatch is not one of the two user-confirmed historical corrections.'
        });
        return;
      }
      confirmedScoreUpdates.push({
        dateKey: expected.dateKey,
        playerId: expected.playerId,
        playerName: correction.playerName,
        opponentId: expected.opponentId,
        opponentName: expected.opponentName,
        matchupId: expected.matchupId,
        historyId: found.historyId,
        historyIndex: found.historyIndex,
        storedScore: Number(found.score),
        matchupScore: Number(expected.score),
        method
      });
    });

    const orphanRows = histories.filter((found) =>
      !usedHistories.has(found)
      && !ambiguousBases.has(`${found.dateKey}|${found.playerId}`)
    );

    confirmedScoreUpdates.sort((a, b) =>
      a.dateKey.localeCompare(b.dateKey) || a.playerName.localeCompare(b.playerName));
    missingRows.sort((a, b) =>
      a.dateKey.localeCompare(b.dateKey) || a.playerName.localeCompare(b.playerName));
    uncertain.sort((a, b) =>
      String(a.dateKey || '').localeCompare(String(b.dateKey || ''))
      || String(a.playerName || '').localeCompare(String(b.playerName || '')));

    return {
      scannedMatchupSides: expectations.length,
      scannedHistoryRows: histories.length,
      confirmedScoreUpdates,
      missingRows,
      uncertain,
      orphanCount: orphanRows.length,
      orphanSample: orphanRows.slice(0, 5).map((item) => ({
        dateKey: item.dateKey,
        playerId: item.playerId,
        playerName: item.playerName,
        historyId: item.historyId
      }))
    };
  }

  function planFingerprint(plan) {
    return JSON.stringify({
      confirmedScoreUpdates: (plan?.confirmedScoreUpdates || []).map((item) => [
        item.dateKey,
        item.playerId,
        item.matchupId,
        item.historyId,
        item.historyIndex,
        item.storedScore,
        item.matchupScore
      ]),
      missingRows: (plan?.missingRows || []).map((item) => [
        item.dateKey,
        item.playerId,
        item.opponentId,
        item.matchupId,
        item.score,
        item.historyId
      ]),
      uncertain: (plan?.uncertain || []).map((item) => [
        item.type,
        item.dateKey || '',
        item.playerId || '',
        item.matchupId || '',
        item.historyId || '',
        item.reason || ''
      ]),
      orphanCount: Number(plan?.orphanCount) || 0
    });
  }

  function buildHistoryRow(item) {
    const matchup = item.matchup || {};
    const row = {
      id: item.historyId,
      date: item.dateKey,
      dateKey: item.dateKey,
      playerId: item.playerId,
      score: Number(item.score),
      opponentId: item.opponentId,
      matchupId: item.matchupId,
      source: 'audit-game-history-repair'
    };

    ['seasonId', 'roundId', 'matchupType'].forEach((field) => {
      if (populated(matchup[field])) row[field] = matchup[field];
    });

    const seriesId = matchup.seriesId || matchup.seasonSeriesId;
    if (populated(seriesId)) {
      row.seriesId = seriesId;
      row.seasonSeriesId = seriesId;
    }

    const gameNumber = matchup.gameNumber || matchup.seriesGameNumber;
    if (populated(gameNumber)) {
      row.gameNumber = gameNumber;
      row.seriesGameNumber = gameNumber;
    }

    return row;
  }

  function nonHistorySnapshot(state) {
    const copy = {};
    Object.keys(state || {}).forEach((key) => {
      if (key === 'gameHistory') return;
      copy[key] = state[key];
    });
    return JSON.stringify(copy);
  }

  function applyGameHistoryRepair(stateInput, planInput = null) {
    const sourceState = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const plan = planInput || buildGameHistoryRepairPlan(sourceState);
    const state = clone(sourceState);
    if (!Array.isArray(state.gameHistory)) state.gameHistory = [];

    const beforeOtherDomains = nonHistorySnapshot(state);
    let updatedScores = 0;
    let createdRows = 0;
    let skippedStale = 0;

    (plan.confirmedScoreUpdates || []).forEach((item) => {
      let row = null;
      if (item.historyId) {
        row = state.gameHistory.find((candidate) => String(candidate?.id || '') === item.historyId) || null;
      }
      if (!row && Number.isInteger(item.historyIndex)) {
        const candidate = state.gameHistory[item.historyIndex];
        if (
          candidate
          && dateKey(candidate) === item.dateKey
          && String(candidate.playerId || '') === item.playerId
          && equalScore(historyScore(candidate), item.storedScore)
        ) row = candidate;
      }
      if (
        !row
        || dateKey(row) !== item.dateKey
        || String(row.playerId || '') !== item.playerId
        || !equalScore(historyScore(row), item.storedScore)
      ) {
        skippedStale += 1;
        return;
      }
      row.score = Number(item.matchupScore);
      updatedScores += 1;
    });

    (plan.missingRows || []).forEach((item) => {
      const exists = state.gameHistory.some((row) =>
        String(row?.id || '') === item.historyId
        || (
          String(row?.matchupId || '') === item.matchupId
          && String(row?.playerId || '') === item.playerId
        )
      );
      if (exists) {
        skippedStale += 1;
        return;
      }
      state.gameHistory.push(buildHistoryRow(item));
      createdRows += 1;
    });

    if (nonHistorySnapshot(state) !== beforeOtherDomains) {
      throw new Error('The repair attempted to change data outside gameHistory.');
    }

    return {
      state,
      changed: updatedScores > 0 || createdRows > 0,
      updatedScores,
      createdRows,
      skippedStale,
      remainingPlan: buildGameHistoryRepairPlan(state)
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

  function loadCurrentState() {
    try {
      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });
      return loaded?.state || loaded || readPersistedState() || {};
    } catch (_) {
      return readPersistedState() || {};
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
  }

  function listMarkup(items, renderItem, emptyText) {
    if (!items.length) return `<p class="muted text-sm">${escapeHtml(emptyText)}</p>`;
    const rows = items.slice(0, MAX_SAMPLE_ROWS).map((item) =>
      `<li>${renderItem(item)}</li>`).join('');
    const omitted = items.length > MAX_SAMPLE_ROWS
      ? `<li class="muted">… ${items.length - MAX_SAMPLE_ROWS} additional row(s)</li>`
      : '';
    return `<ul class="text-sm space-y-1 mt-2" style="padding-left:1.25rem;list-style:disc">${rows}${omitted}</ul>`;
  }

  function installAuditPanel() {
    const auditChecks = global.document?.getElementById('auditChecks');
    const main = auditChecks?.closest('main') || global.document?.querySelector('main');
    if (!main || global.document.getElementById('gameHistoryRepairPanel')) return false;

    const panel = global.document.createElement('section');
    panel.id = 'gameHistoryRepairPanel';
    panel.className = 'glass space-y-3';
    panel.innerHTML = `
      <div>
        <div class="text-lg font-semibold">Game-History Reconciliation Repair</div>
        <p class="muted text-sm mt-1">
          Preview the two confirmed stale history scores and confidently missing NPC history rows.
          Matchups, winners, records, Gold, Season results, and the 25 orphan history rows are not changed.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button id="previewGameHistoryRepairBtn" type="button" class="btn btn-teal">
          Preview Game-History Repair
        </button>
        <button id="repairGameHistoryBtn" type="button" class="btn btn-ghost" disabled>
          Repair Confirmed History Rows
        </button>
      </div>
      <label class="flex items-start gap-2 text-sm">
        <input id="gameHistoryBackupConfirmed" type="checkbox" class="mt-1">
        <span>I exported a fresh full backup of the current phone data.</span>
      </label>
      <div id="gameHistoryRepairStatus" class="muted text-sm">
        Run the preview first. Nothing is changed during preview.
      </div>
      <div id="gameHistoryRepairPreview" class="space-y-3"></div>
    `;
    main.appendChild(panel);

    const previewButton = panel.querySelector('#previewGameHistoryRepairBtn');
    const repairButton = panel.querySelector('#repairGameHistoryBtn');
    const backupCheckbox = panel.querySelector('#gameHistoryBackupConfirmed');
    const status = panel.querySelector('#gameHistoryRepairStatus');
    const previewWrap = panel.querySelector('#gameHistoryRepairPreview');

    let previewPlan = null;
    let previewFingerprint = '';

    function updateRepairAvailability() {
      const safePlan = previewPlan
        && previewPlan.uncertain.length === 0
        && (previewPlan.confirmedScoreUpdates.length > 0 || previewPlan.missingRows.length > 0);
      repairButton.disabled = !(safePlan && backupCheckbox.checked);
    }

    function renderPreview(plan) {
      const scoreMarkup = listMarkup(
        plan.confirmedScoreUpdates,
        (item) =>
          `${escapeHtml(item.dateKey)} · ${escapeHtml(item.playerName)}: `
          + `${escapeHtml(item.storedScore)} → ${escapeHtml(item.matchupScore)} `
          + `<span class="muted">(${escapeHtml(item.method)})</span>`,
        'Confirmed score updates: 0'
      );

      const missingMarkup = listMarkup(
        plan.missingRows,
        (item) =>
          `${escapeHtml(item.dateKey)} · ${escapeHtml(item.playerName)} vs `
          + `${escapeHtml(item.opponentName)} · score ${escapeHtml(item.score)}`,
        'Missing history rows to create: 0'
      );

      const uncertainMarkup = listMarkup(
        plan.uncertain,
        (item) =>
          `${escapeHtml(item.dateKey || 'Unknown date')} · `
          + `${escapeHtml(item.playerName || item.playerId || 'Unknown row')} · `
          + `${escapeHtml(item.reason)}`,
        'Needs manual review: 0'
      );

      previewWrap.innerHTML = `
        <div>
          <strong>Confirmed score updates: ${plan.confirmedScoreUpdates.length}</strong>
          ${scoreMarkup}
        </div>
        <div>
          <strong>Missing history rows to create: ${plan.missingRows.length}</strong>
          ${missingMarkup}
        </div>
        <div>
          <strong>Needs manual review: ${plan.uncertain.length}</strong>
          ${uncertainMarkup}
        </div>
        <p class="muted text-sm">
          Orphan legacy history rows left untouched: ${plan.orphanCount}.
        </p>
      `;

      if (plan.uncertain.length) {
        status.textContent = 'Repair is blocked because at least one row needs manual review.';
      } else if (!plan.confirmedScoreUpdates.length && !plan.missingRows.length) {
        status.textContent = 'No confirmed reconciliation repairs are currently needed.';
      } else {
        status.textContent =
          `Preview ready: ${plan.confirmedScoreUpdates.length} score update(s) and `
          + `${plan.missingRows.length} missing row(s). No data has changed.`;
      }
      updateRepairAvailability();
    }

    previewButton.addEventListener('click', () => {
      const state = loadCurrentState();
      previewPlan = buildGameHistoryRepairPlan(state);
      previewFingerprint = planFingerprint(previewPlan);
      backupCheckbox.checked = false;
      renderPreview(previewPlan);
    });

    backupCheckbox.addEventListener('change', updateRepairAvailability);

    repairButton.addEventListener('click', () => {
      if (!previewPlan || !backupCheckbox.checked) return;

      const currentState = loadCurrentState();
      const freshPlan = buildGameHistoryRepairPlan(currentState);
      if (planFingerprint(freshPlan) !== previewFingerprint) {
        previewPlan = null;
        previewFingerprint = '';
        updateRepairAvailability();
        status.textContent =
          'The saved data changed after the preview. Run Preview Game-History Repair again.';
        return;
      }

      if (freshPlan.uncertain.length) {
        renderPreview(freshPlan);
        return;
      }

      let result;
      try {
        result = applyGameHistoryRepair(currentState, freshPlan);
      } catch (error) {
        console.error('Game-history repair failed before save', error);
        status.textContent = `Repair stopped before saving: ${error?.message || error}`;
        return;
      }

      if (!result.changed) {
        previewPlan = result.remainingPlan;
        previewFingerprint = planFingerprint(previewPlan);
        renderPreview(previewPlan);
        status.textContent = 'No rows changed. The preview may already have been repaired.';
        return;
      }

      try {
        const saved = core.saveStateSnapshot?.(result.state, {
          savePath: 'audit-game-history-reconciliation-repair',
          userInitiated: true,
          interactive: true,
          immediateWrite: true
        });
        if (saved?.blocked || saved?.ok === false) {
          throw new Error(saved?.reason || saved?.error || 'The save was blocked.');
        }
      } catch (error) {
        console.error('Game-history repair save failed', error);
        status.textContent =
          `Save failed, so no success is being reported: ${error?.message || error}`;
        return;
      }

      previewPlan = result.remainingPlan;
      previewFingerprint = planFingerprint(previewPlan);
      backupCheckbox.checked = false;
      renderPreview(previewPlan);
      status.textContent =
        `Repair saved: ${result.updatedScores} stale score(s) updated and `
        + `${result.createdRows} missing history row(s) created. `
        + `${result.skippedStale} stale item(s) skipped.`;

      if (typeof global.runAudit === 'function') {
        try { global.runAudit(); } catch (_) {}
      } else {
        try { global.document.getElementById('runAuditBtn')?.click(); } catch (_) {}
      }
    });

    return true;
  }

  const api = {
    CONFIRMED_SCORE_CORRECTIONS,
    buildGameHistoryRepairPlan,
    planFingerprint,
    applyGameHistoryRepair,
    installAuditPanel
  };

  core.GameHistoryReconciliationRepair = api;
  global.TaskPointsGameHistoryReconciliationRepair = api;

  function scheduleInstall() {
    global.setTimeout?.(() => installAuditPanel(), 0);
  }

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', scheduleInstall, { once: true });
    } else {
      scheduleInstall();
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
