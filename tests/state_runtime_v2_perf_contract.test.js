const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_perf.js'), 'utf8');
const serializationGuard = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_serialization_guard.js'), 'utf8');
const structureBridge = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_habit_structure_bridge.js'), 'utf8');

function install() {
  const events = [];
  let tick = 0;
  const runtime = {
    applyHabitDelta: async () => ({ committed: true, revision: 2 }),
    applyHabitOrderOverlay: async (payload) => ({ committed: true, revision: 3, payload }),
    applyHabitEditSnapshot: async () => ({ committed: true, revision: 4 }),
    applyHabitPresenceSnapshot: async () => ({ committed: true, revision: 5 }),
    enqueueHabitDelta: () => Promise.resolve(true),
    enqueueHabitOrderOverlay: () => Promise.resolve(true),
    enqueueHabitEditFromLegacy: () => Promise.resolve(true),
    enqueueHabitPresenceFromLegacy: () => Promise.resolve(true),
    verifyParity: async () => ({ match: true }),
    buildCompatibilitySnapshot: async () => ({ habits: [], completions: [] }),
    getStatus: () => ({ installed: true, darkEnabled: true })
  };
  const context = {
    TaskPointsStateRuntimeV2: runtime,
    TaskPointsPerf: {
      mark(name, detail) { events.push({ type: 'mark', name, detail }); },
      duration(name, durationMs, detail) { events.push({ type: 'duration', name, durationMs, detail }); }
    },
    performance: { now() { tick += 0.25; return tick; } },
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'state_runtime_v2_perf.js' });
  return { context, runtime, events };
}

test('sync enqueue timing is separately observable from async V2 transaction timing', async () => {
  const { context, runtime, events } = install();
  await runtime.enqueueHabitDelta({ habitId: 'h1', dayKey: '2026-09-06' });
  await runtime.applyHabitDelta({ habitId: 'h1', dayKey: '2026-09-06' });

  const enqueue = events.find((event) => event.name === 'stateV2.enqueue.completion.sync');
  const txn = events.find((event) => event.name === 'stateV2.txn.completion');
  assert.ok(enqueue);
  assert.equal(enqueue.detail.foregroundBlocking, true);
  assert.equal(enqueue.detail.promiseReturned, true);
  assert.ok(txn);
  assert.equal(txn.detail.storesTouched, 3);
  assert.equal(txn.detail.estimatedRowsTouched, 3);
  assert.equal(txn.detail.committed, true);

  const status = context.TaskPointsStateRuntimeV2Perf.getStatus();
  assert.equal(status.syncEnqueues, 1);
  assert.equal(status.asyncMutations, 1);
});

test('order and edit traces disclose bounded row/store scope', async () => {
  const { runtime, events } = install();
  await runtime.applyHabitOrderOverlay({ orders: { h1: 1, h2: 2, h3: 3 } });
  await runtime.applyHabitEditSnapshot({ completionRows: [{ id: 'c1' }, { id: 'c2' }] });

  const order = events.find((event) => event.name === 'stateV2.txn.order');
  const edit = events.find((event) => event.name === 'stateV2.txn.edit');
  assert.equal(order.detail.storesTouched, 3);
  assert.equal(order.detail.habitCount, 3);
  assert.equal(order.detail.estimatedRowsTouched, 5);
  assert.equal(edit.detail.storesTouched, 4);
  assert.equal(edit.detail.completionRows, 2);
  assert.equal(edit.detail.estimatedRowsTouched, 5);
});

test('parity and compatibility work is labeled as heavyweight foreground maintenance when invoked directly', async () => {
  const { runtime, events } = install();
  await runtime.verifyParity();
  await runtime.buildCompatibilitySnapshot();
  assert.equal(events.find((event) => event.name === 'stateV2.maintenance.parity').detail.foregroundBlocking, true);
  assert.equal(events.find((event) => event.name === 'stateV2.maintenance.compatibility').detail.foregroundBlocking, true);
});

test('dark Habit structure bridge loads performance instrumentation only through the dark preview path', () => {
  assert.match(structureBridge, /script\.src = '\/state_runtime_v2_perf\.js'/);
  assert.match(structureBridge, /if \(!isEnabled\(\) \|\| global\.TaskPointsStateRuntimeV2Perf\?\.installed/);
  assert.match(structureBridge, /loadPerfInstrumentation\(\);\s*return install\(\);/);
});

test('mobile V2 tracing hides the legacy live text wall without disabling trace collection', () => {
  assert.match(source, /#tp-perf-panel\{display:none!important\}/);
  assert.match(source, /\(max-width: 768px\)/);
  assert.match(source, /global\.TaskPointsPerf\?\.mark/);
  assert.match(source, /global\.TaskPointsPerf\?\.duration/);
});

test('V2 preview loads a shared serializer that deduplicates and sequences mutation transactions', () => {
  assert.match(source, /state_runtime_v2_serialization_guard\.js/);
  assert.match(serializationGuard, /const inFlight = new Map\(\)/);
  assert.match(serializationGuard, /const recent = new Map\(\)/);
  assert.match(serializationGuard, /const run = tail\.then/);
  assert.match(serializationGuard, /tail = run\.catch/);
  assert.match(serializationGuard, /stateV2\.serializationDeduped/);
  assert.match(serializationGuard, /applyHabitDelta/);
  assert.match(serializationGuard, /applyHabitOrderOverlay/);
  assert.match(serializationGuard, /applyHabitEditSnapshot/);
  assert.match(serializationGuard, /applyHabitPresenceSnapshot/);
});
