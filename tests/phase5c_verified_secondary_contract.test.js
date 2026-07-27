const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'phase5b_deferred_mirror.js'), 'utf8');
const HEALTH_SOURCE = fs.readFileSync(path.join(ROOT, 'storage_health_phase5c.js'), 'utf8');
const HEALTH_HTML = fs.readFileSync(path.join(ROOT, 'storage_health.html'), 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const DB_NAME = 'taskpoints_verified_secondary_v1';

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
    this.failMain = false;
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) {
    if (this.failMain && String(key) === STORAGE_KEY) throw new Error('authoritative write rejected');
    this.rows.set(String(key), String(value));
  }
  removeItem(key) { this.rows.delete(String(key)); }
}

function createFakeIndexedDb() {
  const databases = new Map();
  let openCalls = 0;
  const request = (work) => {
    const req = {};
    queueMicrotask(() => {
      try { req.result = work(); req.onsuccess?.(); }
      catch (error) { req.error = error; req.onerror?.(); }
    });
    return req;
  };
  class Database {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (name) => this.stores.has(name) };
    }
    createObjectStore(name) {
      const rows = new Map();
      this.stores.set(name, rows);
      return rows;
    }
    transaction(name) {
      const rows = this.stores.get(name);
      if (!rows) throw new Error(`missing store: ${name}`);
      const tx = {
        error: null,
        objectStore() {
          return {
            put(value) { return request(() => { rows.set(value.id, structuredClone(value)); return value.id; }); },
            get(key) { return request(() => structuredClone(rows.get(key))); },
            delete(key) { return request(() => rows.delete(key)); }
          };
        }
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    }
    close() {}
  }
  return {
    open(name) {
      openCalls += 1;
      const req = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) { db = new Database(); databases.set(name, db); }
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    read(name, id) { return structuredClone(databases.get(name)?.stores.get('snapshots')?.get(id)); },
    openCalls: () => openCalls
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function summary(state) {
  const keys = ['tasks','completions','habits','players','flexActions','gameHistory','matchups','schedule','seasonHistory','reminders','weightHistory','vo2MaxHistory'];
  const counts = Object.fromEntries(keys.map((key) => [key, Array.isArray(state?.[key]) ? state[key].length : 0]));
  counts.total = keys.reduce((sum, key) => sum + counts[key], 0);
  counts.majorTotal = ['tasks','completions','habits','players','gameHistory','matchups','seasonHistory'].reduce((sum, key) => sum + counts[key], 0);
  return { counts, hashes: { state: canonical(state || {}) } };
}

function makeState(label) {
  return {
    tasks: [{ id: `task-${label}` }], completions: [{ id: `completion-${label}` }],
    habits: [], players: [], flexActions: [], gameHistory: [], matchups: [],
    schedule: [], seasonHistory: [], reminders: [], weightHistory: [], vo2MaxHistory: []
  };
}

function install() {
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: JSON.stringify(makeState('initial')),
    [JOURNAL_KEY]: '[]',
    taskpoints_phase4_storage_mode_v1: 'off'
  });
  const indexedDB = createFakeIndexedDb();
  let loadCalls = 0;
  const core = {
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    __storageDataLossGuardInstalled: true,
    __phase5aNativeSnapshotInstalled: true,
    parseTaskPointsStorageJson(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    shadowCanonicalJson: canonical,
    shadowSourceSummary: summary,
    loadAppState() { loadCalls += 1; return {}; }
  };
  const context = {
    TaskPointsCore: core, localStorage, indexedDB, Storage: FakeStorage,
    structuredClone, queueMicrotask, setTimeout, clearTimeout,
    JSON, Date, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'phase5b_deferred_mirror.js' });
  return { core, localStorage, indexedDB, loadCalls: () => loadCalls };
}

test('does not consult IndexedDB during installation or replace the app read path', () => {
  const harness = install();
  assert.equal(harness.indexedDB.openCalls(), 0);
  harness.core.loadAppState();
  assert.equal(harness.loadCalls(), 1);
  assert.equal(harness.localStorage.getItem('taskpoints_phase4_storage_mode_v1'), 'off');
  assert.equal(harness.core.getPhase5CVerifiedSecondaryStatus().indexedDbReadsEnabled, false);
  assert.equal(harness.core.getPhase5CVerifiedSecondaryStatus().indexedDbWriteBackEnabled, false);
});

test('promotes an exact hash- and count-verified copy only after a successful localStorage save', async () => {
  const harness = install();
  const raw = JSON.stringify(makeState('saved'));
  harness.localStorage.setItem(STORAGE_KEY, raw);
  await harness.core.flushPhase5CVerifiedSecondaryWrites();
  const latest = harness.indexedDB.read(DB_NAME, 'latest');
  assert.equal(latest.status, 'passed_verification');
  assert.equal(latest.raw, raw);
  assert.equal(latest.counts.tasks, 1);
  assert.equal(harness.indexedDB.read(DB_NAME, 'candidate'), undefined);
  const status = harness.core.getPhase5CVerifiedSecondaryStatus();
  assert.equal(status.lastStatus, 'passed_verification');
  assert.equal(status.mirrorsCurrentSave, true);
  assert.equal(status.lastVerifiedCounts.majorTotal, 2);
});

test('a rejected authoritative write cannot queue or replace the verified secondary copy', async () => {
  const harness = install();
  harness.localStorage.failMain = true;
  assert.throws(
    () => harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(makeState('blocked'))),
    /authoritative write rejected/
  );
  await harness.core.flushPhase5CVerifiedSecondaryWrites();
  assert.equal(harness.indexedDB.read(DB_NAME, 'latest'), undefined);
});

test('pending habit journal changes pause secondary mirroring', async () => {
  const harness = install();
  harness.localStorage.setItem(JOURNAL_KEY, JSON.stringify([{ id: 'pending' }]));
  harness.localStorage.setItem(STORAGE_KEY, JSON.stringify(makeState('journal')));
  await harness.core.flushPhase5CVerifiedSecondaryWrites();
  assert.equal(harness.indexedDB.read(DB_NAME, 'latest'), undefined);
  assert.equal(harness.core.getPhase5CVerifiedSecondaryStatus().lastStatus, 'waiting_for_habit_journal');
});

test('Storage Health adds a read-only verified-secondary check', () => {
  assert.doesNotThrow(() => new vm.Script(HEALTH_SOURCE));
  assert.match(HEALTH_HTML, /storage_health_phase5c\.js/);
  assert.match(HEALTH_SOURCE, /phase5cLastVerifiedRawHash/);
  assert.match(HEALTH_SOURCE, /phase5cLastVerifiedCounts/);
  assert.match(HEALTH_SOURCE, /Verified secondary mirror matches the current save/);
  assert.doesNotMatch(HEALTH_SOURCE, /localStorage\.(?:setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(HEALTH_SOURCE, /indexedDB\.(?:open|deleteDatabase)\s*\(/);
});
