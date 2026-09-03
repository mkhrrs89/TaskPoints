const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage } = require('./helpers/fake_indexeddb_v2');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_habit_structure_bridge.js'), 'utf8');
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
      { id: 'h1', name: 'Read', category: 'habit', order: 1, pointsPerDay: 8, doneKeys: ['2026-09-01'], failedKeys: [], iceKeys: [], updatedAtISO: '2026-09-01T10:00:00.000Z' },
      { id: 'h2', name: 'Walk', category: 'habit', order: 2, pointsPerDay: 5, doneKeys: ['2026-09-01'], failedKeys: [], iceKeys: [], updatedAtISO: '2026-09-01T10:00:00.000Z' },
      { id: 'h3', name: 'Stretch', category: 'habit', order: 3, pointsPerDay: 3, doneKeys: [], failedKeys: [], iceKeys: [], updatedAtISO: '2026-09-01T10:00:00.000Z' }
    ],
    completions: [
      { id: 'c1', taskId: 'c1', title: '[Habit] Read', source: 'habit', habitId: 'h1', dayKey: '2026-09-01', points: 8, completedAtISO: '2026-09-01T12:00:00.000Z' },
      { id: 'c2', taskId: 'c2', title: '[Habit] Walk', source: 'habit', habitId: 'h2', dayKey: '2026-09-01', points: 5, completedAtISO: '2026-09-01T12:01:00.000Z' }
    ],
    tasks: [{ id: 't1', title: 'Legacy-owned task' }]
  };
}

function installRuntime(indexedDB = new FakeIndexedDB(), localStorage = null, label = 'presence') {
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

function habitRows(indexedDB) {
  return indexedDB.dump(DB_NAME).habits;
}

test('adding a persisted Habit atomically appends one V2 Habit row, ledger entry, and revision without touching completions', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);
  const startingRevision = runtimeMeta(app.indexedDB).revision;

  const authoritative = readLegacy(app.localStorage);
  authoritative.habits.push({
    id: 'h4', name: 'Meditate', category: 'habit', order: 4, pointsPerDay: 6,
    doneKeys: [], failedKeys: [], iceKeys: [], updatedAtISO: '2026-09-03T16:00:00.000Z'
  });
  writeLegacy(app.localStorage, authoritative);

  const snapshot = app.api.captureHabitPresenceSnapshotFromLegacy('h4', { source: 'test-add' });
  const result = await app.api.applyHabitPresenceSnapshot(snapshot);
  const after = app.indexedDB.dump(DB_NAME);

  assert.equal(result.committed, true);
  assert.equal(result.exists, true);
  assert.equal(result.assignedLegacyIndex, 3);
  assert.equal(habitRows(app.indexedDB).find((row) => row.id === 'h4').value.name, 'Meditate');
  assert.deepEqual(plain(after.completions), plain(before.completions));
  assert.equal(after.mutations.length, 1);
  assert.equal(after.mutations[0].type, 'habit-presence-sync');
  assert.equal(after.mutations[0].action, 'upsert');
  assert.equal(after.mutations[0].source, 'test-add');
  assert.equal(after.mutations[0].previousRevision, startingRevision);
  assert.equal(after.mutations[0].revision, startingRevision + 1);
  assert.equal(runtimeMeta(app.indexedDB).revision, startingRevision + 1);
  assert.equal(app.api.getStatus().mirroredPresenceMutations, 1);
  assert.equal((await app.api.verifyParity()).match, true);
});

test('deleting a Habit removes only its V2 Habit row and preserves all historical completion rows', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);

  const authoritative = readLegacy(app.localStorage);
  authoritative.habits = authoritative.habits.filter((habit) => habit.id !== 'h1');
  writeLegacy(app.localStorage, authoritative);

  const result = await app.api.applyHabitPresenceSnapshot(
    app.api.captureHabitPresenceSnapshotFromLegacy('h1', { source: 'test-delete' })
  );
  const after = app.indexedDB.dump(DB_NAME);
  const compatibility = await app.api.buildCompatibilitySnapshot();

  assert.equal(result.committed, true);
  assert.equal(result.exists, false);
  assert.equal(habitRows(app.indexedDB).some((row) => row.id === 'h1'), false);
  assert.deepEqual(plain(after.completions), plain(before.completions));
  assert.equal(compatibility.completions.some((completion) => completion.habitId === 'h1'), true, 'delete keeps historical log entries');
  assert.equal(after.mutations[0].action, 'delete');
  assert.equal((await app.api.verifyParity()).match, true);
});

test('delete then add uses a monotonic V2 sequence so compatibility Habit order never collides after a gap', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();

  let authoritative = readLegacy(app.localStorage);
  authoritative.habits = authoritative.habits.filter((habit) => habit.id !== 'h2');
  writeLegacy(app.localStorage, authoritative);
  const deleted = await app.api.applyHabitPresenceSnapshot(app.api.captureHabitPresenceSnapshotFromLegacy('h2'));
  assert.equal(deleted.committed, true);
  assert.deepEqual(habitRows(app.indexedDB).map((row) => [row.id, row.legacyIndex]).sort(), [['h1', 0], ['h3', 2]]);

  authoritative = readLegacy(app.localStorage);
  authoritative.habits.push({
    id: 'h4', name: 'Journal', category: 'habit', order: 4, pointsPerDay: 4,
    doneKeys: [], failedKeys: [], iceKeys: [], updatedAtISO: '2026-09-03T16:01:00.000Z'
  });
  writeLegacy(app.localStorage, authoritative);
  const added = await app.api.applyHabitPresenceSnapshot(app.api.captureHabitPresenceSnapshotFromLegacy('h4'));
  assert.equal(added.committed, true);
  assert.equal(added.assignedLegacyIndex, 3, 'append uses max existing V2 sequence + 1 rather than colliding with current legacy array index 2');

  const compatibility = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(compatibility.habits.map((habit) => habit.id), ['h1', 'h3', 'h4']);
  assert.deepEqual(compatibility.habits.map((habit) => habit.id), readLegacy(app.localStorage).habits.map((habit) => habit.id));
});

test('Habit presence transaction failure rolls back row, ledger, and revision while leaving completions untouched', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);

  const authoritative = readLegacy(app.localStorage);
  authoritative.habits = authoritative.habits.filter((habit) => habit.id !== 'h2');
  writeLegacy(app.localStorage, authoritative);
  const snapshot = app.api.captureHabitPresenceSnapshotFromLegacy('h2');

  app.indexedDB.failNext({ store: 'meta', operation: 'put', error: new Error('forced_presence_meta_failure') });
  await assert.rejects(app.api.applyHabitPresenceSnapshot(snapshot), /forced_presence_meta_failure|transaction_aborted/);
  assert.deepEqual(plain(app.indexedDB.dump(DB_NAME)), plain(before));
});

test('Habit presence and completion mutations share the same revision conflict guard across runtimes', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtimeA = installRuntime(indexedDB, localStorage, 'presence-a').api;
  const runtimeB = installRuntime(indexedDB, localStorage, 'presence-b').api;
  await runtimeA.seedFromLegacy();
  await runtimeB.seedFromLegacy();
  const staleRevision = runtimeB.getObservedRevision();

  const authoritative = readLegacy(localStorage);
  authoritative.habits.push({ id: 'h4', name: 'New', category: 'habit', order: 4, pointsPerDay: 2, doneKeys: [], failedKeys: [], iceKeys: [] });
  writeLegacy(localStorage, authoritative);
  const presence = await runtimeA.applyHabitPresenceSnapshot(runtimeA.captureHabitPresenceSnapshotFromLegacy('h4'));
  assert.equal(presence.committed, true);

  const completion = {
    habitId: 'h1', dayKey: '2026-09-03', source: 'habit', status: 'full', done: true,
    completionPoints: 8, updatedAtISO: '2026-09-03T16:02:00.000Z'
  };
  await assert.rejects(
    runtimeB.applyHabitDelta(completion, { expectedRevision: staleRevision }),
    (error) => error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT'
  );
  const retry = await runtimeB.applyHabitDelta(completion);
  assert.equal(retry.committed, true);
  assert.equal(habitRows(indexedDB).some((row) => row.id === 'h4'), true);
});

function installBridgeHarness({ dark = true, deleteSucceeds = true, retireSucceeds = true } = {}) {
  const events = [];
  const storage = new FakeStorage(dark ? { [DARK_MODE_KEY]: '1' } : {});
  const stateObject = {
    habits: [
      { id: 'h1', name: 'Read', updatedAtISO: 'before', retired: false },
      { id: 'h2', name: 'Walk', updatedAtISO: 'before', retired: false }
    ]
  };
  let next = 3;
  const context = {
    localStorage: storage,
    state: stateObject,
    console: { warn() {}, log() {}, error() {} },
    Promise,
    TaskPointsStateRuntimeV2: {
      enqueueHabitPresenceFromLegacy(id, options) {
        events.push(`presence:${id}:${options.source}`);
        return Promise.resolve({ committed: true });
      },
      enqueueHabitEditFromLegacy(id, options) {
        events.push(`edit:${id}:${options.source}`);
        return Promise.resolve({ committed: true });
      }
    },
    addHabit() {
      const id = `h${next++}`;
      events.push(`original:addHabit:${id}`);
      stateObject.habits.push({ id, name: 'Added Habit', updatedAtISO: 'new' });
    },
    addVice() {
      const id = `h${next++}`;
      events.push(`original:addVice:${id}`);
      stateObject.habits.push({ id, name: 'Added Vice', category: 'vice', updatedAtISO: 'new' });
    },
    deleteHabit(id) {
      events.push(`original:delete:${id}`);
      if (deleteSucceeds) stateObject.habits = stateObject.habits.filter((habit) => habit.id !== id);
    },
    retireHabit(id) {
      events.push(`original:retire:${id}`);
      if (!retireSucceeds) return;
      const habit = stateObject.habits.find((candidate) => candidate.id === id);
      if (habit) { habit.retired = true; habit.updatedAtISO = 'after'; }
    },
    document: { readyState: 'complete', addEventListener() {} },
    setTimeout(fn) { fn(); return 1; },
    addEventListener() {}
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(bridgeSource, context, { filename: 'state_runtime_v2_habit_structure_bridge.js' });
  return { context, events, stateObject };
}

test('structure bridge runs production add first then queues presence for the newly created Habit and Vice', async () => {
  const harness = installBridgeHarness();
  harness.context.addHabit();
  harness.context.addVice();
  await Promise.resolve();
  assert.deepEqual(harness.events, [
    'original:addHabit:h3', 'presence:h3:home-addHabit',
    'original:addVice:h4', 'presence:h4:home-addVice'
  ]);
});

test('structure bridge queues delete only after production actually removed the Habit', async () => {
  const success = installBridgeHarness({ deleteSucceeds: true });
  success.context.deleteHabit('h1');
  await Promise.resolve();
  assert.deepEqual(success.events, ['original:delete:h1', 'presence:h1:home-deleteHabit']);

  const cancelled = installBridgeHarness({ deleteSucceeds: false });
  cancelled.context.deleteHabit('h1');
  await Promise.resolve();
  assert.deepEqual(cancelled.events, ['original:delete:h1']);
  assert.equal(cancelled.context.TaskPointsStateRuntimeV2HabitStructureBridge.getStatus().skippedNoChange, 1);
});

test('structure bridge reuses the proven Habit edit mutation for retirement', async () => {
  const success = installBridgeHarness({ retireSucceeds: true });
  success.context.retireHabit('h1');
  await Promise.resolve();
  assert.deepEqual(success.events, ['original:retire:h1', 'edit:h1:home-retireHabit']);

  const noChange = installBridgeHarness({ retireSucceeds: false });
  noChange.context.retireHabit('h1');
  await Promise.resolve();
  assert.deepEqual(noChange.events, ['original:retire:h1']);
});

test('structure bridge is default-off and leaves production methods unwrapped', () => {
  const harness = installBridgeHarness({ dark: false });
  const addHabit = harness.context.addHabit;
  const deleteHabit = harness.context.deleteHabit;
  const status = harness.context.TaskPointsStateRuntimeV2HabitStructureBridge.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.installed, false);
  assert.equal(harness.context.addHabit, addHabit);
  assert.equal(harness.context.deleteHabit, deleteHabit);
  harness.context.addHabit();
  assert.deepEqual(harness.events, ['original:addHabit:h3']);
});

test('worker core bundle includes the V2 Habit structure bridge after the edit bridge', () => {
  const editAt = workerSource.indexOf("'/state_runtime_v2_habit_edit_bridge.js'");
  const structureAt = workerSource.indexOf("'/state_runtime_v2_habit_structure_bridge.js'");
  assert.ok(editAt >= 0 && structureAt > editAt);
  assert.match(workerSource, /stateRuntimeV2HabitStructureBridgeSource/);
  assert.match(workerSource, /x-taskpoints-state-runtime-v2-habit-structure-bridge/);
});
