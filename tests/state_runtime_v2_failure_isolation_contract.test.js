const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage, clone } = require('./helpers/fake_indexeddb_v2');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const DB_NAME = 'taskpoints_state_v2';
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';
const LEGACY_HABIT_JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';

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
    completions: [],
    tasks: [{ id: 't1', title: 'Production-only task state' }]
  };
}

function delta(dayKey = '2026-09-01') {
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

function readJournal(storage) {
  const raw = storage.getItem(LEGACY_HABIT_JOURNAL_KEY);
  return raw ? JSON.parse(raw) : [];
}

function makeCore(localStorage) {
  const loadAppState = () => JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
  const readTaskPointsStoredState = () => JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
  const core = {
    STORAGE_KEY: LEGACY_KEY,
    PENDING_HABIT_DELTAS_KEY: LEGACY_HABIT_JOURNAL_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return readJournal(localStorage); },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(input) {
      const rows = readJournal(localStorage);
      const durable = { ...input, id: input.id || `${input.source === 'vice' ? 'vice' : 'habit'}:${input.habitId}:${input.dayKey}` };
      rows.push(durable);
      localStorage.setItem(LEGACY_HABIT_JOURNAL_KEY, JSON.stringify(rows));
      return durable;
    },
    loadAppState,
    readTaskPointsStoredState
  };
  return { core, loadAppState, readTaskPointsStoredState };
}

function install({ indexedDB, initialState = legacyState() }) {
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(initialState)
  });
  const coreBundle = makeCore(localStorage);
  let uuid = 0;
  const marks = [];
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
    crypto: { randomUUID() { uuid += 1; return `failure-isolation-${uuid}`; } },
    TaskPointsCore: coreBundle.core,
    TaskPointsPerf: { mark(name, detail) { marks.push({ name, detail: clone(detail) }); } },
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });

  async function settle(iterations = 20) {
    for (let index = 0; index < iterations; index += 1) await Promise.resolve();
  }

  return {
    api: context.TaskPointsStateRuntimeV2,
    core: coreBundle.core,
    originalLoadAppState: coreBundle.loadAppState,
    originalReadTaskPointsStoredState: coreBundle.readTaskPointsStoredState,
    localStorage,
    indexedDB,
    marks,
    settle
  };
}

function failingOpenIndexedDB() {
  return {
    openCalls: [],
    open(name, version = 1) {
      const request = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      };
      this.openCalls.push({ name: String(name), version: Number(version || 1) });
      queueMicrotask(() => {
        const error = new Error('forced_v2_open_failure');
        error.name = 'UnknownError';
        request.error = error;
        request.onerror?.({ target: request });
      });
      return request;
    }
  };
}

test('V2-18 parity mismatch is diagnostic-only and does not repair or replace legacy authoritative state', async () => {
  const indexedDB = new FakeIndexedDB();
  const app = install({ indexedDB });
  await app.api.seedFromLegacy();

  const legacyRawBefore = app.localStorage.getItem(LEGACY_KEY);
  const db = indexedDB._databases.get(DB_NAME);
  const habitsStore = db._stores.get('habits');
  const tamperedRow = clone(habitsStore.get('h1'));
  tamperedRow.value.name = 'DELIBERATE V2 MISMATCH';
  habitsStore.set('h1', tamperedRow);

  const parity = await app.api.verifyParity();
  assert.equal(parity.checked, true);
  assert.equal(parity.match, false);
  assert.notEqual(parity.expectedHash, parity.actualHash);

  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyRawBefore, 'legacy authoritative bytes must remain unchanged');
  assert.equal(app.core.loadAppState, app.originalLoadAppState, 'V2 must not replace legacy load authority');
  assert.equal(app.core.readTaskPointsStoredState, app.originalReadTaskPointsStoredState, 'V2 must not replace legacy read authority');
  assert.equal(app.core.readTaskPointsStoredState().habits[0].name, 'Read');
  assert.equal(indexedDB.dump(DB_NAME).habits.find((row) => row.id === 'h1').value.name, 'DELIBERATE V2 MISMATCH', 'parity check must not silently repair V2 either');
  assert.equal(app.api.getStatus().readAuthority, 'legacy_only');
});

test('V2-19 IndexedDB open failure leaves production journal/read behavior untouched', async () => {
  const indexedDB = failingOpenIndexedDB();
  const app = install({ indexedDB });
  const legacyRawBefore = app.localStorage.getItem(LEGACY_KEY);

  const startStatus = await app.api.startDarkMirror();
  assert.equal(startStatus.readAuthority, 'legacy_only');
  assert.equal(indexedDB.openCalls.length >= 1, true);
  assert.match(app.api.getStatus().lastError, /forced_v2_open_failure/);

  const written = app.core.writePendingHabitDelta(delta());
  assert.equal(written.habitId, 'h1');
  assert.equal(readJournal(app.localStorage).length, 1, 'production WAL must persist even though V2 cannot open');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyRawBefore);
  assert.equal(app.core.loadAppState, app.originalLoadAppState);
  assert.equal(app.core.readTaskPointsStoredState, app.originalReadTaskPointsStoredState);
  assert.equal(app.core.readTaskPointsStoredState().tasks[0].title, 'Production-only task state');

  await app.settle();
  assert.equal(app.api.getStatus().mirrorFailures >= 2, true, 'seed failure and mirrored mutation failure should remain V2 diagnostics');
  assert.equal(readJournal(app.localStorage).length, 1);
});

test('V2-20 quota-style V2 transaction failure rolls back V2 and preserves the successful production journal write', async () => {
  const indexedDB = new FakeIndexedDB();
  const app = install({ indexedDB });
  await app.api.seedFromLegacy();
  await app.api.startDarkMirror();

  const v2Before = indexedDB.dump(DB_NAME);
  const legacyRawBefore = app.localStorage.getItem(LEGACY_KEY);
  const quotaError = new Error('forced_v2_quota_failure');
  quotaError.name = 'QuotaExceededError';
  indexedDB.failNext({ store: 'meta', operation: 'put', error: quotaError });

  const written = app.core.writePendingHabitDelta(delta('2026-09-02'));
  assert.equal(written.dayKey, '2026-09-02');
  assert.equal(readJournal(app.localStorage).length, 1, 'production WAL must be durable synchronously');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyRawBefore);

  await app.settle(30);

  assert.deepEqual(indexedDB.dump(DB_NAME), v2Before, 'failed V2 logical mutation must roll back completely');
  assert.equal(readJournal(app.localStorage).length, 1, 'V2 failure must not remove the production WAL');
  assert.equal(app.core.readTaskPointsStoredState().habits[0].doneKeys.length, 0, 'legacy snapshot remains authoritative and unchanged until its own normal compaction');
  assert.equal(app.api.getStatus().mirrorFailures >= 1, true);
  assert.match(app.api.getStatus().lastError, /forced_v2_quota_failure/);
  assert.equal(app.api.getStatus().readAuthority, 'legacy_only');
});
