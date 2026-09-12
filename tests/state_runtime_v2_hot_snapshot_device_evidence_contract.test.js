const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const reviewer = require(path.join(__dirname, '..', 'state_runtime_v2_trace_review.js'));
const editSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_habit_edit_bridge.js'), 'utf8');
const structureSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_habit_structure_bridge.js'), 'utf8');
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';

async function flushQueue() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function baseStatus() {
  return {
    lastParity: { checked: true, match: true },
    mirroredMutations: 4,
    mirroredOrderMutations: 1,
    mirroredEditMutations: 1,
    mirroredPresenceMutations: 1,
    mirrorFailures: 0,
    traceDiagnostics: {
      perf: {
        mutationClasses: {
          completion: { syncEnqueues: 1, asyncMutations: 0, asyncFailures: 0, maxSyncEnqueueMs: 1, maxMutationMs: 0 },
          order: { syncEnqueues: 1, asyncMutations: 0, asyncFailures: 0, maxSyncEnqueueMs: 1, maxMutationMs: 0 },
          edit: { syncEnqueues: 1, asyncMutations: 0, asyncFailures: 0, maxSyncEnqueueMs: 1, maxMutationMs: 0 },
          presence: { syncEnqueues: 1, asyncMutations: 0, asyncFailures: 0, maxSyncEnqueueMs: 1, maxMutationMs: 0 }
        }
      },
      maintenanceIdle: {
        deepQuietMs: 20000,
        deepQuietDeferrals: 1,
        deepQuietReleases: 1,
        deepQuietPreemptions: 3,
        executed: 1,
        failures: 0
      },
      serialization: { failures: 0 },
      acceptance: {
        directForegroundMaintenanceCalls: 0,
        automaticParityDeepIdleObserved: true,
        noV2FailuresObserved: true,
        deepQuietMs: 20000
      }
    }
  };
}

test('device reviewer keeps all four mutation classes proven after transaction and commit events leave the trace ring', () => {
  const report = {
    stateRuntimeV2Status: baseStatus(),
    pages: [{
      path: '/',
      events: [
        { epochMs: 1000, type: 'duration', name: 'stateV2.enqueue.completion.sync', durationMs: 1, detail: {} },
        { epochMs: 1100, type: 'duration', name: 'stateV2.enqueue.order.sync', durationMs: 1, detail: {} },
        { epochMs: 1200, type: 'duration', name: 'stateV2.enqueue.edit.sync', durationMs: 1, detail: {} },
        { epochMs: 1210, type: 'duration', name: 'stateV2.capture.edit.sync', durationMs: 7, detail: {} },
        { epochMs: 1300, type: 'duration', name: 'stateV2.enqueue.presence.sync', durationMs: 1, detail: {} },
        { epochMs: 1310, type: 'duration', name: 'stateV2.capture.presence.sync', durationMs: 2, detail: {} },
        { epochMs: 2000, type: 'mark', name: 'stateV2.maintenance.parity.deepDeferred', detail: {} },
        { epochMs: 23000, type: 'mark', name: 'stateV2.maintenance.parity.deepReleased', detail: { preemptionCount: 3, lastInteractionAgoMs: 20050 } }
      ]
    }]
  };

  const result = reviewer.review(report);
  assert.equal(result.mutationClasses.completion.durableCommitCount, 1);
  assert.equal(result.mutationClasses.order.durableCommitCount, 1);
  assert.equal(result.mutationClasses.edit.durableCommitCount, 1);
  assert.equal(result.mutationClasses.presence.durableCommitCount, 1);
  assert.equal(result.mutationClasses.edit.transactionCount, 0);
  assert.equal(result.mutationClasses.edit.commitCount, 1);
  assert.equal(result.mutationClasses.edit.maxCaptureMs, 7);
  assert.equal(result.mutationClasses.edit.maxForegroundSyncMs, 7);
  assert.equal(result.mutationClasses.presence.maxCaptureMs, 2);
  assert.equal(result.allMutationClassesObserved, true);
  assert.equal(result.interactionPreemptionObserved, true);
  assert.equal(result.evidenceCompleteForDeviceTrace, true);
});

function editHarness() {
  const durations = [];
  const applied = [];
  let legacyCalls = 0;
  let tick = 0;
  const state = {
    habits: [
      { id: 'h1', name: 'Read', updatedAtISO: 'before' },
      { id: 'h2', name: 'Walk', updatedAtISO: 'before' }
    ],
    completions: [
      { id: 'c1', habitId: 'h1', points: 4 },
      ...Array.from({ length: 250 }, (_, index) => ({ id: `u${index}`, habitId: 'h2', points: 1 })),
      { id: 'c2', habitId: 'h1', points: 4 }
    ]
  };
  const runtime = {
    enqueueHabitEditFromLegacy() { legacyCalls += 1; return Promise.resolve({ committed: true }); },
    applyHabitEditSnapshot(snapshot) { applied.push(snapshot); return Promise.resolve({ committed: true, revision: applied.length }); },
    getStatus() { return { currentGeneration: 'g1' }; }
  };
  const context = {
    state,
    TaskPointsStateRuntimeV2: runtime,
    TaskPointsPerf: { mark() {}, duration(name, durationMs, detail) { durations.push({ name, durationMs, detail }); } },
    localStorage: { getItem(key) { return key === DARK_MODE_KEY ? '1' : null; } },
    structuredClone,
    performance: { now() { tick += 0.5; return tick; } },
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Promise,
    console: { warn() {} },
    saveHabitEdit(id) { state.habits.find((habit) => habit.id === id).updatedAtISO = 'after'; },
    document: { readyState: 'complete', addEventListener() {} },
    setTimeout(fn) { fn(); return 1; },
    addEventListener() {}
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(editSource, context, { filename: 'state_runtime_v2_habit_edit_bridge.js' });
  return { context, runtime, applied, durations, legacyCalls: () => legacyCalls };
}

test('Habit edit bridge snapshots only the hot affected Habit/completions and avoids the persisted-state fallback', async () => {
  const harness = editHarness();
  harness.context.saveHabitEdit('h1');
  await flushQueue();

  assert.equal(harness.legacyCalls(), 0);
  assert.equal(harness.applied.length, 1);
  assert.equal(harness.applied[0].habitId, 'h1');
  assert.equal(harness.applied[0].habit.name, 'Read');
  assert.equal(harness.applied[0].completionEntries.length, 2);
  assert.equal(
    Array.from(harness.applied[0].completionEntries, (entry) => String(entry.value.id)).join(','),
    'c1,c2'
  );
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitEditBridge.getStatus().hotSnapshotRequests, 1);
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitEditBridge.getStatus().legacyFallbackRequests, 0);
  assert.equal(harness.durations.some((row) => row.name === 'stateV2.capture.edit.sync'), true);
});

test('hot edit enqueue is not rewrapped outside perf/maintenance wrapper chains', () => {
  const harness = editHarness();
  const hot = harness.runtime.enqueueHabitEditFromLegacy;
  function outer() { return hot.apply(this, arguments); }
  Object.defineProperty(outer, '__taskPointsOriginal', { value: hot });
  harness.runtime.enqueueHabitEditFromLegacy = outer;
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitEditBridge.installHotEditEnqueue(), true);
  assert.equal(harness.runtime.enqueueHabitEditFromLegacy, outer);
});

function structureHarness() {
  const durations = [];
  const applied = [];
  let legacyCalls = 0;
  let tick = 0;
  const state = { habits: [{ id: 'h1', name: 'Read', updatedAtISO: 'before', retired: false }], completions: [] };
  let nextId = 2;
  const runtime = {
    enqueueHabitPresenceFromLegacy() { legacyCalls += 1; return Promise.resolve({ committed: true }); },
    applyHabitPresenceSnapshot(snapshot) { applied.push(snapshot); return Promise.resolve({ committed: true, revision: applied.length }); },
    enqueueHabitEditFromLegacy() { return Promise.resolve({ committed: true }); },
    getStatus() { return { currentGeneration: 'g1' }; }
  };
  const context = {
    state,
    TaskPointsStateRuntimeV2: runtime,
    TaskPointsPerf: { mark() {}, duration(name, durationMs, detail) { durations.push({ name, durationMs, detail }); } },
    localStorage: { getItem(key) { return key === DARK_MODE_KEY ? '1' : null; } },
    structuredClone,
    performance: { now() { tick += 0.25; return tick; } },
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Promise,
    console: { warn() {} },
    addHabit() { state.habits.push({ id: `h${nextId++}`, name: 'Added', updatedAtISO: 'new' }); },
    addVice() { state.habits.push({ id: `h${nextId++}`, name: 'Vice', category: 'vice', updatedAtISO: 'new' }); },
    deleteHabit(id) { state.habits = state.habits.filter((habit) => habit.id !== id); },
    retireHabit(id) { const habit = state.habits.find((row) => row.id === id); if (habit) { habit.retired = true; habit.updatedAtISO = 'after'; } },
    document: { readyState: 'complete', addEventListener() {} },
    setTimeout(fn) { fn(); return 1; },
    addEventListener() {}
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(structureSource, context, { filename: 'state_runtime_v2_habit_structure_bridge.js' });
  return { context, runtime, state, applied, durations, legacyCalls: () => legacyCalls };
}

test('Habit add/delete presence bridge uses a tiny hot snapshot instead of reparsing persisted state', async () => {
  const harness = structureHarness();
  harness.context.addHabit();
  await flushQueue();
  assert.equal(harness.legacyCalls(), 0);
  assert.equal(harness.applied.length, 1);
  assert.equal(harness.applied[0].habitId, 'h2');
  assert.equal(harness.applied[0].exists, true);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.applied[0], 'completions'), false);

  harness.context.deleteHabit('h2');
  await flushQueue();
  assert.equal(harness.applied.length, 2);
  assert.equal(harness.applied[1].habitId, 'h2');
  assert.equal(harness.applied[1].exists, false);
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitStructureBridge.getStatus().hotPresenceSnapshotRequests, 2);
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitStructureBridge.getStatus().legacyFallbackRequests, 0);
  assert.equal(harness.durations.some((row) => row.name === 'stateV2.capture.presence.sync'), true);
});

test('hot presence enqueue is not rewrapped outside perf/maintenance wrapper chains', () => {
  const harness = structureHarness();
  const hot = harness.runtime.enqueueHabitPresenceFromLegacy;
  function outer() { return hot.apply(this, arguments); }
  Object.defineProperty(outer, '__taskPointsOriginal', { value: hot });
  harness.runtime.enqueueHabitPresenceFromLegacy = outer;
  assert.equal(harness.context.TaskPointsStateRuntimeV2HabitStructureBridge.installHotPresenceEnqueue(), true);
  assert.equal(harness.runtime.enqueueHabitPresenceFromLegacy, outer);
});
