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
    completions: [],
    tasks: [{ id: 't1', title: 'Legacy authority sentinel' }]
  };
}

function createCore(localStorage, writes = []) {
  return {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(input) {
      const durable = { ...input, id: input.id || `habit:${input.habitId}:${input.dayKey}` };
      writes.push(durable);
      return durable;
    }
  };
}

function install({ indexedDB, visibilityState = 'visible' }) {
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const productionWrites = [];
  const document = {
    readyState: 'loading',
    visibilityState,
    addEventListener() {}
  };
  const location = { pathname: '/index.html' };
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
    queueMicrotask,
    console: { warn() {}, log() {}, error() {} },
    crypto: { randomUUID() { uuid += 1; return `lifecycle-${uuid}`; } },
    TaskPointsCore: createCore(localStorage, productionWrites),
    document,
    location
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return {
    api: context.TaskPointsStateRuntimeV2,
    core: context.TaskPointsCore,
    localStorage,
    indexedDB,
    document,
    location,
    productionWrites
  };
}

function delta(dayKey = '2026-09-03') {
  return {
    habitId: 'h1',
    dayKey,
    source: 'habit',
    status: 'full',
    done: true,
    completionFraction: 1,
    completionPoints: 4,
    updatedAtISO: `${dayKey}T15:00:00.000Z`
  };
}

function blockedIndexedDB() {
  const openCalls = [];
  return {
    openCalls,
    open(name, version = 1) {
      const request = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      };
      openCalls.push({ name: String(name), version: Number(version || 1) });
      queueMicrotask(() => request.onblocked?.({ target: request }));
      return request;
    }
  };
}

test('explicit IndexedDB blocked-open leaves production behavior authoritative and records the V2 failure', async () => {
  const indexedDB = blockedIndexedDB();
  const app = install({ indexedDB });
  const legacyBefore = app.localStorage.getItem(LEGACY_KEY);

  const status = await app.api.startDarkMirror();
  assert.equal(status.readAuthority, 'legacy_only');
  assert.equal(indexedDB.openCalls.length, 1);
  assert.match(app.api.getStatus().lastError, /state_runtime_v2_open_blocked/);

  const written = app.core.writePendingHabitDelta(delta());
  assert.equal(written.habitId, 'h1');
  assert.equal(app.productionWrites.length, 1, 'production mutation still succeeds first');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyBefore, 'V2 blocked-open cannot rewrite authoritative state');

  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  assert.equal(app.api.getStatus().mirrorFailures >= 2, true, 'blocked seed and blocked mirrored mutation remain diagnostic-only');
  assert.equal(app.api.getStatus().readAuthority, 'legacy_only');
});

test('a visibility change to background during an IndexedDB mutation does not partially commit or cancel the transaction', async () => {
  const indexedDB = new FakeIndexedDB();
  const app = install({ indexedDB });
  await app.api.seedFromLegacy();

  const applying = app.api.applyHabitDelta(delta('2026-09-04'));
  app.document.visibilityState = 'hidden';
  const result = await applying;

  assert.equal(result.committed, true);
  const snapshot = indexedDB.dump(DB_NAME);
  assert.equal(snapshot.habits[0].value.doneKeys.includes('2026-09-04'), true);
  assert.equal(snapshot.completions.length, 1);
  assert.equal(snapshot.mutations.length, 1);
  assert.equal(app.api.getStatus().readAuthority, 'legacy_only');
});

test('navigation-state change during an IndexedDB mutation cannot redirect the write to another store or drop it', async () => {
  const indexedDB = new FakeIndexedDB();
  const app = install({ indexedDB });
  await app.api.seedFromLegacy();

  const applying = app.api.applyHabitDelta(delta('2026-09-05'));
  app.location.pathname = '/rankings.html';
  const result = await applying;

  assert.equal(result.committed, true);
  assert.deepEqual(indexedDB.databaseNames(), [DB_NAME]);
  assert.deepEqual(indexedDB.storeNames(DB_NAME), ['completions', 'habits', 'meta', 'mutations']);
  const snapshot = indexedDB.dump(DB_NAME);
  assert.equal(snapshot.habits[0].value.doneKeys.includes('2026-09-05'), true);
  assert.equal(snapshot.completions[0].value.dayKey, '2026-09-05');
  assert.equal(snapshot.mutations.length, 1);
});
