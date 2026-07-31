;(function installSameDayAuditReconciliationFix(global) {
  'use strict';

  const existing = global.TaskPointsAuditIntegrity || {};
  const DEFAULT_DETAIL_LIMIT = 75;
  const populated = value => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finiteValue = value => populated(value) && Number.isFinite(Number(value));
  const isYou = id => String(id || '').toUpperCase() === 'YOU';
  const shortId = id => populated(id) ? (String(id).trim().length > 12 ? `${String(id).trim().slice(0, 8)}…` : String(id).trim()) : '';
  const formatScore = value => Number.isFinite(Number(value)) ? String(Number(Number(value).toFixed(2))) : String(value);
  const validLedgerKey = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const formatDateLabel = dateKey => validLedgerKey(dateKey) ? dateKey : 'unknown date';

  function normalizeDate(values, options) {
    for (const value of values) {
      if (!populated(value)) continue;
      try {
        const key = options && typeof options.dateKey === 'function'
          ? options.dateKey(value)
          : (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : new Date(value).toISOString().slice(0, 10));
        if (validLedgerKey(key)) return key;
      } catch (_) {}
    }
    return '';
  }

  function limitDetails(details, options) {
    const requested = Number(options && options.detailLimit);
    const limit = Number.isInteger(requested) && requested >= 0 ? requested : DEFAULT_DETAIL_LIMIT;
    return details.length <= limit
      ? details
      : details.slice(0, limit).concat(`… ${details.length - limit} additional issue(s) omitted.`);
  }

  function issueCollector() {
    const buckets = [[], [], [], [], [], []];
    let failures = 0;
    let warnings = 0;
    return {
      fail(message, priority = 0) {
        failures += 1;
        buckets[Math.max(0, Math.min(5, priority))].push(`FAIL — ${message}`);
      },
      warn(message, priority = 4) {
        warnings += 1;
        buckets[Math.max(0, Math.min(5, priority))].push(`WARN — ${message}`);
      },
      result(options) {
        const details = buckets.flat();
        return {
          status: failures ? 'FAIL' : (warnings ? 'WARN' : 'PASS'),
          summary: failures || warnings ? `${failures} failure(s), ${warnings} warning(s)` : 'No issues found',
          details: limitDetails(details, options)
        };
      }
    };
  }

  function getPlayerLabel(state, playerId) {
    const player = (Array.isArray(state && state.players) ? state.players : [])
      .find(item => item && String(item.id) === String(playerId));
    const id = shortId(playerId);
    return player && populated(player.name) ? `${player.name} (${id})` : id || 'unknown player';
  }

  function sideScore(matchup, side) {
    const primaryName = side === 'A' ? 'scoreA' : 'scoreB';
    const aliasName = side === 'A' ? 'playerAScore' : 'playerBScore';
    const primary = matchup && matchup[primaryName];
    const alias = matchup && matchup[aliasName];
    const hasPrimary = populated(primary);
    const primaryFinite = finiteValue(primary);
    const aliasFinite = finiteValue(alias);
    return {
      valid: primaryFinite || (!hasPrimary && aliasFinite),
      value: primaryFinite ? Number(primary) : ((!hasPrimary && aliasFinite) ? Number(alias) : NaN)
    };
  }

  function finalized(matchup) {
    if (!matchup) return false;
    if (populated(matchup.finalizedAtISO) || populated(matchup.completedAtISO)
      || populated(matchup.winnerId) || populated(matchup.loserId) || populated(matchup.result)) return true;
    return sideScore(matchup, 'A').valid && sideScore(matchup, 'B').valid;
  }

  function historyScore(row) {
    if (finiteValue(row && row.score)) return { valid: true, value: Number(row.score), fallback: false };
    if (!populated(row && row.score)) {
      if (finiteValue(row && row.points)) return { valid: true, value: Number(row.points), fallback: true, field: 'points' };
      if (finiteValue(row && row.total)) return { valid: true, value: Number(row.total), fallback: true, field: 'total' };
    }
    return { valid: false, value: NaN, fallback: false };
  }

  function matchupLabel(matchup, index) {
    const id = matchup && (matchup.id || matchup.matchupId);
    const context = matchup && [
      matchup.seasonId,
      matchup.seriesId || matchup.seasonSeriesId,
      matchup.roundId,
      matchup.gameNumber || matchup.seriesGameNumber,
      matchup.matchupType
    ].filter(populated).join(' ');
    return `Matchup ${context || shortId(id) || `#${index + 1}`}`;
  }

  function contextKey(item) {
    const row = item.row || item.matchup || {};
    const fields = [
      row.seasonId,
      row.seriesId || row.seasonSeriesId,
      row.roundId,
      row.gameNumber || row.seriesGameNumber,
      row.matchupType
    ];
    return fields.some(populated)
      ? fields.map(value => populated(value) ? String(value).trim() : '').join('|')
      : '';
  }

  function groupByBase(items) {
    const groups = new Map();
    items.forEach(item => {
      const key = `${item.date}|${item.playerId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return groups;
  }

  function buildMatchupHistoryReconciliationAudit(state, options = {}) {
    const out = issueCollector();
    const expectations = [];
    const histories = [];
    const ids = new Set();

    (Array.isArray(state && state.matchups) ? state.matchups : []).forEach((matchup, index) => {
      if (!finalized(matchup)) return;
      const date = normalizeDate([
        matchup.dateKey,
        matchup.date,
        matchup.completedAtISO,
        matchup.finalizedAtISO
      ], options);

      ['A', 'B'].forEach(side => {
        const playerId = matchup[`player${side}Id`];
        if (!playerId || isYou(playerId)) return;
        const score = sideScore(matchup, side);
        const label = `${matchupLabel(matchup, index)} side ${side} (${getPlayerLabel(state, playerId)})`;
        if (!date || !score.valid) {
          out.fail(`${label} cannot be reconciled because its date or score is unusable`, 0);
          return;
        }
        const opponentSide = side === 'A' ? 'B' : 'A';
        expectations.push({
          matchup,
          date,
          playerId: String(playerId),
          opponentId: populated(matchup[`player${opponentSide}Id`]) ? String(matchup[`player${opponentSide}Id`]) : '',
          score: score.value,
          matchupId: populated(matchup.id || matchup.matchupId)
            ? String(matchup.id || matchup.matchupId).trim()
            : '',
          label
        });
      });
    });

    (Array.isArray(state && state.gameHistory) ? state.gameHistory : []).forEach((row, index) => {
      const label = `Game history ${shortId(row && row.id) || `#${index + 1}`}`;
      if (row && populated(row.id)) {
        if (ids.has(row.id)) out.fail(`Duplicate gameHistory ID ${shortId(row.id)}`, 2);
        else ids.add(row.id);
      }
      if (!row || !populated(row.playerId)) {
        out.fail(`${label} is missing playerId`, 1);
        return;
      }
      const date = normalizeDate([row.dateKey, row.date, row.completedAtISO, row.createdAtISO], options);
      if (!date) {
        out.fail(`${label} is missing a usable date`, 1);
        return;
      }
      if (isYou(row.playerId)) return;
      histories.push({
        row,
        date,
        playerId: String(row.playerId),
        opponentId: populated(row.opponentId) ? String(row.opponentId) : '',
        score: historyScore(row),
        matchupId: populated(row.matchupId) ? String(row.matchupId).trim() : '',
        label: `${label} (${getPlayerLabel(state, row.playerId)})`
      });
    });

    const expectationGroups = groupByBase(expectations);
    const historyGroups = groupByBase(histories);
    const unusedHistories = new Set(histories);
    const ambiguousBases = new Set();

    const scoreEqual = (expected, found) =>
      found.score.valid && Math.abs(expected.score - found.score.value) <= 0.05;

    const consume = (expected, found) => {
      unusedHistories.delete(found);
      if (found.score.fallback) out.warn(`${found.label} uses legacy ${found.score.field} instead of score`, 4);
      if (!found.score.valid) out.fail(`${found.label} has no usable score`, 0);
      else if (!scoreEqual(expected, found)) {
        out.fail(
          `${formatDateLabel(expected.date)} ${getPlayerLabel(state, expected.playerId)} `
          + `matchup score ${formatScore(expected.score)} differs from history score ${formatScore(found.score.value)}`,
          0
        );
      }
    };

    const allBases = new Set([...expectationGroups.keys(), ...historyGroups.keys()]);
    allBases.forEach(key => {
      const expectedRows = expectationGroups.get(key) || [];
      const historyRows = historyGroups.get(key) || [];
      const remainingExpected = new Set(expectedRows);
      const remainingHistory = new Set(historyRows);

      const pair = (expected, found) => {
        if (!remainingExpected.has(expected) || !remainingHistory.has(found)) return false;
        remainingExpected.delete(expected);
        remainingHistory.delete(found);
        consume(expected, found);
        return true;
      };

      expectedRows.forEach(expected => {
        if (!remainingExpected.has(expected) || !expected.matchupId) return;
        const matches = [...remainingHistory].filter(found => found.matchupId === expected.matchupId);
        if (matches.length === 1) {
          pair(expected, matches[0]);
        } else if (matches.length > 1) {
          out.fail(
            `${expected.label} has ${matches.length} gameHistory rows with explicit matchup ID ${shortId(expected.matchupId)}`,
            2
          );
          remainingExpected.delete(expected);
          matches.forEach(found => {
            remainingHistory.delete(found);
            unusedHistories.delete(found);
          });
        }
      });

      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const expected of [...remainingExpected]) {
          const context = contextKey(expected);
          if (!context) continue;
          const candidates = [...remainingHistory].filter(found => contextKey(found) === context);
          if (candidates.length !== 1) continue;
          const reverse = [...remainingExpected].filter(other => contextKey(other) === context);
          if (reverse.length !== 1) continue;
          if (pair(expected, candidates[0])) progressed = true;
        }
      }

      progressed = true;
      while (progressed) {
        progressed = false;
        for (const expected of [...remainingExpected]) {
          if (!expected.opponentId) continue;
          const candidates = [...remainingHistory].filter(found =>
            found.opponentId && found.opponentId === expected.opponentId
          );
          if (candidates.length !== 1) continue;
          const reverse = [...remainingExpected].filter(other =>
            other.opponentId && other.opponentId === candidates[0].opponentId
          );
          if (reverse.length !== 1) continue;
          if (pair(expected, candidates[0])) progressed = true;
        }
      }

      progressed = true;
      while (progressed) {
        progressed = false;
        for (const expected of [...remainingExpected]) {
          const candidates = [...remainingHistory].filter(found => scoreEqual(expected, found));
          if (candidates.length !== 1) continue;
          const candidate = candidates[0];
          const reverse = [...remainingExpected].filter(other => scoreEqual(other, candidate));
          if (reverse.length !== 1) continue;
          if (pair(expected, candidate)) progressed = true;
        }
      }

      if (remainingExpected.size === 1 && remainingHistory.size === 1) {
        const expected = [...remainingExpected][0];
        const found = [...remainingHistory][0];
        if (expected.matchupId && found.matchupId && expected.matchupId !== found.matchupId) {
          out.fail(
            `${formatDateLabel(expected.date)} ${getPlayerLabel(state, expected.playerId)} `
            + `has conflicting explicit matchup IDs ${shortId(expected.matchupId)}/${shortId(found.matchupId)}`,
            0
          );
          remainingExpected.delete(expected);
        } else {
          pair(expected, found);
        }
      }

      if (!remainingExpected.size) return;

      if (!remainingHistory.size) {
        remainingExpected.forEach(expected => out.fail(`${expected.label} has no matching gameHistory row`, 0));
        return;
      }

      ambiguousBases.add(key);
      out.warn(
        `Ambiguous historical matchup/history reconciliation for ${key}: `
        + `${remainingExpected.size} unresolved finalized matchup side(s) and `
        + `${remainingHistory.size} unresolved history row(s) share the same player/date.`,
        5
      );
    });

    const orphan = [...unusedHistories].filter(found => !ambiguousBases.has(`${found.date}|${found.playerId}`));
    if (orphan.length) {
      out.warn(
        `${orphan.length} legacy gameHistory rows have no corresponding finalized matchup. Orphan sample: `
        + `${orphan.slice(0, 5).map(found => `${found.label} on ${formatDateLabel(found.date)}`).join('; ')}.`,
        5
      );
    }

    const result = out.result(options);
    return {
      id: 'matchup-history-reconciliation',
      title: 'Matchups and game history reconcile',
      section: 'Game Data Integrity',
      status: result.status,
      expected: 'Finalized NPC matchup sides reconcile to gameHistory by ID, series/game context, opponent, or one-to-one legacy date/player/score matching.',
      actual: result.summary,
      details: result.details,
      trace: 'state.matchups ↔ state.gameHistory by ID, context, opponent, and one-to-one legacy keys',
      tips: 'Same-day games are matched as a group so one history row cannot be consumed by the wrong matchup. No rows are created, removed, or changed.'
    };
  }

  const api = {
    ...existing,
    buildMatchupHistoryReconciliationAudit
  };
  global.TaskPointsAuditIntegrity = api;
  global.TaskPointsAuditSameDayReconciliation = { buildMatchupHistoryReconciliationAudit };
  if (typeof module !== 'undefined' && module.exports) module.exports = { buildMatchupHistoryReconciliationAudit };
})(typeof window !== 'undefined' ? window : globalThis);
