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
const recovery = require('../season2_missed_playin_recovery.js');
const core = global.TaskPointsCore;

function makeSeeds(count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    seed: index + 1,
    playerId: `P${index + 1}`,
    playerName: `Player ${index + 1}`,
    name: `Player ${index + 1}`
  }));
}

function previewState(matchupControl = false) {
  const seeds = makeSeeds();
  return {
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
  return Array.from({ length: 30 }, (_, index) => ({
    id: `ordinary-2026-08-02-${index + 1}`,
    date: '2026-08-02',
    dateKey: '2026-08-02',
    playerAId: `P${index * 2 + 1}`,
    playerBId: `P${index * 2 + 2}`
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
  const playIns = Object.values(season.series).filter((series) => series.roundId === 'play_in');
  const gameHistory = playIns.flatMap((series) => [series.playerAId, series.playerBId])
    .map((playerId) => {
      const seed = Number(String(playerId).replace(/^P/, ''));
      return {
        id: `history-${playerId}`,
        date: '2026-08-01',
        dateKey: '2026-08-01',
        playerId,
        score: 100 - seed
      };
    });
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
  const result = recovery.repairMissedPlayIn(brokenLockedSeasonState(), {
    effectiveDateKey: '2026-08-02',
    nowISO: '2026-08-02T12:20:00.000Z'
  });

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
  assert.equal(augustSecond?.seasonMatchupControl, true);
  assert.equal(tournamentRows.length, 16);
  assert.equal(tournamentRows.every((matchup) => matchup.roundId === 'opening_round'), true);
  assert.equal(tournamentRows.every((matchup) => matchup.seriesGameNumber === 1), true);
});

test('Season 2 missed Play-In recovery is idempotent', () => {
  const first = recovery.repairMissedPlayIn(brokenLockedSeasonState(), {
    effectiveDateKey: '2026-08-02',
    nowISO: '2026-08-02T12:20:00.000Z'
  });
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
