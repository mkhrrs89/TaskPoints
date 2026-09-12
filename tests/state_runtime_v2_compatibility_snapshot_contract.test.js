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
  assert.equal(parity.expectedCounts.habits, 1);
  assert.equal(parity.expectedCounts.completions, 5);
  assert.equal(parity.actualCounts.habits, 1);
  assert.equal(parity.actualCounts.completions, 5);
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


test('parity identifies changed fields and reordered records without exposing values or repairing data', async () => {
  const initial = { habits: [baseHabit('h1', 'Read', '', 0), baseHabit('h2', 'Walk', '', 1)], completions: [] };
  const { api, localStorage, indexedDB } = install(initial);
  await api.seedFromLegacy();
  const before = JSON.stringify(indexedDB.dump(DB_NAME));
  const changed = structuredClone(initial);
  changed.habits[0].name = 'Private changed name';
  changed.habits.reverse();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(changed));
  const parity = await api.verifyParity();
  assert.equal(parity.match, false);
  assert.equal(parity.differences.collections.habits.changed, 1);
  assert.equal(parity.differences.collections.habits.moved, 2);
  const row = parity.differences.samples.find((sample) => sample.kind === 'changed');
  assert.equal(row.id, 'h1');
  assert.equal(Array.from(row.fields).join(','), 'name');
  assert.equal(JSON.stringify(parity.differences).includes('Private changed name'), false);
  assert.equal(JSON.stringify(indexedDB.dump(DB_NAME)), before);
});

test('parity diagnostics cap samples while keeping full mismatch counts', async () => {
  const initial = { habits: Array.from({ length: 40 }, (_, i) => baseHabit(`h${i}`, 'Before', '', i)), completions: [] };
  const { api, localStorage } = install(initial);
  await api.seedFromLegacy();
  initial.habits.forEach((habit) => { habit.name = 'After'; });
  localStorage.setItem(LEGACY_KEY, JSON.stringify(initial));
  const result = await api.verifyParity();
  assert.equal(result.differences.collections.habits.changed, 40);
  assert.equal(result.differences.samples.length, 20);
  assert.equal(result.differences.truncated, true);
});

test('parity ignores only the three recomputed Habit caches without changing storage or exports', async () => {
  const initial = { habits: [{ ...baseHabit('h1', 'Read', '', 0), __streak: 2, __completion: 50, __failedStreak: 0 }], completions: [] };
  const { api, localStorage, indexedDB } = install(initial);
  await api.seedFromLegacy();
  const before = JSON.stringify(indexedDB.dump(DB_NAME));
  const changed = structuredClone(initial);
  changed.habits[0].__streak = 3;
  changed.habits[0].__completion = 75;
  delete changed.habits[0].__failedStreak;
  const raw = JSON.stringify(changed);
  localStorage.setItem(LEGACY_KEY, raw);
  const result = await api.verifyParity();
  assert.equal(result.match, true);
  assert.equal(result.expectedHash, result.actualHash);
  assert.equal(result.differences, null);
  assert.equal(result.ignoredDerivedCacheDifferences.records, 1);
  assert.equal(result.ignoredDerivedCacheDifferences.fields.__failedStreak, 1);
  assert.equal(localStorage.getItem(LEGACY_KEY), raw);
  assert.equal(JSON.stringify(indexedDB.dump(DB_NAME)), before);
  assert.equal((await api.buildCompatibilitySnapshot()).habits[0].__streak, 2);
});

test('Habit timestamps, unknown double-underscore fields and every completion field remain strict', async () => {
  const initial = { habits: [{ ...baseHabit('h1', 'Read', '', 0), updatedAtISO: '2026-09-12T12:00:00.000Z' }], completions: [{ id: 'c1', points: 4, __streak: 1 }] };
  const { api, localStorage } = install(initial);
  await api.seedFromLegacy();
  initial.habits[0].updatedAtISO = '2026-09-12T12:00:01.000Z';
  initial.habits[0].__other = 7;
  initial.completions[0].__streak = 2;
  localStorage.setItem(LEGACY_KEY, JSON.stringify(initial));
  const result = await api.verifyParity();
  assert.equal(result.match, false);
  const habit = result.differences.samples.find((row) => row.collection === 'habits');
  assert.equal(habit.fields.includes('updatedAtISO'), true);
  assert.equal(habit.fields.includes('__other'), true);
  const timestamp = habit.fieldDetails.find((row) => row.field === 'updatedAtISO');
  assert.equal(timestamp.expected.value, '2026-09-12T12:00:01.000Z');
  assert.equal(timestamp.actual.value, '2026-09-12T12:00:00.000Z');
  assert.equal(result.differences.collections.completions.changed, 1);
});

test('forty-six Habit mismatches cannot crowd four completion mismatches out of the report', async () => {
  const initial = {
    habits: Array.from({ length: 46 }, (_, i) => ({ ...baseHabit(`h${i}`, 'Read', '', i), __streak: 0, updatedAtISO: 'before' })),
    completions: Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, points: 4, title: 'Private original title' }))
  };
  const { api, localStorage } = install(initial);
  await api.seedFromLegacy();
  for (const habit of initial.habits) { habit.__streak = 1; habit.updatedAtISO = 'after'; }
  for (const completion of initial.completions) { completion.points = 8; completion.title = 'Private changed title'; }
  localStorage.setItem(LEGACY_KEY, JSON.stringify(initial));
  const result = await api.verifyParity();
  assert.equal(result.match, false);
  assert.equal(result.ignoredDerivedCacheDifferences.records, 46);
  assert.equal(result.differences.sampleCounts.habits, 20);
  assert.equal(result.differences.sampleCounts.completions, 4);
  assert.equal(result.differences.samples.length, 24);
  assert.equal(result.differences.sampleLimitPerCollection, 20);
  assert.equal(result.differences.truncated, true);
  const completion = result.differences.samples.find((row) => row.collection === 'completions');
  assert.equal(completion.fieldDetails.find((row) => row.field === 'points').expected.value, 8);
  assert.equal(completion.fieldDetails.find((row) => row.field === 'points').actual.value, 4);
  assert.equal(JSON.stringify(result).includes('Private'), false);
});
