(function installSeasonTwoMissedPlayInRecovery(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const SEASON_ID = 'season_2_august_2026';
  const PRESET_ID = 'season2_60_august_2026';
  const RECOVERY_KEY = 'season2MissedPlayInRecoveryAtISO';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function rowDateKey(row) {
    return String(
      row?.dateKey
      || row?.date
      || row?.completedAtISO
      || row?.recordedAtISO
      || ''
    ).slice(0, 10);
  }

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function addScore(scores, playerId, value) {
    const id = String(playerId || '');
    const score = finite(value);
    if (!id || score == null || scores.has(id)) return;
    scores.set(id, score);
  }

  function buildDailyScoreIndex(state, dateKey) {
    const scores = new Map();

    (Array.isArray(state?.gameHistory) ? state.gameHistory : []).forEach((row) => {
      if (rowDateKey(row) !== dateKey) return;
      addScore(scores, row?.playerId, row?.score ?? row?.points ?? row?.total);
    });

    const collectMatchup = (row) => {
      if (rowDateKey(row) !== dateKey) return;
      addScore(scores, row?.playerAId, row?.scoreA ?? row?.playerAScore);
      addScore(scores, row?.playerBId, row?.scoreB ?? row?.playerBScore);
    };

    (Array.isArray(state?.matchups) ? state.matchups : []).forEach(collectMatchup);
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => {
      const dayKey = String(day?.dateKey || day?.date || '').slice(0, 10);
      if (dayKey !== dateKey) return;
      (Array.isArray(day?.matchups) ? day.matchups : []).forEach((row) => {
        collectMatchup({ ...row, dateKey: row?.dateKey || dayKey, date: row?.date || dayKey });
      });
    });

    return scores;
  }

  function configuredPlayInWindow(season) {
    return (Array.isArray(season?.dateWindows) ? season.dateWindows : [])
      .find((round) => round?.id === 'play_in') || null;
  }

  function isTargetSeason(season) {
    const playIn = configuredPlayInWindow(season);
    return Boolean(
      season
      && season.id === SEASON_ID
      && season?.bracketConfig?.presetId === PRESET_ID
      && playIn?.startDate === '2026-08-01'
      && playIn?.endDate === '2026-08-01'
      && Number(playIn?.bestOf) === 1
    );
  }

  function playInSeries(season) {
    return Object.values(season?.series || {})
      .filter((series) => series?.roundId === 'play_in')
      .sort((a, b) => (Number(a?.seriesIndex) || 0) - (Number(b?.seriesIndex) || 0));
  }

  function isSeriesResolved(series) {
    return Boolean(
      series?.winnerId
      || series?.status === 'complete'
      || (Array.isArray(series?.gameResults) && series.gameResults.length > 0)
    );
  }

  function repairMissedPlayIn(state, options = {}) {
    const normalized = typeof core?.normalizeState === 'function'
      ? core.normalizeState(state || {})
      : clone(state || {});
    const season = normalized.currentSeason;
    const effectiveDateKey = String(options.effectiveDateKey || options.dateKey || '').slice(0, 10);
    const nowISO = options.nowISO || new Date().toISOString();

    if (!isTargetSeason(season)) {
      return { ok: true, changed: false, reason: 'not_target_season', state: normalized, recoveredSeriesIds: [] };
    }
    if (season?.meta?.[RECOVERY_KEY]) {
      return { ok: true, changed: false, reason: 'already_recovered', state: normalized, recoveredSeriesIds: [] };
    }
    if (!effectiveDateKey || effectiveDateKey <= '2026-08-01') {
      return { ok: true, changed: false, reason: 'play_in_day_not_closed', state: normalized, recoveredSeriesIds: [] };
    }
    if (
      typeof core?.prepareSeasonForDailySlate !== 'function'
      || typeof core?.recordSeasonSeriesGameResult !== 'function'
      || typeof core?.advanceSeasonSeriesWinner !== 'function'
    ) {
      return { ok: false, changed: false, reason: 'core_helpers_unavailable', state: normalized, recoveredSeriesIds: [] };
    }

    const allPlayIns = playInSeries(season);
    const unresolved = allPlayIns.filter((series) => !isSeriesResolved(series));
    if (!allPlayIns.length) {
      return { ok: false, changed: false, reason: 'play_in_series_missing', state: normalized, recoveredSeriesIds: [] };
    }

    const scores = buildDailyScoreIndex(normalized, '2026-08-01');
    const missingPlayerIds = Array.from(new Set(unresolved.flatMap((series) => [series?.playerAId, series?.playerBId])
      .filter((playerId) => playerId && !scores.has(String(playerId)))));
    if (missingPlayerIds.length) {
      return {
        ok: false,
        changed: false,
        reason: 'missing_play_in_scores',
        state: normalized,
        recoveredSeriesIds: [],
        missingPlayerIds
      };
    }

    let nextSeason = season;
    const prepared = core.prepareSeasonForDailySlate(nextSeason, '2026-08-01', {
      ...options,
      nowISO,
      state: normalized,
      currentState: normalized
    });
    if (prepared?.season) nextSeason = prepared.season;

    const recoveredSeriesIds = [];
    for (const originalSeries of unresolved) {
      const series = nextSeason?.series?.[originalSeries.id] || originalSeries;
      const scoreA = scores.get(String(series.playerAId));
      const scoreB = scores.get(String(series.playerBId));
      const matchupId = `recovered_${series.id}_2026-08-01_g1`;
      const recorded = core.recordSeasonSeriesGameResult(nextSeason, series.id, {
        id: matchupId,
        matchupId,
        seasonId: nextSeason.id,
        seriesId: series.id,
        seasonSeriesId: series.id,
        roundId: series.roundId,
        date: '2026-08-01',
        dateKey: '2026-08-01',
        gameNumber: 1,
        seriesGameNumber: 1,
        game: 1,
        playerAId: series.playerAId,
        playerBId: series.playerBId,
        scoreA,
        scoreB,
        playerAScore: scoreA,
        playerBScore: scoreB,
        matchupType: 'tournament',
        source: 'season2_missed_playin_recovery',
        recoveredFromDailyScores: true
      }, { ...options, nowISO });

      if (!recorded?.ok || !recorded?.season || !recorded?.series?.winnerId) {
        return {
          ok: false,
          changed: false,
          reason: 'record_play_in_failed',
          failedSeriesId: series.id,
          state: normalized,
          recoveredSeriesIds: []
        };
      }

      const advanced = core.advanceSeasonSeriesWinner(recorded.season, series.id, { ...options, nowISO });
      if (!advanced?.ok || !advanced?.season) {
        return {
          ok: false,
          changed: false,
          reason: 'advance_play_in_failed',
          failedSeriesId: series.id,
          state: normalized,
          recoveredSeriesIds: []
        };
      }

      nextSeason = advanced.season;
      recoveredSeriesIds.push(series.id);
    }

    nextSeason = {
      ...nextSeason,
      status: nextSeason.status === 'locked' ? 'active' : nextSeason.status,
      updatedAtISO: nowISO,
      meta: {
        ...(nextSeason.meta || {}),
        seasonMatchupControlEnabled: true,
        [RECOVERY_KEY]: nowISO,
        season2MissedPlayInRecoveredSeriesIds: recoveredSeriesIds,
        season2MissedPlayInRecoverySourceDateKey: '2026-08-01'
      }
    };

    const nextState = typeof core?.normalizeState === 'function'
      ? core.normalizeState({
          ...normalized,
          currentSeason: nextSeason,
          latestSeasonId: nextSeason.id || normalized.latestSeasonId || ''
        })
      : {
          ...normalized,
          currentSeason: nextSeason,
          latestSeasonId: nextSeason.id || normalized.latestSeasonId || ''
        };

    return {
      ok: true,
      changed: recoveredSeriesIds.length > 0 || season?.meta?.seasonMatchupControlEnabled !== true,
      reason: recoveredSeriesIds.length ? 'recovered' : 'matchup_control_enabled',
      state: nextState,
      recoveredSeriesIds,
      missingPlayerIds: []
    };
  }

  function runAutomaticRecovery(options = {}) {
    if (!core?.loadAppState || !core?.saveStateSnapshot) return null;
    const now = options.now instanceof Date ? options.now : new Date();
    const effectiveDateKey = options.effectiveDateKey
      || (typeof core.dateKey === 'function' ? core.dateKey(now) : now.toISOString().slice(0, 10));
    let loaded;
    try {
      loaded = core.loadAppState({ syncDerived: false, persistSync: false });
    } catch (error) {
      console.warn('Season 2 Play-In recovery could not load state.', error);
      return { ok: false, changed: false, reason: 'load_failed', error };
    }

    const result = repairMissedPlayIn(loaded?.state || loaded || {}, {
      ...options,
      effectiveDateKey,
      nowISO: options.nowISO || now.toISOString()
    });
    global.__tpSeason2MissedPlayInRecovery = result;

    if (!result?.ok) {
      if (result?.reason !== 'not_target_season' && result?.reason !== 'play_in_day_not_closed') {
        console.warn('Season 2 Play-In recovery did not run:', result);
      }
      return result;
    }
    if (!result.changed) return result;

    try {
      const saved = core.saveStateSnapshot(result.state, {
        savePath: 'season2-missed-play-in-recovery',
        immediateWrite: true,
        userInitiated: false
      });
      result.state = saved?.state || saved || result.state;
      console.info(`Recovered ${result.recoveredSeriesIds.length} missed Season 2 Play-In result(s).`);
      return result;
    } catch (error) {
      console.error('Season 2 Play-In recovery save failed.', error);
      return { ...result, ok: false, changed: false, reason: 'save_failed', error };
    }
  }

  const api = {
    SEASON_ID,
    PRESET_ID,
    RECOVERY_KEY,
    buildDailyScoreIndex,
    repairMissedPlayIn,
    runAutomaticRecovery
  };

  global.TaskPointsSeasonTwoRecovery = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (global.document) runAutomaticRecovery();
})(typeof window !== 'undefined' ? window : globalThis);
