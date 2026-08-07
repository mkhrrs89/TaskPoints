const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PHASE2 = fs.readFileSync(path.join(ROOT, 'phase2_reset_hook.js'), 'utf8');
const HOT_CACHE = fs.readFileSync(path.join(ROOT, 'state_hot_cache.js'), 'utf8');
const IDLE = fs.readFileSync(path.join(ROOT, 'storage_maintenance_idle.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, '_worker.js'), 'utf8');

const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const VAULT_META_KEY = 'taskpoints_safety_vault_meta_v1';

class FakeStorage {
  constructor(initial = {}) { this.rows = new Map(Object.entries(initial).map(([k, v]) => [String(k), String(v)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function rawHash(raw) {
  const text = String(raw || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function baseState(label = 'a') {
  return {
    tasks: Array.from({ length: 40 }, (_, i) => ({ id: `${label}-t-${i}` })),
    completions: Array.from({ length: 40 }, (_, i) => ({ id: `${label}-c-${i}` })),
    habits: [], players: [], flexActions: [], gameHistory: [], matchups: [],
    schedule: [], seasonHistory: [], reminders: []
  };
}

test('safety vault metadata prevents IndexedDB reads for ordinary writes inside the rotation window', async () => {
  const initialRaw = JSON.stringify(baseState('initial'));
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: initialRaw,
    [JOURNAL_KEY]: '[]',
    [VAULT_META_KEY]: JSON.stringify({
      schemaVersion: 1,
      latestRawHash: rawHash(initialRaw),
      latestCreatedAtISO: new Date().toISOString(),
      updatedAtISO: new Date().toISOString(),
      source: 'test'
    })
  });
  let indexedDbOpens = 0;
  const indexedDB = { open() { indexedDbOpens += 1; throw new Error('vault should not open'); } };
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    queueShadowDualWrite() { return Promise.resolve(); },
    parseTaskPointsStorageJson(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    normalizeState(value) { return value; },
    saveValidatedSnapshot() {},
    saveStateSnapshot() {},
    writeTaskPointsStoredState() {},
    shadowSourceSummary(state) { return { counts: {}, hashes: { state: JSON.stringify(state) } }; },
    shadowCanonicalJson(value) { return JSON.stringify(value); }
  };
  const context = {
    TaskPointsCore: core, localStorage, indexedDB, Storage: FakeStorage,
    structuredClone, queueMicrotask, setTimeout, clearTimeout,
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(PHASE2, context, { filename: 'phase2_reset_hook.js' });
  await core.flushTaskPointsSafetyVault();
  assert.equal(indexedDbOpens, 0, 'startup should trust fresh lightweight vault metadata');

  const nextRaw = JSON.stringify(baseState('next'));
  localStorage.setItem(STORAGE_KEY, nextRaw);
  await core.flushTaskPointsSafetyVault();
  assert.equal(indexedDbOpens, 0, 'ordinary save inside six-hour window should not read the vault');
  assert.equal(core.getTaskPointsDataLossGuardStatus().vaultQueuePending, false);
});

test('state hot cache reuses default loads, isolates callers, and invalidates after authoritative writes', () => {
  const localStorage = new FakeStorage({ [STORAGE_KEY]: '{"v":1}', [JOURNAL_KEY]: '[]', taskpoints_state_revision_v1: 'r1' });
  let loadCalls = 0;
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    loadAppState() { loadCalls += 1; return { state: { value: loadCalls, nested: { x: 1 } }, storageKeysFound: [STORAGE_KEY] }; }
  };
  const listeners = new Map();
  const context = {
    TaskPointsCore: core, localStorage, Storage: FakeStorage, structuredClone,
    addEventListener(name, fn) { listeners.set(name, fn); },
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(HOT_CACHE, context, { filename: 'state_hot_cache.js' });

  const first = core.loadAppState();
  const second = core.loadAppState();
  assert.equal(loadCalls, 1);
  assert.notEqual(first, second);
  second.state.nested.x = 99;
  assert.equal(core.loadAppState().state.nested.x, 1, 'cached result must be defensively cloned');
  assert.equal(loadCalls, 1);

  localStorage.setItem(STORAGE_KEY, '{"v":2}');
  const afterWrite = core.loadAppState();
  assert.equal(loadCalls, 2);
  assert.equal(afterWrite.state.value, 2);

  core.loadAppState({ persistSync: false });
  core.loadAppState({ persistSync: false });
  assert.equal(loadCalls, 4, 'explicit-option loads retain the original path');
  assert.ok(core.getStateHotCacheStatus().hits >= 2);
});

test('storage maintenance waits for a quiet interaction window but explicit maintenance is not delayed', async () => {
  let clock = 5000;
  const scheduled = [];
  let restoreCalls = 0;
  const listeners = new Map();
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    addEventListener(name, fn) { listeners.set(name, fn); }
  };
  const core = {
    restorePhase4CommittedPrimary() { restoreCalls += 1; return Promise.resolve(true); },
    queuePhase4PrimaryWrite() { return Promise.resolve(true); },
    readPhase3ShadowSnapshot() { return Promise.resolve({}); },
    refreshPhase3ReadCache() { return Promise.resolve(true); }
  };
  const context = {
    TaskPointsCore: core, document,
    performance: { now: () => clock },
    setTimeout(fn) { scheduled.push(fn); return scheduled.length; },
    Promise, Date, Math, Object, Array, String, Number, Boolean, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(IDLE, context, { filename: 'storage_maintenance_idle.js' });

  listeners.get('pointerdown')();
  const deferred = core.restorePhase4CommittedPrimary({ reason: 'cache_not_ready' });
  assert.equal(restoreCalls, 0);
  clock += 2000;
  while (scheduled.length) scheduled.shift()();
  await deferred;
  assert.equal(restoreCalls, 1);

  listeners.get('pointerdown')();
  await core.restorePhase4CommittedPrimary({ reason: 'manual_recovery' });
  assert.equal(restoreCalls, 2, 'explicit recovery operation should bypass the idle delay');
  assert.ok(core.getStorageMaintenanceIdleStatus().deferredCalls >= 1);
});

test('worker fingerprints and appends both Step 3A runtime modules', () => {
  for (const pathName of ['/state_hot_cache.js', '/storage_maintenance_idle.js']) {
    assert.match(WORKER, new RegExp(pathName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(WORKER, /x-taskpoints-state-hot-cache/);
  assert.match(WORKER, /x-taskpoints-storage-idle/);
});
