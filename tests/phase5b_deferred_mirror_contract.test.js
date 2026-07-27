const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'phase5b_deferred_mirror.js');
const PHASE2_PATH = path.join(__dirname, '..', 'phase2_reset_hook.js');
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const PHASE2_SOURCE = fs.readFileSync(PHASE2_PATH, 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const VAULT_DB = 'taskpoints_safety_vault_v1';

class FakeStorage {
  constructor(initial = {}) { this.rows = new Map(Object.entries(initial).map(([k,v]) => [String(k), String(v)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function fakeIndexedDB() {
  const databases = new Map();
  const request = (work) => {
    const req = {};
    queueMicrotask(() => {
      try { req.result = work(); req.onsuccess?.(); }
      catch (error) { req.error = error; req.onerror?.(); }
    });
    return req;
  };
  class DB {
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
      if (!rows) throw new Error(`missing store ${name}`);
      const tx = {
        error: null,
        objectStore() {
          return {
            get: (key) => request(() => structuredClone(rows.get(key))),
            put: (value) => request(() => { rows.set(value.id, structuredClone(value)); return value.id; })
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
      const req = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) { db = new DB(); databases.set(name, db); }
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    read(name, store, id) { return structuredClone(databases.get(name)?.stores.get(store)?.get(id)); }
  };
}

function state(label, count = 120) {
  return {
    tasks: [{ id: `task-${label}` }],
    completions: Array.from({ length: count }, (_, i) => ({ id: `${label}-c${i}` })),
    habits: [{ id: `habit-${label}` }],
    players: Array.from({ length: 20 }, (_, i) => ({ id: `${label}-p${i}` })),
    flexActions: [],
    gameHistory: Array.from({ length: 120 }, (_, i) => ({ id: `${label}-g${i}` })),
    matchups: Array.from({ length: 120 }, (_, i) => ({ id: `${label}-m${i}` })),
    schedule: [], seasonHistory: [{ id: `season-${label}` }], reminders: []
  };
}
function emptyState() {
  return { tasks: [], completions: [], habits: [], players: [], flexActions: [], gameHistory: [], matchups: [], schedule: [], seasonHistory: [], reminders: [] };
}

function install(initial = state('a')) {
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: JSON.stringify(initial),
    taskpoints_phase4_storage_mode_v1: 'indexeddb_primary',
    taskpoints_emergency_recovery_hold_v1: '{"active":true}'
  });
  const indexedDB = fakeIndexedDB();
  const alerts = [];
  let now = Date.parse('2026-07-27T12:00:00Z');
  class FakeDate extends Date {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const core = {
    STORAGE_KEY,
    parseTaskPointsStorageJson: (raw, fallback) => { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    saveStateSnapshot(next, options = {}) { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); return { state: next, options }; },
    saveValidatedSnapshot(next, options = {}) { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); return { state: next, options }; }
  };
  const context = {
    TaskPointsCore: core, localStorage, indexedDB, Storage: FakeStorage, structuredClone,
    queueMicrotask, setTimeout, clearTimeout, JSON, Math, Object, Array, String, Number,
    Boolean, Promise, Error, Set, Map, console, Date: FakeDate,
    alert: (message) => alerts.push(message)
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'storage_data_loss_guard.js' });
  return { core, localStorage, indexedDB, alerts, advance: (ms) => { now += ms; } };
}

test('disables Phase 5B and holds IndexedDB-primary off', async () => {
  const h = install();
  assert.equal(h.core.PHASE5B_LIVE_BUNDLE_DISABLED, true);
  assert.equal(h.core.getPhase5BStatus().disabledForSafety, true);
  assert.equal(h.localStorage.getItem('taskpoints_phase4_storage_mode_v1'), 'off');
  await h.core.flushTaskPointsSafetyVault();
});

test('blocks an early-startup empty snapshot from replacing rich saved data', async () => {
  const h = install();
  const before = h.localStorage.getItem(STORAGE_KEY);
  assert.throws(
    () => h.core.saveStateSnapshot(emptyState(), { savePath: 'startup-derived-sync' }),
    /blocked a suspicious destructive state overwrite/i
  );
  assert.equal(h.localStorage.getItem(STORAGE_KEY), before);
  assert.equal(h.alerts.length, 1);
  await h.core.flushTaskPointsSafetyVault();
});

test('allows normal populated saves and creates an independent known-good vault snapshot', async () => {
  const h = install();
  const next = state('b');
  h.core.saveStateSnapshot(next, { savePath: 'task-edit' });
  assert.equal(JSON.parse(h.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'task-b');
  await h.core.flushTaskPointsSafetyVault();
  const latest = h.indexedDB.read(VAULT_DB, 'snapshots', 'latest');
  assert.ok(latest);
  assert.ok(latest.counts.majorTotal > 300);
  assert.equal(JSON.parse(latest.raw).tasks[0].id, 'task-a');
});

test('explicit confirmed import can replace the current state', async () => {
  const h = install();
  const imported = { ...emptyState(), tasks: [{ id: 'imported' }], completions: Array.from({ length: 20 }, (_, i) => ({ id: i })) };
  const result = h.core.saveValidatedSnapshot(imported, { allowDestructiveOverwrite: true, source: 'settings-import' });
  assert.equal(result.state.tasks[0].id, 'imported');
  assert.equal(JSON.parse(h.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'imported');
  await h.core.flushTaskPointsSafetyVault();
});

test('rotates and preserves four independent safety-vault snapshots', async () => {
  const h = install();
  await h.core.flushTaskPointsSafetyVault();
  for (const label of ['b', 'c', 'd']) {
    h.advance(7 * 60 * 60 * 1000);
    h.core.saveStateSnapshot(state(label), { savePath: 'task-edit' });
    await h.core.flushTaskPointsSafetyVault();
  }
  assert.equal(JSON.parse(h.indexedDB.read(VAULT_DB, 'snapshots', 'latest').raw).tasks[0].id, 'task-d');
  assert.equal(JSON.parse(h.indexedDB.read(VAULT_DB, 'snapshots', 'prev1').raw).tasks[0].id, 'task-c');
  assert.equal(JSON.parse(h.indexedDB.read(VAULT_DB, 'snapshots', 'prev2').raw).tasks[0].id, 'task-b');
  assert.equal(JSON.parse(h.indexedDB.read(VAULT_DB, 'snapshots', 'prev3').raw).tasks[0].id, 'task-a');

  assert.throws(() => h.localStorage.setItem(STORAGE_KEY, JSON.stringify(emptyState())));
  await h.core.flushTaskPointsSafetyVault();
  assert.equal(JSON.parse(h.indexedDB.read(VAULT_DB, 'snapshots', 'latest').raw).tasks[0].id, 'task-d');
});

test('guard is installed from the Phase 2 safety floor before Phase 4 and Phase 5A', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(PHASE2_SOURCE));
  assert.match(PHASE2_SOURCE, /installTaskPointsStorageDataLossGuard/);
  assert.match(PHASE2_SOURCE, /always-loaded Phase 2 safety/);
  assert.ok(worker.indexOf("'/phase2_reset_hook.js'") < worker.indexOf("'/phase4_storage_coordinator.js'"));
  assert.ok(worker.indexOf("'/phase2_reset_hook.js'") < worker.indexOf("'/phase5a_native_snapshot.js'"));
});

test('worker keeps the former Phase 5B bundle slot as an idempotent safety kill-switch', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /'\/phase5b_deferred_mirror\.js'/);
  assert.match(SOURCE, /PHASE5B_LIVE_BUNDLE_DISABLED = true/);
  assert.match(SOURCE, /phase5b_disabled_after_empty_state_overwrite/);
  assert.doesNotMatch(SOURCE, /CHECKPOINT_DELAY/);
  assert.doesNotMatch(SOURCE, /deferredMirror: true/);
});
