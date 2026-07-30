(function (global) {
  'use strict';

  const STANDARD_BEST_OF = [1, 3, 5, 7];
  const SEASON_TWO_PRESET_ID = 'season2_60_august_2026';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function dateFromKey(key) {
    const parts = String(key || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return new Date(NaN);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function dateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(key, amount) {
    const date = dateFromKey(key);
    if (Number.isNaN(date.getTime())) return '';
    date.setDate(date.getDate() + Number(amount || 0));
    return dateKey(date);
  }

  function daysInclusive(start, end) {
    const a = dateFromKey(start);
    const b = dateFromKey(end);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
  }

  function slugify(value, fallback = 'round') {
    const slug = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return slug || fallback;
  }

  function largestPowerOfTwoAtMost(value) {
    const count = Math.max(2, Math.floor(Number(value) || 2));
    let power = 1;
    while ((power * 2) <= count) power *= 2;
    return power;
  }

  function seedOrder(size) {
    const count = Number(size);
    if (!Number.isInteger(count) || count < 2 || (count & (count - 1)) !== 0) return [];
    let order = [1, 2];
    for (let bracketSize = 4; bracketSize <= count; bracketSize *= 2) {
      const next = [];
      order.forEach((seed) => next.push(seed, bracketSize + 1 - seed));
      order = next;
    }
    return order;
  }

  function roundNameForSize(size) {
    if (size === 2) return 'Finals';
    if (size === 4) return 'Semifinals';
    if (size === 8) return 'Quarterfinals';
    if (size === 16) return 'Round of 16';
    return `Round of ${size}`;
  }

  function defaultBestOfForSize(size) {
    if (size === 2) return 7;
    if (size <= 16) return 5;
    return 3;
  }

  function buildRoundSkeletons(mainSize, hasPreliminary) {
    const rounds = [];
    if (hasPreliminary) rounds.push({ id: 'play_in', displayName: 'Play-In', bestOf: 1, tieBreaker: 'higher_seed' });
    let size = mainSize;
    while (size >= 2) {
      const isFinal = size === 2;
      rounds.push({
        id: isFinal ? 'finals' : `round_of_${size}`,
        displayName: roundNameForSize(size),
        bestOf: defaultBestOfForSize(size),
        tieBreaker: 'none'
      });
      size /= 2;
    }
    return rounds;
  }

  function fitRoundDates(rounds, startDate, endDate) {
    const safeRounds = clone(rounds || []);
    const totalDays = daysInclusive(startDate, endDate);
    const required = safeRounds.reduce((sum, round) => sum + Math.max(1, Number(round.bestOf) || 1), 0);
    if (!safeRounds.length || totalDays < 1) return safeRounds;

    const extra = Math.max(0, totalDays - required);
    const gaps = Math.max(0, safeRounds.length - 1);
    const baseGap = gaps ? Math.floor(extra / gaps) : 0;
    let remainder = gaps ? extra % gaps : extra;
    let cursor = startDate;

    safeRounds.forEach((round, index) => {
      const duration = Math.max(1, Number(round.bestOf) || 1);
      round.startDate = cursor;
      round.endDate = addDays(cursor, duration - 1);
      if (index < safeRounds.length - 1) {
        const gap = baseGap + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        cursor = addDays(round.endDate, gap + 1);
      }
    });

    const last = safeRounds[safeRounds.length - 1];
    if (last && last.endDate !== endDate) {
      const shift = daysInclusive(last.endDate, endDate) - 1;
      if (shift !== 0) {
        last.startDate = addDays(last.startDate, shift);
        last.endDate = endDate;
      }
    }
    return safeRounds;
  }

  function createGenericConfig(options = {}) {
    const entrantCount = Math.max(2, Math.floor(Number(options.entrantCount) || 2));
    const startDate = options.startDate || '2026-08-01';
    const endDate = options.endDate || '2026-08-31';
    const mainSize = largestPowerOfTwoAtMost(entrantCount);
    const hasPreliminary = entrantCount > mainSize;
    const preliminarySeries = hasPreliminary ? entrantCount - mainSize : 0;
    const directByes = hasPreliminary ? entrantCount - (preliminarySeries * 2) : entrantCount;
    const rounds = fitRoundDates(buildRoundSkeletons(mainSize, hasPreliminary), startDate, endDate);
    return {
      version: 1,
      presetId: 'custom_single_elimination',
      name: options.name || `${entrantCount}-Player Single Elimination`,
      entrantCount,
      startDate,
      endDate,
      mainBracketSize: mainSize,
      preliminarySeries,
      directByes,
      pairingMethod: 'standard_seeded',
      rounds
    };
  }

  function createSeasonTwoPreset(options = {}) {
    const startDate = options.startDate || '2026-08-01';
    const endDate = options.endDate || '2026-08-31';
    return {
      version: 1,
      presetId: SEASON_TWO_PRESET_ID,
      name: 'Season 2 — 60 to 48 to 32',
      entrantCount: 60,
      startDate,
      endDate,
      mainBracketSize: 32,
      preliminarySeries: 12,
      directByes: 16,
      pairingMethod: 'season2_60_seeded',
      rounds: [
        { id: 'play_in', displayName: 'Play-In', bestOf: 1, startDate: '2026-08-01', endDate: '2026-08-01', tieBreaker: 'higher_seed' },
        { id: 'opening_round', displayName: 'Opening Round', bestOf: 3, startDate: '2026-08-02', endDate: '2026-08-04', tieBreaker: 'none' },
        { id: 'round_of_32', displayName: 'Round of 32', bestOf: 5, startDate: '2026-08-05', endDate: '2026-08-09', tieBreaker: 'none' },
        { id: 'round_of_16', displayName: 'Round of 16', bestOf: 5, startDate: '2026-08-10', endDate: '2026-08-14', tieBreaker: 'none' },
        { id: 'quarterfinals', displayName: 'Quarterfinals', bestOf: 5, startDate: '2026-08-15', endDate: '2026-08-19', tieBreaker: 'none' },
        { id: 'semifinals', displayName: 'Semifinals', bestOf: 5, startDate: '2026-08-20', endDate: '2026-08-24', tieBreaker: 'none' },
        { id: 'finals', displayName: 'Finals', bestOf: 7, startDate: '2026-08-25', endDate: '2026-08-31', tieBreaker: 'none' }
      ]
    };
  }

  function normalizeConfig(config, availableSeeds = []) {
    const incoming = clone(config || {});
    const entrantCount = Math.min(
      Math.max(2, Math.floor(Number(incoming.entrantCount) || 2)),
      Math.max(2, availableSeeds.length || Number(incoming.entrantCount) || 2)
    );
    let normalized = incoming.presetId === SEASON_TWO_PRESET_ID && entrantCount >= 60
      ? { ...createSeasonTwoPreset(incoming), ...incoming, entrantCount: 60 }
      : { ...createGenericConfig({ ...incoming, entrantCount }), ...incoming, entrantCount };
    normalized.rounds = (Array.isArray(incoming.rounds) && incoming.rounds.length ? incoming.rounds : normalized.rounds)
      .map((round, index) => ({
        id: slugify(round.id || round.displayName, index === (normalized.rounds?.length || 1) - 1 ? 'finals' : `round_${index + 1}`),
        displayName: String(round.displayName || round.name || `Round ${index + 1}`),
        bestOf: STANDARD_BEST_OF.includes(Number(round.bestOf)) ? Number(round.bestOf) : 1,
        startDate: String(round.startDate || ''),
        endDate: String(round.endDate || ''),
        tieBreaker: round.tieBreaker === 'higher_seed' ? 'higher_seed' : 'none'
      }));
    if (normalized.rounds.length) normalized.rounds[normalized.rounds.length - 1].id = 'finals';
    return normalized;
  }

  function validateConfig(config, seeds = []) {
    const errors = [];
    const warnings = [];
    const normalized = normalizeConfig(config, seeds);
    if (normalized.entrantCount > seeds.length) errors.push(`The bracket needs ${normalized.entrantCount} seeds, but only ${seeds.length} are available.`);
    if (normalized.entrantCount < 2) errors.push('At least two entrants are required.');
    const ids = new Set();
    let previousEnd = '';
    normalized.rounds.forEach((round, index) => {
      if (ids.has(round.id)) errors.push(`Round ID ${round.id} is duplicated.`);
      ids.add(round.id);
      if (!STANDARD_BEST_OF.includes(Number(round.bestOf))) errors.push(`${round.displayName} must be best of 1, 3, 5, or 7.`);
      const duration = daysInclusive(round.startDate, round.endDate);
      if (duration < Number(round.bestOf)) errors.push(`${round.displayName} has ${duration || 0} scheduled day(s), fewer than its best-of-${round.bestOf} maximum.`);
      if (previousEnd && round.startDate <= previousEnd) errors.push(`${round.displayName} overlaps the prior round.`);
      previousEnd = round.endDate;
      if (index === 0 && round.startDate !== normalized.startDate) warnings.push(`The first round starts ${round.startDate}, not ${normalized.startDate}.`);
    });
    const finals = normalized.rounds[normalized.rounds.length - 1];
    if (!finals || finals.id !== 'finals') errors.push('The final round must be Finals.');
    if (finals && finals.endDate !== normalized.endDate) warnings.push(`The last possible Finals game is ${finals.endDate}, not ${normalized.endDate}.`);
    if (normalized.presetId === SEASON_TWO_PRESET_ID && normalized.entrantCount !== 60) errors.push('The Season 2 preset requires exactly 60 entrants.');
    return { ok: errors.length === 0, config: normalized, errors, warnings };
  }

  function seedEntry(seeds, seedNumber) {
    const row = (Array.isArray(seeds) ? seeds : []).find((seed) => Number(seed?.seed) === Number(seedNumber));
    if (!row) return null;
    const playerId = row.playerId || row.id || '';
    return {
      playerId,
      playerName: row.playerName || row.name || playerId || `Seed ${seedNumber}`,
      seed: Number(seedNumber)
    };
  }

  function seriesId(seasonId, roundId, index) {
    return `${seasonId}_${roundId}_${index}`;
  }

  function createSeries(options) {
    const a = options.playerA || null;
    const b = options.playerB || null;
    const bestOf = Number(options.bestOf) || 1;
    const now = options.nowISO || new Date().toISOString();
    return {
      id: options.id,
      seasonId: options.seasonId,
      roundId: options.roundId,
      roundName: options.roundName,
      roundIndex: options.roundIndex,
      seriesIndex: options.seriesIndex,
      bestOf,
      winsNeeded: Math.floor(bestOf / 2) + 1,
      tieBreaker: options.tieBreaker === 'higher_seed' ? 'higher_seed' : 'none',
      status: options.status || 'pending',
      playerAId: a?.playerId || '',
      playerBId: b?.playerId || '',
      playerASeed: Number.isFinite(Number(a?.seed)) ? Number(a.seed) : null,
      playerBSeed: Number.isFinite(Number(b?.seed)) ? Number(b.seed) : null,
      playerAName: a?.playerName || '',
      playerBName: b?.playerName || '',
      placeholderA: options.placeholderA || '',
      placeholderB: options.placeholderB || '',
      winsA: 0,
      winsB: 0,
      winnerId: '',
      loserId: '',
      gameResults: [],
      nextSeriesId: options.nextSeriesId || '',
      nextSlot: options.nextSlot === 'B' ? 'B' : (options.nextSlot === 'A' ? 'A' : ''),
      createdAtISO: now,
      updatedAtISO: now
    };
  }

  function buildLaterRounds(series, bracketRounds, seasonId, rounds, firstMainRoundIndex, firstMainSize, nowISO) {
    let priorRoundIndex = firstMainRoundIndex;
    let priorSize = firstMainSize;
    for (let roundIndex = firstMainRoundIndex + 1; roundIndex < rounds.length; roundIndex += 1) {
      const round = rounds[roundIndex];
      const seriesCount = priorSize / 4;
      const ids = [];
      for (let index = 1; index <= seriesCount; index += 1) {
        const id = seriesId(seasonId, round.id, index);
        ids.push(id);
        const priorRound = rounds[priorRoundIndex];
        const priorA = seriesId(seasonId, priorRound.id, index * 2 - 1);
        const priorB = seriesId(seasonId, priorRound.id, index * 2);
        const nextRound = rounds[roundIndex + 1];
        const nextSeries = nextRound ? seriesId(seasonId, nextRound.id, Math.ceil(index / 2)) : '';
        series[id] = createSeries({
          id,
          seasonId,
          roundId: round.id,
          roundName: round.displayName,
          roundIndex,
          seriesIndex: index,
          bestOf: round.bestOf,
          tieBreaker: round.tieBreaker,
          placeholderA: `Winner of ${priorA}`,
          placeholderB: `Winner of ${priorB}`,
          nextSeriesId: nextSeries,
          nextSlot: nextRound ? (index % 2 === 1 ? 'A' : 'B') : '',
          nowISO
        });
      }
      bracketRounds.push({ id: round.id, displayName: round.displayName, roundIndex, bestOf: round.bestOf, seriesIds: ids });
      priorRoundIndex = roundIndex;
      priorSize /= 2;
    }
  }

  function buildSeasonTwoTournament(seeds, config, options = {}) {
    const seasonId = options.seasonId || 'season_2_august_2026';
    const nowISO = options.nowISO || new Date().toISOString();
    const rounds = config.rounds;
    const series = {};
    const bracketRounds = [];

    const playIn = rounds[0];
    const playInIds = [];
    for (let index = 0; index < 12; index += 1) {
      const id = seriesId(seasonId, playIn.id, index + 1);
      playInIds.push(id);
      const openingIndex = 12 - index;
      series[id] = createSeries({
        id,
        seasonId,
        roundId: playIn.id,
        roundName: playIn.displayName,
        roundIndex: 0,
        seriesIndex: index + 1,
        bestOf: playIn.bestOf,
        tieBreaker: 'higher_seed',
        playerA: seedEntry(seeds, 37 + index),
        playerB: seedEntry(seeds, 60 - index),
        nextSeriesId: seriesId(seasonId, 'opening_round', openingIndex),
        nextSlot: 'B',
        nowISO
      });
    }
    bracketRounds.push({ id: playIn.id, displayName: playIn.displayName, roundIndex: 0, bestOf: playIn.bestOf, seriesIds: playInIds });

    const opening = rounds[1];
    const openingIds = [];
    for (let index = 1; index <= 16; index += 1) {
      const id = seriesId(seasonId, opening.id, index);
      openingIds.push(id);
      let playerA;
      let playerB;
      let placeholderB = '';
      if (index <= 12) {
        playerA = seedEntry(seeds, 16 + index);
        placeholderB = `Winner of ${seriesId(seasonId, playIn.id, 13 - index)}`;
      } else {
        playerA = seedEntry(seeds, 16 + index);
        playerB = seedEntry(seeds, 49 - index);
      }
      series[id] = createSeries({
        id,
        seasonId,
        roundId: opening.id,
        roundName: opening.displayName,
        roundIndex: 1,
        seriesIndex: index,
        bestOf: opening.bestOf,
        playerA,
        playerB,
        placeholderB,
        nowISO
      });
    }
    bracketRounds.push({ id: opening.id, displayName: opening.displayName, roundIndex: 1, bestOf: opening.bestOf, seriesIds: openingIds });

    const round32 = rounds[2];
    const order = seedOrder(32);
    const round32Ids = [];
    const lowerSlotDestination = new Map();
    for (let index = 0; index < 16; index += 1) {
      const seedA = order[index * 2];
      const seedB = order[index * 2 + 1];
      const id = seriesId(seasonId, round32.id, index + 1);
      round32Ids.push(id);
      const nextRound = rounds[3];
      const makeParticipant = (slotSeed) => slotSeed <= 16 ? seedEntry(seeds, slotSeed) : null;
      const a = makeParticipant(seedA);
      const b = makeParticipant(seedB);
      if (seedA > 16) lowerSlotDestination.set(seedA, { id, slot: 'A' });
      if (seedB > 16) lowerSlotDestination.set(seedB, { id, slot: 'B' });
      series[id] = createSeries({
        id,
        seasonId,
        roundId: round32.id,
        roundName: round32.displayName,
        roundIndex: 2,
        seriesIndex: index + 1,
        bestOf: round32.bestOf,
        playerA: a,
        playerB: b,
        placeholderA: a ? '' : `Winner for Seed Slot ${seedA}`,
        placeholderB: b ? '' : `Winner for Seed Slot ${seedB}`,
        nextSeriesId: seriesId(seasonId, nextRound.id, Math.ceil((index + 1) / 2)),
        nextSlot: (index + 1) % 2 === 1 ? 'A' : 'B',
        nowISO
      });
    }
    openingIds.forEach((id, index) => {
      const slotSeed = index + 17;
      const destination = lowerSlotDestination.get(slotSeed);
      if (destination) series[id] = { ...series[id], nextSeriesId: destination.id, nextSlot: destination.slot };
    });
    bracketRounds.push({ id: round32.id, displayName: round32.displayName, roundIndex: 2, bestOf: round32.bestOf, seriesIds: round32Ids });

    buildLaterRounds(series, bracketRounds, seasonId, rounds, 2, 32, nowISO);

    return {
      bracket: {
        type: 'dynamic_configured_championship',
        seasonId,
        presetId: config.presetId,
        generatedAtISO: nowISO,
        lockedAtISO: options.official ? nowISO : '',
        roundOrder: rounds.map((round) => round.id),
        rounds: bracketRounds
      },
      series
    };
  }

  function buildGenericTournament(seeds, config, options = {}) {
    const seasonId = options.seasonId || 'configured_season';
    const nowISO = options.nowISO || new Date().toISOString();
    const rounds = config.rounds;
    const hasPreliminary = config.entrantCount > config.mainBracketSize;
    const firstMainRoundIndex = hasPreliminary ? 1 : 0;
    const firstMainRound = rounds[firstMainRoundIndex];
    const mainSize = config.mainBracketSize;
    const series = {};
    const bracketRounds = [];
    const slotDestinations = new Map();

    const order = seedOrder(mainSize);
    const mainIds = [];
    for (let index = 0; index < mainSize / 2; index += 1) {
      const slotA = order[index * 2];
      const slotB = order[index * 2 + 1];
      const id = seriesId(seasonId, firstMainRound.id, index + 1);
      mainIds.push(id);
      slotDestinations.set(slotA, { id, slot: 'A' });
      slotDestinations.set(slotB, { id, slot: 'B' });
      const directSeedLimit = hasPreliminary ? config.directByes : config.entrantCount;
      const a = slotA <= directSeedLimit ? seedEntry(seeds, slotA) : null;
      const b = slotB <= directSeedLimit ? seedEntry(seeds, slotB) : null;
      const nextRound = rounds[firstMainRoundIndex + 1];
      series[id] = createSeries({
        id,
        seasonId,
        roundId: firstMainRound.id,
        roundName: firstMainRound.displayName,
        roundIndex: firstMainRoundIndex,
        seriesIndex: index + 1,
        bestOf: firstMainRound.bestOf,
        playerA: a,
        playerB: b,
        placeholderA: a ? '' : `Winner for Seed Slot ${slotA}`,
        placeholderB: b ? '' : `Winner for Seed Slot ${slotB}`,
        nextSeriesId: nextRound ? seriesId(seasonId, nextRound.id, Math.ceil((index + 1) / 2)) : '',
        nextSlot: nextRound ? ((index + 1) % 2 === 1 ? 'A' : 'B') : '',
        nowISO
      });
    }

    if (hasPreliminary) {
      const prelim = rounds[0];
      const prelimIds = [];
      const firstHighSeed = config.directByes + 1;
      for (let index = 0; index < config.preliminarySeries; index += 1) {
        const highSeed = firstHighSeed + index;
        const lowSeed = config.entrantCount - index;
        const destination = slotDestinations.get(highSeed);
        const id = seriesId(seasonId, prelim.id, index + 1);
        prelimIds.push(id);
        series[id] = createSeries({
          id,
          seasonId,
          roundId: prelim.id,
          roundName: prelim.displayName,
          roundIndex: 0,
          seriesIndex: index + 1,
          bestOf: prelim.bestOf,
          tieBreaker: prelim.tieBreaker,
          playerA: seedEntry(seeds, highSeed),
          playerB: seedEntry(seeds, lowSeed),
          nextSeriesId: destination?.id || '',
          nextSlot: destination?.slot || '',
          nowISO
        });
      }
      bracketRounds.push({ id: prelim.id, displayName: prelim.displayName, roundIndex: 0, bestOf: prelim.bestOf, seriesIds: prelimIds });
    }

    bracketRounds.push({ id: firstMainRound.id, displayName: firstMainRound.displayName, roundIndex: firstMainRoundIndex, bestOf: firstMainRound.bestOf, seriesIds: mainIds });
    buildLaterRounds(series, bracketRounds, seasonId, rounds, firstMainRoundIndex, mainSize, nowISO);
    return {
      bracket: {
        type: 'dynamic_configured_championship',
        seasonId,
        presetId: config.presetId,
        generatedAtISO: nowISO,
        lockedAtISO: options.official ? nowISO : '',
        roundOrder: rounds.map((round) => round.id),
        rounds: bracketRounds
      },
      series
    };
  }

  function buildConfiguredTournament(seeds, config, options = {}) {
    const validation = validateConfig(config, seeds);
    if (!validation.ok) return { ok: false, config: validation.config, errors: validation.errors, warnings: validation.warnings, bracket: null, series: {} };
    const selectedSeeds = (Array.isArray(seeds) ? seeds : []).slice(0, validation.config.entrantCount).map((seed, index) => ({ ...seed, seed: index + 1 }));
    const built = validation.config.presetId === SEASON_TWO_PRESET_ID
      ? buildSeasonTwoTournament(selectedSeeds, validation.config, options)
      : buildGenericTournament(selectedSeeds, validation.config, options);
    return { ok: true, config: validation.config, selectedSeeds, errors: [], warnings: validation.warnings, ...built };
  }

  function lockConfiguredSeasonBracket(state, config, options = {}) {
    const core = global.TaskPointsCore || {};
    const normalized = typeof core.normalizeState === 'function' ? core.normalizeState(state || {}) : clone(state || {});
    const season = normalized.currentSeason;
    if (!season || season.status !== 'preview') return { ok: false, error: 'preview_required', state: normalized };
    const nowISO = options.nowISO || new Date().toISOString();
    const built = buildConfiguredTournament(season.seeds || [], config, { seasonId: season.id, nowISO, official: true });
    if (!built.ok) return { ...built, state: normalized, error: 'invalid_config' };
    const nextSeason = {
      ...season,
      status: 'locked',
      seeds: built.selectedSeeds,
      bracketConfig: built.config,
      bracket: built.bracket,
      series: built.series,
      dateWindows: built.config.rounds.map((round) => ({ ...round })),
      warnings: (Array.isArray(season.warnings) ? season.warnings : []).filter((warning) => warning?.code !== 'non_34_player_pool'),
      updatedAtISO: nowISO,
      meta: {
        ...(season.meta || {}),
        previewOnly: false,
        canCreateOfficialBracket: true,
        dynamicBracket: true,
        seedsLocked: true,
        officialBracketCreatedAtISO: nowISO,
        bracketBuilderPresetId: built.config.presetId
      }
    };
    const nextState = { ...normalized, currentSeason: nextSeason, latestSeasonId: nextSeason.id || normalized.latestSeasonId || '' };
    return { ok: true, state: typeof core.normalizeState === 'function' ? core.normalizeState(nextState) : nextState, season: nextSeason, ...built };
  }

  const api = {
    STANDARD_BEST_OF,
    SEASON_TWO_PRESET_ID,
    addDays,
    daysInclusive,
    largestPowerOfTwoAtMost,
    seedOrder,
    fitRoundDates,
    createGenericConfig,
    createSeasonTwoPreset,
    normalizeConfig,
    validateConfig,
    buildConfiguredTournament,
    lockConfiguredSeasonBracket
  };

  global.TaskPointsBracketBuilder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
