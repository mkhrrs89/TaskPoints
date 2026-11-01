const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: key => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: key => storage.delete(String(key)),
  key: index => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};
require('../scoring_core.js');
const core = global.TaskPointsCore;
const KEY = core.STORAGE_KEY;

function baseState() {
  return core.normalizeState({
    tasks: [{ id: 't1', title: 'Task one', points: 2, status: 'active' }],
    completions: [{ id: 'c1', taskId: 't1', points: 2, completedAtISO: '2026-10-31T12:00:00Z' }],
    gameHistory: [{ id: 'gh1', playerId: 'p1', score: 25 }],
    matchups: [{ id: 'm1', playerAId: 'YOU', playerBId: 'p1', scoreA: 2, scoreB: 25 }],
    reminders: [{ id: 'r1', text: 'Do not drop this reminder' }],
    weightHistory: [{ id: 'w1', dateKey: '2026-10-31', weight: 178 }],
    vo2MaxHistory: [{ id: 'v1', dateKey: '2026-10-31', value: 43 }],
    liveDiffHistory: { '2026-10-31': [{ value: 1 }] },
    players: [{ id: 'p1', name: 'Opponent' }]
  });
}

function seed(state = baseState()) {
  storage.clear();
  core.saveStateSnapshot(state, { immediateWrite: true });
  return state;
}

function read() {
  return core.parseTaskPointsStorageJson(storage.get(KEY), {});
}

test('merge-save protects all historical collections while reusing the exact current decode', () => {
  seed();
  const result = core.mergeAndSaveState({
    tasks: [{ id: 't2', title: 'Task two', points: 3 }],
    reminders: [],
    weightHistory: [],
    vo2MaxHistory: [],
    liveDiffHistory: {}
  }, { immediateWrite: true });
  assert.equal(result.skipped, undefined);
  const saved = read();
  assert.equal(saved.tasks.length, 2);
  for (const key of ['completions', 'gameHistory', 'matchups', 'reminders', 'weightHistory', 'vo2MaxHistory']) {
    assert.equal(saved[key].length, 1, key);
  }
  assert.ok(Object.keys(saved.liveDiffHistory).length > 0);
});

test('merge-save avoids a duplicate decompression/parse of an unchanged stored snapshot', () => {
  seed();
  const originalParse = JSON.parse;
  let count = 0;
  JSON.parse = function countedParse(...args) {
    count++;
    return originalParse.apply(this, args);
  };
  try {
    core.mergeAndSaveState({ tasks: [{ id: 't2', title: 'New task', points: 3 }] }, { immediateWrite: true });
    // 2 JSON.parse calls to decode the existing compressed snapshot, then
    // 2 for mandatory saved-byte readback verification. No extra sticky decode.
    assert.equal(count, 4);
  } finally {
    JSON.parse = originalParse;
  }
});

test('a competing storage update invalidates reuse and protects latest previously-empty histories', () => {
  const initial = baseState();
  // The existing sticky-field contract restores a newly populated domain
  // when an older page submits an empty one. It does not attempt to merge
  // two independently appended history arrays.
  initial.weightHistory = [];
  initial.vo2MaxHistory = [];
  initial.liveDiffHistory = {};
  seed(initial);
  const updatedSource = structuredClone(initial);
  updatedSource.reminders.push({ id: 'r2', text: 'Added by another tab' });
  updatedSource.weightHistory.push({ id: 'w2', dateKey: '2026-11-01', weight: 177 });
  updatedSource.vo2MaxHistory.push({ id: 'v2', dateKey: '2026-11-01', value: 44 });
  updatedSource.liveDiffHistory = { '2026-11-01': [{ value: 99 }] };
  const competingRaw = core.buildOptimizedTaskPointsStorageRaw(updatedSource).chosenRaw;
  const originalRead = global.localStorage.getItem;
  let reads = 0;
  global.localStorage.getItem = function concurrentRead(key) {
    if (String(key) === KEY && ++reads === 3) {
      // The first read was mergeState, the second the save preflight,
      // and the third is the sticky-field authority check.
      storage.set(KEY, competingRaw);
    }
    return originalRead.call(this, key);
  };
  try {
    core.mergeAndSaveState({
      tasks: [{ id: 't2', title: 'New task' }],
      reminders: [],
      weightHistory: [],
      vo2MaxHistory: [],
      liveDiffHistory: {}
    }, { immediateWrite: true });
  } finally {
    global.localStorage.getItem = originalRead;
  }
  assert.ok(reads >= 3, 'competing write was injected during authority check');
  const persisted = read();
  assert.ok(persisted.reminders.some(row => row.id === 'r2'), 'latest reminder preserved');
  assert.ok(persisted.weightHistory.some(row => row.id === 'w2'), 'latest weight history preserved');
  assert.ok(persisted.vo2MaxHistory.some(row => row.id === 'v2'), 'latest VO2 history preserved');
  assert.ok(persisted.liveDiffHistory['2026-11-01'], 'latest live diff preserved');
});

test('direct snapshot saves retain their existing safe readback path', () => {
  seed();
  const state = baseState();
  state.tasks[0].title = 'Updated via direct snapshot';
  core.saveStateSnapshot(state, { immediateWrite: true });
  const saved = read();
  assert.equal(saved.tasks[0].title, 'Updated via direct snapshot');
  assert.equal(saved.weightHistory.length, 1);
  assert.equal(saved.vo2MaxHistory.length, 1);
});

test('a supplied stale raw or existing object cannot bypass the fresh storage authority check', () => {
  seed();
  const staleRaw = storage.get(KEY);
  const newer = baseState();
  newer.reminders.push({ id: 'r-new', text: 'Must survive stale source' });
  storage.set(KEY, core.buildOptimizedTaskPointsStorageRaw(newer).chosenRaw);
  core.mergeAndSaveState({ reminders: [] }, { raw: staleRaw, immediateWrite: true });
  assert.ok(read().reminders.some(r => r.id === 'r-new'));

  storage.set(KEY, core.buildOptimizedTaskPointsStorageRaw(newer).chosenRaw);
  core.mergeAndSaveState({ reminders: [] }, { existing: baseState(), immediateWrite: true });
  assert.ok(read().reminders.some(r => r.id === 'r-new'));
});
