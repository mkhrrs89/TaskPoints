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

function baseLegacyState() {
  return {
    habits: [
      {
        id: 'h1',
        name: 'Read',
        category: 'mind',
        group: 'Morning',
        pointsPerDay: 10,
        halfPointEnabled: true,
        doneKeys: [],
        failedKeys: [],
        iceKeys: []
      }
    ],
    completions: []
  };
}

function installRuntime({ indexedDB = new FakeIndexedDB(), localStorage = null } = {}) {
  const storage = localStorage || new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(baseLegacyState())
  });
  let uuid = 0;
  const legacyWrites = [];
  const core = {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(input) {
      const durable = {
        ...input,
        id: input.id || `${input.source === 'vice' ? 'vice' : 'habit'}:${input.habitId}:${input.dayKey}`
      };
      legacyWrites.push(durable);
      return durable;
    }
  };
  const context = {
    indexedDB,
    localStorage: storage,
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
    crypto: { randomUUID() { uuid += 1; return `preview-scenario-${uuid}`; } },
    TaskPointsCore: core,
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return {
    api: context.TaskPointsStateRuntimeV2,
    core,
    indexedDB,
    localStorage: storage,
    legacyWrites
  };
}

function delta(status, updatedAtISO, overrides = {}) {
  return {
    habitId: 'h1',
    dayKey: '2026-09-03',
    source: 'habit',
    status,
    done: status === 'full' || status === 'half',
    failed: status === 'failed',
    icy: false,
    completionFraction: status === 'half' ? 0.5 : (status === 'full' ? 1 : 0),
    updatedAtISO,
    ...overrides
  };
}

async function waitForMirrors(app, expected, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    const status = app.api.getStatus();
    if (status.mirroredMutations >= expected || status.mirrorFailures > 0) return status;
    await Promise.resolve();
  }
  assert.fail(`timed out waiting for ${expected} mirrored mutations`);
}

function runtimeMeta(app) {
  return app.indexedDB.dump(DB_NAME).meta.find((row) => row.id === 'runtime');
}

test('V2 preview rapid full -> half -> off toggles serialize in order and end fully undone', async () => {
  const app = installRuntime();
  await app.api.startDarkMirror();
  const seedRevision = runtimeMeta(app).revision;

  app.core.writePendingHabitDelta(delta('full', '2026-09-03T12:00:00.000Z'));
  app.core.writePendingHabitDelta(delta('half', '2026-09-03T12:00:01.000Z'));
  app.core.writePendingHabitDelta(delta('off', '2026-09-03T12:00:02.000Z'));

  const status = await waitForMirrors(app, 3);
  const habit = await app.api.getHabit('h1');
  const completions = await app.api.getCompletionsForHabit('h1');
  const snapshot = app.indexedDB.dump(DB_NAME);

  assert.equal(status.mirrorFailures, 0);
  assert.equal(status.mirroredMutations, 3);
  assert.deepEqual(habit.doneKeys, []);
  assert.deepEqual(habit.failedKeys, []);
  assert.equal(completions.length, 0);
  assert.equal(snapshot.mutations.length, 3, 'every distinct rapid toggle remains auditable');
  assert.equal(runtimeMeta(app).revision, seedRevision + 3);
  assert.equal(app.legacyWrites.length, 3, 'production journal still receives every action first');
});

test('V2 preview half completion stores the canonical half fraction and half points', async () => {
  const app = installRuntime();
  await app.api.startDarkMirror();

  app.core.writePendingHabitDelta(delta('half', '2026-09-03T13:00:00.000Z'));
  const status = await waitForMirrors(app, 1);
  const habit = await app.api.getHabit('h1');
  const completions = await app.api.getCompletionsForHabit('h1');

  assert.equal(status.mirrorFailures, 0);
  assert.deepEqual(habit.doneKeys, ['2026-09-03']);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].completionFraction, 0.5);
  assert.equal(completions[0].points, 5);
  assert.equal(completions[0].dayKey, '2026-09-03');
});

test('V2 preview preserves explicit completionPoints and icy state from the production delta', async () => {
  const app = installRuntime();
  await app.api.startDarkMirror();

  app.core.writePendingHabitDelta(delta('full', '2026-09-03T14:00:00.000Z', {
    icy: true,
    completionFraction: 1,
    completionPoints: 7.5
  }));
  const status = await waitForMirrors(app, 1);
  const habit = await app.api.getHabit('h1');
  const completions = await app.api.getCompletionsForHabit('h1');

  assert.equal(status.mirrorFailures, 0);
  assert.deepEqual(habit.doneKeys, ['2026-09-03']);
  assert.deepEqual(habit.iceKeys, ['2026-09-03']);
  assert.equal(completions[0].points, 7.5);
  assert.equal(completions[0].completionFraction, 1);
});

test('V2 preview failed -> full correction removes failed state and creates exactly one completion', async () => {
  const app = installRuntime();
  await app.api.startDarkMirror();

  app.core.writePendingHabitDelta(delta('failed', '2026-09-03T15:00:00.000Z'));
  app.core.writePendingHabitDelta(delta('full', '2026-09-03T15:00:01.000Z'));

  const status = await waitForMirrors(app, 2);
  const habit = await app.api.getHabit('h1');
  const completions = await app.api.getCompletionsForHabit('h1');

  assert.equal(status.mirrorFailures, 0);
  assert.deepEqual(habit.failedKeys, []);
  assert.deepEqual(habit.doneKeys, ['2026-09-03']);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].points, 10);
  assert.equal(app.indexedDB.dump(DB_NAME).mutations.length, 2);
});

test('V2 preview does not drop a burst of completions across several days', async () => {
  const app = installRuntime();
  await app.api.startDarkMirror();
  const seedRevision = runtimeMeta(app).revision;
  const days = ['03', '04', '05', '06', '07', '08'];

  days.forEach((day, index) => {
    app.core.writePendingHabitDelta(delta('full', `2026-09-${day}T12:00:0${index}.000Z`, {
      dayKey: `2026-09-${day}`
    }));
  });

  const status = await waitForMirrors(app, days.length, 400);
  const habit = await app.api.getHabit('h1');
  const completions = await app.api.getCompletionsForHabit('h1');
  const expectedDays = days.map((day) => `2026-09-${day}`);

  assert.equal(status.mirrorFailures, 0);
  assert.equal(status.mirroredMutations, days.length);
  assert.deepEqual(habit.doneKeys, expectedDays);
  assert.deepEqual(completions.map((row) => row.dayKey), expectedDays.slice().reverse(), 'completion ordering remains newest-write first');
  assert.equal(app.indexedDB.dump(DB_NAME).mutations.length, days.length);
  assert.equal(runtimeMeta(app).revision, seedRevision + days.length);
});

test('targeted V2 Habit completion lookup skips full Habits scan and preserves packed duplicate-ID order', async () => {
  const legacy = baseLegacyState();
  legacy.habits.push({
    ...structuredClone(legacy.habits[0]), id: 'h2', name: 'Walk'
  });
  legacy.completions = [
    { id: 'shared-id', source: 'habit', habitId: 'h2', dayKey: '2026-09-06', points: 5 },
    { id: 'h1-recent', source: 'habit', habitId: 'h1', dayKey: '2026-09-05', points: 10 },
    { id: 'shared-id', source: 'habit', habitId: 'h1', dayKey: '2026-09-04', points: 7 },
    { id: 'h2-old', source: 'habit', habitId: 'h2', dayKey: '2026-09-03', points: 5 }
  ];
  const app = installRuntime({
    localStorage: new FakeStorage({
      [DARK_MODE_KEY]: '1',
      [LEGACY_KEY]: JSON.stringify(legacy)
    })
  });
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);
  const originalConsume = app.indexedDB._consumeFailure.bind(app.indexedDB);
  const operations = [];
  app.indexedDB._consumeFailure = (store, operation) => {
    operations.push([store, operation]);
    return originalConsume(store, operation);
  };

  const h1 = await app.api.getCompletionsForHabit('h1');
  const h2 = await app.api.getCompletionsForHabit('h2');
  const missing = await app.api.getCompletionsForHabit('unknown');

  assert.deepEqual(h1.map(row => row.dayKey), ['2026-09-05', '2026-09-04']);
  assert.deepEqual(h2.map(row => row.dayKey), ['2026-09-06', '2026-09-03']);
  assert.deepEqual(missing, []);
  assert.equal(operations.some(([store, operation]) =>
    store === 'habits' && operation === 'getAll'), false,
    'single-Habit lookups must never deserialize the entire Habits store');
  assert.equal(operations.filter(([store, operation]) =>
    store === 'habits' && operation === 'get').length, 3);
  assert.equal(operations.filter(([store, operation]) =>
    store === 'completions' && operation === 'getAll').length, 3,
    'unverified completion indexes must still use the complete safe fallback');
  assert.deepEqual(app.indexedDB.dump(DB_NAME), before,
    'preview retrieval must not mutate persisted records or metadata');
});

test('V2 one-Habit lookup leaves unrelated Habit records unread when completions are empty', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const originalConsume = app.indexedDB._consumeFailure.bind(app.indexedDB);
  let habitStoreScans = 0;
  app.indexedDB._consumeFailure = (store, operation) => {
    if (store === 'habits' && operation === 'getAll') habitStoreScans += 1;
    return originalConsume(store, operation);
  };
  assert.deepEqual(await app.api.getCompletionsForHabit('h1'), []);
  assert.equal(habitStoreScans, 0);
});
