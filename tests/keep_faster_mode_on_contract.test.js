const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const guardSource = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_guard.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(ROOT, '_worker.js'), 'utf8');

const STORAGE_KEY = 'taskpoints_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';

class FakeStorage {
  constructor(rows = {}) {
    this.rows = new Map(Object.entries(rows).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function install(rows = {}) {
  const localStorage = new FakeStorage(rows);
  const core = {
    STORAGE_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    getPhase4StorageMode() { return localStorage.getItem(MODE_KEY) || 'off'; },
    setPhase4StorageMode(mode) {
      const next = String(mode || 'off');
      localStorage.setItem(MODE_KEY, next);
      return next;
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Set,
    Date,
    Math,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(guardSource, context, { filename: 'indexeddb_requalification_guard.js' });
  return { core, localStorage };
}

test('completed Faster Mode stays configured while a temporary habit journal is pending', () => {
  const harness = install({
    [STORAGE_KEY]: JSON.stringify({ tasks: [{ id: 'task' }] }),
    [MODE_KEY]: 'indexeddb_primary',
    [GATE_KEY]: JSON.stringify({ status: 'fast_mode_enabled' }),
    [JOURNAL_KEY]: JSON.stringify([{ id: 'pending-habit-save' }])
  });

  assert.equal(harness.core.getPhase4StorageMode(), 'indexeddb_primary');
  assert.equal(harness.core.getIndexedDbRequalificationPermission('indexeddb_primary').allowed, true);
  assert.equal(harness.core.getIndexedDbRequalificationStatus().pendingHabitChanges, 1);
  assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'indexeddb_primary');
  assert.equal(harness.core.getPhase4StorageMode(), 'indexeddb_primary');
});

test('a real recovery hold still forces Faster Mode off', () => {
  const harness = install({
    [STORAGE_KEY]: JSON.stringify({ tasks: [{ id: 'task' }] }),
    [MODE_KEY]: 'indexeddb_primary',
    [GATE_KEY]: JSON.stringify({ status: 'fast_mode_enabled' }),
    [HOLD_KEY]: JSON.stringify({ reason: 'recovery-needed' })
  });

  assert.equal(harness.core.getPhase4StorageMode(), 'off');
  assert.equal(harness.core.getIndexedDbRequalificationPermission('indexeddb_primary').allowed, false);
  assert.equal(harness.core.getIndexedDbRequalificationPermission('indexeddb_primary').reason, 'recovery_hold_active');
});

test('the normal scoring-core bundle installs the updated guard before the embedded cache guard', () => {
  const guardPathIndex = workerSource.indexOf("'/indexeddb_requalification_guard.js'");
  const cachePathIndex = workerSource.indexOf("'/phase4_cache_guard.js'");
  assert.ok(guardPathIndex >= 0, 'updated guard module must be fetched');
  assert.ok(cachePathIndex > guardPathIndex, 'updated guard must be fetched before the cache guard');

  const guardSourceIndex = workerSource.indexOf('phase4RequalificationGuardSource,', workerSource.indexOf("'  try {'"));
  const cacheSourceIndex = workerSource.indexOf('phase4CacheSource,', guardSourceIndex + 1);
  assert.ok(guardSourceIndex >= 0, 'updated guard source must be included in the Phase 4 bundle');
  assert.ok(cacheSourceIndex > guardSourceIndex, 'updated guard source must execute before the embedded guard');
  assert.match(workerSource, /completePhase4 = Boolean\([^\n]*phase4RequalificationGuardSource/);
});
