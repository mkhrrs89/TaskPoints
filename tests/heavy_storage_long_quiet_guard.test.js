const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'storage_maintenance_idle.js'), 'utf8');
const marker = ';(function installTaskPointsHeavyStorageLongQuietGuard';
const start = source.indexOf(marker);
assert.notEqual(start, -1, 'heavy storage quiet guard should be present');
const guardSource = source.slice(start);

test('storage maintenance bundle remains valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'storage_maintenance_idle.js' }));
});

test('heavy Home mirrors wait for 20 seconds of sustained quiet', async () => {
  let idle = {
    lastInteractionAgoMs: 5000,
    navigationQuietForMs: 0,
    pageLeaving: false,
    activeEditor: false
  };
  const timers = [];
  const marks = [];
  let runs = 0;
  let ordinaryRuns = 0;

  const core = {
    whenStorageMaintenanceQuiet(run) {
      return Promise.resolve().then(run);
    },
    getStorageMaintenanceIdleStatus() {
      return { ...idle };
    }
  };

  const context = {
    TaskPointsCore: core,
    document: { visibilityState: 'visible' },
    location: { pathname: '/' },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    Promise,
    Set,
    Array,
    Number,
    String,
    console,
    TaskPointsPerf: {
      mark(name, detail) { marks.push({ name, detail }); }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(guardSource, context, { filename: 'heavy_storage_long_quiet_guard.js' });

  await core.whenStorageMaintenanceQuiet(() => { ordinaryRuns += 1; }, { source: 'some-light-maintenance' });
  assert.equal(ordinaryRuns, 1, 'unrelated maintenance should keep the existing quiet behavior');

  const heavyPromise = core.whenStorageMaintenanceQuiet(() => { runs += 1; }, { source: 'phase5c_verified_secondary' });
  await Promise.resolve();
  assert.equal(runs, 0);
  assert.equal(timers.length > 0, true);
  assert.equal(marks.some((entry) => entry.name === 'storage.heavyMaintenanceDeferred'), true);

  idle = { ...idle, lastInteractionAgoMs: 20050 };
  while (timers.length) timers.shift()();
  await heavyPromise;

  assert.equal(runs, 1);
  assert.equal(marks.some((entry) => entry.name === 'storage.heavyMaintenanceReleased'), true);
  assert.equal(core.getHeavyStorageLongQuietGuardStatus().requiredQuietMs, 20000);
});

test('phase2 dual-write uses the same deep-idle gate', async () => {
  const timers = [];
  let idle = {
    lastInteractionAgoMs: 19999,
    navigationQuietForMs: 0,
    pageLeaving: false,
    activeEditor: false
  };
  let runs = 0;
  const core = {
    whenStorageMaintenanceQuiet(run) { return Promise.resolve().then(run); },
    getStorageMaintenanceIdleStatus() { return { ...idle }; }
  };
  const context = {
    TaskPointsCore: core,
    document: { visibilityState: 'visible' },
    location: { pathname: '/index.html' },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    Promise,
    Set,
    Array,
    Number,
    String,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(guardSource, context);

  const promise = core.whenStorageMaintenanceQuiet(() => { runs += 1; }, { reason: 'phase2_dual_write_coalesced' });
  await Promise.resolve();
  assert.equal(runs, 0);

  idle = { ...idle, lastInteractionAgoMs: 21000 };
  while (timers.length) timers.shift()();
  await promise;
  assert.equal(runs, 1);
});
