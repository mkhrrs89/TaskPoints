const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage } = require('./helpers/fake_indexeddb_v2');

const generationSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_generation.js'), 'utf8');
const walSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal_bridge.js'), 'utf8');
const verifiedRestoreHtml = fs.readFileSync(path.join(__dirname, '..', 'verified_secondary_restore.html'), 'utf8');
const verifiedRestoreSource = fs.readFileSync(path.join(__dirname, '..', 'verified_secondary_restore.js'), 'utf8');

const DARK = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';
const WAL_KEY = 'taskpoints_v2_pending_mutations_v1';
const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
const DB_NAME = 'taskpoints_state_v2';

function legacyState(habitId = 'h1', name = 'Read') {
  return {
    habits: [{ id: habitId, name, pointsPerDay: 4, doneKeys: [], failedKeys: [], iceKeys: [] }],
    completions: []
  };
}

function delta(habitId = 'h1', dayKey = '2026-09-01') {
  return {
    id: `habit:${habitId}:${dayKey}`,
    habitId,
    dayKey,
    source: 'habit',
    status: 'full',
    done: true,
    updatedAtISO: `${dayKey}T12:00:00.000Z`
  };
}

function install({ initialState = legacyState(), initialStorage = {} } = {}) {
  const localStorage = new FakeStorage({
    [DARK]: '1',
    [LEGACY_KEY]: JSON.stringify(initialState),
    ...initialStorage
  });
  const indexedDB = new FakeIndexedDB();
  let uuid = 0;
  const documentListeners = new Map();

  const core = {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(input) { return { ...input }; },
    saveValidatedSnapshot(nextState, options = {}) {
      if (options.testBlocked === true) {
        return { state: JSON.parse(localStorage.getItem(LEGACY_KEY)), blocked: true, reason: 'snapshot-shape-invalid' };
      }
      localStorage.setItem(LEGACY_KEY, JSON.stringify(nextState));
      return { state: nextState, options };
    },
    saveStateSnapshot(nextState, options = {}) {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(nextState));
      return { state: nextState, options };
    },
    safeReplaceTaskPointsStorage(storageKey, serializedCandidate) {
      localStorage.setItem(storageKey, serializedCandidate);
      return true;
    }
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
    crypto: { randomUUID() { uuid += 1; return `generation-test-${uuid}`; } },
    TaskPointsCore: core,
    document: {
      readyState: 'loading',
      addEventListener(type, handler) { documentListeners.set(type, handler); }
    },
    queueMicrotask(fn) { Promise.resolve().then(fn); },
    setTimeout(fn) { Promise.resolve().then(fn); return 1; },
    location: { pathname: '/index.html' }
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  vm.runInNewContext(walSource, context, { filename: 'state_runtime_v2_wal.js' });
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  vm.runInNewContext(bridgeSource, context, { filename: 'state_runtime_v2_wal_bridge.js' });

  async function settle() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  }

  return {
    context,
    core,
    localStorage,
    indexedDB,
    generation: context.TaskPointsStateRuntimeV2Generation,
    wal: context.TaskPointsStateRuntimeV2Wal,
    runtime: context.TaskPointsStateRuntimeV2,
    bridge: context.TaskPointsStateRuntimeV2WalBridge,
    settle
  };
}

function runtimeMeta(app) {
  return app.indexedDB.dump(DB_NAME)?.meta?.find((row) => row.id === 'runtime') || null;
}

test('V2-12 Reset All rotates generation, clears V2 mirror, and preserves old WAL as stale/non-replayable', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const oldGeneration = app.generation.read();
  const appended = app.wal.appendHabitDelta(delta(), { generation: oldGeneration });
  assert.equal(appended.generation, oldGeneration);

  app.localStorage.removeItem(LEGACY_KEY);
  await app.settle();
  await app.bridge.start();

  const newGeneration = app.generation.read();
  assert.notEqual(newGeneration, oldGeneration);
  const replay = await app.bridge.replayPending();
  assert.equal(replay.stale >= 1, true);

  const pending = app.wal.getPendingRows();
  assert.equal(pending.rows.length, 1);
  assert.equal(pending.rows[0].generation, oldGeneration);

  const snapshot = app.indexedDB.dump(DB_NAME);
  assert.equal(snapshot.habits.length, 0);
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.mutations.length, 0);
  assert.equal(runtimeMeta(app).resetGeneration, newGeneration);
  assert.equal(runtimeMeta(app).legacyMissing, true);
});

test('V2-13 an in-flight old-generation mutation is rejected after generation rotation', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const oldGeneration = app.generation.read();

  const applying = app.runtime.applyHabitDelta(delta(), { expectedGeneration: oldGeneration });
  const rotated = app.generation.rotate('reset-all-test');
  assert.notEqual(rotated.generation, oldGeneration);

  await assert.rejects(applying, /state_runtime_v2_stale_generation/);
  await app.settle();
  await app.runtime.seedFromLegacy({ force: true });

  const snapshot = app.indexedDB.dump(DB_NAME);
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.mutations.length, 0);
  assert.equal(snapshot.habits[0].value.doneKeys.length, 0);
  assert.equal(runtimeMeta(app).resetGeneration, rotated.generation);
});

test('V2-14 destructive import rotates generation and makes pre-import WAL permanently stale', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const oldGeneration = app.generation.read();
  app.wal.appendHabitDelta(delta(), { generation: oldGeneration });

  const imported = legacyState('h2', 'Imported Habit');
  app.core.saveValidatedSnapshot(imported, {
    allowDestructiveOverwrite: true,
    source: 'settings-import',
    immediateWrite: true
  });
  await app.settle();
  await app.bridge.start();

  const newGeneration = app.generation.read();
  assert.notEqual(newGeneration, oldGeneration);
  const replay = await app.bridge.replayPending();
  assert.equal(replay.stale >= 1, true);
  assert.equal(app.wal.getPendingRows().rows[0].generation, oldGeneration);

  const snapshot = app.indexedDB.dump(DB_NAME);
  assert.deepEqual(snapshot.habits.map((row) => row.id), ['h2']);
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.mutations.length, 0);
  assert.equal(runtimeMeta(app).resetGeneration, newGeneration);
});

test('rejected authorized restore preserves original generation, V1 data and pending WAL', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const originalGeneration = app.generation.read();
  const originalState = app.localStorage.getItem(LEGACY_KEY);
  app.wal.appendHabitDelta(delta(), { generation: originalGeneration });

  const rejected = app.core.saveValidatedSnapshot({ habits: [] }, {
    allowDestructiveOverwrite: true,
    source: 'settings-restore',
    immediateWrite: true,
    testBlocked: true
  });
  await app.settle();

  assert.equal(rejected.blocked, true);
  assert.equal(app.localStorage.getItem(LEGACY_KEY), originalState);
  assert.equal(app.generation.read(), originalGeneration, 'rejected restore may not rotate generation');
  assert.equal(app.wal.getPendingRows().rows.length, 1, 'rejected restore must preserve WAL');
});

test('ordinary validated snapshot save does not rotate V2 generation', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const before = app.generation.read();

  app.core.saveValidatedSnapshot(legacyState(), {
    source: 'ordinary-save',
    immediateWrite: true,
    allowDestructiveOverwrite: false
  });
  await app.settle();

  assert.equal(app.generation.read(), before);
});

test('temporary remove-and-replace does not look like Reset All', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const before = app.generation.read();
  const raw = app.localStorage.getItem(LEGACY_KEY);

  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem(LEGACY_KEY, raw);
  await app.settle();

  assert.equal(app.generation.read(), before);
});

test('verified-secondary restore loads generation guard and rotates only after verified readback', () => {
  const generationScriptAt = verifiedRestoreHtml.indexOf('state_runtime_v2_generation.js');
  const restoreScriptAt = verifiedRestoreHtml.indexOf('verified_secondary_restore.js');
  assert.ok(generationScriptAt >= 0 && restoreScriptAt > generationScriptAt);

  const countVerifiedAt = verifiedRestoreSource.indexOf('Restored record-count verification failed');
  const verifiedAt = verifiedRestoreSource.indexOf('restoreVerified = true;');
  const rotateAt = verifiedRestoreSource.indexOf("TaskPointsStateRuntimeV2Generation?.rotate?.('verified-secondary-restore')");
  assert.ok(countVerifiedAt >= 0, 'record-count verification must be present');
  assert.ok(verifiedAt > countVerifiedAt, 'restore is marked verified only after exact count verification');
  assert.ok(rotateAt > verifiedAt, 'generation rotates only after the restore is fully verified');
});

test('generation module is default-off and does not create an epoch on production/default state', () => {
  const localStorage = new FakeStorage();
  const context = { localStorage, JSON, Date, Math, String, Number, Boolean, Array, Object, Map, Set, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  assert.equal(context.TaskPointsStateRuntimeV2Generation.getStatus().enabled, false);
  assert.equal(localStorage.getItem(GENERATION_KEY), null);
});

test('generation read denial never manufactures an epoch or discards existing WAL evidence', () => {
  const app = install();
  const epoch = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const savedWal = app.localStorage.getItem(WAL_KEY);
  const savedGeneration = app.localStorage.getItem(GENERATION_KEY);
  const originalGet = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = (key) => {
    if (String(key) === GENERATION_KEY) throw new Error('synthetic generation read SecurityError');
    return originalGet(key);
  };
  try {
    assert.throws(() => app.generation.read(), /state_runtime_v2_generation_read_failed/);
    assert.throws(() => app.generation.ensure(), /state_runtime_v2_generation_read_failed/);
    assert.throws(() => app.generation.rotate('unauthorized-rotation'), /state_runtime_v2_generation_read_failed/);
    assert.throws(() => app.wal.appendHabitDelta(delta('h2')), /state_runtime_v2_generation_read_failed/);
    const status = app.generation.getStatus();
    assert.equal(status.generation, null);
    assert.equal(status.generationReadable, false);
    assert.equal(status.rotations, 0);
    assert.match(status.lastError, /state_runtime_v2_generation_read_failed/);
    const walStatus = app.wal.getStatus();
    assert.equal(walStatus.generationReadable, false);
    assert.equal(walStatus.pendingCount, null);
    assert.equal(walStatus.malformed, true);
  } finally {
    app.localStorage.getItem = originalGet;
  }
  assert.equal(app.localStorage.getItem(GENERATION_KEY), savedGeneration);
  assert.equal(app.localStorage.getItem(WAL_KEY), savedWal);
  assert.equal(app.generation.read(), epoch);
  assert.deepEqual(app.wal.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(app.generation.ensure().created, false);
  assert.equal(app.wal.getStatus().generationReadable, true);
  assert.equal(app.wal.getStatus().pendingCount, 1);
});

test('denied generation read during module bootstrap preserves the preexisting epoch for a later reload', () => {
  const localStorage = new FakeStorage({
    [DARK]: '1',
    [GENERATION_KEY]: 'preexisting-generation:abc',
    [WAL_KEY]: '[{"id":"old-evidence","generation":"preexisting-generation:abc","delta":{"habitId":"h1","dayKey":"2026-09-01"}}]'
  });
  const rawRead = localStorage.getItem.bind(localStorage);
  localStorage.getItem = key => {
    if (String(key) === GENERATION_KEY) throw new Error('synthetic bootstrap read SecurityError');
    return rawRead(key);
  };
  const context = { localStorage, JSON, Date, Math, String, Number, Boolean, Array, Object, Map, Set, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  const generation = context.TaskPointsStateRuntimeV2Generation;
  assert.equal(rawRead(GENERATION_KEY), 'preexisting-generation:abc');
  assert.equal(generation.getStatus().generationReadable, false);
  assert.throws(() => generation.ensure(), /state_runtime_v2_generation_read_failed/);
  assert.equal(rawRead(GENERATION_KEY), 'preexisting-generation:abc');
  localStorage.getItem = rawRead;
  assert.equal(generation.ensure().created, false);
  assert.equal(generation.read(), 'preexisting-generation:abc');
  assert.equal(generation.getStatus().rotations, 0);
});

test('Home interaction is held when generation cannot be read, without changing V1 or V2 WAL', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalGeneration = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const originalWal = app.localStorage.getItem(WAL_KEY);
  const originalV1 = app.localStorage.getItem(LEGACY_KEY);
  const get = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = (key) => {
    if (String(key) === GENERATION_KEY) throw new Error('denied generation for resumed tap');
    return get(key);
  };
  try {
    const decision = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
    assert.equal(decision.proceed, false);
    assert.equal(decision.reason, 'generation_unreadable');
    const status = app.runtime.getStatus();
    assert.equal(status.generationReadable, false);
    assert.equal(status.currentGeneration, null);
    assert.equal(status.generationInteractionSafetyBlocks, 1);
    assert.equal(status.readAuthority, 'legacy_only');
  } finally {
    app.localStorage.getItem = get;
  }
  assert.equal(app.localStorage.getItem(LEGACY_KEY), originalV1);
  assert.equal(app.localStorage.getItem(WAL_KEY), originalWal);
  assert.equal(app.generation.read(), originalGeneration);
  assert.deepEqual(app.wal.getPendingRows().rows.map(x => x.id), [first.mutationId]);
  const resumed = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
  assert.equal(resumed.proceed, true);
  assert.equal(app.runtime.getStatus().generationReadable, true);
});

test('temporarily missing generation key blocks stale Home interactions without creating a replacement epoch', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalEpoch = app.generation.read();
  const V1 = app.localStorage.getItem(LEGACY_KEY);
  app.localStorage.removeItem(GENERATION_KEY);
  const blocked = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
  assert.equal(blocked.proceed, false);
  assert.equal(blocked.reason, 'generation_missing');
  assert.equal(app.runtime.getStatus().generationInteractionSafetyBlocks, 1);
  assert.equal(app.localStorage.getItem(GENERATION_KEY), null,
    'a normal tap must not silently manufacture another generation');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), V1);
  app.localStorage.setItem(GENERATION_KEY, originalEpoch);
  assert.equal(app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' }).proceed, true);
});

test('Home Habit guard rejects inaccessible V2 preview flag without losing existing V1 or WAL', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const epoch = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const legacyBefore = app.localStorage.getItem(LEGACY_KEY);
  const walBefore = app.localStorage.getItem(WAL_KEY);
  const get = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = key => {
    if (String(key) === DARK) throw new Error('synthetic dark-mode read SecurityError');
    return get(key);
  };
  try {
    const decision = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
    assert.equal(decision.proceed, false);
    assert.equal(decision.reason, 'dark_mode_unreadable');
    assert.equal(app.runtime.getStatus().generationInteractionSafetyBlocks, 1);
    assert.equal(app.generation.read(), epoch);
  } finally {
    app.localStorage.getItem = get;
  }
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyBefore);
  assert.equal(app.localStorage.getItem(WAL_KEY), walBefore);
  assert.deepEqual(app.wal.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' }).proceed, true);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('normal V1-only Home remains available when the optional V2 preview flag is unreadable', () => {
  const storage = new FakeStorage({
    [DARK]: '0',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const context = {
    localStorage: storage, JSON, Date, Math, String, Number, Boolean, Array, Object, Map, Set,
    TaskPointsCore: { STORAGE_KEY: LEGACY_KEY },
    console: { warn() {}, error() {}, log() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  const oldGet = storage.getItem.bind(storage);
  storage.getItem = key => {
    if (String(key) === DARK) throw new Error('synthetic optional preview key read failure');
    return oldGet(key);
  };
  try {
    const result = context.TaskPointsStateRuntimeV2.beforeHabitInteraction({
      habitId: 'h1', dayKey: '2026-09-01'
    });
    assert.equal(result.proceed, true);
    assert.equal(result.reason, 'dark_unavailable_without_v2_page');
  } finally { storage.getItem = oldGet; }
});

test('preview pilot readiness checks a stable verified mirror but never switches read authority', async () => {
  const app = install();
  const beforeStart = await app.runtime.inspectPilotReadiness();
  assert.equal(beforeStart.eligible, false);
  assert.equal(beforeStart.reason, 'page_generation_unbound');
  await app.runtime.startCoordinatedDarkMirror();
  const oldMeta = structuredClone(runtimeMeta(app));
  const legacyBefore = app.localStorage.getItem(LEGACY_KEY);
  const ready = await app.runtime.inspectPilotReadiness();
  assert.equal(ready.checked, true);
  assert.equal(ready.eligible, true, JSON.stringify(ready));
  assert.equal(ready.reason, 'pilot_consistent');
  assert.equal(ready.readAuthority, 'legacy_only');
  assert.equal(ready.counts.habits, 1);
  assert.equal(ready.counts.completions, 0);
  assert.deepEqual(runtimeMeta(app), oldMeta, 'inspection must never update meta or seed revision');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyBefore);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('preview pilot readiness refuses pending WAL and unverified same-generation Habit differences', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const initial = await app.runtime.inspectPilotReadiness();
  assert.equal(initial.eligible, true, JSON.stringify(initial));
  const generation = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const blockedWal = await app.runtime.inspectPilotReadiness();
  assert.equal(blockedWal.reason, 'wal_pending');
  assert.equal(blockedWal.eligible, false);
  assert.equal(app.wal.getPendingRows().rows.length, 1);
  app.wal.removeMutation(first.mutationId);
  const originalV1 = app.localStorage.getItem(LEGACY_KEY);
  app.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacyState('h1', 'Later external edit')));
  const mismatch = await app.runtime.inspectPilotReadiness();
  assert.equal(mismatch.reason, 'pilot_parity_mismatch');
  assert.equal(mismatch.eligible, false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY).includes('Later external edit'), true);
  app.localStorage.setItem(LEGACY_KEY, originalV1);
  const recovered = await app.runtime.inspectPilotReadiness();
  assert.equal(recovered.eligible, true, JSON.stringify(recovered));
  assert.equal(app.generation.read(), generation);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('preview pilot readiness fails closed on denied WAL reads and changed generations', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const get = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = key => {
    if (String(key) === WAL_KEY) throw Error('temporary WAL read denied');
    return get(key);
  };
  try {
    const denied = await app.runtime.inspectPilotReadiness();
    assert.equal(denied.eligible, false);
    assert.equal(denied.reason, 'wal_unreadable');
  } finally { app.localStorage.getItem = get; }
  assert.equal((await app.runtime.inspectPilotReadiness()).eligible, true);
  const originalEpoch = app.generation.read();
  app.localStorage.setItem(GENERATION_KEY, 'import-replacement-epoch');
  const changed = await app.runtime.inspectPilotReadiness();
  assert.equal(changed.eligible, false);
  assert.equal(changed.reason, 'generation_changed');
  assert.equal(app.localStorage.getItem(GENERATION_KEY), 'import-replacement-epoch');
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
  app.localStorage.setItem(GENERATION_KEY, originalEpoch);
  assert.equal((await app.runtime.inspectPilotReadiness()).eligible, true);
});
