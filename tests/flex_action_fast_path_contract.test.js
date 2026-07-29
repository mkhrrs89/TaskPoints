const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'flex_action_fast_path.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_flex_completions_v1';

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows)); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

class FakeElement {
  constructor(className = '') {
    this.className = className;
    this.children = [];
    this.attributes = new Map();
    this.parent = null;
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
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

function makeHarness(options = {}) {
  const baseline = { completions: [], flexActions: [{ id: 'flex1', name: 'Walk', points: 3 }] };
  const storage = new FakeStorage({ [STORAGE_KEY]: JSON.stringify(baseline), ...(options.storageRows || {}) });
  const rafs = [];
  const timers = [];
  const listeners = {};
  let storedState = clone(baseline);
  const metrics = { saveCalls: 0, fullRenderCalls: 0, fallbackFlexRenderCalls: 0, toastCalls: 0, lastSaveOptions: null };
  let idCounter = 0;
  let confirmResult = options.confirmResult ?? true;

  const row = new FakeElement('flex-action-row');
  const usage = new FakeElement('flex-action-usage');
  row.usage = usage;
  row.appendChild(usage);
  const button = new FakeElement('btn');
  button.setAttribute('data-act', 'flex-do');
  button.setAttribute('data-id', 'flex1');
  button.row = row;

  const core = {
    STORAGE_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    loadAppState() { return { state: clone(storedState) }; },
    saveStateSnapshot(candidate, saveOptions = {}) {
      metrics.saveCalls += 1;
      metrics.lastSaveOptions = clone(saveOptions);
      if (options.failSave) throw new Error('forced save failure');
      storedState = clone(candidate);
      storage.setItem(STORAGE_KEY, JSON.stringify(storedState));
      return { state: clone(candidate), options: saveOptions };
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
      querySelectorAll: (selector) => selector === '[data-act="flex-do"][data-id]' ? [button] : [],
      addEventListener(type, fn) { (listeners[`document:${type}`] ||= []).push(fn); }
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    requestAnimationFrame(fn) { rafs.push(fn); return rafs.length; },
    cancelAnimationFrame() {},
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
    confirm() { return confirmResult; },
    alert() {},
    crypto: { randomUUID: () => `completion-${++idCounter}` },
    metrics,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    Math
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`
    var state = ${JSON.stringify(baseline)};
    var lastFlexCompletion = null;
    function addCompletion(entry) { state.completions.unshift(entry); metrics.toastCalls += 1; }
    function save(savePath, extraOptions) {
      var result = TaskPointsCore.saveStateSnapshot(state, Object.assign({ savePath: savePath }, extraOptions || {}));
      state = result.state;
    }
    function renderFlexActions() { metrics.fallbackFlexRenderCalls += 1; }
    function renderAll() { metrics.fullRenderCalls += 1; }
    function scheduleRender(fn) { requestAnimationFrame(fn); }
    function flexBaseDate() { return new Date('2026-07-29T00:00:00'); }
    function isViewingFlexYesterday() { return false; }
    function logFlexCompletion(id) {
      var f = state.flexActions.find((entry) => entry.id === id);
      if (!f || f.retired) return;
      var completionDate = flexBaseDate();
      completionDate.setHours(12, 0, 0, 0);
      addCompletion({
        id: crypto.randomUUID(), taskId: null, flexId: id, title: '[Flex] ' + f.name,
        points: f.points || 0, completedAtISO: completionDate.toISOString(), source: 'flex'
      });
      lastFlexCompletion = { id: id, at: Date.now() };
      save();
      renderFlexActions();
      scheduleRender(renderAll);
    }
    function resetAll() {
      if (!confirm('reset?')) return false;
      localStorage.removeItem('${STORAGE_KEY}');
      state = { completions: [], flexActions: [] };
      return true;
    }
    Object.defineProperties(this, {
      _state: { get: () => state },
      _saveCalls: { get: () => metrics.saveCalls },
      _fullRenderCalls: { get: () => metrics.fullRenderCalls },
      _fallbackFlexRenderCalls: { get: () => metrics.fallbackFlexRenderCalls },
      _toastCalls: { get: () => metrics.toastCalls },
      _lastSaveOptions: { get: () => metrics.lastSaveOptions }
    });
  `, context);

  if (options.recoveryLocked) {
    context.TaskPointsRecoveryJournalWriteLockGuard = {
      readLock: () => ({ active: true }),
      pageMayWrite: () => false
    };
  }
  if (options.recoveryAttempt) {
    context.TaskPointsRecoveryAttemptWriteLockGuard = { readAttemptLock: () => ({ active: true }) };
  }

  vm.runInContext(source, context, { filename: 'flex_action_fast_path.js' });

  return {
    context,
    core,
    storage,
    rafs,
    timers,
    listeners,
    usage,
    getState: () => context._state,
    getSaveCalls: () => context._saveCalls,
    getFullRenderCalls: () => context._fullRenderCalls,
    getFallbackFlexRenderCalls: () => context._fallbackFlexRenderCalls,
    getToastCalls: () => context._toastCalls,
    getLastSaveOptions: () => context._lastSaveOptions
  };
}

function flushRafs(harness) {
  const callbacks = harness.rafs.splice(0);
  callbacks.forEach((callback) => callback(Date.now()));
}

function flushTimers(harness, limit = 20) {
  let count = 0;
  while (harness.timers.length && count < limit) {
    const callback = harness.timers.shift();
    callback();
    count += 1;
  }
}

test('the worker bundles the Flex Action fast path after the home modules', () => {
  assert.match(workerSource, /'\/flex_action_fast_path\.js'/);
  assert.match(workerSource, /if \(flexActionFastPathSource\) sources\.push\(flexActionFastPathSource\)/);
});

test('a Flex Action tap paints its orange dot before any full-state save or full render', () => {
  const h = makeHarness();
  h.context.logFlexCompletion('flex1');

  assert.equal(h.getState().completions.length, 1);
  assert.equal(h.getToastCalls(), 1);
  assert.equal(h.getSaveCalls(), 0, 'the full snapshot save must not block the input event');
  assert.equal(h.getFullRenderCalls(), 0, 'the heavy home render must not run before first paint');
  assert.equal(h.getFallbackFlexRenderCalls(), 0, 'the fast row update should avoid rebuilding the whole Flex list');
  const dots = h.usage.querySelector('.flex-action-dots');
  assert.ok(dots);
  assert.equal(dots.querySelectorAll('.flex-action-dot').length, 1);
  assert.equal(JSON.parse(h.storage.getItem(JOURNAL_KEY)).length, 1);

  flushRafs(h);
  assert.equal(h.getSaveCalls(), 0, 'the frame is reserved for painting the dot');
  flushTimers(h, 1);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  flushRafs(h);
  assert.equal(h.getFullRenderCalls(), 1);
});

test('rapid Flex Action taps coalesce into one verified background snapshot', () => {
  const h = makeHarness();
  h.context.logFlexCompletion('flex1');
  h.context.logFlexCompletion('flex1');

  assert.equal(h.getState().completions.length, 2);
  assert.equal(h.usage.querySelector('.flex-action-dots').querySelectorAll('.flex-action-dot').length, 2);
  assert.equal(JSON.parse(h.storage.getItem(JOURNAL_KEY)).length, 2);

  flushRafs(h);
  flushTimers(h, 1);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(JSON.parse(h.storage.getItem(STORAGE_KEY)).completions.length, 2);
});

test('the background save uses the interactive packed-save path', () => {
  const h = makeHarness();
  h.context.logFlexCompletion('flex1');
  flushRafs(h);
  flushTimers(h, 1);
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.getLastSaveOptions().interactive, true);
  assert.equal(h.getLastSaveOptions().deferCompression, true);
  assert.equal(h.getLastSaveOptions().userInitiated, true);
  assert.equal(h.getLastSaveOptions().savePath, 'flex-completion-fast-path');
});

test('pending Flex completions replay after a reload and pagehide flushes them synchronously', () => {
  const h = makeHarness();
  h.context.logFlexCompletion('flex1');
  const loaded = h.core.loadAppState();
  assert.equal(loaded.state.completions.length, 1);
  assert.equal(loaded.pendingFlexCompletions, 1);

  h.listeners.pagehide[0]();
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
});

test('core flushes include pending Flex completions before exports or reset paths continue', () => {
  const h = makeHarness();
  h.context.logFlexCompletion('flex1');
  h.core.flushPendingSaves();
  assert.equal(h.getSaveCalls(), 1);
  assert.equal(h.storage.getItem(JOURNAL_KEY), null);
});

test('a confirmed Reset All clears the pending Flex journal, while a canceled reset does not erase unsaved evidence', () => {
  const confirmed = makeHarness({ failSave: true, confirmResult: true });
  confirmed.context.logFlexCompletion('flex1');
  confirmed.context.resetAll();
  assert.equal(confirmed.storage.getItem(JOURNAL_KEY), null);

  const canceled = makeHarness({ failSave: true, confirmResult: false });
  canceled.context.logFlexCompletion('flex1');
  canceled.context.resetAll();
  assert.ok(canceled.storage.getItem(JOURNAL_KEY));
});

test('recovery locks block the tiny journal before the in-memory completion or dot changes', () => {
  for (const options of [{ recoveryLocked: true }, { recoveryAttempt: true }]) {
    const h = makeHarness(options);
    assert.throws(() => h.context.logFlexCompletion('flex1'), /recovery protection is active/);
    assert.equal(h.getState().completions.length, 0);
    assert.equal(h.usage.querySelector('.flex-action-dots'), null);
    assert.equal(h.storage.getItem(JOURNAL_KEY), null);
  }
});

test('a malformed pending Flex journal is preserved rather than overwritten', () => {
  const h = makeHarness({ storageRows: { [JOURNAL_KEY]: '{bad-json' } });
  assert.throws(() => h.context.logFlexCompletion('flex1'), /journal is malformed/);
  assert.equal(h.storage.getItem(JOURNAL_KEY), '{bad-json');
  assert.equal(h.getState().completions.length, 0);
});
