const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PHASE5C = fs.readFileSync(path.join(ROOT, 'phase5b_deferred_mirror.js'), 'utf8');
const IDLE = fs.readFileSync(path.join(ROOT, 'storage_maintenance_idle.js'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const DIAG_KEY = 'taskpoints_storage_data_loss_guard_v1';
const DB_NAME = 'taskpoints_verified_secondary_v1';

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
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

function makeState(label) {
  return {
    tasks: [{ id: `task-${label}` }],
    completions: [{ id: `completion-${label}` }],
    habits: [], players: [], flexActions: [], gameHistory: [], matchups: [],
    schedule: [], seasonHistory: [], reminders: [], weightHistory: [], vo2MaxHistory: []
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function summary(state) {
  const keys = ['tasks','completions','habits','players','flexActions','gameHistory','matchups','schedule','seasonHistory','reminders','weightHistory','vo2MaxHistory'];
  const counts = Object.fromEntries(keys.map((key) => [key, Array.isArray(state?.[key]) ? state[key].length : 0]));
  counts.total = keys.reduce((sum, key) => sum + counts[key], 0);
  counts.majorTotal = ['tasks','completions','habits','players','gameHistory','matchups','seasonHistory']
    .reduce((sum, key) => sum + counts[key], 0);
  return { counts, hashes: { state: canonical(state || {}) } };
}

function createFakeIndexedDb() {
  const databases = new Map();
  let openCalls = 0;
  const request = (work) => {
    const req = {};
    queueMicrotask(() => {
      try { req.result = work(); req.onsuccess?.(); }
      catch (error) { req.error = error; req.onerror?.(); }
    });
    return req;
  };
  class Database {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    }
    createObjectStore(name) {
      const rows = new Map();
      this.stores.set(name, rows);
      return rows;
    }
    transaction(name) {
      const rows = this.stores.get(name);
      if (!rows) throw new Error(`missing store: ${name}`);
      const tx = {
        error: null,
        objectStore() {
          return {
            put(value) { return request(() => { rows.set(value.id, structuredClone(value)); return value.id; }); },
            get(key) { return request(() => structuredClone(rows.get(key))); },
            delete(key) { return request(() => rows.delete(key)); }
          };
        }
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    }
    close() {}
  }
  return {
    open(name) {
      openCalls += 1;
      const req = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) { db = new Database(); databases.set(name, db); }
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    openCalls: () => openCalls,
    read(name, id) { return structuredClone(databases.get(name)?.stores.get('snapshots')?.get(id)); }
  };
}

function createHarness() {
  let clock = 100;
  const timers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const initialRaw = JSON.stringify(makeState('initial'));
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: initialRaw,
    [JOURNAL_KEY]: '[]',
    [DIAG_KEY]: JSON.stringify({
      phase5cEnabled: true,
      phase5cLastStatus: 'passed_verification',
      phase5cMirrorsCurrentSave: true,
      phase5cLastVerifiedRawHash: rawHash(initialRaw),
      phase5cHomeNativeStatus: 'passed_verification',
      phase5cHomeNativeRawHash: rawHash(initialRaw)
    }),
    taskpoints_phase4_storage_mode_v1: 'off'
  });
  const indexedDB = createFakeIndexedDb();
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    __storageDataLossGuardInstalled: true,
    __phase5aNativeSnapshotInstalled: true,
    parseTaskPointsStorageJson(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    shadowCanonicalJson: canonical,
    shadowSourceSummary: summary,
    loadAppState() { return {}; }
  };
  const document = {
    readyState: 'loading',
    visibilityState: 'visible',
    activeElement: null,
    addEventListener(name, fn) { documentListeners.set(name, fn); }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    indexedDB,
    Storage: FakeStorage,
    document,
    performance: { now: () => clock },
    structuredClone,
    queueMicrotask,
    setTimeout(fn, delay = 0) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
    addEventListener(name, fn) { windowListeners.set(name, fn); },
    requestIdleCallback: undefined,
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(PHASE5C, context, { filename: 'phase5b_deferred_mirror.js' });
  vm.runInNewContext(IDLE, context, { filename: 'storage_maintenance_idle.js' });

  return {
    core, localStorage, indexedDB, document, documentListeners, windowListeners, timers,
    setClock(value) { clock = value; },
    runNextTimer() { const item = timers.shift(); if (item) item.fn(); return Boolean(item); },
    async settle(ms = 30) { await new Promise((resolve) => setTimeout(resolve, ms)); }
  };
}

test('Phase 5C waits through page startup and a navigation intent before opening IndexedDB', async () => {
  const h = createHarness();
  const nextRaw = JSON.stringify(makeState('changed'));
  h.localStorage.setItem(STORAGE_KEY, nextRaw);
  assert.equal(h.indexedDB.openCalls(), 0);
  assert.equal(h.core.getPhase5CVerifiedSecondaryStatus().lastStatus, 'queued_waiting_for_idle');

  h.runNextTimer(); // launch the shared idle gate
  assert.equal(h.indexedDB.openCalls(), 0, 'queue launch must not start verification while the document is loading');

  h.document.readyState = 'complete';
  h.setClock(2000);
  h.runNextTimer(); // first shared idle retry
  assert.equal(h.indexedDB.openCalls(), 0, 'startup grace should still protect the new page');

  h.setClock(3000);
  h.documentListeners.get('click')?.({
    target: {
      tagName: 'A',
      closest() { return this; },
      getAttribute(name) { return name === 'href' ? '/settings.html' : ''; },
      hasAttribute() { return false; }
    }
  });
  h.setClock(5000);
  h.runNextTimer();
  assert.equal(h.indexedDB.openCalls(), 0, 'a navigation click must extend the maintenance quiet window');

  h.setClock(7000);
  h.runNextTimer();
  await h.settle();
  assert.ok(h.indexedDB.openCalls() > 0, 'verification may begin only after startup/navigation and interaction quiet windows clear');
  await h.core.flushPhase5CVerifiedSecondaryWrites();
  assert.equal(h.indexedDB.read(DB_NAME, 'latest').raw, nextRaw);
});

test('rapid saves coalesce to the newest state before the quiet-window verification starts', async () => {
  const h = createHarness();
  const first = JSON.stringify(makeState('first'));
  const second = JSON.stringify(makeState('second'));
  const newest = JSON.stringify(makeState('newest'));
  h.localStorage.setItem(STORAGE_KEY, first);
  h.localStorage.setItem(STORAGE_KEY, second);
  h.localStorage.setItem(STORAGE_KEY, newest);
  assert.equal(h.indexedDB.openCalls(), 0);

  await h.core.flushPhase5CVerifiedSecondaryWrites();
  assert.equal(h.indexedDB.read(DB_NAME, 'latest').raw, newest);
  assert.equal(h.core.getPhase5CVerifiedSecondaryStatus().mirrorsCurrentSave, true);
});

test('rewriting an already verified identical state does not reopen the verified-secondary database', async () => {
  const h = createHarness();
  const raw = JSON.stringify(makeState('verified'));
  h.localStorage.setItem(STORAGE_KEY, raw);
  await h.core.flushPhase5CVerifiedSecondaryWrites();
  const opensAfterVerification = h.indexedDB.openCalls();
  assert.ok(opensAfterVerification > 0);

  h.localStorage.setItem(STORAGE_KEY, raw);
  assert.equal(h.core.getPhase5CVerifiedSecondaryStatus().pendingWrite, false);
  while (h.timers.length) h.runNextTimer();
  await h.settle(10);
  assert.equal(h.indexedDB.openCalls(), opensAfterVerification, 'identical verified rewrites should not trigger another IndexedDB verification');
});

test('shared maintenance gate treats hidden/leaving pages as busy and keeps explicit recovery immediate', async () => {
  let clock = 10000;
  const timers = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let runs = 0;
  const document = {
    readyState: 'complete', visibilityState: 'visible', activeElement: null,
    addEventListener(name, fn) { documentListeners.set(name, fn); }
  };
  const core = {};
  const context = {
    TaskPointsCore: core, document,
    performance: { now: () => clock },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    addEventListener(name, fn) { windowListeners.set(name, fn); },
    Promise, Date, Math, Object, Array, String, Number, Boolean, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(IDLE, context, { filename: 'storage_maintenance_idle.js' });

  document.visibilityState = 'hidden';
  const delayed = core.whenStorageMaintenanceQuiet(() => { runs += 1; return true; }, { source: 'phase5c_verified_secondary' });
  assert.equal(runs, 0);
  timers.shift()?.();
  assert.equal(runs, 0);

  document.visibilityState = 'visible';
  windowListeners.get('pageshow')?.();
  clock += 5000;
  while (timers.length) timers.shift()();
  await delayed;
  assert.equal(runs, 1);

  await core.whenStorageMaintenanceQuiet(() => { runs += 1; return true; }, { reason: 'manual_recovery' });
  assert.equal(runs, 2, 'explicit recovery must bypass navigation/idle deferral');
});
