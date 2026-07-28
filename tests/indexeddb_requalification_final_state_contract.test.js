const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_final_state.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');

const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows).map(([key, value]) => [String(key), String(value)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function element(text = '', disabled = false, allowed = 'true') {
  return {
    textContent: text,
    disabled,
    dataset: { allowed },
    id: '',
    closest() { return this; },
    click() {}
  };
}

function install(mode, gateStatus, options = {}) {
  const elements = {
    overallTitle: element('Reading your saved copies…'),
    overallDetail: element('Nothing will switch or write while this page is opening.'),
    modeValue: element('Checking'),
    actionMessage: element('Reading all saved copies…'),
    startTestBtn: element('Start short test', true, 'false'),
    finishTestBtn: element('Finish test and turn on faster mode', true, 'false'),
    refreshBtn: element('Refresh read-only checks', Boolean(options.refreshDisabled))
  };
  Object.entries(elements).forEach(([id, value]) => { value.id = id; });

  const documentListeners = new Map();
  const windowListeners = new Map();
  const localStorage = new FakeStorage({
    [MODE_KEY]: mode,
    [GATE_KEY]: JSON.stringify({ status: gateStatus })
  });
  const timers = [];
  let nextTimerId = 1;
  let refreshes = 0;
  let reloads = 0;

  function fakeSetTimeout(handler) {
    const timer = { id: nextTimerId++, handler, cancelled: false };
    timers.push(timer);
    return timer.id;
  }

  function fakeClearTimeout(id) {
    const timer = timers.find((entry) => entry.id === id);
    if (timer) timer.cancelled = true;
  }

  function runNextTimer() {
    while (timers.length) {
      const timer = timers.shift();
      if (timer.cancelled) continue;
      timer.handler();
      return true;
    }
    return false;
  }

  function renderCurrentState() {
    const currentMode = localStorage.getItem(MODE_KEY) || 'off';
    const currentGate = JSON.parse(localStorage.getItem(GATE_KEY) || '{}');
    const activeTest = currentMode === 'verify_primary_writes'
      && ['awaiting_smoke_test', 'ready_for_fast_mode'].includes(currentGate.status);
    elements.modeValue.textContent = currentMode === 'indexeddb_primary'
      ? 'Faster mode'
      : (currentMode === 'verify_primary_writes' ? 'Short test mode' : 'Safe mode');
    elements.overallTitle.textContent = activeTest ? 'Ready to check your edit and reopen' : 'Read-only checks passed';
    elements.overallDetail.textContent = activeTest
      ? 'Press Finish when you have made the harmless edit and fully closed and reopened the normal TaskPoints app.'
      : 'Nothing has been written or switched. Press Start to load the full two-step safety test.';
    elements.actionMessage.textContent = 'This page has only read your saved copies so far.';
    elements.startTestBtn.disabled = activeTest;
    elements.startTestBtn.dataset.allowed = activeTest ? 'false' : 'true';
    elements.finishTestBtn.disabled = !activeTest;
    elements.finishTestBtn.dataset.allowed = activeTest ? 'true' : 'false';
  }

  elements.refreshBtn.click = () => {
    if (elements.refreshBtn.disabled) return;
    refreshes += 1;
    if (options.refreshFails) return;
    if (options.asyncRefresh) fakeSetTimeout(renderCurrentState);
    else renderCurrentState();
  };

  const document = {
    readyState: 'complete',
    documentElement: {},
    getElementById: (id) => elements[id] || null,
    addEventListener(type, handler) { documentListeners.set(type, handler); }
  };
  const context = {
    document,
    localStorage,
    location: { reload() { reloads += 1; } },
    JSON,
    Object,
    Array,
    String,
    Boolean,
    Promise,
    Error,
    console,
    queueMicrotask,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    addEventListener(type, handler) { windowListeners.set(type, handler); }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'indexeddb_requalification_final_state.js' });
  return {
    context,
    elements,
    documentListeners,
    windowListeners,
    localStorage,
    runNextTimer,
    getRefreshes: () => refreshes,
    getReloads: () => reloads
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('final-state guard loads after the read-only loader', () => {
  assert.ok(PAGE.indexOf('indexeddb_requalification_loader.js') < PAGE.indexOf('indexeddb_requalification_final_state.js'));
  assert.doesNotThrow(() => new vm.Script(SOURCE));
});

test('completed Faster Mode renders a final screen and disables both test actions from the initial loading UI', () => {
  const { elements, context } = install('indexeddb_primary', 'fast_mode_enabled');
  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
  assert.match(elements.overallDetail.textContent, /working copy and backups remain in place/i);
  assert.equal(elements.modeValue.textContent, 'Faster mode');
  assert.match(elements.actionMessage.textContent, /No further setup action is needed/i);
  assert.equal(elements.startTestBtn.disabled, true);
  assert.equal(elements.startTestBtn.dataset.allowed, 'false');
  assert.equal(elements.finishTestBtn.disabled, true);
  assert.equal(elements.finishTestBtn.dataset.allowed, 'false');
  assert.equal(context.TaskPointsRequalificationFinalState.isFasterModeEnabled(), true);
});

test('ending the exact final state reruns the real read-only render instead of restoring the loading snapshot', async () => {
  const { elements, context, localStorage, windowListeners, getRefreshes } = install('indexeddb_primary', 'fast_mode_enabled');
  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('storage')({ key: MODE_KEY });
  await settle();

  assert.equal(getRefreshes(), 1);
  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(elements.modeValue.textContent, 'Safe mode');
  assert.equal(elements.startTestBtn.disabled, false);
  assert.equal(elements.startTestBtn.dataset.allowed, 'true');
  assert.equal(elements.finishTestBtn.disabled, true);
  assert.equal(elements.finishTestBtn.dataset.allowed, 'false');
  assert.equal(context.TaskPointsRequalificationFinalState.ownsUi(), false);
});

test('ending final state waits for a busy Refresh button and rerenders when it becomes available', async () => {
  const { elements, context, localStorage, windowListeners, runNextTimer, getRefreshes } = install(
    'indexeddb_primary',
    'fast_mode_enabled',
    { refreshDisabled: true }
  );
  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('storage')({ key: MODE_KEY });
  await settle();

  assert.equal(getRefreshes(), 0);
  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
  assert.equal(context.TaskPointsRequalificationFinalState.ownsUi(), true);

  elements.refreshBtn.disabled = false;
  runNextTimer();
  await settle();

  assert.equal(getRefreshes(), 1);
  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(elements.modeValue.textContent, 'Safe mode');
  assert.equal(elements.startTestBtn.disabled, false);
  assert.equal(context.TaskPointsRequalificationFinalState.ownsUi(), false);
});

test('ownership remains until an asynchronous read-only render visibly replaces the final screen', async () => {
  const { elements, context, localStorage, windowListeners, runNextTimer, getRefreshes } = install(
    'indexeddb_primary',
    'fast_mode_enabled',
    { asyncRefresh: true }
  );
  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('storage')({ key: MODE_KEY });
  await settle();

  assert.equal(getRefreshes(), 1);
  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
  assert.equal(context.TaskPointsRequalificationFinalState.ownsUi(), true);
  assert.equal(context.TaskPointsRequalificationFinalState.releaseInFlight(), true);

  runNextTimer();
  context.TaskPointsRequalificationFinalState.reconcileState();

  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(context.TaskPointsRequalificationFinalState.ownsUi(), false);
  assert.equal(context.TaskPointsRequalificationFinalState.releaseInFlight(), false);
});

test('a failed asynchronous handoff retries and then reloads without releasing the stale final screen', async () => {
  const { elements, context, localStorage, windowListeners, runNextTimer, getRefreshes, getReloads } = install(
    'indexeddb_primary',
    'fast_mode_enabled',
    { refreshFails: true }
  );
  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('storage')({ key: MODE_KEY });
  await settle();

  for (let index = 0; index < 4; index += 1) {
    runNextTimer();
    await settle();
  }

  assert.equal(getRefreshes(), 3);
  assert.equal(getReloads(), 1);
  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
  assert.equal(context.TaskPointsRequalificationFinalState.ownsUi(), true);
});

test('back-forward-cache restore also recomputes the current Off-mode setup state', async () => {
  const { elements, localStorage, windowListeners, getRefreshes } = install('indexeddb_primary', 'fast_mode_enabled');
  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('pageshow')({ persisted: true });
  await settle();

  assert.equal(getRefreshes(), 1);
  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(elements.startTestBtn.disabled, false);
});

test('guard does not interfere with a short test that is still active', () => {
  const { elements, context, getRefreshes } = install('verify_primary_writes', 'awaiting_smoke_test');
  assert.equal(elements.overallTitle.textContent, 'Reading your saved copies…');
  assert.equal(elements.startTestBtn.disabled, true);
  assert.equal(elements.finishTestBtn.disabled, true);
  assert.equal(context.TaskPointsRequalificationFinalState.isFasterModeEnabled(), false);
  assert.equal(getRefreshes(), 0);
});

test('completed Faster Mode blocks accidental Start or Finish clicks before target handlers run', () => {
  const { elements, documentListeners } = install('indexeddb_primary', 'fast_mode_enabled');
  const click = documentListeners.get('click');
  let prevented = 0;
  let stopped = 0;
  click({
    target: elements.startTestBtn,
    preventDefault() { prevented += 1; },
    stopImmediatePropagation() { stopped += 1; }
  });
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(elements.startTestBtn.disabled, true);
});
