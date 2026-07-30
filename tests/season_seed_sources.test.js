const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
global.TaskPointsCore = {};
global.TaskPointsSeason = {};

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
  assert.equal(seedSources.normalizeScope('', { name: 'Future Season' }), 'overall');
});

test('explicit valid ranking source is retained', () => {
  assert.equal(seedSources.normalizeScope('overall', { id: 'season_2_august_2026' }), 'overall');
  assert.equal(seedSources.normalizeScope('season1', { id: 'season_2_august_2026' }), 'season1');
  assert.equal(seedSources.normalizeScope('season2', { id: 'season_1_june_2026' }), 'season2');
});
