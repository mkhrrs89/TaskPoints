const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); },
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};

require('../scoring_core.js');
const builder = require('../season_bracket_builder_core.js');
require('../season_bracket_builder_fixes.js');
require('../season_matchup_materialization_guard.js');
const recovery = require('../season2_missed_playin_recovery.js');
const core = global.TaskPointsCore;

function makeSeeds(count = 60) {
  return Array.from({ length: count }, (_, index) => {
    const seed = index + 1;
    const isUser = seed === 21;
    return {
      seed,
      playerId: isUser ? 'YOU' : `P${seed}`,
      playerName: isUser ? 'Miggy' : `Player ${seed}`,
      name: isUser ? 'Miggy' : `Player ${seed}`
    };
  });
}

function previewState(matchupControl = false) {
  const seeds = makeSeeds();
  return {
    youName: 'Miggy',
    players: seeds.map((seed) => ({ id: seed.playerId, name: seed.playerName, active: true })),
    tasks: [],
    habits: [],
    completions: [],
    matchups: [],
    gameHistory: [],
    schedule: [],
    flexActions: [],
    opponentDripSchedules: [],
    currentSeason: {
      id: 'season_2_august_2026',
      name: 'Season 2',
      label: 'August 2026 TaskPoints Championship',
      monthKey: '2026-08',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      startDateKey: '2026-08-01',
      endDateKey: '2026-08-31',
      status: 'preview',
      seedMode: 'manual',
      seeds,
      playerPool: seeds.map((seed) => ({ id: seed.playerId, name: seed.playerName })),
      bracket: {},
      series: {},
      meta: { seasonMatchupControlEnabled: matchupControl }
    }
  };
}

function ordinaryAugustSecondMatchups() {
  const ids = makeSeeds().map((seed) => seed.playerId);
  return Array.from({ length: 30 }, (_, index) => ({
    id: `ordinary-2026-08-02-${index + 1}`,
    date: '2026-08-02',
    dateKey: '2026-08-02',
    playerAId: ids[index * 2],
    playerBId: ids[index * 2 + 1]
  }));
}

function brokenLockedSeasonState() {
  const locked = builder.lockConfiguredSeasonBracket(
    previewState(false),
    builder.createSeasonTwoPreset(),
    { nowISO: '2026-08-01T04:53:56.665Z' }
  );
  assert.equal(locked.ok, true);

  const season = {
    ...locked.season,
    status: 'locked',
    meta: {
      ...(locked.season.meta || {}),
      seasonMatchupControlEnabled: false
    }
  };
  const seedByPlayerId = new Map(makeSeeds().map((seed) => [seed.playerId, seed.seed]));
  const playIns = Object.values(season.series).filter((series) => series.roundId === 'play_in');
  const gameHistory = playIns.flatMap((series) => [series.playerAId, series.playerBId])
    .map((playerId) => ({
      id: `history-${playerId}`,
      date: '2026-08-01',
      dateKey: '2026-08-01',
      playerId,
      score: 100 - Number(seedByPlayerId.get(playerId))
    }));
  const augustSecond = ordinaryAugustSecondMatchups();

  return core.normalizeState({
    ...locked.state,
    currentSeason: season,
    gameHistory,
    matchups: augustSecond,
    schedule: [{
      date: '2026-08-02',
      dateKey: '2026-08-02',
      matchups: augustSecond
    }]
  });
}

function recoverSeasonTwo() {
  return recovery.repairMissedPlayIn(brokenLockedSeasonState(), {
    effectiveDateKey: '2026-08-02',
    nowISO: '2026-08-02T12:20:00.000Z'
  });
}

test('locking a configured bracket enables Season matchup control', () => {
  const result = builder.lockConfiguredSeasonBracket(
    previewState(false),
    builder.createSeasonTwoPreset(),
    { nowISO: '2026-07-31T12:00:00.000Z' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.season.status, 'locked');
  assert.equal(result.season.meta.seasonMatchupControlEnabled, true);
  assert.equal(result.state.currentSeason.meta.seasonMatchupControlEnabled, true);
});

test('missed August 1 Play-Ins are recovered from recorded daily scores and advanced', () => {
  const result = recoverSeasonTwo();

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.recoveredSeriesIds.length, 12);
  assert.equal(result.state.currentSeason.status, 'active');
  assert.equal(result.state.currentSeason.meta.seasonMatchupControlEnabled, true);

  const playIns = Object.values(result.state.currentSeason.series)
    .filter((series) => series.roundId === 'play_in');
  assert.equal(playIns.length, 12);
  assert.equal(playIns.every((series) => series.status === 'complete'), true);
  assert.equal(playIns.every((series) => series.winnerId && series.gameResults.length === 1), true);
  assert.equal(playIns.every((series) => series.gameResults[0].source === 'matchup'), true);
  assert.equal(playIns.every((series) => String(series.gameResults[0].matchupId).startsWith('recovered_')), true);

  const openingRound = Object.values(result.state.currentSeason.series)
    .filter((series) => series.roundId === 'opening_round');
  assert.equal(openingRound.length, 16);
  assert.equal(openingRound.every((series) => series.playerAId && series.playerBId), true);

  const augustSecond = result.state.schedule.find((day) => (day.dateKey || day.date) === '2026-08-02');
  const tournamentRows = (augustSecond?.matchups || []).filter((matchup) => matchup.matchupType === 'tournament');
  const exhibitionRows = (augustSecond?.matchups || []).filter((matchup) => matchup.matchupType === 'exhibition');
  const allPlayerIds = (augustSecond?.matchups || []).flatMap((matchup) => [matchup.playerAId, matchup.playerBId]);
  const tournamentPlayerIds = new Set(tournamentRows.flatMap((matchup) => [matchup.playerAId, matchup.playerBId]));

  assert.equal(augustSecond?.seasonMatchupControl, true);
  assert.equal(tournamentRows.length, 16);
  assert.equal(exhibitionRows.length, 14);
  assert.equal(augustSecond?.matchups?.length, 30);
  assert.equal(allPlayerIds.length, 60);
  assert.equal(new Set(allPlayerIds).size, 60);
  assert.equal(exhibitionRows.some((matchup) => tournamentPlayerIds.has(matchup.playerAId) || tournamentPlayerIds.has(matchup.playerBId)), false);
  assert.equal(tournamentRows.every((matchup) => matchup.roundId === 'opening_round'), true);
  assert.equal(tournamentRows.every((matchup) => matchup.seriesGameNumber === 1), true);
});

test('legacy blank-type daily rows are replaced by the controlled tournament and exhibition slate', () => {
  const result = recoverSeasonTwo();
  assert.equal(result.ok, true);

  const ordinary = ordinaryAugustSecondMatchups();
  const state = core.normalizeState({
    ...result.state,
    matchups: ordinary,
    schedule: [{ date: '2026-08-02', dateKey: '2026-08-02', matchups: ordinary }]
  });
  const repaired = core.repairSeasonControlledScheduleFromSyncedSeason(state, {
    todayDateKey: '2026-08-02',
    nowISO: '2026-08-02T12:30:00.000Z'
  });

  const sameDay = repaired.state.matchups.filter((matchup) => (matchup.dateKey || matchup.date) === '2026-08-02');
  const tournamentRows = sameDay.filter((matchup) => matchup.matchupType === 'tournament');
  const exhibitionRows = sameDay.filter((matchup) => matchup.matchupType === 'exhibition');
  const playerIds = sameDay.flatMap((matchup) => [matchup.playerAId, matchup.playerBId]);

  assert.equal(repaired.changed, true);
  assert.ok(repaired.reclassifiedLegacyExhibitionCount >= 30);
  assert.equal(sameDay.some((matchup) => !matchup.matchupType), false);
  assert.equal(sameDay.some((matchup) => String(matchup.id || '').startsWith('ordinary-')), false);
  assert.equal(tournamentRows.length, 16);
  assert.equal(exhibitionRows.length, 14);
  assert.equal(sameDay.length, 30);
  assert.equal(new Set(playerIds).size, 60);
});

test('blank-type rows referenced by stored Season results are never reclassified', () => {
  const result = recoverSeasonTwo();
  assert.equal(result.ok, true);

  const referenced = {
    id: 'referenced-legacy-row',
    date: '2026-08-02',
    dateKey: '2026-08-02',
    playerAId: 'P1',
    playerBId: 'P2'
  };
  const seriesEntry = Object.values(result.state.currentSeason.series)[0];
  const state = core.normalizeState({
    ...result.state,
    matchups: [referenced],
    schedule: [{ date: '2026-08-02', dateKey: '2026-08-02', matchups: [referenced] }],
    currentSeason: {
      ...result.state.currentSeason,
      series: {
        ...result.state.currentSeason.series,
        [seriesEntry.id]: {
          ...seriesEntry,
          gameResults: [...(seriesEntry.gameResults || []), { matchupId: referenced.id, dateKey: '2026-08-02' }]
        }
      }
    }
  });

  const prepared = core.classifyLegacySeasonExhibitionsForDate(state, '2026-08-02');
  assert.equal(prepared.changed, false);
  assert.equal(prepared.classifiedCount, 0);
  assert.equal(prepared.state.matchups[0].matchupType, undefined);
});

test('champion-crowned seasons do not regenerate controlled matchups', () => {
  const result = recoverSeasonTwo();
  assert.equal(result.ok, true);

  const championState = core.normalizeState({
    ...result.state,
    currentSeason: { ...result.state.currentSeason, status: 'champion_crowned' }
  });
  const before = JSON.stringify(championState.matchups);
  const materialized = core.materializeSeasonSlateMatchupsForDate(championState, '2026-08-02', {
    nowISO: '2026-08-02T12:40:00.000Z'
  });

  assert.equal(core.shouldUseSeasonMatchupControl(championState, '2026-08-02'), false);
  assert.equal(materialized.changed, false);
  assert.equal(JSON.stringify(materialized.state.matchups), before);
});

test('Season 2 missed Play-In recovery is idempotent', () => {
  const first = recoverSeasonTwo();
  const second = recovery.repairMissedPlayIn(first.state, {
    effectiveDateKey: '2026-08-02',
    nowISO: '2026-08-02T12:21:00.000Z'
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'already_recovered');
  assert.equal(JSON.stringify(second.state.currentSeason), JSON.stringify(first.state.currentSeason));
});
