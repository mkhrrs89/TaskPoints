const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_maintenance_idle.js'), 'utf8');
const perfSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_perf.js'), 'utf8');

function install(options = {}) {
  let darkEnabled = false;
  let underlyingParityCalls = 0;
  let directParityCalls = 0;
  let compatibilityCalls = 0;
  let tick = 0;
  let idle = options.idleStatus ? { ...options.idleStatus } : null;
  const jobs = [];
  const timers = [];
  const events = [];
  const eventHandlers = new Map();

  async function parityOriginal() {
    underlyingParityCalls += 1;
    if (typeof options.onParity === 'function') return options.onParity();
    return { checked: true, match: true };
  }

  async function parityDirectWrapper() {
    directParityCalls += 1;
    return parityOriginal();
  }
  Object.defineProperty(parityDirectWrapper, '__taskPointsOriginal', { value: parityOriginal });

  async function compatibilityOriginal() {
    compatibilityCalls += 1;
    return { habits: [], completions: [] };
  }
  async function compatibilityDirectWrapper() {
    return compatibilityOriginal();
  }
  Object.defineProperty(compatibilityDirectWrapper, '__taskPointsOriginal', { value: compatibilityOriginal });

  const runtime = {
    enqueueHabitDelta: () => Promise.resolve({ committed: true, revision: 2 }),
    enqueueHabitOrderOverlay: () => Promise.resolve({ committed: true, revision: 3 }),
    enqueueHabitEditFromLegacy: () => Promise.resolve({ committed: true, revision: 4 }),
    enqueueHabitPresenceFromLegacy: () => Promise.resolve({ committed: true, revision: 5 }),
    verifyParity: parityDirectWrapper,
    buildCompatibilitySnapshot: compatibilityDirectWrapper,
    getStatus: () => ({ installed: true, darkEnabled })
  };

  const core = {};
  if (options.coordinator !== false) {
    core.whenStorageMaintenanceQuiet = (run, maintenanceOptions) => new Promise((resolve, reject) => {
      jobs.push({ run, maintenanceOptions, resolve, reject });
    });
  }
  if (idle) core.getStorageMaintenanceIdleStatus = () => ({ ...idle });

  const document = {
    visibilityState: 'visible',
    addEventListener(name, handler) {
      const handlers = eventHandlers.get(name) || [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
    }
  };

  const context = {
    TaskPointsStateRuntimeV2: runtime,
    TaskPointsCore: core,
    TaskPointsPerf: {
      mark(name, detail) { events.push({ type: 'mark', name, detail }); },
      duration(name, durationMs, detail) { events.push({ type: 'duration', name, durationMs, detail }); }
    },
    document,
    performance: { now() { tick += 0.25; return tick; } },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Promise,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'state_runtime_v2_maintenance_idle.js' });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  async function runNextJob() {
    const job = jobs.shift();
    assert.ok(job, 'expected a queued idle maintenance job');
    try {
      const result = await job.run();
      job.resolve(result);
      await flush();
      return result;
    } catch (error) {
      job.reject(error);
      await flush();
      throw error;
    }
  }

  async function runNextTimer() {
    const timer = timers.shift();
    assert.ok(timer, 'expected a queued deep-idle timer');
    timer();
    await flush();
  }

  return {
    context,
    runtime,
    core,
    jobs,
    timers,
    events,
    flush,
    runNextJob,
    runNextTimer,
    dispatchInteraction(name = 'pointerdown') {
      for (const handler of eventHandlers.get(name) || []) handler({ type: name, isTrusted: true });
    },
    setDark(value) { darkEnabled = value === true; },
    setIdle(value) {
      idle = value ? { ...value } : null;
      if (idle && typeof core.getStorageMaintenanceIdleStatus !== 'function') {
        core.getStorageMaintenanceIdleStatus = () => ({ ...idle });
      }
    },
    counts() { return { underlyingParityCalls, directParityCalls, compatibilityCalls }; }
  };
}

test('mutation completion schedules parity behind the existing quiet-maintenance coordinator without delaying the mutation promise', async () => {
  const env = install();
  env.setDark(true);

  const mutationPromise = env.runtime.enqueueHabitDelta({ habitId: 'h1', dayKey: '2026-09-09' });
  const mutationResult = await mutationPromise;
  assert.equal(mutationResult.committed, true);
  await env.flush();

  assert.equal(env.jobs.length, 1);
  assert.equal(env.counts().underlyingParityCalls, 0);
  assert.equal(env.counts().directParityCalls, 0);
  assert.equal(env.jobs[0].maintenanceOptions.reason, 'state_v2_background_parity');

  await env.runNextJob();
  assert.equal(env.counts().underlyingParityCalls, 1);
  assert.equal(env.counts().directParityCalls, 0, 'idle maintenance bypasses the direct foreground perf wrapper');

  const durationEvent = env.events.find((event) => event.type === 'duration' && event.name === 'stateV2.maintenance.parity');
  assert.ok(durationEvent);
  assert.equal(durationEvent.detail.foregroundBlocking, false);
  assert.equal(durationEvent.detail.scheduled, true);
});

test('V2 background parity waits for 20 seconds of sustained quiet before entering the shared maintenance coordinator', async () => {
  const env = install({
    idleStatus: {
      lastInteractionAgoMs: 5000,
      navigationQuietForMs: 0,
      pageLeaving: false,
      activeEditor: false
    }
  });
  env.setDark(true);
  const api = env.context.TaskPointsStateRuntimeV2MaintenanceIdle;

  const parityPromise = api.scheduleParityVerification({ source: 'deep-idle-test' });
  await env.flush();
  assert.equal(env.jobs.length, 0);
  assert.equal(env.timers.length, 1);
  assert.equal(api.getStatus().deepQuietMs, 20000);
  assert.equal(api.getStatus().deepQuietPending, 1);

  env.setIdle({
    lastInteractionAgoMs: 12000,
    navigationQuietForMs: 0,
    pageLeaving: false,
    activeEditor: false
  });
  await env.runNextTimer();
  assert.equal(env.jobs.length, 0);
  assert.equal(env.timers.length, 1, 'continued activity window should keep deep verification deferred');

  env.setIdle({
    lastInteractionAgoMs: 20050,
    navigationQuietForMs: 0,
    pageLeaving: false,
    activeEditor: false
  });
  await env.runNextTimer();
  assert.equal(env.jobs.length, 1);
  assert.equal(api.getStatus().deepQuietPending, 0);
  assert.equal(api.getStatus().deepQuietReleases, 1);

  await env.runNextJob();
  await parityPromise;
  assert.equal(env.counts().underlyingParityCalls, 1);
  assert.equal(env.events.some((event) => event.name === 'stateV2.maintenance.parity.deepDeferred'), true);
  assert.equal(env.events.some((event) => event.name === 'stateV2.maintenance.parity.deepReleased'), true);
});

test('interaction during a deep-idle wait is preserved on the release event even if generic trace interaction marks disappear', async () => {
  const env = install({
    idleStatus: {
      lastInteractionAgoMs: 5000,
      navigationQuietForMs: 0,
      pageLeaving: false,
      activeEditor: false
    }
  });
  env.setDark(true);
  const api = env.context.TaskPointsStateRuntimeV2MaintenanceIdle;

  const parityPromise = api.scheduleParityVerification({ source: 'preemption-test' });
  await env.flush();
  assert.equal(env.timers.length, 1);

  env.dispatchInteraction('pointerdown');
  env.setIdle({
    lastInteractionAgoMs: 100,
    navigationQuietForMs: 0,
    pageLeaving: false,
    activeEditor: false
  });
  await env.runNextTimer();
  assert.equal(env.jobs.length, 0);
  assert.equal(api.getStatus().deepQuietPreemptions, 1);

  env.setIdle({
    lastInteractionAgoMs: 20050,
    navigationQuietForMs: 0,
    pageLeaving: false,
    activeEditor: false
  });
  await env.runNextTimer();
  assert.equal(env.jobs.length, 1);

  const release = env.events.find((event) => event.name === 'stateV2.maintenance.parity.deepReleased');
  assert.ok(release);
  assert.equal(release.detail.preemptionCount, 1);
  assert.equal(release.detail.lastInteractionAgoMs, 20050);
  assert.equal(env.events.some((event) => event.name === 'stateV2.maintenance.parity.preempted'), true);

  await env.runNextJob();
  await parityPromise;
});

test('rapid mutation requests coalesce into one parity pass when they all arrive before idle execution', async () => {
  const env = install();
  env.setDark(true);

  await Promise.all([
    env.runtime.enqueueHabitDelta({ habitId: 'h1', dayKey: '2026-09-09' }),
    env.runtime.enqueueHabitOrderOverlay({ orders: { h1: 1, h2: 2 } }),
    env.runtime.enqueueHabitEditFromLegacy('h1')
  ]);
  await env.flush();

  assert.equal(env.jobs.length, 1);
  const before = env.context.TaskPointsStateRuntimeV2MaintenanceIdle.getStatus();
  assert.equal(before.lanes.parity.requested, 3);
  assert.ok(before.coalesced >= 2);

  await env.runNextJob();
  const after = env.context.TaskPointsStateRuntimeV2MaintenanceIdle.getStatus();
  assert.equal(env.counts().underlyingParityCalls, 1);
  assert.equal(after.lanes.parity.completed, 3);
  assert.equal(env.jobs.length, 0);
});

test('a mutation arriving while parity is already running causes a second quiet pass instead of being swallowed', async () => {
  let releaseParity;
  let parityStartedResolve;
  const parityStarted = new Promise((resolve) => { parityStartedResolve = resolve; });
  const gate = new Promise((resolve) => { releaseParity = resolve; });
  let first = true;
  const env = install({
    onParity: async () => {
      if (first) {
        first = false;
        parityStartedResolve();
        await gate;
      }
      return { checked: true, match: true };
    }
  });
  env.setDark(true);

  await env.runtime.enqueueHabitDelta({ habitId: 'h1', dayKey: '2026-09-09' });
  await env.flush();
  assert.equal(env.jobs.length, 1);

  const firstJobPromise = env.runNextJob();
  await parityStarted;
  await env.runtime.enqueueHabitPresenceFromLegacy('h2');
  await env.flush();

  releaseParity();
  await firstJobPromise;
  await env.flush();
  assert.equal(env.jobs.length, 1, 'new mutation during parity should schedule a follow-up quiet pass');

  await env.runNextJob();
  assert.equal(env.counts().underlyingParityCalls, 2);
  assert.equal(env.context.TaskPointsStateRuntimeV2MaintenanceIdle.getStatus().lanes.parity.completed, 2);
});

test('direct parity remains immediate for explicit diagnostic/export-style callers', async () => {
  const env = install();
  env.setDark(true);
  const result = await env.runtime.verifyParity();
  assert.equal(result.match, true);
  assert.equal(env.counts().directParityCalls, 1);
  assert.equal(env.counts().underlyingParityCalls, 1);
  assert.equal(env.jobs.length, 0);
});

test('dark-off and missing-coordinator cases fail closed without running heavyweight maintenance', async () => {
  const env = install({ coordinator: false });
  const api = env.context.TaskPointsStateRuntimeV2MaintenanceIdle;

  const darkOff = await api.scheduleParityVerification({ source: 'test' });
  assert.equal(darkOff.reason, 'dark_disabled');

  env.setDark(true);
  const noCoordinator = await api.scheduleParityVerification({ source: 'test' });
  assert.equal(noCoordinator.reason, 'idle_coordinator_unavailable');
  assert.equal(env.counts().underlyingParityCalls, 0);
  const status = api.getStatus();
  assert.equal(status.idleCoordinatorAvailable, false);
  assert.equal(status.lanes.parity.requested, 1);
  assert.equal(status.lanes.parity.completed, 1);
  assert.equal(status.lanes.parity.active, false);
});

test('performance preview loader includes the V2 idle maintenance module with a cache-busted URL', () => {
  assert.match(perfSource, /state_runtime_v2_maintenance_idle\.js\?v=20260911-2/);
  assert.match(perfSource, /data-taskpoints-state-v2-maintenance-idle/);
  assert.match(source, /whenStorageMaintenanceQuiet/);
  assert.match(source, /DEEP_QUIET_MS = 20000/);
  assert.match(source, /preemptionCount/);
  assert.match(source, /foregroundBlocking: false/);
});
