const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'indexeddb_requalification_session_compat.js'), 'utf8');
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

function makeHarness({ heldLocks = 1, vaultVerified = true, pendingJournal = false, sameSession = false } = {}) {
  const baselineRaw = JSON.stringify({ tasks: [{ id: 'before' }] });
  const currentRaw = JSON.stringify({ tasks: [{ id: 'before' }, { id: 'after' }] });
  const storage = new FakeStorage({
    [STORAGE_KEY]: currentRaw,
    [MODE_KEY]: 'verify_primary_writes',
    [GATE_KEY]: JSON.stringify({
      status: 'awaiting_smoke_test',
      preparedBrowserSessionId: 'prepared-session',
      baselineRawHash: rawHash(baselineRaw)
    })
  });
  if (pendingJournal) storage.setItem(JOURNAL_KEY, JSON.stringify([{ id: 'waiting' }]));

  const finishButton = { dataset: { allowed: 'false' }, disabled: true };
  const core = {
    STORAGE_KEY,
    PHASE4_STORAGE_MODE_KEY: MODE_KEY,
    PENDING_HABIT_DELTAS_KEY: JOURNAL_KEY,
    getIndexedDbBrowserSessionStatus() {
      return { sessionId: sameSession ? 'prepared-session' : 'fresh-session', lockSupported: true };
    },
    queuePhase4PrimaryWrite() {},
    async flushPhase4PrimaryWrites() {},
    queuePhase5ANativeSnapshotWrite() {},
    async flushPhase5ANativeSnapshotWrites() {},
    queuePhase5CVerifiedSecondaryWrite() {},
    async flushPhase5CVerifiedSecondaryWrites() {},
    async restorePhase4CommittedPrimary() { return { restored: true }; },
    getPhase4StorageStatus() {
      return {
        latestQueuedSequence: 2,
        latestPassedSequence: 2,
        pendingWrites: 0,
        lastFallbackReason: null,
        countsMatch: true,
        hashesMatch: true,
        canonicalMatch: true,
        mismatches: []
      };
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage: storage,
    Storage: FakeStorage,
    navigator: {
      locks: {
        async query() {
          return {
            held: Array.from({ length: heldLocks }, () => ({ name: 'taskpoints_active_page_v1' })),
            pending: []
          };
        }
      }
    },
    document: { getElementById: (id) => id === 'finishTestBtn' ? finishButton : null },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Set,
    Date,
    Math,
    console,
    __TASKPOINTS_REQUALIFICATION_VERIFIED_VAULT_HASH__: vaultVerified ? 'verified-vault' : ''
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'indexeddb_requalification_session_compat.js' });
  return { storage, finishButton };
}

test('a missed normal-app witness is recovered after the setup page confirms it is the only TaskPoints page', async () => {
  const harness = makeHarness();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gate = JSON.parse(harness.storage.getItem(GATE_KEY));
  assert.equal(gate.freshAppSessionId, 'fresh-session');
  assert.equal(gate.exclusivePageLockConfirmed, true);
  assert.equal(gate.reopenProofMethod, 'single_active_page_lock_query');
  assert.equal(harness.finishButton.dataset.allowed, 'true');
  assert.equal(harness.finishButton.disabled, false);
});

test('the missed-witness repair refuses to run while another TaskPoints page is open', async () => {
  const harness = makeHarness({ heldLocks: 2 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gate = JSON.parse(harness.storage.getItem(GATE_KEY));
  assert.equal(gate.freshAppSessionId, undefined);
  assert.equal(harness.finishButton.dataset.allowed, 'false');
});

test('the missed-witness repair still requires the vault, clean journals, and a different browser session', async () => {
  for (const options of [{ vaultVerified: false }, { pendingJournal: true }, { sameSession: true }]) {
    const harness = makeHarness(options);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const gate = JSON.parse(harness.storage.getItem(GATE_KEY));
    assert.equal(gate.freshAppSessionId, undefined);
  }
});
