const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const KILL_SWITCH_PATH = path.join(__dirname, '..', 'phase5b_deferred_mirror.js');
const PHASE2_PATH = path.join(__dirname, '..', 'phase2_reset_hook.js');
const KILL_SWITCH_SOURCE = fs.readFileSync(KILL_SWITCH_PATH, 'utf8');
const PHASE2_SOURCE = fs.readFileSync(PHASE2_PATH, 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';
const VAULT_DB = 'taskpoints_safety_vault_v1';

class FakeStorage {
  constructor(initial = {}) { this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function deepMerge(base, update) {
  const left = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const right = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  const result = { ...left };
  Object.entries(right).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else result[key] = structuredClone(value);
  });
  return result;
}

function normalize(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    completions: Array.isArray(source.completions) ? source.completions : [],
    habits: Array.isArray(source.habits) ? source.habits : [],
    players: Array.isArray(source.players) ? source.players : [],
    flexActions: Array.isArray(source.flexActions) ? source.flexActions : [],
    gameHistory: Array.isArray(source.gameHistory) ? source.gameHistory : [],
    matchups: Array.isArray(source.matchups) ? source.matchups : [],
    schedule: Array.isArray(source.schedule) ? source.schedule : [],
    seasonHistory: Array.isArray(source.seasonHistory) ? source.seasonHistory : [],
    reminders: Array.isArray(source.reminders) ? source.reminders : []
  };
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
  return normalize({
    tasks: [{ id: `task-${label}`, title: label }],
    completions: Array.from({ length: count }, (_, index) => ({ id: `${label}-c${index}` })),
    habits: [{ id: `habit-${label}` }],
    players: Array.from({ length: 20 }, (_, index) => ({ id: `${label}-p${index}` })),
    gameHistory: Array.from({ length: 120 }, (_, index) => ({ id: `${label}-g${index}` })),
    matchups: Array.from({ length: 120 }, (_, index) => ({ id: `${label}-m${index}` })),
    seasonHistory: [{ id: `season-${label}` }]
  });
}

function emptyState() { return normalize({}); }

function install(initial = state('a'), extraStorage = {}) {
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: JSON.stringify(initial),
    taskpoints_phase4_storage_mode_v1: 'indexeddb_primary',
    taskpoints_emergency_recovery_hold_v1: '{"active":true}',
    ...extraStorage
  });
  const indexedDB = fakeIndexedDB();
  const alerts = [];
  let now = Date.parse('2026-07-27T12:00:00Z');
  class FakeDate extends Date {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return now; }
  }

  function safeReplace(raw) {
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous !== null && String(raw).length < previous.length) {
      localStorage.removeItem(STORAGE_KEY);
      try { localStorage.setItem(STORAGE_KEY, raw); }
      catch (error) {
        localStorage.setItem(STORAGE_KEY, previous);
        throw error;
      }
    } else localStorage.setItem(STORAGE_KEY, raw);
  }

  const core = {
    STORAGE_KEY,
    queueShadowDualWrite: () => Promise.resolve({ status: 'passed_verification' }),
    parseTaskPointsStorageJson: (raw, fallback) => { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    normalizeState: normalize,
    mergeState(patch, options = {}) { return { state: normalize(deepMerge(options.existing || {}, patch || {})) }; },
    shadowCanonicalJson: (value) => JSON.stringify(value),
    shadowSourceSummary: (value) => ({ hashes: { state: JSON.stringify(value || {}) } }),
    writeTaskPointsStoredState(next) { safeReplace(JSON.stringify(normalize(next))); return localStorage.getItem(STORAGE_KEY); },
    saveStateSnapshot(next, options = {}) { safeReplace(JSON.stringify(normalize(next))); return { state: normalize(next), options }; },
    saveValidatedSnapshot(next, options = {}) { safeReplace(JSON.stringify(normalize(next))); return { state: normalize(next), options }; }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    indexedDB,
    Storage: undefined,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    Set,
    Map,
    console,
    Date: FakeDate,
    alert: (message) => alerts.push(message)
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(PHASE2_SOURCE, context, { filename: 'phase2_reset_hook.js' });
  return { core, localStorage, indexedDB, alerts, advance: (milliseconds) => { now += milliseconds; } };
}

test('disables Phase 5B and holds IndexedDB-primary off', async () => {
  const harness = install();
  assert.equal(harness.core.PHASE5B_LIVE_BUNDLE_DISABLED, true);
  assert.equal(harness.core.getPhase5BStatus().disabledForSafety, true);
  assert.equal(harness.localStorage.getItem('taskpoints_phase4_storage_mode_v1'), 'off');
  await harness.core.flushTaskPointsSafetyVault();
});

test('blocks a catastrophic candidate through the real remove-then-set replacement sequence', async () => {
  const harness = install();
  const before = harness.localStorage.getItem(STORAGE_KEY);
  assert.throws(
    () => harness.core.saveStateSnapshot(emptyState(), { savePath: 'startup-derived-sync' }),
    /blocked a suspicious destructive state overwrite/i
  );
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), before);
  assert.equal(harness.alerts.length, 1);
  await harness.core.flushTaskPointsSafetyVault();
});

test('allows normal populated saves and creates an independent known-good vault snapshot', async () => {
  const harness = install();
  harness.core.saveStateSnapshot(state('b'), { savePath: 'task-edit' });
  assert.equal(JSON.parse(harness.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'task-b');
  await harness.core.flushTaskPointsSafetyVault();
  const latest = harness.indexedDB.read(VAULT_DB, 'snapshots', 'latest');
  assert.ok(latest);
  assert.ok(latest.counts.majorTotal > 300);
  assert.equal(JSON.parse(latest.raw).tasks[0].id, 'task-a');
});

test('explicit confirmed settings import can replace the current state', async () => {
  const harness = install();
  const imported = normalize({ tasks: [{ id: 'imported' }], completions: Array.from({ length: 20 }, (_, index) => ({ id: index })) });
  const result = harness.core.saveValidatedSnapshot(imported, {
    allowDestructiveOverwrite: true,
    source: 'settings-import'
  });
  assert.equal(result.state.tasks[0].id, 'imported');
  assert.equal(JSON.parse(harness.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'imported');
  await harness.core.flushTaskPointsSafetyVault();
});

test('replays and verifies a pending legacy Phase 5B journal before clearing it', async () => {
  const journal = {
    schemaVersion: 1,
    revision: 7,
    operations: [{
      type: 'merge',
      patch: { tasks: [{ id: 'task-journal', title: 'Recovered pending edit' }] },
      options: {}
    }]
  };
  const harness = install(state('base'), { [JOURNAL_KEY]: JSON.stringify(journal) });
  const restored = JSON.parse(harness.localStorage.getItem(STORAGE_KEY));
  assert.equal(restored.tasks[0].id, 'task-journal');
  assert.equal(harness.localStorage.getItem(JOURNAL_KEY), null);
  const diagnostics = JSON.parse(harness.localStorage.getItem('taskpoints_storage_data_loss_guard_v1'));
  assert.equal(diagnostics.legacyJournalStatus, 'reconciled');
  assert.equal(diagnostics.legacyJournalRevision, 7);
  await harness.core.flushTaskPointsSafetyVault();
});

test('rotates and preserves four independent safety-vault snapshots', async () => {
  const harness = install();
  await harness.core.flushTaskPointsSafetyVault();
  for (const label of ['b', 'c', 'd']) {
    harness.advance(7 * 60 * 60 * 1000);
    harness.core.saveStateSnapshot(state(label), { savePath: 'task-edit' });
    await harness.core.flushTaskPointsSafetyVault();
  }
  assert.equal(JSON.parse(harness.indexedDB.read(VAULT_DB, 'snapshots', 'latest').raw).tasks[0].id, 'task-d');
  assert.equal(JSON.parse(harness.indexedDB.read(VAULT_DB, 'snapshots', 'prev1').raw).tasks[0].id, 'task-c');
  assert.equal(JSON.parse(harness.indexedDB.read(VAULT_DB, 'snapshots', 'prev2').raw).tasks[0].id, 'task-b');
  assert.equal(JSON.parse(harness.indexedDB.read(VAULT_DB, 'snapshots', 'prev3').raw).tasks[0].id, 'task-a');

  assert.throws(() => harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(emptyState())));
  await harness.core.flushTaskPointsSafetyVault();
  assert.equal(JSON.parse(harness.indexedDB.read(VAULT_DB, 'snapshots', 'latest').raw).tasks[0].id, 'task-d');
});

test('guard compiles and is installed from Phase 2 before Phase 4 and Phase 5A', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(PHASE2_SOURCE));
  assert.match(PHASE2_SOURCE, /installTaskPointsStorageDataLossGuard/);
  assert.ok(worker.indexOf("'/phase2_reset_hook.js'") < worker.indexOf("'/phase4_storage_coordinator.js'"));
  assert.ok(worker.indexOf("'/phase2_reset_hook.js'") < worker.indexOf("'/phase5a_native_snapshot.js'"));
});

test('former Phase 5B slot is only a fail-closed compatibility kill-switch', () => {
  assert.doesNotThrow(() => new vm.Script(KILL_SWITCH_SOURCE));
  assert.match(KILL_SWITCH_SOURCE, /PHASE5B_LIVE_BUNDLE_DISABLED = true/);
  assert.match(KILL_SWITCH_SOURCE, /storage data-loss guard was not installed/);
  assert.doesNotMatch(KILL_SWITCH_SOURCE, /CHECKPOINT_DELAY/);
  assert.doesNotMatch(KILL_SWITCH_SOURCE, /deferredMirror: true/);
});
