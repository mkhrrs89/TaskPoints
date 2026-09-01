const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage } = require('./helpers/fake_indexeddb_v2');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const DB_NAME = 'taskpoints_state_v2';
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';

function install(legacyState) {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState)
  });
  let uuid = 0;
  const core = {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(delta) { return { ...delta }; }
  };
  const context = {
    indexedDB,
    localStorage,
    structuredClone,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Promise,
    console: { warn() {}, log() {}, error() {} },
    crypto: { randomUUID() { uuid += 1; return `compat-${uuid}`; } },
    TaskPointsCore: core,
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return { api: context.TaskPointsStateRuntimeV2, indexedDB, localStorage };
}

function baseHabit(id, name, group, order) {
  return {
    id,
    name,
    group,
    order,
    pointsPerDay: 4,
    doneKeys: [],
    failedKeys: [],
    iceKeys: []
  };
}

test('V2-16 compatibility snapshot preserves exact legacy habit array order and stable habit shape', async () => {
  const legacy = {
    profile: { name: 'You' },
    settings: { habitSort: 'manual' },
    habits: [
      baseHabit('h-z', 'Last group first', 'zeta', 40),
      baseHabit('h-a2', 'Alpha second', 'alpha', 20),
      baseHabit('h-a1', 'Alpha first', 'alpha', 10),
      baseHabit('h-m', 'Middle', 'middle', 30)
    ],
    completions: [],
    tasks: [{ id: 't1', title: 'Unrelated state must remain' }]
  };
  const app = install(legacy);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.habits, legacy.habits);
  assert.deepEqual(snapshot.tasks, legacy.tasks);
  assert.deepEqual(snapshot.profile, legacy.profile);
  assert.deepEqual(snapshot.settings, legacy.settings);
  assert.deepEqual(snapshot.habits.map((habit) => habit.id), ['h-z', 'h-a2', 'h-a1', 'h-m']);

  const storedHabitRows = app.indexedDB.dump(DB_NAME).habits;
  assert.equal(storedHabitRows.length, legacy.habits.length);
  assert.deepEqual(
    storedHabitRows.slice().sort((a, b) => a.legacyIndex - b.legacyIndex).map((row) => row.value.id),
    legacy.habits.map((habit) => habit.id)
  );
});

test('V2-17 compatibility snapshot preserves completion order, duplicate IDs, differing duplicate payloads, and id-less rows exactly', async () => {
  const duplicateFirst = {
    id: 'duplicate-id',
    title: 'first duplicate',
    source: 'habit',
    habitId: 'h1',
    dayKey: '2026-08-30',
    points: 4,
    completedAtISO: '2026-08-30T09:00:00.000Z'
  };
  const duplicateSecond = {
    id: 'duplicate-id',
    title: 'second duplicate with different payload',
    source: 'habit',
    habitId: 'h1',
    dayKey: '2026-08-30',
    points: 99,
    completedAtISO: '2026-08-30T09:05:00.000Z'
  };
  const idless = {
    title: 'legacy malformed row without id',
    source: 'manual',
    points: 3,
    completedAtISO: '2026-08-29T10:00:00.000Z'
  };
  const legacy = {
    habits: [baseHabit('h1', 'Read', 'default', 1)],
    completions: [
      duplicateFirst,
      { id: 'unique-middle', title: 'middle', source: 'task', points: 2, completedAtISO: '2026-08-30T08:00:00.000Z' },
      duplicateSecond,
      idless,
      { id: 'unique-last', title: 'last', source: 'task', points: 1, completedAtISO: '2026-08-28T08:00:00.000Z' }
    ]
  };
  const app = install(legacy);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.completions, legacy.completions);
  assert.equal(snapshot.completions.length, 5);
  assert.equal(snapshot.completions.filter((row) => row.id === 'duplicate-id').length, 2);
  assert.equal(snapshot.completions[0].points, 4);
  assert.equal(snapshot.completions[2].points, 99);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.completions[3], 'id'), false);

  const storedRows = app.indexedDB.dump(DB_NAME).completions;
  const duplicateStorageRow = storedRows.find((row) => row.id === 'duplicate-id');
  assert.equal(Array.isArray(duplicateStorageRow.entries), true);
  assert.equal(duplicateStorageRow.entries.length, 2);
  assert.equal(app.api.getStatus().schemaVersion, 2);

  const parity = await app.api.verifyParity();
  assert.equal(parity.match, true);
  assert.deepEqual(parity.expectedCounts, { habits: 1, completions: 5 });
  assert.deepEqual(parity.actualCounts, { habits: 1, completions: 5 });
});

test('V2-17 a new V2 habit completion sorts ahead of preserved unrelated duplicate legacy rows', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Read', 'default', 1)],
    completions: [
      { id: 'dup', title: 'duplicate A', source: 'task', points: 1, completedAtISO: '2026-08-20T08:00:00.000Z' },
      { id: 'dup', title: 'duplicate B', source: 'task', points: 2, completedAtISO: '2026-08-19T08:00:00.000Z' },
      { id: 'tail', title: 'tail', source: 'task', points: 3, completedAtISO: '2026-08-18T08:00:00.000Z' }
    ]
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();

  const result = await app.api.applyHabitDelta({
    id: 'habit:h1:2026-09-01',
    habitId: 'h1',
    dayKey: '2026-09-01',
    source: 'habit',
    status: 'full',
    done: true,
    updatedAtISO: '2026-09-01T12:00:00.000Z'
  });
  assert.equal(result.committed, true);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.equal(snapshot.completions[0].id, 'habit:h1:2026-09-01');
  assert.deepEqual(snapshot.completions.slice(1), legacy.completions);
  assert.equal(snapshot.completions.filter((row) => row.id === 'dup').length, 2);
});
