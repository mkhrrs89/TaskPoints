const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'phase4_primary_read_path.js');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function install({ authoritativeState, cacheState = authoritativeState, serializedState = undefined } = {}) {
  const raw = JSON.stringify(authoritativeState);
  const cachedRaw = serializedState === undefined ? JSON.stringify(cacheState) : serializedState;
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: raw,
    [MODE_KEY]: 'indexeddb_primary'
  });
  const sessionStorage = new FakeStorage();
  let currentCache = {
    schemaVersion: 1,
    sequence: 1,
    state: cacheState,
    serializedState: cachedRaw,
    mirrorRaw: raw,
    sourceHash: 'verified-hash',
    destinationHash: 'verified-hash',
    status: 'passed_verification'
  };
  let expensiveValidationCalls = 0;
  let originalLoadCalls = 0;

  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PHASE4_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY,
    getPhase4StorageMode: () => localStorage.getItem(MODE_KEY) || 'off',
    setPhase4StorageMode(value) { localStorage.setItem(MODE_KEY, value); return value; },
    getPendingShadowDualWriteCount: () => 0,
    getPendingPhase4WriteCount: () => 0,
    readPendingHabitDeltas: () => [],
    parseTaskPointsStorageJson() {
      expensiveValidationCalls += 1;
      throw new Error('ordinary reads must not reparse the mirror for validation');
    },
    shadowSourceSummary() {
      expensiveValidationCalls += 1;
      throw new Error('ordinary reads must not summarize the full state');
    },
    shadowCanonicalJson() {
      expensiveValidationCalls += 1;
      throw new Error('ordinary reads must not canonicalize the full state');
    },
    shadowVerificationMismatches() {
      expensiveValidationCalls += 1;
      throw new Error('ordinary reads must not run full mismatch verification');
    },
    getPhase4VerifiedPrimaryCache: () => currentCache,
    setPhase4VerifiedPrimaryCache(next) { currentCache = next; return next; },
    clearPhase4Caches() { currentCache = null; return true; },
    getPhase4StorageStatus() { return {}; },
    loadAppState(options = {}) {
      originalLoadCalls += 1;
      return {
        state: JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'),
        persistSync: options.persistSync
      };
    }
  };

  const context = {
    TaskPointsCore: core,
    localStorage,
    sessionStorage,
    Storage: FakeStorage,
    addEventListener() {},
    queueMicrotask() {},
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(MODULE_PATH, 'utf8'), context, { filename: MODULE_PATH });

  return {
    core,
    localStorage,
    expensiveValidationCalls: () => expensiveValidationCalls,
    originalLoadCalls: () => originalLoadCalls
  };
}

test('ordinary primary reads use exact saved-byte metadata instead of full-state validation', () => {
  const state = { tasks: [{ id: 'quick-tap' }], habits: [], completions: [] };
  const harness = install({ authoritativeState: state });

  const result = harness.core.loadAppState({ persistSync: true });

  assert.equal(result.state.tasks[0].id, 'quick-tap');
  assert.equal(result.persistSync, false);
  assert.equal(harness.originalLoadCalls(), 1);
  assert.equal(harness.expensiveValidationCalls(), 0);
});

test('an exact-byte mismatch still fails closed to the authoritative loader', () => {
  const authoritative = { tasks: [{ id: 'newer' }] };
  const stale = { tasks: [{ id: 'older' }] };
  const harness = install({
    authoritativeState: authoritative,
    cacheState: stale,
    serializedState: JSON.stringify(stale)
  });

  const result = harness.core.loadAppState();

  assert.equal(result.state.tasks[0].id, 'newer');
  assert.equal(harness.originalLoadCalls(), 1);
  assert.equal(harness.expensiveValidationCalls(), 0);
});

test('a native cache without serializedState reuses its exact verified mirror bytes', () => {
  const state = { tasks: [{ id: 'native-cache' }], habits: [] };
  const harness = install({ authoritativeState: state, serializedState: null });

  const result = harness.core.loadAppState();

  assert.equal(result.state.tasks[0].id, 'native-cache');
  assert.equal(harness.originalLoadCalls(), 1);
  assert.equal(harness.expensiveValidationCalls(), 0);
});
