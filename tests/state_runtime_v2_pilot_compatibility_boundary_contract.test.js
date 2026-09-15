const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage, clone } = require('./helpers/fake_indexeddb_v2');

const source = fs.readFileSync('state_runtime_v2.js', 'utf8');
const DB_NAME = 'taskpoints_state_v2';
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';

function legacyState() {
  return {
    habits: [
      { id: 'h1', name: 'Read', pointsPerDay: 4, doneKeys: ['2026-09-14'], failedKeys: [], iceKeys: [], order: 1 },
      { id: 'h2', name: 'Stretch', pointsPerDay: 2, doneKeys: ['2026-09-13'], failedKeys: [], iceKeys: [], order: 2 }
    ],
    completions: [
      { id: 'task-new', source: 'task', taskId: 't1', title: 'Task newest', points: 3 },
      { id: 'habit:h1:2026-09-14', source: 'habit', habitId: 'h1', dayKey: '2026-09-14', title: '[Habit] Read', points: 4 },
      { title: 'Legacy id-less manual row', source: 'manual', points: 7 },
      { id: 'vice:h2:2026-09-13', source: 'vice', habitId: 'h2', dayKey: '2026-09-13', title: '[Vice] Stretch', points: -2 },
      { id: 'task-old', source: 'task', taskId: 't2', title: 'Task oldest', points: 1 }
    ],
    tasks: [{ id: 't1', title: 'Task newest' }],
    profile: { name: 'You' }
  };
}

function install(initial = legacyState()) {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(initial),
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
    crypto: { randomUUID() { return 'pilot-compat-boundary'; } },
    TaskPointsCore: core,
    TaskPointsPerf: { mark() {} },
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'state_runtime_v2.js' });
  return { api: context.TaskPointsStateRuntimeV2, indexedDB, localStorage };
}

function completionStore(indexedDB) {
  return indexedDB._databases.get(DB_NAME)._stores.get('completions');
}

function storedCompletionValues(indexedDB) {
  return indexedDB.dump(DB_NAME).completions.flatMap((row) => {
    if (Array.isArray(row.entries)) return row.entries.map((entry) => entry.value);
    return row.value ? [row.value] : [];
  });
}

function replaceLegacy(localStorage, mutate) {
  const state = JSON.parse(localStorage.getItem(LEGACY_KEY));
  mutate(state);
  localStorage.setItem(LEGACY_KEY, JSON.stringify(state));
  return state;
}

test('V2 seed owns only Habit/Vice completions while compatibility output preserves every legacy-only completion exactly', async () => {
  const initial = legacyState();
  const app = install(initial);
  await app.api.seedFromLegacy();

  const stored = storedCompletionValues(app.indexedDB);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((row) => row.id).sort(), [
    'habit:h1:2026-09-14',
    'vice:h2:2026-09-13'
  ]);
  assert.equal(stored.some((row) => row.source === 'task' || row.source === 'manual'), false);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.completions, initial.completions);
  assert.deepEqual(snapshot.tasks, initial.tasks);
  assert.deepEqual(snapshot.profile, initial.profile);
});

test('a legacy-only completion added after seed survives compatibility export without reseeding V2', async () => {
  const app = install();
  await app.api.seedFromLegacy();
  const beforeStored = clone(storedCompletionValues(app.indexedDB));

  const nextLegacy = replaceLegacy(app.localStorage, (state) => {
    state.completions.unshift({
      id: 'task-after-seed',
      source: 'task',
      taskId: 't-after',
      title: 'Created after V2 seed',
      points: 9
    });
  });

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.completions, nextLegacy.completions);
  assert.deepEqual(storedCompletionValues(app.indexedDB), beforeStored, 'legacy-only completion must not enter the V2 pilot store');
});

test('compatibility export overlays V2 pilot payloads into their legacy slots without disturbing legacy-only relative order', async () => {
  const app = install();
  await app.api.seedFromLegacy();

  const store = completionStore(app.indexedDB);
  const id = 'habit:h1:2026-09-14';
  const row = clone(store.get(id));
  assert.ok(row);
  row.entries[0].value.points = 12;
  row.entries[0].value.completionFraction = 0.5;
  store.set(id, row);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.completions.map((row) => row.id ?? null), [
    'task-new',
    'habit:h1:2026-09-14',
    null,
    'vice:h2:2026-09-13',
    'task-old'
  ]);
  assert.equal(snapshot.completions[1].points, 12);
  assert.equal(snapshot.completions[1].completionFraction, 0.5);
  assert.equal(snapshot.completions[0].title, 'Task newest');
  assert.equal(snapshot.completions[2].title, 'Legacy id-less manual row');
  assert.equal(snapshot.completions[4].title, 'Task oldest');
});

test('V2-only pilot completions are prepended while legacy-only completions remain byte-for-byte represented', async () => {
  const app = install();
  await app.api.seedFromLegacy();

  completionStore(app.indexedDB).set('habit:h1:2026-09-15', {
    id: 'habit:h1:2026-09-15',
    entries: [{
      sequence: 999,
      value: {
        id: 'habit:h1:2026-09-15',
        source: 'habit',
        habitId: 'h1',
        dayKey: '2026-09-15',
        title: '[Habit] Read',
        points: 4,
        completionFraction: 1
      }
    }]
  });

  const legacy = JSON.parse(app.localStorage.getItem(LEGACY_KEY));
  const legacyOnly = legacy.completions.filter((row) => row.source !== 'habit' && row.source !== 'vice');
  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.equal(snapshot.completions[0].id, 'habit:h1:2026-09-15');
  assert.deepEqual(
    snapshot.completions.filter((row) => row.source !== 'habit' && row.source !== 'vice'),
    legacyOnly
  );
});

test('removing a pilot completion from V2 removes only that pilot row from compatibility output', async () => {
  const app = install();
  await app.api.seedFromLegacy();
  completionStore(app.indexedDB).delete('habit:h1:2026-09-14');

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.equal(snapshot.completions.some((row) => row.id === 'habit:h1:2026-09-14'), false);
  assert.equal(snapshot.completions.some((row) => row.id === 'vice:h2:2026-09-13'), true);
  assert.equal(snapshot.completions.some((row) => row.id === 'task-new'), true);
  assert.equal(snapshot.completions.some((row) => row.id === 'task-old'), true);
  assert.equal(snapshot.completions.some((row) => row.title === 'Legacy id-less manual row'), true);
});
