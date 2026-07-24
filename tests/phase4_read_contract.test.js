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

function readPlannedModule() {
  assert.equal(
    fs.existsSync(MODULE_PATH),
    true,
    'Phase 4.1 is intentionally red: phase4_primary_read_path.js has not been implemented yet.'
  );
  return fs.readFileSync(MODULE_PATH, 'utf8');
}

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
  clear() { this.rows.clear(); }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function fixture(version = 1) {
  return {
    completions: [{ id: 'c1', points: version }],
    matchups: [],
    gameHistory: [],
    seasonHistory: [],
    tasks: [{ id: `task-${version}`, version }],
    habits: [{ id: 'h1' }],
    players: [{ id: 'p1', imageId: 'player-image' }],
    schedule: [],
    settings: { sound: true },
    youImageId: 'profile-image'
  };
}

function verifiedCache(state, mirrorRaw = JSON.stringify(state), sequence = 1) {
  const hash = stateHash(state);
  return {
    schemaVersion: 1,
    sequence,
    state,
    serializedState: JSON.stringify(state),
    sourceHash: hash,
    destinationHash: hash,
    mirrorRaw,
    mirrorHash: stateHash(mirrorRaw),
    status: 'passed_verification',
    verifiedAt: '2026-07-24T16:35:03.184Z'
  };
}

function install({
  authoritativeState = fixture(1),
  primaryState = authoritativeState,
  mode = 'indexeddb_primary',
  phase2Pending = 0,
  phase4Pending = 0,
  journal = [],
  journalRaw = null,
  cache = verifiedCache(primaryState, JSON.stringify(authoritativeState)),
  mutateDuringPrimaryRead = null
} = {}) {
  const source = readPlannedModule();
  const authoritativeRaw = JSON.stringify(authoritativeState);
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: authoritativeRaw,
    [MODE_KEY]: mode,
    ...((journalRaw != null || journal.length) ? { [JOURNAL_KEY]: journalRaw != null ? String(journalRaw) : JSON.stringify(journal) } : {})
  });
  const sessionStorage = new FakeStorage();
  const listeners = new Map();
  let originalLoadCalls = 0;
  let clearCacheCalls = 0;
  const capturedOptions = [];
  let currentCache = cache;

  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PHASE4_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY,
    getPhase4StorageMode() {
      const value = localStorage.getItem(MODE_KEY);
      return ['off', 'verify_primary_writes', 'indexeddb_primary'].includes(value) ? value : 'off';
    },
    setPhase4StorageMode(value) {
      const next = ['off', 'verify_primary_writes', 'indexeddb_primary'].includes(value) ? value : 'off';
      localStorage.setItem(MODE_KEY, next);
      return next;
    },
    getPendingShadowDualWriteCount: () => phase2Pending,
    getPendingPhase4WriteCount: () => phase4Pending,
    readPendingHabitDeltas: () => {
      const raw = localStorage.getItem(JOURNAL_KEY);
      return raw ? JSON.parse(raw) : [];
    },
    parseTaskPointsStorageJson(raw, fallback = {}) { return raw ? JSON.parse(raw) : fallback; },
    shadowCanonicalJson: canonical,
    shadowSourceSummary(state) { return { counts: {}, hashes: { state: stateHash(state) } }; },
    shadowVerificationMismatches(sourceValue, destinationValue) {
      return sourceValue.hashes.state === destinationValue.hashes.state ? [] : [{ type: 'overall_state' }];
    },
    getPhase4VerifiedPrimaryCache() { return currentCache; },
    setPhase4VerifiedPrimaryCache(next) { currentCache = next; return next; },
    clearPhase4Caches() { clearCacheCalls += 1; currentCache = null; return true; },
    getPhase4StorageStatus() {
      let diagnostics = {};
      try { diagnostics = JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY) || '{}'); } catch (_) {}
      return {
        configuredMode: this.getPhase4StorageMode(),
        effectiveSource: diagnostics.effectiveSource || 'localStorage',
        indexedDbReadsTotal: Number(diagnostics.indexedDbReadsTotal) || 0,
        fallbackReadsTotal: Number(diagnostics.fallbackReadsTotal) || 0,
        lastFallbackReason: diagnostics.lastFallbackReason || null,
        cacheReadyThisPage: Boolean(currentCache),
        currentMirrorMatchesCache: Boolean(currentCache && localStorage.getItem(STORAGE_KEY) === currentCache.mirrorRaw)
      };
    },
    loadAppState(options = {}) {
      originalLoadCalls += 1;
      capturedOptions.push({ ...options });
      const raw = localStorage.getItem(STORAGE_KEY);
      localStorage.getItem(JOURNAL_KEY);
      if (mutateDuringPrimaryRead && options.persistSync === false) mutateDuringPrimaryRead({ localStorage, core });
      return { state: raw ? JSON.parse(raw) : {}, source: 'original-loader' };
    }
  };

  const context = {
    TaskPointsCore: core,
    localStorage,
    sessionStorage,
    Storage: FakeStorage,
    addEventListener(type, callback) {
      const rows = listeners.get(type) || [];
      rows.push(callback);
      listeners.set(type, rows);
    },
    queueMicrotask() {},
    structuredClone,
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'phase4_primary_read_path.js' });

  for (const method of [
    'getPhase4VerifiedPrimaryCache', 'setPhase4VerifiedPrimaryCache',
    'clearPhase4Caches', 'getPhase4StorageStatus', 'loadAppState'
  ]) {
    assert.equal(typeof core[method], 'function', `${method} must remain installed`);
  }

  return {
    core,
    localStorage,
    sessionStorage,
    authoritativeRaw,
    capturedOptions,
    originalLoadCalls: () => originalLoadCalls,
    clearCacheCalls: () => clearCacheCalls,
    dispatchStorage(event) {
      for (const callback of listeners.get('storage') || []) callback(event);
    }
  };
}

test('Off mode uses the untouched localStorage loader', () => {
  const harness = install({ mode: 'off', authoritativeState: fixture(1), primaryState: fixture(99) });
  const result = harness.core.loadAppState({ persistSync: true });
  const status = harness.core.getPhase4StorageStatus();
  assert.equal(result.state.tasks[0].id, 'task-1');
  assert.equal(status.effectiveSource, 'localStorage');
  assert.equal(status.indexedDbReadsTotal, 0);
  assert.equal(harness.capturedOptions[0].persistSync, true);
});

test('verify_primary_writes mode verifies writes but never serves a primary read', () => {
  const harness = install({ mode: 'verify_primary_writes', authoritativeState: fixture(2) });
  const result = harness.core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-2');
  assert.equal(harness.core.getPhase4StorageStatus().indexedDbReadsTotal, 0);
});

test('indexeddb_primary serves only a fully verified cache matching the live mirror', () => {
  const state = fixture(3);
  const harness = install({ mode: 'indexeddb_primary', authoritativeState: state, primaryState: state });
  const result = harness.core.loadAppState({ persistSync: true });
  const status = harness.core.getPhase4StorageStatus();

  assert.equal(result.state.tasks[0].id, 'task-3');
  assert.equal(status.effectiveSource, 'indexedDB');
  assert.equal(status.indexedDbReadsTotal, 1);
  assert.equal(status.fallbackReadsTotal, 0);
  assert.equal(harness.capturedOptions[0].persistSync, false);
});

test('a stale primary cache cannot override newer localStorage', () => {
  const harness = install({ authoritativeState: fixture(4), primaryState: fixture(3) });
  const result = harness.core.loadAppState();
  const status = harness.core.getPhase4StorageStatus();
  assert.equal(result.state.tasks[0].id, 'task-4');
  assert.equal(status.indexedDbReadsTotal, 0);
  assert.equal(status.lastFallbackReason, 'mirror_mismatch');
});

test('a missing mirror is an empty/reset signal and never serves stale primary state', () => {
  const harness = install({ authoritativeState: fixture(5), primaryState: fixture(5) });
  harness.localStorage.removeItem(STORAGE_KEY);
  const result = harness.core.loadAppState();
  const status = harness.core.getPhase4StorageStatus();
  assert.deepEqual(result.state, {});
  assert.equal(status.indexedDbReadsTotal, 0);
  assert.equal(status.lastFallbackReason, 'authoritative_missing');
});

test('a pending Phase 2 dual write forces localStorage fallback', () => {
  const harness = install({ authoritativeState: fixture(6), phase2Pending: 1 });
  harness.core.loadAppState();
  assert.equal(harness.core.getPhase4StorageStatus().lastFallbackReason, 'dual_write_pending');
});

test('a pending Phase 4 write forces localStorage fallback', () => {
  const harness = install({ authoritativeState: fixture(7), phase4Pending: 1 });
  harness.core.loadAppState();
  assert.equal(harness.core.getPhase4StorageStatus().lastFallbackReason, 'phase4_write_pending');
});

test('a pending habit journal forces localStorage fallback', () => {
  const harness = install({
    authoritativeState: fixture(8),
    journal: [{ id: 'habit:h1:2026-07-24', habitId: 'h1', dayKey: '2026-07-24', source: 'habit' }]
  });
  harness.core.loadAppState();
  assert.equal(harness.core.getPhase4StorageStatus().lastFallbackReason, 'pending_habit_journal');
});

test('mirror mutation during an IndexedDB-assisted read discards the result and reruns the original loader', () => {
  const original = fixture(9);
  const newer = fixture(10);
  let mutated = false;
  const harness = install({
    authoritativeState: original,
    primaryState: original,
    mutateDuringPrimaryRead({ localStorage }) {
      if (mutated) return;
      mutated = true;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newer));
    }
  });
  const result = harness.core.loadAppState({ persistSync: true });
  const status = harness.core.getPhase4StorageStatus();
  assert.equal(result.state.tasks[0].id, 'task-10');
  assert.equal(harness.originalLoadCalls(), 2);
  assert.equal(status.lastFallbackReason, 'mirror_changed_during_primary_read');
  assert.equal(harness.capturedOptions[0].persistSync, false);
  assert.equal(harness.capturedOptions[1].persistSync, true);
});

test('journal appearance, replacement, or clearing during a primary read discards the attempt', () => {
  for (const [name, before, after] of [
    ['appearance', null, JSON.stringify([{ id: 'j1', habitId: 'h1', dayKey: '2026-07-24', source: 'habit' }])],
    ['replacement', '[]', JSON.stringify([{ id: 'j2', habitId: 'h1', dayKey: '2026-07-25', source: 'habit' }])],
    ['clearing', '[]', null]
  ]) {
    let changed = false;
    const harness = install({
      authoritativeState: fixture(11),
      journalRaw: before,
      mutateDuringPrimaryRead({ localStorage }) {
        if (changed) return;
        changed = true;
        if (after == null) localStorage.removeItem(JOURNAL_KEY);
        else localStorage.setItem(JOURNAL_KEY, after);
      }
    });
    harness.core.loadAppState();
    assert.equal(
      harness.core.getPhase4StorageStatus().lastFallbackReason,
      'journal_changed_during_primary_read',
      name
    );
  }
});

test('switching Phase 4 Off clears the primary cache and immediately restores Phase 3/localStorage behavior', () => {
  const harness = install({ authoritativeState: fixture(12) });
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
  harness.core.setPhase4StorageMode('off');
  const result = harness.core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-12');
  assert.equal(harness.core.getPhase4StorageStatus().configuredMode, 'off');
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, false);
  assert.equal(harness.clearCacheCalls() > 0, true);
});

test('cross-tab save or reset invalidates the primary cache before the next load', () => {
  for (const event of [
    { name: 'save', newValue: JSON.stringify(fixture(14)) },
    { name: 'reset', newValue: null }
  ]) {
    const harness = install({ authoritativeState: fixture(13) });
    if (event.newValue == null) harness.localStorage.removeItem(STORAGE_KEY);
    else harness.localStorage.setItem(STORAGE_KEY, event.newValue);
    harness.dispatchStorage({
      key: STORAGE_KEY,
      oldValue: harness.authoritativeRaw,
      newValue: event.newValue,
      storageArea: harness.localStorage
    });
    harness.core.loadAppState();
    assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, false, event.name);
    assert.equal(harness.core.getPhase4StorageStatus().indexedDbReadsTotal, 0, event.name);
  }
});

test('invalid mode values fail closed to localStorage', () => {
  const harness = install({ mode: 'corrupt-mode', authoritativeState: fixture(15) });
  const result = harness.core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-15');
  assert.equal(harness.core.getPhase4StorageStatus().configuredMode, 'off');
  assert.equal(harness.core.getPhase4StorageStatus().indexedDbReadsTotal, 0);
});

test('image references remain ordinary state and the primary read path performs no image database access', () => {
  let imageDbOpened = false;
  const harness = install({ authoritativeState: fixture(16) });
  harness.core.openImageDb = () => { imageDbOpened = true; throw new Error('must not be called'); };
  const result = harness.core.loadAppState();
  assert.equal(result.state.players[0].imageId, 'player-image');
  assert.equal(result.state.youImageId, 'profile-image');
  assert.equal(imageDbOpened, false);
});
