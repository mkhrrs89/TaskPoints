const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const localRows = new Map();
global.localStorage = {
  getItem: (key) => localRows.has(String(key)) ? localRows.get(String(key)) : null,
  setItem: (key, value) => { localRows.set(String(key), String(value)); },
  removeItem: (key) => { localRows.delete(String(key)); }
};

require('../scoring_core.js');
require('../phase2_dual_write.js');
const core = global.TaskPointsCore;

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
    futureRows: [{ id: 'duplicate' }, { id: 'duplicate' }, { version }],
    settings: { sound: true },
    youImageId: 'profile-image'
  };
}

function createFakeIndexedDb({ strictTransactions = false } = {}) {
  const databases = new Map();
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
    key(value, key) {
      return key ?? value[this.def.keyPath];
    }
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
            get(key) {
              ensureActive();
              return makeRequest(() => structuredClone(store.rows.get(key)));
            },
            getAll() {
              ensureActive();
              return makeRequest(() => [...store.rows.values()].map((value) => structuredClone(value)));
            },
            getAllKeys() {
              ensureActive();
              return makeRequest(() => [...store.rows.keys()]);
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
      const req = {};
      queueMicrotask(() => {
        try {
          let db = databases.get(name);
          const requested = version ?? db?.version ?? 1;
          if (db && requested < db.version) throw new Error('VersionError');
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
    _db: (name) => databases.get(name)
  };
}

async function openFakeDb(idb, name, version, upgrade) {
  await new Promise((resolve, reject) => {
    const req = idb.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}

async function rows(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  return await new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function seedVerifiedShadow(idb) {
  await openFakeDb(idb, core.SHADOW_MIGRATION_DB_NAME, core.SHADOW_MIGRATION_DB_VERSION, (db) => {
    [...['completions', 'matchups', 'gameHistory', 'seasonHistory', 'tasks', 'habits', 'players'], 'collections']
      .forEach((name) => db.createObjectStore(name, { keyPath: 'key' }));
    db.createObjectStore('values', { keyPath: 'field' });
    db.createObjectStore('metadata', { keyPath: 'id' });
  });
  const db = idb._db(core.SHADOW_MIGRATION_DB_NAME);
  const tx = db.transaction('metadata', 'readwrite');
  tx.objectStore('metadata').put({
    id: 'current',
    schemaVersion: core.SHADOW_MIGRATION_SCHEMA_VERSION,
    status: 'passed_verification'
  });
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  return db;
}

test('dual-write refuses to write before Phase 1 verification', async () => {
  const idb = createFakeIndexedDb({ strictTransactions: true });
  const result = await core.writeShadowDualWriteSnapshot(fixture(), { indexedDB: idb });
  assert.equal(result.status, 'skipped_not_verified');
  const db = idb._db(core.SHADOW_MIGRATION_DB_NAME);
  assert.equal((await rows(db, 'tasks')).length, 0);
  assert.equal((await rows(db, 'collections')).length, 0);
});

test('rapid localStorage saves end with exact latest state in IndexedDB', async () => {
  localRows.clear();
  const idb = createFakeIndexedDb({ strictTransactions: true });
  global.indexedDB = idb;
  const db = await seedVerifiedShadow(idb);
  const states = [fixture(1), fixture(2), fixture(3)];

  states.forEach((state) => {
    global.localStorage.setItem(core.STORAGE_KEY, JSON.stringify(state));
  });
  await core.flushShadowDualWrites();

  assert.equal(global.localStorage.getItem(core.STORAGE_KEY), JSON.stringify(states[2]));
  assert.equal(core.getPendingShadowDualWriteCount(), 0);
  const status = await core.getShadowDualWriteStatus({ indexedDB: idb });
  const expected = core.shadowSourceSummary(states[2]);
  assert.equal(status.status, 'passed_verification', JSON.stringify(status));
  assert.equal(status.verification.countsMatch, true);
  assert.equal(status.verification.hashesMatch, true);
  assert.equal(status.verification.source.hashes.state, expected.hashes.state);
  assert.equal(status.verification.destination.hashes.state, expected.hashes.state);
  assert.deepEqual((await rows(db, 'tasks')).map((row) => row.value.id), ['task-3']);

  const collectionRows = await rows(db, 'collections');
  ['schedule', 'opponentDripSchedules', 'storageWarnings', 'workHistory'].forEach((field) => {
    assert.equal(collectionRows.some((row) => row.kind === 'manifest' && row.field === field), true, field);
  });
  assert.equal(collectionRows.filter((row) => row.kind === 'item' && row.field === 'futureRows').length, 3);
  assert.equal(idb._db(core.IMAGE_DB_NAME), undefined, 'dual writes must not create or alter the image database');
});

test('IndexedDB failure never blocks the authoritative localStorage save', async () => {
  localRows.clear();
  const previousIndexedDb = global.indexedDB;
  global.indexedDB = null;
  try {
    const state = fixture(9);
    const raw = JSON.stringify(state);
    assert.doesNotThrow(() => global.localStorage.setItem(core.STORAGE_KEY, raw));
    assert.equal(global.localStorage.getItem(core.STORAGE_KEY), raw);
    await core.flushShadowDualWrites();
    assert.equal(global.localStorage.getItem(core.STORAGE_KEY), raw);
  } finally {
    global.indexedDB = previousIndexedDb;
  }
});
