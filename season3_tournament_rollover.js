;(function installTaskPointsSeasonThreeTournamentRollover(global) {
  'use strict';

  if (global.TaskPointsSeasonThreeTournamentRollover?.installed) return;

  const core = global.TaskPointsCore;
  const builder = global.TaskPointsBracketBuilder;
  if (!core || !builder) return;

  const SEASON_ID = 'season_3_october_2026';
  const SEASON_NAME = 'Season 3';
  const SEASON_LABEL = 'October 2026 TaskPoints Championship';
  const MONTH_KEY = '2026-10';
  const QUALIFICATION_START = '2026-09-01';
  const TOURNAMENT_START = '2026-10-01';
  const TOURNAMENT_END = '2026-10-31';
  const ENTRANT_COUNT = 60;

  function clone(value) {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function rowDateKey(row) {
    const value = row?.dateKey || row?.date || row?.completedAtISO || row?.dateISO || row?.createdAtISO || '';
    return value ? String(value).slice(0, 10) : '';
  }

  function isSeasonThree(season) {
    if (!season || typeof season !== 'object') return false;
    const id = String(season.id || '').toLowerCase();
    const label = String(season.label || '').toLowerCase();
    return season.monthKey === MONTH_KEY
      || id === SEASON_ID
      || id.includes('season_3')
      || id.includes('october_2026')
      || label.includes('october 2026');
  }

  function scopedQualificationState(state) {
    const filterRows = (rows) => (Array.isArray(rows) ? rows : []).filter((row) => {
      const key = rowDateKey(row);
      return key >= QUALIFICATION_START && key < TOURNAMENT_START;
    });
    return {
      ...(state || {}),
      matchups: filterRows(state?.matchups),
      gameHistory: filterRows(state?.gameHistory),
      completions: filterRows(state?.completions)
    };
  }

  function activePool(state) {
    if (typeof core.getActiveSeasonPlayerPool === 'function') {
      try { return core.getActiveSeasonPlayerPool(state || {}).map((player) => ({ ...player })); } catch (_) {}
    }
    const you = { id: 'YOU', name: state?.youName || 'You', isYou: true };
    return [you].concat((Array.isArray(state?.players) ? state.players : [])
      .filter((player) => player && player.active !== false && player.id && player.id !== 'YOU')
      .map((player) => ({ ...player })));
  }

  function allowedPool(state, season) {
    const active = activePool(state);
    const activeById = new Map(active.map((player) => [String(player?.id || player?.playerId || ''), player]));
    const configured = Array.isArray(season?.playerPool) ? season.playerPool : [];
    if (!configured.length) return active;

    const allowedIds = new Set(configured
      .map((player) => String(player?.id || player?.playerId || ''))
      .filter(Boolean));
    return active.filter((player) => allowedIds.has(String(player?.id || player?.playerId || '')));
  }

  function finalQualificationSeeds(state, season) {
    const pool = allowedPool(state, season);
    const allowedIds = new Set(pool.map((player) => String(player?.id || player?.playerId || '')).filter(Boolean));
    const scoped = scopedQualificationState(state);
    const source = typeof core.getSeasonSeedSourceRows === 'function'
      ? core.getSeasonSeedSourceRows(scoped)
      : { rows: [], warnings: [] };
    const existingById = new Map((Array.isArray(season?.seeds) ? season.seeds : [])
      .map((seed) => [String(seed?.playerId || seed?.id || ''), seed]));
    const playerById = new Map(pool.map((player) => [String(player?.id || player?.playerId || ''), player]));

    const rows = (Array.isArray(source?.rows) ? source.rows : [])
      .filter((row) => allowedIds.has(String(row?.playerId || row?.id || '')));

    const seeds = rows.map((row, index) => {
      const playerId = String(row?.playerId || row?.id || '');
      const existing = existingById.get(playerId) || {};
      const player = playerById.get(playerId) || {};
      return {
        ...existing,
        seed: index + 1,
        playerId,
        id: playerId,
        playerName: row?.name || row?.playerName || existing.playerName || player.name || playerId,
        name: row?.name || row?.playerName || existing.name || player.name || playerId,
        imageId: existing.imageId || player.imageId || '',
        wins: Number(row?.wins) || 0,
        losses: Number(row?.losses) || 0,
        winPct: Number.isFinite(Number(row?.winPct)) ? Number(row.winPct) : 0,
        totalPoints: Number(row?.totalPoints) || 0,
        averageScore: Number.isFinite(Number(row?.averageScore)) ? Number(row.averageScore) : 0,
        marginOfVictory: Number.isFinite(Number(row?.marginOfVictory)) ? Number(row.marginOfVictory) : null,
        warningFlags: Array.isArray(existing.warningFlags) ? existing.warningFlags.slice() : []
      };
    });

    return {
      seeds,
      playerPool: pool,
      warnings: Array.isArray(source?.warnings) ? source.warnings.slice() : []
    };
  }

  function buildPreview(state, currentSeason, qualification, nowISO) {
    const structuralWarnings = (Array.isArray(currentSeason?.warnings) ? currentSeason.warnings : [])
      .filter((warning) => warning?.code !== 'incomplete_seeding_data' && warning?.code !== 'season3_insufficient_qualifiers');
    const warnings = structuralWarnings.concat(qualification.warnings || []);
    const options = {
      ...(currentSeason || {}),
      id: SEASON_ID,
      name: currentSeason?.name || SEASON_NAME,
      label: currentSeason?.label || SEASON_LABEL,
      monthKey: MONTH_KEY,
      month: MONTH_KEY,
      startDate: TOURNAMENT_START,
      endDate: TOURNAMENT_END,
      startDateKey: TOURNAMENT_START,
      endDateKey: TOURNAMENT_END,
      status: 'preview',
      seedMode: 'auto',
      seedRankingScope: 'season3',
      playerPool: qualification.playerPool,
      seeds: qualification.seeds,
      warnings,
      createdAtISO: currentSeason?.createdAtISO || nowISO,
      updatedAtISO: nowISO,
      meta: {
        ...(currentSeason?.meta || {}),
        previewOnly: true,
        qualificationFieldSize: ENTRANT_COUNT,
        qualificationRule: 'top_60_season3_rankings',
        qualificationWindowStart: QUALIFICATION_START,
        qualificationWindowEnd: '2026-09-30'
      }
    };
    if (typeof core.createEmptySeasonDraft === 'function') return core.createEmptySeasonDraft(options);
    return options;
  }

  function effectiveDateKey(options = {}) {
    const explicit = options.effectiveDateKey || options.todayDateKey || options.dateKey;
    if (explicit) return String(explicit).slice(0, 10);
    if (typeof core.todayKey === 'function') return String(core.todayKey()).slice(0, 10);
    const now = options.nowISO ? new Date(options.nowISO) : new Date();
    if (Number.isNaN(now.getTime())) return '';
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function ensureSeasonThreeTournamentRollover(stateInput, options = {}) {
    const state = typeof core.normalizeState === 'function'
      ? core.normalizeState(stateInput || {})
      : clone(stateInput || {});
    const dayKey = effectiveDateKey(options);
    const nowISO = options.nowISO || (dayKey ? `${dayKey}T12:00:00.000Z` : new Date().toISOString());

    if (!dayKey || dayKey < TOURNAMENT_START) {
      return { ok: true, changed: false, reason: 'before_tournament_start', state };
    }
    if (dayKey > TOURNAMENT_END && options.allowLateRollover !== true) {
      return { ok: true, changed: false, reason: 'after_tournament_window', state };
    }

    const current = state.currentSeason || null;
    if (current && !isSeasonThree(current)) {
      return { ok: true, changed: false, reason: 'different_current_season', state };
    }
    if (current && current.status !== 'preview') {
      return { ok: true, changed: false, reason: 'season3_already_official', state };
    }
    if (!current && (Array.isArray(state.seasonHistory) ? state.seasonHistory : []).some(isSeasonThree)) {
      return { ok: true, changed: false, reason: 'season3_already_archived', state };
    }

    const qualification = finalQualificationSeeds(state, current);
    if (qualification.seeds.length < ENTRANT_COUNT) {
      return {
        ok: false,
        changed: false,
        reason: 'insufficient_qualifiers',
        error: 'season3_insufficient_qualifiers',
        required: ENTRANT_COUNT,
        available: qualification.seeds.length,
        state
      };
    }

    const preview = buildPreview(state, current, qualification, nowISO);
    const previewState = typeof core.normalizeState === 'function'
      ? core.normalizeState({ ...state, currentSeason: preview, latestSeasonId: SEASON_ID })
      : { ...state, currentSeason: preview, latestSeasonId: SEASON_ID };

    if (typeof builder.createSeasonThreePreset !== 'function' || typeof builder.lockConfiguredSeasonBracket !== 'function') {
      return { ok: false, changed: false, reason: 'builder_unavailable', error: 'season3_builder_unavailable', state };
    }

    const locked = builder.lockConfiguredSeasonBracket(
      previewState,
      builder.createSeasonThreePreset(),
      { nowISO }
    );
    if (!locked?.ok || !locked?.state || !locked?.season) {
      return {
        ...(locked || {}),
        ok: false,
        changed: false,
        reason: locked?.error || 'season3_lock_failed',
        state
      };
    }

    const officialSeason = {
      ...locked.season,
      status: 'locked',
      seedMode: 'auto',
      seedRankingScope: 'season3',
      updatedAtISO: nowISO,
      meta: {
        ...(locked.season.meta || {}),
        seasonMatchupControlEnabled: true,
        seedsLocked: true,
        season3AutoRollover: true,
        season3AutoRolloverDateKey: dayKey,
        qualificationFieldSize: ENTRANT_COUNT,
        qualificationRule: 'top_60_season3_rankings',
        qualificationWindowStart: QUALIFICATION_START,
        qualificationWindowEnd: '2026-09-30'
      }
    };

    let nextState = typeof core.normalizeState === 'function'
      ? core.normalizeState({ ...locked.state, currentSeason: officialSeason, latestSeasonId: SEASON_ID })
      : { ...locked.state, currentSeason: officialSeason, latestSeasonId: SEASON_ID };

    let materializedCount = 0;
    if (options.materialize !== false && dayKey >= TOURNAMENT_START && dayKey <= TOURNAMENT_END
        && typeof core.materializeSeasonSlateMatchupsForDate === 'function') {
      const materialized = core.materializeSeasonSlateMatchupsForDate(nextState, dayKey, {
        ...options,
        nowISO,
        todayDateKey: dayKey
      });
      if (materialized?.state) nextState = materialized.state;
      materializedCount = Number(materialized?.materializedCount) || 0;
    }

    return {
      ok: true,
      changed: true,
      reason: current ? 'season3_preview_locked' : 'season3_created_and_locked',
      state: nextState,
      season: nextState.currentSeason,
      qualificationSeedCount: qualification.seeds.length,
      tournamentSeedCount: Array.isArray(nextState.currentSeason?.seeds) ? nextState.currentSeason.seeds.length : 0,
      materializedCount
    };
  }

  function persistAutomaticRollover(options = {}) {
    if (typeof core.loadAppState !== 'function' || typeof core.saveStateSnapshot !== 'function') {
      return { ok: false, changed: false, reason: 'storage_api_unavailable' };
    }
    const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
    const state = loaded?.state || loaded || {};
    const result = ensureSeasonThreeTournamentRollover(state, options);
    if (!result.changed) return result;

    const saved = core.saveStateSnapshot(result.state, {
      storageKey: core.STORAGE_KEY || 'taskpoints_v1',
      immediateWrite: true,
      savePath: 'season3-october-auto-rollover'
    });
    return {
      ...result,
      state: saved?.state || result.state,
      persisted: true
    };
  }

  const api = {
    installed: true,
    SEASON_ID,
    QUALIFICATION_START,
    TOURNAMENT_START,
    TOURNAMENT_END,
    ENTRANT_COUNT,
    isSeasonThree,
    scopedQualificationState,
    finalQualificationSeeds,
    ensureSeasonThreeTournamentRollover,
    persistAutomaticRollover
  };
  global.TaskPointsSeasonThreeTournamentRollover = api;
  core.ensureSeasonThreeTournamentRollover = ensureSeasonThreeTournamentRollover;

  if (global.document) {
    try {
      persistAutomaticRollover();
    } catch (error) {
      console.error('Season 3 automatic October rollover failed', error);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
