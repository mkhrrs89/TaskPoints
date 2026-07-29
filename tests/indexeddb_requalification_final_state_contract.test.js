const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_loader.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification.html'), 'utf8');

const STORAGE_KEY = 'taskpoints_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
const HABIT_JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
const SECONDARY_DB = 'taskpoints_verified_secondary_v1';
const VAULT_DB = 'taskpoints_safety_vault_v1';
const COUNT_KEYS = [
  'tasks', 'completions', 'habits', 'players', 'flexActions',
  'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders',
  'weightHistory', 'vo2MaxHistory'
];
const MAJOR_KEYS = ['tasks', 'completions', 'habits', 'players', 'gameHistory', 'matchups', 'seasonHistory'];

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows).map(([key, value]) => [String(key), String(value)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
  clear() { this.rows.clear(); }
}

function rawHash(raw) {
  const text = String(raw || '');
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function countsFor(state) {
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, Array.isArray(state?.[key]) ? state[key].length : 0]));
  counts.total = COUNT_KEYS.reduce((sum, key) => sum + counts[key], 0);
  counts.majorTotal = MAJOR_KEYS.reduce((sum, key) => sum + counts[key], 0);
  return counts;
}

function vaultCountsFor(state) {
  const keys = [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders'
  ];
  const counts = Object.fromEntries(keys.map((key) => [key, Array.isArray(state?.[key]) ? state[key].length : 0]));
  counts.total = keys.reduce((sum, key) => sum + counts[key], 0);
  counts.majorTotal = MAJOR_KEYS.reduce((sum, key) => sum + counts[key], 0);
  return counts;
}

function element(id, text = '') {
  const listeners = new Map();
  return {
    id,
    textContent: text,
    innerHTML: '',
    disabled: id !== 'refreshBtn',
    dataset: { allowed: id === 'refreshBtn' ? 'true' : 'false' },
    addEventListener(type, handler) {
      const rows = listeners.get(type) || [];
      rows.push(handler);
      listeners.set(type, rows);
    },
    click() {
      const event = {
        target: this,
        preventDefault() {},
        stopImmediatePropagation() { this.stopped = true; }
      };
      for (const handler of listeners.get('click') || []) {
        handler(event);
        if (event.stopped) break;
      }
    }
  };
}

function createIndexedDB(records, delayMs = 0) {
  let activeReads = 0;
  let maxActiveReads = 0;

  function createDb(name) {
    return {
      objectStoreNames: { contains: (store) => store === 'snapshots' },
      transaction() {
        const transaction = { error: null };
        transaction.objectStore = () => ({
          get(id) {
            const request = {};
            activeReads += 1;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
            setTimeout(() => {
              request.result = JSON.parse(JSON.stringify(records[name]?.[id] || null));
              request.onsuccess?.();
              setTimeout(() => {
                activeReads -= 1;
                transaction.oncomplete?.();
              }, 0);
            }, delayMs);
            return request;
          }
        });
        return transaction;
      },
      close() {}
    };
  }

  return {
    databases: async () => [{ name: SECONDARY_DB }, { name: VAULT_DB }],
    open(name) {
      const request = {};
      setTimeout(() => {
        request.result = createDb(name);
        request.onsuccess?.();
      }, 0);
      return request;
    },
    getMaxActiveReads: () => maxActiveReads
  };
}

function makeState() {
  return {
    tasks: [{ id: 'task' }],
    completions: Array.from({ length: 40 }, (_, id) => ({ id })),
    habits: [{ id: 'habit' }],
    players: Array.from({ length: 12 }, (_, id) => ({ id })),
    flexActions: [{ id: 'flex' }],
    gameHistory: Array.from({ length: 20 }, (_, id) => ({ id })),
    matchups: Array.from({ length: 20 }, (_, id) => ({ id })),
    schedule: [{ id: 'schedule' }],
    seasonHistory: [{ id: 'season' }],
    reminders: [{ id: 'reminder' }],
    weightHistory: Array.from({ length: 3 }, (_, id) => ({ id })),
    vo2MaxHistory: Array.from({ length: 2 }, (_, id) => ({ id }))
  };
}

function install(mode = 'indexeddb_primary', gateStatus = 'fast_mode_enabled', delayMs = 0, options = {}) {
  const state = makeState();
  const raw = JSON.stringify(state);
  const fullCounts = countsFor(state);
  const records = {
    [SECONDARY_DB]: {
      latest: { id: 'latest', raw, rawHash: rawHash(raw), counts: fullCounts, status: options.secondaryStatus || 'passed_verification' }
    },
    [VAULT_DB]: {
      latest: { id: 'latest', raw, rawHash: rawHash(raw), counts: vaultCountsFor(state) }
    }
  };
  const indexedDB = createIndexedDB(records, delayMs);
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: raw,
    [MODE_KEY]: mode,
    [GATE_KEY]: JSON.stringify({ status: gateStatus })
  });
  const elements = {
    overallTitle: element('overallTitle', 'Reading your saved copies…'),
    overallDetail: element('overallDetail', 'Nothing will switch or write while this page is opening.'),
    modeValue: element('modeValue', 'Checking'),
    recordValue: element('recordValue', '—'),
    backupValue: element('backupValue', '—'),
    holdValue: element('holdValue', '—'),
    checks: element('checks'),
    startTestBtn: element('startTestBtn', 'Start short test'),
    finishTestBtn: element('finishTestBtn', 'Finish test and turn on faster mode'),
    refreshBtn: element('refreshBtn', 'Refresh read-only checks'),
    actionMessage: element('actionMessage', 'Reading all saved copies…'),
    technicalReport: element('technicalReport', 'Loading…')
  };
  const windowListeners = new Map();
  let appendedScripts = 0;
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement: () => ({ src: '', async: false, onload: null, onerror: null }),
    head: { appendChild() { appendedScripts += 1; } }
  };
  const context = {
    TaskPointsStorageHealth: {
      COUNT_KEYS,
      rawHash,
      parseStoredRaw: (value) => ({ state: JSON.parse(value), encoding: 'plain JSON' }),
      countsFor
    },
    document,
    localStorage,
    indexedDB,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Set,
    Date,
    Math,
    Promise,
    Error,
    Event: class Event { constructor(type) { this.type = type; } },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    dispatchEvent() {},
    addEventListener(type, handler) { windowListeners.set(type, handler); }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'indexeddb_requalification_loader.js' });
  return {
    context,
    elements,
    localStorage,
    indexedDB,
    windowListeners,
    getAppendedScripts: () => appendedScripts
  };
}

function settle(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('completed Faster Mode is rendered by the existing read-only loader with no helper script', () => {
  assert.doesNotMatch(PAGE, /indexeddb_requalification_final_state\.js/);
  assert.match(SOURCE, /function isCompletedFastMode\(report\)/);
  assert.match(SOURCE, /Faster mode is on/);
  assert.match(SOURCE, /refreshPromise/);
  assert.match(SOURCE, /refreshQueued/);
});

test('initial completed state shows final success and disables both setup actions', async () => {
  const { elements, context } = install();
  await settle();

  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
  assert.match(elements.overallDetail.textContent, /working copy and backups remain in place/i);
  assert.equal(elements.modeValue.textContent, 'Faster mode');
  assert.match(elements.actionMessage.textContent, /No further setup action is needed/i);
  assert.equal(elements.startTestBtn.disabled, true);
  assert.equal(elements.startTestBtn.dataset.allowed, 'false');
  assert.equal(elements.finishTestBtn.disabled, true);
  assert.equal(elements.finishTestBtn.dataset.allowed, 'false');
  assert.equal(context.TaskPointsRequalificationLoader.isCompletedFastMode(context.__TASKPOINTS_REQUALIFICATION_READ_ONLY_REPORT__), true);
});

test('failed safety checks take priority over the completed Faster Mode banner', async () => {
  const { elements } = install('indexeddb_primary', 'fast_mode_enabled', 0, { secondaryStatus: 'failed_verification' });
  await settle();

  assert.equal(elements.overallTitle.textContent, 'A safety check needs attention');
  assert.equal(elements.backupValue.textContent, 'Check needed');
  assert.match(elements.checks.innerHTML, /separate backup has not completed its safety check/i);
  assert.equal(elements.startTestBtn.disabled, true);
  assert.equal(elements.finishTestBtn.disabled, true);
  assert.doesNotMatch(elements.actionMessage.textContent, /No further setup action is needed/i);
});

test('switching Faster Mode Off reruns the actual read-only scan and restores Start', async () => {
  const { elements, localStorage, windowListeners } = install();
  await settle();

  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('storage')({ key: MODE_KEY });
  await settle();

  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(elements.modeValue.textContent, 'Safe mode');
  assert.equal(elements.startTestBtn.disabled, false);
  assert.equal(elements.startTestBtn.dataset.allowed, 'true');
  assert.equal(elements.finishTestBtn.disabled, true);
  assert.equal(elements.finishTestBtn.dataset.allowed, 'false');
});

test('back-forward-cache restore also rescans the current state', async () => {
  const { elements, localStorage, windowListeners } = install();
  await settle();

  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('pageshow')({ persisted: true });
  await settle();

  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(elements.startTestBtn.disabled, false);
});

test('state changes during a slow scan are serialized instead of starting overlapping scans', async () => {
  const { elements, localStorage, indexedDB, windowListeners } = install('indexeddb_primary', 'fast_mode_enabled', 35);
  localStorage.setItem(MODE_KEY, 'off');
  windowListeners.get('storage')({ key: MODE_KEY });
  windowListeners.get('storage')({ key: GATE_KEY });
  windowListeners.get('pageshow')({ persisted: true });
  await settle(180);

  assert.ok(indexedDB.getMaxActiveReads() <= 2, `expected at most two parallel database reads, got ${indexedDB.getMaxActiveReads()}`);
  assert.equal(elements.overallTitle.textContent, 'Read-only checks passed');
  assert.equal(elements.startTestBtn.disabled, false);
});

test('every report storage dependency and a clear event trigger a rescan', async () => {
  const storageKeyBlock = SOURCE.match(/const reportStorageKeys = new Set\(\[[\s\S]*?\]\);/)?.[0] || '';
  for (const token of ['STORAGE_KEY', 'MODE_KEY', 'HOLD_KEY', 'GATE_KEY', 'ATTEMPT_LOCK_KEY', 'HABIT_JOURNAL_KEY', 'LEGACY_JOURNAL_KEY']) {
    assert.match(storageKeyBlock, new RegExp(`\\b${token}\\b`));
  }
  assert.match(SOURCE, /event\.key == null \|\| reportStorageKeys\.has\(event\.key\)/);

  const { elements, localStorage, windowListeners } = install();
  await settle();

  localStorage.setItem(HABIT_JOURNAL_KEY, JSON.stringify([{ id: 'pending' }]));
  windowListeners.get('storage')({ key: HABIT_JOURNAL_KEY });
  await settle();
  assert.equal(elements.overallTitle.textContent, 'A safety check needs attention');
  assert.match(elements.checks.innerHTML, /Finish or recover the waiting changes first/i);

  localStorage.removeItem(HABIT_JOURNAL_KEY);
  windowListeners.get('storage')({ key: null });
  await settle();
  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
});

test('a stale test-button click cannot load the runtime after Faster Mode is already complete', async () => {
  const { elements, getAppendedScripts } = install();
  await settle();
  elements.startTestBtn.disabled = false;
  elements.startTestBtn.dataset.allowed = 'true';
  elements.startTestBtn.click();
  await settle();

  assert.equal(getAppendedScripts(), 0);
  assert.equal(elements.overallTitle.textContent, 'Faster mode is on');
  assert.equal(elements.startTestBtn.disabled, true);
});