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
require('../season_matchup_materialization_guard.js');
const core = global.TaskPointsCore;

function oddPoolState() {
  const legacy = {
    id: 'legacy-ordinary-row',
    date: '2026-08-02',
    dateKey: '2026-08-02',
    playerAId: 'YOU',
    playerBId: 'P3'
  };
  const round = {
    id: 'opening_round',
    displayName: 'Opening Round',
    startDate: '2026-08-02',
    endDate: '2026-08-02',
    bestOf: 1
  };
  return core.normalizeState({
    youName: 'You',
    players: [
      { id: 'P2', name: 'Player 2', active: true },
      { id: 'P3', name: 'Player 3', active: true }
    ],
    tasks: [],
    habits: [],
    completions: [],
    gameHistory: [],
    flexActions: [],
    opponentDripSchedules: [],
    matchups: [legacy],
    schedule: [{ date: '2026-08-02', dateKey: '2026-08-02', matchups: [legacy] }],
    currentSeason: {
      id: 'odd_pool_season',
      monthKey: '2026-08',
      startDate: '2026-08-02',
      endDate: '2026-08-02',
      startDateKey: '2026-08-02',
      endDateKey: '2026-08-02',
      status: 'active',
      dateWindows: [round],
      bracketConfig: { rounds: [round] },
      bracket: { roundOrder: ['opening_round'] },
      meta: {
        seasonMatchupControlEnabled: true,
        roundStartDateKeys: { opening_round: '2026-08-02' }
      },
      series: {
        odd_pool_opening_round_1: {
          id: 'odd_pool_opening_round_1',
          seasonId: 'odd_pool_season',
          roundId: 'opening_round',
          roundName: 'Opening Round',
          roundIndex: 1,
          seriesIndex: 1,
          status: 'active',
          bestOf: 1,
          winsNeeded: 1,
          playerAId: 'YOU',
          playerAName: 'You',
          playerBId: 'P2',
          playerBName: 'Player 2',
          winsA: 0,
          winsB: 0,
          winnerId: '',
          loserId: '',
          gameResults: []
        }
      }
    }
  });
}

test('odd exhibition pools do not destructively replace legacy rows', () => {
  const state = oddPoolState();
  const before = JSON.stringify(state);
  const result = core.repairSeasonControlledScheduleFromSyncedSeason(state, {
    todayDateKey: '2026-08-02',
    nowISO: '2026-08-02T12:00:00.000Z'
  });

  assert.equal(result.changed, false);
  assert.equal(JSON.stringify(result.state), before);
  assert.equal(result.state.matchups[0].matchupType, undefined);
  assert.equal((result.errors || []).some((message) => String(message).includes('Odd exhibition player pool')), true);
});

test('legacy classification stays dormant outside a controlled Season date', () => {
  const state = oddPoolState();
  const result = core.classifyLegacySeasonExhibitionsForDate(state, '2026-08-03');

  assert.equal(result.changed, false);
  assert.equal(result.classifiedCount, 0);
  assert.equal(result.state.matchups[0].matchupType, undefined);
});
