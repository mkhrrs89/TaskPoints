;(function (global) {
  'use strict';

  const existing = global.TaskPointsAuditIntegrity || {};
  const populated = value => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const finite = value => populated(value) && Number.isFinite(Number(value));
  const isYou = id => String(id || '').toUpperCase() === 'YOU';
  const shortId = id => populated(id) ? (String(id).trim().length > 12 ? `${String(id).trim().slice(0, 8)}…` : String(id).trim()) : '';
  const formatScore = value => Number.isFinite(Number(value)) ? String(Number(Number(value).toFixed(2))) : String(value);
  const validDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
  };


  const REVIEWED_LEGACY_HISTORY = Object.freeze([
    Object.freeze({ id: '1455656d-4aff-4571-acce-37133586187d', date: '2026-04-24', score: 64.9 }),
    Object.freeze({ id: '97b42ce0-4569-4c94-a0bf-d4c60835e5d2', date: '2026-06-14', score: 76.1 }),
    Object.freeze({ id: '0237ebbe-90bd-423e-a5a9-8b949e043958', date: '2026-06-14', score: 43.4 }),
    Object.freeze({ id: '4d6bfb2e-4c60-4543-8297-968aa55abf8c', date: '2026-06-14', score: 47 }),
    Object.freeze({ id: '323d0df8-fbed-4276-b9f7-303816858159', date: '2026-06-14', score: 41.6 }),
    Object.freeze({ id: 'aa3d9527-a07f-4f62-8003-5b6cf211a221', date: '2026-06-14', score: 42.9 }),
    Object.freeze({ id: 'c6d813ac-6418-4a11-9d8d-85df63455cb3', date: '2026-06-14', score: 29.7 }),
    Object.freeze({ id: '1290705e-3c86-4e16-ab0b-84bac53802a2', date: '2026-06-14', score: 37.4 }),
    Object.freeze({ id: '1bd66c72-9770-4858-8b95-ab1dac07202b', date: '2026-06-14', score: 46.8 }),
    Object.freeze({ id: '83a3afce-2e89-47dc-9f76-5a358dccfa9f', date: '2026-06-14', score: 28.7 }),
    Object.freeze({ id: 'd26921d1-9543-4b80-94a3-01c85a6f4853', date: '2026-06-14', score: 43.8 }),
    Object.freeze({ id: '6661a09e-de85-42e6-8bf7-6d1188abbfdd', date: '2026-06-14', score: 61.7 }),
    Object.freeze({ id: '06a9af59-7157-4119-9923-582e045b210c', date: '2026-06-14', score: 40.6 }),
    Object.freeze({ id: '32911f20-67aa-4de4-a126-56d4667ec7ee', date: '2026-06-14', score: 35.7 }),
    Object.freeze({ id: '88d122ae-6f7e-44c9-bc01-8ff960e63cc5', date: '2026-06-14', score: 57.4 }),
    Object.freeze({ id: '5b3ecc5d-8c59-461c-9241-69ab1ebeb53c', date: '2026-06-14', score: 40.1 }),
    Object.freeze({ id: '9e1bc886-f211-4669-ac36-e514a8550ec0', date: '2026-06-14', score: 44 }),
    Object.freeze({ id: 'ee21e7f7-a7ef-4a00-87de-e6aa6d4d6c21', date: '2026-06-14', score: 44.8 }),
    Object.freeze({ id: '5206a3bf-3fb0-480c-875c-5fd82b9f51d2', date: '2026-06-14', score: 44.9 }),
    Object.freeze({ id: '3bf523ed-2d66-4ccd-8365-b5bbef231123', date: '2026-06-14', score: 38.8 }),
    Object.freeze({ id: 'c52424d6-89c2-4b93-ac78-7a7a007cbe65', date: '2026-06-14', score: 59.2 }),
    Object.freeze({ id: 'd61c32ad-7926-46ae-920d-ddf7042415b4', date: '2026-06-14', score: 47.5 }),
    Object.freeze({ id: '86d94b15-f0fe-4946-beee-6f74dd035fd4', date: '2026-06-14', score: 40.1 }),
    Object.freeze({ id: '910c5f7f-7dc4-4902-999a-addece91b69e', date: '2026-06-14', score: 26.9 }),
    Object.freeze({ id: '919d8981-e405-4d74-97c9-8a484514d28a', date: '2026-06-14', score: 53.8 })
  ]);
  const reviewedLegacyById = new Map(REVIEWED_LEGACY_HISTORY.map(item => [item.id, item]));

  function reviewedLegacyIdentity(found) {
    const id = String(found?.row?.id || '').trim();
    const reviewed = reviewedLegacyById.get(id);
    if (!reviewed || found.date !== reviewed.date || !found.score?.valid) return null;
    return Math.abs(Number(found.score.value) - reviewed.score) <= 0.05 ? reviewed : null;
  }

  function isReviewedLegacyOrphan(found, expectations, histories) {
    if (!reviewedLegacyIdentity(found)) return false;
    if (found.matchupId) return false;
    const baseKey = `${found.date}|${found.playerId}`;
    const sameBaseHistory = histories.filter(other =>
      other !== found && `${other.date}|${other.playerId}` === baseKey
    );
    if (sameBaseHistory.length) return false;
    const sameBaseExpectations = expectations.filter(expected =>
      `${expected.date}|${expected.playerId}` === baseKey
    );
    return sameBaseExpectations.length === 0;
  }

  function normalizeDate(values, options) {
    for (const value of values) {
      if (!populated(value)) continue;
      try {
        const key = options && typeof options.dateKey === 'function'
          ? options.dateKey(value)
          : (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : new Date(value).toISOString().slice(0, 10));
        if (validDate(key)) return key;
      } catch (_) {}
    }
    return '';
  }

  function playerLabel(state, playerId) {
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find(item => item && String(item.id) === String(playerId));
    const id = shortId(playerId);
    return player && populated(player.name) ? `${player.name} (${id})` : id || 'unknown player';
  }

  function sideScore(matchup, side) {
    const primary = matchup?.[side === 'A' ? 'scoreA' : 'scoreB'];
    const alias = matchup?.[side === 'A' ? 'playerAScore' : 'playerBScore'];
    const hasPrimary = populated(primary);
    return {
      valid: finite(primary) || (!hasPrimary && finite(alias)),
      value: finite(primary) ? Number(primary) : ((!hasPrimary && finite(alias)) ? Number(alias) : NaN)
    };
  }

  function finalized(matchup) {
    if (!matchup) return false;
    if ([matchup.finalizedAtISO, matchup.completedAtISO, matchup.winnerId, matchup.loserId, matchup.result].some(populated)) return true;
    return sideScore(matchup, 'A').valid && sideScore(matchup, 'B').valid;
  }

  function historyScore(row) {
    if (finite(row?.score)) return { valid: true, value: Number(row.score), fallback: false };
    if (!populated(row?.score) && finite(row?.points)) return { valid: true, value: Number(row.points), fallback: true, field: 'points' };
    if (!populated(row?.score) && finite(row?.total)) return { valid: true, value: Number(row.total), fallback: true, field: 'total' };
    return { valid: false, value: NaN, fallback: false };
  }

  function contextKey(item) {
    const row = item.row || item.matchup || {};
    const fields = [row.seasonId, row.seriesId || row.seasonSeriesId, row.roundId, row.gameNumber || row.seriesGameNumber, row.matchupType];
    return fields.some(populated) ? fields.map(value => populated(value) ? String(value).trim() : '').join('|') : '';
  }

  function matchupLabel(matchup, index) {
    const context = [matchup?.seasonId, matchup?.seriesId || matchup?.seasonSeriesId, matchup?.roundId, matchup?.gameNumber || matchup?.seriesGameNumber, matchup?.matchupType]
      .filter(populated).join(' ');
    return `Matchup ${context || shortId(matchup?.id || matchup?.matchupId) || `#${index + 1}`}`;
  }

  function collector() {
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
        const requested = Number(options?.detailLimit);
        const limit = Number.isInteger(requested) && requested >= 0 ? requested : 75;
        return {
          status: failures ? 'FAIL' : (warnings ? 'WARN' : 'PASS'),
          summary: failures || warnings ? `${failures} failure(s), ${warnings} warning(s)` : 'No issues found',
          details: details.length <= limit ? details : details.slice(0, limit).concat(`… ${details.length - limit} additional issue(s) omitted.`)
        };
      }
    };
  }

  function groupByDatePlayer(rows) {
    const groups = new Map();
    rows.forEach(row => {
      const key = `${row.date}|${row.playerId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return groups;
  }

  function buildMatchupHistoryReconciliationAudit(state, options = {}) {
    const out = collector();
    const expectations = [];
    const histories = [];
    const historyIds = new Set();

    (Array.isArray(state?.matchups) ? state.matchups : []).forEach((matchup, index) => {
      if (!finalized(matchup)) return;
      const date = normalizeDate([matchup.dateKey, matchup.date, matchup.completedAtISO, matchup.finalizedAtISO], options);
      ['A', 'B'].forEach(side => {
        const playerId = matchup[`player${side}Id`];
        if (!playerId || isYou(playerId)) return;
        const score = sideScore(matchup, side);
        const label = `${matchupLabel(matchup, index)} side ${side} (${playerLabel(state, playerId)})`;
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
          matchupId: populated(matchup.id || matchup.matchupId) ? String(matchup.id || matchup.matchupId).trim() : '',
          label
        });
      });
    });

    (Array.isArray(state?.gameHistory) ? state.gameHistory : []).forEach((row, index) => {
      const rawLabel = `Game history ${shortId(row?.id) || `#${index + 1}`}`;
      if (populated(row?.id)) {
        if (historyIds.has(row.id)) out.fail(`Duplicate gameHistory ID ${shortId(row.id)}`, 2);
        else historyIds.add(row.id);
      }
      if (!populated(row?.playerId)) {
        out.fail(`${rawLabel} is missing playerId`, 1);
        return;
      }
      const date = normalizeDate([row.dateKey, row.date, row.completedAtISO, row.createdAtISO], options);
      if (!date) {
        out.fail(`${rawLabel} is missing a usable date`, 1);
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
        label: `${rawLabel} (${playerLabel(state, row.playerId)})`
      });
    });

    const expectedGroups = groupByDatePlayer(expectations);
    const historyGroups = groupByDatePlayer(histories);
    const unused = new Set(histories);
    const ambiguous = new Set();
    const reportedIdConflicts = new Set();
    const scoreEqual = (expected, found) => found.score.valid && Math.abs(expected.score - found.score.value) <= 0.05;

    const consume = (expected, found) => {
      unused.delete(found);
      if (found.score.fallback) out.warn(`${found.label} uses legacy ${found.score.field} instead of score`, 4);
      if (!found.score.valid) out.fail(`${found.label} has no usable score`, 0);
      else if (!scoreEqual(expected, found)) {
        out.fail(`${expected.date} ${playerLabel(state, expected.playerId)} matchup score ${formatScore(expected.score)} differs from history score ${formatScore(found.score.value)}`, 0);
      }
    };

    new Set([...expectedGroups.keys(), ...historyGroups.keys()]).forEach(key => {
      const expectedRows = expectedGroups.get(key) || [];
      const historyRows = historyGroups.get(key) || [];
      const remainingExpected = new Set(expectedRows);
      const remainingHistory = new Set(historyRows);

      const reportIdConflict = (expected, found) => {
        const conflictKey = `${expected.matchupId}|${found.matchupId}|${expected.label}|${found.label}`;
        if (reportedIdConflicts.has(conflictKey)) return;
        reportedIdConflicts.add(conflictKey);
        out.fail(`${expected.date} ${playerLabel(state, expected.playerId)} has conflicting explicit matchup IDs ${shortId(expected.matchupId)}/${shortId(found.matchupId)}`, 0);
      };

      const pair = (expected, found) => {
        if (!remainingExpected.has(expected) || !remainingHistory.has(found)) return false;
        if (expected.matchupId && found.matchupId && expected.matchupId !== found.matchupId) {
          reportIdConflict(expected, found);
          return false;
        }
        remainingExpected.delete(expected);
        remainingHistory.delete(found);
        consume(expected, found);
        return true;
      };

      expectedRows.forEach(expected => {
        if (!remainingExpected.has(expected) || !expected.matchupId) return;
        const matches = [...remainingHistory].filter(found => found.matchupId === expected.matchupId);
        if (matches.length === 1) pair(expected, matches[0]);
        else if (matches.length > 1) {
          out.fail(`${expected.label} has ${matches.length} gameHistory rows with explicit matchup ID ${shortId(expected.matchupId)}`, 2);
          remainingExpected.delete(expected);
          matches.forEach(found => {
            remainingHistory.delete(found);
            unused.delete(found);
          });
        }
      });

      const matchUnique = predicate => {
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const expected of [...remainingExpected]) {
            const candidates = [...remainingHistory].filter(found => predicate(expected, found));
            if (candidates.length !== 1) continue;
            const candidate = candidates[0];
            const reverse = [...remainingExpected].filter(other => predicate(other, candidate));
            if (reverse.length !== 1) continue;
            if (pair(expected, candidate)) progressed = true;
          }
        }
      };

      matchUnique((expected, found) => {
        const context = contextKey(expected);
        return Boolean(context && contextKey(found) === context);
      });
      matchUnique((expected, found) => Boolean(expected.opponentId && found.opponentId && expected.opponentId === found.opponentId));
      matchUnique(scoreEqual);

      if (remainingExpected.size === 1 && remainingHistory.size === 1) {
        const expected = [...remainingExpected][0];
        const found = [...remainingHistory][0];
        if (!pair(expected, found) && expected.matchupId && found.matchupId && expected.matchupId !== found.matchupId) {
          remainingExpected.delete(expected);
        }
      }

      if (!remainingExpected.size) return;
      if (!remainingHistory.size) {
        remainingExpected.forEach(expected => out.fail(`${expected.label} has no matching gameHistory row`, 0));
        return;
      }

      ambiguous.add(key);
      out.warn(`Ambiguous historical matchup/history reconciliation for ${key}: ${remainingExpected.size} unresolved finalized matchup side(s) and ${remainingHistory.size} unresolved history row(s) share the same player/date.`, 5);
    });

    const orphan = [...unused].filter(found => !ambiguous.has(`${found.date}|${found.playerId}`));
    const reviewedLegacy = orphan.filter(found => isReviewedLegacyOrphan(found, expectations, histories));
    const reviewedLegacySet = new Set(reviewedLegacy);
    const unexplainedOrphan = orphan.filter(found => !reviewedLegacySet.has(found));
    if (unexplainedOrphan.length) {
      out.warn(`${unexplainedOrphan.length} legacy gameHistory rows have no corresponding finalized matchup. Orphan sample: ${unexplainedOrphan.slice(0, 5).map(found => `${found.label} on ${found.date}`).join('; ')}.`, 5);
    }

    const result = out.result(options);
    const reviewedDetails = reviewedLegacy.length
      ? [
          `INFO — ${reviewedLegacy.length} reviewed legacy-only gameHistory row(s) are preserved and excluded from warnings only while their reviewed identity and safety conditions remain unchanged.`,
          ...reviewedLegacy.map(found =>
            `INFO — Reviewed legacy-only: ${found.date} · ${playerLabel(state, found.playerId)} · score ${formatScore(found.score.value)} · history ${String(found.row?.id || '')}`
          )
        ]
      : [];
    const reviewedSummary = reviewedLegacy.length
      ? `${result.summary}; ${reviewedLegacy.length} reviewed legacy-only history row(s) preserved`
      : result.summary;
    return {
      id: 'matchup-history-reconciliation',
      title: 'Matchups and game history reconcile',
      section: 'Game Data Integrity',
      status: result.status,
      expected: 'Finalized NPC matchup sides reconcile to gameHistory by ID, series/game context, opponent, or one-to-one legacy date/player/score matching.',
      actual: reviewedSummary,
      details: [...result.details, ...reviewedDetails],
      reviewedLegacyHistory: reviewedLegacy.map(found => ({
        historyId: String(found.row?.id || ''),
        date: found.date,
        playerId: found.playerId,
        player: playerLabel(state, found.playerId),
        score: found.score.value
      })),
      trace: 'state.matchups ↔ state.gameHistory by ID, context, opponent, and one-to-one legacy keys',
      tips: 'Same-day games are matched as a group so one history row cannot be consumed by the wrong matchup. Reviewed legacy-only rows remain visible as PASS-side informational evidence; any new or changed orphan still warns. No rows are created, removed, or changed.'
    };
  }

  global.TaskPointsAuditIntegrity = { ...existing, buildMatchupHistoryReconciliationAudit, REVIEWED_LEGACY_HISTORY };
  global.TaskPointsAuditSameDayReconciliation = { buildMatchupHistoryReconciliationAudit, REVIEWED_LEGACY_HISTORY };
  if (typeof module !== 'undefined' && module.exports) module.exports = { buildMatchupHistoryReconciliationAudit, REVIEWED_LEGACY_HISTORY };
})(typeof window !== 'undefined' ? window : globalThis);
