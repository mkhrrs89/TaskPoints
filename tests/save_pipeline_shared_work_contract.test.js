const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'save_pipeline_shared_work.js'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, '_worker.js'), 'utf8');

function install() {
  const raw = JSON.stringify({ tasks: [{ id: 'a' }], habits: [], completions: [] });
  const verifiedState = JSON.parse(raw);
  let parseCalls = 0;
  let summaryCalls = 0;
  let pendingPhase4 = 0;
  let journal = [];
  const cache = {
    status: 'passed_verification',
    sequence: 7,
    state: verifiedState,
    mirrorRaw: raw,
    destinationHash: 'state-hash',
    destinationCounts: { tasks: 1, habits: 0, completions: 0 },
    mirrorHash: 'raw-hash',
    verifiedAt: '2026-08-01T21:00:00.000Z'
  };
  const localStorage = {
    getItem(key) { return key === 'taskpoints_v1' ? raw : null; }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    getPhase4VerifiedPrimaryCache: () => cache,
    getPendingShadowDualWriteCount: () => 0,
    getPendingPhase4WriteCount: () => pendingPhase4,
    readPendingHabitDeltas: () => journal,
    parseTaskPointsStorageJson(value, fallback) {
      parseCalls += 1;
      return value ? JSON.parse(value) : fallback;
    },
    shadowSourceSummary(value) {
      summaryCalls += 1;
      return { counts: { tasks: value.tasks?.length || 0 }, hashes: { state: 'fresh-hash' } };
    }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    structuredClone,
    JSON, Object, Array, String, Number, Boolean, Promise, Error, Date, Math, WeakMap, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'save_pipeline_shared_work.js' });
  return {
    core,
    context,
    raw,
    cache,
    parseCalls: () => parseCalls,
    summaryCalls: () => summaryCalls,
    setPending: (value) => { pendingPhase4 = value; },
    setJournal: (value) => { journal = value; }
  };
}

test('verified raw is cloned from the trusted Phase 4 package without reparsing', () => {
  const harness = install();
  const parsed = harness.core.parseTaskPointsStorageJson(harness.raw, {});
  assert.deepEqual(parsed, harness.cache.state);
  assert.notEqual(parsed, harness.cache.state);
  assert.equal(harness.parseCalls(), 0);

  const summary = harness.core.shadowSourceSummary(parsed);
  assert.equal(summary.hashes.state, 'state-hash');
  assert.equal(summary.counts.tasks, 1);
  assert.equal(harness.summaryCalls(), 0);
});

test('shared snapshot metadata follows structured clones used by later backup layers', () => {
  const harness = install();
  const parsed = harness.core.parseTaskPointsStorageJson(harness.raw, {});
  const cloned = harness.context.structuredClone(parsed);
  const summary = harness.core.shadowSourceSummary(cloned);
  assert.equal(summary.hashes.state, 'state-hash');
  assert.equal(harness.summaryCalls(), 0);
  assert.ok(harness.core.getSharedSaveWorkStatus().clonePropagationCount >= 1);
});

test('pending writes or habit journal entries disable reuse and fall back safely', () => {
  const harness = install();
  harness.setPending(1);
  harness.core.parseTaskPointsStorageJson(harness.raw, {});
  assert.equal(harness.parseCalls(), 1);

  harness.setPending(0);
  harness.setJournal([{ id: 'pending' }]);
  harness.core.parseTaskPointsStorageJson(harness.raw, {});
  assert.equal(harness.parseCalls(), 2);
});

test('the versioned worker fingerprints and includes the shared save module', () => {
  assert.match(worker, /'\/save_pipeline_shared_work\.js'/);
  assert.match(worker, /readAssetSource\(env, request, '\/save_pipeline_shared_work\.js'\)/);
  assert.match(worker, /x-taskpoints-shared-save-work/);
});
