;(function installTaskPointsYouScoreAliasAlignment(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__youScoreAliasAlignmentInstalled) return;
  core.__youScoreAliasAlignmentInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const TOLERANCE = 0.000001;
  const originalSyncYouMatchups = typeof core.syncYouMatchups === 'function'
    ? core.syncYouMatchups.bind(core)
    : null;
  const originalLoadAppState = typeof core.loadAppState === 'function'
    ? core.loadAppState.bind(core)
    : null;
  const originalSaveStateSnapshot = typeof core.saveStateSnapshot === 'function'
    ? core.saveStateSnapshot.bind(core)
    : null;
  const originalSaveAppState = typeof core.saveAppState === 'function'
    ? core.saveAppState.bind(core)
    : null;
  const originalMergeAndSaveState = typeof core.mergeAndSaveState === 'function'
    ? core.mergeAndSaveState.bind(core)
    : null;

  let persistingRepair = false;

  let homeAliasRepairFallbackTimer = null;

  function isTaskPointsHomePage() {
    const pathname = String(global.location?.pathname || '');
    return pathname === '/' || pathname.endsWith('/index.html');
  }

  function scheduleHomeAliasRepair() {
    const enqueue = global.TaskPointsHomeIdleQueue?.enqueue;
    if (typeof enqueue === 'function') {
      enqueue('home-you-score-alias-repair', () => repairPersistedState(), { delayMs: 14000 });
      return true;
    }
    if (homeAliasRepairFallbackTimer != null) return true;
    homeAliasRepairFallbackTimer = global.setTimeout?.(() => {
      homeAliasRepairFallbackTimer = null;
      const lateEnqueue = global.TaskPointsHomeIdleQueue?.enqueue;
      if (typeof lateEnqueue === 'function') {
        lateEnqueue('home-you-score-alias-repair', () => repairPersistedState(), { delayMs: 14000 });
      } else {
        global.setTimeout?.(() => repairPersistedState(), 14000);
      }
    }, 0);
    return true;
  }

  function populated(value) {
    return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  }

  function finite(value) {
    return populated(value) && Number.isFinite(Number(value));
  }

  function equalScore(left, right) {
    return finite(left) && finite(right) && Math.abs(Number(left) - Number(right)) <= TOLERANCE;
  }

  function isYou(playerId) {
    return String(playerId || '').toUpperCase() === 'YOU';
  }

  function rowDateKey(row) {
    if (!row || typeof row !== 'object') return '';
    for (const value of [row.dateKey, row.date, row.completedAtISO, row.finalizedAtISO, row.createdAtISO]) {
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

  function recordedSeriesId(row) {
    const helper = core.getRecordedSeriesId;
    if (typeof helper === 'function') {
      try {
        const value = helper(row);
        if (populated(value)) return String(value).trim();
      } catch (_) {}
    }
    const value = row?.seriesId || row?.seasonSeriesId || '';
    return populated(value) ? String(value).trim() : '';
  }

  function currentSeasonId(state) {
    const value = state?.currentSeason?.id || state?.currentSeason?.seasonId || '';
    return populated(value) ? String(value).trim() : '';
  }

  function seasonSeriesIds(state) {
    const series = state?.currentSeason?.series;
    const rows = Array.isArray(series) ? series : Object.values(series || {});
    const ids = new Set();
    rows.forEach((row) => {
      [row?.id, row?.seriesId, row?.seasonSeriesId].forEach((value) => {
        if (populated(value)) ids.add(String(value).trim());
      });
    });
    return ids;
  }

  function isTournamentLike(row) {
    const type = String(row?.matchupType || '').trim().toLowerCase();
    return type === 'tournament' || type === 'season' || Boolean(recordedSeriesId(row));
  }

  function isExplicitCurrentSeasonTournament(row, state, currentSeriesIds = seasonSeriesIds(state)) {
    if (!row || typeof row !== 'object' || !state?.currentSeason) return false;

    const type = String(row.matchupType || '').trim().toLowerCase();
    if (type && type !== 'tournament' && type !== 'season') return false;

    const seasonId = currentSeasonId(state);
    const rowSeasonId = populated(row.seasonId) ? String(row.seasonId).trim() : '';
    const seriesId = recordedSeriesId(row);

    const matchingSeason = Boolean(seasonId && rowSeasonId && seasonId === rowSeasonId);
    const matchingSeries = Boolean(seriesId && currentSeriesIds.has(seriesId));

    // Explicit contradictory metadata always wins over a looser signal.
    if (seasonId && rowSeasonId && !matchingSeason) return false;
    if (seriesId && currentSeriesIds.size && !matchingSeries) return false;

    // A blank-type row is only tournament evidence when its series belongs to
    // the current season. A typed legacy row still needs positive season or
    // current-series identity evidence; matchupType alone is not sufficient.
    if (type !== 'tournament' && type !== 'season') return matchingSeries;
    return matchingSeason || matchingSeries;
  }

  function sameMatchup(left, right) {
    if (!left || !right) return false;
    const leftId = matchupId(left);
    const rightId = matchupId(right);
    if (leftId && rightId) return leftId === rightId;
    if (rowDateKey(left) !== rowDateKey(right)) return false;
    if (String(left.playerAId || '') !== String(right.playerAId || '')) return false;
    if (String(left.playerBId || '') !== String(right.playerBId || '')) return false;
    const leftSeries = recordedSeriesId(left);
    const rightSeries = recordedSeriesId(right);
    if (leftSeries && rightSeries && leftSeries !== rightSeries) return false;
    const leftGame = Number(left.gameNumber || left.seriesGameNumber);
    const rightGame = Number(right.gameNumber || right.seriesGameNumber);
    return !Number.isFinite(leftGame) || !Number.isFinite(rightGame) || leftGame === rightGame;
  }

  function alignmentScope(row, state, options, currentSeriesIds) {
    if (!row || (!isYou(row.playerAId) && !isYou(row.playerBId))) return false;
    if (options.currentSeasonOnly === true) {
      return isExplicitCurrentSeasonTournament(row, state, currentSeriesIds);
    }
    if (options.tournamentOnly === true) return isTournamentLike(row);
    return true;
  }

  function alignRow(row) {
    if (!row || typeof row !== 'object') return { row, changed: false, sides: 0 };
    let next = row;
    let sides = 0;

    if (isYou(row.playerAId) && finite(row.scoreA) && !equalScore(row.scoreA, row.playerAScore)) {
      next = next === row ? { ...row } : next;
      next.playerAScore = Number(row.scoreA);
      sides += 1;
    }
    if (isYou(row.playerBId) && finite(row.scoreB) && !equalScore(row.scoreB, row.playerBScore)) {
      next = next === row ? { ...row } : next;
      next.playerBScore = Number(row.scoreB);
      sides += 1;
    }

    return { row: next, changed: sides > 0, sides };
  }

  function alignYouScoreAliases(stateInput, options = {}) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    const currentSeriesIds = seasonSeriesIds(state);
    let repairedSides = 0;
    let repairedMatchups = 0;
    let repairedScheduleCopies = 0;

    const matchups = (Array.isArray(state.matchups) ? state.matchups : []).map((row) => {
      if (!alignmentScope(row, state, options, currentSeriesIds)) return row;
      const aligned = alignRow(row);
      if (!aligned.changed) return row;
      repairedSides += aligned.sides;
      repairedMatchups += 1;
      return aligned.row;
    });

    const sourceRows = matchups.filter((row) => alignmentScope(row, state, options, currentSeriesIds));
    const schedule = (Array.isArray(state.schedule) ? state.schedule : []).map((day) => {
      if (!Array.isArray(day?.matchups) || !sourceRows.length) return day;
      let dayChanged = false;
      const dayMatchups = day.matchups.map((candidate) => {
        const source = sourceRows.find((row) => sameMatchup(row, candidate));
        if (!source) return candidate;
        const next = { ...candidate };
        let local = false;
        if (isYou(source.playerAId) && finite(source.scoreA) && !equalScore(next.playerAScore, source.scoreA)) {
          next.scoreA = Number(source.scoreA);
          next.playerAScore = Number(source.scoreA);
          local = true;
        }
        if (isYou(source.playerBId) && finite(source.scoreB) && !equalScore(next.playerBScore, source.scoreB)) {
          next.scoreB = Number(source.scoreB);
          next.playerBScore = Number(source.scoreB);
          local = true;
        }
        if (!local) return candidate;
        dayChanged = true;
        repairedScheduleCopies += 1;
        return next;
      });
      return dayChanged ? { ...day, matchups: dayMatchups } : day;
    });

    const changed = repairedMatchups > 0 || repairedScheduleCopies > 0;
    return {
      state: changed ? { ...state, matchups, schedule } : state,
      changed,
      repairedSides,
      repairedMatchups,
      repairedScheduleCopies
    };
  }

  function persistRepair(state, diagnostics, options = {}) {
    if (!originalSaveStateSnapshot || persistingRepair || options.persistSync === false) return false;
    persistingRepair = true;
    try {
      originalSaveStateSnapshot(state, {
        immediateWrite: true,
        savePath: 'you-score-alias-alignment-repair',
        source: 'you-score-alias-alignment-repair',
        youScoreAliasRepair: diagnostics
      });
      return true;
    } catch (error) {
      console.warn('TaskPoints: unable to persist YOU score alias alignment yet.', error);
      return false;
    } finally {
      persistingRepair = false;
    }
  }

  function repairPersistedState(options = {}) {
    if (!global.localStorage || persistingRepair) return { changed: false, repairedSides: 0 };
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { changed: false, repairedSides: 0 };
      const state = core.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
      const result = alignYouScoreAliases(state, { currentSeasonOnly: true });
      if (result.changed) persistRepair(result.state, result, options);
      return result;
    } catch (_) {
      return { changed: false, repairedSides: 0 };
    }
  }

  function alignCurrentSeasonState(state) {
    return alignYouScoreAliases(state, { currentSeasonOnly: true });
  }

  if (originalSyncYouMatchups) {
    core.syncYouMatchups = function syncYouMatchupsWithAlignedAliases(state, options = {}) {
      const result = originalSyncYouMatchups(state, options);
      const syncedState = result?.state || result;
      if (!syncedState || typeof syncedState !== 'object') return result;
      const aligned = alignCurrentSeasonState(syncedState);
      if (!aligned.changed) return result;
      return result?.state
        ? { ...result, state: aligned.state, changed: true, youScoreAliasAlignment: aligned }
        : aligned.state;
    };
    core.syncYouMatchups.__taskPointsYouScoreAliasAlignment = true;
    core.syncYouMatchups.__taskPointsOriginal = originalSyncYouMatchups;
  }

  if (originalLoadAppState) {
    core.loadAppState = function loadAppStateWithAlignedYouAliases(options = {}) {
      const loaded = originalLoadAppState(options);
      const state = loaded?.state || loaded;
      if (!state || typeof state !== 'object') return loaded;
      const aligned = alignCurrentSeasonState(state);
      if (!aligned.changed) return loaded;
      if (isTaskPointsHomePage()) scheduleHomeAliasRepair();
      else persistRepair(aligned.state, aligned, options);
      return loaded?.state
        ? { ...loaded, state: aligned.state, youScoreAliasAlignment: aligned }
        : aligned.state;
    };
    core.loadAppState.__taskPointsYouScoreAliasAlignment = true;
    core.loadAppState.__taskPointsOriginal = originalLoadAppState;
  }

  if (originalSaveStateSnapshot) {
    core.saveStateSnapshot = function saveStateSnapshotWithAlignedYouAliases(state, options = {}) {
      const aligned = alignCurrentSeasonState(state);
      return originalSaveStateSnapshot(aligned.state, options);
    };
    core.saveStateSnapshot.__taskPointsYouScoreAliasAlignment = true;
    core.saveStateSnapshot.__taskPointsOriginal = originalSaveStateSnapshot;
  }

  if (originalSaveAppState) {
    core.saveAppState = function saveAppStateWithAlignedYouAliases(...args) {
      const stateIndex = typeof args[0] === 'string' ? 1 : 0;
      if (args[stateIndex] && typeof args[stateIndex] === 'object') {
        args[stateIndex] = alignCurrentSeasonState(args[stateIndex]).state;
      }
      return originalSaveAppState(...args);
    };
    core.saveAppState.__taskPointsYouScoreAliasAlignment = true;
    core.saveAppState.__taskPointsOriginal = originalSaveAppState;
  }

  if (originalMergeAndSaveState) {
    core.mergeAndSaveState = function mergeAndSaveStateWithAlignedYouAliases(state, options = {}) {
      const aligned = alignCurrentSeasonState(state);
      return originalMergeAndSaveState(aligned.state, options);
    };
    core.mergeAndSaveState.__taskPointsYouScoreAliasAlignment = true;
    core.mergeAndSaveState.__taskPointsOriginal = originalMergeAndSaveState;
  }

  const api = {
    installed: true,
    alignYouScoreAliases,
    repairPersistedState,
    isExplicitCurrentSeasonTournamentMatchup: isExplicitCurrentSeasonTournament
  };
  core.YouScoreAliasAlignment = api;
  global.TaskPointsYouScoreAliasAlignment = api;

  if (isTaskPointsHomePage()) {
    scheduleHomeAliasRepair();
  } else {
    repairPersistedState();
    global.setTimeout?.(repairPersistedState, 0);
  }
  global.addEventListener?.('pageshow', () => {
    if (isTaskPointsHomePage()) scheduleHomeAliasRepair();
    else repairPersistedState();
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
