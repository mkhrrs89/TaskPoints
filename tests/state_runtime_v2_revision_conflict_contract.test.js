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

function installRuntime(indexedDB, localStorage, label, configure = () => {}) {
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
  configure(context);
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

test('cross-tab revision signal invalidates a stale runtime before its next Habit interaction', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  let reloads = 0;
  let contextB;
  const runtimeA = installRuntime(indexedDB, localStorage, 'signal-a');
  const runtimeB = installRuntime(indexedDB, localStorage, 'signal-b', (context) => {
    contextB = context;
    context.location = { reload() { reloads += 1; } };
  });

  await runtimeA.seedFromLegacy();
  await runtimeB.seedFromLegacy();
  const startingRevision = runtimeB.getObservedRevision();

  const committed = await runtimeA.applyHabitDelta(delta('2026-09-01'));
  assert.equal(committed.revision, startingRevision + 1);
  assert.equal(runtimeB.getStatus().externalRevisionInvalidated, false);

  assert.equal(runtimeB.checkForExternalRevisionSignal(), true);
  const invalidated = runtimeB.getStatus();
  assert.equal(invalidated.externalRevisionInvalidated, true);
  assert.equal(invalidated.externalRevision, startingRevision + 1);

  const guard = runtimeB.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-02' });
  assert.equal(guard.proceed, false);
  assert.equal(guard.reloadRequested, true);
  assert.equal(reloads, 1);
  assert.equal(contextB.TaskPointsCore.writePendingHabitDelta(delta('2026-09-02')).dayKey, '2026-09-02');
});

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


test('internal journal and generic mutation dispatch share the queue with an in-flight presence mutation', async () => {
  const indexedDB = new FakeIndexedDB();
  const storage = new FakeStorage({ [DARK_MODE_KEY]: '1', [LEGACY_KEY]: JSON.stringify(legacyState()) });
  let context;
  const runtime = installRuntime(indexedDB, storage, 'queue', (value) => { context = value; });
  await runtime.startDarkMirror();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = false;
  const presence = runtime.applyHabitPresenceSnapshot;
  runtime.applyHabitPresenceSnapshot = async (...args) => { started = true; await gate; return presence(...args); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_serialization_guard.js'), 'utf8'), context);
  const before = runtime.getObservedRevision();
  const adding = runtime.applyHabitPresenceSnapshot({ habitId: 'h2', exists: true, habit: { id: 'h2', name: 'New' } });
  await Promise.resolve();
  assert.equal(started, true);
  context.TaskPointsCore.writePendingHabitDelta(delta('2026-09-01'));
  const generic = runtime.applyMutation({ type: 'habit-completion-set', delta: delta('2026-09-02') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.getObservedRevision(), before, 'internal paths must not bypass the held queue');
  release();
  await Promise.all([adding, generic]);
  while (context.TaskPointsStateRuntimeV2SerializationGuard.getStatus().active) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.getStatus().revisionConflicts, 0);
  assert.equal(runtime.getStatus().mirrorFailures, 0);
  assert.equal(runtime.getObservedRevision(), before + 3);
  assert.equal((await runtime.getCompletionsForHabit('h1')).length, 2);
});


test('cross-tab commits with reverse timestamps keep V1 journal completion order without reseeding', async () => {
  const indexedDB = new FakeIndexedDB();
  const legacy = legacyState();
  legacy.habits.push({
    id:'h2',name:'Walk',pointsPerDay:5,doneKeys:[],failedKeys:[],iceKeys:[]
  });
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]:'1',[LEGACY_KEY]:JSON.stringify(legacy)
  });
  const newerTab = installRuntime(indexedDB, localStorage, 'timestamp-newer-tab');
  const olderTab = installRuntime(indexedDB, localStorage, 'timestamp-older-tab');
  await newerTab.seedFromLegacy();
  await olderTab.seedFromLegacy();

  const newer = await newerTab.applyHabitDelta(delta('2026-09-10'));
  assert.equal(newer.committed,true);
  const olderDelta = {
    ...delta('2026-09-09'),
    id:'habit:h2:2026-09-09',
    habitId:'h2',completionPoints:5
  };
  await assert.rejects(
    olderTab.applyHabitDelta(olderDelta),
    e=>e.code==='STATE_RUNTIME_V2_REVISION_CONFLICT'
  );
  const older = await olderTab.applyHabitDelta(olderDelta);
  assert.equal(older.committed,true);

  const actual = await newerTab.buildCompatibilitySnapshot();
  const ids = actual.completions.map(c=>c.id);
  assert.deepEqual(ids, ['habit:h1:2026-09-10','habit:h2:2026-09-09'],
    'V2 must follow journal update time, not the reverse IndexedDB commit order');
  const v2Before = JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME)));
  assert.equal(v2Before.mutations.length,2);

  // Model the production journal's canonical oldest-first replay, which
  // unshifts the latest timestamped event before the earlier event.
  const canonical = structuredClone(actual);
  canonical.completions.sort((a,b)=>
    String(b.completedAtISO).localeCompare(String(a.completedAtISO)));
  localStorage.setItem(LEGACY_KEY,JSON.stringify(canonical));
  const reopened = installRuntime(indexedDB,localStorage,'timestamp-reopened');
  const reused = await reopened.seedFromLegacy();
  assert.equal(reused.reason,'verified_current');
  assert.equal((await reopened.verifyParity()).match,true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME).mutations)),
    v2Before.mutations,
    'correct ordering must not rewrite or discard the existing mutation ledger');
});

test('timestamp-ranked new completions remain in front of the original legacy baseline', async () => {
  const indexedDB = new FakeIndexedDB();
  const legacy = legacyState();
  legacy.habits[0].doneKeys.push('2026-09-20');
  legacy.completions.push({
    id:'habit:h1:2026-09-20',taskId:'habit:h1:2026-09-20',
    title:'[Habit] Read (2026-09-20)',points:4,
    completedAtISO:'2026-09-20T12:00:00.000Z',
    source:'habit',habitId:'h1',dayKey:'2026-09-20',completionFraction:1
  });
  const storage = new FakeStorage({
    [DARK_MODE_KEY]:'1',[LEGACY_KEY]:JSON.stringify(legacy)
  });
  const runtime = installRuntime(indexedDB,storage,'historical-baseline');
  await runtime.seedFromLegacy();
  const newerWrite = await runtime.applyHabitDelta(delta('2026-09-01'));
  assert.equal(newerWrite.committed,true);
  const snapshot = await runtime.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.completions.map(c=>c.dayKey),
    ['2026-09-01','2026-09-20'],
    'a pending journal event precedes seeded legacy entries even if its day is earlier');
});


test('reverse cross-tab commits for two days on one Habit preserve V1 doneKeys order and latest timestamp', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const tabA = installRuntime(indexedDB, localStorage, 'same-habit-a');
  const tabB = installRuntime(indexedDB, localStorage, 'same-habit-b');
  await tabA.seedFromLegacy();
  await tabB.seedFromLegacy();
  const newer = {
    ...delta('2026-09-10'),
    updatedAtISO: '2026-09-14T12:00:09.000Z'
  };
  const older = {
    ...delta('2026-09-11'),
    updatedAtISO: '2026-09-14T12:00:01.000Z'
  };
  const first = await tabA.applyHabitDelta(newer);
  assert.equal(first.committed, true);
  await assert.rejects(tabB.applyHabitDelta(older),
    error => error.code === 'STATE_RUNTIME_V2_REVISION_CONFLICT');
  const second = await tabB.applyHabitDelta(older);
  assert.equal(second.committed, true);

  const before = JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME)));
  const habit = before.habits.find(row => row.id === 'h1');
  assert.deepEqual(habit.value.doneKeys, ['2026-09-11', '2026-09-10'],
    'V1 sorts the earlier journal event first regardless of commit order');
  assert.equal(habit.value.updatedAtISO, newer.updatedAtISO);
  assert.equal(habit.journalDayOrder['2026-09-10'].updatedAtISO, newer.updatedAtISO);
  assert.equal(habit.journalDayOrder['2026-09-11'].updatedAtISO, older.updatedAtISO);
  assert.equal(before.mutations.length, 2);

  // Simulate the production V1 journal replay, oldest timestamp first with
  // newest completion at the front, then verify read-only V2 adoption.
  const canonical = legacyState();
  canonical.habits[0] = JSON.parse(JSON.stringify(habit.value));
  canonical.completions = (await tabB.buildCompatibilitySnapshot()).completions;
  localStorage.setItem(LEGACY_KEY, JSON.stringify(canonical));
  const fresh = installRuntime(indexedDB, localStorage, 'same-habit-restart');
  assert.equal((await fresh.seedFromLegacy()).reason, 'verified_current');
  assert.equal((await fresh.verifyParity()).match, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME).mutations)),
    before.mutations,
    'restart must retain both original durable journal mutations');
});

test('a correction to an older Habit day moves that day to its later V1 journal position', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtime = installRuntime(indexedDB, localStorage, 'same-habit-correction');
  await runtime.seedFromLegacy();
  const first = delta('2026-09-10');
  const second = delta('2026-09-11');
  await runtime.applyHabitDelta(first);
  await runtime.applyHabitDelta(second);
  const latestCorrection = {
    ...first,
    status: 'half', done: true, completionFraction: 0.5,
    completionPoints: 2,
    updatedAtISO: '2026-09-12T16:00:00.000Z'
  };
  await runtime.applyHabitDelta(latestCorrection);
  const before = JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME)));
  const habit = before.habits.find(row => row.id === 'h1').value;
  assert.deepEqual(habit.doneKeys, ['2026-09-11', '2026-09-10']);
  assert.equal(habit.updatedAtISO, latestCorrection.updatedAtISO);
  assert.equal(before.mutations.length, 3);
  const snapshot = await runtime.buildCompatibilitySnapshot();
  assert.equal(snapshot.completions[0].dayKey, '2026-09-10');
  assert.equal(snapshot.completions[0].completionFraction, 0.5);
  assert.equal(snapshot.completions.length, 2);
});



test('V1 compaction promotes previous Habit days to baseline before new backdated V2 events', async () => {
  const indexedDB = new FakeIndexedDB();
  const storage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtime = installRuntime(indexedDB, storage, 'compaction-epoch');
  await runtime.seedFromLegacy();
  const make = (dayKey, second) => ({
    ...delta(dayKey),
    updatedAtISO: '2026-09-20T12:00:' + String(second).padStart(2, '0') + '.000Z'
  });
  await runtime.applyHabitDelta(make('2026-09-11', 9));
  await runtime.applyHabitDelta(make('2026-09-10', 1));
  const first = await runtime.buildCompatibilitySnapshot();
  assert.deepEqual(first.habits[0].doneKeys, ['2026-09-10', '2026-09-11']);
  assert.deepEqual(first.completions.map(c => c.dayKey), ['2026-09-11', '2026-09-10']);
  const before = JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME)));
  storage.setItem(LEGACY_KEY, JSON.stringify(first)); // V1 compacted its journal

  await runtime.applyHabitDelta(make('2026-09-12', 5));
  const next = await runtime.buildCompatibilitySnapshot();
  assert.deepEqual(next.habits[0].doneKeys, ['2026-09-10', '2026-09-11', '2026-09-12'],
    'days saved by V1 compaction must remain a stable baseline');
  assert.deepEqual(next.completions.map(c => c.dayKey), ['2026-09-12', '2026-09-11', '2026-09-10'],
    'a new pending completion must precede the compacted V1 baseline');
  const after = JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME)));
  assert.equal(after.meta[0].completionOrderEpoch, 1);
  assert.deepEqual(Object.keys(after.habits[0].journalDayOrder), ['2026-09-12']);
  assert.deepEqual(after.mutations.slice(0, before.mutations.length), before.mutations,
    'the original mutation ledger survives the V1 checkpoint');
  assert.equal(after.mutations.length, 3);

  // Next verified checkpoint starts another journal epoch. A new backdated
  // completion must again be placed in front without touching old rows.
  storage.setItem(LEGACY_KEY, JSON.stringify(next));
  const reopened = installRuntime(indexedDB, storage, 'compaction-epoch-reload');
  assert.equal((await reopened.seedFromLegacy()).reason, 'verified_current');
  await reopened.applyHabitDelta(make('2026-09-13', 2));
  const third = await reopened.buildCompatibilitySnapshot();
  assert.deepEqual(third.habits[0].doneKeys, [
    '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'
  ]);
  assert.deepEqual(third.completions.map(c => c.dayKey), [
    '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10'
  ]);
  assert.equal(runtimeMeta(indexedDB).completionOrderEpoch, 2);
  storage.setItem(LEGACY_KEY, JSON.stringify(third));
  const final = installRuntime(indexedDB, storage, 'compaction-final-reload');
  assert.equal((await final.seedFromLegacy()).reason, 'verified_current');
  assert.equal((await final.verifyParity()).match, true);
  assert.equal(indexedDB.dump(DB_NAME).mutations.length, 4);
});

test('unrelated V1 snapshot save does not erase V2 un-compacted Habit ordering hints', async () => {
  const indexedDB = new FakeIndexedDB();
  const legacy = legacyState();
  const storage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacy)
  });
  const runtime = installRuntime(indexedDB, storage, 'unrelated-snapshot');
  await runtime.seedFromLegacy();
  const make = (dayKey, second) => ({
    ...delta(dayKey),
    updatedAtISO: '2026-09-20T12:00:' + String(second).padStart(2, '0') + '.000Z'
  });
  await runtime.applyHabitDelta(make('2026-09-11', 9));
  const before = JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME)));
  const unrelated = structuredClone(legacy);
  unrelated.tasks = [{ id: 'task-outside-pilot', title: 'Unrelated' }];
  storage.setItem(LEGACY_KEY, JSON.stringify(unrelated));
  await runtime.applyHabitDelta(make('2026-09-10', 1));
  const after = JSON.parse(JSON.stringify(indexedDB.dump(DB_NAME)));
  assert.deepEqual(after.habits[0].value.doneKeys, ['2026-09-10', '2026-09-11']);
  assert.equal(after.meta[0].completionOrderEpoch || 0, 0,
    'an unrelated V1 rewrite cannot impersonate verified Habit compaction');
  assert.deepEqual(Object.keys(after.habits[0].journalDayOrder).sort(),
    ['2026-09-10', '2026-09-11']);
  assert.deepEqual(after.mutations.slice(0, before.mutations.length), before.mutations);
});
