const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'habit_completion_source_guard.js'), 'utf8');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function install(previous) {
  let saved = null;
  let persisted = clone(previous);
  let storedReads = 0;
  let generation = 1;
  const listeners = new Map();
  const context = {
    console,
    JSON,
    Date,
    Set,
    Map,
    Number,
    structuredClone: clone,
    addEventListener(name, callback) { listeners.set(name, callback); },
    localStorage: {
      getItem(key) {
        if (String(key) === 'taskpoints_v1') return JSON.stringify(persisted);
        if (String(key) === 'taskpoints_pending_habit_deltas_v1') return '[]';
        if (String(key) === 'taskpoints_state_revision_v1') return String(generation);
        return null;
      }
    },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      PENDING_HABIT_DELTAS_KEY: 'taskpoints_pending_habit_deltas_v1',
      getStateHotCacheStatus() { return { generation }; },
      loadAppState() { return { state: clone(persisted), pendingHabitDeltas: [] }; },
      readTaskPointsStoredState(key, fallback) {
        if (key !== 'taskpoints_v1') return fallback;
        storedReads += 1;
        return clone(persisted);
      },
      saveStateSnapshot(state, options) {
        persisted = clone(state);
        generation += 1;
        saved = { state: clone(state), options: clone(options || {}) };
        return { state };
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_completion_source_guard.js' });
  return {
    core: context.TaskPointsCore,
    getSaved: () => saved,
    getStoredReads: () => storedReads,
    bumpGeneration() { generation += 1; },
    emit(name, detail = {}) { listeners.get(name)?.({ key: detail.key, detail }); }
  };
}

test('new completion normalizes source and restores done status without rewriting history', () => {
  const previous = {
    habits: [
      { id: 'vice-1', category: 'vice', doneKeys: [], failedKeys: ['2026-08-03'], iceKeys: [] },
      { id: 'habit-2', category: 'habit', doneKeys: ['2026-08-01'], failedKeys: [], iceKeys: [] }
    ],
    completions: [
      { id: 'existing', source: 'habit', habitId: 'vice-1', dayKey: '2025-12-07', points: 3 }
    ]
  };
  const { core, getSaved } = install(previous);
  const next = clone(previous);
  next.completions.push({
    id: 'new-row', source: 'habit', viceId: 'vice-1', dayKey: '2026-08-03', points: 3
  });

  core.saveStateSnapshot(next, { savePath: 'habit-toggle' });
  const saved = getSaved().state;

  assert.equal(saved.completions[0].source, 'habit', 'existing historical source is untouched');
  assert.equal(saved.completions[1].source, 'vice');
  assert.equal(saved.completions[1].habitId, 'vice-1');
  assert.deepEqual(Array.from(saved.habits[0].doneKeys), ['2026-08-03']);
  assert.deepEqual(Array.from(saved.habits[0].failedKeys), []);
  assert.deepEqual(saved.habits[1], previous.habits[1], 'unrelated habit is untouched');
});

test('guard does not mass-normalize when more than one row is added', () => {
  const previous = {
    habits: [{ id: 'vice-1', category: 'vice', doneKeys: [], failedKeys: [], iceKeys: [] }],
    completions: []
  };
  const { core, getSaved } = install(previous);
  const next = clone(previous);
  next.completions.push(
    { id: 'a', source: 'habit', habitId: 'vice-1', dayKey: '2026-08-03', points: 3 },
    { id: 'b', source: 'habit', habitId: 'vice-1', dayKey: '2026-08-02', points: 3 }
  );

  core.saveStateSnapshot(next, {});
  const saved = getSaved().state;
  assert.equal(saved.completions[0].source, 'habit');
  assert.deepEqual(saved.habits[0].doneKeys, []);
});


test('loaded completion tracker skips the full previous-state read for saves that cannot add one completion', () => {
  const previous = {
    tasks: [{ id: 't1', title: 'One' }],
    habits: [{ id: 'habit-1', category: 'habit', doneKeys: [], failedKeys: [] }],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  const next = clone(previous);
  next.tasks[0].title = 'Renamed';

  harness.core.saveStateSnapshot(next, { savePath: 'task-edit' });

  assert.equal(harness.getStoredReads(), 0);
  const status = harness.core.getHabitCompletionSourceGuardStatus();
  assert.equal(status.countFastSkips, 1);
  assert.equal(status.fullPreviousStateReads, 0);
});

test('loaded completion tracker skips the full previous-state read for one clearly non-habit completion', () => {
  const previous = {
    tasks: [{ id: 't1' }, { id: 't2' }],
    habits: [],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  const next = clone(previous);
  next.completions.push({ id: 'new-task-completion', source: 'task', taskId: 't2', points: 2 });

  harness.core.saveStateSnapshot(next, { savePath: 'task-complete' });

  assert.equal(harness.getStoredReads(), 0);
  assert.deepEqual(harness.getSaved().state.completions, next.completions);
  const status = harness.core.getHabitCompletionSourceGuardStatus();
  assert.equal(status.nonHabitAddFastSkips, 1);
  assert.equal(status.fullPreviousStateReads, 0);
});

test('possible habit completion still performs the full previous-state read and preserves correction behavior', () => {
  const previous = {
    habits: [{ id: 'vice-1', category: 'vice', doneKeys: [], failedKeys: ['2026-08-03'], iceKeys: [] }],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  const next = clone(previous);
  next.completions.push({ id: 'new-habit', source: 'habit', viceId: 'vice-1', dayKey: '2026-08-03', points: 3 });

  harness.core.saveStateSnapshot(next, { savePath: 'habit-toggle' });

  assert.equal(harness.getStoredReads(), 1);
  assert.equal(harness.getSaved().state.completions[1].source, 'vice');
  assert.equal(harness.getSaved().state.completions[1].habitId, 'vice-1');
  assert.deepEqual(Array.from(harness.getSaved().state.habits[0].doneKeys), ['2026-08-03']);
  const status = harness.core.getHabitCompletionSourceGuardStatus();
  assert.equal(status.fullPreviousStateReads, 1);
});

test('stale completion tracker fails closed to the existing full-read guard', () => {
  const previous = {
    tasks: [{ id: 't1' }],
    habits: [],
    completions: [{ id: 'existing', source: 'task', taskId: 't1', points: 1 }]
  };
  const harness = install(previous);
  harness.core.loadAppState();
  harness.bumpGeneration();
  const next = clone(previous);
  next.tasks.push({ id: 't2' });

  harness.core.saveStateSnapshot(next, { savePath: 'task-create' });

  assert.equal(harness.getStoredReads(), 1,
    'uncertain/stale tracking must use the original full previous-state check');
  assert.equal(harness.core.getHabitCompletionSourceGuardStatus().fullPreviousStateReads, 1);
});
