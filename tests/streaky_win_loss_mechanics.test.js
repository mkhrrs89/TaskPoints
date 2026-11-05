const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;
const settings = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

function matchup(dateKey, playerAId, playerBId, scoreA, scoreB, extras = {}) {
  return { dateKey, playerAId, playerBId, scoreA, scoreB, ...extras };
}
function player(id, streaky = 100, baseline = 50) {
  return { id, streaky, baseline, variance: 0, varianceTilt: 50, momentum: 0, risky: 0, intimidation: 0, poise: 0 };
}

test('zero/missing/invalid Streaky values migrate to 50; nonzero ratings survive', () => {
  const state = core.normalizeState({ players: [
    { id: 'old' }, { id: 'zero', streaky: 0 }, { id: 'invalid', streaky: 'NA' },
    { id: 'negative', streaky: -10 }, { id: 'one', streaky: 1 },
    { id: 'average', streaky: 50 }, { id: 'fractional', streaky: 67.5 },
    { id: 'high', streaky: 120 }
  ] });
  assert.deepEqual(state.players.map(p => p.streaky), [50, 50, 50, 1, 1, 50, 67.5, 100]);
  assert.equal(state.players[1].greed, 0, 'Greed stays separate');
});

test('win and loss streaks are symmetric, rating-scaled, start at two and cap their effect at ten', () => {
  assert.equal(core.computeStreakyEffect(player('P'), 0).bonus, 0);
  assert.equal(core.computeStreakyEffect(player('P'), 1).bonus, 0);
  assert.equal(core.computeStreakyEffect(player('P'), -1).bonus, 0);
  assert.equal(core.computeStreakyEffect(player('P'), 2).bonus, 1.2);
  assert.equal(core.computeStreakyEffect(player('P'), 5).bonus, 3);
  assert.equal(core.computeStreakyEffect(player('P'), 10).bonus, 6);
  assert.equal(core.computeStreakyEffect(player('P'), 19).bonus, 6);
  assert.equal(core.computeStreakyEffect(player('P'), 19).streak, 19, 'streak keeps its true length');
  assert.equal(core.computeStreakyEffect(player('P'), -2).bonus, -1.2);
  assert.equal(core.computeStreakyEffect(player('P'), -10).bonus, -6);
  assert.equal(core.computeStreakyEffect(player('P', 50), 10).bonus, 3);
  assert.equal(core.computeStreakyEffect(player('P', 1), 10).bonus, 0.06);
  assert.equal(core.computeStreakyEffect(player('P', 0), 10).bonus, 3);
});

test('season resets on Nov 1 and prior October tournament results do not carry', () => {
  const state = { matchups: [
    matchup('2026-10-29', 'P', 'Q', 100, 1, { matchupType: 'tournament' }),
    matchup('2026-10-31', 'P', 'YOU', 10, 0, { matchupType: 'tournament' }),
    matchup('2026-11-01', 'P', 'Q', 2, 1),
    matchup('2026-11-02', 'P', 'YOU', 4, 1)
  ] };
  assert.equal(core.getStreakySeasonStart('2026-11-01'), '2026-11-01');
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-01'), 2);
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-02'), 1);
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-03'), 2);
  assert.equal(core.computeNpcWinLossStreak(state, 'YOU', '2026-11-03'), 0);
  assert.equal(core.getStreakySeasonStart('2026-09-01'), '2026-09-01');
  assert.equal(core.getStreakySeasonStart('2026-08-01'), '2026-07-01');
});

test('ties reset streaks, a loss flips its sign, and missing days do not break streaks', () => {
  const state = { matchups: [
    matchup('2026-11-01', 'P', 'YOU', 5, 0),
    matchup('2026-11-04', 'P', 'Q', 4, 1),
    matchup('2026-11-07', 'P', 'Q', 2, 2),
    matchup('2026-11-08', 'Q', 'P', 8, 4),
    matchup('2026-11-10', 'P', 'Q', 1, 6)
  ] };
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-07'), 2);
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-08'), 0);
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-10'), -1);
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-11'), -2);
});

test('pending and malformed scores do not count; scores determine winners not point margins', () => {
  const state = { matchups: [
    matchup('2026-11-01', 'P', 'Q', 1, 0),
    matchup('2026-11-02', 'P', 'Q', null, 0),
    matchup('2026-11-03', 'P', 'Q', 100, 0, { completed: false }),
    matchup('2026-11-04', 'P', 'Q', 100, 0, { result: 'pending' }),
    matchup('2026-11-05', 'P', 'Q', 'invalid', 0),
    matchup('2026-11-06', 'P', 'Q', 1.1, 1.0)
  ] };
  assert.equal(core.computeNpcWinLossStreak(state, 'P', '2026-11-07'), 2);
});

test('a real NPC score gets the additive modifier against YOU, without changing YOUR score', () => {
  const state = { matchups: [
    matchup('2026-11-01', 'P', 'YOU', 5, 4),
    matchup('2026-11-02', 'P', 'YOU', 3, 2)
  ] };
  let effects = null;
  const score = core.simulateAiScoreForPlayerCore(player('P'), '2026-11-03', {
    state, context: { captureEffects(e) { effects = e; } }
  });
  assert.equal(score, core.softCurbNpcScore(51.2));
  assert.equal(effects.streakyBonus, 1.2);
  assert.equal(effects.streakyStreak, 2);
  assert.equal(effects.streakySeasonStart, '2026-11-01');
  assert.equal(effects.intimidationApplied, false);
  assert.equal(state.matchups[0].scoreB, 4, 'human score not modified');
  assert.equal(state.matchups[1].scoreB, 2);
});

test('NPC-vs-NPC scores also use Streaky, and losses produce penalties', () => {
  const state = { matchups: [
    matchup('2026-11-01', 'P', 'Q', 1, 2),
    matchup('2026-11-02', 'P', 'Q', 1, 2)
  ] };
  let effects;
  const score = core.simulateAiScoreForPlayerCore(player('P'), '2026-11-03', {
    state, context: { opponent: player('Q', 50, 40), captureEffects(e) { effects = e; } }
  });
  assert.equal(score, core.softCurbNpcScore(48.8));
  assert.equal(effects.streakyBonus, -1.2);
  assert.equal(effects.streakyStreak, -2);
});

test('season streak length remains accurate past ten victories', () => {
  const matchups = Array.from({ length: 15 }, (_, i) =>
    matchup('2026-11-' + String(i + 1).padStart(2, '0'), 'P', 'Q', 1, 0)
  );
  const wins = core.computeNpcWinLossStreak({ matchups }, 'P', '2026-11-17');
  assert.equal(wins, 15);
  assert.equal(core.computeStreakyEffect(player('P'), wins).bonus, 6);
});

test('Settings multi-day NPC simulation updates streaks after both players finish their game', () => {
  assert.match(settings, /winLossStreakByPlayer\.set\(player\.id, outcome/);
  assert.match(settings, /computeStreakyEffect\(player, context\.winLossStreak/);
  assert.match(settings, /winLossStreak: winLossStreakByPlayer\.get\(player\.id\)/);
  assert.match(settings, /const outcome = Math\.sign\(a - b\)/);
});
