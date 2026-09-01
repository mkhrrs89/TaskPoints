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

  const verifiedAt = verifiedRestoreSource.indexOf('restoreVerified = true;');
  const rotateAt = verifiedRestoreSource.indexOf("TaskPointsStateRuntimeV2Generation?.rotate?.('verified-secondary-restore')");
  assert.ok(verifiedAt >= 0 && rotateAt > verifiedAt);
  assert.match(verifiedRestoreSource.slice(verifiedAt, rotateAt), /Restored record-count verification failed/);
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
