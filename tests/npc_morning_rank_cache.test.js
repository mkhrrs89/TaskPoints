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
