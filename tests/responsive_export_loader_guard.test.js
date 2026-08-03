const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fullSource = fs.readFileSync(path.join(__dirname, '..', 'inbox_count_badge.js'), 'utf8');
const marker = '(function loadTaskPointsResponsiveExport(global) {';
const markerIndex = fullSource.indexOf(marker);
if (markerIndex < 0) throw new Error('Responsive export loader was not found.');
const source = fullSource.slice(markerIndex);

function createButton() {
  const attrs = new Map();
  return {
    textContent: 'Export',
    disabled: false,
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); }
  };
}

function installLoader(overrides = {}) {
  const documentListeners = [];
  const removedListeners = [];
  const scriptListeners = {};
  const button = createButton();
  const script = {
    id: '',
    src: '',
    async: true,
    setAttribute() {},
    addEventListener(type, handler) { scriptListeners[type] = handler; }
  };

  const context = {
    console,
    Promise,
    Date,
    JSON,
    Object,
    Array,
    String,
    Map,
    Set,
    location: { pathname: '/today.html' },
    localStorage: { getItem() { return null; } },
    document: {
      readyState: 'complete',
      addEventListener(type, handler, capture) { documentListeners.push({ type, handler, capture }); },
      removeEventListener(type, handler, capture) { removedListeners.push({ type, handler, capture }); },
      querySelector(selector) { return selector === '[data-export-button]' ? button : null; },
      querySelectorAll(selector) { return selector === '[data-export-button]' ? [button] : []; },
      getElementById() { return null; },
      createElement(tag) { assert.equal(tag, 'script'); return script; },
      head: { appendChild(node) { assert.strictEqual(node, script); } },
      body: null,
      documentElement: null
    },
    addEventListener() {},
    setTimeout(callback) { callback(); return 1; },
    ...overrides
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'responsive-export-loader.js' });
  return { context, button, script, scriptListeners, documentListeners, removedListeners };
}

test('secondary-page snapshot prepares and persists the schedule before serialization', () => {
  let prepareCalls = 0;
  let savedSnapshot = null;
  const state = { tasks: [], completions: [], players: [], schedule: [] };
  const { context } = installLoader({
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      flushPendingSaves() {},
      loadAppState() { return { state }; },
      normalizeState(value) { return { ...value }; }
    },
    ensureUpcomingScheduleFallback(snapshot) {
      prepareCalls += 1;
      snapshot.schedule = [{ date: '2026-08-03', matchups: [] }];
      return true;
    },
    saveStateSnapshotFallback(snapshot) { savedSnapshot = snapshot; }
  });

  const payload = context.getTaskPointsExportSnapshot();
  assert.equal(prepareCalls, 1);
  assert.strictEqual(savedSnapshot, payload.state);
  assert.deepEqual(
    JSON.parse(JSON.stringify(payload.state.schedule)),
    [{ date: '2026-08-03', matchups: [] }]
  );
  assert.equal(payload.exportType, 'taskpoints_full_backup');
});

test('early repeated taps are captured and handed off as exactly one export', async () => {
  const { context, button, scriptListeners, documentListeners, removedListeners } = installLoader();
  const guard = documentListeners.find((entry) => entry.type === 'click' && entry.capture === true);
  assert.ok(guard, 'capture-phase loading guard should install immediately');

  let prevented = 0;
  let stopped = 0;
  const makeEvent = () => ({
    target: { closest(selector) { return selector === '[data-export-button]' ? button : null; } },
    preventDefault() { prevented += 1; },
    stopPropagation() {},
    stopImmediatePropagation() { stopped += 1; }
  });

  guard.handler(makeEvent());
  guard.handler(makeEvent());
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Preparing…');

  let starts = 0;
  context.TaskPointsResponsiveExport = {
    installed: true,
    startExport() { starts += 1; return Promise.resolve(); }
  };
  assert.equal(typeof scriptListeners.load, 'function');
  scriptListeners.load();
  await Promise.resolve();

  assert.equal(starts, 1);
  assert.equal(context.__tpResponsiveExportLoaderState.pending, false);
  assert.ok(removedListeners.some((entry) => entry.type === 'click' && entry.capture === true));
});
