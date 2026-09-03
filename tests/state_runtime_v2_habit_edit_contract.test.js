const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage } = require('./helpers/fake_indexeddb_v2');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_habit_edit_bridge.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
const DB_NAME = 'taskpoints_state_v2';
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function legacyState() {
  return {
    habits: [
      {
        id: 'h1',
        name: 'Read',
        category: 'habit',
        tag: 'Mind',
        pointsPerDay: 8,
        order: 1,
        doneKeys: ['2026-09-01', '2026-09-02'],
        failedKeys: [],
        iceKeys: [],
        halfPointEnabled: true,
        updatedAtISO: '2026-09-01T10:00:00.000Z'
      },
      {
        id: 'h2',
        name: 'Walk',
        category: 'habit',
        tag: 'Body',
        pointsPerDay: 5,
        order: 2,
        doneKeys: ['2026-09-01'],
        failedKeys: [],
        iceKeys: [],
        updatedAtISO: '2026-09-01T10:00:00.000Z'
      }
    ],
    completions: [
      {
        id: 'dup',
        taskId: 'dup',
        title: '[Habit] Read (2026-09-01)',
        source: 'habit',
        habitId: 'h1',
        dayKey: '2026-09-01',
        points: 8,
        completionFraction: 1,
        completedAtISO: '2026-09-01T12:00:00.000Z'
      },
      {
        id: 'dup',
        taskId: 'dup',
        title: '[Habit] Walk (2026-09-01)',
        source: 'habit',
        habitId: 'h2',
        dayKey: '2026-09-01',
        points: 5,
        completionFraction: 1,
        completedAtISO: '2026-09-01T12:00:01.000Z'
      },
      {
        id: 'h1-half',
        taskId: 'h1-half',
        title: '[Habit] Read (2026-09-02)',
        source: 'habit',
        habitId: 'h1',
        dayKey: '2026-09-02',
        points: 4,
        completionFraction: 0.5,
        completedAtISO: '2026-09-02T12:00:00.000Z'
      },
      {
        id: 'task-completion',
        taskId: 'task-1',
        title: 'Unrelated task',
        points: 20,
        completedAtISO: '2026-09-02T13:00:00.000Z'
      }
    ],
    tasks: [{ id: 'task-1', title: 'Must remain legacy-owned' }]
  };
}

function installRuntime(indexedDB = new FakeIndexedDB(), localStorage = null, label = 'edit') {
  const storage = localStorage || new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
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
    crypto: { randomUUID() { uuid += 1; return `${label}-${uuid}`; } },
    TaskPointsCore: {
      STORAGE_KEY: LEGACY_KEY,
      parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
      readPendingHabitDeltas() { return []; },
      applyPendingHabitDeltas() {},
      habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
      writePendingHabitDelta(input) { return { ...input }; }
    },
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: `state_runtime_v2_${label}.js` });
  return { api: context.TaskPointsStateRuntimeV2, indexedDB, localStorage: storage };
}

function readLegacy(storage) {
  return JSON.parse(storage.getItem(LEGACY_KEY));
}

function writeLegacy(storage, state) {
  storage.setItem(LEGACY_KEY, JSON.stringify(state));
}

function runtimeMeta(indexedDB) {
  return indexedDB.dump(DB_NAME).meta.find((row) => row.id === 'runtime');
}

function habitRow(indexedDB, id) {
  return indexedDB.dump(DB_NAME).habits.find((row) => row.id === id).value;
}

test('Habit metadata edit updates only the targeted Habit when historical completions are future-only', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const startingRevision = runtimeMeta(app.indexedDB).revision;
  const before = app.indexedDB.dump(DB_NAME);

  const authoritative = readLegacy(app.localStorage);
  const h1 = authoritative.habits.find((habit) => habit.id === 'h1');
  h1.name = 'Read 30 Minutes';
  h1.tag = 'Focus';
  h1.pointsPerDay = 10;
  h1.halfPointEnabled = false;
  h1.daysPerCompleteWeek = 5;
  h1.updatedAtISO = '2026-09-03T15:30:00.000Z';
  writeLegacy(app.localStorage, authoritative);

  const snapshot = app.api.captureHabitEditSnapshotFromLegacy('h1', { source: 'test-future-only' });
  const result = await app.api.applyHabitEditSnapshot(snapshot);
  const after = app.indexedDB.dump(DB_NAME);

  assert.equal(result.committed, true);
  assert.equal(result.completionRowsTouched, 0, 'future-only edit must write zero historical completion rows');
  assert.equal(habitRow(app.indexedDB, 'h1').name, 'Read 30 Minutes');
  assert.equal(habitRow(app.indexedDB, 'h1').tag, 'Focus');
  assert.equal(habitRow(app.indexedDB, 'h1').pointsPerDay, 10);
  assert.equal(habitRow(app.indexedDB, 'h1').halfPointEnabled, false);
  assert.equal(habitRow(app.indexedDB, 'h1').daysPerCompleteWeek, 5);
  assert.deepEqual(plain(habitRow(app.indexedDB, 'h2')), plain(before.habits.find((row) => row.id === 'h2').value));
  assert.deepEqual(plain(after.completions), plain(before.completions), 'future-only edit must not rewrite historical completion rows');
  assert.equal(after.mutations.length, 1);
  assert.equal(after.mutations[0].type, 'habit-edit-sync');
  assert.equal(after.mutations[0].source, 'test-future-only');
  assert.equal(after.mutations[0].previousRevision, startingRevision);
  assert.equal(after.mutations[0].revision, startingRevision + 1);
  assert.equal(runtimeMeta(app.indexedDB).revision, startingRevision + 1);
  assert.equal(app.api.getStatus().mirroredEditMutations, 1);
  assert.equal(app.api.getStatus().readAuthority, 'legacy_only');
});

test('retroactive point edit rewrites only the edited Habits entries even inside a duplicate-ID completion row', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();

  const authoritative = readLegacy(app.localStorage);
  const h1 = authoritative.habits.find((habit) => habit.id === 'h1');
  h1.pointsPerDay = 12;
  h1.updatedAtISO = '2026-09-03T15:31:00.000Z';
  authoritative.completions.forEach((completion) => {
    if (completion.habitId !== 'h1') return;
    completion.points = completion.completionFraction === 0.5 ? 6 : 12;
  });
  writeLegacy(app.localStorage, authoritative);

  const result = await app.api.applyHabitEditSnapshot(
    app.api.captureHabitEditSnapshotFromLegacy('h1', { source: 'test-retroactive' })
  );
  const compatibility = await app.api.buildCompatibilitySnapshot();
  const duplicateRows = compatibility.completions.filter((completion) => completion.id === 'dup');
  const h1Duplicate = duplicateRows.find((completion) => completion.habitId === 'h1');
  const h2Duplicate = duplicateRows.find((completion) => completion.habitId === 'h2');
  const half = compatibility.completions.find((completion) => completion.id === 'h1-half');
  const unrelated = compatibility.completions.find((completion) => completion.id === 'task-completion');

  assert.equal(result.committed, true);
  assert.equal(result.completionRowsTouched, 2);
  assert.equal(h1Duplicate.points, 12);
  assert.equal(h2Duplicate.points, 5, 'the other Habits entry sharing duplicate id must remain byte-for-byte semantically unchanged');
  assert.equal(half.points, 6);
  assert.equal(unrelated.points, 20);
  assert.equal((await app.api.verifyParity()).match, true);
});

test('Habit edit transaction failure rolls back Habit, completion rows, mutation ledger, and revision together', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);

  const authoritative = readLegacy(app.localStorage);
  const h1 = authoritative.habits.find((habit) => habit.id === 'h1');
  h1.name = 'Should Roll Back In V2';
  h1.pointsPerDay = 14;
  h1.updatedAtISO = '2026-09-03T15:32:00.000Z';
  authoritative.completions.forEach((completion) => {
    if (completion.habitId === 'h1') completion.points = completion.completionFraction === 0.5 ? 7 : 14;
  });
  writeLegacy(app.localStorage, authoritative);
  const snapshot = app.api.captureHabitEditSnapshotFromLegacy('h1');

  app.indexedDB.failNext({ store: 'meta', operation: 'put', error: new Error('forced_edit_meta_failure') });
  await assert.rejects(app.api.applyHabitEditSnapshot(snapshot), /forced_edit_meta_failure|transaction_aborted/);
  assert.deepEqual(plain(app.indexedDB.dump(DB_NAME)), plain(before));
});

test('Habit edit and completion mutation share one revision guard across runtime instances', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtimeA = installRuntime(indexedDB, localStorage, 'edit-a').api;
  const runtimeB = installRuntime(indexedDB, localStorage, 'edit-b').api;

  await runtimeA.seedFromLegacy();
  await runtimeB.seedFromLegacy();
  const staleRevision = runtimeB.getObservedRevision();

  const authoritative = readLegacy(localStorage);
  const h1 = authoritative.habits.find((habit) => habit.id === 'h1');
  h1.name = 'Edited Across Tabs';
  h1.updatedAtISO = '2026-09-03T15:33:00.000Z';
  writeLegacy(localStorage, authoritative);
  const edit = await runtimeA.applyHabitEditSnapshot(runtimeA.captureHabitEditSnapshotFromLegacy('h1'));
  assert.equal(edit.committed, true);

  const completion = {
    habitId: 'h1',
    dayKey: '2026-09-03',
    source: 'habit',
    status: 'full',
    done: true,
    completionPoints: 8,
    updatedAtISO: '2026-09-03T15:33:01.000Z'
  };
  await assert.rejects(
    runtimeB.applyHabitDelta(completion, { expectedRevision: staleRevision }),
    (error) => error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT'
  );
  const retry = await runtimeB.applyHabitDelta(completion);
  assert.equal(retry.committed, true);
  assert.equal(habitRow(indexedDB, 'h1').name, 'Edited Across Tabs');
  assert.equal(habitRow(indexedDB, 'h1').doneKeys.includes('2026-09-03'), true);
});

function installBridgeHarness({ dark = true, changes = true } = {}) {
  const events = [];
  const storage = new FakeStorage(dark ? { [DARK_MODE_KEY]: '1' } : {});
  const stateObject = {
    habits: [{ id: 'h1', updatedAtISO: 'before' }]
  };
  const context = {
    localStorage: storage,
    state: stateObject,
    console: { warn() {}, log() {}, error() {} },
    Promise,
    TaskPointsStateRuntimeV2: {
      enqueueHabitEditFromLegacy(id) {
        events.push(`enqueue:${id}`);
        return Promise.resolve({ committed: true });
      }
    },
    saveHabitEdit(id) {
      events.push(`original:${id}`);
      if (changes) stateObject.habits[0].updatedAtISO = 'after';
    },
    document: { readyState: 'complete', addEventListener() {} },
    setTimeout(fn) { fn(); return 1; },
    addEventListener() {}
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(bridgeSource, context, { filename: 'state_runtime_v2_habit_edit_bridge.js' });
  return { context, events };
}

test('Habit edit bridge runs production edit first and queues V2 only after a real edit changed the Habit', async () => {
  const harness = installBridgeHarness({ dark: true, changes: true });
  harness.context.saveHabitEdit('h1', {});
  await Promise.resolve();
  assert.deepEqual(harness.events, ['original:h1', 'enqueue:h1']);
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitEditBridge.getStatus().mirroredEditRequests, 1);
});

test('Habit edit bridge does not queue V2 when the edit was cancelled or produced no Habit change', async () => {
  const harness = installBridgeHarness({ dark: true, changes: false });
  harness.context.saveHabitEdit('h1', {});
  await Promise.resolve();
  assert.deepEqual(harness.events, ['original:h1']);
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitEditBridge.getStatus().skippedUnchanged, 1);
});

test('Habit edit bridge remains default-off and does not wrap production saveHabitEdit', () => {
  const harness = installBridgeHarness({ dark: false, changes: true });
  const original = harness.context.saveHabitEdit;
  const status = harness.context.TaskPointsStateRuntimeV2HabitEditBridge.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.installed, false);
  harness.context.saveHabitEdit('h1', {});
  assert.equal(harness.context.saveHabitEdit, original);
  assert.deepEqual(harness.events, ['original:h1']);
});

test('worker core bundle includes the V2 Habit edit bridge after the V2 runtime', () => {
  const runtimeAt = workerSource.indexOf("'/state_runtime_v2.js'");
  const bridgeAt = workerSource.indexOf("'/state_runtime_v2_habit_edit_bridge.js'");
  assert.ok(runtimeAt >= 0 && bridgeAt > runtimeAt);
  assert.match(workerSource, /stateRuntimeV2HabitEditBridgeSource/);
  assert.match(workerSource, /x-taskpoints-state-runtime-v2-habit-edit-bridge/);
});
