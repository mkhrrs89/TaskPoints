const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = home.indexOf('function simulateToday() {');
const end = home.indexOf('function getHistoryDateKey(g)', start);
assert.ok(start > 0 && end > start);
const simulateSource = home.slice(start, end);
const clone = value => JSON.parse(JSON.stringify(value));
const day = '2026-11-11';
const scoreFor = id => id === 'YOU' ? 12 : 55 + Number(id.split('-')[1]);
const effectFor = id => ({ greedRating: 25, npcId: id });

function seed() {
  const players = Array.from({ length: 8 }, (_, i) =>
    ({ id: 'NPC-' + i, name: 'Player ' + i, greed: 25, active: true }));
  const matchups = Array.from({ length: 6500 }, (_, i) => ({
    id: 'prior-' + i, dateKey: '2026-11-10',
    playerAId: 'NPC-' + (i % 8), playerBId: 'NPC-' + ((i + 1) % 8),
    scoreA: 65, scoreB: 46
  }));
  // Match by pair, even though the new schedule has a different ID.
  matchups.push({ id: 'prior-today', dateKey: day, playerAId: 'NPC-1', playerBId: 'NPC-0',
    scoreA: 42, scoreB: 50, matchupType: 'regular', playerAEffects: { existing: true } });
  // Match by ID, even though the pair in the saved record differs.
  matchups.push({ id: 'stable', dateKey: day, playerAId: 'NPC-6', playerBId: 'NPC-7',
    scoreA: 41, scoreB: 46, matchupType: 'playoff' });
  const todayPairs = [
    { id: 'new-pair', playerAId: 'NPC-0', playerBId: 'NPC-1', matchupType: 'regular' },
    { id: 'stable', playerAId: 'NPC-1', playerBId: 'NPC-2', matchupType: 'playoff' },
    { id: 'new-3', playerAId: 'NPC-2', playerBId: 'NPC-3', matchupType: 'regular' },
    { id: 'new-4', playerAId: 'NPC-4', playerBId: 'NPC-5', matchupType: 'regular' },
    { id: 'new-5', playerAId: 'NPC-6', playerBId: 'YOU', matchupType: 'regular' }
  ];
  const gameHistory = Array.from({ length: 5000 }, (_, i) => ({
    id: 'history-' + i, date: '2026-11-10', playerId: 'NPC-' + (i % 8), score: 50
  }));
  gameHistory.push({ id: 'existing-today', date: day, playerId: 'NPC-3',
    score: 31, effects: { previous: true } });
  return {
    players, gameHistory, matchups,
    schedule: [{ date: day, matchups: todayPairs }]
  };
}

function expectedMatchups(state) {
  const existing = clone(state.matchups);
  const pairs = state.schedule[0].matchups;
  const names = new Map(state.players.map(p => [p.id, p.name]));
  for (const pair of pairs) {
    const candidate = {
      ...pair, id: pair.id, date: day, dateKey: day,
      playerAName: names.get(pair.playerAId) || (pair.playerAId === 'YOU' ? 'You' : 'Unknown'),
      playerBName: names.get(pair.playerBId) || (pair.playerBId === 'YOU' ? 'You' : 'Unknown'),
      scoreA: scoreFor(pair.playerAId), scoreB: scoreFor(pair.playerBId),
      playerAEffects: pair.playerAId === 'YOU' ? null : effectFor(pair.playerAId),
      playerBEffects: pair.playerBId === 'YOU' ? null : effectFor(pair.playerBId)
    };
    const id = String(candidate.id || candidate.matchupId || '');
    const index = existing.findIndex(m => {
      if (!m || String(m.dateKey || m.date || '') !== day) return false;
      if (id && String(m.id || m.matchupId || '') === id) return true;
      const a = String(m.playerAId || '');
      const b = String(m.playerBId || '');
      return [a, b].sort().join('|') ===
        [String(candidate.playerAId), String(candidate.playerBId)].sort().join('|')
        && String(m.matchupType || '') === String(candidate.matchupType || '');
    });
    if (index < 0) existing.push(candidate);
    else {
      const prior = existing[index];
      existing[index] = {
        ...candidate, ...prior,
        playerAEffects: prior.playerAEffects ?? candidate.playerAEffects ?? null,
        playerBEffects: prior.playerBEffects ?? candidate.playerBEffects ?? null
      };
    }
  }
  return existing;
}

test('daily matchup index reproduces the original earliest ID-or-pair matching with 6500 historical games', () => {
  const input = seed();
  const expected = expectedMatchups(input);
  const state = clone(input);
  let dateReads = 0, saves = 0, generatedSchedules = 0;
  const context = {
    state,
    console: { warn() {}, error() {} },
    Date, JSON, Math, Map, Set, String, Number, Array,
    markHomeMorningStartupPhase() {},
    getGameDayKey() { return day; },
    getMatchupDateKeyLocal(row) { dateReads++; return String(row?.dateKey || row?.date || ''); },
    getHistoryDateKey(row) { return String(row?.date || row?.dateKey || ''); },
    getYouName() { return 'You'; },
    ensureUpcomingSchedule() { generatedSchedules++; },
    computeTodayPoints() { return 12; },
    simulateAiScoreForPlayer(player, dateKey, options) {
      options?.captureEffects?.(effectFor(player.id));
      return scoreFor(player.id);
    },
    ensureOpponentDripSchedule() {},
    makeId() { throw new Error('Schedule is complete, no random IDs should be necessary'); },
    TaskPointsCore: { withGoldNpcScoringBatch(state, fn) { return fn(); } },
    save() { saves++; return true; }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(simulateSource + String.fromCharCode(10) + 'simulateToday();', context);
  assert.deepEqual(clone(state.matchups), expected,
    'all same-day replacements and insertion orders must match legacy findIndex behavior');
  assert.equal(saves, 1, 'new daily slate continues to save exactly once');
  assert.equal(generatedSchedules, 1);
  assert.ok(dateReads <= input.matchups.length * 2 + 100,
    'date lookups must scale with historic rows, not historic rows times each new game');
  assert.ok(state.gameHistory.some(g => g.id === 'existing-today' && g.effects?.npcId === 'NPC-3'),
    'existing today history receives updated effects');
  assert.equal(state.gameHistory.filter(g => g.date === day).length, 9,
    'each NPC gets exactly one today record; old records stay intact');
  assert.equal(input.gameHistory.length, 5001, 'seed was not mutated by simulation');
});

test('the one-pass matchup index does not remove season reconciliation or protected saving', () => {
  assert.ok(simulateSource.includes('const todayMatchupIds = new Map();'));
  assert.ok(simulateSource.includes('const todayMatchupPairs = new Map();'));
  assert.ok(simulateSource.includes('const existingIndex = Math.min('));
  assert.ok(simulateSource.includes('rebuildTodayMatchupIndex()'));
  assert.ok(simulateSource.includes('TaskPointsCore.dedupeSameDayGeneratedSlateState'));
  assert.ok(simulateSource.includes('TaskPointsCore.syncSeasonResultsFromDailyMatchups'));
  assert.ok(simulateSource.includes('const saved = save();'));
});
