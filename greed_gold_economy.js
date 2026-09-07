;(function installTaskPointsGreedGoldEconomy(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__greedGoldEconomyInstalled) return;
  core.__greedGoldEconomyInstalled = true;

  const STORAGE_KEY = core.STORAGE_KEY || 'taskpoints_v1';
  const ECONOMY_VERSION = 1;
  const GREED_SCORE_MAX_BONUS = 5;
  const GREED_THEFT_MAX_RATE = 0.10;
  const YOU_THEFT_GREED = 50;
  const CHAMPION_BONUS = 25;
  const LEGACY_GOLD_START_DATE = '2026-07-01';
  const NPC_SCORE_HARD_MAX = 85;
  const MAX_PATCH_ATTEMPTS = 160;
  let patchAttempts = 0;
  let internalPersistDepth = 0;
  let displayStateCache = null;
  let displayStateCacheRevision = '';

  const roundGold = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
  const roundScore = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
  const roundDetail = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const safeId = (value) => encodeURIComponent(String(value || '').trim()).replace(/%/g, '_');

  function localDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function rowDateKey(row) {
    const candidates = [row?.dateKey, row?.date, row?.completedAtISO, row?.finalizedAtISO, row?.recordedAtISO, row?.createdAtISO];
    for (const candidate of candidates) {
      if (candidate == null || candidate === '') continue;
      const direct = String(candidate).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    }
    return '';
  }

  function sideScore(matchup, side) {
    const primary = matchup?.[side === 'B' ? 'scoreB' : 'scoreA'];
    const alias = matchup?.[side === 'B' ? 'playerBScore' : 'playerAScore'];
    if (finite(primary)) return Number(primary);
    return finite(alias) ? Number(alias) : null;
  }

  function matchupContext(row) {
    return [
      row?.seasonId,
      row?.seriesId || row?.seasonSeriesId,
      row?.roundId,
      row?.gameNumber || row?.seriesGameNumber,
      row?.matchupType || row?.type
    ].map((value) => value == null ? '' : String(value)).join('|');
  }

  function matchupIdentity(matchup) {
    const explicit = String(matchup?.id || matchup?.matchupId || '').trim();
    if (explicit) return `id:${explicit}`;
    const a = String(matchup?.playerAId || '').trim();
    const b = String(matchup?.playerBId || '').trim();
    const date = rowDateKey(matchup);
    if (!a || !b || !date) return '';
    return `fallback:${date}|${[a, b].sort().join('|')}|${matchupContext(matchup)}`;
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
    const date = rowDateKey(row);
    if (!playerId || !opponentId || !date) return '';
    return `fallback:${date}|${[playerId, opponentId].sort().join('|')}|${matchupContext(row)}`;
  }

  function historyScore(row) {
    for (const value of [row?.score, row?.points, row?.total]) if (finite(value)) return Number(value);
    return null;
  }

  function collectCompleteMatchups(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : {};
    if (typeof global.TaskPointsSeasonChampionGoldBonus?.collectCompleteRankingMatchups === 'function') {
      try { return global.TaskPointsSeasonChampionGoldBonus.collectCompleteRankingMatchups(state); } catch (_) {}
    }

    const rows = [];
    const seen = new Set();
    const add = (matchup, source) => {
      if (!matchup || typeof matchup !== 'object') return;
      const playerAId = String(matchup.playerAId || '').trim();
      const playerBId = String(matchup.playerBId || '').trim();
      const scoreA = sideScore(matchup, 'A');
      const scoreB = sideScore(matchup, 'B');
      if (!playerAId || !playerBId || scoreA === null || scoreB === null) return;
      const normalized = { ...matchup, playerAId, playerBId, scoreA, scoreB, playerAScore: scoreA, playerBScore: scoreB, __goldSource: source };
      const key = matchupIdentity(normalized);
      if (!key || seen.has(key)) return;
      seen.add(key);
      rows.push(normalized);
    };

    (Array.isArray(state.matchups) ? state.matchups : []).forEach((row) => add(row, 'matchups'));
    [state.currentSeason, ...(Array.isArray(state.seasonHistory) ? state.seasonHistory : [])].filter(Boolean).forEach((season) => {
      (Array.isArray(season.tournamentMatchupResults) ? season.tournamentMatchupResults : []).forEach((row) => add(row, 'seasonHistory'));
    });

    const groups = new Map();
    (Array.isArray(state.gameHistory) ? state.gameHistory : []).forEach((row) => {
      const groupKey = historyGroupIdentity(row);
      if (!groupKey || seen.has(groupKey)) return;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(row);
    });

    groups.forEach((groupRows) => {
      if (!groupRows.length) return;
      const first = groupRows[0];
      const winnerId = String(groupRows.find((row) => row?.winnerId)?.winnerId || '').trim();
      const loserId = String(groupRows.find((row) => row?.loserId)?.loserId || '').trim();
      let playerAId = winnerId;
      let playerBId = loserId;
      if (!playerAId || !playerBId || playerAId === playerBId) {
        playerAId = String(first?.playerId || '').trim();
        playerBId = historyOpponentId(first);
      }
      if (!playerAId || !playerBId || playerAId === playerBId) return;
      const scoreFor = (playerId) => {
        const values = groupRows
          .filter((row) => String(row?.playerId || '') === playerId)
          .map(historyScore)
          .filter((value) => value !== null);
        const unique = [];
        values.forEach((value) => {
          if (!unique.some((existing) => Math.abs(existing - value) < 0.0001)) unique.push(value);
        });
        return unique.length === 1 ? unique[0] : null;
      };
      const scoreA = scoreFor(playerAId);
      const scoreB = scoreFor(playerBId);
      if (scoreA === null || scoreB === null) return;
      const id = String(first?.matchupId || '').trim();
      add({
        ...(id ? { id, matchupId: id } : {}),
        dateKey: rowDateKey(first),
        playerAId,
        playerBId,
        scoreA,
        scoreB,
        winnerId: winnerId || (scoreA > scoreB ? playerAId : scoreB > scoreA ? playerBId : ''),
        loserId: loserId || (scoreA > scoreB ? playerBId : scoreB > scoreA ? playerAId : ''),
        seasonId: first?.seasonId || '',
        seriesId: first?.seriesId || first?.seasonSeriesId || '',
        roundId: first?.roundId || '',
        gameNumber: first?.gameNumber || first?.seriesGameNumber || null,
        matchupType: first?.matchupType || '',
        completedAtISO: first?.completedAtISO || first?.createdAtISO || ''
      }, 'gameHistory');
    });
    return rows;
  }

  function seasonIdentity(season, index = 0) {
    return String(season?.id || `${season?.monthKey || season?.month || ''}|${season?.startDateKey || season?.startDate || ''}|${season?.endDateKey || season?.endDate || ''}|${index}`);
  }

  function championIdForSeason(season) {
    const stored = season?.championSummary?.championId || season?.championId || '';
    if (stored) return String(stored);
    try { return String(core.getSeasonChampionFromFinals?.(season)?.playerId || ''); } catch (_) { return ''; }
  }

  function seasonBoundaryDate(season) {
    const explicit = String(season?.endDateKey || season?.endDate || '').slice(0, 10);
    if (explicit) return explicit;
    const month = String(season?.monthKey || season?.month || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(month) ? `${month}-31` : '';
  }

  function legacyGoldForPlayer(state, playerId, todayKey = localDateKey()) {
    const id = String(playerId || '').trim();
    if (!id) return 0;
    let gold = 0;
    collectCompleteMatchups(state).forEach((matchup) => {
      const date = rowDateKey(matchup);
      if (!date || date < LEGACY_GOLD_START_DATE || (todayKey && date >= todayKey)) return;
      const a = String(matchup.playerAId || '') === id;
      const b = String(matchup.playerBId || '') === id;
      if (!a && !b) return;
      const scoreA = sideScore(matchup, 'A');
      const scoreB = sideScore(matchup, 'B');
      const margin = a ? scoreA - scoreB : scoreB - scoreA;
      if (margin > 0) gold += margin / 10;
    });
    [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])].filter(Boolean).forEach((season) => {
      const boundary = seasonBoundaryDate(season);
      if (boundary && boundary >= LEGACY_GOLD_START_DATE && championIdForSeason(season) === id) gold += CHAMPION_BONUS;
    });
    return roundGold(gold);
  }

  function ledgerRows(state) {
    if (!Array.isArray(state.goldLedger)) state.goldLedger = [];
    return state.goldLedger;
  }

  function goldBalance(state, playerId) {
    const id = String(playerId || '').trim();
    if (!id) return 0;
    if (!state?.goldEconomy || Number(state.goldEconomy.version) !== ECONOMY_VERSION) return legacyGoldForPlayer(state || {}, id);
    return roundGold(ledgerRows(state || {}).reduce((sum, row) => String(row?.playerId || '') === id ? sum + (Number(row?.amount) || 0) : sum, 0));
  }

  function participantIds(state) {
    const ids = new Set(['YOU']);
    (Array.isArray(state?.players) ? state.players : []).forEach((player) => {
      const id = String(player?.id || player?.playerId || '').trim();
      if (id) ids.add(id);
    });
    return [...ids];
  }

  function activeNpcPlayers(state) {
    return (Array.isArray(state?.players) ? state.players : []).filter((player) => {
      const id = String(player?.id || player?.playerId || '').trim();
      return id && id !== 'YOU' && player?.active !== false;
    });
  }

  function richestActiveNpcGold(state) {
    return roundGold(activeNpcPlayers(state).reduce((max, player) => Math.max(max, goldBalance(state, player.id || player.playerId)), 0));
  }

  function opponentGoldRating(state, opponentId) {
    const id = String(opponentId || '').trim();
    if (!id || id === 'YOU') return 0;
    const player = activeNpcPlayers(state).find((item) => String(item?.id || item?.playerId || '') === id);
    if (!player) return 0;
    const richest = richestActiveNpcGold(state);
    if (richest <= 0) return 0;
    return Math.min(100, Math.max(0, (goldBalance(state, id) / richest) * 100));
  }

  function effectiveTheftGreed(state, playerId, matchup = null) {
    const id = String(playerId || '').trim();
    if (id === 'YOU') return YOU_THEFT_GREED;
    const side = String(matchup?.playerAId || '') === id ? 'A' : String(matchup?.playerBId || '') === id ? 'B' : '';
    const captured = side ? Number(matchup?.[`player${side}Effects`]?.greedRating) : NaN;
    if (Number.isFinite(captured)) return clamp(captured, 0, 100);
    const player = (Array.isArray(state?.players) ? state.players : []).find((item) => String(item?.id || item?.playerId || '') === id);
    return clamp(player?.greed, 0, 100);
  }

  function greedPerformance(state, player, opponent) {
    const playerId = String(player?.id || player?.playerId || '').trim();
    const opponentId = String(opponent?.id || opponent?.playerId || '').trim();
    const greedRating = clamp(player?.greed, 0, 100);
    const eligible = Boolean(playerId && opponentId && playerId !== 'YOU' && opponentId !== 'YOU');
    const opponentGold = eligible ? goldBalance(state, opponentId) : 0;
    const richest = eligible ? richestActiveNpcGold(state) : 0;
    const ogRating = eligible ? opponentGoldRating(state, opponentId) : 0;
    const potentialBonus = eligible && richest > 0
      ? GREED_SCORE_MAX_BONUS * (greedRating / 100) * (ogRating / 100)
      : 0;
    return {
      eligible,
      greedRating,
      opponentGold: roundGold(opponentGold),
      opponentGoldRating: roundDetail(ogRating),
      richestActiveNpcGold: roundGold(richest),
      potentialBonus: roundDetail(potentialBonus)
    };
  }

  function openingIgnoredSameDayKeys(state, launchDateKey) {
    return collectCompleteMatchups(state)
      .filter((row) => rowDateKey(row) === launchDateKey)
      .map(matchupIdentity)
      .filter(Boolean);
  }

  function existingChampionKeys(state) {
    return [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])]
      .filter(Boolean)
      .map((season, index) => championIdForSeason(season) ? seasonIdentity(season, index) : '')
      .filter(Boolean);
  }

  function appendLedgerEntry(state, entry) {
    const ledger = ledgerRows(state);
    if (ledger.some((row) => String(row?.id || '') === String(entry.id || ''))) return false;
    const balanceBefore = goldBalance(state, entry.playerId);
    ledger.push({ ...entry, amount: roundGold(entry.amount), balanceAfter: roundGold(balanceBefore + Number(entry.amount || 0)) });
    return true;
  }

  function ensureGoldEconomy(state, options = {}) {
    if (!state || typeof state !== 'object') return { state, changed: false, initialized: false };
    if (state.goldEconomy && Number(state.goldEconomy.version) === ECONOMY_VERSION) {
      if (!Array.isArray(state.goldLedger)) state.goldLedger = [];
      return { state, changed: false, initialized: false };
    }

    const launchedAtISO = String(options.nowISO || new Date().toISOString());
    const launchDateKey = String(options.dateKey || localDateKey(launchedAtISO)).slice(0, 10);
    const openingBalances = new Map(participantIds(state).map((playerId) => [playerId, legacyGoldForPlayer(state, playerId, launchDateKey)]));
    state.goldLedger = [];
    state.goldEconomy = {
      version: ECONOMY_VERSION,
      launchedAtISO,
      launchDateKey,
      ignoredSameDayMatchupKeys: openingIgnoredSameDayKeys(state, launchDateKey),
      settledMatchupKeys: [],
      ignoredChampionKeys: existingChampionKeys(state),
      settledChampionKeys: []
    };

    openingBalances.forEach((opening, playerId) => {
      if (opening <= 0) return;
      appendLedgerEntry(state, {
        id: `gold:opening:${safeId(playerId)}`,
        type: 'opening_balance',
        playerId,
        opponentId: '',
        matchupId: '',
        seasonId: '',
        dateKey: launchDateKey,
        createdAtISO: launchedAtISO,
        amount: opening,
        meta: { source: 'legacy_gold_at_launch' }
      });
    });
    return { state, changed: true, initialized: true };
  }

  function transactionTimestamp(matchup) {
    return String(matchup?.completedAtISO || matchup?.finalizedAtISO || matchup?.recordedAtISO || matchup?.createdAtISO || `${rowDateKey(matchup) || localDateKey()}T12:00:00.000Z`);
  }

  function goldWinner(matchup) {
    const scoreA = sideScore(matchup, 'A');
    const scoreB = sideScore(matchup, 'B');
    if (scoreA === null || scoreB === null || scoreA === scoreB) return null;
    return scoreA > scoreB
      ? { winnerId: String(matchup.playerAId || ''), loserId: String(matchup.playerBId || ''), scoreA, scoreB }
      : { winnerId: String(matchup.playerBId || ''), loserId: String(matchup.playerAId || ''), scoreA, scoreB };
  }

  function applyGoldOutcomeToMatchingRows(state, identity, outcome) {
    const visit = (rows) => {
      (Array.isArray(rows) ? rows : []).forEach((row) => {
        if (matchupIdentity(row) === identity) row.goldOutcome = { ...outcome };
      });
    };
    visit(state?.matchups);
    visit(state?.currentSeason?.tournamentMatchupResults);
    (Array.isArray(state?.seasonHistory) ? state.seasonHistory : []).forEach((season) => visit(season?.tournamentMatchupResults));
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => visit(day?.matchups));
  }

  function settleOneMatchup(state, matchup) {
    const economy = state?.goldEconomy;
    if (!economy || Number(economy.version) !== ECONOMY_VERSION) return false;
    const identity = matchupIdentity(matchup);
    if (!identity) return false;
    const settled = new Set(Array.isArray(economy.settledMatchupKeys) ? economy.settledMatchupKeys : []);
    if (settled.has(identity)) return false;
    const date = rowDateKey(matchup);
    if (!date || date < economy.launchDateKey) return false;
    if (date === economy.launchDateKey && (Array.isArray(economy.ignoredSameDayMatchupKeys) ? economy.ignoredSameDayMatchupKeys : []).includes(identity)) return false;

    const scoreA = sideScore(matchup, 'A');
    const scoreB = sideScore(matchup, 'B');
    if (scoreA === null || scoreB === null) return false;
    const result = goldWinner(matchup);
    if (!result) {
      economy.settledMatchupKeys = [...settled, identity];
      applyGoldOutcomeToMatchingRows(state, identity, {
        settled: true,
        tie: true,
        settledAtISO: transactionTimestamp(matchup),
        marginGoldAwarded: 0,
        theftGoldStolen: 0
      });
      return true;
    }

    const winnerPregameGold = goldBalance(state, result.winnerId);
    const loserPregameGold = goldBalance(state, result.loserId);
    const winnerGreed = effectiveTheftGreed(state, result.winnerId, matchup);
    const theftRate = (winnerGreed / 100) * GREED_THEFT_MAX_RATE;
    const theftGold = Math.min(loserPregameGold, roundGold(loserPregameGold * theftRate));
    const marginGold = roundGold(Math.abs(result.scoreA - result.scoreB) / 10);
    const stamp = transactionTimestamp(matchup);
    const matchupId = String(matchup?.id || matchup?.matchupId || identity);
    const seasonId = String(matchup?.seasonId || '');

    if (marginGold > 0) {
      appendLedgerEntry(state, {
        id: `gold:${safeId(identity)}:margin:${safeId(result.winnerId)}`,
        type: 'matchup_margin',
        playerId: result.winnerId,
        opponentId: result.loserId,
        matchupId,
        seasonId,
        dateKey: date,
        createdAtISO: stamp,
        amount: marginGold,
        meta: { scoreA: result.scoreA, scoreB: result.scoreB, pointDifferential: Math.abs(result.scoreA - result.scoreB) }
      });
    }

    const transferId = `gold-transfer:${safeId(identity)}`;
    if (theftGold > 0) {
      appendLedgerEntry(state, {
        id: `${transferId}:loss:${safeId(result.loserId)}`,
        transferId,
        type: 'matchup_theft',
        playerId: result.loserId,
        opponentId: result.winnerId,
        matchupId,
        seasonId,
        dateKey: date,
        createdAtISO: stamp,
        amount: -theftGold,
        meta: { direction: 'lost', winnerGreedRating: winnerGreed, theftRate, pregameGold: loserPregameGold }
      });
      appendLedgerEntry(state, {
        id: `${transferId}:gain:${safeId(result.winnerId)}`,
        transferId,
        type: 'matchup_theft',
        playerId: result.winnerId,
        opponentId: result.loserId,
        matchupId,
        seasonId,
        dateKey: date,
        createdAtISO: stamp,
        amount: theftGold,
        meta: { direction: 'stolen', winnerGreedRating: winnerGreed, theftRate, opponentPregameGold: loserPregameGold }
      });
    }

    const outcome = {
      settled: true,
      winnerId: result.winnerId,
      loserId: result.loserId,
      winnerPregameGold: roundGold(winnerPregameGold),
      loserPregameGold: roundGold(loserPregameGold),
      winnerEffectiveGreed: winnerGreed,
      theftRate,
      marginGoldAwarded: marginGold,
      theftGoldStolen: theftGold,
      settledAtISO: stamp
    };
    economy.settledMatchupKeys = [...settled, identity];
    applyGoldOutcomeToMatchingRows(state, identity, outcome);
    return true;
  }

  function reconcileChampionBonuses(state) {
    const economy = state?.goldEconomy;
    if (!economy) return false;
    const ignored = new Set(Array.isArray(economy.ignoredChampionKeys) ? economy.ignoredChampionKeys : []);
    const settled = new Set(Array.isArray(economy.settledChampionKeys) ? economy.settledChampionKeys : []);
    let changed = false;
    [state?.currentSeason, ...(Array.isArray(state?.seasonHistory) ? state.seasonHistory : [])].filter(Boolean).forEach((season, index) => {
      const championId = championIdForSeason(season);
      if (!championId) return;
      const key = seasonIdentity(season, index);
      if (!key || ignored.has(key) || settled.has(key)) return;
      const date = seasonBoundaryDate(season) || localDateKey();
      appendLedgerEntry(state, {
        id: `gold:champion:${safeId(key)}:${safeId(championId)}`,
        type: 'champion_bonus',
        playerId: championId,
        opponentId: '',
        matchupId: '',
        seasonId: String(season?.id || key),
        dateKey: date,
        createdAtISO: String(season?.championSummary?.crownedAtISO || season?.completedAtISO || `${date}T23:59:59.000Z`),
        amount: CHAMPION_BONUS,
        meta: { championBonus: CHAMPION_BONUS }
      });
      settled.add(key);
      changed = true;
    });
    economy.settledChampionKeys = [...settled];
    return changed;
  }

  function reconcileGoldEconomy(state, options = {}) {
    const initialized = ensureGoldEconomy(state, options);
    if (!state || typeof state !== 'object') return { state, changed: initialized.changed, initialized: initialized.initialized };
    let changed = initialized.changed;
    const rows = collectCompleteMatchups(state).slice().sort((a, b) => {
      const dateCompare = rowDateKey(a).localeCompare(rowDateKey(b));
      if (dateCompare) return dateCompare;
      const timeCompare = transactionTimestamp(a).localeCompare(transactionTimestamp(b));
      return timeCompare || matchupIdentity(a).localeCompare(matchupIdentity(b));
    });
    rows.forEach((row) => { if (settleOneMatchup(state, row)) changed = true; });
    if (reconcileChampionBonuses(state)) changed = true;
    return { state, changed, initialized: initialized.initialized };
  }

  function refreshWinnerFields(matchup) {
    const scoreA = sideScore(matchup, 'A');
    const scoreB = sideScore(matchup, 'B');
    if (scoreA === null || scoreB === null) return;
    if (scoreA > scoreB) {
      matchup.winnerId = String(matchup.playerAId || '');
      matchup.loserId = String(matchup.playerBId || '');
    } else if (scoreB > scoreA) {
      matchup.winnerId = String(matchup.playerBId || '');
      matchup.loserId = String(matchup.playerAId || '');
    } else {
      matchup.winnerId = '';
      matchup.loserId = '';
    }
  }

  function updateGameHistoryForMatchup(state, matchup) {
    const date = rowDateKey(matchup);
    if (!date) return;
    const result = goldWinner(matchup);
    ['A', 'B'].forEach((side) => {
      const playerId = String(matchup?.[`player${side}Id`] || '');
      if (!playerId || playerId === 'YOU') return;
      const score = sideScore(matchup, side);
      if (score === null) return;
      (Array.isArray(state?.gameHistory) ? state.gameHistory : []).forEach((row) => {
        const rowPlayer = String(row?.playerId || '');
        if (rowPlayer !== playerId || rowDateKey(row) !== date) return;
        row.score = score;
        row.effects = { ...(row.effects || {}), ...(matchup?.[`player${side}Effects`] || {}) };
        if (result) {
          row.winnerId = result.winnerId;
          row.loserId = result.loserId;
          row.opponentId = playerId === result.winnerId ? result.loserId : result.winnerId;
        }
      });
    });
  }

  function applyGreedToMatchup(state, matchup) {
    if (!matchup || typeof matchup !== 'object') return false;
    const aId = String(matchup.playerAId || '');
    const bId = String(matchup.playerBId || '');
    const scoreA = sideScore(matchup, 'A');
    const scoreB = sideScore(matchup, 'B');
    if (!aId || !bId || scoreA === null || scoreB === null) return false;

    const playerMap = new Map((Array.isArray(state?.players) ? state.players : []).map((player) => [String(player?.id || player?.playerId || ''), player]));
    const npcVsNpc = aId !== 'YOU' && bId !== 'YOU';
    let changed = false;

    ['A', 'B'].forEach((side) => {
      const playerId = side === 'A' ? aId : bId;
      if (playerId === 'YOU') return;
      const effectsKey = `player${side}Effects`;
      const existingEffects = matchup[effectsKey] && typeof matchup[effectsKey] === 'object' ? matchup[effectsKey] : {};
      if (Number(existingEffects.greedTelemetryVersion) === ECONOMY_VERSION) return;

      const opponentId = side === 'A' ? bId : aId;
      const player = playerMap.get(playerId) || { id: playerId, greed: 0 };
      const opponent = opponentId === 'YOU' ? { id: 'YOU' } : (playerMap.get(opponentId) || { id: opponentId });
      const effect = greedPerformance(state, player, opponent);
      const scoreKey = `score${side}`;
      const aliasKey = side === 'A' ? 'playerAScore' : 'playerBScore';
      const base = side === 'A' ? scoreA : scoreB;
      const finalScore = npcVsNpc ? roundScore(Math.min(NPC_SCORE_HARD_MAX, base + effect.potentialBonus)) : base;
      const applied = roundScore(finalScore - base);
      matchup[scoreKey] = finalScore;
      matchup[aliasKey] = finalScore;
      matchup[effectsKey] = {
        ...existingEffects,
        greedTelemetryVersion: ECONOMY_VERSION,
        greedPerformanceEligible: npcVsNpc,
        greedApplied: applied > 0,
        greedBonus: applied,
        greedPotentialBonus: npcVsNpc ? effect.potentialBonus : 0,
        greedRating: effect.greedRating,
        opponentGold: npcVsNpc ? effect.opponentGold : 0,
        opponentGoldRating: npcVsNpc ? effect.opponentGoldRating : 0,
        richestActiveNpcGold: npcVsNpc ? effect.richestActiveNpcGold : richestActiveNpcGold(state)
      };
      changed = true;
    });

    if (changed) {
      refreshWinnerFields(matchup);
      updateGameHistoryForMatchup(state, matchup);
    }
    return changed;
  }

  function updateMatchingScoresAndEffects(state, sourceMatchup) {
    const identity = matchupIdentity(sourceMatchup);
    if (!identity) return;
    const copy = (row) => {
      if (matchupIdentity(row) !== identity) return;
      ['scoreA','scoreB','playerAScore','playerBScore','playerAEffects','playerBEffects','winnerId','loserId'].forEach((key) => {
        if (sourceMatchup[key] !== undefined) row[key] = sourceMatchup[key] && typeof sourceMatchup[key] === 'object' ? { ...sourceMatchup[key] } : sourceMatchup[key];
      });
    };
    (Array.isArray(state?.matchups) ? state.matchups : []).forEach(copy);
    (Array.isArray(state?.schedule) ? state.schedule : []).forEach((day) => (Array.isArray(day?.matchups) ? day.matchups : []).forEach(copy));
    (Array.isArray(state?.currentSeason?.tournamentMatchupResults) ? state.currentSeason.tournamentMatchupResults : []).forEach(copy);
  }

  function completeIdentitySet(state, dateKey = '') {
    return new Set(collectCompleteMatchups(state).filter((row) => !dateKey || rowDateKey(row) === dateKey).map(matchupIdentity).filter(Boolean));
  }

  function syncSeasonAfterGreed(state, dateKey) {
    try {
      if (typeof core.syncCurrentSeasonSeriesFromRecordedResults === 'function') {
        const sync = core.syncCurrentSeasonSeriesFromRecordedResults(state);
        if (sync?.state) return { state: sync.state, changed: Boolean(sync.changed) };
      }
      if (typeof core.syncSeasonResultsFromDailyMatchups === 'function') {
        const sync = core.syncSeasonResultsFromDailyMatchups(state, dateKey);
        if (sync?.state) return { state: sync.state, changed: Boolean(sync.changed) };
      }
    } catch (error) {
      console.warn('Greed Gold season result resync failed:', error);
    }
    return { state, changed: false };
  }

  function readStoredState() {
    try {
      const loaded = originalLoadAppState?.({ syncDerived: false, persistSync: false });
      const state = loaded?.state || loaded;
      if (state && typeof state === 'object') return state;
    } catch (_) {}
    try {
      const raw = global.localStorage?.getItem?.(STORAGE_KEY);
      if (!raw) return null;
      return core.parseTaskPointsStorageJson?.(raw, null) || JSON.parse(raw);
    } catch (_) { return null; }
  }

  function preserveStoredEconomy(candidate) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    if (candidate.goldEconomy && Number(candidate.goldEconomy.version) === ECONOMY_VERSION && Array.isArray(candidate.goldLedger)) return candidate;
    const stored = readStoredState();
    if (stored?.goldEconomy && Number(stored.goldEconomy.version) === ECONOMY_VERSION) {
      candidate.goldEconomy = stored.goldEconomy;
      candidate.goldLedger = Array.isArray(stored.goldLedger) ? stored.goldLedger : [];
    }
    return candidate;
  }

  function prepareStateForSave(candidate) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    preserveStoredEconomy(candidate);
    reconcileGoldEconomy(candidate, { dateKey: localDateKey(), nowISO: new Date().toISOString() });
    return candidate;
  }

  const originalSimulator = typeof core.simulateAiScoreForPlayerCore === 'function' ? core.simulateAiScoreForPlayerCore.bind(core) : null;
  const originalMaterialize = typeof core.materializeSeasonSlateMatchupsForDate === 'function' ? core.materializeSeasonSlateMatchupsForDate.bind(core) : null;
  const originalSaveStateSnapshot = typeof core.saveStateSnapshot === 'function' ? core.saveStateSnapshot.bind(core) : null;
  const originalMergeAndSaveState = typeof core.mergeAndSaveState === 'function' ? core.mergeAndSaveState.bind(core) : null;
  const originalSaveAppState = typeof core.saveAppState === 'function' ? core.saveAppState.bind(core) : null;
  const originalLoadAppState = typeof core.loadAppState === 'function' ? core.loadAppState.bind(core) : null;

  if (originalSimulator) {
    core.simulateAiScoreForPlayerCore = function greedAwareAiScore(player, dateKey, options = {}) {
      const state = options?.state && typeof options.state === 'object' ? options.state : null;
      if (state) reconcileGoldEconomy(state, { dateKey: localDateKey(), nowISO: new Date().toISOString() });
      const context = options?.context || {};
      const originalCapture = typeof context.captureEffects === 'function' ? context.captureEffects : null;
      let baseEffects = null;
      const wrappedContext = {
        ...context,
        captureEffects(effects) { baseEffects = effects || null; }
      };
      const baseScore = originalSimulator(player, dateKey, { ...options, context: wrappedContext });
      const opponent = context.opponent || null;
      const effect = state
        ? greedPerformance(state, player, opponent)
        : { eligible: false, greedRating: clamp(player?.greed, 0, 100), opponentGold: 0, opponentGoldRating: 0, richestActiveNpcGold: 0, potentialBonus: 0 };
      const finalScore = effect.eligible && finite(baseScore)
        ? roundScore(Math.min(NPC_SCORE_HARD_MAX, Number(baseScore) + effect.potentialBonus))
        : Number(baseScore);
      const applied = finite(baseScore) && finite(finalScore) ? roundScore(finalScore - Number(baseScore)) : 0;
      if (originalCapture) {
        originalCapture({
          ...(baseEffects || {}),
          greedTelemetryVersion: ECONOMY_VERSION,
          greedPerformanceEligible: Boolean(effect.eligible),
          greedApplied: applied > 0,
          greedBonus: applied,
          greedPotentialBonus: effect.eligible ? effect.potentialBonus : 0,
          greedRating: effect.greedRating,
          opponentGold: effect.eligible ? effect.opponentGold : 0,
          opponentGoldRating: effect.eligible ? effect.opponentGoldRating : 0,
          richestActiveNpcGold: effect.richestActiveNpcGold
        });
      }
      return finalScore;
    };
    core.simulateAiScoreForPlayerCore.__taskPointsGreedAware = true;
  }

  if (originalMaterialize) {
    core.materializeSeasonSlateMatchupsForDate = function greedAwareSeasonMaterialization(state, dateKey, options = {}) {
      const working = state && typeof state === 'object' ? state : {};
      const today = localDateKey();
      reconcileGoldEconomy(working, { dateKey: today, nowISO: options.nowISO || new Date().toISOString() });
      const targetDate = String(dateKey || '').slice(0, 10);
      const before = completeIdentitySet(working, targetDate);
      const result = originalMaterialize(working, dateKey, options) || { state: working, changed: false };
      let nextState = result.state || working;
      const candidates = collectCompleteMatchups(nextState)
        .filter((row) => rowDateKey(row) === targetDate && !before.has(matchupIdentity(row)))
        .sort((a, b) => {
          const timeCompare = transactionTimestamp(a).localeCompare(transactionTimestamp(b));
          return timeCompare || matchupIdentity(a).localeCompare(matchupIdentity(b));
        });
      let greedChanged = false;

      candidates.forEach((candidate) => {
        const identity = matchupIdentity(candidate);
        const source = (Array.isArray(nextState.matchups) ? nextState.matchups : []).find((row) => matchupIdentity(row) === identity) || candidate;
        if (applyGreedToMatchup(nextState, source)) {
          updateMatchingScoresAndEffects(nextState, source);
          greedChanged = true;
        }
        if (settleOneMatchup(nextState, source)) greedChanged = true;
      });

      if (greedChanged) {
        const seasonSync = syncSeasonAfterGreed(nextState, targetDate);
        nextState = seasonSync.state || nextState;
        if (seasonSync.changed) greedChanged = true;
      }
      const finalReconcile = reconcileGoldEconomy(nextState, { dateKey: today, nowISO: options.nowISO || new Date().toISOString() });
      if (finalReconcile.changed) greedChanged = true;
      return { ...result, state: nextState, changed: Boolean(result.changed || greedChanged) };
    };
    core.materializeSeasonSlateMatchupsForDate.__taskPointsGreedAware = true;
  }

  if (originalSaveStateSnapshot) {
    core.saveStateSnapshot = function greedAwareSaveStateSnapshot(candidate, options = {}) {
      if (candidate && typeof candidate === 'object' && internalPersistDepth === 0) prepareStateForSave(candidate);
      return originalSaveStateSnapshot(candidate, options);
    };
    core.saveStateSnapshot.__taskPointsGreedAware = true;
  }

  if (originalMergeAndSaveState) {
    core.mergeAndSaveState = function greedAwareMergeAndSaveState(candidate, options = {}) {
      if (candidate && typeof candidate === 'object' && internalPersistDepth === 0) prepareStateForSave(candidate);
      return originalMergeAndSaveState(candidate, options);
    };
    core.mergeAndSaveState.__taskPointsGreedAware = true;
  }

  if (originalSaveAppState) {
    core.saveAppState = function greedAwareSaveAppState(candidate, options = {}) {
      if (candidate && typeof candidate === 'object' && internalPersistDepth === 0) prepareStateForSave(candidate);
      return originalSaveAppState(candidate, options);
    };
    core.saveAppState.__taskPointsGreedAware = true;
  }

  if (originalLoadAppState) {
    core.loadAppState = function greedAwareLoadAppState(options = {}) {
      const loaded = originalLoadAppState(options);
      const state = loaded?.state && typeof loaded.state === 'object' ? loaded.state : loaded;
      if (!state || typeof state !== 'object') return loaded;
      const reconciled = reconcileGoldEconomy(state, { dateKey: localDateKey(), nowISO: new Date().toISOString() });
      if (reconciled.changed && originalSaveStateSnapshot && internalPersistDepth === 0) {
        try {
          internalPersistDepth += 1;
          const saved = originalSaveStateSnapshot(state, { storageKey: STORAGE_KEY, immediateWrite: true, savePath: 'greed-gold-economy-reconcile' });
          const savedState = saved?.state || state;
          if (loaded?.state && typeof loaded === 'object') return { ...loaded, state: savedState };
          return savedState;
        } catch (error) {
          console.warn('Greed Gold reconciliation could not be persisted:', error);
        } finally {
          internalPersistDepth = Math.max(0, internalPersistDepth - 1);
        }
      }
      return loaded?.state && typeof loaded === 'object' ? { ...loaded, state } : state;
    };
    core.loadAppState.__taskPointsGreedAware = true;
  }

  function currentStorageRevision() {
    try { return String(global.localStorage?.getItem?.('taskpoints_state_revision_v1') || ''); }
    catch (_) { return ''; }
  }

  function loadCurrentState() {
    const revision = currentStorageRevision();
    if (revision && displayStateCache && displayStateCacheRevision === revision) return displayStateCache;
    try {
      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });
      const state = loaded?.state || loaded || null;
      if (state && typeof state === 'object') {
        displayStateCache = state;
        displayStateCacheRevision = currentStorageRevision() || revision;
        return state;
      }
    } catch (_) {}
    const stored = readStoredState();
    if (stored && typeof stored === 'object') {
      displayStateCache = stored;
      displayStateCacheRevision = currentStorageRevision() || revision;
    }
    return stored;
  }

  function patchGoldDisplays() {
    let changed = false;
    if (typeof global.getHomepageGoldValue === 'function' && !global.getHomepageGoldValue.__taskPointsLedgerGold) {
      const original = global.getHomepageGoldValue;
      global.getHomepageGoldValue = function ledgerHomepageGold(playerId) {
        const state = loadCurrentState();
        if (state?.goldEconomy?.version === ECONOMY_VERSION) return goldBalance(state, playerId);
        return original.apply(this, arguments);
      };
      global.getHomepageGoldValue.__taskPointsLedgerGold = true;
      global.getHomepageGoldValue.__taskPointsOriginal = original;
      changed = true;
    }
    if (typeof global.computeRankingExtrasForPlayer === 'function' && !global.computeRankingExtrasForPlayer.__taskPointsLedgerGold) {
      const original = global.computeRankingExtrasForPlayer;
      global.computeRankingExtrasForPlayer = function ledgerRankingExtras(player, row, state) {
        const result = original.apply(this, arguments) || {};
        const source = state?.goldEconomy?.version === ECONOMY_VERSION ? state : loadCurrentState();
        const playerId = String(row?.playerId || player?.id || '').trim();
        return source?.goldEconomy?.version === ECONOMY_VERSION ? { ...result, gold: goldBalance(source, playerId) } : result;
      };
      global.computeRankingExtrasForPlayer.__taskPointsLedgerGold = true;
      global.computeRankingExtrasForPlayer.__taskPointsOriginal = original;
      changed = true;
    }
    if (typeof global.computeGoldForPlayerId === 'function' && !global.computeGoldForPlayerId.__taskPointsLedgerGold) {
      const original = global.computeGoldForPlayerId;
      global.computeGoldForPlayerId = function ledgerStandingsGold(playerId) {
        const state = loadCurrentState();
        return state?.goldEconomy?.version === ECONOMY_VERSION ? goldBalance(state, playerId) : original.apply(this, arguments);
      };
      global.computeGoldForPlayerId.__taskPointsLedgerGold = true;
      global.computeGoldForPlayerId.__taskPointsOriginal = original;
      changed = true;
    }
    return changed;
  }

  function playerNameForMatchup(playerId, matchup) {
    try {
      if (typeof global.getName === 'function') return String(global.getName(playerId, matchup) || playerId);
    } catch (_) {}
    const state = loadCurrentState() || {};
    if (String(playerId) === 'YOU') return String(state.youName || 'You');
    const player = (Array.isArray(state.players) ? state.players : []).find((item) => String(item?.id || item?.playerId || '') === String(playerId));
    return String(player?.name || playerId || 'Unknown');
  }

  function greedEffectSummary(matchup, side) {
    const playerId = String(matchup?.[`player${side}Id`] || '');
    if (!playerId || playerId === 'YOU') return '';
    const effects = matchup?.[`player${side}Effects`];
    if (!effects || Number(effects.greedTelemetryVersion) !== ECONOMY_VERSION) return '';
    const name = playerNameForMatchup(playerId, matchup);
    if (effects.greedPerformanceEligible === false) return `${name} Greed boost off vs YOU`;
    const bonus = Number(effects.greedBonus) || 0;
    const greed = clamp(effects.greedRating, 0, 100);
    const og = clamp(effects.opponentGoldRating, 0, 100);
    return `${name} Greed +${bonus.toFixed(1)} (GR ${greed.toFixed(0)}, OG ${og.toFixed(0)})`;
  }

  function goldOutcomeSummary(matchup) {
    const outcome = matchup?.goldOutcome;
    if (!outcome?.settled || outcome.tie) return outcome?.tie ? 'Gold: no award on tie' : '';
    const winner = playerNameForMatchup(outcome.winnerId, matchup);
    const margin = Number(outcome.marginGoldAwarded) || 0;
    const stolen = Number(outcome.theftGoldStolen) || 0;
    const pieces = [`${winner} +${margin.toFixed(1)} margin Gold`];
    if (stolen > 0) pieces.push(`stole ${stolen.toFixed(1)} Gold`);
    return `Gold: ${pieces.join(', ')}`;
  }

  function formatMatchupGreedDetails(matchup) {
    const parts = [greedEffectSummary(matchup, 'A'), greedEffectSummary(matchup, 'B'), goldOutcomeSummary(matchup)].filter(Boolean);
    return parts.join(' · ');
  }

  function patchMatchupDescriptions() {
    let changed = false;
    if (typeof global.describeMatchup === 'function' && !global.describeMatchup.__taskPointsGreedDetails) {
      const original = global.describeMatchup;
      global.describeMatchup = function greedDetailedMatchup(matchup) {
        const base = original.apply(this, arguments);
        const detail = formatMatchupGreedDetails(matchup);
        return detail ? `${base} • ${detail}` : base;
      };
      global.describeMatchup.__taskPointsGreedDetails = true;
      global.describeMatchup.__taskPointsOriginal = original;
      changed = true;
    }
    if (typeof global.describeMatchupForPlayer === 'function' && !global.describeMatchupForPlayer.__taskPointsGreedDetails) {
      const original = global.describeMatchupForPlayer;
      global.describeMatchupForPlayer = function greedDetailedMatchupForPlayer(matchup) {
        const base = original.apply(this, arguments);
        const detail = formatMatchupGreedDetails(matchup);
        return detail ? `${base} • ${detail}` : base;
      };
      global.describeMatchupForPlayer.__taskPointsGreedDetails = true;
      global.describeMatchupForPlayer.__taskPointsOriginal = original;
      changed = true;
    }
    if (changed && typeof global.renderMatchups === 'function') {
      global.setTimeout?.(() => { try { global.renderMatchups(); } catch (_) {} }, 0);
    }
    return changed;
  }

  function installLedgerNavLink() {
    const doc = global.document;
    if (!doc?.querySelectorAll) return false;
    let inserted = false;
    doc.querySelectorAll('.dropdown-menu').forEach((menu) => {
      if (menu.querySelector?.('a[href="gold_ledger.html"]')) return;
      const ratings = menu.querySelector?.('a[href="game_ratings.html"]');
      if (!ratings || !ratings.parentNode) return;
      const link = doc.createElement('a');
      link.href = 'gold_ledger.html';
      link.className = 'btn btn-teal btn-toolbar nav-btn';
      link.textContent = 'Gold Ledger';
      ratings.insertAdjacentElement?.('afterend', link) || ratings.parentNode.appendChild(link);
      inserted = true;
    });
    return inserted;
  }

  function patchWhenReady() {
    patchGoldDisplays();
    patchMatchupDescriptions();
    installLedgerNavLink();
    patchAttempts += 1;
    if (patchAttempts < MAX_PATCH_ATTEMPTS) global.setTimeout?.(patchWhenReady, 50);
  }

  const api = {
    version: ECONOMY_VERSION,
    GREED_SCORE_MAX_BONUS,
    GREED_THEFT_MAX_RATE,
    YOU_THEFT_GREED,
    CHAMPION_BONUS,
    roundGold,
    rowDateKey,
    matchupIdentity,
    collectCompleteMatchups,
    legacyGoldForPlayer,
    ensureGoldEconomy,
    reconcileGoldEconomy,
    reconcileChampionBonuses,
    settleOneMatchup,
    goldBalance,
    activeNpcPlayers,
    richestActiveNpcGold,
    opponentGoldRating,
    effectiveTheftGreed,
    greedPerformance,
    applyGreedToMatchup,
    formatMatchupGreedDetails,
    patchGoldDisplays,
    patchMatchupDescriptions,
    installLedgerNavLink
  };
  core.getGoldBalance = (state, playerId) => goldBalance(state || {}, playerId);
  core.getRichestActiveNpcGold = (state) => richestActiveNpcGold(state || {});
  core.getOpponentGoldRating = (state, playerId) => opponentGoldRating(state || {}, playerId);
  core.getGreedPerformance = (state, player, opponent) => greedPerformance(state || {}, player || {}, opponent || {});
  core.reconcileGoldEconomy = (state, options) => reconcileGoldEconomy(state || {}, options || {});
  global.TaskPointsGreedGoldEconomy = api;

  if (global.document?.readyState === 'loading') global.document.addEventListener?.('DOMContentLoaded', patchWhenReady, { once: true });
  else patchWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);