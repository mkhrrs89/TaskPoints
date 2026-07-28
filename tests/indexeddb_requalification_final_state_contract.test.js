const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_final_state.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows).map(([key, value]) => [String(key), String(value)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function element(text = '') {
  return {
    textContent: text,
    disabled: false,
    dataset: { allowed: 'true' },
    id: '',
    closest() { return this; }
  };
}

function install(mode, gateStatus) {
  const elements = {
    overallTitle: element('Read-only checks passed'),
    overallDetail: element('Nothing has been written or switched. Press Start to load the full two-step safety test.'),
    modeValue: element(mode === 'indexeddb_primary' ? 'Faster mode' : 'Safe mode'),
    actionMessage: element('This page has only read your saved copies so far.'),
    startTestBtn: element('Start short test'),
    finishTestBtn: element('Finish test and turn on faster mode')
  };
  Object.entries(elements).forEach(([id, value]) => { value.id = id; });
  const listeners = new Map();
  const windowListeners = new Map();
  const document = {
    readyState: 'complete',
    documentElement: {},
    getElementById: (id) => elements[id] || null,
    addEventListener(type, handler) { listeners.set(type, handler); }
  };
  const localStorage = new FakeStorage({
    taskpoints_phase4_storage_mode_v1: mode,
    taskpoints_indexeddb_requalification_v1: JSON.stringify({ status: gateStatus })
  });
  const context = {
    document,
    localStorage,
    JSON,
    Object,
    Array,
    String,
    Boolean,
    Promise,
    Error,
    console,
    queueMicrotask,
    setTimeout,
    addEventListener(type, handler) { windowListeners.set(type, handler); }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'indexeddb_requalification_final_state.js' });
  return { context, elements, listeners, windowListeners, localStorage };
}

test('final-state guard loads after the read-only loader', () => {
  assert.ok(PAGE.indexOf('indexeddb_requalification_loader.js') < PAGE.indexOf('indexeddb_requalification_final_state.js'));
  assert.doesNotThrow(() => new vm.Script(SOURCE));
});

test('completed Faster Mode renders a final screen and disables both test actions', () => {
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

test('guard does not interfere with a short test that is still active', () => {
  const { elements, context } = install('verify_primary_writes', 'awaiting_smoke_test');
  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(elements.startTestBtn.disabled, false);
  assert.equal(elements.finishTestBtn.disabled, false);
  assert.equal(context.TaskPointsRequalificationFinalState.isFasterModeEnabled(), false);
});

test('completed Faster Mode blocks accidental Start or Finish clicks before target handlers run', () => {
  const { elements, listeners } = install('indexeddb_primary', 'fast_mode_enabled');
  const click = listeners.get('click');
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

test('turning Faster Mode off releases the final screen and restores the re-test controls', () => {
  const { elements, context, localStorage } = install('indexeddb_primary', 'fast_mode_enabled');
  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
  assert.equal(elements.startTestBtn.disabled, true);

  localStorage.setItem('taskpoints_phase4_storage_mode_v1', 'off');
  assert.equal(context.TaskPointsRequalificationFinalState.syncState(), true);

  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.match(elements.overallDetail.textContent, /Press Start to load the full two-step safety test/i);
  assert.equal(elements.modeValue.textContent, 'Faster mode');
  assert.equal(elements.actionMessage.textContent, 'This page has only read your saved copies so far.');
  assert.equal(elements.startTestBtn.disabled, false);
  assert.equal(elements.startTestBtn.dataset.allowed, 'true');
  assert.equal(elements.finishTestBtn.disabled, false);
  assert.equal(elements.finishTestBtn.dataset.allowed, 'true');
  assert.equal(context.TaskPointsRequalificationFinalState.isFasterModeEnabled(), false);
});
