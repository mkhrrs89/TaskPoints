const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const READ_PATH = path.join(__dirname, '..', 'phase4_primary_read_path.js');
const CODEC_PATH = path.join(__dirname, '..', 'phase3_session_codec.js');
const STATUS_PATH = path.join(__dirname, '..', 'phase4_storage_status.html');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';
const SESSION_KEY = 'taskpoints_phase4_verified_primary_cache_v1';

class FakeStorage {
  constructor(initial = {}) { this.rows = new Map(Object.entries(initial).map(([k,v]) => [String(k), String(v)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) {
  const text = canonical(value);
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) { result ^= text.charCodeAt(index); result = Math.imul(result, 16777619); }
  return `${(result >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}
function fixture(version = 1) {
  return { completions: [], matchups: [], gameHistory: [], seasonHistory: [], tasks: [{ id: `task-${version}` }], habits: [], players: [{ id: 'p1', imageId: 'img-1' }], settings: { version } };
}
function cacheRecord(state, mirrorRaw, sequence = 4) {
  const stateHash = hash(state);
  return {
    schemaVersion: 1, sequence, state, serializedState: JSON.stringify(state), sourceHash: stateHash,
    destinationHash: stateHash, sourceCounts: {}, destinationCounts: {}, mirrorRaw,
    mirrorHash: hash(mirrorRaw), status: 'passed_verification', verifiedAt: '2026-07-24T22:00:00.000Z'
  };
}
async function install({ mode = 'indexeddb_primary', sessionRecord = null } = {}) {
  const state = fixture(1);
  const mirrorRaw = JSON.stringify(state);
  const localStorage = new FakeStorage({ [STORAGE_KEY]: mirrorRaw, [MODE_KEY]: mode });
  const sessionStorage = new FakeStorage(sessionRecord ? { [SESSION_KEY]: JSON.stringify(sessionRecord) } : {});
  const listeners = new Map();
  const microtasks = [];
  let currentCache = null;
  let queueCalls = 0;
  const core = {
    STORAGE_KEY, PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY, PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PHASE4_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY, PHASE4_SESSION_CACHE_KEY: SESSION_KEY,
    getPhase4StorageMode() { return localStorage.getItem(MODE_KEY) || 'off'; },
    setPhase4StorageMode(value) { localStorage.setItem(MODE_KEY, value); return value; },
    getPendingShadowDualWriteCount: () => 0,
    getPendingPhase4WriteCount: () => 0,
    readPendingHabitDeltas: () => [],
    parseTaskPointsStorageJson: (raw, fallback = {}) => raw ? JSON.parse(raw) : fallback,
    shadowCanonicalJson: canonical,
    shadowSourceSummary(value) { return { counts: {}, hashes: { state: hash(value) } }; },
    shadowVerificationMismatches(left, right) { return left.hashes.state === right.hashes.state ? [] : [{ type: 'state' }]; },
    getPhase4VerifiedPrimaryCache: () => currentCache,
    setPhase4VerifiedPrimaryCache(value) { currentCache = value || null; return currentCache; },
    clearPhase4Caches() { currentCache = null; sessionStorage.removeItem(SESSION_KEY); return true; },
    queuePhase4PrimaryWrite() {
      queueCalls += 1;
      currentCache = cacheRecord(state, mirrorRaw, queueCalls + 10);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentCache));
      return Promise.resolve();
    },
    flushPhase4PrimaryWrites: () => Promise.resolve(),
    getPhase4StorageStatus() {
      let diagnostics = {};
      try { diagnostics = JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY) || '{}'); } catch (_) {}
      return { configuredMode: this.getPhase4StorageMode(), effectiveSource: diagnostics.effectiveSource || 'localStorage', cacheReadyThisPage: Boolean(currentCache), currentMirrorMatchesCache: Boolean(currentCache && currentCache.mirrorRaw === mirrorRaw) };
    },
    loadAppState(options = {}) {
      const raw = localStorage.getItem(STORAGE_KEY);
      localStorage.getItem(JOURNAL_KEY);
      return { state: raw ? JSON.parse(raw) : {}, options };
    }
  };
  const context = {
    TaskPointsCore: core, localStorage, sessionStorage, Storage: FakeStorage,
    addEventListener(type, callback) { const rows = listeners.get(type) || []; rows.push(callback); listeners.set(type, rows); },
    queueMicrotask(callback) { microtasks.push(callback); },
    structuredClone, JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(READ_PATH, 'utf8'), context, { filename: 'phase4_primary_read_path.js' });
  async function drain() {
    while (microtasks.length) microtasks.shift()();
    await Promise.resolve();
    await core.warmPhase4PrimaryCache?.('test_drain');
    await Promise.resolve();
  }
  return { core, localStorage, sessionStorage, mirrorRaw, state, drain, queueCalls: () => queueCalls };
}

test('Phase 4 restores a matching verified primary cache from compressed session storage semantics', async () => {
  const state = fixture(1);
  const mirrorRaw = JSON.stringify(state);
  const harness = await install({ sessionRecord: cacheRecord(state, mirrorRaw) });
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
  assert.equal(harness.core.getPhase4StorageStatus().cacheRestoredFromSession, true);
  assert.equal(harness.queueCalls(), 0);
  const result = harness.core.loadAppState({ persistSync: true });
  assert.equal(result.state.tasks[0].id, 'task-1');
  assert.equal(harness.core.getPhase4StorageStatus().effectiveSource, 'indexedDB');
});

test('a cold IndexedDB Primary page schedules one verified cache warmup', async () => {
  const harness = await install();
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, false);
  await harness.drain();
  assert.equal(harness.queueCalls(), 1);
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
  assert.equal(harness.core.getPhase4StorageStatus().effectiveSource, 'indexedDB_ready');
});

test('switching from Off to IndexedDB Primary schedules cache warmup', async () => {
  const harness = await install({ mode: 'off' });
  harness.core.setPhase4StorageMode('indexeddb_primary');
  await harness.drain();
  assert.equal(harness.queueCalls(), 1);
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, true);
});

test('the shared session codec manages the Phase 4 cache key', () => {
  const source = fs.readFileSync(CODEC_PATH, 'utf8');
  assert.match(source, /taskpoints_phase4_verified_primary_cache_v1/);
  assert.match(source, /MANAGED_SESSION_CACHE_KEYS/);
});

test('Phase 4 Refresh and mode selection explicitly warm a missing primary cache', () => {
  const html = fs.readFileSync(STATUS_PATH, 'utf8');
  assert.match(html, /warmPhase4PrimaryCache/);
  assert.match(html, /primaryNeedsWarmup/);
  assert.match(html, /indexeddb_primary_mode_enabled/);
  assert.match(html, /Checking…/);
});
