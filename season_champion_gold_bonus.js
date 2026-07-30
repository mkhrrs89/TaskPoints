;(function installTaskPointsSeasonChampionGoldBonus(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__seasonChampionGoldBonusInstalled) return;
  core.__seasonChampionGoldBonusInstalled = true;

  const BONUS_GOLD = 25;
  const GOLD_START_DATE = '2026-07-01';
  const MAX_INSTALL_ATTEMPTS = 120;
  let installAttempts = 0;

  function roundGold(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  }

  function loadState() {
    try {
      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });
      if (loaded?.state) return loaded.state;
      if (loaded && typeof loaded === 'object') return loaded;
    } catch (_) {}

    try {
      const raw = global.localStorage?.getItem?.(core.STORAGE_KEY || 'taskpoints_v1');
      if (!raw) return null;
      return core.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function stateWithSeasonData(candidate) {
    if (candidate && typeof candidate === 'object' && (candidate.currentSeason || Array.isArray(candidate.seasonHistory))) {
      return candidate;
    }
    return loadState() || candidate || {};
  }

  function seasonBoundaryDate(season) {
    const explicit = String(season?.endDateKey || season?.endDate || '').slice(0, 10);
    if (explicit) return explicit;
    const monthKey = String(season?.monthKey || season?.month || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(monthKey) ? `${monthKey}-31` : '';
  }

  function seasonIdentity(season, index) {
    return String(
      season?.id
      || `${season?.monthKey || season?.month || ''}|${season?.startDateKey || season?.startDate || ''}|${season?.endDateKey || season?.endDate || ''}|${season?.name || season?.label || ''}`
      || `season-${index}`
    );
  }

  function championIdForSeason(season) {
    const stored = season?.championSummary?.championId || season?.championId || '';
    if (stored) return String(stored);
    try {
      return String(core.getSeasonChampionFromFinals?.(season)?.playerId || '');
    } catch (_) {
      return '';
    }
  }

  function getTournamentChampionGoldBonus(playerId, stateInput = null, options = {}) {
    const id = String(playerId || '').trim();
    if (!id) return 0;

    const state = stateWithSeasonData(stateInput);
    const seasons = [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])]
      .filter(Boolean);
    const seen = new Set();
    let bonus = 0;

    seasons.forEach((season, index) => {
      const key = seasonIdentity(season, index);
      if (seen.has(key)) return;
      seen.add(key);

      const boundary = seasonBoundaryDate(season);
      if (!boundary || boundary < GOLD_START_DATE) return;
      if (typeof options.allowsDate === 'function' && options.allowsDate(boundary) !== true) return;
      if (championIdForSeason(season) === id) bonus += BONUS_GOLD;
    });

    return bonus;
  }

  function patchHomepageGold() {
    const original = global.getHomepageGoldValue;
    if (typeof original !== 'function') return false;
    if (original.__taskPointsChampionBonusIncluded) return true;

    const wrapped = function getHomepageGoldValueWithChampionBonus(playerId) {
      const base = original.apply(this, arguments);
      if (base == null) return base;
      return roundGold((Number(base) || 0) + getTournamentChampionGoldBonus(playerId));
    };
    wrapped.__taskPointsChampionBonusIncluded = true;
    wrapped.__taskPointsOriginal = original;
    global.getHomepageGoldValue = wrapped;

    global.formatHomepageGold = function formatHomepageGoldWithChampionBonus(playerId) {
      const gold = global.getHomepageGoldValue(playerId);
      return gold === null ? 'Gold: —' : `Gold: ${Number(gold).toFixed(1)}`;
    };
    global.formatHomepageGold.__taskPointsChampionBonusIncluded = true;
    return true;
  }

  function patchRankingsGold() {
    const original = global.computeRankingExtrasForPlayer;
    if (typeof original !== 'function') return false;
    if (original.__taskPointsChampionBonusIncluded) return true;

    const wrapped = function computeRankingExtrasWithChampionBonus(player, row, state) {
      const result = original.apply(this, arguments) || {};
      const playerId = String(row?.playerId || player?.id || '').trim();
      return {
        ...result,
        gold: roundGold((Number(result.gold) || 0) + getTournamentChampionGoldBonus(playerId, state, {
          allowsDate: typeof global.rankingsScopeAllowsDate === 'function'
            ? (dateKey) => global.rankingsScopeAllowsDate(dateKey)
            : null
        }))
      };
    };
    wrapped.__taskPointsChampionBonusIncluded = true;
    wrapped.__taskPointsOriginal = original;
    global.computeRankingExtrasForPlayer = wrapped;
    return true;
  }

  function refreshHomeGold() {
    if (typeof global.getHomepageGoldValue !== 'function') return;
    const state = loadState();
    const youElement = global.document?.getElementById?.('matchupYourGold');
    if (youElement) youElement.textContent = global.formatHomepageGold?.('YOU') || `Gold: ${global.getHomepageGoldValue('YOU').toFixed(1)}`;

    const today = typeof global.getGameDayKey === 'function'
      ? global.getGameDayKey(new Date())
      : new Date().toISOString().slice(0, 10);
    const matchup = state && typeof core.chooseUserMatchupForDate === 'function'
      ? core.chooseUserMatchupForDate(state, today, 'YOU')
      : null;
    const opponentId = matchup
      ? (matchup.playerAId === 'YOU' ? matchup.playerBId : matchup.playerAId)
      : '';
    const opponentElement = global.document?.getElementById?.('matchupOpponentGold');
    if (opponentElement && opponentId) opponentElement.textContent = global.formatHomepageGold?.(opponentId) || `Gold: ${global.getHomepageGoldValue(opponentId).toFixed(1)}`;
  }

  function installGoldDisplayPatches() {
    const pathname = String(global.location?.pathname || '');
    const isRankings = pathname.endsWith('/rankings.html') || pathname === 'rankings.html';
    const isHome = pathname === '' || pathname === '/' || pathname.endsWith('/index.html');
    const homepageReady = !isHome || patchHomepageGold();
    const rankingsReady = !isRankings || patchRankingsGold();

    if (!homepageReady || !rankingsReady) return false;
    if (isHome) refreshHomeGold();
    if (isRankings && typeof global.renderRankings === 'function') {
      try { global.renderRankings(); } catch (_) {}
    }
    return true;
  }

  function installWhenReady() {
    if (installGoldDisplayPatches()) return;
    installAttempts += 1;
    if (installAttempts < MAX_INSTALL_ATTEMPTS) global.setTimeout?.(installWhenReady, 50);
  }

  core.SEASON_CHAMPION_GOLD_BONUS = BONUS_GOLD;
  core.SEASON_CHAMPION_GOLD_START_DATE = GOLD_START_DATE;
  core.getTournamentChampionGoldBonus = getTournamentChampionGoldBonus;
  global.TaskPointsSeasonChampionGoldBonus = {
    BONUS_GOLD,
    GOLD_START_DATE,
    getTournamentChampionGoldBonus,
    installGoldDisplayPatches,
    patchHomepageGold,
    patchRankingsGold
  };

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
