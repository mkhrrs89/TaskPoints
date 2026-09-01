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
        pointsPerDay: 4,
        doneKeys: [],
        failedKeys: [],
        iceKeys: []
      }
    ],
    completions: []
  };
}

function createCore() {
  return {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(delta) { return { ...delta }; }
  };
}

function installRuntime({ indexedDB = new FakeIndexedDB(), localStorage = null } = {}) {
  const storage = localStorage || new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(baseLegacyState())
  });
  let uuid = 0;
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
    crypto: { randomUUID() { uuid += 1; return `test-${uuid}`; } },
    TaskPointsCore: createCore(),
    document: {
      readyState: 'loading',
      addEventListener() {}
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return {
    api: context.TaskPointsStateRuntimeV2,
    indexedDB,
    localStorage: storage,
    context
  };
}

function delta(dayKey = '2026-09-01', overrides = {}) {
  return {
    id: `habit:h1:${dayKey}`,
    habitId: 'h1',
    dayKey,
    source: 'habit',
    status: 'full',
    done: true,
    updatedAtISO: `${dayKey}T12:00:00.000Z`,
    ...overrides
  };
}

function runtimeMeta(snapshot) {
  return snapshot.meta.find((row) => row.id === 'runtime');
}

function completion(snapshot, dayKey) {
  return snapshot.completions.find((row) => row.id === `habit:h1:${dayKey}`);
}

test('V2-01 opening V2 creates only the dedicated database and four expected stores', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();

  assert.deepEqual(app.indexedDB.databaseNames(), [DB_NAME]);
  assert.deepEqual(app.indexedDB.storeNames(DB_NAME), ['completions', 'habits', 'meta', 'mutations']);
});

test('V2-02 State Runtime V2 never opens or creates the existing image database', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  await app.api.applyHabitDelta(delta());

  assert.deepEqual(new Set(app.indexedDB.openCalls.map((call) => call.name)), new Set([DB_NAME]));
  assert.equal(app.indexedDB.databaseNames().some((name) => /image/i.test(name)), false);
});

test('V2-03 one habit mutation atomically commits habit, completion, ledger row, and revision', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);
  const beforeRevision = runtimeMeta(before).revision;

  const result = await app.api.applyHabitDelta(delta());
  const after = app.indexedDB.dump(DB_NAME);
  const habitRow = after.habits.find((row) => row.id === 'h1');
  const completionRow = completion(after, '2026-09-01');
  const mutationRow = after.mutations.find((row) => row.id === result.mutationId);
  const meta = runtimeMeta(after);

  assert.equal(result.committed, true);
  assert.equal(result.duplicate, false);
  assert.equal(habitRow.value.doneKeys.includes('2026-09-01'), true);
  assert.equal(completionRow.value.points, 4);
  assert.equal(completionRow.value.habitId, 'h1');
  assert.equal(mutationRow.status, 'committed');
  assert.equal(mutationRow.revision, beforeRevision + 1);
  assert.equal(meta.revision, beforeRevision + 1);
  assert.equal(meta.lastMutationId, result.mutationId);
  assert.equal(meta.completionSequence, 1);
});

test('V2-04 failure of the final meta write rolls back every part of the logical mutation', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);

  app.indexedDB.failNext({
    store: 'meta',
    operation: 'put',
    error: new Error('forced_meta_write_failure')
  });

  await assert.rejects(app.api.applyHabitDelta(delta()), /forced_meta_write_failure|mutation_aborted/);
  const after = app.indexedDB.dump(DB_NAME);

  assert.deepEqual(after, before);
  assert.equal(after.mutations.length, 0);
  assert.equal(after.completions.length, 0);
  assert.equal(runtimeMeta(after).revision, runtimeMeta(before).revision);
  assert.equal(after.habits[0].value.doneKeys.length, 0);
});

test('V2-05 replaying the exact same mutation id is an idempotent no-op', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();

  const first = await app.api.applyHabitDelta(delta());
  const afterFirst = app.indexedDB.dump(DB_NAME);
  const second = await app.api.applyHabitDelta(delta());
  const afterSecond = app.indexedDB.dump(DB_NAME);

  assert.equal(first.committed, true);
  assert.equal(second.committed, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.mutationId, first.mutationId);
  assert.deepEqual(afterSecond, afterFirst);
  assert.equal(afterSecond.mutations.length, 1);
  assert.equal(afterSecond.completions.length, 1);
});

test('V2-06 committed revision survives runtime recreation and is used by the next mutation', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(baseLegacyState())
  });

  const firstRuntime = installRuntime({ indexedDB, localStorage });
  await firstRuntime.api.seedFromLegacy();
  const first = await firstRuntime.api.applyHabitDelta(delta('2026-09-01'));
  const afterFirst = indexedDB.dump(DB_NAME);
  const revisionAfterFirst = runtimeMeta(afterFirst).revision;
  assert.equal(first.revision, revisionAfterFirst);

  const secondRuntime = installRuntime({ indexedDB, localStorage });
  await secondRuntime.api.seedFromLegacy();
  assert.equal(runtimeMeta(indexedDB.dump(DB_NAME)).revision, revisionAfterFirst);

  const second = await secondRuntime.api.applyHabitDelta(delta('2026-09-02'));
  const afterSecond = indexedDB.dump(DB_NAME);
  assert.equal(second.revision, revisionAfterFirst + 1);
  assert.equal(runtimeMeta(afterSecond).revision, revisionAfterFirst + 1);
  assert.equal(afterSecond.mutations.length, 2);
  assert.equal(afterSecond.completions.length, 2);
});
