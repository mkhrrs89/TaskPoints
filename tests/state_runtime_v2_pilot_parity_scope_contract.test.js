const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage, clone } = require('./helpers/fake_indexeddb_v2');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const DB_NAME = 'taskpoints_state_v2';
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const HABIT_COMPLETION_ID = 'habit:h1:2026-09-15';

function initialState() {
  return {
    habits: [{
      id: 'h1',
      name: 'Read',
      pointsPerDay: 4,
      doneKeys: ['2026-09-15'],
      failedKeys: [],
      iceKeys: [],
      updatedAtISO: '2026-09-15T12:00:00.000Z'
    }],
    completions: [{
      id: HABIT_COMPLETION_ID,
      taskId: HABIT_COMPLETION_ID,
      title: '[Habit] Read (2026-09-15)',
      points: 4,
      completedAtISO: '2026-09-15T12:00:00.000Z',
      source: 'habit',
      habitId: 'h1',
      dayKey: '2026-09-15'
      // Historical full completions may canonically omit completionFraction.
    }],
    tasks: []
  };
}

function install() {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(initialState()),
    [JOURNAL_KEY]: '[]'
  });
  const core = {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]'); },
    applyPendingHabitDeltas(state) { return { state, applied: 0, appliedDeltas: [], skippedDeltas: [] }; },
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(delta) { return delta; }
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
    crypto: { randomUUID() { return 'pilot-parity-scope'; } },
    TaskPointsCore: core,
    TaskPointsPerf: { mark() {} },
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return { api: context.TaskPointsStateRuntimeV2, indexedDB, localStorage };
}

function updateLegacy(storage, mutate) {
  const state = JSON.parse(storage.getItem(LEGACY_KEY));
  mutate(state);
  storage.setItem(LEGACY_KEY, JSON.stringify(state));
}

function completionStore(indexedDB) {
  return indexedDB._databases.get(DB_NAME)._stores.get('completions');
}

function setV2Fraction(indexedDB, fraction) {
  const store = completionStore(indexedDB);
  const row = clone(store.get(HABIT_COMPLETION_ID));
  assert.ok(row, 'seeded Habit completion row should exist');
  if (Array.isArray(row.entries)) row.entries[0].value.completionFraction = fraction;
  else row.value.completionFraction = fraction;
  store.set(HABIT_COMPLETION_ID, row);
}

test('V2 pilot parity ignores unmigrated completion classes and treats omitted full fraction as canonical 1', async () => {
  const app = install();
  await app.api.seedFromLegacy();

  // V2 writes canonical full completions with an explicit 1, while older legacy
  // rows may omit the field. That semantic representation difference is not a mismatch.
  setV2Fraction(app.indexedDB, 1);

  // Simulate a non-Habit completion arriving after the dark seed. The first V2
  // pilot does not mirror this class and must not report it as a Habit parity failure.
  updateLegacy(app.localStorage, (state) => {
    state.completions.unshift({
      id: 'task-completion-random-uuid',
      taskId: 'task-1',
      title: 'Unmigrated task completion',
      points: 3,
      completedAtISO: '2026-09-15T12:30:00.000Z',
      source: 'task'
    });
  });

  const parity = await app.api.verifyParity();
  assert.equal(parity.match, true);
  assert.equal(parity.comparisonScope, 'habit_records_plus_habit_vice_completions_normalizing_full_fraction');
  assert.deepEqual(JSON.parse(JSON.stringify(parity.expectedCounts)), { habits: 1, completions: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(parity.actualCounts)), { habits: 1, completions: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(parity.scopeExcludedCounts)), {
    expectedCompletions: 1,
    actualCompletions: 0
  });
  assert.equal(parity.differences, null);

  // Parity projection is diagnostic-only: it must not rewrite the legacy row.
  const legacy = JSON.parse(app.localStorage.getItem(LEGACY_KEY));
  const legacyHabitCompletion = legacy.completions.find((row) => row.id === HABIT_COMPLETION_ID);
  assert.equal(Object.prototype.hasOwnProperty.call(legacyHabitCompletion, 'completionFraction'), false);
});

test('V2 pilot parity remains strict for half/full fraction differences', async () => {
  const app = install();
  await app.api.seedFromLegacy();
  setV2Fraction(app.indexedDB, 0.5);

  const parity = await app.api.verifyParity();
  assert.equal(parity.match, false);
  assert.equal(parity.differences.collections.completions.changed, 1);
  const changed = parity.differences.samples.find((row) => row.collection === 'completions' && row.kind === 'changed');
  assert.ok(changed);
  assert.deepEqual(Array.from(changed.fields), ['completionFraction']);
  assert.equal(changed.fieldDetails[0].expected.value, 1);
  assert.equal(changed.fieldDetails[0].actual.value, 0.5);
});

test('V2 pilot parity still fails when an authoritative Habit completion is actually missing', async () => {
  const app = install();
  await app.api.seedFromLegacy();
  completionStore(app.indexedDB).delete(HABIT_COMPLETION_ID);

  const parity = await app.api.verifyParity();
  assert.equal(parity.match, false);
  assert.equal(parity.differences.collections.completions.missing, 1);
  assert.equal(parity.differences.collections.completions.extra, 0);
});
