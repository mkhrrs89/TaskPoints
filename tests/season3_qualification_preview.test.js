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
require('../season.js');

const core = global.TaskPointsCore;
const seasonApi = global.TaskPointsSeason;

function makeState(count = 80) {
  return core.normalizeState({
    youName: 'You',
    players: Array.from({ length: count - 1 }, (_, index) => ({
      id: `P${index + 1}`,
      name: `Player ${index + 1}`,
      active: true
    })),
    matchups: [],
    gameHistory: [],
    completions: []
  });
}

test('new Season 3 preview keeps all active players ranked while defining a top-60 field', () => {
  const state = makeState(80);
  const activeIds = core.getActiveSeasonPlayerPool(state).map((player) => player.id || player.playerId);
  const preview = seasonApi.buildManualSeasonPreview(state, {
    name: 'Season 3',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    playerIds: activeIds
  });

  assert.equal(preview.id, 'season_3_october_2026');
  assert.equal(preview.monthKey, '2026-10');
  assert.equal(preview.seedMode, seasonApi.AUTO_SEED_MODE);
  assert.equal(preview.seedRankingScope, 'season3');
  assert.equal(preview.seeds.length, 80);
  assert.equal(preview.meta.qualificationFieldSize, 60);
  assert.equal(preview.meta.qualificationRule, 'top_60_season3_rankings');
  assert.equal(preview.meta.canCreateOfficialBracket, true);
  assert.deepEqual(preview.meta.bufferDays, []);
  assert.equal(preview.bracket.type, 'season3_60_player_preview_shell');
  assert.deepEqual(preview.bracket.rounds.map((round) => round.id), [
    'play_in', 'opening_round', 'round_of_32', 'round_of_16', 'quarterfinals', 'semifinals', 'finals'
  ]);
});

test('Season 3 preview refuses to claim bracket readiness below 60 ranked active players', () => {
  const state = makeState(59);
  const activeIds = core.getActiveSeasonPlayerPool(state).map((player) => player.id || player.playerId);
  const preview = seasonApi.buildManualSeasonPreview(state, {
    name: 'Season 3',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    playerIds: activeIds
  });

  assert.equal(preview.seeds.length, 59);
  assert.equal(preview.meta.canCreateOfficialBracket, false);
  assert.equal(preview.warnings.some((warning) => warning.code === 'season3_insufficient_qualifiers'), true);
});

test('base Season preparation does not replace a scoped Season 3 seed order with overall rankings', () => {
  const state = makeState(80);
  const seeded = seasonApi.buildManualSeasonPreview(state, {
    name: 'Season 3',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    playerIds: core.getActiveSeasonPlayerPool(state).map((player) => player.id || player.playerId)
  });
  const customOrder = seeded.seeds.slice().reverse().map((seed, index) => ({ ...seed, seed: index + 1 }));
  const prepared = seasonApi.prepareSeasonStateForPreview(
    { ...state, currentSeason: { ...seeded, seeds: customOrder } },
    { effectiveDateKey: '2026-09-29', nowISO: '2026-09-29T12:00:00.000Z' }
  );

  assert.deepEqual(
    prepared.state.currentSeason.seeds.map((seed) => seed.playerId),
    customOrder.map((seed) => seed.playerId)
  );
});
