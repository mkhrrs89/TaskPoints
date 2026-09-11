const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_perf.js'), 'utf8');
const serializationGuard = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_serialization_guard.js'), 'utf8');
const structureBridge = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_habit_structure_bridge.js'), 'utf8');

function install(options = {}) {
  const events = [];
  let tick = 0;
  const runtime = {
    applyHabitDelta: async () => ({ committed: true, revision: 2 }),
    applyHabitOrderOverlay: async (payload) => ({ committed: true, revision: 3, payload }),
    applyHabitEditSnapshot: async () => ({ committed: true, revision: 4 }),
    applyHabitPresenceSnapshot: async () => ({ committed: true, revision: 5 }),
    enqueueHabitOrderOverlay: () => Promise.resolve(true),
    enqueueHabitEditFromLegacy: () => Promise.resolve(true),
    enqueueHabitPresenceFromLegacy: () => Promise.resolve(true),
    verifyParity: async () => ({ match: true }),
    buildCompatibilitySnapshot: async () => ({ habits: [], completions: [] }),
    getStatus: () => ({ installed: true, darkEnabled: true, hookInstalled: options.publicCompletionEnqueue === false })
  };
  if (options.publicCompletionEnqueue !== false) runtime.enqueueHabitDelta = () => Promise.resolve(true);
  const core = {
    writePendingHabitDelta(delta) { return { ...delta, journaled: true }; }
  };
  const context = {
    TaskPointsStateRuntimeV2: runtime,
    TaskPointsCore: core,
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
  return { context, runtime, core, events };
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
  assert.equal(status.asyncFailures, 0);
  assert.equal(status.mutationClasses.completion.syncEnqueues, 1);
  assert.equal(status.mutationClasses.completion.asyncMutations, 1);
});

test('completion enqueue timing falls back to the installed pending-Habit journal when the runtime enqueue is lexical-only', () => {
  const { context, core, events } = install({ publicCompletionEnqueue: false });
  const result = core.writePendingHabitDelta({ habitId: 'h1', dayKey: '2026-09-11', status: 'full' });

  assert.equal(result.journaled, true);
  const enqueue = events.find((event) => event.name === 'stateV2.enqueue.completion.sync');
  assert.ok(enqueue);
  assert.equal(enqueue.detail.foregroundBlocking, true);
  assert.equal(enqueue.detail.source, 'pending-habit-journal');
  assert.equal(context.TaskPointsStateRuntimeV2Perf.getStatus().completionJournalEnqueueBridgeInstalled, true);
  assert.equal(context.TaskPointsStateRuntimeV2Perf.getStatus().mutationClasses.completion.syncEnqueues, 1);
});

test('runtime status exported by the generic perf trace includes V2 perf, deep-idle, serializer, and acceptance summaries', () => {
  const { context, runtime } = install();
  context.TaskPointsStateRuntimeV2MaintenanceIdle = {
    getStatus: () => ({ installed: true, deepQuietMs: 20000, deepQuietPending: 1, failures: 0 })
  };
  context.TaskPointsStateRuntimeV2SerializationGuard = {
    getStatus: () => ({ installed: true, active: 2, maxQueueDepth: 3, failures: 0 })
  };

  const status = runtime.getStatus();
  assert.equal(status.darkEnabled, true);
  assert.equal(status.traceDiagnostics.perf.installed, true);
  assert.equal(status.traceDiagnostics.maintenanceIdle.deepQuietMs, 20000);
  assert.equal(status.traceDiagnostics.maintenanceIdle.deepQuietPending, 1);
  assert.equal(status.traceDiagnostics.serialization.active, 2);
  assert.equal(status.traceDiagnostics.serialization.maxQueueDepth, 3);
  assert.equal(status.traceDiagnostics.acceptance.deepQuietMs, 20000);
  assert.equal(status.traceDiagnostics.acceptance.physicalDeviceEvidenceStillRequired, true);
  assert.equal(runtime.getStatus.__taskPointsV2TraceStatusBridge, true);
  assert.equal(typeof runtime.getStatus.__taskPointsOriginal, 'function');
});

test('acceptance snapshot summarizes all four mutation classes and distinguishes automatic idle work from direct foreground maintenance', async () => {
  const { context, runtime } = install();
  context.TaskPointsStateRuntimeV2MaintenanceIdle = {
    getStatus: () => ({
      installed: true,
      deepQuietMs: 20000,
      deepQuietDeferrals: 1,
      deepQuietReleases: 1,
      executed: 1,
      failures: 0
    })
  };
  context.TaskPointsStateRuntimeV2SerializationGuard = {
    getStatus: () => ({ installed: true, failures: 0 })
  };

  await runtime.enqueueHabitDelta({ habitId: 'h1', dayKey: '2026-09-06' });
  await runtime.applyHabitDelta({ habitId: 'h1', dayKey: '2026-09-06' });
  await runtime.enqueueHabitOrderOverlay({ orders: { h1: 1, h2: 2 } });
  await runtime.applyHabitOrderOverlay({ orders: { h1: 1, h2: 2 } });
  await runtime.enqueueHabitEditFromLegacy({ habitId: 'h1' });
  await runtime.applyHabitEditSnapshot({ habitId: 'h1', completionRows: [] });
  await runtime.enqueueHabitPresenceFromLegacy({ habitId: 'h2', exists: false });
  await runtime.applyHabitPresenceSnapshot({ habitId: 'h2', exists: false });

  const beforeDirect = context.TaskPointsStateRuntimeV2Perf.getAcceptanceSnapshot();
  assert.equal(beforeDirect.allMutationClassesObserved, true);
  assert.equal(beforeDirect.mutationClasses.completion.syncEnqueues, 1);
  assert.equal(beforeDirect.mutationClasses.order.asyncMutations, 1);
  assert.equal(beforeDirect.mutationClasses.edit.asyncFailures, 0);
  assert.equal(beforeDirect.mutationClasses.presence.asyncMutations, 1);
  assert.equal(beforeDirect.directForegroundMaintenanceCalls, 0);
  assert.equal(beforeDirect.noDirectForegroundMaintenanceObserved, true);
  assert.equal(beforeDirect.automaticParityDeepIdleObserved, true);
  assert.equal(beforeDirect.noV2FailuresObserved, true);
  assert.equal(beforeDirect.physicalDeviceEvidenceStillRequired, true);

  await runtime.verifyParity();
  const afterDirect = context.TaskPointsStateRuntimeV2Perf.getAcceptanceSnapshot();
  assert.equal(afterDirect.directForegroundMaintenanceCalls, 1);
  assert.equal(afterDirect.noDirectForegroundMaintenanceObserved, false);
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
  assert.match(structureBridge, /script\.src = '\/state_runtime_v2_perf\.js\?v=20260911-5'/);
  assert.match(structureBridge, /if \(!isEnabled\(\) \|\| global\.TaskPointsStateRuntimeV2Perf\?\.installed/);
  assert.match(structureBridge, /loadPerfInstrumentation\(\);\s*loadLiveTraceReview\(\);\s*return install\(\);/);
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
