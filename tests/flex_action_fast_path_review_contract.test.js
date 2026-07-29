const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'flex_action_fast_path.js'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_flex_completions_v1';

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows)); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

class FakeElement {
  constructor(className = '') { this.className = className; this.children = []; this.attributes = new Map(); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  closest(selector) { return selector === '.flex-action-row' ? this.row || null : null; }
  querySelector(selector) {
    if (selector === '.flex-action-usage') return this.usage || null;
    if (selector === '.flex-action-dots') return this.children.find((child) => child.className === 'flex-action-dots') || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.flex-action-dot') return this.children.filter((child) => String(child.className).split(/\s+/).includes('flex-action-dot'));
    return [];
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function completion(id, flexId = 'flex1') {
  return { id, taskId: null, flexId, title: '[Flex] Walk', points: 3, completedAtISO: `2026-07-29T12:00:0${id.length}.000Z`, source: 'flex' };
}

function makeHarness() {
  const baseline = { completions: [], flexActions: [{ id: 'flex1', name: 'Walk', points: 3 }] };
  const storage = new FakeStorage({ [STORAGE_KEY]: JSON.stringify(baseline) });
  const rafs = [];
  const timers = [];
  const listeners = {};
  const metrics = { saveCalls: 0, delays: [] };
  let nextTimerId = 0;
  let failSave = false;
  let idCounter = 0;

  const row = new FakeElement('flex-action-row');
  const usage = new FakeElement('flex-action-usage');
  row.usage = usage;
  const button = new FakeElement('btn');
  button.setAttribute('data-id', 'flex1');
  button.row = row;

  const core = {
    STORAGE_KEY,
    parseTaskPointsStorageJson: JSON.parse,
    loadAppState() { return { state: JSON.parse(storage.getItem(STORAGE_KEY)) }; },
    saveStateSnapshot(candidate, options = {}) {
      metrics.saveCalls += 1;
      if (failSave) throw new Error('forced failure');
      storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
      return { state: clone(candidate), options };
    },
    flushPendingSaves() {}
  };

  const context = {
    console,
    TaskPointsCore: core,
    localStorage: storage,
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      createElement: () => new FakeElement(),
      querySelectorAll: () => [button],
      addEventListener(type, fn) { (listeners[`document:${type}`] ||= []).push(fn); }
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    requestAnimationFrame(fn) { rafs.push(fn); return rafs.length; },
    cancelAnimationFrame() {},
    setTimeout(fn, delay = 0) {
      const item = { id: ++nextTimerId, fn, delay, canceled: false };
      timers.push(item);
      metrics.delays.push(delay);
      return item.id;
    },
    clearTimeout(id) { const item = timers.find((entry) => entry.id === id); if (item) item.canceled = true; },
    alert() {},
    confirm() { return true; },
    crypto: { randomUUID: () => `b-${++idCounter}` },
    Date, JSON, String, Number, Boolean, Object, Array, Map, Set, Math
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`
    var state = ${JSON.stringify(baseline)};
    var beforeSnapshotHook = null;
    var renderCount = 0;
    function addCompletion(entry) { state.completions.unshift(entry); }
    function save(savePath, extraOptions) {
      if (typeof beforeSnapshotHook === 'function') beforeSnapshotHook();
      var result = TaskPointsCore.saveStateSnapshot(state, Object.assign({ savePath: savePath }, extraOptions || {}));
      state = result.state;
    }
    function renderFlexActions() {}
    function renderAll() { renderCount += 1; }
    function scheduleRender(fn) { requestAnimationFrame(fn); }
    function flexBaseDate() { return new Date('2026-07-29T00:00:00'); }
    function isViewingFlexYesterday() { return false; }
    function logFlexCompletion(id) {
      var f = state.flexActions.find((entry) => entry.id === id);
      var d = flexBaseDate(); d.setHours(12,0,0,0);
      addCompletion({ id: crypto.randomUUID(), taskId: null, flexId: id, title: '[Flex] ' + f.name, points: f.points, completedAtISO: d.toISOString(), source: 'flex' });
      save(); renderFlexActions(); scheduleRender(renderAll);
    }
    function resetAll() { return false; }
    Object.defineProperties(this, {
      _state: { get: () => state },
      _renderCount: { get: () => renderCount },
      _setHook: { value: (fn) => { beforeSnapshotHook = fn; } }
    });
  `, context);
  vm.runInContext(source, context, { filename: 'flex_action_fast_path.js' });

  function flushRafs() { const batch = rafs.splice(0); batch.forEach((fn) => fn(Date.now())); }
  function flushTimers(limit = 100) {
    let ran = 0;
    while (ran < limit) {
      const item = timers.shift();
      if (!item) break;
      if (!item.canceled) { item.fn(); ran += 1; }
    }
    return ran;
  }
  function dispatchDocument(type, event = {}) { (listeners[`document:${type}`] || []).forEach((fn) => fn(event)); }

  return {
    context, storage, metrics, flushRafs, flushTimers, dispatchDocument,
    setFailSave(value) { failSave = value; },
    setBeforeSnapshot(fn) { context._setHook(fn); },
    state: () => context._state,
    renderCount: () => context._renderCount
  };
}

test('a drained shared journal refreshes from authoritative storage instead of writing a stale tab snapshot', () => {
  const h = makeHarness();
  h.context.logFlexCompletion('flex1');
  const own = h.state().completions[0];
  const other = completion('a');

  h.setBeforeSnapshot(() => {
    h.storage.setItem(STORAGE_KEY, JSON.stringify({ completions: [own, other], flexActions: [{ id: 'flex1', name: 'Walk', points: 3 }] }));
    h.storage.removeItem(JOURNAL_KEY);
    h.setBeforeSnapshot(null);
  });

  h.flushRafs();
  h.flushTimers(1);

  assert.equal(h.metrics.saveCalls, 0, 'the underlying full-snapshot writer must be skipped after another tab drained the journal');
  assert.deepEqual(JSON.parse(h.storage.getItem(STORAGE_KEY)).completions.map((entry) => entry.id).sort(), ['a', own.id].sort());
  assert.deepEqual(Array.from(h.state().completions, (entry) => entry.id).sort(), ['a', own.id].sort(), 'the stale tab is refreshed from authoritative storage');
});

test('persistent failures use bounded exponential retries without repeated heavy renders', () => {
  const h = makeHarness();
  h.setFailSave(true);
  h.context.logFlexCompletion('flex1');
  h.flushRafs();
  h.flushTimers(50);

  assert.equal(h.metrics.saveCalls, 6, 'one initial attempt plus five bounded retries');
  assert.deepEqual(h.metrics.delays.slice(0, 6), [0, 1000, 2000, 4000, 8000, 16000]);
  assert.equal(h.context.TaskPointsFlexActionFastPath.getRetryStatus().retryPaused, true);
  assert.equal(h.renderCount(), 0, 'failed retries must not trigger full Home renders');
  assert.ok(h.storage.getItem(JOURNAL_KEY), 'the unsaved completion remains protected');
});

test('a relevant resume event restarts a paused journal and clears it after storage becomes writable', () => {
  const h = makeHarness();
  h.setFailSave(true);
  h.context.logFlexCompletion('flex1');
  h.flushRafs();
  h.flushTimers(50);
  assert.equal(h.context.TaskPointsFlexActionFastPath.getRetryStatus().retryPaused, true);

  h.setFailSave(false);
  h.dispatchDocument('visibilitychange');
  h.flushRafs();
  h.flushTimers(10);
  h.flushRafs();

  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  assert.equal(h.context.TaskPointsFlexActionFastPath.getRetryStatus().retryPaused, false);
  assert.equal(h.renderCount(), 1);
});
