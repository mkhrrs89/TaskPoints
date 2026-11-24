const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;

const makePlayer = (id, baseline, poise) => ({
  id, name: id, active: true, baseline, variance: 13, varianceTilt: 50,
  momentum: 45, risky: 40, poise, intimidation: 78, streaky: 80, greed: 25
});
function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
function seedState() {
  const players = [
    makePlayer('A', 42, 100), makePlayer('B', 57, 55), makePlayer('C', 63, 100)
  ];
  const matchups = [], gameHistory = [];
  for (let i = 0; i < 360; i++) {
    const a = players[i % 3], b = players[(i + 1) % 3];
    const day = '2026-11-' + String(i % 11 + 1).padStart(2, '0');
    matchups.push({
      id: 'm-' + i, dateKey: day, playerAId: a.id, playerBId: b.id,
      scoreA: a.baseline + i % 6, scoreB: b.baseline + i % 4
    });
    gameHistory.push({
      id: 'g-' + i, date: day, playerId: a.id, score: a.baseline + i % 6
    });
  }
  return { players, matchups, gameHistory, youName: 'You', completions: [] };
}

test('precomputed daily rankings retain identical scores, effects and RNG calls', () => {
  const state = seedState();
  const rankMap = new Map(core.computeCanonicalRankings(state)
    .map(row => [row.playerId, row]));
  const originalRandom = Math.random;
  try {
    for (let seed = 1; seed <= 25; seed++) {
      for (const scored of state.players) {
        for (const opponent of state.players) {
          if (scored.id === opponent.id) continue;
          const calculate = cached => {
            const rand = seededRandom(seed);
            let count = 0, effects = null;
            Math.random = () => { count++; return rand(); };
            const score = core.simulateAiScoreForPlayerCore(scored, '2026-11-13', {
              state,
              context: {
                opponent,
                ...(cached ? { canonicalRanksByPlayerId: rankMap } : {}),
                captureEffects(value) { effects = value; }
              }
            });
            return { score, effects, count };
          };
          assert.deepEqual(calculate(true), calculate(false),
            'standings cache must not alter score, telemetry or RNG');
        }
      }
    }
  } finally {
    Math.random = originalRandom;
  }
});

test('today history appended during scoring does not change historical standings', () => {
  const state = seedState();
  const ranks = core.computeCanonicalRankings(state);
  state.gameHistory.push({ date: '2026-11-13', playerId: 'A', score: 74 });
  assert.deepEqual(core.computeCanonicalRankings(state), ranks);
  const source = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /context\.canonicalRanksByPlayerId instanceof Map/);
  assert.match(home, /canonicalRanksByPlayerId,/);
  assert.match(home, /TaskPointsCore\.withGoldNpcScoringBatch\(state, scoreNpcParticipants\)/);
  assert.match(home, /const saved = save\(\)/);
});

test('preindexed morning rankings exactly match established rankings for 120 players', () => {
  const state = seedState();
  const players = Array.from({ length: 120 }, (_, i) => makePlayer('NPC-' + i, 40 + i / 10, i % 100));
  players.push({ id: 'inactive', name: 'Inactive', active: false, baseline: 50 });
  state.players = players;
  state.matchups = [];
  const rng = seededRandom(8361);
  for (let i = 0; i < 6300; i++) {
    const ai = Math.floor(rng() * players.length);
    const bi = Math.floor(rng() * players.length);
    const a = players[ai].id;
    const b = i % 41 === 0 ? a : players[bi].id;
    const day = '2026-' + String(i % 12 + 1).padStart(2, '0') + '-' + String(i % 27 + 1).padStart(2, '0');
    const scoreA = i % 19 === 0 ? null : i % 23 === 0 ? '51' : Math.round(rng() * 100) / 10;
    const scoreB = i % 31 === 0 ? null : i % 37 === 0 ? '52' : Math.round(rng() * 100) / 10;
    state.matchups.push({
      id: 'rank-' + i,
      dateKey: i % 101 === 0 ? new Date().toISOString().slice(0, 10) : day,
      playerAId: i % 89 === 0 ? 'YOU' : a,
      playerBId: i % 97 === 0 ? 'YOU' : b,
      scoreA, scoreB
    });
  }
  // Scored ties, incomplete matches, inactive players and same-side IDs
  // must preserve every decimal, rank and tie-break identically.
  for (const includeToday of [false, true]) {
    const expected = core.computeCanonicalRankings(state, { includeToday });
    const actual = core.computeCanonicalRankings(state, { includeToday, preindexed: true });
    assert.deepEqual(actual, expected);
    const every = actual.map(row => row.playerId);
    assert.equal(every.includes('inactive'), false);
    assert.equal(every.includes('YOU'), true);
  }
});

test('preindexed daily ranks are reused without altering scores or effect telemetry', () => {
  const state = seedState();
  const oldMap = new Map(core.computeCanonicalRankings(state).map(row => [row.playerId, row]));
  const newMap = new Map(core.computeCanonicalRankings(state, { preindexed: true })
    .map(row => [row.playerId, row]));
  assert.deepEqual([...newMap], [...oldMap]);
  const original = Math.random;
  try {
    for (let seed = 1; seed < 20; seed++) {
      const score = ranks => {
        Math.random = seededRandom(seed);
        let captured = null;
        const result = core.simulateAiScoreForPlayerCore(state.players[0], '2026-11-13', {
          state,
          context: {
            opponent: state.players[2],
            canonicalRanksByPlayerId: ranks,
            captureEffects(effects) { captured = effects; }
          }
        });
        return { result, captured };
      };
      assert.deepEqual(score(newMap), score(oldMap));
    }
  } finally {
    Math.random = original;
  }
  const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(home, /computeCanonicalRankings\(state, \{ preindexed: true \}\)/);
});

test('NPC morning history inputs exactly reproduce legacy momentum and streak outcomes', () => {
  const players = Array.from({ length: 120 }, (_, i) => makePlayer('NPC-' + i, 40 + (i % 20), 50 + i % 50));
  const state = { players, gameHistory: [], matchups: [] };
  const rng = seededRandom(16316);
  for (let i = 0; i < 12500; i++) {
    const p = players[Math.floor(rng() * players.length)];
    const day = '2026-' + String(i % 12 + 1).padStart(2, '0') + '-' + String(i % 27 + 1).padStart(2, '0');
    state.gameHistory.push({ playerId: p.id, date: day, score: (rng() * 90).toFixed(1) });
  }
  for (let i = 0; i < 6100; i++) {
    const a = players[Math.floor(rng() * players.length)].id;
    const b = i % 29 === 0 ? a : players[Math.floor(rng() * players.length)].id;
    const day = '2026-' + String(i % 12 + 1).padStart(2, '0') + '-' + String(i % 27 + 1).padStart(2, '0');
    state.matchups.push({ playerAId: a, playerBId: b, dateKey: day,
      gameNumber: i % 7, scoreA: i % 31 === 0 ? null : Number((rng() * 90).toFixed(1)),
      scoreB: i % 37 === 0 ? null : Number((rng() * 90).toFixed(1)),
      ...(i % 41 === 0 ? { result: 'pending' } : {})
    });
  }
  const ids = players.map(p => p.id);
  for (const dateKey of ['2026-11-14', '2026-10-12', '2026-07-10']) {
    const inputs = core.buildNpcMorningScoringInputs(state, ids, dateKey);
    assert.equal(inputs.npcStreakByPlayerId.size, ids.length);
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      assert.equal(inputs.npcStreakByPlayerId.get(player.id),
        core.computeNpcWinLossStreak(state, player.id, dateKey), 'streak for ' + player.id);
      const prior = state.gameHistory.filter(row => row.playerId === player.id)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      assert.deepEqual(inputs.npcLatestHistoryByPlayerId.get(player.id), prior);
    }
    const originalRandom = Math.random;
    try {
      for (const p of players) {
        const opponent = players[(ids.indexOf(p.id) + 3) % players.length];
        const calculate = useCache => {
          let effects = null, calls = 0;
          const next = seededRandom(9163);
          Math.random = () => { calls++; return next(); };
          const result = core.simulateAiScoreForPlayerCore(p, dateKey, {
            state,
            context: {
              opponent,
              ...(useCache ? inputs : {}),
              captureEffects(value) { effects = value; }
            }
          });
          return { result, effects, calls };
        };
        assert.deepEqual(calculate(true), calculate(false),
          'scores, all modifiers and random draws must match for ' + p.id);
      }
    } finally { Math.random = originalRandom; }
  }
});

test('morning scoring inputs ignore same-day incomplete rows without mutating saved history', () => {
  const state = seedState();
  const before = JSON.stringify(state);
  const inputs = core.buildNpcMorningScoringInputs(state, ['A', 'B', 'C'], '2026-11-13');
  assert.equal(JSON.stringify(state), before, 'cache building is read-only');
  assert.equal(inputs.npcStreakByPlayerId.get('A'),
    core.computeNpcWinLossStreak(state, 'A', '2026-11-13'));
  state.gameHistory.push({ playerId: 'B', date: '2026-11-13', score: 44 });
  assert.deepEqual(inputs.npcLatestHistoryByPlayerId.get('A'),
    state.gameHistory.filter(x => x.playerId === 'A').sort((a,b) => b.date.localeCompare(a.date))[0]);
});
