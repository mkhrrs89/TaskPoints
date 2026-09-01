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

function legacyState() {
  return {
    habits: [{
      id: 'h1',
      name: 'Read',
      pointsPerDay: 4,
      doneKeys: [],
      failedKeys: [],
      iceKeys: []
    }],
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

function installRuntime(indexedDB, localStorage, label) {
  let uuid = 0;
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
    crypto: { randomUUID() { uuid += 1; return `${label}-${uuid}`; } },
    TaskPointsCore: createCore(),
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: `state_runtime_v2_${label}.js` });
  return context.TaskPointsStateRuntimeV2;
}

function delta(dayKey) {
  return {
    id: `habit:h1:${dayKey}`,
    habitId: 'h1',
    dayKey,
    source: 'habit',
    status: 'full',
    done: true,
    updatedAtISO: `${dayKey}T12:00:00.000Z`
  };
}

function runtimeMeta(indexedDB) {
  return indexedDB.dump(DB_NAME).meta.find((row) => row.id === 'runtime');
}

test('V2-15 stale runtime detects revision conflict inside the mutation transaction and cannot overwrite newer V2 state', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });

  const runtimeA = installRuntime(indexedDB, localStorage, 'runtime-a');
  const runtimeB = installRuntime(indexedDB, localStorage, 'runtime-b');

  await runtimeA.seedFromLegacy();
  await runtimeB.seedFromLegacy();

  const sharedStartingRevision = runtimeMeta(indexedDB).revision;
  assert.equal(runtimeA.getObservedRevision(), sharedStartingRevision);
  assert.equal(runtimeB.getObservedRevision(), sharedStartingRevision);

  const committedByA = await runtimeA.applyHabitDelta(delta('2026-09-01'));
  assert.equal(committedByA.committed, true);
  assert.equal(committedByA.revision, sharedStartingRevision + 1);

  const afterA = indexedDB.dump(DB_NAME);
  assert.equal(runtimeB.getObservedRevision(), sharedStartingRevision, 'runtime B must still hold its stale local observation');

  await assert.rejects(
    runtimeB.applyHabitDelta(delta('2026-09-02')),
    (error) => {
      assert.equal(error.code, 'STATE_RUNTIME_V2_REVISION_CONFLICT');
      assert.equal(error.expectedRevision, sharedStartingRevision);
      assert.equal(error.actualRevision, sharedStartingRevision + 1);
      return true;
    }
  );

  const afterRejectedB = indexedDB.dump(DB_NAME);
  assert.deepEqual(afterRejectedB, afterA, 'conflicting mutation must commit no rows at all');
  assert.equal(runtimeB.getStatus().revisionConflicts, 1);
  assert.equal(runtimeB.getStatus().lastKnownRevision, sharedStartingRevision + 1);
  assert.equal(runtimeB.getStatus().lastRevisionConflict.expectedRevision, sharedStartingRevision);
  assert.equal(runtimeB.getStatus().lastRevisionConflict.actualRevision, sharedStartingRevision + 1);

  const retry = await runtimeB.applyHabitDelta(delta('2026-09-02'));
  assert.equal(retry.committed, true);
  assert.equal(retry.revision, sharedStartingRevision + 2);

  const finalSnapshot = indexedDB.dump(DB_NAME);
  const habit = finalSnapshot.habits.find((row) => row.id === 'h1').value;
  assert.deepEqual(new Set(habit.doneKeys), new Set(['2026-09-01', '2026-09-02']));
  assert.equal(finalSnapshot.completions.length, 2);
  assert.equal(finalSnapshot.mutations.length, 2);
  assert.equal(runtimeMeta(indexedDB).revision, sharedStartingRevision + 2);
});

test('duplicate mutation remains idempotent even when caller revision is stale', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtimeA = installRuntime(indexedDB, localStorage, 'runtime-a');
  const runtimeB = installRuntime(indexedDB, localStorage, 'runtime-b');

  await runtimeA.seedFromLegacy();
  await runtimeB.seedFromLegacy();
  const staleRevision = runtimeB.getObservedRevision();
  const first = await runtimeA.applyHabitDelta(delta('2026-09-01'));
  const beforeDuplicate = indexedDB.dump(DB_NAME);

  const duplicate = await runtimeB.applyHabitDelta(delta('2026-09-01'), { expectedRevision: staleRevision });
  assert.equal(duplicate.committed, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.mutationId, first.mutationId);
  assert.deepEqual(indexedDB.dump(DB_NAME), beforeDuplicate);
});
