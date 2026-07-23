const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'phase3_navigation_cache.js'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const MODE_KEY = 'taskpoints_phase3_read_mode_v1';
const DIAGNOSTICS_KEY = 'taskpoints_phase3_read_diagnostics_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';

function storage(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    getItem(key) { return rows.has(String(key)) ? rows.get(String(key)) : null; },
    setItem(key, value) { rows.set(String(key), String(value)); },
    removeItem(key) { rows.delete(String(key)); },
    clear() { rows.clear(); }
  };
}

function install() {
  const state = { tasks: [{ id: 'current' }], completions: [], matchups: [], gameHistory: [], seasonHistory: [], habits: [], players: [] };
  const raw = JSON.stringify(state);
  const localStorage = storage({ [STORAGE_KEY]: raw, [MODE_KEY]: 'verified_indexeddb' });
  const sessionStorage = storage();
  const listeners = new Map();
  let underlyingCacheReady = true;
  let underlyingClearCalls = 0;
  let indexedReads = 0;

  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    PHASE3_READ_MODE_KEY: MODE_KEY,
    PHASE3_READ_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY,
    getPhase3ReadMode() { return localStorage.getItem(MODE_KEY) || 'off'; },
    getPhase3ReadStatus() {
      return {
        status: 'ready',
        effectiveSource: underlyingCacheReady ? 'indexedDB_ready' : 'localStorage',
        cacheReadyThisPage: underlyingCacheReady,
        currentRawMatchesCache: underlyingCacheReady,
        indexedDbReadsTotal: indexedReads,
        fallbackReadsTotal: 0
      };
    },
    refreshPhase3ReadCache: async () => ({ status: 'ready' }),
    setPhase3ReadMode(mode) { localStorage.setItem(MODE_KEY, mode); return mode; },
    clearPhase3ReadCache() {
      underlyingClearCalls += 1;
      underlyingCacheReady = false;
      return true;
    },
    readPhase3ShadowSnapshot: async () => { throw new Error('not used'); },
    getPendingShadowDualWriteCount: () => 0,
    readPendingHabitDeltas: () => [],
    parseTaskPointsStorageJson(value, fallback = {}) { return value ? JSON.parse(value) : fallback; },
    shadowCanonicalJson: JSON.stringify,
    shadowSourceLayout(value) { return { arrays: value, collections: {}, values: {} }; },
    shadowSourceSummary() { return { counts: {}, hashes: { state: 'same' } }; },
    shadowVerificationMismatches: () => [],
    loadAppState() {
      if (underlyingCacheReady && localStorage.getItem(MODE_KEY) === 'verified_indexeddb') indexedReads += 1;
      return { state: JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    }
  };

  const context = {
    TaskPointsCore: core,
    localStorage,
    sessionStorage,
    queueMicrotask() {},
    addEventListener(type, callback) {
      const rows = listeners.get(type) || [];
      rows.push(callback);
      listeners.set(type, rows);
    },
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'phase3_navigation_cache.js' });

  return {
    core,
    localStorage,
    raw,
    dispatch(event) { for (const callback of listeners.get('storage') || []) callback(event); },
    underlyingClearCalls: () => underlyingClearCalls,
    indexedReads: () => indexedReads
  };
}

test('cross-tab reset clears both navigation and underlying Phase 3 caches before quick restore', () => {
  const harness = install();

  harness.localStorage.removeItem(STORAGE_KEY);
  harness.dispatch({ key: STORAGE_KEY, oldValue: harness.raw, newValue: null, storageArea: harness.localStorage });
  assert.ok(harness.underlyingClearCalls() >= 1);

  harness.localStorage.setItem(STORAGE_KEY, harness.raw);
  harness.localStorage.setItem(MODE_KEY, 'verified_indexeddb');
  const result = harness.core.loadAppState();

  assert.equal(result.state.tasks[0].id, 'current');
  assert.equal(harness.indexedReads(), 0);
  assert.ok(harness.underlyingClearCalls() >= 2);
});
