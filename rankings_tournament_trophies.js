;(function installTaskPointsRankingsTournamentTrophies(global) {
  'use strict';

  if (!global || global.TaskPointsRankingsTournamentTrophies?.installed) return;

  const core = global.TaskPointsCore || {};
  const MAX_INSTALL_ATTEMPTS = 120;
  const TROPHY = '🏆';
  let installAttempts = 0;
  let championCounts = new Map();
  let observer = null;
  let decorating = false;

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

  function winnerFromFinalsRows(season) {
    const rows = (Array.isArray(season?.tournamentMatchupResults) ? season.tournamentMatchupResults : [])
      .filter((row) => String(row?.roundId || '').toLowerCase() === 'finals');
    if (!rows.length) return '';

    const wins = new Map();
    rows.forEach((row) => {
      let winnerId = String(row?.winnerId || '').trim();
      if (!winnerId) {
        const scoreA = Number(row?.scoreA ?? row?.playerAScore);
        const scoreB = Number(row?.scoreB ?? row?.playerBScore);
        if (Number.isFinite(scoreA) && Number.isFinite(scoreB) && scoreA !== scoreB) {
          winnerId = scoreA > scoreB ? String(row?.playerAId || '').trim() : String(row?.playerBId || '').trim();
        }
      }
      if (winnerId) wins.set(winnerId, (wins.get(winnerId) || 0) + 1);
    });

    if (!wins.size) return '';
    const sorted = Array.from(wins.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
      const lastWinner = [...rows].reverse().map((row) => String(row?.winnerId || '').trim()).find(Boolean);
      return lastWinner || '';
    }
    return sorted[0][0];
  }

  function championIdForSeason(season) {
    const stored = String(
      season?.championSummary?.championId
      || season?.championId
      || season?.champion?.playerId
      || season?.champion?.id
      || ''
    ).trim();
    if (stored) return stored;

    try {
      const derived = String(core.getSeasonChampionFromFinals?.(season)?.playerId || '').trim();
      if (derived) return derived;
    } catch (_) {}

    return winnerFromFinalsRows(season);
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
    return count ? ` ${TROPHY.repeat(count)}` : '';
  }

  function stripTrophySuffix(name) {
    return String(name || '').replace(/(?:\s*🏆)+\s*$/u, '').trimEnd();
  }

  function decorateName(name, playerId, stateInput = null) {
    return `${stripTrophySuffix(name)}${trophySuffix(getTournamentWinCount(playerId, stateInput))}`;
  }

  function refreshChampionCounts(stateInput = null) {
    championCounts = buildChampionCounts(stateInput || loadState());
    return championCounts;
  }

  function playerNameForId(playerId, state) {
    const id = String(playerId || '').trim();
    if (!id) return '';
    if (id === 'YOU') {
      const youName = String(state?.youName || '').trim();
      return youName || 'You';
    }
    const player = (Array.isArray(state?.players) ? state.players : [])
      .find((candidate) => String(candidate?.id || '').trim() === id);
    return String(player?.name || '').trim();
  }

  function rankedPlayerIds(state) {
    try {
      const scoped = typeof global.getScopedRankingsState === 'function'
        ? global.getScopedRankingsState(state)
        : state;
      const rows = typeof core.computeCanonicalRankings === 'function'
        ? core.computeCanonicalRankings(scoped)
        : [];
      return rows.map((row) => String(row?.playerId || '').trim()).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function decorateRankingsDom(stateInput = null) {
    if (decorating) return false;
    const document = global.document;
    const list = document?.getElementById?.('rankingsList');
    if (!list?.querySelectorAll) return false;

    const state = stateInput && typeof stateInput === 'object' ? stateInput : (loadState() || {});
    refreshChampionCounts(state);
    const ids = rankedPlayerIds(state);
    const rows = Array.from(list.querySelectorAll('.ranking-row'));
    if (!rows.length) return false;

    decorating = true;
    try {
      rows.forEach((row, index) => {
        const nameElement = row?.querySelector?.('.ranking-name');
        if (!nameElement) return;

        const playerId = ids[index] || '';
        const fallbackName = stripTrophySuffix(nameElement.textContent || '');
        const canonicalName = playerNameForId(playerId, state) || fallbackName;
        const count = championCounts.get(playerId) || 0;
        const desired = `${canonicalName}${trophySuffix(count)}`;
        if (nameElement.textContent !== desired) nameElement.textContent = desired;
      });
    } finally {
      decorating = false;
    }
    return true;
  }

  function scheduleDecoration() {
    const run = () => decorateRankingsDom();
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(run);
    else global.setTimeout?.(run, 0);
  }

  function startDomObserver() {
    const document = global.document;
    const list = document?.getElementById?.('rankingsList');
    if (!list) return false;

    scheduleDecoration();
    if (observer || typeof global.MutationObserver !== 'function') return true;

    observer = new global.MutationObserver(() => {
      if (!decorating) scheduleDecoration();
    });
    observer.observe(list, { childList: true, subtree: true });
    return true;
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
          name: `${stripTrophySuffix(source.name)}${trophySuffix(wins)}`
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
        const result = originalRenderRankings.apply(this, arguments);
        Promise.resolve(result).finally(scheduleDecoration);
        return result;
      };
      wrappedRenderRankings.__taskPointsTournamentTrophiesIncluded = true;
      wrappedRenderRankings.__taskPointsOriginal = originalRenderRankings;
      global.renderRankings = wrappedRenderRankings;
    }

    return true;
  }

  function installWhenReady() {
    const patched = patchRankings();
    const observing = startDomObserver();
    if (patched || observing) {
      refreshChampionCounts();
      scheduleDecoration();
      return;
    }
    installAttempts += 1;
    if (installAttempts < MAX_INSTALL_ATTEMPTS) global.setTimeout?.(installWhenReady, 50);
  }

  const api = {
    installed: true,
    seasonIdentity,
    championIdForSeason,
    winnerFromFinalsRows,
    buildChampionCounts,
    getTournamentWinCount,
    trophySuffix,
    stripTrophySuffix,
    decorateName,
    refreshChampionCounts,
    decorateRankingsDom,
    startDomObserver,
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
