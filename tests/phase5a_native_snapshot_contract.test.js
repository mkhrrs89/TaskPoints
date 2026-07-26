const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'phase5a_native_snapshot.js');
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const DB_NAME = 'taskpoints_shadow_state_v1';

class FakeStorage {
  constructor(initial = {}) { this.rows = new Map(Object.entries(initial).map(([k, v]) => [String(k), String(v)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}
function hashValue(value) { return hashText(canonical(value)); }
function summary(state) {
  return {
    counts: { tasks: Array.isArray(state.tasks) ? state.tasks.length : 0 },
    hashes: { state: hashText(canonical(state || {})) }
  };
}

function createFakeIndexedDb() {
  const databases = new Map();
  const request = (run) => {
    const req = {};
    queueMicrotask(() => {
      try { req.result = run(); req.onsuccess?.(); }
      catch (error) { req.error = error; req.onerror?.(); }
    });
    return req;
  };
  class Store {
    constructor(def) { this.def = def; this.rows = new Map(); }
    key(value, key) { return key ?? value[this.def.keyPath]; }
  }
  class Database {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this.stores = new Map();
      this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    }
    createObjectStore(name, def = {}) {
      const store = new Store(def);
      this.stores.set(name, store);
      return store;
    }
    transaction(names) {
      const list = Array.isArray(names) ? names : [names];
      const db = this;
      const tx = {
        error: null,
        objectStore(name) {
          if (!list.includes(name)) throw new Error('store not in transaction');
          const store = db.stores.get(name);
          if (!store) throw new Error(`missing store: ${name}`);
          return {
            put(value, key) {
              store.rows.set(store.key(value, key), structuredClone(value));
              return request(() => key);
            },
            get(key) { return request(() => structuredClone(store.rows.get(key))); },
            delete(key) { store.rows.delete(key); return request(() => undefined); }
          };
        },
        abort() { tx.onabort?.(); }
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    }
    close() {}
  }
  return {
    open(name, version) {
      const req = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        const upgrade = !db;
        if (!db) { db = new Database(name, version || 1); databases.set(name, db); }
        req.result = db;
        if (upgrade) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    _db(name) { return databases.get(name); }
  };
}

async function seedCommit(indexedDB, mirrorRaw, state, sequence = 3) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('metadata', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('metadata', 'readwrite');
  tx.objectStore('metadata').put({
    id: 'phase4_primary_commit',
    status: 'passed_verification',
    sequence,
    mirrorHash: hashValue(mirrorRaw),
    verification: { destination: summary(state), source: summary(state) }
  });
  await new Promise((resolve) => { tx.oncomplete = resolve; });
}

async function getMetadata(indexedDB, key) {
  const db = indexedDB._db(DB_NAME);
  const tx = db.transaction('metadata', 'readonly');
  return await new Promise((resolve, reject) => {
    const req = tx.objectStore('metadata').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function install({ mode = 'indexeddb_primary', mirrorRaw = 'opaque-compressed-mirror', state = { tasks: [{ id: 't1' }] } } = {}) {
  const completeState = {
    reminders: [], completions: [], players: [], habits: [], flexActions: [], gameHistory: [], matchups: [],
    schedule: [], opponentDripSchedules: [], weightHistory: [], vo2MaxHistory: [], workHistory: [],
    liveDiffHistory: {}, liveDiffSnapshots: {}, projects: [], notes: '', habitTagColors: {}, scoringSettings: {},
    playerBadges: {}, currentSeason: null, latestSeasonId: '', seasonHistory: [],
    ...state
  };
  const localStorage = new FakeStorage({ [MODE_KEY]: mode, [STORAGE_KEY]: mirrorRaw, [JOURNAL_KEY]: '[]' });
  const indexedDB = createFakeIndexedDb();
  await seedCommit(indexedDB, mirrorRaw, completeState);
  let phase4Cache = {
    schemaVersion: 1,
    sequence: 3,
    committedSequence: 3,
    state: structuredClone(completeState),
    serializedState: mirrorRaw,
    sourceHash: summary(completeState).hashes.state,
    destinationHash: summary(completeState).hashes.state,
    sourceCounts: summary(completeState).counts,
    destinationCounts: summary(completeState).counts,
    mirrorRaw,
    mirrorHash: hashValue(mirrorRaw),
    status: 'passed_verification'
  };
  let fallbackLoadCalls = 0;
  let nativeNormalizeCalls = 0;
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    PHASE4_DIAGNOSTICS_KEY: 'taskpoints_phase4_diagnostics_v1',
    PHASE4_PRIMARY_COMMIT_METADATA_ID: 'phase4_primary_commit',
    SHADOW_MIGRATION_DB_NAME: DB_NAME,
    SHADOW_MIGRATION_DB_VERSION: 1,
    getPhase4StorageMode: () => localStorage.getItem(MODE_KEY) || 'off',
    setPhase4StorageMode(next) { localStorage.setItem(MODE_KEY, next); return next; },
    flushPhase4PrimaryWrites: async () => undefined,
    getPendingPhase4WriteCount: () => 0,
    getPendingShadowDualWriteCount: () => 0,
    readPendingHabitDeltas: () => JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]'),
    getPhase4VerifiedPrimaryCache: () => phase4Cache,
    setPhase4VerifiedPrimaryCache(value) { phase4Cache = value; return value; },
    clearPhase4Caches() { phase4Cache = null; return true; },
    shadowCanonicalJson: canonical,
    shadowSourceSummary: summary,
    normalizeState(value) { nativeNormalizeCalls += 1; return structuredClone(value); },
    syncDerivedPoints(value) { return { state: value, changed: false }; },
    syncYouMatchups(value) { return { state: value, changed: false }; },
    repairSeasonChampionshipData(value) { return { ok: false, state: value }; },
    mergeAndSaveState() { throw new Error('native read must not persist'); },
    loadAppState() {
      fallbackLoadCalls += 1;
      return { state: JSON.parse(localStorage.getItem(STORAGE_KEY)) };
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    indexedDB,
    Storage: FakeStorage,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'phase5a_native_snapshot.js' });
  await core.flushPhase5ANativeSnapshotWrites();
  return {
    core, localStorage, indexedDB, state: completeState, mirrorRaw,
    fallbackLoadCalls: () => fallbackLoadCalls,
    nativeNormalizeCalls: () => nativeNormalizeCalls
  };
}

test('installs native snapshot APIs without replacing Phase 4 controls', async () => {
  const { core } = await install({ mode: 'verify_primary_writes' });
  assert.equal(core.PHASE5A_NATIVE_SNAPSHOT_METADATA_ID, 'phase5a_native_snapshot');
  assert.equal(core.PHASE5A_NATIVE_SNAPSHOT_FORMAT, 'metadata_structured_clone_v1');
  assert.equal(typeof core.restorePhase5ANativeSnapshot, 'function');
  assert.equal(typeof core.queuePhase5ANativeSnapshotWrite, 'function');
  assert.equal(typeof core.flushPhase5ANativeSnapshotWrites, 'function');
  assert.equal(typeof core.getPhase4StorageMode, 'function');
});

test('writes the normal state object directly into IndexedDB', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  await harness.core.queuePhase5ANativeSnapshotWrite();
  await harness.core.flushPhase5ANativeSnapshotWrites();
  const record = await getMetadata(harness.indexedDB, 'phase5a_native_snapshot');
  assert.equal(record.status, 'passed_verification');
  assert.equal(record.snapshotFormat, 'metadata_structured_clone_v1');
  assert.deepEqual(record.state, harness.state);
  assert.equal(Object.hasOwn(record, 'serializedState'), false);
});

test('restores and serves native state without parsing or stringifying the opaque rollback mirror', async () => {
  const harness = await install({ mode: 'indexeddb_primary' });
  await harness.core.queuePhase5ANativeSnapshotWrite();
  await harness.core.flushPhase5ANativeSnapshotWrites();
  harness.core.clearPhase5ANativeSnapshotCache();
  const restored = await harness.core.restorePhase5ANativeSnapshot();
  assert.equal(restored, true);
  const loaded = harness.core.loadAppState({ persistSync: false });
  assert.deepEqual(loaded.state, harness.state);
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), harness.mirrorRaw);
  assert.equal(harness.core.getPhase5ANativeSnapshotStatus().cacheReady, true);
  assert.equal(harness.fallbackLoadCalls(), 0);
  assert.ok(harness.nativeNormalizeCalls() > 0);
  assert.equal(harness.core.getPhase5ANativeSnapshotCache().serializedState, null);
});

test('falls back when the rollback mirror changes', async () => {
  const harness = await install({ mode: 'indexeddb_primary' });
  await harness.core.queuePhase5ANativeSnapshotWrite();
  await harness.core.flushPhase5ANativeSnapshotWrites();
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks: [{ id: 'newer' }] }));
  const loaded = harness.core.loadAppState({ persistSync: false });
  assert.equal(loaded.state.tasks[0].id, 'newer');
  assert.equal(harness.fallbackLoadCalls(), 1);
});

test('worker loads Phase 5A only after the complete Phase 4 bundle and keeps generated navigation JavaScript valid', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /'\/phase5a_native_snapshot\.js'/);
  assert.match(worker, /completePhase5A/);
  assert.match(worker, /5a-native-indexeddb-snapshot/);
  assert.match(worker, /Phase 5A native snapshot failed to install; Phase 4 remains active/);
  assert.match(worker, /try \{ result\.set\(name, Object\.getOwnPropertyDescriptor\(target, name\) \|\| null\); \}/);
});
