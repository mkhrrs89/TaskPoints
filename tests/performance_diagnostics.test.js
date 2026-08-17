const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'performance_diagnostics.js'), 'utf8');

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    dump() { return Object.fromEntries(map); }
  };
}

function run(search = '', seed = {}) {
  const sessionStorage = storage(seed);
  let clock = 10;
  const listeners = new Map();
  const document = {
    title: 'TaskPoints',
    readyState: 'loading',
    body: null,
    addEventListener(name, fn) { listeners.set(name, fn); },
    getElementById() { return null; }
  };
  const context = {
    window: null,
    globalThis: null,
    location: { search, pathname: '/index.html', origin: 'https://taskpoints.test', href: `https://taskpoints.test/index.html${search}` },
    sessionStorage,
    document,
    navigator: { userAgent: 'test', hardwareConcurrency: 4 },
    performance: { now: () => (clock += 5), timeOrigin: 1000, getEntriesByType: () => [] },
    URLSearchParams,
    URL,
    JSON,
    Set,
    Map,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Promise,
    Error,
    console,
    setTimeout: () => 1,
    addEventListener() {},
    requestAnimationFrame: () => 1
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'performance_diagnostics.js' });
  return { context, sessionStorage, listeners };
}

test('diagnostics stay completely dormant by default', () => {
  const { context, sessionStorage } = run('');
  assert.equal(context.TaskPointsPerf, undefined);
  assert.equal(sessionStorage.getItem('tp_perf_trace_enabled_v1'), null);
});

test('perf=1 enables a session trace and exposes report controls', () => {
  const { context, sessionStorage } = run('?perf=1');
  assert.equal(sessionStorage.getItem('tp_perf_trace_enabled_v1'), '1');
  assert.equal(context.TaskPointsPerf?.enabled, true);
  assert.equal(typeof context.TaskPointsPerf.buildReport, 'function');
  context.TaskPointsPerf.mark('test.mark', { ok: true });
  context.TaskPointsPerf.duration('test.duration', 123.4);
  context.TaskPointsPerf.recordBundleReady();
  const report = context.TaskPointsPerf.buildReport();
  assert.equal(report.currentPath, '/index.html');
  assert.ok(report.eventCount >= 4);
  assert.ok(report.topDurations.some((row) => row.name === 'test.duration'));
  assert.ok(report.topDurations.some((row) => row.name === 'core.bundle.evaluate'));
});

test('loadAppState trace records options and caller information only while tracing is enabled', () => {
  const { context } = run('?perf=1');
  context.TaskPointsCore = {
    loadAppState(options = {}) { return { state: {}, options }; }
  };
  context.TaskPointsPerf.installHooks();

  vm.runInNewContext(`
    globalThis.invokeLoadAppStateFromVm = function invokeLoadAppStateFromVm() {
      return TaskPointsCore.loadAppState({ syncDerived: true, persistSync: false, preloadedState: { tasks: [] } });
    };
  `, context);

  const result = context.invokeLoadAppStateFromVm();
  assert.deepEqual(result.state, {});
  const report = context.TaskPointsPerf.buildReport();
  const event = report.pages.flatMap((page) => page.events || []).find((row) => row.name === 'core.loadAppState');
  assert.ok(event, 'expected a core.loadAppState duration event');
  assert.equal(event.detail?.syncDerived, true);
  assert.equal(event.detail?.persistSync, false);
  assert.equal(event.detail?.hasPreloadedState, true);
  assert.match(String(event.detail?.caller || event.detail?.stack || ''), /invokeLoadAppStateFromVm|evalmachine/);
});

test('perf=0 disables tracing for the session', () => {
  const { context, sessionStorage } = run('?perf=0', { tp_perf_trace_enabled_v1: '1' });
  assert.equal(context.TaskPointsPerf, undefined);
  assert.equal(sessionStorage.getItem('tp_perf_trace_enabled_v1'), null);
});
