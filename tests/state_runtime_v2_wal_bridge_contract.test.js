const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const walSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal_bridge.js'), 'utf8');

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

const DARK = 'taskpoints_state_v2_dark_mode_v1';
const WAL_KEY = 'taskpoints_v2_pending_mutations_v1';
const delta = {
  id: 'habit:h1:2026-08-31',
  habitId: 'h1',
  dayKey: '2026-08-31',
  source: 'habit',
  status: 'full',
  done: true,
  updatedAtISO: '2026-08-31T20:00:00.000Z'
};

function install({ enabled = true, initial = {}, applyResult = { committed: true, duplicate: false } } = {}) {
  const localStorage = new FakeStorage({ ...(enabled ? { [DARK]: '1' } : {}), ...initial });
  const timers = [];
  const events = [];
  let runtimeApply = async () => {
    events.push('apply');
    if (applyResult instanceof Error) throw applyResult;
    return typeof applyResult === 'function' ? applyResult() : applyResult;
  };

  const core = {
    writePendingHabitDelta(input) {
      events.push('legacy');
      return { ...input };
    }
  };

  const context = {
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
    console,
    TaskPointsCore: core,
    TaskPointsStateRuntimeV2: {
      applyHabitDelta(input) { return runtimeApply(input); }
    },
    setTimeout(fn) { timers.push(fn); return timers.length; }
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(walSource, context, { filename: 'state_runtime_v2_wal.js' });
  vm.runInNewContext(bridgeSource, context, { filename: 'state_runtime_v2_wal_bridge.js' });

  async function flushTimers() {
    while (timers.length) {
      const fn = timers.shift();
      await fn();
      await Promise.resolve();
    }
    await Promise.resolve();
  }

  return {
    context,
    core,
    localStorage,
    events,
    flushTimers,
    setRuntimeApply(fn) { runtimeApply = fn; }
  };
}

test('bridge is default-off and leaves the production habit journal untouched', () => {
  const { context, core, localStorage } = install({ enabled: false });
  const original = core.writePendingHabitDelta;
  assert.equal(context.TaskPointsStateRuntimeV2WalBridge.getStatus().enabled, false);
  assert.equal(context.TaskPointsStateRuntimeV2WalBridge.installHook(), false);
  assert.equal(core.writePendingHabitDelta, original);
  assert.equal(localStorage.getItem(WAL_KEY), null);
});

test('habit journal writes V1 first, then synchronously writes V2 WAL before async verification', async () => {
  const app = install();
  await app.flushTimers();
  app.events.length = 0;

  app.core.writePendingHabitDelta(delta);
  assert.deepEqual(app.events, ['legacy']);
  const pending = JSON.parse(app.localStorage.getItem(WAL_KEY));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].delta.habitId, 'h1');
  assert.equal(app.events.includes('apply'), false);

  await app.flushTimers();
  assert.equal(app.events.includes('apply'), true);
  assert.equal(app.localStorage.getItem(WAL_KEY), null);
});

test('verified duplicate is safe to clear because IndexedDB already contains that mutation', async () => {
  const app = install({ applyResult: { committed: false, duplicate: true } });
  await app.flushTimers();
  app.core.writePendingHabitDelta(delta);
  assert.ok(app.localStorage.getItem(WAL_KEY));
  await app.flushTimers();
  assert.equal(app.localStorage.getItem(WAL_KEY), null);
});

test('failed IndexedDB verification preserves WAL for a later replay', async () => {
  const app = install({ applyResult: new Error('quota') });
  await app.flushTimers();
  app.core.writePendingHabitDelta(delta);
  await app.flushTimers();
  const pending = JSON.parse(app.localStorage.getItem(WAL_KEY));
  assert.equal(pending.length, 1);
  assert.equal(app.context.TaskPointsStateRuntimeV2WalBridge.getStatus().failures > 0, true);
});

test('startup replay commits an interrupted WAL mutation and removes it exactly after verification', async () => {
  const seed = install();
  await seed.flushTimers();
  const mutationId = seed.context.TaskPointsStateRuntimeV2Wal.mutationIdForDelta(delta);
  const row = {
    id: mutationId,
    schemaVersion: 1,
    type: 'habit-completion-set',
    createdAtISO: '2026-08-31T20:00:01.000Z',
    delta
  };

  const app = install({ initial: { [WAL_KEY]: JSON.stringify([row]) } });
  await app.flushTimers();
  assert.equal(app.events.filter((event) => event === 'apply').length, 1);
  assert.equal(app.localStorage.getItem(WAL_KEY), null);
  assert.equal(app.context.TaskPointsStateRuntimeV2WalBridge.getStatus().replayCleared, 1);
});

test('startup replay stops at a failed mutation and leaves it durable', async () => {
  const seed = install();
  await seed.flushTimers();
  const mutationId = seed.context.TaskPointsStateRuntimeV2Wal.mutationIdForDelta(delta);
  const row = { id: mutationId, schemaVersion: 1, type: 'habit-completion-set', createdAtISO: 'x', delta };
  const app = install({
    initial: { [WAL_KEY]: JSON.stringify([row]) },
    applyResult: new Error('indexeddb_failed')
  });
  await app.flushTimers();
  assert.ok(app.localStorage.getItem(WAL_KEY));
  assert.equal(JSON.parse(app.localStorage.getItem(WAL_KEY)).length, 1);
});

test('malformed WAL is preserved during startup replay and is never silently cleared', async () => {
  const malformed = '{ nope';
  const app = install({ initial: { [WAL_KEY]: malformed } });
  await app.flushTimers();
  assert.equal(app.localStorage.getItem(WAL_KEY), malformed);
  assert.equal(app.events.includes('apply'), false);
});

test('bridge hook installation is idempotent', async () => {
  const app = install();
  await app.flushTimers();
  const wrapped = app.core.writePendingHabitDelta;
  assert.equal(app.context.TaskPointsStateRuntimeV2WalBridge.installHook(), true);
  assert.equal(app.core.writePendingHabitDelta, wrapped);
});
