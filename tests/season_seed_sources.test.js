const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
global.TaskPointsCore = {};
global.TaskPointsSeason = {
  generateProjectedSeeds(state) {
    const hasSeasonTwoData = (state?.matchups || []).some((row) => String(row?.dateKey || '') >= '2026-07-01');
    const order = hasSeasonTwoData ? ['B', 'A'] : ['A', 'B'];
    return {
      seeds: order.map((playerId, index) => ({
        seed: index + 1,
        playerId,
        id: playerId,
        playerName: playerId,
        name: playerId,
        wins: hasSeasonTwoData ? 2 - index : index,
        losses: index,
        winPct: hasSeasonTwoData ? 1 - (index * 0.5) : index * 0.5,
        totalPoints: hasSeasonTwoData ? 20 - index : 10 + index,
        averageScore: hasSeasonTwoData ? 10 - index : 5 + index,
        marginOfVictory: hasSeasonTwoData ? 3 - index : index
      })),
      warnings: []
    };
  },
  buildProjectedBracket(seeds) {
    return { participantIds: seeds.map((seed) => seed.playerId) };
  }
};

require('../season_seed_sources.js');

const seedSources = global.TaskPointsSeasonSeedSources;

test('season ranking scopes use the same July 1 boundary as Rankings', () => {
  const sample = {
    matchups: [
      { id: 'm-season-1', dateKey: '2026-06-30' },
      { id: 'm-season-2', dateKey: '2026-07-01' }
    ],
    gameHistory: [
      { id: 'g-season-1', dateKey: '2026-06-15' },
      { id: 'g-season-2', dateKey: '2026-07-15' }
    ],
    completions: [
      { id: 'c-season-1', completedAtISO: '2026-06-20T12:00:00.000Z' },
      { id: 'c-season-2', completedAtISO: '2026-07-20T12:00:00.000Z' }
    ]
  };

  const seasonOne = seedSources.getScopedState(sample, 'season1');
  const seasonTwo = seedSources.getScopedState(sample, 'season2');
  const overall = seedSources.getScopedState(sample, 'overall');

  assert.deepEqual(seasonOne.matchups.map((row) => row.id), ['m-season-1']);
  assert.deepEqual(seasonTwo.matchups.map((row) => row.id), ['m-season-2']);
  assert.deepEqual(seasonOne.gameHistory.map((row) => row.id), ['g-season-1']);
  assert.deepEqual(seasonTwo.gameHistory.map((row) => row.id), ['g-season-2']);
  assert.deepEqual(seasonOne.completions.map((row) => row.id), ['c-season-1']);
  assert.deepEqual(seasonTwo.completions.map((row) => row.id), ['c-season-2']);
  assert.equal(overall, sample);
});

test('ranking source defaults follow the season being previewed', () => {
  assert.equal(seedSources.normalizeScope('', { id: 'season_1_june_2026' }), 'season1');
  assert.equal(seedSources.normalizeScope('', { id: 'season_2_august_2026' }), 'season2');
  assert.equal(seedSources.normalizeScope('', { name: 'Season 1' }), 'season1');
  assert.equal(seedSources.normalizeScope('', { name: 'Season 2' }), 'season2');
  assert.equal(seedSources.normalizeScope('', {
    name: 'Season 1',
    monthKey: '2026-06',
    label: 'August 2026 TaskPoints Championship'
  }), 'season2');
  assert.equal(seedSources.normalizeScope('', { name: 'Future Season' }), 'overall');
});

test('explicit valid ranking source is retained', () => {
  assert.equal(seedSources.normalizeScope('overall', { id: 'season_2_august_2026' }), 'overall');
  assert.equal(seedSources.normalizeScope('season1', { id: 'season_2_august_2026' }), 'season1');
  assert.equal(seedSources.normalizeScope('season2', { id: 'season_1_june_2026' }), 'season2');
});

test('new preview ordering follows the chosen scope without changing the selected pool', () => {
  const baseSeason = {
    id: 'season_2_august_2026',
    name: 'Season 2',
    status: 'preview',
    seedMode: 'manual',
    warnings: [{ code: 'structural', message: 'Keep me' }],
    seeds: [
      { seed: 1, playerId: 'A', playerName: 'Alpha', imageId: 'image-a' },
      { seed: 2, playerId: 'B', playerName: 'Bravo', imageId: 'image-b' }
    ],
    bracket: { participantIds: ['A', 'B'] }
  };
  const state = {
    players: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    matchups: [
      { dateKey: '2026-06-30', playerAId: 'A', playerBId: 'B' },
      { dateKey: '2026-07-01', playerAId: 'A', playerBId: 'B' }
    ]
  };

  const rebuilt = seedSources.reorderManualPreviewByScope(baseSeason, state, 'season2', ['A', 'B']);

  assert.deepEqual(rebuilt.seeds.map((seed) => seed.playerId), ['B', 'A']);
  assert.deepEqual(rebuilt.seeds.map((seed) => seed.seed), [1, 2]);
  assert.equal(rebuilt.seeds.some((seed) => seed.playerId === 'C'), false);
  assert.equal(rebuilt.seeds.find((seed) => seed.playerId === 'A').imageId, 'image-a');
  assert.deepEqual(rebuilt.bracket.participantIds, ['B', 'A']);
  assert.deepEqual(rebuilt.warnings, [{ code: 'structural', message: 'Keep me' }]);
  assert.equal(rebuilt.seedRankingScope, 'season2');
});
