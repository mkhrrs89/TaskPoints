const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage } = require('./helpers/fake_indexeddb_v2');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const fastPathSource = fs.readFileSync(path.join(__dirname, '..', 'habit_fast_path_control.js'), 'utf8');
const DB_NAME = 'taskpoints_state_v2';
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';

function legacyState() {
  return {
    habits: [
      {
        id: 'h1',
        name: 'Read',
        category: 'mind',
        group: 'Morning',
        pointsPerDay: 8,
        order: 1,
        doneKeys: [],
        failedKeys: [],
        iceKeys: []
      },
      {
        id: 'h2',
        name: 'Walk',
        category: 'fitness',
        group: 'Morning',
        pointsPerDay: 5,
        order: 2,
        doneKeys: [],
        failedKeys: [],
        iceKeys: []
      }
    ],
    completions: []
  };
}

function installRuntime(indexedDB = new FakeIndexedDB(), localStorage = null, label = 'order') {
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

function runtimeMeta(indexedDB) {
  return indexedDB.dump(DB_NAME).meta.find((row) => row.id === 'runtime');
}

function habitRow(indexedDB, id) {
  return indexedDB.dump(DB_NAME).habits.find((row) => row.id === id).value;
}

function overlay(updatedAtISO, h1, h2) {
  return { version: 1, updatedAtISO, orders: { h1, h2 } };
}

test('Habit order overlay commits changed Habit rows, mutation ledger, and revision atomically without touching other fields', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const startingRevision = runtimeMeta(app.indexedDB).revision;
  const h1Before = habitRow(app.indexedDB, 'h1');
  const h2Before = habitRow(app.indexedDB, 'h2');

  const result = await app.api.applyHabitOrderOverlay(overlay('2026-09-03T15:10:00.000Z', 2, 1));
  const snapshot = app.indexedDB.dump(DB_NAME);
  const h1After = habitRow(app.indexedDB, 'h1');
  const h2After = habitRow(app.indexedDB, 'h2');

  assert.equal(result.committed, true);
  assert.deepEqual(result.changedHabitIds.sort(), ['h1', 'h2']);
  assert.equal(h1After.order, 2);
  assert.equal(h2After.order, 1);
  assert.deepEqual({ ...h1After, order: h1Before.order }, h1Before, 'only h1.order may change');
  assert.deepEqual({ ...h2After, order: h2Before.order }, h2Before, 'only h2.order may change');
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.mutations.length, 1);
  assert.equal(snapshot.mutations[0].type, 'habit-order-set');
  assert.equal(snapshot.mutations[0].previousRevision, startingRevision);
  assert.equal(snapshot.mutations[0].revision, startingRevision + 1);
  assert.deepEqual(snapshot.mutations[0].changedHabitIds.sort(), ['h1', 'h2']);
  assert.equal(runtimeMeta(app.indexedDB).revision, startingRevision + 1);
  assert.equal(app.api.getStatus().mirroredOrderMutations, 1);
  assert.equal(app.api.getStatus().readAuthority, 'legacy_only');
});

test('the exact same durable order overlay is idempotent', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const payload = overlay('2026-09-03T15:11:00.000Z', 2, 1);
  const first = await app.api.applyHabitOrderOverlay(payload);
  const beforeDuplicate = app.indexedDB.dump(DB_NAME);
  const duplicate = await app.api.applyHabitOrderOverlay(payload);

  assert.equal(first.committed, true);
  assert.equal(duplicate.committed, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.mutationId, first.mutationId);
  assert.deepEqual(app.indexedDB.dump(DB_NAME), beforeDuplicate);
});

test('rapid reorder churn serializes through the shared V2 mirror queue and preserves the final order', async () => {
  const app = installRuntime();
  await app.api.seedFromLegacy();
  const startingRevision = runtimeMeta(app.indexedDB).revision;

  app.api.enqueueHabitOrderOverlay(overlay('2026-09-03T15:12:00.000Z', 2, 1));
  app.api.enqueueHabitOrderOverlay(overlay('2026-09-03T15:12:01.000Z', 1, 2));
  await app.api.enqueueHabitOrderOverlay(overlay('2026-09-03T15:12:02.000Z', 2, 1));

  assert.equal(habitRow(app.indexedDB, 'h1').order, 2);
  assert.equal(habitRow(app.indexedDB, 'h2').order, 1);
  assert.equal(app.indexedDB.dump(DB_NAME).mutations.length, 3);
  assert.equal(runtimeMeta(app.indexedDB).revision, startingRevision + 3);
  assert.equal(app.api.getStatus().mirroredOrderMutations, 3);
  assert.equal(app.api.getStatus().mirrorFailures, 0);
});

test('order and completion mutations share the same revision guard across runtime instances', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtimeA = installRuntime(indexedDB, localStorage, 'order-a').api;
  const runtimeB = installRuntime(indexedDB, localStorage, 'order-b').api;

  await runtimeA.seedFromLegacy();
  await runtimeB.seedFromLegacy();
  const staleRevision = runtimeB.getObservedRevision();
  const reorder = await runtimeA.applyHabitOrderOverlay(overlay('2026-09-03T15:13:00.000Z', 2, 1));
  assert.equal(reorder.committed, true);

  const completion = {
    habitId: 'h1',
    dayKey: '2026-09-03',
    source: 'habit',
    status: 'full',
    done: true,
    updatedAtISO: '2026-09-03T15:13:01.000Z'
  };
  await assert.rejects(
    runtimeB.applyHabitDelta(completion, { expectedRevision: staleRevision }),
    (error) => error?.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT'
  );
  const retry = await runtimeB.applyHabitDelta(completion);
  assert.equal(retry.committed, true);
  assert.equal(habitRow(indexedDB, 'h1').order, 2, 'completion retry preserves the newer order mutation');
  assert.equal(habitRow(indexedDB, 'h1').doneKeys.includes('2026-09-03'), true);
});

test('production reorder overlay is persisted before V2 is queued, and replay queues the same durable overlay', () => {
  const writeStart = fastPathSource.indexOf('function writeOverlay()');
  const writeEnd = fastPathSource.indexOf('function applyOverlay()', writeStart);
  const writeBody = fastPathSource.slice(writeStart, writeEnd);
  const persistAt = writeBody.indexOf('localStorage?.setItem?.(OVERLAY_KEY, raw)');
  const queueAt = writeBody.indexOf("queueV2OrderMirror(payload, 'overlay-written')");
  assert.ok(persistAt >= 0 && queueAt > persistAt, 'existing durable overlay must be written before V2 is queued');

  const applyStart = fastPathSource.indexOf('function applyOverlay()');
  const applyEnd = fastPathSource.indexOf('function clearCompactionTimer()', applyStart);
  const applyBody = fastPathSource.slice(applyStart, applyEnd);
  assert.match(applyBody, /queueV2OrderMirror\(overlay, 'overlay-replayed'\)/);
  assert.match(applyBody, /queueV2OrderMirror\(overlay, 'overlay-already-compacted'\)/);
  assert.match(fastPathSource, /habitOrderDurability|production_habit_order_overlay|enqueueHabitOrderOverlay/);
});
