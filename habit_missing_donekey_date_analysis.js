(function installMissingDoneKeyDateAnalysis(global) {
  'use strict';
  if (global.TaskPointsMissingDoneKeyDateAnalysis) return;

  const core = global.TaskPointsCore || {};
  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const TOLERANCE = 0.05;
  const populated = (value) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = (value) => populated(value) && Number.isFinite(Number(value));
  const isYou = (value) => String(value || '').toUpperCase() === 'YOU';
  const validDayKey = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

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
    return year + '-' + month + '-' + day;
  }

  function rowDay(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dayKey, row.dateKey]) {
      const direct = typeof value === 'string' ? value.slice(0, 10) : '';
      if (validDayKey(direct)) return direct;
    }
    if (validDayKey(row.date)) return row.date;
    for (const value of [row.date, row.dateISO, row.completedAtISO, row.createdAtISO, row.finalizedAtISO]) {
      if (!populated(value)) continue;
      const key = localDateKey(value);
      if (key) return key;
    }
    return '';
  }

  function sideScore(row, side) {
    const primary = row && row[side === 'B' ? 'scoreB' : 'scoreA'];
    const alias = row && row[side === 'B' ? 'playerBScore' : 'playerAScore'];
    if (finite(primary)) return Number(primary);
    if (finite(alias)) return Number(alias);
    return null;
  }

  function resultLabel(userScore, opponentScore) {
    if (!finite(userScore) || !finite(opponentScore)) return 'Unknown';
    const user = Number(userScore);
    const opponent = Number(opponentScore);
    if (Math.abs(user - opponent) <= 0.0001) return 'Tie';
    return user > opponent ? 'Win' : 'Loss';
  }

  function matchupId(row) {
    return String((row && (row.id || row.matchupId)) || '').trim();
  }

  function playerName(state, playerId) {
    if (isYou(playerId)) return String((state && state.youName) || 'You');
    const player = (Array.isArray(state && state.players) ? state.players : [])
      .find((item) => item && String(item.id) === String(playerId));
    return String((player && (player.name || player.playerName)) || playerId || 'Unknown opponent');
  }

  function fallbackMissingTargets(state) {
    const completionKeys = new Set();
    (Array.isArray(state && state.completions) ? state.completions : []).forEach((row) => {
      if (!row || !['habit','vice'].includes(row.source)) return;
      const habitId = String(row.habitId || row.viceId || '').trim();
      const dayKey = rowDay(row);
      if (habitId && dayKey) completionKeys.add(habitId + '|' + dayKey);
    });
    const targets = [];
    (Array.isArray(state && state.habits) ? state.habits : []).forEach((habit) => {
      const habitId = String((habit && habit.id) || '').trim();
      if (!habitId) return;
      const seen = new Set();
      (Array.isArray(habit.doneKeys) ? habit.doneKeys : []).forEach((dayKey) => {
        if (!validDayKey(dayKey) || seen.has(dayKey)) return;
        seen.add(dayKey);
        if (completionKeys.has(habitId + '|' + dayKey)) return;
        targets.push({
          habitId,
          habitName: String(habit.name || habit.title || habit.label || habitId),
          dayKey
        });
      });
    });
    return targets;
  }

  function missingTargets(state) {
    const recovery = global.TaskPointsHabitCompletionBackupRecovery;
    if (recovery && typeof recovery.buildMissingTargets === 'function') {
      try { return recovery.buildMissingTargets(state); } catch (_) {}
    }
    return fallbackMissingTargets(state);
  }

  function canonicalScoreMap(state) {
    if (typeof core.youDailyTotalsWithInertia !== 'function') {
      throw new Error('The canonical TaskPoints daily scorer is unavailable.');
    }
    const totals = core.youDailyTotalsWithInertia(state || {});
    if (!totals || typeof totals !== 'object') {
      throw new Error('The canonical TaskPoints daily scorer returned no totals.');
    }
    const map = new Map();
    Object.entries(totals).forEach(([dayKey, value]) => {
      if (validDayKey(dayKey) && finite(value)) map.set(dayKey, Number(value));
    });
    return map;
  }

  function historyScore(row) {
    if (finite(row && row.score)) return Number(row.score);
    if (finite(row && row.points)) return Number(row.points);
    if (finite(row && row.total)) return Number(row.total);
    return null;
  }

  function compatibleYouHistoryRows(state, matchup, dayKey) {
    const rows = (Array.isArray(state && state.gameHistory) ? state.gameHistory : [])
      .filter((row) => isYou(row && row.playerId) && rowDay(row) === dayKey);
    if (!matchup) return rows;
    const mid = matchupId(matchup);
    const opponentId = isYou(matchup.playerAId) ? matchup.playerBId : matchup.playerAId;
    return rows.filter((row) => {
      const rowMid = String((row && row.matchupId) || '').trim();
      if (mid && rowMid) return rowMid === mid;
      if (rowMid) return false;
      return !populated(row && row.opponentId)
        || !populated(opponentId)
        || String(row.opponentId) === String(opponentId);
    });
  }

  function buildMissingDateAnalysis(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const targets = missingTargets(state);
    const byDay = new Map();
    targets.forEach((target) => {
      if (!byDay.has(target.dayKey)) byDay.set(target.dayKey, []);
      byDay.get(target.dayKey).push(target);
    });

    const scoreMap = canonicalScoreMap(state);
    const allMatchups = Array.isArray(state.matchups) ? state.matchups : [];
    const allHistory = Array.isArray(state.gameHistory) ? state.gameHistory : [];
    const days = [];

    Array.from(byDay.entries()).sort((a,b) => a[0].localeCompare(b[0])).forEach((entry) => {
      const dayKey = entry[0];
      const missingRows = entry[1];
      const matchups = allMatchups.filter((row) =>
        row && rowDay(row) === dayKey && (isYou(row.playerAId) || isYou(row.playerBId))
      );
      const youHistory = allHistory.filter((row) => isYou(row && row.playerId) && rowDay(row) === dayKey);
      const currentCanonicalScore = finite(scoreMap.get(dayKey)) ? Number(scoreMap.get(dayKey)) : 0;
      const habitNames = Array.from(new Set(missingRows.map((row) => row.habitName || row.habitId))).sort();

      const base = {
        dayKey,
        missingCount: missingRows.length,
        habitNames,
        currentCanonicalScore,
        matchupCount: matchups.length,
        youHistoryCount: youHistory.length,
        classification: '',
        classificationLabel: '',
        reason: ''
      };

      if (matchups.length === 0) {
        const finiteHistory = youHistory.filter((row) => finite(historyScore(row)));
        if (finiteHistory.length) {
          days.push(Object.assign({}, base, {
            classification: 'history-only',
            classificationLabel: 'History-only score; no stored matchup',
            historyScores: finiteHistory.map(historyScore),
            reason: finiteHistory.length + ' scored You gameHistory row(s) survive on this date, but no stored matchup involving You does. No automatic reconstruction should use the missing doneKeys.'
          }));
        } else {
          days.push(Object.assign({}, base, {
            classification: 'no-game',
            classificationLabel: 'No stored game on this date',
            reason: 'No stored matchup or scored You gameHistory row exists for this date. The missing doneKeys do not currently feed a saved W/L result, though the reconstructed daily score may be incomplete.'
          }));
        }
        return;
      }

      if (matchups.length !== 1) {
        days.push(Object.assign({}, base, {
          classification: 'needs-review',
          classificationLabel: 'Needs review',
          reason: matchups.length + ' stored matchups involving You exist on this date, so a single preserved historical score cannot be identified safely.'
        }));
        return;
      }

      const matchup = matchups[0];
      const side = isYou(matchup.playerAId) ? 'A' : 'B';
      const opponentSide = side === 'A' ? 'B' : 'A';
      const storedUserScore = sideScore(matchup, side);
      const opponentScore = sideScore(matchup, opponentSide);
      const opponentId = side === 'A' ? matchup.playerBId : matchup.playerAId;
      const mid = matchupId(matchup);
      const compatibleHistory = compatibleYouHistoryRows(state, matchup, dayKey);
      const finiteCompatibleHistory = compatibleHistory.filter((row) => finite(historyScore(row)));
      const matchingHistoryCount = finite(storedUserScore)
        ? finiteCompatibleHistory.filter((row) => Math.abs(Number(historyScore(row)) - Number(storedUserScore)) <= TOLERANCE).length
        : 0;

      if (!mid || !finite(storedUserScore) || !finite(opponentScore)) {
        days.push(Object.assign({}, base, {
          classification: 'needs-review',
          classificationLabel: 'Needs review',
          matchupId: mid,
          opponentId,
          opponentName: playerName(state, opponentId),
          storedUserScore: finite(storedUserScore) ? Number(storedUserScore) : null,
          opponentScore: finite(opponentScore) ? Number(opponentScore) : null,
          compatibleHistoryCount: finiteCompatibleHistory.length,
          reason: 'A matchup exists, but it does not contain a stable ID and two finite stored scores.'
        }));
        return;
      }

      if (finiteCompatibleHistory.length > 1) {
        days.push(Object.assign({}, base, {
          classification: 'needs-review',
          classificationLabel: 'Needs review',
          matchupId: mid,
          opponentId,
          opponentName: playerName(state, opponentId),
          storedUserScore: Number(storedUserScore),
          opponentScore: Number(opponentScore),
          compatibleHistoryCount: finiteCompatibleHistory.length,
          reason: finiteCompatibleHistory.length + ' compatible scored You gameHistory rows exist for this matchup, so the historical copies are ambiguous.'
        }));
        return;
      }

      const scoreGap = Number((Number(storedUserScore) - currentCanonicalScore).toFixed(4));
      const common = Object.assign({}, base, {
        matchupId: mid,
        opponentId,
        opponentName: playerName(state, opponentId),
        storedUserScore: Number(storedUserScore),
        opponentScore: Number(opponentScore),
        preservedResult: resultLabel(storedUserScore, opponentScore),
        scoreGap,
        compatibleHistoryCount: finiteCompatibleHistory.length,
        matchingHistoryCount
      });

      if (Math.abs(scoreGap) <= TOLERANCE) {
        days.push(Object.assign({}, common, {
          classification: 'frozen-match',
          classificationLabel: 'Stored game score matches current ledger',
          reason: 'The stored matchup preserves Your ' + Number(storedUserScore) + ' score and the current canonical completion ledger also recomputes ' + currentCanonicalScore + '. The missing doneKeys are not currently creating a game-score discrepancy.'
        }));
      } else {
        days.push(Object.assign({}, common, {
          classification: 'frozen-drift',
          classificationLabel: 'Stored game score differs from current ledger',
          reason: 'The stored matchup preserves Your ' + Number(storedUserScore) + ' score, while the current canonical completion ledger recomputes ' + currentCanonicalScore + ' (gap ' + (scoreGap > 0 ? '+' : '') + scoreGap + '). The gap could reflect missing completion rows or other historical scoring/data changes, so it cannot be assigned to these doneKeys alone.'
        }));
      }
    });

    const counts = {
      frozenMatch: days.filter((row) => row.classification === 'frozen-match').length,
      frozenDrift: days.filter((row) => row.classification === 'frozen-drift').length,
      noGame: days.filter((row) => row.classification === 'no-game').length,
      historyOnly: days.filter((row) => row.classification === 'history-only').length,
      needsReview: days.filter((row) => row.classification === 'needs-review').length
    };
    return { missingRowCount: targets.length, affectedDateCount: days.length, counts, days };
  }

  function readCurrentState() {
    if (typeof core.readTaskPointsStoredState === 'function') {
      return core.readTaskPointsStoredState(STORAGE_KEY, null);
    }
    const raw = global.localStorage && global.localStorage.getItem && global.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[char]));
  }

  function formatDay(row) {
    const habits = row.habitNames.join(', ');
    const matchup = row.matchupId
      ? ' · matchup ' + row.matchupId + (row.opponentName ? ' vs ' + row.opponentName : '')
      : '';
    const scores = row.storedUserScore != null
      ? ' · stored ' + row.storedUserScore + ', current ledger ' + row.currentCanonicalScore
      : ' · current ledger ' + row.currentCanonicalScore;
    return '<li class="mb-3"><strong>' + escapeHtml(row.dayKey) + ' — ' + escapeHtml(row.classificationLabel) + '</strong>'
      + '<div class="mt-1">' + row.missingCount + ' missing row(s): ' + escapeHtml(habits) + '</div>'
      + '<div class="muted">' + escapeHtml(scores + matchup) + '</div>'
      + '<div class="muted">' + escapeHtml(row.reason) + '</div></li>';
  }

  function installPanel() {
    const recoveryPanel = global.document && global.document.getElementById('habitCompletionBackupRecovery');
    if (!recoveryPanel || global.document.getElementById('habitMissingDoneKeyDateAnalysis')) return false;

    const section = global.document.createElement('div');
    section.id = 'habitMissingDoneKeyDateAnalysis';
    section.className = 'border-t border-zinc-700/60 pt-4 space-y-3';
    section.innerHTML = [
      '<div class="font-semibold">Analyze missing doneKeys by date</div>',
      '<p class="muted text-sm">Read-only. Groups the unrecoverable doneKeys by date and checks the canonical completion total against any stored matchup score involving You. It does not invent points, change matchups, or modify Habit history.</p>',
      '<div class="flex flex-wrap gap-2"><button id="analyzeMissingDoneKeysBtn" type="button" class="btn btn-primary">Analyze Missing Dates</button><button id="copyMissingDoneKeyAnalysisBtn" type="button" class="btn btn-ghost" disabled>Copy Date Analysis</button></div>',
      '<div id="missingDoneKeyAnalysisStatus" class="muted text-sm">Run the date analysis after the backup scan.</div>',
      '<div id="missingDoneKeyAnalysisSummary" class="text-sm"></div>',
      '<div id="missingDoneKeyAnalysisRows"></div>'
    ].join('');
    recoveryPanel.appendChild(section);

    const analyze = section.querySelector('#analyzeMissingDoneKeysBtn');
    const copy = section.querySelector('#copyMissingDoneKeyAnalysisBtn');
    const status = section.querySelector('#missingDoneKeyAnalysisStatus');
    const summary = section.querySelector('#missingDoneKeyAnalysisSummary');
    const rows = section.querySelector('#missingDoneKeyAnalysisRows');
    let analysis = null;

    analyze.addEventListener('click', () => {
      analysis = null;
      copy.disabled = true;
      analyze.disabled = true;
      status.textContent = 'Grouping missing rows by date and comparing preserved game scores…';
      try {
        const state = readCurrentState();
        if (!state) throw new Error('No TaskPoints state was found.');
        analysis = buildMissingDateAnalysis(state);
        const c = analysis.counts;
        summary.innerHTML =
          'Missing rows: <strong>' + analysis.missingRowCount + '</strong> across <strong>' + analysis.affectedDateCount + '</strong> date(s)<br>'
          + 'Stored game score matches current ledger: <strong>' + c.frozenMatch + '</strong><br>'
          + 'Stored game score differs from current ledger: <strong>' + c.frozenDrift + '</strong><br>'
          + 'No stored game: <strong>' + c.noGame + '</strong><br>'
          + 'History-only score: <strong>' + c.historyOnly + '</strong><br>'
          + 'Needs review: <strong>' + c.needsReview + '</strong>';
        rows.innerHTML = analysis.days.length
          ? '<ul class="text-sm mt-3" style="padding-left:1.25rem;list-style:disc">' + analysis.days.map(formatDay).join('') + '</ul>'
          : '<div class="muted text-sm">No missing doneKeys remain.</div>';
        copy.disabled = !analysis.days.length;
        status.textContent = analysis.days.length
          ? 'Date analysis complete. No data was changed. Copy the report and send it for review before changing or suppressing any remaining warnings.'
          : 'No missing doneKeys remain.';
      } catch (error) {
        status.textContent = 'Date analysis failed: ' + (error && error.message ? error.message : error);
      } finally {
        analyze.disabled = false;
      }
    });

    copy.addEventListener('click', async () => {
      if (!analysis || !analysis.days || !analysis.days.length) return;
      const c = analysis.counts;
      const lines = [
        'Missing doneKey Date Analysis — ' + analysis.missingRowCount + ' row(s), ' + analysis.affectedDateCount + ' date(s)',
        'Stored game score matches current ledger: ' + c.frozenMatch,
        'Stored game score differs from current ledger: ' + c.frozenDrift,
        'No stored game: ' + c.noGame,
        'History-only score: ' + c.historyOnly,
        'Needs review: ' + c.needsReview,
        ''
      ];
      analysis.days.forEach((row, index) => {
        lines.push((index + 1) + '. ' + row.dayKey + ' — ' + row.classificationLabel);
        lines.push('   Missing: ' + row.missingCount + ' — ' + row.habitNames.join(', '));
        lines.push('   Current canonical completion score: ' + row.currentCanonicalScore);
        if (row.storedUserScore != null) {
          lines.push('   Stored You score: ' + row.storedUserScore + '; opponent: ' + (row.opponentName || row.opponentId || '?') + ' ' + (row.opponentScore == null ? '?' : row.opponentScore) + '; result: ' + (row.preservedResult || '?'));
          lines.push('   Score gap (stored - current): ' + row.scoreGap);
          lines.push('   Matchup ID: ' + (row.matchupId || '(none)'));
          lines.push('   Compatible You gameHistory rows: ' + (row.compatibleHistoryCount || 0) + '; matching stored score: ' + (row.matchingHistoryCount || 0));
        } else if (Array.isArray(row.historyScores)) {
          lines.push('   Surviving You gameHistory score(s): ' + row.historyScores.join(', '));
        }
        lines.push('   Reason: ' + row.reason);
      });
      try {
        if (!global.navigator || !global.navigator.clipboard || !global.navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
        await global.navigator.clipboard.writeText(lines.join('\n'));
        status.textContent = 'Date analysis copied. No data was changed.';
      } catch (_) {
        status.textContent = 'Could not copy automatically. The analysis remains visible and read-only.';
      }
    });

    return true;
  }

  const api = { buildMissingDateAnalysis, rowDay, sideScore, compatibleYouHistoryRows, installPanel };
  global.TaskPointsMissingDoneKeyDateAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (global.document) {
    let tries = 0;
    const install = () => {
      if (installPanel()) return;
      tries += 1;
      if (tries < 80 && global.setTimeout) global.setTimeout(install, 50);
    };
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', install, { once:true });
    } else {
      install();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
