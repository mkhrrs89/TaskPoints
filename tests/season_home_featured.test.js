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

function buildSeries(overrides = {}) {
  return {
    id: 'play-in-1',
    roundId: 'play_in',
    roundName: 'Play-In',
    roundIndex: 0,
    seriesIndex: 0,
    playerAId: 'A',
    playerAName: 'Player A',
    playerASeed: 33,
    playerBId: 'B',
    playerBName: 'Player B',
    playerBSeed: 34,
    bestOf: 3,
    winsNeeded: 2,
    winsA: 0,
    winsB: 0,
    gameNumber: 2,
    currentGameNumber: 2,
    status: 'active',
    gameResults: [],
    ...overrides,
  };
}

test('home series game number is derived from live wins instead of stale stored fields', () => {
  assert.equal(core.getCurrentSeriesGameNumberForHome(buildSeries({ winsA: 0, winsB: 0, gameNumber: 99 })), 1);
  assert.equal(core.getCurrentSeriesGameNumberForHome(buildSeries({ winsA: 1, winsB: 0, gameNumber: 1 })), 2);
  assert.equal(core.getCurrentSeriesGameNumberForHome(buildSeries({ winsA: 1, winsB: 1, gameNumber: 2 })), 3);
  assert.equal(core.getCurrentSeriesGameNumberForHome(buildSeries({ winsA: 2, winsB: 1, bestOf: 5, winsNeeded: 3, gameNumber: 2 })), 4);
});

test('featured home matchup uses live series score for game number and elimination state', () => {
  const series = buildSeries({ winsA: 1, winsB: 1, gameNumber: 2, currentGameNumber: 2 });
  const season = { id: 'season-1', status: 'active', series: { [series.id]: series } };

  const featured = core.getFeaturedSeasonMatchup(season, '2026-06-02', { matchups: [] });

  assert.equal(featured.roundName, 'Play-In');
  assert.equal(featured.statusText, 'Series tied 1–1');
  assert.equal(featured.gameNumber, 3);
  assert.equal(featured.isEliminationGame, true);
});

test('featured matchup prefers a rivalry over a comparable ordinary matchup', () => {
  const rivalry = buildSeries({
    id: 'rivalry',
    seriesIndex: 2,
    playerAId: 'A',
    playerAName: 'Alpha',
    playerASeed: 18,
    playerBId: 'B',
    playerBName: 'Beta',
    playerBSeed: 19,
    winsA: 0,
    winsB: 0,
    bestOf: 5,
    winsNeeded: 3
  });
  const ordinary = buildSeries({
    id: 'ordinary',
    seriesIndex: 1,
    playerAId: 'C',
    playerAName: 'Charlie',
    playerASeed: 1,
    playerBId: 'D',
    playerBName: 'Delta',
    playerBSeed: 32,
    winsA: 0,
    winsB: 0,
    bestOf: 5,
    winsNeeded: 3
  });
  const season = { id: 'season-1', status: 'active', series: { rivalry, ordinary } };
  const state = {
    players: [
      { id: 'A', name: 'Alpha', rivalId: 'B' },
      { id: 'B', name: 'Beta' },
      { id: 'C', name: 'Charlie' },
      { id: 'D', name: 'Delta' }
    ],
    matchups: [
      { dateKey: '2026-06-02', matchupType: 'tournament', seriesId: 'rivalry' },
      { dateKey: '2026-06-02', matchupType: 'tournament', seriesId: 'ordinary' }
    ]
  };

  const featured = core.getFeaturedSeasonMatchup(season, '2026-06-02', state);

  assert.equal(core.isPlayerRivalry(state, 'A', 'B'), true);
  assert.equal(core.isPlayerRivalry(state, 'B', 'A'), true);
  assert.equal(featured.series.id, 'rivalry');
  assert.equal(featured.isRivalry, true);
});

test('rivalry boost does not outrank a higher-stakes elimination game', () => {
  const rivalry = buildSeries({
    id: 'rivalry',
    seriesIndex: 1,
    playerAId: 'A',
    playerAName: 'Alpha',
    playerBId: 'B',
    playerBName: 'Beta',
    winsA: 0,
    winsB: 0,
    bestOf: 5,
    winsNeeded: 3
  });
  const elimination = buildSeries({
    id: 'elimination',
    seriesIndex: 2,
    playerAId: 'C',
    playerAName: 'Charlie',
    playerBId: 'D',
    playerBName: 'Delta',
    winsA: 2,
    winsB: 0,
    bestOf: 5,
    winsNeeded: 3
  });
  const season = { id: 'season-1', status: 'active', series: { rivalry, elimination } };
  const state = {
    players: [
      { id: 'A', rivalId: 'B' },
      { id: 'B' },
      { id: 'C' },
      { id: 'D' }
    ],
    matchups: [
      { dateKey: '2026-06-02', matchupType: 'tournament', seriesId: 'rivalry' },
      { dateKey: '2026-06-02', matchupType: 'tournament', seriesId: 'elimination' }
    ]
  };

  const featured = core.getFeaturedSeasonMatchup(season, '2026-06-02', state);

  assert.equal(featured.series.id, 'elimination');
  assert.equal(featured.isEliminationGame, true);
  assert.equal(featured.isRivalry, false);
});
