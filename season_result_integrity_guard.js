;(function installSeasonResultIntegrity(g) {
  'use strict';
  const c = g?.TaskPointsCore;
  if (!c || c.__seasonResultIntegrityGuardInstalled) return;
  c.__seasonResultIntegrityGuardInstalled = true;

  const finals = new Set(['complete', 'completed', 'final', 'finalized', 'finished']);
  const original = {};
  [
    'loadAppState', 'saveStateSnapshot', 'saveAppState',
    'syncCurrentSeasonSeriesFromRecordedResults', 'buildSeasonDailySlate',
    'materializeSeasonSlateMatchupsForDate', 'repairSeasonControlledScheduleFromSyncedSeason',
    'recalculateSeasonSeriesFromGameResults', 'recalculateAllSeasonSeriesFromGameResults',
    'backfillLateBoundSeasonSeriesResults'
  ].forEach((name) => {
    original[name] = typeof c[name] === 'function' ? c[name].bind(c) : null;
  });

  let saving = false;
  let statAttempts = 0;
  const copy = (value) => {
    if (value == null) return value;
    if (typeof g.structuredClone === 'function') {
      try { return g.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  };
  const dateKey = (value) => {
    if (value == null || value === '') return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const rowDate = (row) => {
    for (const value of [row?.dateKey, row?.date, row?.dayKey, row?.dateISO, row?.completedAtISO, row?.finalizedAtISO, row?.createdAtISO, row?.recordedAtISO]) {
      const key = dateKey(value);
      if (key) return key;
    }
    return '';
  };
  const today = (options = {}) => {
    const explicit = String(options.actualTodayDateKey || options.realTodayDateKey || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
    const coreToday = String(c.todayKey?.() || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(coreToday) ? coreToday : dateKey(new Date());
  };
  const nowIso = (options = {}) => options.actualNowISO || new Date().toISOString();
  const type = (row) => String(row?.matchupType || '').trim().toLowerCase();
  const isLegacy = (row) => Boolean(row && (row.legacySeasonExhibition === true || !type(row)));
  const isTyped = (row) => row?.legacySeasonExhibition !== true && ['tournament', 'season', 'exhibition'].includes(type(row));
  const playerList = (rows) => {
    const ids = [];
    for (const row of rows) {
      const a = String(row?.playerAId || '');
      const b = String(row?.playerBId || '');
      if (!a || !b || a === b) return null;
      ids.push(a, b);
    }
    return ids;
  };
  const completeSlate = (rows) => {
    const ids = playerList(rows);
    return Boolean(ids && ids.length === rows.length * 2 && new Set(ids).size === ids.length);
  };
  const samePlayers = (left, right) => {
    const a = playerList(left);
    const b = playerList(right);
    if (!a || !b || a.length !== b.length) return false;
    const set = new Set(a);
    return set.size === new Set(b).size && b.every((id) => set.has(id));
  };
  function duplicateDates(rows) {
    const days = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const key = rowDate(row);
      if (!key) return;
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(row);
    });
    const result = new Set();
    days.forEach((dayRows, key) => {
      const canonical = dayRows.filter(isTyped);
      const legacy = dayRows.filter(isLegacy);
      if (canonical.length >= 4 && canonical.length === legacy.length
        && completeSlate(canonical) && completeSlate(legacy) && samePlayers(canonical, legacy)) result.add(key);
    });
    return result;
  }
  function removeDuplicateSlates(state) {
    const dates = duplicateDates(state?.matchups);
    let removed = 0;
    const matchups = (state?.matchups || []).filter((row) => {
      const drop = dates.has(rowDate(row)) && isLegacy(row);
      if (drop) removed += 1;
      return !drop;
    });
    let scheduleRemoved = 0;
    const schedule = (state?.schedule || []).map((day) => {
      const datesInDay = duplicateDates(day?.matchups);
      if (!datesInDay.has(rowDate(day))) return day;
      const rows = (day.matchups || []).filter((row) => {
        const drop = isLegacy(row);
        if (drop) scheduleRemoved += 1;
        return !drop;
      });
      return { ...day, matchups: rows };
    });
    const changed = removed > 0 || scheduleRemoved > 0;
    return { state: changed ? { ...state, matchups, schedule } : state, changed, duplicateDates: [...dates].sort(), dates: [...dates].sort(), removedMatchups: removed, removedScheduleCopies: scheduleRemoved, removed, scheduleRemoved };
  }

  const isFinal = (row) => Boolean(row && (
    row.resultFinal === true || row.final === true || row.isFinal === true || row.completed === true
    || row.completedAtISO || row.finalizedAtISO || row.resultFinalAtISO
    || finals.has(String(row.status || row.resultStatus || row.state || '').toLowerCase())
  ));
  const isSynthetic = (row) => {
    const source = String(row?.source || '').toLowerCase();
    const id = String(row?.id || row?.matchupId || row?.gameId || '').toLowerCase();
    return row?.playInProtectedSlotRepair === true || row?.lateBoundSeriesCatchUp === true
      || row?.catchUpResult === true || source === 'admin_catch_up'
      || id.includes('_protected_slot_repair_game_') || id.includes('_catch_up_');
  };
  const winner = (series) => {
    if (series?.winnerId) return String(series.winnerId);
    const need = Number(series?.winsNeeded) || Math.floor((Number(series?.bestOf) || 1) / 2) + 1;
    const a = Number(series?.winsA) || 0;
    const b = Number(series?.winsB) || 0;
    return a >= need && a > b ? String(series?.playerAId || '') : (b >= need && b > a ? String(series?.playerBId || '') : '');
  };
  function recalc(series, options) {
    if (original.recalculateSeasonSeriesFromGameResults) {
      try { return original.recalculateSeasonSeriesFromGameResults(series, options); } catch (_) {}
    }
    const rows = series.gameResults || [];
    const winsA = rows.filter((row) => row.winnerId === series.playerAId).length;
    const winsB = rows.filter((row) => row.winnerId === series.playerBId).length;
    const need = Number(series.winsNeeded) || Math.floor((Number(series.bestOf) || 1) / 2) + 1;
    const win = winsA >= need && winsA > winsB ? series.playerAId : (winsB >= need && winsB > winsA ? series.playerBId : '');
    return { ...series, winsA, winsB, winnerId: win, loserId: win ? (win === series.playerAId ? series.playerBId : series.playerAId) : '', status: win ? 'complete' : (series.playerAId && series.playerBId ? 'active' : 'pending') };
  }
  function repairSeason(state, options = {}) {
    const season = state?.currentSeason;
    if (!season?.series) return { state, changed: false, live: 0, synthetic: 0, slots: 0 };
    const day = today(options);
    const now = nowIso(options);
    const month = String(season.monthKey || '').slice(0, 7);
    let seriesMap = { ...season.series };
    const invalid = [];
    let changed = false;
    let live = 0;
    let synthetic = 0;
    Object.entries(season.series).forEach(([id, series]) => {
      const rows = series?.gameResults || [];
      const kept = rows.filter((row) => {
        const key = rowDate(row);
        const badSynthetic = isSynthetic(row) && key && month && key.slice(0, 7) !== month;
        const badLive = key && key >= day && !isFinal(row);
        if (badSynthetic) synthetic += 1;
        else if (badLive) live += 1;
        return !badSynthetic && !badLive;
      });
      if (kept.length === rows.length) return;
      const oldWinner = winner(series);
      seriesMap[id] = { ...recalc({ ...series, gameResults: kept }, { ...options, nowISO: now, todayDateKey: day }), updatedAtISO: now };
      if (oldWinner && oldWinner !== winner(seriesMap[id])) invalid.push({ playerId: oldWinner, roundId: String(series.roundId || '') });
      changed = true;
    });
    const order = c.getSeasonRoundOrder?.(season) || ['play_in', 'opening_round', 'round_of_32', 'round_of_16', 'quarterfinals', 'semifinals', 'finals'];
    const index = new Map(order.map((id, i) => [String(id), i]));
    const seen = new Set();
    let slots = 0;
    while (invalid.length) {
      const item = invalid.shift();
      const token = `${item.playerId}|${item.roundId}`;
      if (!item.playerId || seen.has(token)) continue;
      seen.add(token);
      const from = index.has(item.roundId) ? index.get(item.roundId) : -1;
      Object.entries(seriesMap).forEach(([id, series]) => {
        const to = index.has(String(series?.roundId || '')) ? index.get(String(series.roundId)) : 999;
        if (!series || to <= from) return;
        const sides = [];
        if (series.playerAId === item.playerId) sides.push('A');
        if (series.playerBId === item.playerId) sides.push('B');
        if (!sides.length) return;
        const oldWinner = winner(series);
        let next = { ...series };
        sides.forEach((side) => {
          next[`player${side}Id`] = '';
          next[`player${side}Name`] = '';
          next[`player${side}Seed`] = null;
          next[`placeholder${side}`] ||= 'Awaiting winner';
          slots += 1;
        });
        seriesMap[id] = { ...next, gameResults: [], winsA: 0, winsB: 0, winnerId: '', loserId: '', status: 'pending', manualResult: false, resultSource: '', updatedAtISO: now };
        if (oldWinner) invalid.push({ playerId: oldWinner, roundId: String(series.roundId || '') });
        changed = true;
      });
    }
    let nextSeason = changed ? { ...season, series: seriesMap, updatedAtISO: now } : season;
    if (changed && original.recalculateAllSeasonSeriesFromGameResults) {
      try { nextSeason = original.recalculateAllSeasonSeriesFromGameResults(nextSeason, { ...options, nowISO: now, todayDateKey: day })?.season || nextSeason; } catch (_) {}
      nextSeason = { ...nextSeason, updatedAtISO: now };
    }
    return { state: changed ? { ...state, currentSeason: nextSeason } : state, changed, live, synthetic, slots };
  }
  function repair(state, options = {}) {
    const duplicates = removeDuplicateSlates(state || {});
    const season = repairSeason(duplicates.state, options);
    if (!duplicates.changed && !season.changed) return { state, changed: false, diagnostics: null };
    const diagnostics = {
      version: 1,
      repairedAtISO: nowIso(options),
      actualTodayDateKey: today(options),
      duplicateDates: duplicates.dates,
      removedDuplicateMatchups: duplicates.removed,
      removedDuplicateScheduleCopies: duplicates.scheduleRemoved,
      removedLiveSeasonResults: season.live,
      removedOutOfSeasonSyntheticResults: season.synthetic,
      clearedAdvancedSlots: season.slots
    };
    const next = season.state;
    const currentSeason = next.currentSeason ? { ...next.currentSeason, meta: { ...(next.currentSeason.meta || {}), seasonResultIntegrityRepair: diagnostics } } : next.currentSeason;
    return { state: { ...next, currentSeason }, changed: true, diagnostics };
  }

  const priority = (row) => {
    const t = type(row);
    if ((['tournament', 'season'].includes(t) || row?.seriesId || row?.seasonSeriesId || row?.roundId) && row?.legacySeasonExhibition !== true) return 0;
    if (t && t !== 'exhibition') return 1;
    if (!t && row?.legacySeasonExhibition !== true) return 2;
    return t === 'exhibition' && row?.legacySeasonExhibition !== true ? 3 : 4;
  };
  function choose(rows, key = '') {
    return (rows || []).filter((row) => !key || rowDate(row) === key).slice().sort((a, b) => {
      const p = priority(a) - priority(b);
      if (p) return p;
      const f = Number(isFinal(b)) - Number(isFinal(a));
      if (f) return f;
      return String(a?.id || a?.matchupId || '').localeCompare(String(b?.id || b?.matchupId || ''));
    })[0] || null;
  }
  function onePerDay(rows) {
    const order = [];
    const map = new Map();
    (rows || []).forEach((row, i) => {
      const key = rowDate(row) || `_${i}`;
      if (!map.has(key)) order.push(key);
      map.set(key, map.has(key) ? choose([map.get(key), row], key) : row);
    });
    return order.map((key) => map.get(key));
  }
  function safeScheduleState(state, options = {}) {
    const fixed = repair(state, options).state;
    const day = today(options);
    const keep = (row) => !rowDate(row) || rowDate(row) < day || isFinal(row);
    return { ...fixed, matchups: (fixed.matchups || []).filter(keep), gameHistory: (fixed.gameHistory || []).filter(keep) };
  }
  function persist(state, diagnostics, options = {}) {
    if (!original.saveStateSnapshot || saving || options.persistSync === false) return false;
    saving = true;
    try {
      original.saveStateSnapshot(state, { immediateWrite: true, savePath: 'season-result-integrity-repair', source: 'season-result-integrity-repair', integrityRepair: diagnostics });
      return true;
    } catch (error) {
      console.warn('TaskPoints season integrity repair could not be persisted yet.', error);
      return false;
    } finally { saving = false; }
  }
  const repairResult = (result, options) => {
    if (!result?.state) return result;
    const fixed = repair(result.state, options);
    return fixed.changed ? { ...result, state: fixed.state, changed: true, integrityRepair: fixed.diagnostics } : result;
  };

  if (original.loadAppState) c.loadAppState = function loadFixed(options = {}) {
    const loaded = original.loadAppState(options);
    const state = loaded?.state || loaded;
    if (!state || typeof state !== 'object') return loaded;
    const fixed = repair(state, options);
    if (!fixed.changed) return loaded;
    persist(fixed.state, fixed.diagnostics, options);
    return loaded?.state ? { ...loaded, state: fixed.state, integrityRepair: fixed.diagnostics } : fixed.state;
  };
  if (original.saveStateSnapshot) c.saveStateSnapshot = function saveFixed(state, options = {}) {
    return original.saveStateSnapshot(repair(state, options).state, options);
  };
  if (original.saveAppState) c.saveAppState = function saveAppFixed(...args) {
    const options = typeof args[0] === 'string' ? (args[2] || {}) : (args[1] || {});
    const result = original.saveAppState(...args);
    const fixed = repairResult(result, options);
    if (fixed !== result && fixed?.state) persist(fixed.state, fixed.integrityRepair, options);
    return fixed;
  };
  if (original.syncCurrentSeasonSeriesFromRecordedResults) c.syncCurrentSeasonSeriesFromRecordedResults = function syncFixed(state, options = {}) {
    const day = today(options);
    return repairResult(original.syncCurrentSeasonSeriesFromRecordedResults(repair(state, { ...options, actualTodayDateKey: day }).state, { ...options, todayDateKey: day, actualTodayDateKey: day, nowISO: nowIso(options) }), { ...options, actualTodayDateKey: day });
  };
  if (original.buildSeasonDailySlate) c.buildSeasonDailySlate = function buildFixed(state, target, options = {}) {
    const day = today(options);
    const safe = safeScheduleState(state, { ...options, actualTodayDateKey: day });
    const result = original.buildSeasonDailySlate(safe, target, { ...options, todayDateKey: day, actualTodayDateKey: day, nowISO: nowIso(options) });
    if (!result?.updatedSeason) return result;
    const fixed = repair({ ...safe, currentSeason: result.updatedSeason }, { ...options, actualTodayDateKey: day });
    return fixed.changed ? { ...result, updatedSeason: fixed.state.currentSeason, integrityRepair: fixed.diagnostics } : result;
  };
  if (original.materializeSeasonSlateMatchupsForDate) c.materializeSeasonSlateMatchupsForDate = function materializeFixed(state, target, options = {}) {
    const day = today(options);
    const fixed = repair(state, { ...options, actualTodayDateKey: day });
    if (String(target || '').slice(0, 10) > day) return { state: fixed.state, changed: fixed.changed, materializedCount: 0, removedExhibitionCount: 0, removedStaleSeasonCount: 0, blockedFutureMaterialization: true, warnings: ['Future matchup rows were not written into the live ledger.'], errors: [] };
    return repairResult(original.materializeSeasonSlateMatchupsForDate(fixed.state, target, { ...options, todayDateKey: day, actualTodayDateKey: day, nowISO: nowIso(options) }), { ...options, actualTodayDateKey: day });
  };
  if (original.repairSeasonControlledScheduleFromSyncedSeason) c.repairSeasonControlledScheduleFromSyncedSeason = function scheduleFixed(state, options = {}) {
    const day = today(options);
    const fixed = repair(state, { ...options, actualTodayDateKey: day });
    const future = (fixed.state.schedule || []).filter((row) => rowDate(row) > day);
    const current = { ...fixed.state, schedule: (fixed.state.schedule || []).filter((row) => !rowDate(row) || rowDate(row) <= day) };
    const result = original.repairSeasonControlledScheduleFromSyncedSeason(current, { ...options, todayDateKey: day, actualTodayDateKey: day, nowISO: nowIso(options) });
    const merged = [...(result?.state?.schedule || current.schedule), ...future].sort((a, b) => rowDate(a).localeCompare(rowDate(b)));
    const final = repair({ ...(result?.state || current), schedule: merged }, { ...options, actualTodayDateKey: day });
    return { ...result, state: final.state, changed: Boolean(result?.changed || fixed.changed || final.changed), futureScheduleDatesPreserved: future.map(rowDate).filter(Boolean), integrityRepair: final.diagnostics || fixed.diagnostics };
  };
  if (original.backfillLateBoundSeasonSeriesResults) c.backfillLateBoundSeasonSeriesResults = function backfillFixed(state, seasonArg, options = {}) {
    const season = seasonArg || state?.currentSeason;
    if (season?.monthKey && String(season.monthKey).slice(0, 7) !== '2026-06') return { ok: true, state, season, updatedSeason: season, changed: false, backfilledCount: 0, seriesIds: [], skippedIncompatibleSeason: true };
    return original.backfillLateBoundSeasonSeriesResults(state, seasonArg, options);
  };

  function installStats() {
    const current = g.getCompletedYouMatchupsForStats;
    if (typeof current !== 'function') {
      if (++statAttempts < 80) g.setTimeout?.(installStats, 50);
      return false;
    }
    if (current.__taskPointsCanonicalOneResultPerDate) return true;
    const wrapped = function (...args) { return onePerDay(current.apply(this, args)); };
    wrapped.__taskPointsCanonicalOneResultPerDate = true;
    wrapped.__taskPointsOriginal = current;
    g.getCompletedYouMatchupsForStats = wrapped;
    g.TaskPointsHomeYesterdayResultConsistency?.applySavedYesterdayResult?.();
    return true;
  }
  function repairStored() {
    if (!g.localStorage || saving) return false;
    try {
      const key = c.STORAGE_KEY || 'taskpoints_v1';
      const raw = g.localStorage.getItem(key);
      if (!raw) return false;
      const state = c.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
      const fixed = repair(state, {});
      if (!fixed.changed) return false;
      return persist(fixed.state, fixed.diagnostics, {});
    } catch (_) { return false; }
  }

  const api = { installed: true, version: 1, rowDateKey: rowDate, hasExplicitFinalEvidence: isFinal, findDuplicateSlateDateKeys: duplicateDates, removeDuplicateLegacySlates: removeDuplicateSlates, repairCurrentSeasonResults: repairSeason, repairState: repair, chooseCanonicalCompletedMatchup: choose, dedupeCompletedMatchupsByDate: onePerDay, sanitizeStateForScheduling: safeScheduleState, repairAuthoritativeStoredState: repairStored, installCompletedStatsDedupe: installStats };
  c.SeasonResultIntegrity = api;
  g.TaskPointsSeasonResultIntegrity = api;
  installStats();
  repairStored();
  g.setTimeout?.(repairStored, 0);
  g.addEventListener?.('pageshow', () => { installStats(); repairStored(); });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
