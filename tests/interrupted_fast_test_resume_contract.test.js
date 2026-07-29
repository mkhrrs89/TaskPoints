const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_session_compat.js'), 'utf8');

const STORAGE_KEY = 'taskpoints_v1';
const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
const HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
const ATTEMPT_LOCK_KEY = 'taskpoints_recovery_attempt_lock_v1';
const JOURNAL_KEY = 'taskpoints_pending_habit_deltas_v1';
const LEGACY_JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';

class FakeStorage {
  constructor(rows = {}) {
    this.rows = new Map(Object.entries(rows).map(([key, value]) => [String(key), String(value)]));
  }
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

function install(options = {}) {
  const baselineRaw = JSON.stringify({ tasks: [{ id: 'before' }] });
  const currentRaw = JSON.stringify({ tasks: [{ id: 'before' }, { id: 'after' }] });
  const originalGate = {
    schemaVersion: 1,
    status: 'awaiting_smoke_test',
    authorizedAtISO: '2026-07-29T01:39:55.742Z',
    authorizedRawHash: rawHash(baselineRaw),
    baselineRawHash: rawHash(baselineRaw),
    baselineCounts: { tasks: 1 },
    baselineVerificationFailures: 0,
    baselineBlockedWrites: 0,
    preparedBrowserSessionId: 'prepared-session',
    preparedPageId: 'prepared-page',
    freshAppSessionId: 'fresh-session',
    freshAppStartedAtISO: '2026-07-29T03:32:13.838Z',
    freshAppRawHash: rawHash(baselineRaw),
    freshAppPage: 'index.html',
    exclusivePageLockConfirmed: options.exclusiveProof !== false,
    testPreparedAtISO: '2026-07-29T01:40:30.791Z',
    preparedSequence: 95,
    hadRecoveryHold: false
  };
  const localStorage = new FakeStorage({
    [STORAGE_KEY]: currentRaw,
    [MODE_KEY]: 'off',
    [GATE_KEY]: JSON.stringify(originalGate),
    ...(options.hold ? { [HOLD_KEY]: 'active' } : {}),
    ...(options.attempt ? { [ATTEMPT_LOCK_KEY]: 'active' } : {}),
    ...(options.journal ? { [JOURNAL_KEY]: JSON.stringify([{ id: 'pending' }]) } : {}),
    ...(options.legacy ? { [LEGACY_JOURNAL_KEY]: JSON.stringify({ id: 'legacy' }) } : {})
  });
  const core = {
    STORAGE_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    getIndexedDbBrowserSessionStatus() {
      return { sessionId: 'setup-session', lockSupported: true, sessionStorageAvailable: true };
    },
    setPhase4StorageMode(mode) {
      localStorage.setItem(MODE_KEY, String(mode || 'off'));
      return localStorage.getItem(MODE_KEY);
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    Storage: FakeStorage,
    __TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__: options.vaultVerified === false ? '' : 'vault-hash',
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
    queueMicrotask,
    setTimeout
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'indexeddb_requalification_session_compat.js' });
  return { context, core, localStorage, originalGate, currentRaw };
}

test('a proven interrupted test is resumed and its witness survives the normal Start flow', async () => {
  const harness = install();

  assert.equal(harness.localStorage.getItem(MODE_KEY), 'verify_primary_writes');
  const prepared = JSON.parse(harness.localStorage.getItem(GATE_KEY));
  assert.equal(prepared.status, 'authorizing_test_mode');
  assert.equal(prepared.authorizedRawHash, rawHash(harness.currentRaw));
  assert.ok(prepared.interruptedModeRepairPreparedAtISO);

  harness.localStorage.setItem(GATE_KEY, JSON.stringify({
    status: 'authorizing_test_mode',
    authorizedRawHash: rawHash(harness.currentRaw),
    baselineRawHash: harness.originalGate.baselineRawHash,
    baselineCounts: harness.originalGate.baselineCounts,
    baselineVerificationFailures: 0,
    baselineBlockedWrites: 0,
    preparedBrowserSessionId: harness.originalGate.preparedBrowserSessionId
  }));
  harness.localStorage.setItem(GATE_KEY, JSON.stringify({
    status: 'awaiting_smoke_test',
    authorizedRawHash: rawHash(harness.currentRaw),
    baselineRawHash: rawHash(harness.currentRaw),
    baselineCounts: { tasks: 2 },
    preparedBrowserSessionId: 'replacement-session',
    preparedPageId: 'replacement-page',
    freshAppSessionId: null,
    freshAppRawHash: null,
    preparedSequence: 100
  }));
  await Promise.resolve();

  const resumed = JSON.parse(harness.localStorage.getItem(GATE_KEY));
  assert.equal(resumed.status, 'awaiting_smoke_test');
  assert.equal(resumed.baselineRawHash, harness.originalGate.baselineRawHash);
  assert.deepEqual(resumed.baselineCounts, harness.originalGate.baselineCounts);
  assert.equal(resumed.preparedBrowserSessionId, harness.originalGate.preparedBrowserSessionId);
  assert.equal(resumed.freshAppSessionId, harness.originalGate.freshAppSessionId);
  assert.equal(resumed.freshAppRawHash, rawHash(harness.currentRaw));
  assert.equal(resumed.freshAppWitnessRawHash, harness.originalGate.freshAppRawHash);
  assert.equal(resumed.exclusivePageLockConfirmed, true);
  assert.ok(resumed.interruptedModeResumedAtISO);
});

test('blocking recovery or pending-work conditions leave the interrupted test off', () => {
  for (const options of [
    { hold: true },
    { attempt: true },
    { journal: true },
    { legacy: true }
  ]) {
    const harness = install(options);
    assert.equal(harness.localStorage.getItem(MODE_KEY), 'off');
    assert.equal(JSON.parse(harness.localStorage.getItem(GATE_KEY)).status, 'awaiting_smoke_test');
  }
});

test('the compatibility bridge refuses to invent proof without vault or exclusive-lock verification', () => {
  for (const options of [
    { vaultVerified: false },
    { exclusiveProof: false }
  ]) {
    const harness = install(options);
    assert.equal(harness.localStorage.getItem(MODE_KEY), 'off');
    assert.equal(JSON.parse(harness.localStorage.getItem(GATE_KEY)).status, 'awaiting_smoke_test');
  }
});
