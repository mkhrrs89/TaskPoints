const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_serialization_guard.js'), 'utf8');

function install(options = {}) {
  const calls = [];
  let firstGateResolve = null;
  let firstGate = null;
  if (options.holdFirst) {
    firstGate = new Promise((resolve) => { firstGateResolve = resolve; });
  }

  const applyHabitDelta = async (payload) => {
    calls.push(payload.state);
    if (firstGate && calls.length === 1) await firstGate;
    return { committed: true, state: payload.state, call: calls.length };
  };

  const runtime = {
    applyHabitDelta,
    applyHabitOrderOverlay: async () => ({ committed: true }),
    applyHabitEditSnapshot: async () => ({ committed: true }),
    applyHabitPresenceSnapshot: async () => ({ committed: true })
  };
  const marks = [];
  const context = {
    TaskPointsStateRuntimeV2: runtime,
    TaskPointsPerf: { mark(name, detail) { marks.push({ name, detail }); } },
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    Map,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'state_runtime_v2_serialization_guard.js' });
  return { context, runtime, calls, marks, releaseFirst: () => firstGateResolve?.() };
}

function payload(state) {
  return { habitId: 'h1', dayKey: '2026-09-11', mutationId: `same-${state}`, state };
}

test('adjacent identical completed requests may reuse the recent result', async () => {
  const { context, runtime, calls } = install();
  const first = await runtime.applyHabitDelta(payload('full'));
  const second = await runtime.applyHabitDelta(payload('full'));

  assert.equal(first.state, 'full');
  assert.equal(second.state, 'full');
  assert.deepEqual(calls, ['full']);
  const status = context.TaskPointsStateRuntimeV2SerializationGuard.getStatus();
  assert.equal(status.deduped, 1);
  assert.equal(status.completed, 1);
  assert.equal(status.requestSequence, 2);
});

test('A then B then A is never swallowed by the recent duplicate cache', async () => {
  const { context, runtime, calls } = install();
  await runtime.applyHabitDelta(payload('full'));
  await runtime.applyHabitDelta(payload('off'));
  const final = await runtime.applyHabitDelta(payload('full'));

  assert.deepEqual(calls, ['full', 'off', 'full']);
  assert.equal(final.state, 'full');
  const status = context.TaskPointsStateRuntimeV2SerializationGuard.getStatus();
  assert.equal(status.deduped, 0);
  assert.equal(status.completed, 3);
  assert.equal(status.requestSequence, 3);
});

test('A then B then A remains ordered even while the first A is still in flight', async () => {
  const { context, runtime, calls, releaseFirst } = install({ holdFirst: true });
  const firstA = runtime.applyHabitDelta(payload('full'));
  const middleB = runtime.applyHabitDelta(payload('off'));
  const finalA = runtime.applyHabitDelta(payload('full'));

  await Promise.resolve();
  assert.deepEqual(calls, ['full']);
  releaseFirst();
  const results = await Promise.all([firstA, middleB, finalA]);

  assert.deepEqual(calls, ['full', 'off', 'full']);
  assert.deepEqual(results.map((row) => row.state), ['full', 'off', 'full']);
  const status = context.TaskPointsStateRuntimeV2SerializationGuard.getStatus();
  assert.equal(status.deduped, 0);
  assert.equal(status.completed, 3);
});

test('truly adjacent identical in-flight requests still coalesce', async () => {
  const { context, runtime, calls, releaseFirst, marks } = install({ holdFirst: true });
  const first = runtime.applyHabitDelta(payload('full'));
  const duplicate = runtime.applyHabitDelta(payload('full'));

  await Promise.resolve();
  assert.deepEqual(calls, ['full']);
  releaseFirst();
  const [a, b] = await Promise.all([first, duplicate]);

  assert.equal(a.state, 'full');
  assert.equal(b.state, 'full');
  assert.deepEqual(calls, ['full']);
  assert.equal(context.TaskPointsStateRuntimeV2SerializationGuard.getStatus().deduped, 1);
  const dedupeMark = marks.find((row) => row.name === 'stateV2.serializationDeduped');
  assert.equal(dedupeMark.detail.phase, 'inflight');
  assert.equal(dedupeMark.detail.adjacent, true);
});


test('requests with distinct explicit revision preconditions never reuse a cached result', async () => {
  const { runtime, calls } = install();
  await runtime.applyHabitDelta(payload('full'), { expectedRevision: 1 });
  await runtime.applyHabitDelta(payload('full'), { expectedRevision: 2 });
  assert.deepEqual(calls, ['full', 'full']);
});
