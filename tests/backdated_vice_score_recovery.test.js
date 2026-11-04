const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../scoring_core.js');
const core = global.TaskPointsCore;
const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sources = fs.readFileSync(path.join(__dirname, '..', 'daily_sources.html'), 'utf8');

function viceCompletion(dayKey, completedAtISO, overrides = {}) {
  return {
    id: 'habit:vice3:' + dayKey,
    taskId: 'habit:vice3:' + dayKey,
    source: 'vice', habitId: 'vice3',
    title: '[Vice] Example (' + dayKey + ')',
    points: 2, completionFraction: 1, dayKey,
    completedAtISO, ...overrides
  };
}

test('a backdated vice replay uses selected day, not the time of editing', () => {
  const state = {
    habits: [{ id: 'vice3', name: 'Example', category: 'vice', pointsPerDay: 2,
      doneKeys: [], failedKeys: [], iceKeys: [] }],
    completions: []
  };
  const journal = [{
    id: 'vice:vice3:2026-11-03', habitId: 'vice3', dayKey: '2026-11-03',
    source: 'vice', status: 'full', done: true, completionFraction: 1,
    completionPoints: 2, updatedAtISO: '2026-11-04T12:31:00.000Z'
  }];
  const replay = core.applyPendingHabitDeltas(state, journal);
  assert.equal(replay.applied, 1);
  assert.equal(core.dateKey(state.completions[0].completedAtISO), '2026-11-03');
  assert.equal(state.completions[0].points, 2);
  assert.equal(state.completions[0].source, 'vice');
  assert.deepEqual(state.habits[0].doneKeys, ['2026-11-03']);
  assert.equal(journal[0].updatedAtISO, '2026-11-04T12:31:00.000Z',
    'real journal edit timestamp stays intact');
});

test('normalization repairs a previously persisted wrong-day vice without modifying the source object', () => {
  const wrong = viceCompletion('2026-11-03', '2026-11-04T12:31:00.000Z');
  const input = { completions: [wrong] };
  const normalized = core.normalizeState(input);
  assert.equal(core.dateKey(normalized.completions[0].completedAtISO), '2026-11-03');
  assert.equal(input.completions[0].completedAtISO, '2026-11-04T12:31:00.000Z');
  assert.deepEqual(core.normalizeState(normalized).completions, normalized.completions,
    'the repair is idempotent');
});

test('Habit and Vice repair is selective; unrelated sources and correct dates are untouched', () => {
  const correctVice = viceCompletion('2026-11-03', '2026-11-03T18:00:00.000Z');
  const badHabit = viceCompletion('2026-11-03', '2026-11-04T12:31:00.000Z',
    { source: 'habit', habitId: 'habit3' });
  const metric = viceCompletion('2026-11-03', '2026-11-04T12:31:00.000Z',
    { source: 'metric' });
  const invalidDay = viceCompletion('2026-11-31', '2026-11-04T12:31:00.000Z');
  const normalized = core.normalizeState({
    completions: [correctVice, badHabit, metric, invalidDay]
  }).completions;
  assert.equal(normalized[0].completedAtISO, correctVice.completedAtISO);
  assert.equal(core.dateKey(normalized[1].completedAtISO), '2026-11-03');
  assert.equal(normalized[2].completedAtISO, metric.completedAtISO);
  assert.equal(normalized[3].completedAtISO, invalidDay.completedAtISO);
});

test('two backdated Vice points move from Nov 4 to Nov 3, flipping a 0.4 loss into a 1.6 win', () => {
  const wrong = viceCompletion('2026-11-03', '2026-11-04T12:31:00.000Z');
  const other = [
    { id: 'nov3-other', source: 'task', title: 'Other sources',
      points: 47.5, completedAtISO: '2026-11-03T12:00:00.000Z' },
    { id: 'nov3-vices', source: 'vice', habitId: 'other-vice', dayKey: '2026-11-03',
      title: 'Other vices', points: 5, completedAtISO: '2026-11-03T12:00:00.000Z' }
  ];
  const input = {
    habits: [{ id: 'vice3', name: 'Example', category: 'vice',
      doneKeys: ['2026-11-03'], failedKeys: [], iceKeys: [] }],
    completions: [...other, wrong],
    matchups: [{ id: 'nov3-game', dateKey: '2026-11-03', playerAId: 'YOU',
      playerBId: 'NPC', scoreA: 52.5, scoreB: 52.9, result: 'you-loss' }]
  };
  const oldTotals = core.aggregateCompletionsByDate(input.completions, input).dailyTotals;
  assert.equal(oldTotals['2026-11-03'], 52.5);
  assert.equal(oldTotals['2026-11-04'], 2);

  const normalized = core.normalizeState(input);
  const corrected = core.aggregateCompletionsByDate(normalized.completions, normalized).dailyTotals;
  assert.equal(corrected['2026-11-03'], 54.5);
  assert.equal(corrected['2026-11-04'] || 0, 0);
  assert.equal(normalized.completions.length, input.completions.length);

  const result = core.syncYouMatchups(normalized, { normalized: true });
  assert.equal(result.changed, true);
  assert.equal(result.state.matchups[0].scoreA, 54.5);
  assert.equal(result.state.matchups[0].scoreB, 52.9);
  assert.equal(result.state.matchups[0].result, 'you-win');
});

test('Home and Daily Sources explicitly refresh the corrected scoring script', () => {
  assert.match(home, /src="scoring_core\.js\?v=20261104-backdated-vice-correction-1"/);
  assert.match(sources, /src="scoring_core\.js\?v=20261104-backdated-vice-correction-1"/);
  assert.match(sources, /TaskPointsCore\.normalizeState\(stateInput \|\| \{\}\)/);
  assert.match(home, /TaskPointsCore\.syncYouMatchups\(nextState\)/);
});
