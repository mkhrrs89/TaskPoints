const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'phase4_cache_guard.js'), 'utf8');

function install({ mode = 'verify_primary_writes', journal = [{}], gap = true, autoCompact = true } = {}) {
  const rows = new Map([['taskpoints_v1', JSON.stringify({ habits: [], completions: [] })]]);
  let journalRows = journal.slice();
  let compactionCalls = 0;
  let queueCalls = 0;
  const status = {
    latestQueuedSequence: gap ? 22 : 17,
    latestPassedSequence: 17,
    lastFallbackReason: gap ? 'pending_habit_journal' : null
  };
  const listeners = {};
  const localStorage = {
    getItem(key) { return rows.has(key) ? rows.get(key) : null; },
    setItem(key, value) { rows.set(key, String(value)); }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    PENDING_HABIT_DELTAS_KEY: 'taskpoints_pending_habit_deltas_v1',
    PHASE4_STORAGE_MODE_KEY: 'taskpoints_phase4_storage_mode_v1',
    getPhase4StorageMode: () => mode,
    readPendingHabitDeltas: () => journalRows,
    getPhase4StorageStatus: () => ({ ...status }),
    parseTaskPointsStorageJson: (raw) => JSON.parse(raw),
    clearPhase4Caches() {},
    schedulePendingHabitDeltaCompaction() {
      compactionCalls += 1;
      if (autoCompact) setTimeout(() => { journalRows = []; }, 0);
    },
    queuePhase4PrimaryWrite() {
      queueCalls += 1;
      status.latestQueuedSequence = 23;
      status.latestPassedSequence = 23;
      status.lastFallbackReason = null;
      return Promise.resolve();
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    addEventListener(type, fn) { listeners[type] = fn; },
    setTimeout,
    clearTimeout,
    Promise,
    Number,
    JSON,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'phase4_cache_guard.js' });
  return { core, compactionCalls: () => compactionCalls, queueCalls: () => queueCalls };
}

test('new page resumes a durable journal and closes a persisted sequence gap', async () => {
  const harness = install();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(harness.compactionCalls(), 1);
  assert.equal(harness.queueCalls(), 1);
});

test('gap without a remaining journal queues one recovery write', async () => {
  const harness = install({ journal: [] });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(harness.compactionCalls(), 0);
  assert.equal(harness.queueCalls(), 1);
});

test('off mode performs no recovery work', async () => {
  const harness = install({ mode: 'off' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(harness.compactionCalls(), 0);
  assert.equal(harness.queueCalls(), 0);
});
