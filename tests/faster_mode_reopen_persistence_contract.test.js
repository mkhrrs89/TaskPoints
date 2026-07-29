const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const guardSource = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_guard.js'), 'utf8');
const compatSource = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_session_compat.js'), 'utf8');

const STORAGE_KEY = 'taskpoints_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';

class FakeStorage {
  constructor(rows = {}) { this.rows = new Map(Object.entries(rows)); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function rawHash(raw) {
  const text = String(raw || '');
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function installGuard(rows) {
  const localStorage = new FakeStorage(rows);
  const core = {
    STORAGE_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    getPhase4StorageMode() { return localStorage.getItem(MODE_KEY) || 'off'; },
    setPhase4StorageMode(mode) {
      localStorage.setItem(MODE_KEY, String(mode || 'off'));
      return localStorage.getItem(MODE_KEY);
    }
  };
  const context = { TaskPointsCore: core, localStorage, JSON, String, Number, Boolean, Object, Array, Set, Date, Math, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(guardSource, context, { filename: 'indexeddb_requalification_guard.js' });
  return { core, localStorage };
}

test('temporary habit saves do not erase an active short-test mode', () => {
  const stateRaw = JSON.stringify({ tasks: [{ id: 'task' }] });
  const harness = installGuard({
    [STORAGE_KEY]: stateRaw,
    [MODE_KEY]: 'verify_primary_writes',
    [GATE_KEY]: JSON.stringify({ status: 'awaiting_smoke_test' }),
    [JOURNAL_KEY]: JSON.stringify([{ id: 'pending-save' }])
  });

  assert.equal(harness.core.getPhase4StorageMode(), 'verify_primary_writes');
  assert.equal(harness.core.getIndexedDbRequalificationPermission('verify_primary_writes').allowed, true);
});

test('a proven fresh reopen remains valid after later ordinary saves', () => {
  const originalRaw = JSON.stringify({ tasks: [{ id: 'before' }] });
  const currentRaw = JSON.stringify({ tasks: [{ id: 'before' }, { id: 'after' }] });
  const gate = {
    status: 'awaiting_smoke_test',
    preparedBrowserSessionId: 'prepared-session',
    freshAppSessionId: 'fresh-session',
    freshAppRawHash: rawHash(originalRaw),
    exclusivePageLockConfirmed: true
  };
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: currentRaw,
    [MODE_KEY]: 'verify_primary_writes',
    [GATE_KEY]: JSON.stringify(gate)
  });
  const core = {
    STORAGE_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    getIndexedDbBrowserSessionStatus() {
      return { sessionId: 'setup-session', lockSupported: true, sessionStorageAvailable: true };
    }
  };
  const context = { TaskPointsCore: core, localStorage, JSON, String, Boolean, Object, Array, Date, Math, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(compatSource, context, { filename: 'indexeddb_requalification_session_compat.js' });

  const refreshed = JSON.parse(localStorage.getItem(GATE_KEY));
  assert.equal(refreshed.freshAppWitnessRawHash, rawHash(originalRaw));
  assert.equal(refreshed.freshAppRawHash, rawHash(currentRaw));
  assert.ok(refreshed.reopenProofRefreshedAtISO);
  assert.equal(core.getIndexedDbBrowserSessionStatus().broadcastSupported, true);
});

test('session compatibility does not invent a reopen proof', () => {
  const currentRaw = JSON.stringify({ tasks: [{ id: 'task' }] });
  const originalGate = { status: 'awaiting_smoke_test', preparedBrowserSessionId: 'same', freshAppSessionId: 'same' };
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: currentRaw,
    [MODE_KEY]: 'verify_primary_writes',
    [GATE_KEY]: JSON.stringify(originalGate)
  });
  const core = {
    STORAGE_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    getIndexedDbBrowserSessionStatus() { return { lockSupported: true }; }
  };
  const context = { TaskPointsCore: core, localStorage, JSON, String, Boolean, Object, Array, Date, Math, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(compatSource, context, { filename: 'indexeddb_requalification_session_compat.js' });

  assert.deepEqual(JSON.parse(localStorage.getItem(GATE_KEY)), originalGate);
});
