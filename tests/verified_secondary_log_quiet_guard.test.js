const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GUARD = fs.readFileSync(path.join(ROOT, 'verified_secondary_log_quiet_guard.js'), 'utf8');
const LOADER = fs.readFileSync(path.join(ROOT, 'habit_completion_source_guard.js'), 'utf8');

function installHarness() {
  const timers = [];
  const marks = [];
  let originalCalls = 0;
  let runs = 0;
  const idleStatus = {
    lastInteractionAgoMs: 1500,
    navigationQuietForMs: 0,
    pageLeaving: false,
    activeEditor: false
  };
  const core = {
    whenStorageMaintenanceQuiet(run) {
      originalCalls += 1;
      return Promise.resolve().then(run);
    },
    getStorageMaintenanceIdleStatus() {
      return { ...idleStatus };
    }
  };
  const context = {
    TaskPointsCore: core,
    document: { visibilityState: 'visible' },
    TaskPointsPerf: { mark(name, detail) { marks.push({ name, detail }); } },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    Promise, Object, Array, String, Number, Boolean, RegExp, Error, Math, Date, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(GUARD, context, { filename: 'verified_secondary_log_quiet_guard.js' });
  return {
    core,
    timers,
    marks,
    idleStatus,
    originalCalls: () => originalCalls,
    runs: () => runs,
    makeRun: () => () => { runs += 1; return true; }
  };
}

async function assertGuardedOperationWaits(source, expectedKind) {
  const h = installHarness();
  assert.equal(h.core.getLogLongMaintenanceQuietGuardStatus().requiredQuietMs, 8000);

  const pending = h.core.whenStorageMaintenanceQuiet(h.makeRun(), { source });
  assert.equal(h.runs(), 0);
  assert.equal(h.originalCalls(), 0);
  assert.equal(h.timers.length, 1);

  h.idleStatus.lastInteractionAgoMs = 7999;
  h.timers.shift().fn();
  assert.equal(h.runs(), 0);
  assert.equal(h.originalCalls(), 0);

  h.idleStatus.lastInteractionAgoMs = 8000;
  h.timers.shift().fn();
  await pending;
  assert.equal(h.originalCalls(), 1);
  assert.equal(h.runs(), 1);

  const status = h.core.getLogLongMaintenanceQuietGuardStatus();
  assert.equal(status.deferredByOperation[expectedKind], 1);
  assert.equal(status.releasedByOperation[expectedKind], 1);
}

test('Log verified-secondary maintenance waits for eight seconds of uninterrupted quiet', async () => {
  await assertGuardedOperationWaits('phase5c_verified_secondary', 'phase5c');
});

test('Log Phase 2 shadow dual-write waits for the same eight-second quiet window', async () => {
  await assertGuardedOperationWaits('phase2_dual_write_coalesced', 'phase2');
});

test('Log toolbar background maintenance waits for the same eight-second quiet window', async () => {
  await assertGuardedOperationWaits('toolbar_background_maintenance', 'toolbar');
});

test('unrelated maintenance keeps the original shared idle behavior', async () => {
  const h = installHarness();
  await h.core.whenStorageMaintenanceQuiet(h.makeRun(), { source: 'phase3_cache_refresh' });
  assert.equal(h.originalCalls(), 1);
  assert.equal(h.runs(), 1);
  assert.equal(h.timers.length, 0);
});

test('the guard is loaded only by the Log-page loader', () => {
  assert.match(LOADER, /verified_secondary_log_quiet_guard\.js\?v=20260816-1/);
  assert.match(LOADER, /pathname === '\/log'/);
  assert.match(LOADER, /pathname\.endsWith\('\/log\.html'\)/);
  assert.match(LOADER, /data-taskpoints-verified-secondary-log-quiet-guard/);
});
