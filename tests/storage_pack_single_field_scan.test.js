const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const stored = new Map();
global.localStorage = {
  getItem(key) { return stored.has(String(key)) ? stored.get(String(key)) : null; },
  setItem(key, value) { stored.set(String(key), String(value)); },
  removeItem(key) { stored.delete(String(key)); },
  key(index) { return Array.from(stored.keys())[index] || null; },
  get length() { return stored.size; }
};
require('../scoring_core.js');

const core = global.TaskPointsCore;
const fnv32 = str => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
};

// Golden-byte fixture from Main's unoptimized encoder (before the field-pass
// optimization). Any difference may affect browser compatibility or storage
// size, and should be investigated rather than silently accepted.
function fixture() {
  return {
    tasks: [
      { id: 't0', title: 'Morning journal', points: 1.5, tags: ['a', 'b'] },
      { id: 't1', title: 'Late night', points: 0, tags: [] }
    ],
    completions: [
      { id: 'c0', completedAtISO: '2026-11-01T12:00:00.000Z', taskId: 't0', points: 1.5, source: 'task' },
      { id: 'c1', completedAtISO: '2026-11-01T20:00:00.000Z', taskId: 't1', points: 0, source: 'task' },
      { id: 'c2', completedAtISO: '2026-10-28T12:00:00.000Z', taskId: 't0', points: 3, source: 'habit', title: 'Poêle ☕' }
    ],
    matchups: [
      { id: 'm1', date: '2026-10-28', playerAId: 'YOU', playerBId: 'P1', scoreA: 41.2, scoreB: 30.1 },
      { id: 'm2', date: '2026-11-01', playerAId: 'YOU', playerBId: 'P1', scoreA: 3, scoreB: 0, playerAScore: 3 }
    ],
    gameHistory: [{ id: 'gh1', date: '2026-10-28', playerId: 'P1', score: 30.1, matchupId: 'm1' }],
    seasonHistory: [{ id: 'S1', winnerId: 'P1' }],
    reminders: [{ id: 'r', text: 'Meet up' }]
  };
}

test('packed and compressed storage bytes match the pre-optimization encoder', () => {
  const plan = core.buildOptimizedTaskPointsStorageRaw(fixture());
  assert.equal(plan.packedRawJson.length, 858);
  assert.equal(fnv32(plan.packedRawJson), '9790cfdc');
  assert.equal(plan.chosenRaw.length, 358);
  assert.equal(fnv32(plan.chosenRaw), '31e7e13b');
  assert.equal(plan.chosenEncoding, 'lz16-packed-v1');
});

test('fixed-width packer still uses identical fields with and without a precomputed list', () => {
  const rows = [{ id: 'a', foo: 1, strange: { a: true } }, { foo: 2, extra: 'new' }, null, { id: 'c' }];
  const fields = ['id', 'foo', 'strange', 'extra'];
  assert.deepEqual(core.packObjectArray(rows, ['id', 'foo']), core.packObjectArray(rows, ['id', 'foo'], fields));
});

test('compressed save still verifies and preserves all supplied critical histories', () => {
  stored.clear();
  const state = core.normalizeState({
    ...fixture(),
    habits: [{ id: 'h', doneKeys: ['2026-10-28'], name: 'Habit' }],
    players: [{ id: 'P1', name: 'Player' }],
    weightHistory: [{ dateKey: '2026-10-28', weight: 170 }],
    vo2MaxHistory: [{ dateKey: '2026-10-28', value: 44 }]
  });
  core.saveStateSnapshot(state, { storageKey: core.STORAGE_KEY, immediateWrite: true });
  const raw = stored.get(core.STORAGE_KEY);
  assert.ok(raw, 'serialized state must be written');
  const roundTrip = core.parseTaskPointsStorageJson(raw, {});
  for (const key of ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'habits', 'players', 'weightHistory', 'vo2MaxHistory', 'reminders']) {
    assert.equal(roundTrip[key].length, state[key].length, key + ' history count');
  }
});
