;(function installTaskPointsRankingsTournamentTrophies(global) {
  'use strict';

  if (!global || global.TaskPointsRankingsTournamentTrophies?.installed) return;

  const core = global.TaskPointsCore || {};
  const MAX_INSTALL_ATTEMPTS = 120;
  const TROPHY = '🏆';
  let installAttempts = 0;
  let championCounts = new Map();
  let championNameCounts = new Map();
  let rankingsObserver = null;
  let navObserver = null;
  let decorating = false;
  let navRefreshQueued = false;

  function normalizeName(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

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

  function playerNameForId(playerId, state) {
    const id = String(playerId || '').trim();
    if (!id) return '';
    if (id === 'YOU') return String(state?.youName || '').trim() || 'You';

    const historical = (Array.isArray(state?.seasonHistory) ? state.seasonHistory : []).flatMap((season) => [
      ...(Array.isArray(season?.playerPool) ? season.playerPool : []),
      ...(Array.isArray(season?.seeds) ? season.seeds : []),
      ...(Array.isArray(season?.originalSeeds) ? season.originalSeeds : []),
      ...(Array.isArray(season?.finalPlacements) ? season.finalPlacements : []),
      ...(Array.isArray(season?.tournamentStats) ? season.tournamentStats : [])
    ]);
    const candidates = [
      ...(Array.isArray(state?.players) ? state.players : []),
      ...(Array.isArray(state?.currentSeason?.playerPool) ? state.currentSeason.playerPool : []),
      ...(Array.isArray(state?.currentSeason?.seeds) ? state.currentSeason.seeds : []),
      ...historical
    ];
    const player = candidates.find((candidate) => String(candidate?.id || candidate?.playerId || '').trim() === id);
    return String(player?.name || player?.playerName || '').trim();
  }

  function playerIdForName(name, state, season = null) {
    const target = normalizeName(name);
    if (!target) return '';

    if (normalizeName(state?.youName || 'You') === target) return 'YOU';

    const candidates = [
      ...(Array.isArray(state?.players) ? state.players : []),
      ...(Array.isArray(season?.playerPool) ? season.playerPool : []),
      ...(Array.isArray(season?.seeds) ? season.seeds : []),
      ...(Array.isArray(season?.originalSeeds) ? season.originalSeeds : []),
      ...(Array.isArray(season?.finalPlacements) ? season.finalPlacements : []),
      ...(Array.isArray(season?.tournamentStats) ? season.tournamentStats : [])
    ];

    const match = candidates.find((candidate) => {
      const candidateName = candidate?.name || candidate?.playerName;
      return normalizeName(candidateName) === target;
    });
    return String(match?.id || match?.playerId || '').trim();
  }

  function winnerFromPlacementRows(season) {
    const rows = [
      ...(Array.isArray(season?.finalPlacements) ? season.finalPlacements : []),
      ...(Array.isArray(season?.tournamentStats) ? season.tournamentStats : [])
    ];
    const champion = rows.find((row) => {
      const finish = String(row?.finish || row?.placement || row?.result || '').trim().toLowerCase();
      return finish === 'champion' || finish === 'winner' || Number(row?.finishTier) === 0;
    });
    if (!champion) return { id: '', name: '' };
    return {
      id: String(champion?.playerId || champion?.id || '').trim(),
      name: String(champion?.playerName || champion?.name || '').trim()
    };
  }

  function winnerFromSeriesArchive(season) {
    const directFinals = season?.finalsSeries;
    if (directFinals && typeof directFinals === 'object') {
      const id = String(directFinals?.winnerId || '').trim();
      const name = String(directFinals?.winnerName || '').trim();
      if (id || name) return { id, name };
    }

    const archived = Array.isArray(season?.seriesResults) ? season.seriesResults : [];
    const archivedFinal = archived.find((row) => String(row?.roundId || row?.roundName || '').trim().toLowerCase() === 'finals');
    if (archivedFinal) {
      const id = String(archivedFinal?.winnerId || '').trim();
      const name = String(archivedFinal?.winnerName || '').trim();
      if (id || name) return { id, name };
    }

    const seriesValues = season?.series && typeof season.series === 'object'
      ? Object.values(season.series)
      : [];
    const liveFinal = seriesValues.find((row) => String(row?.roundId || row?.roundName || '').trim().toLowerCase() === 'finals');
    if (liveFinal) {
      const id = String(liveFinal?.winnerId || '').trim();
      const name = String(liveFinal?.winnerName || '').trim();
      if (id || name) return { id, name };
    }

    return { id: '', name: '' };
  }

  function winnerFromFinalsRows(season) {
    const rows = (Array.isArray(season?.tournamentMatchupResults) ? season.tournamentMatchupResults : [])
      .filter((row) => String(row?.roundId || '').toLowerCase() === 'finals');
    if (!rows.length) return { id: '', name: '' };

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

    if (!wins.size) return { id: '', name: '' };
    const sorted = Array.from(wins.entries()).sort((a, b) => b[1] - a[1]);
    let winnerId = sorted[0][0];
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
      winnerId = [...rows].reverse().map((row) => String(row?.winnerId || '').trim()).find(Boolean) || winnerId;
    }
    const row = [...rows].reverse().find((candidate) => String(candidate?.winnerId || '').trim() === winnerId) || rows[rows.length - 1];
    const winnerName = winnerId === String(row?.playerAId || '').trim()
      ? String(row?.playerAName || '').trim()
      : winnerId === String(row?.playerBId || '').trim()
        ? String(row?.playerBName || '').trim()
        : '';
    return { id: winnerId, name: winnerName };
  }

  function championForSeason(season, state = {}) {
    const directId = String(
      season?.championSummary?.championId
      || season?.championId
      || season?.champion?.playerId
      || season?.champion?.id
      || ''
    ).trim();
    const directName = String(
      season?.championSummary?.championName
      || season?.championName
      || season?.champion?.playerName
      || season?.champion?.name
      || ''
    ).trim();
    if (directId) return { id: directId, name: directName || playerNameForId(directId, state) };

    const placement = winnerFromPlacementRows(season);
    if (placement.id || placement.name) {
      return {
        id: placement.id || playerIdForName(placement.name, state, season),
        name: placement.name || playerNameForId(placement.id, state)
      };
    }

    const series = winnerFromSeriesArchive(season);
    if (series.id || series.name) {
      return {
        id: series.id || playerIdForName(series.name, state, season),
        name: series.name || playerNameForId(series.id, state)
      };
    }

    try {
      const derived = core.getSeasonChampionFromFinals?.(season);
      const id = String(derived?.playerId || derived?.id || '').trim();
      const name = String(derived?.playerName || derived?.name || '').trim();
      if (id || name) return { id: id || playerIdForName(name, state, season), name: name || playerNameForId(id, state) };
    } catch (_) {}

    const rowsWinner = winnerFromFinalsRows(season);
    if (rowsWinner.id || rowsWinner.name) {
      return {
        id: rowsWinner.id || playerIdForName(rowsWinner.name, state, season),
        name: rowsWinner.name || playerNameForId(rowsWinner.id, state)
      };
    }

    if (directName) return { id: playerIdForName(directName, state, season), name: directName };
    return { id: '', name: '' };
  }

  function championIdForSeason(season, stateInput = null) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : (loadState() || {});
    return championForSeason(season, state).id;
  }

  function buildChampionData(stateInput = null) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : (loadState() || {});
    const seasons = [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])]
      .filter(Boolean);
    const seen = new Set();
    const byId = new Map();
    const byName = new Map();

    seasons.forEach((season, index) => {
      const identity = seasonIdentity(season, index);
      if (seen.has(identity)) return;
      seen.add(identity);

      const champion = championForSeason(season, state);
      const id = String(champion.id || '').trim();
      const name = String(champion.name || playerNameForId(id, state) || '').trim();
      if (id) byId.set(id, (byId.get(id) || 0) + 1);
      if (name) {
        const key = normalizeName(name);
        byName.set(key, (byName.get(key) || 0) + 1);
      }
    });

    return { byId, byName };
  }

  function buildChampionCounts(stateInput = null) {
    return buildChampionData(stateInput).byId;
  }

  function getTournamentWinCount(playerId, stateInput = null) {
    const id = String(playerId || '').trim();
    if (!id) return 0;
    const state = stateInput && typeof stateInput === 'object' ? stateInput : (loadState() || {});
    const data = buildChampionData(state);
    return data.byId.get(id) || data.byName.get(normalizeName(playerNameForId(id, state))) || 0;
  }

  function trophySuffix(winCount) {
    const count = Math.max(0, Math.floor(Number(winCount) || 0));
    return count ? ` ${TROPHY.repeat(count)}` : '';
  }

  function stripTrophySuffix(name) {
    return String(name || '').replace(/(?:\s*🏆)+\s*$/u, '').trimEnd();
  }

  function decorateName(name, playerId, stateInput = null) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : (loadState() || {});
    const data = buildChampionData(state);
    const cleanName = stripTrophySuffix(name);
    const count = data.byId.get(String(playerId || '').trim()) || data.byName.get(normalizeName(cleanName)) || 0;
    return `${cleanName}${trophySuffix(count)}`;
  }

  function refreshChampionCounts(stateInput = null) {
    const data = buildChampionData(stateInput || loadState());
    championCounts = data.byId;
    championNameCounts = data.byName;
    return championCounts;
  }

  function rankedPlayerIds(state) {
    try {
      const scoped = typeof global.getScopedRankingsState === 'function'
        ? global.getScopedRankingsState(state)
        : state;
      const rows = typeof core.computeCanonicalRankings === 'function'
        ? core.computeCanonicalRankings(scoped)
        : [];
      return rows.map((row) => String(row?.playerId || '').trim());
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

        const cleanName = stripTrophySuffix(nameElement.textContent || '');
        const playerId = ids[index] || playerIdForName(cleanName, state) || '';
        const canonicalName = playerNameForId(playerId, state) || cleanName;
        const count = championCounts.get(playerId)
          || championNameCounts.get(normalizeName(canonicalName))
          || championNameCounts.get(normalizeName(cleanName))
          || 0;
        const desired = `${canonicalName}${trophySuffix(count)}`;
        if (nameElement.textContent !== desired) nameElement.textContent = desired;
      });
    } finally {
      decorating = false;
    }
    return true;
  }

  function isRankingsLink(link) {
    if (!link?.getAttribute) return false;
    const href = String(link.getAttribute('href') || '').trim();
    return /(^|\/)rankings\.html(?:[?#].*)?$/.test(href);
  }

  function renameRankingsLinks(root = global.document) {
    const links = [];
    if (isRankingsLink(root)) links.push(root);
    if (root?.querySelectorAll) {
      Array.from(root.querySelectorAll('a[href]')).forEach((link) => {
        if (isRankingsLink(link)) links.push(link);
      });
    }
    links.forEach((link) => {
      if (String(link.textContent || '').trim() === 'Rankings') link.textContent = 'Power Rankings';
      if (String(link.getAttribute?.('aria-label') || '').trim() === 'Rankings') link.setAttribute?.('aria-label', 'Power Rankings');
    });
    return links.length;
  }

  function queueNavRename() {
    if (navRefreshQueued) return;
    navRefreshQueued = true;
    const run = () => {
      navRefreshQueued = false;
      renameRankingsLinks();
    };
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(run);
    else global.setTimeout?.(run, 0);
  }

  function startNavObserver() {
    const document = global.document;
    renameRankingsLinks();
    if (navObserver || typeof global.MutationObserver !== 'function' || !document?.documentElement) return Boolean(document);
    navObserver = new global.MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => Array.from(mutation.addedNodes || []).some((node) => {
        if (isRankingsLink(node)) return true;
        return Array.from(node?.querySelectorAll?.('a[href]') || []).some(isRankingsLink);
      }));
      if (relevant) queueNavRename();
    });
    navObserver.observe(document.documentElement, { childList: true, subtree: true });
    return true;
  }

  function scheduleDecoration() {
    const run = () => {
      renameRankingsLinks();
      decorateRankingsDom();
    };
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(run);
    else global.setTimeout?.(run, 0);
  }

  function startRankingsObserver() {
    const document = global.document;
    const list = document?.getElementById?.('rankingsList');
    if (!list) return false;

    scheduleDecoration();
    if (rankingsObserver || typeof global.MutationObserver !== 'function') return true;

    rankingsObserver = new global.MutationObserver(() => {
      if (!decorating) scheduleDecoration();
    });
    rankingsObserver.observe(list, { childList: true, subtree: true });
    return true;
  }

  function installRankingsWhenReady() {
    const observing = startRankingsObserver();
    if (observing) {
      refreshChampionCounts();
      scheduleDecoration();
      return;
    }
    installAttempts += 1;
    if (installAttempts < MAX_INSTALL_ATTEMPTS) global.setTimeout?.(installRankingsWhenReady, 50);
  }

  const api = {
    installed: true,
    normalizeName,
    seasonIdentity,
    championForSeason,
    championIdForSeason,
    winnerFromPlacementRows,
    winnerFromSeriesArchive,
    winnerFromFinalsRows,
    buildChampionData,
    buildChampionCounts,
    getTournamentWinCount,
    trophySuffix,
    stripTrophySuffix,
    decorateName,
    refreshChampionCounts,
    decorateRankingsDom,
    renameRankingsLinks,
    startNavObserver,
    startRankingsObserver
  };

  global.TaskPointsRankingsTournamentTrophies = api;
  core.getSeasonTournamentWinCount = getTournamentWinCount;

  const pathname = String(global.location?.pathname || '');
  const isRankingsPage = /(^|\/)rankings(?:\.html)?$/i.test(pathname);

  function start() {
    startNavObserver();
    if (isRankingsPage) installRankingsWhenReady();
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
