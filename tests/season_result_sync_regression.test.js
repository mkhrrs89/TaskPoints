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

const core = global.TaskPointsCore;

function result({ id, seriesId, dateKey, gameNumber, playerAId, playerBId, winnerId, source = 'matchup', extra = {} }) {
  const loserId = winnerId === playerAId ? playerBId : playerAId;
  return {
    id,
    matchupId: id,
    seasonId: 'season_1_june_2026',
    seriesId,
    seasonSeriesId: seriesId,
    dateKey,
    gameNumber,
    seriesGameNumber: gameNumber,
    game: gameNumber,
    matchupType: 'tournament',
    playerAId,
    playerBId,
    winnerId,
    loserId,
    scoreA: winnerId === playerAId ? 40 : 20,
    scoreB: winnerId === playerBId ? 40 : 20,
    source,
    ...extra
  };
}

function makeRoundSeries(overrides = {}) {
  return {
    id: 'round32_miggy_joe',
    seasonId: 'season_1_june_2026',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    seriesIndex: 0,
    playerAId: 'miggy',
    playerAName: 'Miggy/You',
    playerASeed: 1,
    playerBId: 'joe',
    playerBName: 'Joe',
    playerBSeed: 32,
    bestOf: 5,
    winsNeeded: 3,
    winsA: 0,
    winsB: 0,
    status: 'active',
    gameResults: [],
    ...overrides
  };
}

function makePlayInSeason(overrides = {}) {
  const playIn1 = {
    id: 'season_1_june_2026_play_in_1',
    seasonId: 'season_1_june_2026',
    roundId: 'play_in',
    roundName: 'Play-In',
    seriesIndex: 0,
    playerAId: 'A',
    playerAName: 'Player A',
    playerASeed: 31,
    playerBId: 'B',
    playerBName: 'Player B',
    playerBSeed: 34,
    bestOf: 3,
    winsNeeded: 2,
    winsA: 0,
    winsB: 0,
    status: 'active',
    gameResults: [result({ id: 'stale_p1_game1', seriesId: 'season_1_june_2026_play_in_1', dateKey: '2026-06-02', gameNumber: 1, playerAId: 'A', playerBId: 'B', winnerId: 'B', source: 'admin_catch_up', extra: { catchUpResult: true, playInProtectedSlotRepair: true } })]
  };
  const playIn2 = {
    id: 'season_1_june_2026_play_in_2',
    seasonId: 'season_1_june_2026',
    roundId: 'play_in',
    roundName: 'Play-In',
    seriesIndex: 1,
    playerAId: 'C',
    playerAName: 'Player C',
    playerASeed: 32,
    playerBId: 'D',
    playerBName: 'Player D',
    playerBSeed: 33,
    bestOf: 3,
    winsNeeded: 2,
    winsA: 0,
    winsB: 0,
    status: 'active',
    gameResults: [result({ id: 'stale_p2_game1', seriesId: 'season_1_june_2026_play_in_2', dateKey: '2026-06-02', gameNumber: 1, playerAId: 'C', playerBId: 'D', winnerId: 'C', source: 'admin_catch_up', extra: { catchUpResult: true, playInProtectedSlotRepair: true } })]
  };
  const r32Seed1 = {
    id: 'r32_seed_1',
    seasonId: 'season_1_june_2026',
    roundId: 'round_of_32',
    seriesIndex: 0,
    playerAId: 'seed1',
    playerAName: 'Seed 1',
    playerASeed: 1,
    playerBId: 'B',
    playerBName: 'Player B',
    playerBSeed: 34,
    bestOf: 5,
    winsNeeded: 3,
    status: 'active'
  };
  const r32Seed2 = {
    id: 'r32_seed_2',
    seasonId: 'season_1_june_2026',
    roundId: 'round_of_32',
    seriesIndex: 8,
    playerAId: 'seed2',
    playerAName: 'Seed 2',
    playerASeed: 2,
    playerBId: 'C',
    playerBName: 'Player C',
    playerBSeed: 32,
    bestOf: 5,
    winsNeeded: 3,
    status: 'active'
  };
  return {
    id: 'season_1_june_2026',
    monthKey: '2026-06',
    status: 'active',
    seeds: [
      { seed: 1, playerId: 'seed1', playerName: 'Seed 1' },
      { seed: 2, playerId: 'seed2', playerName: 'Seed 2' },
      { seed: 31, playerId: 'A', playerName: 'Player A' },
      { seed: 32, playerId: 'C', playerName: 'Player C' },
      { seed: 33, playerId: 'D', playerName: 'Player D' },
      { seed: 34, playerId: 'B', playerName: 'Player B' }
    ],
    series: {
      [playIn1.id]: playIn1,
      [playIn2.id]: playIn2,
      [r32Seed1.id]: r32Seed1,
      [r32Seed2.id]: r32Seed2
    },
    ...overrides
  };
}

function playInMatchups() {
  return [
    result({ id: 'p1_g1_real', seriesId: 'season_1_june_2026_play_in_1', dateKey: '2026-06-02', gameNumber: 1, playerAId: 'A', playerBId: 'B', winnerId: 'A' }),
    result({ id: 'p1_g2_real', seriesId: 'season_1_june_2026_play_in_1', dateKey: '2026-06-03', gameNumber: 2, playerAId: 'A', playerBId: 'B', winnerId: 'B' }),
    result({ id: 'p2_g1_real', seriesId: 'season_1_june_2026_play_in_2', dateKey: '2026-06-02', gameNumber: 1, playerAId: 'C', playerBId: 'D', winnerId: 'C' }),
    result({ id: 'p2_g2_real', seriesId: 'season_1_june_2026_play_in_2', dateKey: '2026-06-03', gameNumber: 2, playerAId: 'C', playerBId: 'D', winnerId: 'D' })
  ];
}

test('current-day results are ignored by normal season sync', () => {
  const series = makeRoundSeries({
    gameResults: [result({ id: 'stale_today', seriesId: 'round32_miggy_joe', dateKey: '2026-06-06', gameNumber: 3, playerAId: 'miggy', playerBId: 'joe', winnerId: 'miggy' })]
  });
  const state = {
    currentSeason: { id: 'season_1_june_2026', monthKey: '2026-06', status: 'active', series: { [series.id]: series } },
    matchups: [
      result({ id: 'miggy_joe_0604', seriesId: series.id, dateKey: '2026-06-04', gameNumber: 1, playerAId: 'miggy', playerBId: 'joe', winnerId: 'miggy' }),
      result({ id: 'miggy_joe_0605', seriesId: series.id, dateKey: '2026-06-05', gameNumber: 2, playerAId: 'miggy', playerBId: 'joe', winnerId: 'miggy' }),
      result({ id: 'miggy_joe_0606_live', seriesId: series.id, dateKey: '2026-06-06', gameNumber: 3, playerAId: 'miggy', playerBId: 'joe', winnerId: 'joe' })
    ]
  };

  const synced = core.syncCurrentSeasonSeriesFromRecordedResults(state, { nowISO: '2026-06-06T22:08:00.000Z' });
  const repaired = synced.state.currentSeason.series[series.id];

  assert.equal(repaired.winsA, 2);
  assert.equal(repaired.winsB, 0);
  assert.equal(repaired.status, 'active');
  assert.equal(repaired.gameResults.length, 2);
});

test('synthetic repair results do not override real matchup results', () => {
  const series = makeRoundSeries({ id: 'synthetic_priority_play_in', roundId: 'play_in', playerAId: 'A', playerBId: 'B', winsNeeded: 2, bestOf: 3 });
  const state = {
    currentSeason: { id: 'season_1_june_2026', monthKey: '2026-06', status: 'active', series: { [series.id]: series } },
    matchups: [result({ id: 'real_g1', seriesId: series.id, dateKey: '2026-06-04', gameNumber: 1, playerAId: 'A', playerBId: 'B', winnerId: 'A' })]
  };
  state.currentSeason.series[series.id].gameResults = [result({ id: 'synthetic_g1', seriesId: series.id, dateKey: '2026-06-04', gameNumber: 1, playerAId: 'A', playerBId: 'B', winnerId: 'B', source: 'admin_catch_up', extra: { catchUpResult: true } })];

  const synced = core.syncCurrentSeasonSeriesFromRecordedResults(state, { nowISO: '2026-06-06T00:00:00.000Z' });
  const repaired = synced.state.currentSeason.series[series.id];

  assert.equal(repaired.winsA, 1);
  assert.equal(repaired.winsB, 0);
  assert.equal(repaired.gameResults[0].winnerId, 'A');
});

test('Play-In protected-slot repair adds only the minimum decider for the protected Player B winner', () => {
  const season = makePlayInSeason();
  const state = { currentSeason: season, matchups: playInMatchups() };

  const repaired = core.repairPlayInSeriesFromProtectedRoundOf32Slots(season, { state, nowISO: '2026-06-07T00:00:00.000Z' });
  assert.equal(repaired.ok, true);
  const series = repaired.season.series.season_1_june_2026_play_in_1;
  assert.equal(series.winsA, 1);
  assert.equal(series.winsB, 2);
  assert.equal(series.status, 'complete');
  assert.equal(series.winnerId, 'B');

  const again = core.repairPlayInSeriesFromProtectedRoundOf32Slots(repaired.season, { state: { currentSeason: repaired.season, matchups: playInMatchups() }, nowISO: '2026-06-07T00:00:00.000Z' });
  assert.deepEqual(again.season.series.season_1_june_2026_play_in_1.gameResults, series.gameResults);
});

test('Play-In protected-slot repair adds only the minimum decider for the opposite Player A winner', () => {
  const season = makePlayInSeason();
  const state = { currentSeason: season, matchups: playInMatchups() };

  const repaired = core.repairPlayInSeriesFromProtectedRoundOf32Slots(season, { state, nowISO: '2026-06-07T00:00:00.000Z' });
  const series = repaired.season.series.season_1_june_2026_play_in_2;
  assert.equal(series.winsA, 2);
  assert.equal(series.winsB, 1);
  assert.equal(series.status, 'complete');
  assert.equal(series.winnerId, 'C');

  const again = core.repairPlayInSeriesFromProtectedRoundOf32Slots(repaired.season, { state: { currentSeason: repaired.season, matchups: playInMatchups() }, nowISO: '2026-06-07T00:00:00.000Z' });
  assert.deepEqual(again.season.series.season_1_june_2026_play_in_2.gameResults, series.gameResults);
});

test('audit-safe result summary matches core counting and does not double-count stale synthetic records', () => {
  const season = makePlayInSeason();
  const state = { currentSeason: season, matchups: playInMatchups() };
  const repaired = core.repairPlayInSeriesFromProtectedRoundOf32Slots(season, { state, nowISO: '2026-06-07T00:00:00.000Z' });
  const nextState = { currentSeason: repaired.season, matchups: playInMatchups() };

  const summary1 = core.getSeasonSeriesRecordedResultSummary(nextState, repaired.season, repaired.season.series.season_1_june_2026_play_in_1, { nowISO: '2026-06-07T00:00:00.000Z' });
  const summary2 = core.getSeasonSeriesRecordedResultSummary(nextState, repaired.season, repaired.season.series.season_1_june_2026_play_in_2, { nowISO: '2026-06-07T00:00:00.000Z' });

  assert.equal(summary1.winsA, 1);
  assert.equal(summary1.winsB, 2);
  assert.equal(summary1.gameResults.length, 3);
  assert.equal(summary2.winsA, 2);
  assert.equal(summary2.winsB, 1);
  assert.equal(summary2.gameResults.length, 3);
});

test('same-day true admin manual override is preserved while same-day live matchup is excluded', () => {
  const series = makeRoundSeries({
    id: 'same_day_admin_override',
    seriesIndex: 3,
    playerASeed: 10,
    playerBSeed: 23,
    playerAId: 'adminA',
    playerBId: 'adminB',
    gameResults: [result({
      id: 'same_day_admin_manual_g1',
      seriesId: 'same_day_admin_override',
      dateKey: '2026-06-06',
      gameNumber: 1,
      playerAId: 'adminA',
      playerBId: 'adminB',
      winnerId: 'adminA',
      source: 'admin_manual',
      extra: { manualResult: true }
    })]
  });
  const state = {
    currentSeason: { id: 'season_1_june_2026', monthKey: '2026-06', status: 'active', series: { [series.id]: series } },
    matchups: [result({
      id: 'same_day_live_matchup_g1',
      seriesId: series.id,
      dateKey: '2026-06-06',
      gameNumber: 1,
      playerAId: 'adminA',
      playerBId: 'adminB',
      winnerId: 'adminB'
    })]
  };

  const synced = core.syncCurrentSeasonSeriesFromRecordedResults(state, { nowISO: '2026-06-06T22:08:00.000Z' });
  const repaired = synced.state.currentSeason.series[series.id];

  assert.equal(repaired.winsA, 1);
  assert.equal(repaired.winsB, 0);
  assert.equal(repaired.gameResults.length, 1);
  assert.equal(repaired.gameResults[0].winnerId, 'adminA');
  assert.equal(repaired.gameResults[0].source, 'admin_manual');
});

test('same-day synthetic repair result does not bypass normal current-day guard', () => {
  const series = makeRoundSeries({
    id: 'same_day_synthetic_guard',
    seriesIndex: 4,
    playerASeed: 11,
    playerBSeed: 22,
    playerAId: 'synA',
    playerBId: 'synB',
    gameResults: [result({
      id: 'same_day_synthetic_g1',
      seriesId: 'same_day_synthetic_guard',
      dateKey: '2026-06-06',
      gameNumber: 1,
      playerAId: 'synA',
      playerBId: 'synB',
      winnerId: 'synA',
      source: 'admin_catch_up',
      extra: { manualResult: true, catchUpResult: true, lateBoundSeriesCatchUp: true, playInProtectedSlotRepair: true }
    })]
  });
  const state = {
    currentSeason: { id: 'season_1_june_2026', monthKey: '2026-06', status: 'active', series: { [series.id]: series } },
    matchups: []
  };

  const synced = core.syncCurrentSeasonSeriesFromRecordedResults(state, { nowISO: '2026-06-06T22:08:00.000Z' });
  const repaired = synced.state.currentSeason.series[series.id];

  assert.equal(repaired.winsA, 0);
  assert.equal(repaired.winsB, 0);
  assert.equal(repaired.gameResults.length, 0);
});

test('forced current-day sync includes same-day non-manual matchup results', () => {
  const series = makeRoundSeries({ id: 'forced_current_day', seriesIndex: 5, playerASeed: 12, playerBSeed: 21, playerAId: 'forceA', playerBId: 'forceB' });
  const state = {
    currentSeason: { id: 'season_1_june_2026', monthKey: '2026-06', status: 'active', series: { [series.id]: series } },
    matchups: [result({
      id: 'forced_current_day_live_g1',
      seriesId: series.id,
      dateKey: '2026-06-06',
      gameNumber: 1,
      playerAId: 'forceA',
      playerBId: 'forceB',
      winnerId: 'forceB'
    })]
  };

  const normal = core.syncCurrentSeasonSeriesFromRecordedResults(state, { nowISO: '2026-06-06T22:08:00.000Z' });
  assert.equal(normal.state.currentSeason.series[series.id].winsB, 0);

  const forced = core.syncCurrentSeasonSeriesFromRecordedResults(state, { nowISO: '2026-06-06T22:08:00.000Z', includeCurrentDayResults: true });
  const repaired = forced.state.currentSeason.series[series.id];
  assert.equal(repaired.winsA, 0);
  assert.equal(repaired.winsB, 1);
  assert.equal(repaired.gameResults.length, 1);
  assert.equal(repaired.gameResults[0].winnerId, 'forceB');
});
