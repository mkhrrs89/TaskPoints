(function (global) {
  'use strict';

  const DEFAULT_DETAIL_LIMIT = 75;
  const populated = value => value !== null && value !== undefined && value !== '';
  const finiteValue = value => populated(value) && Number.isFinite(Number(value));
  const isYou = id => String(id || '').toUpperCase() === 'YOU';

  function limitDetails(details, options) {
    const requested = Number(options && options.detailLimit);
    const limit = Number.isInteger(requested) && requested >= 0 ? requested : DEFAULT_DETAIL_LIMIT;
    if (details.length <= limit) return details;
    return details.slice(0, limit).concat(`… ${details.length - limit} additional issue(s) omitted.`);
  }

  function issueCollector() {
    const details = [];
    let failures = 0;
    let warnings = 0;
    return {
      fail(message) { failures += 1; details.push(`FAIL — ${message}`); },
      warn(message) { warnings += 1; details.push(`WARN — ${message}`); },
      result(options) {
        return {
          status: failures ? 'FAIL' : (warnings ? 'WARN' : 'PASS'),
          summary: failures || warnings ? `${failures} failure(s), ${warnings} warning(s)` : 'No issues found',
          details: limitDetails(details, options)
        };
      }
    };
  }

  function validLedgerKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function normalizeDate(values, options) {
    for (const value of values) {
      if (!populated(value)) continue;
      try {
        const key = options && typeof options.dateKey === 'function'
          ? options.dateKey(value)
          : (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : new Date(value).toISOString().slice(0, 10));
        if (validLedgerKey(key)) return key;
      } catch (_) { /* Invalid external date values are diagnostic data. */ }
    }
    return '';
  }

  function sideScore(matchup, side) {
    const primaryName = side === 'A' ? 'scoreA' : 'scoreB';
    const aliasName = side === 'A' ? 'playerAScore' : 'playerBScore';
    const primary = matchup && matchup[primaryName];
    const alias = matchup && matchup[aliasName];
    const hasPrimary = populated(primary);
    const hasAlias = populated(alias);
    const primaryFinite = finiteValue(primary);
    const aliasFinite = finiteValue(alias);
    return {
      primaryName, aliasName, hasPrimary, hasAlias, primaryFinite, aliasFinite,
      conflict: hasPrimary && hasAlias && (!primaryFinite || !aliasFinite || Math.abs(Number(primary) - Number(alias)) > 0.05),
      valid: primaryFinite || (!hasPrimary && aliasFinite),
      value: primaryFinite ? Number(primary) : ((!hasPrimary && aliasFinite) ? Number(alias) : NaN)
    };
  }

  function finalized(matchup) {
    if (!matchup) return false;
    if (populated(matchup.finalizedAtISO) || populated(matchup.completedAtISO) || populated(matchup.winnerId) || populated(matchup.loserId) || populated(matchup.result)) return true;
    const a = sideScore(matchup, 'A');
    const b = sideScore(matchup, 'B');
    return a.valid && b.valid;
  }

  function historyScore(row) {
    if (finiteValue(row && row.score)) return { valid: true, value: Number(row.score), fallback: false };
    if (!populated(row && row.score)) {
      if (finiteValue(row && row.points)) return { valid: true, value: Number(row.points), fallback: true, field: 'points' };
      if (finiteValue(row && row.total)) return { valid: true, value: Number(row.total), fallback: true, field: 'total' };
    }
    return { valid: false, value: NaN, fallback: false };
  }

  function buildNpcScoreHealthAudit(state, options = {}) {
    const out = issueCollector();
    const min = finiteValue(options.npcScoreMin) ? Number(options.npcScoreMin) : 5;
    const max = finiteValue(options.npcScoreMax) ? Number(options.npcScoreMax) : 85;
    const today = validLedgerKey(options.todayKey) ? options.todayKey : '';
    const classifyRange = (value, date, label) => {
      if (value >= min && value <= max) return;
      if (date && today && date < today) out.warn(`${label} score ${value} is outside ${min}–${max} (historical)`);
      else out.fail(`${label} score ${value} is outside ${min}–${max}`);
    };

    (Array.isArray(state && state.matchups) ? state.matchups : []).forEach((matchup, index) => {
      const date = normalizeDate([matchup && matchup.dateKey, matchup && matchup.date, matchup && matchup.completedAtISO, matchup && matchup.finalizedAtISO], options);
      ['A', 'B'].forEach(side => {
        const playerId = matchup && matchup[`player${side}Id`];
        if (!playerId || isYou(playerId)) return;
        const score = sideScore(matchup, side);
        const label = `Matchup ${matchup.id || matchup.matchupId || `#${index + 1}`} side ${side}`;
        if (score.conflict) out.fail(`${label} has conflicting ${score.primaryName}/${score.aliasName} aliases`);
        if (!finalized(matchup)) return;
        if (!score.valid) out.fail(`${label} has a missing or nonfinite NPC score`);
        else classifyRange(score.value, date, label);
      });
    });

    (Array.isArray(state && state.gameHistory) ? state.gameHistory : []).forEach((row, index) => {
      if (!row || !row.playerId || isYou(row.playerId)) return;
      const label = `Game history ${row.id || `#${index + 1}`}`;
      const score = historyScore(row);
      if (!score.valid) out.fail(`${label} has a missing or nonfinite score`);
      else {
        if (score.fallback) out.warn(`${label} uses legacy ${score.field} instead of score`);
        classifyRange(score.value, normalizeDate([row.dateKey, row.date, row.completedAtISO, row.createdAtISO], options), label);
      }
    });

    (Array.isArray(state && state.opponentDripSchedules) ? state.opponentDripSchedules : []).forEach((schedule, index) => {
      if (!schedule || !populated(schedule.total)) return;
      const label = `Opponent drip schedule ${schedule.id || `#${index + 1}`}`;
      if (!finiteValue(schedule.total)) out.fail(`${label} has a nonfinite total`);
      else classifyRange(Number(schedule.total), normalizeDate([schedule.dateKey, schedule.date, schedule.completedAtISO, schedule.createdAtISO], options), label);
    });

    (Array.isArray(state && state.players) ? state.players : []).forEach((player, index) => {
      if (!player || isYou(player.id) || player.active === false || player.inactive === true || player.archived === true) return;
      if (!finiteValue(player.baseline)) out.fail(`Active NPC ${player.name || player.id || `#${index + 1}`} has an invalid baseline`);
    });
    const result = out.result(options);
    return { id: 'npc-score-health', title: 'NPC score health', section: 'Game Data Integrity', status: result.status, expected: `NPC scores are finite and remain within ${min}–${max}; score aliases agree`, actual: result.summary, details: result.details, trace: 'state.matchups + state.gameHistory + state.opponentDripSchedules + state.players', tips: 'Historical problems are reported only. This audit never rewrites scores or matchup results.' };
  }

  function buildMatchupHistoryReconciliationAudit(state, options = {}) {
    const out = issueCollector();
    const expectations = new Map();
    (Array.isArray(state && state.matchups) ? state.matchups : []).forEach((matchup, index) => {
      if (!finalized(matchup)) return;
      const date = normalizeDate([matchup.dateKey, matchup.date, matchup.completedAtISO, matchup.finalizedAtISO], options);
      ['A', 'B'].forEach(side => {
        const playerId = matchup[`player${side}Id`];
        if (!playerId || isYou(playerId)) return;
        const score = sideScore(matchup, side);
        const label = `Matchup ${matchup.id || matchup.matchupId || `#${index + 1}`} side ${side}`;
        if (!date || !score.valid) { out.fail(`${label} cannot be reconciled because its date or score is unusable`); return; }
        const key = `${date}|${playerId}`;
        const expected = { date, playerId, score: score.value, matchupId: matchup.id || matchup.matchupId || '', side, label };
        if (expectations.has(key)) out.fail(`More than one finalized matchup exists for ${key}`);
        else expectations.set(key, expected);
      });
    });

    const ids = new Set();
    const history = new Map();
    (Array.isArray(state && state.gameHistory) ? state.gameHistory : []).forEach((row, index) => {
      const label = `Game history ${row && (row.id || `#${index + 1}`)}`;
      if (row && populated(row.id)) { if (ids.has(row.id)) out.fail(`Duplicate gameHistory ID ${row.id}`); else ids.add(row.id); }
      if (!row || !populated(row.playerId)) { out.fail(`${label} is missing playerId`); return; }
      const date = normalizeDate([row.dateKey, row.date, row.completedAtISO, row.createdAtISO], options);
      if (!date) { out.fail(`${label} is missing a usable date`); return; }
      if (isYou(row.playerId)) return;
      const key = `${date}|${row.playerId}`;
      if (history.has(key)) out.fail(`More than one gameHistory row exists for ${key}`);
      else history.set(key, { row, label, score: historyScore(row) });
    });

    expectations.forEach((expected, key) => {
      const found = history.get(key);
      if (!found) { out.fail(`${expected.label} has no matching gameHistory row`); return; }
      if (found.score.fallback) out.warn(`${found.label} uses legacy ${found.score.field} instead of score`);
      if (!found.score.valid) out.fail(`${found.label} has no usable score`);
      else if (Math.abs(expected.score - found.score.value) > 0.05) out.fail(`${key} matchup score ${expected.score} differs from history score ${found.score.value}`);
      const historyMatchupId = found.row.matchupId;
      if (expected.matchupId && historyMatchupId && String(expected.matchupId) !== String(historyMatchupId)) out.fail(`${key} has conflicting matchup IDs ${expected.matchupId}/${historyMatchupId}`);
      else if (expected.matchupId && !historyMatchupId) out.warn(`${found.label} lacks matchupId ${expected.matchupId}`);
    });
    history.forEach((found, key) => { if (!expectations.has(key)) out.warn(`${found.label} has no corresponding finalized matchup`); });
    const result = out.result(options);
    return { id: 'matchup-history-reconciliation', title: 'Matchups and game history reconcile', section: 'Game Data Integrity', status: result.status, expected: 'Each finalized NPC matchup side has exactly one matching gameHistory row with the same date, player, score, and compatible matchup ID', actual: result.summary, details: result.details, trace: 'state.matchups ↔ state.gameHistory by dateKey + playerId', tips: 'Orphan legacy history is reported as a warning. No rows are created, removed, or changed.' };
  }

  function buildHabitLedgerConsistencyAudit(state, options = {}) {
    const out = issueCollector();
    const habits = Array.isArray(state && state.habits) ? state.habits : [];
    const byId = new Map();
    const ledgers = new Map();
    habits.forEach((habit, index) => {
      const label = `Habit ${habit && (habit.title || habit.id) || `#${index + 1}`}`;
      if (!habit || !populated(habit.id)) out.fail(`${label} is missing id`);
      else byId.set(String(habit.id), habit);
      const arrays = {};
      ['doneKeys', 'failedKeys', 'iceKeys'].forEach(name => {
        const value = habit && habit[name];
        if (populated(value) && !Array.isArray(value)) out.fail(`${label} ${name} is not an array`);
        const safe = Array.isArray(value) ? value.slice() : [];
        arrays[name] = safe;
        const seen = new Set();
        safe.forEach(key => {
          if (!validLedgerKey(key)) out.fail(`${label} ${name} contains invalid date key ${String(key)}`);
          if (seen.has(key)) out.warn(`${label} ${name} contains duplicate ${String(key)}`);
          seen.add(key);
        });
      });
      const done = new Set(arrays.doneKeys);
      const failed = new Set(arrays.failedKeys);
      arrays.doneKeys.forEach(key => { if (failed.has(key)) out.fail(`${label} marks ${key} both done and failed`); });
      arrays.iceKeys.forEach(key => { if (!done.has(key)) out.fail(`${label} iceKey ${key} is not in doneKeys`); });
      if (habit && habit.category === 'vice' && arrays.iceKeys.length) out.warn(`${label} is a vice with iceKeys`);
      if (habit && populated(habit.id)) ledgers.set(String(habit.id), { habit, label, done, failed, ice: new Set(arrays.iceKeys) });
    });

    const completionIds = new Set();
    const completionKeys = new Set();
    (Array.isArray(state && state.completions) ? state.completions : []).forEach((completion, index) => {
      if (!completion || (completion.source !== 'habit' && completion.source !== 'vice')) return;
      const label = `Completion ${completion.id || `#${index + 1}`}`;
      if (populated(completion.id)) { if (completionIds.has(completion.id)) out.fail(`Duplicate completion ID ${completion.id}`); else completionIds.add(completion.id); }
      const habitId = completion.habitId || completion.viceId;
      if (!completion.habitId && completion.viceId) out.warn(`${label} uses legacy viceId alias`);
      if (!habitId) { out.fail(`${label} is missing a habit reference`); return; }
      const ledger = ledgers.get(String(habitId));
      if (!ledger) { out.fail(`${label} references nonexistent habit ${habitId}`); return; }
      let day = completion.dayKey || completion.dateKey;
      if (!validLedgerKey(day)) {
        const fallback = normalizeDate([completion.completedAtISO], options);
        if (fallback) { day = fallback; out.warn(`${label} derives ${day} from completedAtISO because dayKey is invalid`); }
        else { out.fail(`${label} has no valid dayKey or completedAtISO`); return; }
      }
      const key = `${habitId}|${day}`;
      if (completionKeys.has(key)) out.fail(`Duplicate habit/date completion ${key}`);
      completionKeys.add(key);
      const isVice = ledger.habit.category === 'vice';
      if ((isVice ? 'vice' : 'habit') !== completion.source) out.fail(`${label} source ${completion.source} does not match habit category`);
      if (ledger.failed.has(day)) out.fail(`${label} exists on failedKey ${day}`);
      if (!ledger.done.has(day)) out.fail(`${label} exists without ${day} in doneKeys`);
      const fractionPopulated = populated(completion.completionFraction);
      const fraction = fractionPopulated ? Number(completion.completionFraction) : 1;
      if (fractionPopulated && (fraction !== 0.5 && fraction !== 1)) out.fail(`${label} has invalid completionFraction ${completion.completionFraction}`);
      if (isVice && fraction === 0.5) out.fail(`${label} is a half vice completion`);
      if (!isVice && fraction === 0.5 && ledger.habit.halfPointEnabled === false) out.warn(`${label} is half-complete although half points are disabled`);
      const pointsPerDay = ledger.habit.pointsPerDay;
      if (!finiteValue(pointsPerDay)) out.fail(`${ledger.label} has malformed pointsPerDay`);
      if (!finiteValue(completion.points)) out.fail(`${label} has nonfinite points`);
      if (finiteValue(pointsPerDay) && finiteValue(completion.points) && (fraction === 0.5 || fraction === 1)) {
        const base = Number(pointsPerDay);
        const expected = ledger.ice.has(day) ? Number((base + 0.5).toFixed(1)) : (isVice ? base : base * fraction);
        if (Math.abs(Number(completion.points) - expected) > 0.01) {
          const message = `${label} has ${completion.points} points; expected ${expected}`;
          if (day === options.todayKey) out.fail(message); else out.warn(`${message} (historical)`);
        }
      }
    });
    ledgers.forEach((ledger, habitId) => ledger.done.forEach(day => { if (validLedgerKey(day) && !completionKeys.has(`${habitId}|${day}`)) out.warn(`${ledger.label} doneKey ${day} has no completion row`); }));
    const result = out.result(options);
    return { id: 'habit-ledger-consistency', title: 'Habit ledger consistency', section: 'Habit Ledger Integrity', status: result.status, expected: 'Habit/Vice done, failed, ice, and completion records agree by habit and date', actual: result.summary, details: result.details, trace: 'state.habits doneKeys/failedKeys/iceKeys ↔ state.completions source/habitId/dayKey', tips: 'Legacy doneKeys without completion rows are warnings only. This audit does not create or delete completion entries.' };
  }

  const api = { buildNpcScoreHealthAudit, buildMatchupHistoryReconciliationAudit, buildHabitLedgerConsistencyAudit };
  global.TaskPointsAuditIntegrity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
