const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const standaloneGuard = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_guard.js'), 'utf8');
const bundledGuard = fs.readFileSync(path.join(ROOT, 'phase4_cache_guard.js'), 'utf8');

class FakeStorage {
  constructor(rows = {}) {
    this.rows = new Map(Object.entries(rows).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function hash(raw) {
  const text = String(raw || '');
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function install(source, rows) {
  const localStorage = new FakeStorage(rows);
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    PHASE4_STORAGE_MODE_KEY: 'taskpoints_phase4_storage_mode_v1',
    PENDING_HABIT_DELTAS_KEY: 'taskpoints_pending_habit_deltas_v1',
    getPhase4StorageMode() { return localStorage.getItem(this.PHASE4_STORAGE_MODE_KEY) || 'off'; },
    setPhase4StorageMode(mode) {
      localStorage.setItem(this.PHASE4_STORAGE_MODE_KEY, String(mode || 'off'));
      return String(mode || 'off');
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
    Promise,
    console,
    setTimeout: () => 1,
    clearTimeout: () => undefined
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { core, localStorage };
}

for (const [label, source] of [
  ['standalone guard', standaloneGuard],
  ['always-loaded bundled guard', bundledGuard]
]) {
  test(`${label} requires a fresh test after Faster Mode was switched Off`, () => {
    const raw = '{"tasks":[1]}';
    const harness = install(source, {
      taskpoints_v1: raw,
      taskpoints_phase4_storage_mode_v1: 'off',
      taskpoints_indexeddb_requalification_v1: JSON.stringify({ status: 'fast_mode_enabled' })
    });

    assert.equal(harness.core.setPhase4StorageMode('indexeddb_primary'), 'off');
    assert.equal(harness.localStorage.getItem('taskpoints_phase4_storage_mode_v1'), 'off');
  });

  test(`${label} lets an explicit Off win the final activation race`, () => {
    const raw = '{"tasks":[1]}';
    const ready = JSON.stringify({ status: 'ready_for_fast_mode', lastVerifiedRawHash: hash(raw) });

    const interrupted = install(source, {
      taskpoints_v1: raw,
      taskpoints_phase4_storage_mode_v1: 'off',
      taskpoints_indexeddb_requalification_v1: ready
    });
    assert.equal(interrupted.core.setPhase4StorageMode('indexeddb_primary'), 'off');

    const uninterrupted = install(source, {
      taskpoints_v1: raw,
      taskpoints_phase4_storage_mode_v1: 'verify_primary_writes',
      taskpoints_indexeddb_requalification_v1: ready
    });
    assert.equal(uninterrupted.core.setPhase4StorageMode('indexeddb_primary'), 'indexeddb_primary');
  });
}
