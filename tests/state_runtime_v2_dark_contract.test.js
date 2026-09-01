const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimePath = path.join(__dirname, '..', 'state_runtime_v2.js');
const workerPath = path.join(__dirname, '..', '_worker.js');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function installDisabledRuntime() {
  const localStorage = new FakeStorage();
  let indexedDbOpenCalls = 0;
  let originalJournalCalls = 0;
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    writePendingHabitDelta(delta) {
      originalJournalCalls += 1;
      return { ...delta, id: delta.id || `habit:${delta.habitId}:${delta.dayKey}` };
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    indexedDB: { open() { indexedDbOpenCalls += 1; throw new Error('must not open while disabled'); } },
    structuredClone,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Date,
    Math,
    Map,
    Set,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return { context, core, localStorage, indexedDbOpenCalls: () => indexedDbOpenCalls, originalJournalCalls: () => originalJournalCalls };
}

test('V2 dark runtime is default-off and does not open IndexedDB', async () => {
  const harness = installDisabledRuntime();
  assert.equal(harness.context.TaskPointsStateRuntimeV2.isDarkEnabled(), false);
  assert.equal(harness.context.TaskPointsStateRuntimeV2.getStatus().readAuthority, 'legacy_only');
  await harness.context.TaskPointsStateRuntimeV2.open();
  assert.equal(harness.indexedDbOpenCalls(), 0);
});

test('default-off installation does not wrap the production habit journal', () => {
  const harness = installDisabledRuntime();
  const before = harness.core.writePendingHabitDelta;
  assert.equal(harness.context.TaskPointsStateRuntimeV2.getStatus().hookInstalled, false);
  assert.equal(harness.core.writePendingHabitDelta, before);
  harness.core.writePendingHabitDelta({ habitId: 'h1', dayKey: '2026-08-27', source: 'habit' });
  assert.equal(harness.originalJournalCalls(), 1);
  assert.equal(harness.indexedDbOpenCalls(), 0);
});

test('V2 declares a separate state database and only the four pilot stores', () => {
  assert.match(runtimeSource, /const DB_NAME = 'taskpoints_state_v2'/);
  assert.match(runtimeSource, /\['habits', 'completions', 'mutations', 'meta'\]/);
  assert.equal(runtimeSource.includes("indexedDB.open('taskpoints'"), false, 'must never open the image database');
  assert.equal(runtimeSource.includes('taskpoints_shadow_state_v1'), false, 'must not reuse the shadow migration database');
  assert.equal(runtimeSource.includes('taskpoints_verified_secondary_v1'), false, 'must not reuse verified-secondary storage');
});

test('dark mirror preserves production write ordering and isolates V2 failures', () => {
  const hook = runtimeSource.slice(
    runtimeSource.indexOf('function installHabitJournalHook()'),
    runtimeSource.indexOf('async function readV2Collections()')
  );
  const productionWrite = hook.indexOf('const result = originalWritePendingHabitDelta(...arguments)');
  const enqueue = hook.indexOf('enqueueHabitDelta(result || delta)');
  assert.ok(productionWrite >= 0, 'production journal write must remain present');
  assert.ok(enqueue > productionWrite, 'dark mirror must enqueue only after the production journal succeeds');
  assert.match(runtimeSource, /production state remains authoritative/);
});

test('pilot mutation transaction covers habit, completion, mutation ledger, and meta together', () => {
  const applyStart = runtimeSource.search(/async function applyHabitDelta\(deltaInput(?:,\s*options\s*=\s*\{\})?\)/);
  const apply = runtimeSource.slice(
    applyStart,
    runtimeSource.indexOf('function enqueueHabitDelta(delta)')
  );
  assert.ok(applyStart >= 0, 'applyHabitDelta implementation must be present');
  assert.match(apply, /db\.transaction\(STORE_NAMES, 'readwrite'\)/);
  for (const store of ['habits', 'completions', 'mutations', 'meta']) {
    assert.ok(apply.includes(`objectStore('${store}')`), `${store} participates in the mutation transaction`);
  }
  assert.match(apply, /existingMutation/);
  assert.match(apply, /duplicate = true/);
  assert.match(apply, /revision: nextRevision/);
});

test('V2 runtime never replaces current application read authority', () => {
  assert.equal(runtimeSource.includes('core.loadAppState ='), false);
  assert.equal(runtimeSource.includes('core.readTaskPointsStoredState ='), false);
  assert.equal(runtimeSource.includes('core.saveStateSnapshot ='), false);
  assert.match(runtimeSource, /readAuthority: 'legacy_only'/);
});

test('worker contract includes V2 module in the versioned browser core bundle', () => {
  const workerSource = fs.readFileSync(workerPath, 'utf8');
  assert.match(workerSource, /state_runtime_v2\.js/);
  assert.match(workerSource, /x-taskpoints-state-runtime-v2/);
});
