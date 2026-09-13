;(function installTaskPointsRankingsTournamentTrophies(global) {
  'use strict';

  if (!global || global.TaskPointsRankingsTournamentTrophies?.installed) return;

  const core = global.TaskPointsCore || {};
  const MAX_INSTALL_ATTEMPTS = 120;
  let installAttempts = 0;
  let championCounts = new Map();

  function loadState() {
    try {
      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });
      if (loaded?.state) return loaded.state;
      if (loaded && typeof loaded === 'object') return loaded;
    } catch (_) {}

    try {
      const storageKey = core.STORAGE_KEY || 'taskpoints_v1';
      const raw = global.localStorage?.getItem?.(storageKey);
      if (!raw) return null;
      return core.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function seasonIdentity(season, index = 0) {
    const explicit = String(season?.id || '').trim();
    if (explicit) return `id:${explicit}`;

    const parts = [
      season?.monthKey || season?.month,
      season?.startDateKey || season?.startDate,
      season?.endDateKey || season?.endDate,
      season?.name || season?.label
    ].map((value) => String(value || '').trim());

    if (parts.some(Boolean)) return `fields:${parts.join('|')}`;
    return `index:${index}`;
  }

  function championIdForSeason(season) {
    const stored = String(season?.championSummary?.championId || season?.championId || '').trim();
    if (stored) return stored;

    try {
      return String(core.getSeasonChampionFromFinals?.(season)?.playerId || '').trim();
    } catch (_) {
      return '';
    }
  }

  function buildChampionCounts(stateInput = null) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : (loadState() || {});
    const seasons = [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])]
      .filter(Boolean);
    const seen = new Set();
    const counts = new Map();

    seasons.forEach((season, index) => {
      const identity = seasonIdentity(season, index);
      if (seen.has(identity)) return;
      seen.add(identity);

      const championId = championIdForSeason(season);
      if (!championId) return;
      counts.set(championId, (counts.get(championId) || 0) + 1);
    });

    return counts;
  }

  function getTournamentWinCount(playerId, stateInput = null) {
    const id = String(playerId || '').trim();
    if (!id) return 0;
    return buildChampionCounts(stateInput).get(id) || 0;
  }

  function trophySuffix(winCount) {
    const count = Math.max(0, Math.floor(Number(winCount) || 0));
    return count ? ` ${'🏆'.repeat(count)}` : '';
  }

  function decorateName(name, playerId, stateInput = null) {
    return `${String(name || '')}${trophySuffix(getTournamentWinCount(playerId, stateInput))}`;
  }

  function refreshChampionCounts() {
    championCounts = buildChampionCounts(loadState());
    return championCounts;
  }

  function patchRankings() {
    const originalRenderRow = global.renderRow;
    const originalRenderRankings = global.renderRankings;
    if (typeof originalRenderRow !== 'function' || typeof originalRenderRankings !== 'function') return false;

    if (!originalRenderRow.__taskPointsTournamentTrophiesIncluded) {
      const wrappedRenderRow = function renderRowWithTournamentTrophies(player) {
        const source = player && typeof player === 'object' ? player : null;
        if (!source) return originalRenderRow.apply(this, arguments);

        const playerId = String(source.playerId || source.id || '').trim();
        const wins = championCounts.get(playerId) || 0;
        if (!wins) return originalRenderRow.apply(this, arguments);

        const args = Array.from(arguments);
        args[0] = {
          ...source,
          name: `${String(source.name || '')}${trophySuffix(wins)}`
        };
        return originalRenderRow.apply(this, args);
      };
      wrappedRenderRow.__taskPointsTournamentTrophiesIncluded = true;
      wrappedRenderRow.__taskPointsOriginal = originalRenderRow;
      global.renderRow = wrappedRenderRow;
    }

    if (!originalRenderRankings.__taskPointsTournamentTrophiesIncluded) {
      const wrappedRenderRankings = function renderRankingsWithTournamentTrophies() {
        refreshChampionCounts();
        return originalRenderRankings.apply(this, arguments);
      };
      wrappedRenderRankings.__taskPointsTournamentTrophiesIncluded = true;
      wrappedRenderRankings.__taskPointsOriginal = originalRenderRankings;
      global.renderRankings = wrappedRenderRankings;
    }

    return true;
  }

  function installWhenReady() {
    if (patchRankings()) {
      refreshChampionCounts();
      try { global.renderRankings?.(); } catch (_) {}
      return;
    }
    installAttempts += 1;
    if (installAttempts < MAX_INSTALL_ATTEMPTS) global.setTimeout?.(installWhenReady, 50);
  }

  const api = {
    installed: true,
    seasonIdentity,
    championIdForSeason,
    buildChampionCounts,
    getTournamentWinCount,
    trophySuffix,
    decorateName,
    refreshChampionCounts,
    patchRankings
  };

  global.TaskPointsRankingsTournamentTrophies = api;
  core.getSeasonTournamentWinCount = getTournamentWinCount;

  const pathname = String(global.location?.pathname || '');
  const isRankings = pathname.endsWith('/rankings.html') || pathname === 'rankings.html';
  if (!isRankings) return;

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
