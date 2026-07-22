const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'phase3_navigation_cache.js'), 'utf8');
const MODE_KEY = 'taskpoints_phase3_read_mode_v1';
const DIAGNOSTICS_KEY = 'taskpoints_phase3_read_diagnostics_v1';
const SESSION_CACHE_KEY = 'taskpoints_phase3_verified_session_cache_v1';
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];

function storageFrom(initial = {}, failSet = false) {
  const rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    getItem(key) { return rows.has(String(key)) ? rows.get(String(key)) : null; },
    setItem(key, value) { if (failSet) throw new Error('quota'); rows.set(String(key), String(value)); },
    removeItem(key) { rows.delete(String(key)); },
    clear() { rows.clear(); },
    key(index) { return [...rows.keys()][index] ?? null; },
    get length() { return rows.size; },
    _rows: rows
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceLayout(state) {
  const arrays = {}, collections = {}, values = {};
  for (const [field, value] of Object.entries(state || {})) {
    if (ARRAY_STORES.includes(field) && Array.isArray(value)) arrays[field] = value;
    else if (Array.isArray(value)) collections[field] = value;
    else values[field] = value;
  }
  ARRAY_STORES.forEach((field) => { if (!arrays[field]) arrays[field] = []; });
  return { arrays, collections, values };
}

function stateHash(value) {
  const text = canonical(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function sourceSummary(state) {
  const layout = sourceLayout(state);
  const counts = {};
  Object.entries(layout.arrays).forEach(([field, rows]) => { counts[field] = rows.length; });
  Object.entries(layout.collections).forEach(([field, rows]) => { counts[field] = rows.length; });
  counts.topLevelValues = Object.keys(layout.values).length;
  return {
    counts,
    hashes: { state: stateHash({ arrays: layout.arrays, collections: layout.collections, values: layout.values }) }
  };
}

function fixture(version) {
  return {
    completions: [{ id: 'c1', points: version }],
    matchups: [{ id: 'm1' }],
    gameHistory: [{ id: 'g1' }],
    seasonHistory: [{ id: 's1' }],
    tasks: [{ id: `task-${version}`, version }],
    habits: [{ id: 'h1' }],
    players: [{ id: 'p1' }],
    projects: [{ id: 'project-1' }],
    schedule: [],
    settings: { sound: true }
  };
}

function sessionRecord(state) {
  const summary = sourceSummary(state);
  return JSON.stringify({
    schemaVersion: 1,
    state,
    sourceHash: summary.hashes.state,
    destinationHash: summary.hashes.state,
    sourceCounts: summary.counts,
    destinationCounts: summary.counts,
    verifiedAt: '2026-07-22T21:00:00.000Z'
  });
}

function install({ authoritativeState, cachedState = authoritativeState, mode = 'verified_indexeddb', sessionSetFails = false }) {
  const localStorage = storageFrom({
    [STORAGE_KEY]: JSON.stringify(authoritativeState),
    [MODE_KEY]: mode
  });
  const sessionStorage = storageFrom({
    [SESSION_CACHE_KEY]: sessionRecord(cachedState)
  }, sessionSetFails);
  const capturedOptions = [];
  let originalLoadCalls = 0;

  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    PHASE3_READ_MODE_KEY: MODE_KEY,
    PHASE3_READ_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY,
    shadowCanonicalJson: canonical,
    shadowSourceLayout: sourceLayout,
    shadowSourceSummary: sourceSummary,
    shadowVerificationMismatches(source, destination) {
      return source.hashes.state === destination.hashes.state ? [] : [{ type: 'hash' }];
    },
    parseTaskPointsStorageJson(raw, fallback = {}) { return raw ? JSON.parse(raw) : fallback; },
    getPendingShadowDualWriteCount: () => 0,
    readPendingHabitDeltas: () => [],
    getPhase3ReadMode() {
      const value = localStorage.getItem(MODE_KEY);
      return ['off', 'compare', 'verified_indexeddb'].includes(value) ? value : 'off';
    },
    setPhase3ReadMode(value) { localStorage.setItem(MODE_KEY, value); return value; },
    getPhase3ReadStatus() {
      let diagnostics = {};
      try { diagnostics = JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY) || '{}'); } catch (_) {}
      return {
        configuredMode: this.getPhase3ReadMode(),
        status: diagnostics.status || 'ready',
        effectiveSource: diagnostics.effectiveSource || 'localStorage',
        indexedDbReadsTotal: diagnostics.indexedDbReadsTotal || 0,
        fallbackReadsTotal: diagnostics.fallbackReadsTotal || 0,
        lastFallbackReason: diagnostics.lastFallbackReason || null,
        cacheReadyThisPage: false,
        currentRawMatchesCache: false
      };
    },
    refreshPhase3ReadCache: async () => ({ status: 'ready' }),
    clearPhase3ReadCache: () => true,
    testPhase3VerifiedRead: () => ({ served: false, reason: 'internal' }),
    readPhase3ShadowSnapshot: async () => {
      const summary = sourceSummary(authoritativeState);
      return {
        state: authoritativeState,
        currentMetadata: { status: 'passed_verification' },
        dualWriteMetadata: {
          status: 'passed_verification',
          verification: {
            source: { hashes: { state: summary.hashes.state } },
            destination: { hashes: { state: summary.hashes.state } }
          }
        }
      };
    },
    loadAppState(options = {}) {
      originalLoadCalls += 1;
      capturedOptions.push({ ...options });
      const raw = localStorage.getItem(STORAGE_KEY);
      localStorage.getItem(JOURNAL_KEY);
      return { state: raw ? JSON.parse(raw) : {} };
    }
  };

  const context = {
    TaskPointsCore: core,
    localStorage,
    sessionStorage,
    queueMicrotask() {},
    structuredClone,
    JSON,
    Date,
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
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(MODULE_SOURCE, context, { filename: 'phase3_navigation_cache.js' });

  return {
    core,
    localStorage,
    sessionStorage,
    capturedOptions,
    originalLoadCalls: () => originalLoadCalls
  };
}

test('a verified session snapshot serves the first load after same-tab navigation', () => {
  const harness = install({ authoritativeState: fixture(21) });
  const result = harness.core.loadAppState({ persistSync: true });
  const status = harness.core.getPhase3ReadStatus();

  assert.equal(result.state.tasks[0].id, 'task-21');
  assert.equal(status.effectiveSource, 'indexedDB');
  assert.equal(status.indexedDbReadsTotal, 1);
  assert.equal(status.fallbackReadsTotal, 0);
  assert.equal(status.cacheReadyThisPage, true);
  assert.equal(status.currentRawMatchesCache, true);
  assert.equal(harness.originalLoadCalls(), 1);
  assert.equal(harness.capturedOptions[0].persistSync, false);
  assert.equal(harness.core.PHASE3_SESSION_CACHE_KEY, SESSION_CACHE_KEY);
});

test('a stale session snapshot is rejected, cleared, and cannot override localStorage', () => {
  const harness = install({ authoritativeState: fixture(22), cachedState: fixture(21) });
  const result = harness.core.loadAppState();
  const status = harness.core.getPhase3ReadStatus();

  assert.equal(result.state.tasks[0].id, 'task-22');
  assert.equal(status.indexedDbReadsTotal, 0);
  assert.equal(status.lastFallbackReason, 'session_cache_mismatch');
  assert.equal(harness.sessionStorage.getItem(SESSION_CACHE_KEY), null);
});

test('turning Phase 3 Off clears the session navigation snapshot', () => {
  const harness = install({ authoritativeState: fixture(23) });
  assert.notEqual(harness.sessionStorage.getItem(SESSION_CACHE_KEY), null);
  harness.core.setPhase3ReadMode('off');
  assert.equal(harness.sessionStorage.getItem(SESSION_CACHE_KEY), null);
  assert.equal(harness.core.getPhase3ReadStatus().configuredMode, 'off');
});

test('Compare mode ignores and clears a session navigation snapshot', () => {
  const harness = install({ authoritativeState: fixture(24), mode: 'compare' });
  const result = harness.core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-24');
  assert.equal(harness.sessionStorage.getItem(SESSION_CACHE_KEY), null);
  assert.equal(harness.core.getPhase3ReadStatus().indexedDbReadsTotal, 0);
});

test('sessionStorage quota failure is nonfatal and keeps the same-page cache usable', async () => {
  const harness = install({
    authoritativeState: fixture(25),
    cachedState: fixture(24),
    sessionSetFails: true
  });
  await harness.core.rebuildPhase3NavigationCache();
  const result = harness.core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-25');
  assert.equal(harness.core.getPhase3ReadStatus().indexedDbReadsTotal, 1);
});
