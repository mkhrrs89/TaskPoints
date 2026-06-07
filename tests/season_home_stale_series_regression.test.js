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

function completedMiggyJoeSeries(overrides = {}) {
  return {
    id: 'season_1_june_2026_round_of_32_1',
    seasonId: 'season_1_june_2026',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    roundIndex: 1,
    seriesIndex: 1,
    playerAId: 'YOU',
    playerAName: 'Miggy',
    playerBId: 'JOE',
    playerBName: 'Joe',
    bestOf: 5,
    winsNeeded: 3,
    winsA: 3,
    winsB: 0,
    status: 'complete',
    winnerId: 'YOU',
    loserId: 'JOE',
    gameResults: [
      { dateKey: '2026-06-04', matchupId: 'g1', winnerId: 'YOU', loserId: 'JOE', playerAScore: 100, playerBScore: 80, source: 'matchup' },
      { dateKey: '2026-06-05', matchupId: 'g2', winnerId: 'YOU', loserId: 'JOE', playerAScore: 95, playerBScore: 83, source: 'matchup' },
      { dateKey: '2026-06-06', matchupId: 'g3', winnerId: 'YOU', loserId: 'JOE', playerAScore: 91, playerBScore: 85, source: 'matchup' }
    ],
    ...overrides
  };
}

function makeState(extra = {}) {
  const series = completedMiggyJoeSeries();
  return core.normalizeState({
    youName: 'Miggy',
    players: [
      { id: 'JOE', name: 'Joe', active: true },
      { id: 'ALICE', name: 'Alice', active: true },
      { id: 'BOB', name: 'Bob', active: true }
    ],
    currentSeason: {
      id: 'season_1_june_2026',
      name: 'June 2026 Season',
      monthKey: '2026-06',
      status: 'active',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      meta: { seasonMatchupControlEnabled: true },
      series: { [series.id]: series }
    },
    matchups: [],
    schedule: [],
    ...extra
  });
}

function homeTypeLabel(state, matchup, dateKey) {
  const resolved = core.resolveHomeSeasonSeriesForMatchup(state, matchup, dateKey);
  return resolved.series ? 'Round 1 Match' : (resolved.ambiguous ? '' : 'Exhibition Match');
}

function homeSeriesLabel(state, matchup, dateKey) {
  const resolved = core.resolveHomeSeasonSeriesForMatchup(state, matchup, dateKey);
  if (!resolved.series) return '';
  const series = resolved.series;
  return series.playerAId === 'YOU'
    ? `Series: ${Number(series.winsA) || 0}–${Number(series.winsB) || 0}`
    : `Series: ${Number(series.winsB) || 0}–${Number(series.winsA) || 0}`;
}

test('home label does not treat completed stale direct series as active', () => {
  const state = makeState();
  const matchup = {
    id: 'today-stale',
    dateKey: '2026-06-07',
    playerAId: 'YOU',
    playerBId: 'JOE',
    seriesId: 'season_1_june_2026_round_of_32_1',
    seasonSeriesId: 'season_1_june_2026_round_of_32_1',
    matchupType: 'tournament',
    roundId: 'round_of_32',
    roundName: 'Round of 32'
  };

  assert.equal(homeTypeLabel(state, matchup, '2026-06-07'), 'Exhibition Match');
  assert.equal(homeSeriesLabel(state, matchup, '2026-06-07'), '');
});

test('explicit exhibition wins over stale series metadata', () => {
  const state = makeState();
  const matchup = {
    id: 'today-exhibition-stale',
    dateKey: '2026-06-07',
    playerAId: 'YOU',
    playerBId: 'JOE',
    seriesId: 'season_1_june_2026_round_of_32_1',
    seasonSeriesId: 'season_1_june_2026_round_of_32_1',
    matchupType: 'exhibition',
    roundId: 'round_of_32',
    roundName: 'Round of 32'
  };

  assert.equal(homeTypeLabel(state, matchup, '2026-06-07'), 'Exhibition Match');
  assert.equal(homeSeriesLabel(state, matchup, '2026-06-07'), '');
});

test('stale today tournament metadata is sanitized without changing completed series score', () => {
  const stale = {
    id: 'today-stale-with-score',
    dateKey: '2026-06-07',
    playerAId: 'YOU',
    playerBId: 'JOE',
    scoreA: 101,
    scoreB: 90,
    seriesId: 'season_1_june_2026_round_of_32_1',
    seasonSeriesId: 'season_1_june_2026_round_of_32_1',
    seasonSeriesID: 'season_1_june_2026_round_of_32_1',
    seriesID: 'season_1_june_2026_round_of_32_1',
    matchupType: 'tournament',
    roundId: 'round_of_32',
    roundName: 'Round of 32',
    seriesGameNumber: 4,
    bestOf: 5,
    winsNeeded: 3,
    seasonMatchupLabel: 'Round of 32, Game 4'
  };
  const state = makeState({ matchups: [stale] });

  const sanitized = core.sanitizeSeasonMatchupMetadataForDate(state, stale, '2026-06-07');
  assert.equal(sanitized.matchupType, 'exhibition');
  assert.equal(sanitized.seasonMatchupLabel, 'Exhibition');
  ['seriesId', 'seasonSeriesId', 'seasonSeriesID', 'seriesID', 'roundId', 'roundName', 'seriesGameNumber', 'bestOf', 'winsNeeded'].forEach((field) => {
    assert.equal(Object.hasOwn(sanitized, field), false, `${field} should be removed`);
  });
  assert.equal(sanitized.scoreA, 101);
  assert.equal(sanitized.scoreB, 90);

  const synced = core.syncSeasonResultsFromDailyMatchups(core.normalizeState({ ...state, matchups: [sanitized] }), '2026-06-07');
  const series = synced.updatedSeason.series.season_1_june_2026_round_of_32_1;
  assert.equal(series.winsA, 3);
  assert.equal(series.winsB, 0);
  assert.equal(series.gameResults.length, 3);
});

test('exhibition slate avoids immediate completed tournament opponent when a no-repeat pairing exists', () => {
  const state = makeState();
  const slate = core.buildSeasonDailySlate(state, '2026-06-07', { random: () => 0.42 });

  assert.equal(slate.ok, true, slate.errors.join('; '));
  const youMatchup = slate.exhibitionMatchups.find((matchup) => matchup.playerAId === 'YOU' || matchup.playerBId === 'YOU');
  assert.ok(youMatchup, 'YOU should have an exhibition matchup');
  assert.notEqual(youMatchup.playerAId === 'YOU' ? youMatchup.playerBId : youMatchup.playerAId, 'JOE');
  assert.equal(slate.warnings.some((warning) => /No-repeat June pairing rule relaxed/.test(warning)), false);
});
