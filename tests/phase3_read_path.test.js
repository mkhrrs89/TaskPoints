const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const localRows = new Map();
const storage = {
  getItem(key) { return localRows.has(String(key)) ? localRows.get(String(key)) : null; },
  setItem(key, value) { localRows.set(String(key), String(value)); },
  removeItem(key) { localRows.delete(String(key)); },
  key(index) { return [...localRows.keys()][index] ?? null; },
  get length() { return localRows.size; }
};

global.window = global;
global.localStorage = storage;
global.queueMicrotask ||= queueMicrotask;

const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];
let pendingWrites = 0;
let throwOnLoad = false;
let originalLoadCalls = 0;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hashDetails(value) {
  const text = canonical(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return { hash: `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`, canonicalLength: text.length };
}
function sourceLayout(state) {
  const source = state && typeof state === 'object' ? state : {};
  const arrays = {}, values = {}, collections = {};
  Object.keys(source).forEach((field) => {
    if (ARRAY_STORES.includes(field) && Array.isArray(source[field])) arrays[field] = source[field];
    else if (Array.isArray(source[field])) collections[field] = source[field];
    else values[field] = source[field];
  });
  ARRAY_STORES.forEach((field) => { if (!arrays[field]) arrays[field] = []; });
  return { arrays, values, collections };
}
function sourceSummary(state) {
  const layout = sourceLayout(state);
  const counts = {};
  Object.entries(layout.arrays).forEach(([field, rows]) => { counts[field] = rows.length; });
  Object.entries(layout.collections).forEach(([field, rows]) => { counts[field] = rows.length; });
  counts.topLevelValues = Object.keys(layout.values).length;
  const canonicalLayout = { arrays: layout.arrays, collections: layout.collections, values: layout.values };
  const stateDetail = hashDetails(canonicalLayout);
  const arrayDetails = Object.fromEntries(Object.entries(layout.arrays).map(([field, value]) => [field, hashDetails(value)]));
  const collectionDetails = Object.fromEntries(Object.entries(layout.collections).map(([field, value]) => [field, hashDetails(value)]));
  const valuesDetail = hashDetails(layout.values);
  return {
    counts,
    hashes: {
      state: stateDetail.hash,
      arrays: Object.fromEntries(Object.entries(arrayDetails).map(([field, detail]) => [field, detail.hash])),
      collections: Object.fromEntries(Object.entries(collectionDetails).map(([field, detail]) => [field, detail.hash])),
      values: valuesDetail.hash
    },
    hashDetails: { state: stateDetail, arrays: arrayDetails, collections: collectionDetails, values: valuesDetail }
  };
}
function mismatches(source, destination) {
  const out = [];
  if (source.hashes.state !== destination.hashes.state) out.push({ type: 'hash', field: 'overallState' });
  return out;
}

const core = global.TaskPointsCore = {
  STORAGE_KEY: 'taskpoints_v1',
  SHADOW_MIGRATION_DB_NAME: 'taskpoints_shadow_state_v1',
  SHADOW_MIGRATION_DB_VERSION: 1,
  SHADOW_MIGRATION_SCHEMA_VERSION: 1,
  SHADOW_DUAL_WRITE_METADATA_ID: 'dual_write',
  IMAGE_DB_NAME: 'taskpoints',
  shadowCanonicalJson: canonical,
  shadowSourceLayout: sourceLayout,
  shadowSourceSummary: sourceSummary,
  shadowVerificationMismatches: mismatches,
  parseTaskPointsStorageJson(raw, fallback = {}) { return raw ? JSON.parse(raw) : fallback; },
  flushShadowDualWrites: async () => undefined,
  getPendingShadowDualWriteCount: () => pendingWrites,
  loadAppState() {
    originalLoadCalls += 1;
    if (throwOnLoad) throw new Error('original loader failure');
    const raw = global.localStorage.getItem(this.STORAGE_KEY);
    return { state: raw ? JSON.parse(raw) : {}, storageKeysFound: raw ? [this.STORAGE_KEY] : [], pendingHabitDeltas: [] };
  }
};

require(path.join(__dirname, '..', 'phase3_read_path.js'));

function fixture(version = 1) {
  return {
    completions: [{ id: 'c1', points: version }],
    matchups: [{ id: 'm1' }],
    gameHistory: [{ id: 'g1' }],
    seasonHistory: [{ id: 's1' }],
    tasks: [{ id: `task-${version}`, version }],
    habits: [{ id: 'h1' }],
    players: [{ id: 'p1', imageId: 'player-image' }],
    schedule: [],
    opponentDripSchedules: [],
    storageWarnings: [],
    workHistory: [],
    futureEmpty: [],
    futureRows: [{ id: 'same' }, { id: 'same' }, { version }],
    settings: { sound: true }
  };
}

function createFakeIndexedDb() {
  const databases = new Map();
  let openCount = 0;
  const request = (run) => {
    const req = {};
    queueMicrotask(() => {
      try { req.result = run(); req.onsuccess?.(); }
      catch (error) { req.error = error; req.onerror?.(); }
    });
    return req;
  };
  class Store {
    constructor(def = {}) { this.def = def; this.rows = new Map(); }
    key(value, key) { return key ?? value[this.def.keyPath]; }
  }
  class Database {
    constructor(name, version) {
      this.name = name; this.version = version; this.stores = new Map();
      this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    }
    createObjectStore(name, def = {}) { const store = new Store(def); this.stores.set(name, store); return store; }
    transaction(names) {
      const list = Array.isArray(names) ? names : [names];
      const db = this;
      return {
        objectStore(name) {
          if (!list.includes(name)) throw new Error('store not in transaction');
          const store = db.stores.get(name);
          if (!store) throw new Error(`missing store: ${name}`);
          return {
            put(value, key) { store.rows.set(store.key(value, key), structuredClone(value)); return request(() => key); },
            clear() { store.rows.clear(); return request(() => undefined); },
            get(key) { return request(() => structuredClone(store.rows.get(key))); },
            getAll() { return request(() => [...store.rows.values()].map((value) => structuredClone(value))); },
            getAllKeys() { return request(() => [...store.rows.keys()]); }
          };
        }
      };
    }
    close() {}
  }
  return {
    databases: async () => [...databases.values()].map((db) => ({ name: db.name, version: db.version })),
    open(name, version) {
      openCount += 1;
      const req = {};
      queueMicrotask(() => {
        try {
          let db = databases.get(name);
          const requested = version ?? db?.version ?? 1;
          const upgrade = !db || requested > db.version;
          if (!db) { db = new Database(name, requested); databases.set(name, db); }
          else if (upgrade) db.version = requested;
          req.result = db;
          req.transaction = { abort() {} };
          if (upgrade) req.onupgradeneeded?.();
          req.onsuccess?.();
        } catch (error) { req.error = error; req.onerror?.(); }
      });
      return req;
    },
    _db: (name) => databases.get(name),
    _openCount: () => openCount
  };
}

async function openFakeDb(idb) {
  return await new Promise((resolve, reject) => {
    const req = idb.open(core.SHADOW_MIGRATION_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      [...ARRAY_STORES, 'collections'].forEach((name) => db.createObjectStore(name, { keyPath: 'key' }));
      db.createObjectStore('values', { keyPath: 'field' });
      db.createObjectStore('metadata', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function seedShadow(idb, state, options = {}) {
  const db = idb._db(core.SHADOW_MIGRATION_DB_NAME) || await openFakeDb(idb);
  const layout = sourceLayout(state);
  const stores = [...ARRAY_STORES, 'collections', 'values', 'metadata'];
  const tx = db.transaction(stores, 'readwrite');
  [...ARRAY_STORES, 'collections'].forEach((name) => tx.objectStore(name).clear());
  tx.objectStore('values').clear();
  Object.entries(layout.arrays).forEach(([field, rows]) => rows.forEach((value, index) => tx.objectStore(field).put({ key: index, value })));
  Object.entries(layout.collections).forEach(([field, rows]) => {
    tx.objectStore('collections').put({ key: `manifest:${field}`, kind: 'manifest', field });
    rows.forEach((value, index) => tx.objectStore('collections').put({ key: `item:${field}:${index}`, kind: 'item', field, index, value }));
  });
  Object.entries(layout.values).forEach(([field, value]) => tx.objectStore('values').put({ field, value }));
  const summary = sourceSummary(state);
  tx.objectStore('metadata').put({ id: 'current', status: options.currentStatus || 'passed_verification' });
  tx.objectStore('metadata').put({
    id: 'dual_write',
    status: options.dualStatus || 'passed_verification',
    verification: {
      source: { hashes: { state: options.dualSourceHash || summary.hashes.state } },
      destination: { hashes: { state: options.dualDestinationHash || summary.hashes.state } }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return db;
}

async function reset(state = fixture(1), mode = 'off') {
  await Promise.resolve();
  localRows.clear();
  localRows.set(core.STORAGE_KEY, JSON.stringify(state));
  localRows.set(core.PHASE3_READ_MODE_KEY, mode);
  core.clearPhase3ReadCache();
  pendingWrites = 0;
  throwOnLoad = false;
  originalLoadCalls = 0;
}

test('default mode is off and does not open IndexedDB', async () => {
  await reset(fixture(1), 'off');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  const result = core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-1');
  assert.equal(idb._openCount(), 0);
  assert.equal(core.getPhase3ReadStatus().configuredMode, 'off');
});

test('compare mode verifies exact IndexedDB state but always serves localStorage', async () => {
  const state = fixture(2);
  await reset(state, 'compare');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state);
  const status = await core.getPhase3ReadStatus({ refresh: true, indexedDB: idb });
  assert.equal(status.status, 'compare_passed');
  assert.equal(status.hashesMatch, true);
  assert.equal(status.countsMatch, true);
  assert.equal(status.sourceCounts.futureEmpty, 0);
  const beforeCalls = originalLoadCalls;
  const result = core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-2');
  assert.equal(core.getPhase3ReadStatus().indexedDbReadsTotal, 0);
  assert.equal(originalLoadCalls, beforeCalls + 1);
});

test('verified mode serves an exact cached IndexedDB snapshot on later synchronous loads', async () => {
  const state = fixture(3);
  await reset(state, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state);
  const warmed = await core.getPhase3ReadStatus({ refresh: true, indexedDB: idb });
  assert.equal(warmed.status, 'ready');
  assert.equal(warmed.cacheReadyThisPage, true);
  const getItemBefore = global.localStorage.getItem;
  const result = core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-3');
  const status = core.getPhase3ReadStatus();
  assert.equal(status.effectiveSource, 'indexedDB');
  assert.equal(status.indexedDbReadsTotal, 1);
  assert.equal(global.localStorage.getItem, getItemBefore, 'temporary read override must be restored');
});

test('a changed authoritative raw value immediately forces localStorage fallback', async () => {
  const state = fixture(4);
  await reset(state, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state);
  await core.refreshPhase3ReadCache({ indexedDB: idb, force: true });
  const newer = fixture(5);
  localRows.set(core.STORAGE_KEY, JSON.stringify(newer));
  const result = core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-5');
  assert.equal(core.getPhase3ReadStatus().lastFallbackReason, 'authoritative_changed_since_verification');
});

test('a missing authoritative key can never resurrect cached IndexedDB state', async () => {
  const state = fixture(6);
  await reset(state, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state);
  await core.refreshPhase3ReadCache({ indexedDB: idb, force: true });
  localRows.delete(core.STORAGE_KEY);
  const result = core.loadAppState();
  assert.deepEqual(result.state, {});
  assert.equal(core.getPhase3ReadStatus().lastFallbackReason, 'authoritative_missing');
});

test('pending dual writes force localStorage fallback even with a ready cache', async () => {
  const state = fixture(7);
  await reset(state, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state);
  await core.refreshPhase3ReadCache({ indexedDB: idb, force: true });
  pendingWrites = 1;
  const result = core.loadAppState();
  assert.equal(result.state.tasks[0].id, 'task-7');
  assert.equal(core.getPhase3ReadStatus().lastFallbackReason, 'dual_write_pending');
});

test('a shadow mismatch opens fallback and does not touch the image database', async () => {
  const authoritative = fixture(8);
  const shadow = fixture(9);
  await reset(authoritative, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, shadow);
  const status = await core.getPhase3ReadStatus({ refresh: true, indexedDB: idb });
  assert.equal(status.status, 'fallback');
  assert.equal(status.lastFallbackReason, 'hash_mismatch');
  assert.equal(status.cacheReadyThisPage, false);
  assert.equal(idb._db(core.IMAGE_DB_NAME), undefined);
});

test('Phase 1 and dual-write verification metadata are both required', async () => {
  const state = fixture(10);
  await reset(state, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state, { dualStatus: 'failed' });
  const status = await core.getPhase3ReadStatus({ refresh: true, indexedDB: idb });
  assert.equal(status.status, 'fallback');
  assert.equal(status.lastFallbackReason, 'dual_write_not_verified');
});

test('temporary getItem override is restored even when the original loader throws', async () => {
  const state = fixture(11);
  await reset(state, 'verified_indexeddb');
  const idb = createFakeIndexedDb();
  global.indexedDB = idb;
  await seedShadow(idb, state);
  await core.refreshPhase3ReadCache({ indexedDB: idb, force: true });
  const getItemBefore = global.localStorage.getItem;
  throwOnLoad = true;
  assert.throws(() => core.loadAppState(), /original loader failure/);
  assert.equal(global.localStorage.getItem, getItemBefore);
  throwOnLoad = false;
});
