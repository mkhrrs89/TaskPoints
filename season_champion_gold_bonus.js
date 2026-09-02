;(function installTaskPointsSeasonChampionGoldBonus(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__seasonChampionGoldBonusInstalled) return;
  core.__seasonChampionGoldBonusInstalled = true;

  const BONUS_GOLD = 25;
  const GOLD_START_DATE = '2026-07-01';
  const MAX_INSTALL_ATTEMPTS = 120;
  const ALL_MATCHUPS_KEY = '__taskPointsAllRankingMatchups';
  let installAttempts = 0;

  function roundGold(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  }

  function numericValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
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

  function rowDateKey(row) {
    const values = [row?.dateKey, row?.date, row?.completedAtISO, row?.finalizedAtISO, row?.dateISO, row?.createdAtISO];
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      const direct = String(value).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    }
    return '';
  }

  function todayDateKey() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function sideScore(matchup, side) {
    const primary = matchup?.[side === 'B' ? 'scoreB' : 'scoreA'];
    const alias = matchup?.[side === 'B' ? 'playerBScore' : 'playerAScore'];
    const primaryNumber = numericValue(primary);
    return primaryNumber === null ? numericValue(alias) : primaryNumber;
  }

  function matchupContext(row) {
    return [
      row?.seasonId,
      row?.seriesId || row?.seasonSeriesId,
      row?.roundId,
      row?.gameNumber || row?.seriesGameNumber,
      row?.matchupType
    ].map((value) => value === null || value === undefined ? '' : String(value)).join('|');
  }

  function matchupIdentity(matchup) {
    const explicit = String(matchup?.id || matchup?.matchupId || '').trim();
    if (explicit) return `id:${explicit}`;
    const playerAId = String(matchup?.playerAId || '').trim();
    const playerBId = String(matchup?.playerBId || '').trim();
    const dateKey = rowDateKey(matchup);
    if (!playerAId || !playerBId || !dateKey) return '';
    const pair = [playerAId, playerBId].sort().join('|');
    return `fallback:${dateKey}|${pair}|${matchupContext(matchup)}`;
  }

  function historyOpponentId(row) {
    const explicit = String(row?.opponentId || '').trim();
    if (explicit) return explicit;
    const playerId = String(row?.playerId || '').trim();
    const winnerId = String(row?.winnerId || '').trim();
    const loserId = String(row?.loserId || '').trim();
    if (playerId && winnerId === playerId && loserId) return loserId;
    if (playerId && loserId === playerId && winnerId) return winnerId;
    return '';
  }

  function historyGroupIdentity(row) {
    const matchupId = String(row?.matchupId || '').trim();
    if (matchupId) return `id:${matchupId}`;
    const playerId = String(row?.playerId || '').trim();
    const opponentId = historyOpponentId(row);
    const dateKey = rowDateKey(row);
    if (!playerId || !opponentId || !dateKey) return '';
    const pair = [playerId, opponentId].sort().join('|');
    return `fallback:${dateKey}|${pair}|${matchupContext(row)}`;
  }

  function historyScore(row) {
    const score = numericValue(row?.score);
    if (score !== null) return score;
    const points = numericValue(row?.points);
    if (points !== null) return points;
    return numericValue(row?.total);
  }

  function collectCompleteRankingMatchups(stateInput = null) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : (loadState() || {});
    if (Array.isArray(state?.[ALL_MATCHUPS_KEY])) return state[ALL_MATCHUPS_KEY];

    const result = [];
    const seen = new Set();

    const addMatchup = (matchup, source) => {
      if (!matchup || typeof matchup !== 'object') return;
      const playerAId = String(matchup.playerAId || '').trim();
      const playerBId = String(matchup.playerBId || '').trim();
      if (!playerAId || !playerBId) return;
      const identity = matchupIdentity(matchup);
      if (!identity || seen.has(identity)) return;

      const scoreA = sideScore(matchup, 'A');
      const scoreB = sideScore(matchup, 'B');
      const normalized = {
        ...matchup,
        playerAId,
        playerBId,
        ...(scoreA === null ? {} : { scoreA, playerAScore: scoreA }),
        ...(scoreB === null ? {} : { scoreB, playerBScore: scoreB }),
        __taskPointsHistorySource: source
      };
      seen.add(identity);
      result.push(normalized);
    };

    (Array.isArray(state?.matchups) ? state.matchups : []).forEach((matchup) => addMatchup(matchup, 'matchups'));

    const seasons = [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])]
      .filter(Boolean);
    seasons.forEach((season) => {
      (Array.isArray(season?.tournamentMatchupResults) ? season.tournamentMatchupResults : [])
        .forEach((matchup) => addMatchup(matchup, 'seasonHistory'));
    });

    const groups = new Map();
    (Array.isArray(state?.gameHistory) ? state.gameHistory : []).forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const groupKey = historyGroupIdentity(row);
      if (!groupKey || seen.has(groupKey)) return;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(row);
    });

    groups.forEach((rows, groupKey) => {
      if (seen.has(groupKey) || !rows.length) return;
      const first = rows[0];
      const winnerId = String(rows.find((row) => row?.winnerId)?.winnerId || '').trim();
      const loserId = String(rows.find((row) => row?.loserId)?.loserId || '').trim();
      let playerAId = winnerId;
      let playerBId = loserId;

      if (!playerAId || !playerBId || playerAId === playerBId) {
        playerAId = String(first?.playerId || '').trim();
        playerBId = historyOpponentId(first);
      }
      if (!playerAId || !playerBId || playerAId === playerBId) return;

      const scoreForPlayer = (playerId) => {
        const values = rows
          .filter((row) => String(row?.playerId || '').trim() === playerId)
          .map(historyScore)
          .filter((value) => value !== null);
        if (!values.length) return null;
        const unique = [];
        values.forEach((value) => {
          if (!unique.some((existing) => Math.abs(existing - value) < 0.0001)) unique.push(value);
        });
        return unique.length === 1 ? unique[0] : null;
      };

      const scoreA = scoreForPlayer(playerAId);
      const scoreB = scoreForPlayer(playerBId);
      if (scoreA === null || scoreB === null) return;

      const matchupId = String(first?.matchupId || '').trim();
      const dateKey = rowDateKey(first);
      const reconstructed = {
        ...(matchupId ? { id: matchupId, matchupId } : {}),
        dateKey,
        date: dateKey,
        playerAId,
        playerBId,
        scoreA,
        scoreB,
        playerAScore: scoreA,
        playerBScore: scoreB,
        winnerId: winnerId || (scoreA > scoreB ? playerAId : scoreB > scoreA ? playerBId : ''),
        loserId: loserId || (scoreA > scoreB ? playerBId : scoreB > scoreA ? playerAId : ''),
        seasonId: first?.seasonId || '',
        seriesId: first?.seriesId || first?.seasonSeriesId || '',
        seasonSeriesId: first?.seasonSeriesId || first?.seriesId || '',
        roundId: first?.roundId || '',
        gameNumber: first?.gameNumber || first?.seriesGameNumber || null,
        matchupType: first?.matchupType || '',
        completedAtISO: first?.completedAtISO || first?.createdAtISO || '',
        __taskPointsHistorySource: 'gameHistory'
      };
      addMatchup(reconstructed, 'gameHistory');
    });

    return result;
  }

  function getCumulativeMatchupGold(playerId, stateInput = null, options = {}) {
    const id = String(playerId || '').trim();
    if (!id) return 0;
    const today = String(options.todayKey || todayDateKey()).slice(0, 10);
    let gold = 0;

    collectCompleteRankingMatchups(stateInput).forEach((matchup) => {
      const dateKey = rowDateKey(matchup);
      if (!dateKey || dateKey < GOLD_START_DATE || (today && dateKey >= today)) return;
      const isA = String(matchup?.playerAId || '') === id;
      const isB = String(matchup?.playerBId || '') === id;
      if (!isA && !isB) return;
      const scoreA = sideScore(matchup, 'A');
      const scoreB = sideScore(matchup, 'B');
      if (scoreA === null || scoreB === null) return;
      const margin = isA ? scoreA - scoreB : scoreB - scoreA;
      if (margin > 0) gold += margin / 10;
    });

    return roundGold(gold);
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

  function getTournamentChampionGoldBonus(playerId, stateInput = null) {
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
      if (championIdForSeason(season) === id) bonus += BONUS_GOLD;
    });

    return bonus;
  }

  function patchRankingsHistory() {
    const original = global.getScopedRankingsState;
    if (typeof original !== 'function') return false;
    if (original.__taskPointsHistoricalMatchupsIncluded) return true;

    const wrapped = function getScopedRankingsStateWithHistory(state) {
      const source = state && typeof state === 'object' ? state : {};
      const completeMatchups = Array.isArray(source?.[ALL_MATCHUPS_KEY])
        ? source[ALL_MATCHUPS_KEY]
        : collectCompleteRankingMatchups(source);
      const expanded = { ...source, matchups: completeMatchups, [ALL_MATCHUPS_KEY]: completeMatchups };
      const scoped = original.call(this, expanded) || expanded;
      if (!scoped || typeof scoped !== 'object') return expanded;
      return { ...scoped, [ALL_MATCHUPS_KEY]: completeMatchups };
    };
    wrapped.__taskPointsHistoricalMatchupsIncluded = true;
    wrapped.__taskPointsOriginal = original;
    global.getScopedRankingsState = wrapped;
    return true;
  }

  function patchHomepageGold() {
    const original = global.getHomepageGoldValue;
    if (typeof original !== 'function') return false;
    if (original.__taskPointsChampionBonusIncluded) return true;

    const wrapped = function getHomepageGoldValueWithChampionBonus(playerId) {
      const base = original.apply(this, arguments);
      if (base == null) return base;
      const state = loadState();
      const cumulative = state ? getCumulativeMatchupGold(playerId, state) : 0;
      const marginGold = Math.max(Number(base) || 0, cumulative);
      return roundGold(marginGold + getTournamentChampionGoldBonus(playerId, state));
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
      const cumulative = getCumulativeMatchupGold(playerId, state);
      const marginGold = Math.max(Number(result.gold) || 0, cumulative);
      return {
        ...result,
        gold: roundGold(marginGold + getTournamentChampionGoldBonus(playerId, state))
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
    const rankingsHistoryReady = !isRankings || patchRankingsHistory();
    const rankingsReady = !isRankings || (rankingsHistoryReady && patchRankingsGold());

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
    ALL_MATCHUPS_KEY,
    collectCompleteRankingMatchups,
    getCumulativeMatchupGold,
    getTournamentChampionGoldBonus,
    installGoldDisplayPatches,
    patchRankingsHistory,
    patchHomepageGold,
    patchRankingsGold
  };

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', installWhenReady, { once: true });
  } else {
    installWhenReady();
  }
})(typeof window !== 'undefined' ? window : globalThis);
