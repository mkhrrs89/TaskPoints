const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const records = new Map();
global.localStorage = {
  getItem(key) { return records.get(String(key)) ?? null; },
  setItem(key, value) { records.set(String(key), String(value)); },
  removeItem(key) { records.delete(String(key)); },
  key(index) { return [...records.keys()][index] ?? null; },
  get length() { return records.size; }
};
require('../scoring_core.js');
const core = global.TaskPointsCore;
const MARKER = 'june2026LifetimeMatchupsV1';

function fixture(marker = true) {
  return {
    tasks: [{ id: 't1', title: 'Sticky task', points: 4, status: 'active' }],
    reminders: [{ id: 'r1', text: 'Preserve reminder' }],
    completions: [
      { id: 'c1', taskId: 't1', points: 4, completedAtISO: '2026-10-31T12:00:00.000Z', source: 'task' }
    ],
    habits: [{ id: 'h1', name: 'Repeat habit', doneKeys: [], failedKeys: [], iceKeys: [], pointsPerDay: 2 }],
    players: [{ id: 'P1', name: 'Player One' }],
    matchups: [{ id: 'm1', dateKey: '2026-10-31', playerAId: 'YOU', playerBId: 'P1', scoreA: 4, scoreB: 20 }],
    gameHistory: [{ id: 'g1', playerId: 'P1', dateKey: '2026-10-31', score: 20 }],
    weightHistory: [{ id: 'w1', dateKey: '2026-10-31', weight: 174 }],
    vo2MaxHistory: [{ id: 'v1', dateKey: '2026-10-31', value: 45 }],
    historicalRepairMarkers: marker ? { [MARKER]: true } : {}
  };
}

test('pre-normalized historical repair matches traditional normalization result', () => {
  for (const marked of [false, true]) {
    const input = core.normalizeState(fixture(marked));
    const original = core.repairConfirmedJune2026LifetimeHistory(input);
    const fast = core.repairConfirmedJune2026LifetimeHistory(input, { alreadyNormalized: true });
    assert.equal(fast.changed, original.changed);
    assert.deepEqual(fast.state, original.state);
    assert.deepEqual(fast.unresolved, original.unresolved);
    assert.equal(fast.repairedJune14Matchups, original.repairedJune14Matchups);
  }
});

test('marked already-normalized state avoids second full-state copy', () => {
  const normalized = core.normalizeState(fixture(true));
  const result = core.repairConfirmedJune2026LifetimeHistory(normalized, { alreadyNormalized: true });
  assert.equal(result.changed, false);
  assert.strictEqual(result.state, normalized);
  assert.notStrictEqual(core.repairConfirmedJune2026LifetimeHistory(normalized).state, normalized,
    'public/default repair behavior still normalizes its inputs');
});

test('journal-free load keeps all collections and runs historical repair', () => {
  records.clear();
  const loaded = core.loadAppState({
    preloadedState: fixture(false),
    syncDerived: false,
    persistSync: false
  });
  for (const key of ['tasks', 'reminders', 'completions', 'habits', 'players', 'gameHistory',
    'matchups', 'weightHistory', 'vo2MaxHistory']) {
    assert.equal(loaded.state[key].length, 1, key);
  }
  assert.equal(loaded.state.reminders[0].text, 'Preserve reminder');
});

test('pending habit journal replay stays on normalization-safe path', () => {
  records.clear();
  core.writePendingHabitDelta({
    habitId: 'h1', dayKey: '2026-10-31', source: 'habit',
    status: 'full', done: true, failed: false, icy: false, completionFraction: 1,
    completionPoints: 2, updatedAtISO: '2026-11-01T12:00:00.000Z'
  });
  const loaded = core.loadAppState({
    preloadedState: fixture(true), syncDerived: false, persistSync: false
  });
  assert.equal(loaded.pendingHabitDeltas.length, 1);
  assert.equal(loaded.state.habits[0].doneKeys.includes('2026-10-31'), true);
  assert.equal(loaded.state.completions.some(row => row.habitId === 'h1' && Number(row.points) === 2), true);
  assert.equal(core.readPendingHabitDeltas().length, 1, 'journal must not clear until durable compaction');
  records.clear();
});

test('load only reuses normalized input when pending journal is empty', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.match(source, /alreadyNormalized:\s*pendingHabitDeltas\.length\s*===\s*0/);
  assert.match(source, /const state = options\.alreadyNormalized === true \? stateInput : normalizeState\(stateInput \|\| \{\}\)/);
});
