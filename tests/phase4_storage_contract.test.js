const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'phase4_storage_coordinator.js');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const DIAGNOSTICS_KEY = 'taskpoints_phase4_diagnostics_v1';
const SHADOW_DB = 'taskpoints_shadow_state_v1';
const ARRAY_STORES = ['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'];

function readPlannedModule() {
  assert.equal(
    fs.existsSync(MODULE_PATH),
    true,
    'Phase 4.1 is intentionally red: phase4_storage_coordinator.js has not been implemented yet.'
  );
  return fs.readFileSync(MODULE_PATH, 'utf8');
}

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
    this.failKey = null;
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) {
    if (String(key) === this.failKey) throw new Error('QuotaExceededError');
    this.rows.set(String(key), String(value));
  }
  removeItem(key) { this.rows.delete(String(key)); }
  clear() { this.rows.clear(); }
  key(index) { return [...this.rows.keys()][index] ?? null; }
  get length() { return this.rows.size; }
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

function hashText(text) {
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
    hashes: { state: hashText(canonical(layout)) },
    hashDetails: {}
  };
}

function fixture(version = 1) {
  return {
    completions: [{ id: 'c1', points: version }],
    matchups: [{ id: 'm1', scoreA: version, scoreB: 0 }],
    gameHistory: [{ id: 'g1', score: version }],
    seasonHistory: [{ id: 's1' }],
    tasks: [{ id: `task-${version}`, version }],
    habits: [{ id: 'h1' }],
    players: [{ id: 'p1', imageId: 'player-image' }],
    schedule: [],
    reminders: [],
    futureRows: [{ id: 'duplicate' }, { id: 'duplicate' }, { version }],
    settings: { sound: true },
    youImageId: 'profile-image'
  };
}

function createFakeIndexedDb({ strictTransactions = true } = {}) {
  const databases = new Map();
  const openedNames = [];
  let failTransactionCount = 0;

  const request = (run, onFinish) => {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      } finally {
        onFinish?.();
      }
    });
    return req;
  };

  class Store {
    constructor(def) {
      this.def = def;
      this.rows = new Map();
    }
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
      if (failTransactionCount > 0) {
        failTransactionCount -= 1;
        throw new Error('forced_transaction_failure');
      }
      const db = this;
      const list = Array.isArray(names) ? names : [names];
      let active = true;
      const ensureActive = () => {
        if (!active) throw new Error('TransactionInactiveError');
      };
      const makeRequest = (run) => request(run, strictTransactions ? () => { active = false; } : null);
      const tx = {
        error: null,
        objectStore(name) {
          if (!list.includes(name)) throw new Error('store not in transaction');
          const store = db.stores.get(name);
          if (!store) throw new Error(`missing store: ${name}`);
          return {
            put(value, key) {
              ensureActive();
              store.rows.set(store.key(value, key), structuredClone(value));
              return makeRequest(() => key);
            },
            clear() {
              ensureActive();
              store.rows.clear();
              return makeRequest(() => undefined);
            },
            delete(key) {
              ensureActive();
              store.rows.delete(key);
              return makeRequest(() => undefined);
            },
            get(key) {
              ensureActive();
              return makeRequest(() => structuredClone(store.rows.get(key)));
            },
            getAll() {
              ensureActive();
              return makeRequest(() => [...store.rows.values()].map((value) => structuredClone(value)));
            }
          };
        }
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    }
    close() {}
  }

  return {
    databases: async () => [...databases.values()].map((db) => ({ name: db.name, version: db.version })),
    open(name, version) {
      openedNames.push(name);
      const req = {};
      queueMicrotask(() => {
        try {
          let db = databases.get(name);
          const requested = version ?? db?.version ?? 1;
          const upgrade = !db || requested > db.version;
          if (!db) {
            db = new Database(name, requested);
            databases.set(name, db);
          } else if (upgrade) {
            db.version = requested;
          }
          req.result = db;
          if (upgrade) req.onupgradeneeded?.();
          req.onsuccess?.();
        } catch (error) {
          req.error = error;
          req.onerror?.();
        }
      });
      return req;
    },
    _db: (name) => databases.get(name),
    _openedNames: openedNames,
    failNextTransaction(count = 1) { failTransactionCount += Math.max(1, Number(count) || 1); }
  };
}

async function openDb(idb, name, version, upgrade) {
  await new Promise((resolve, reject) => {
    const req = idb.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}

async function seedShadow(idb) {
  await openDb(idb, SHADOW_DB, 1, (db) => {
    [...ARRAY_STORES, 'collections'].forEach((name) => db.createObjectStore(name, { keyPath: 'key' }));
    db.createObjectStore('values', { keyPath: 'field' });
    db.createObjectStore('metadata', { keyPath: 'id' });
  });
  const db = idb._db(SHADOW_DB);
  const tx = db.transaction('metadata', 'readwrite');
  tx.objectStore('metadata').put({ id: 'current', status: 'passed_verification', schemaVersion: 1 });
  tx.objectStore('metadata').put({ id: 'dual_write', status: 'passed_verification', schemaVersion: 1 });
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  return db;
}

async function getAll(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  return await new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getRow(db, storeName, key) {
  const tx = db.transaction(storeName, 'readonly');
  return await new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function install({ mode, journal = [], diagnostics = null, indexedDB = createFakeIndexedDb() } = {}) {
  const source = readPlannedModule();
  const localStorage = new FakeStorage({
    ...(mode == null ? {} : { [MODE_KEY]: mode }),
    ...(journal.length ? { [JOURNAL_KEY]: JSON.stringify(journal) } : {}),
    ...(diagnostics ? { [DIAGNOSTICS_KEY]: JSON.stringify(diagnostics) } : {})
  });
  await seedShadow(indexedDB);
  let phase3ClearCalls = 0;
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    SHADOW_MIGRATION_DB_NAME: SHADOW_DB,
    SHADOW_MIGRATION_DB_VERSION: 1,
    SHADOW_MIGRATION_SCHEMA_VERSION: 1,
    SHADOW_DUAL_WRITE_METADATA_ID: 'dual_write',
    IMAGE_DB_NAME: 'taskpoints',
    shadowCanonicalJson: canonical,
    shadowSourceLayout: sourceLayout,
    shadowSourceSummary: sourceSummary,
    shadowVerificationMismatches(sourceSummaryValue, destinationSummaryValue) {
      return sourceSummaryValue.hashes.state === destinationSummaryValue.hashes.state ? [] : [{ type: 'overall_state' }];
    },
    parseTaskPointsStorageJson(raw, fallback = {}) { return raw ? JSON.parse(raw) : fallback; },
    readPendingHabitDeltas() {
      const raw = localStorage.getItem(JOURNAL_KEY);
      return raw ? JSON.parse(raw) : [];
    },
    flushShadowDualWrites: async () => undefined,
    getPendingShadowDualWriteCount: () => 0,
    clearPhase3ReadCache() { phase3ClearCalls += 1; return true; }
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
  vm.runInNewContext(source, context, { filename: 'phase4_storage_coordinator.js' });

  assert.equal(core.PHASE4_STORAGE_MODE_KEY, MODE_KEY);
  assert.deepEqual([...core.PHASE4_STORAGE_MODES], ['off', 'verify_primary_writes', 'indexeddb_primary']);
  for (const method of [
    'getPhase4StorageMode', 'setPhase4StorageMode', 'queuePhase4PrimaryWrite',
    'flushPhase4PrimaryWrites', 'getPendingPhase4WriteCount',
    'getPhase4StorageStatus', 'clearPhase4Caches', 'restorePhase4CommittedPrimary'
  ]) {
    assert.equal(typeof core[method], 'function', `${method} must be installed`);
  }

  return { core, localStorage, indexedDB, db: indexedDB._db(SHADOW_DB), phase3ClearCalls: () => phase3ClearCalls };
}

test('Phase 4 defaults to Off and invalid values resolve to Off', async () => {
  const first = await install();
  assert.equal(first.core.getPhase4StorageMode(), 'off');

  const invalid = await install({ mode: 'not-a-mode' });
  assert.equal(invalid.core.getPhase4StorageMode(), 'off');
});

test('Off mode preserves current behavior and does not queue a Phase 4 write', async () => {
  const harness = await install({ mode: 'off' });
  const raw = JSON.stringify(fixture(1));
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase4PrimaryWrites();
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), raw);
  assert.equal(harness.core.getPendingPhase4WriteCount(), 0);
  assert.equal(await getRow(harness.db, 'metadata', 'phase4_primary_commit'), null);
});

test('a successful mirror write is promoted only after verified IndexedDB read-back', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  const state = fixture(2);
  const raw = JSON.stringify(state);
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase4PrimaryWrites();

  const status = await harness.core.getPhase4StorageStatus({ indexedDB: harness.indexedDB });
  const commit = await getRow(harness.db, 'metadata', 'phase4_primary_commit');
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), raw);
  assert.equal(status.latestPassedSequence > 0, true, JSON.stringify(status));
  assert.equal(status.pendingWrites, 0);
  assert.equal(commit.status, 'passed_verification');
  assert.equal(commit.sequence, status.latestPassedSequence);
  assert.equal(commit.verification.countsMatch, true);
  assert.equal(commit.verification.hashesMatch, true);
  assert.deepEqual(commit.verification.mismatches, []);
});

test('a failed localStorage mirror write cannot create or promote a candidate', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  harness.localStorage.failKey = STORAGE_KEY;
  assert.throws(() => harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture(3))), /QuotaExceededError/);
  await harness.core.flushPhase4PrimaryWrites();
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), null);
  assert.equal(harness.core.getPendingPhase4WriteCount(), 0);
  assert.equal(await getRow(harness.db, 'metadata', 'phase4_candidate'), null);
  assert.equal(await getRow(harness.db, 'metadata', 'phase4_primary_commit'), null);
});

test('a cold page restores and re-verifies the committed primary without rewriting it', async () => {
  const harness = await install({ mode: 'indexeddb_primary' });
  const state = fixture(16);
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  await harness.core.flushPhase4PrimaryWrites();
  const commitBefore = await getRow(harness.db, 'metadata', 'phase4_primary_commit');
  harness.core.clearPhase4Caches();
  assert.equal(harness.core.getPhase4StorageStatus().cacheReadyThisPage, false);

  const restored = await harness.core.restorePhase4CommittedPrimary({ indexedDB: harness.indexedDB });
  const commitAfter = await getRow(harness.db, 'metadata', 'phase4_primary_commit');
  const status = harness.core.getPhase4StorageStatus();
  assert.equal(restored.restored, true, JSON.stringify(restored));
  assert.equal(status.cacheReadyThisPage, true);
  assert.equal(status.currentMirrorMatchesCache, true);
  assert.equal(status.latestQueuedSequence, status.latestPassedSequence);
  assert.deepEqual(commitAfter, commitBefore);
});

test('rapid saves commit only the newest valid sequence as primary', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  [fixture(4), fixture(5), fixture(6)].forEach((state) => {
    harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });
  await harness.core.flushPhase4PrimaryWrites();

  const taskRows = await getAll(harness.db, 'tasks');
  const status = await harness.core.getPhase4StorageStatus({ indexedDB: harness.indexedDB });
  assert.deepEqual(taskRows.map((row) => row.value.id), ['task-6']);
  assert.equal(JSON.parse(harness.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'task-6');
  assert.equal(status.latestQueuedSequence, status.latestPassedSequence);
});

test('queued work re-reads the live mirror and never restores a removed pre-reset payload', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  const stale = fixture(7);
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
  harness.localStorage.removeItem(STORAGE_KEY);
  await harness.core.flushPhase4PrimaryWrites();

  const taskRows = await getAll(harness.db, 'tasks');
  const status = await harness.core.getPhase4StorageStatus({ indexedDB: harness.indexedDB });
  assert.equal(taskRows.some((row) => row.value.id === 'task-7'), false);
  assert.equal(status.lastFallbackReason === 'authoritative_missing' || status.resetTombstone === true, true, JSON.stringify(status));
});

test('IndexedDB failure preserves the newer localStorage mirror and records fallback', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  harness.indexedDB.failNextTransaction(5);
  const state = fixture(8);
  const raw = JSON.stringify(state);
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase4PrimaryWrites();

  const status = await harness.core.getPhase4StorageStatus({ indexedDB: harness.indexedDB });
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), raw);
  assert.notEqual(status.lastFallbackReason, null);
  assert.equal(status.effectiveSource, 'localStorage');
});

test('a pending habit journal blocks primary promotion but leaves the mirror intact', async () => {
  const harness = await install({
    mode: 'verify_primary_writes',
    journal: [{ id: 'habit:h1:2026-07-24', habitId: 'h1', dayKey: '2026-07-24', source: 'habit' }]
  });
  const raw = JSON.stringify(fixture(9));
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase4PrimaryWrites();

  const status = await harness.core.getPhase4StorageStatus({ indexedDB: harness.indexedDB });
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), raw);
  assert.notEqual(status.latestQueuedSequence, status.latestPassedSequence);
  assert.equal(status.lastFallbackReason, 'pending_habit_journal');
});

test('unknown collections, empty collections, duplicates, ordering, and image IDs survive', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  const state = fixture(10);
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  await harness.core.flushPhase4PrimaryWrites();

  const collections = await getAll(harness.db, 'collections');
  const values = await getAll(harness.db, 'values');
  const players = await getAll(harness.db, 'players');
  assert.equal(collections.some((row) => row.kind === 'manifest' && row.field === 'schedule'), true);
  assert.deepEqual(
    collections.filter((row) => row.kind === 'item' && row.field === 'futureRows').map((row) => row.value.id),
    ['duplicate', 'duplicate', undefined]
  );
  assert.equal(values.some((row) => row.field === 'youImageId' && row.value === 'profile-image'), true);
  assert.equal(players[0].value.imageId, 'player-image');
});

test('Phase 4 state writes never open or mutate the live image database', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture(11)));
  await harness.core.flushPhase4PrimaryWrites();
  assert.equal(harness.indexedDB._openedNames.includes('taskpoints'), false);
  assert.equal(harness.indexedDB._db('taskpoints'), undefined);
});

test('switching Off is immediate, clears caches, and deletes no stored state', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  const raw = JSON.stringify(fixture(12));
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase4PrimaryWrites();
  const beforeCommit = await getRow(harness.db, 'metadata', 'phase4_primary_commit');

  assert.equal(harness.core.setPhase4StorageMode('off'), 'off');
  assert.equal(harness.core.getPhase4StorageMode(), 'off');
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(await getRow(harness.db, 'metadata', 'phase4_primary_commit'), beforeCommit);
  assert.equal(harness.phase3ClearCalls() > 0, true);
});

test('indexeddb_primary mode retains a complete localStorage rollback mirror', async () => {
  const harness = await install({ mode: 'indexeddb_primary' });
  const state = fixture(13);
  const raw = JSON.stringify(state);
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase4PrimaryWrites();
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), raw);
  assert.deepEqual(JSON.parse(harness.localStorage.getItem(STORAGE_KEY)), state);
});


test('write sequences continue above persisted diagnostics after a page reload', async () => {
  const harness = await install({
    mode: 'verify_primary_writes',
    diagnostics: { latestQueuedSequence: 7, latestPassedSequence: 7 }
  });
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture(14)));
  await harness.core.flushPhase4PrimaryWrites();
  const status = harness.core.getPhase4StorageStatus();
  assert.equal(status.latestQueuedSequence > 7, true, JSON.stringify(status));
  assert.equal(status.latestPassedSequence, status.latestQueuedSequence);
});

test('clearing a pending habit journal automatically retries without adding a verification failure', async () => {
  const harness = await install({
    mode: 'verify_primary_writes',
    journal: [{ id: 'habit:h1:2026-07-24', habitId: 'h1', dayKey: '2026-07-24', source: 'habit' }]
  });
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture(15)));
  await harness.core.flushPhase4PrimaryWrites();
  const deferred = harness.core.getPhase4StorageStatus();
  assert.equal(deferred.lastFallbackReason, 'pending_habit_journal');
  const failuresBefore = deferred.verificationFailuresTotal;

  harness.localStorage.setItem(JOURNAL_KEY, '[]');
  await harness.core.flushPhase4PrimaryWrites();
  const recovered = harness.core.getPhase4StorageStatus();
  assert.equal(recovered.latestQueuedSequence, recovered.latestPassedSequence, JSON.stringify(recovered));
  assert.equal(recovered.lastFallbackReason, null);
  assert.equal(recovered.verificationFailuresTotal, failuresBefore);
  assert.equal(recovered.deferredWritesTotal > 0, true);
});


test('a transient IndexedDB transaction failure retries and settles without a verification failure', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  harness.indexedDB.failNextTransaction();
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture(17)));
  await harness.core.flushPhase4PrimaryWrites();

  const status = harness.core.getPhase4StorageStatus();
  assert.equal(status.latestQueuedSequence, status.latestPassedSequence, JSON.stringify(status));
  assert.equal(status.pendingWrites, 0);
  assert.equal(status.lastFallbackReason, null);
  assert.equal(status.verificationFailuresTotal, 0);
  assert.equal(status.deferredWritesTotal > 0, true);
});

test('a burst of mirror writes is coalesced into a small number of verified transactions', async () => {
  const harness = await install({ mode: 'verify_primary_writes' });
  for (let version = 20; version < 40; version += 1) {
    harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture(version)));
  }
  await harness.core.flushPhase4PrimaryWrites();

  const status = harness.core.getPhase4StorageStatus();
  assert.equal(status.latestQueuedSequence, status.latestPassedSequence, JSON.stringify(status));
  assert.equal(status.latestQueuedSequence <= 3, true, JSON.stringify(status));
  assert.equal(status.pendingWrites, 0);
  assert.equal(JSON.parse(harness.localStorage.getItem(STORAGE_KEY)).tasks[0].id, 'task-39');
});
