const test = require('node:test');
const assert = require('node:assert/strict');

// The matrix remains the source-of-truth checklist for State Runtime V2.
// Contracts move out of TODO status only after an executable test exercises the
// behavior. The coverage map below points to the concrete test file responsible
// for each promoted contract.

const CONTRACTS = Object.freeze([
  {
    id: 'V2-01',
    area: 'database-boundary',
    name: 'opening V2 creates only the expected database and initial object stores',
    requires: ['taskpoints_state_v2', 'habits', 'completions', 'mutations', 'meta']
  },
  {
    id: 'V2-02',
    area: 'image-isolation',
    name: 'State Runtime V2 never opens or mutates the existing image database',
    requires: ['taskpoints/images remains isolated']
  },
  {
    id: 'V2-03',
    area: 'atomic-mutation',
    name: 'one habit mutation commits ledger rows, changed records, and revision atomically',
    requires: ['mutation ledger', 'habit/completion changes', 'revision increment']
  },
  {
    id: 'V2-04',
    area: 'atomic-mutation',
    name: 'transaction failure commits none of a logical mutation',
    requires: ['no partial rows', 'no revision increment', 'mutation remains recoverable']
  },
  {
    id: 'V2-05',
    area: 'idempotency',
    name: 'replaying a duplicate mutation id is an idempotent no-op',
    requires: ['no duplicate completion', 'no double scoring', 'no extra revision']
  },
  {
    id: 'V2-06',
    area: 'revision',
    name: 'the committed V2 revision survives runtime recreation and page reload',
    requires: ['persistent revision', 'no in-memory-only sequence authority']
  },
  {
    id: 'V2-07',
    area: 'wal',
    name: 'the synchronous WAL write happens before asynchronous IndexedDB commit begins',
    requires: ['taskpoints_v2_pending_mutations_v1', 'write-ahead ordering']
  },
  {
    id: 'V2-08',
    area: 'wal',
    name: 'verified V2 commit removes only the matching WAL mutation',
    requires: ['unrelated pending mutations remain durable']
  },
  {
    id: 'V2-09',
    area: 'crash-safety',
    name: 'kill-before-IndexedDB simulation leaves the foreground mutation replayable from WAL',
    requires: ['no intentional loss after synchronous WAL write']
  },
  {
    id: 'V2-10',
    area: 'crash-safety',
    name: 'startup WAL replay commits an interrupted mutation exactly once',
    requires: ['idempotent replay', 'WAL cleared only after verified commit']
  },
  {
    id: 'V2-11',
    area: 'wal-integrity',
    name: 'malformed WAL data is preserved or quarantined and never silently applied',
    requires: ['diagnostic failure', 'no destructive silent clear']
  },
  {
    id: 'V2-12',
    area: 'generation',
    name: 'WAL from an older reset generation cannot replay after Reset All',
    requires: ['persistent resetGeneration', 'stale mutation rejection']
  },
  {
    id: 'V2-13',
    area: 'generation',
    name: 'Reset All invalidates an in-flight mutation from the previous generation',
    requires: ['no pre-reset resurrection']
  },
  {
    id: 'V2-14',
    area: 'import-restore',
    name: 'import or authorized restore supersedes pre-import V2 mutations',
    requires: ['new generation/epoch', 'stale WAL cannot replay']
  },
  {
    id: 'V2-15',
    area: 'multi-context',
    name: 'two runtimes detect revision conflict instead of silently last-write-wins overwriting',
    requires: ['expected revision', 'conflict/invalidation path']
  },
  {
    id: 'V2-16',
    area: 'compatibility-snapshot',
    name: 'compatibility snapshots preserve current habit ordering exactly',
    requires: ['group order', 'habit order', 'stable legacy shape']
  },
  {
    id: 'V2-17',
    area: 'compatibility-snapshot',
    name: 'compatibility snapshots preserve completion ordering and duplicate semantics exactly',
    requires: ['legacy canonical completion semantics']
  },
  {
    id: 'V2-18',
    area: 'dark-mirror',
    name: 'dark-mirror mismatch is reported without changing application reads or repairing production state',
    requires: ['diagnostics only', 'legacy remains authoritative']
  },
  {
    id: 'V2-19',
    area: 'fallback',
    name: 'V2 open failure leaves current production behavior untouched',
    requires: ['no V2 read substitution', 'legacy save/read path preserved']
  },
  {
    id: 'V2-20',
    area: 'fallback',
    name: 'V2 quota failure leaves current production behavior untouched',
    requires: ['no production data damage', 'diagnostic failure only in dark mode']
  },
  {
    id: 'V2-21',
    area: 'export',
    name: 'export includes all committed V2 mutations once V2 becomes mutation-authoritative',
    requires: ['transactionally consistent compatibility snapshot or verified checkpoint']
  },
  {
    id: 'V2-22',
    area: 'rollout-gate',
    name: 'no V2 behavior flag may be enabled unless the existing repository suite remains passing',
    requires: ['full current test suite', 'V2 contract suite', 'default-off rollout']
  }
]);

const EXECUTABLE_COVERAGE = Object.freeze({
  'V2-01': 'tests/state_runtime_v2_atomic_contract.test.js',
  'V2-02': 'tests/state_runtime_v2_atomic_contract.test.js',
  'V2-03': 'tests/state_runtime_v2_atomic_contract.test.js',
  'V2-04': 'tests/state_runtime_v2_atomic_contract.test.js',
  'V2-05': 'tests/state_runtime_v2_atomic_contract.test.js',
  'V2-06': 'tests/state_runtime_v2_atomic_contract.test.js',
  'V2-07': 'tests/state_runtime_v2_wal_bridge_contract.test.js',
  'V2-08': 'tests/state_runtime_v2_wal_contract.test.js',
  'V2-09': 'tests/state_runtime_v2_wal_bridge_contract.test.js',
  'V2-10': 'tests/state_runtime_v2_wal_bridge_contract.test.js',
  'V2-11': 'tests/state_runtime_v2_wal_bridge_contract.test.js',
  'V2-12': 'tests/state_runtime_v2_generation_contract.test.js',
  'V2-13': 'tests/state_runtime_v2_generation_contract.test.js',
  'V2-14': 'tests/state_runtime_v2_generation_contract.test.js',
  'V2-15': 'tests/state_runtime_v2_revision_conflict_contract.test.js'
});

test('State Runtime V2 defines the complete initial 22-contract matrix', () => {
  assert.equal(CONTRACTS.length, 22);
  assert.equal(new Set(CONTRACTS.map((contract) => contract.id)).size, 22);
  assert.deepEqual(
    CONTRACTS.map((contract) => contract.id),
    Array.from({ length: 22 }, (_, index) => `V2-${String(index + 1).padStart(2, '0')}`)
  );
});

test('State Runtime V2 contract matrix covers every required correctness boundary', () => {
  const areas = new Set(CONTRACTS.map((contract) => contract.area));
  for (const requiredArea of [
    'database-boundary',
    'image-isolation',
    'atomic-mutation',
    'idempotency',
    'revision',
    'wal',
    'crash-safety',
    'wal-integrity',
    'generation',
    'import-restore',
    'multi-context',
    'compatibility-snapshot',
    'dark-mirror',
    'fallback',
    'export',
    'rollout-gate'
  ]) {
    assert.equal(areas.has(requiredArea), true, `missing V2 contract area: ${requiredArea}`);
  }
});

test('V2 contracts explicitly preserve existing production and image-storage boundaries', () => {
  const text = JSON.stringify(CONTRACTS);
  assert.match(text, /taskpoints_state_v2/);
  assert.match(text, /taskpoints\/images remains isolated/);
  assert.match(text, /legacy remains authoritative/);
  assert.match(text, /current production behavior untouched/);
  assert.match(text, /default-off rollout/);
});

test('V2-01 through V2-15 are promoted only with explicit executable coverage files', () => {
  const promoted = Object.keys(EXECUTABLE_COVERAGE);
  assert.deepEqual(
    promoted,
    Array.from({ length: 15 }, (_, index) => `V2-${String(index + 1).padStart(2, '0')}`)
  );
  const contractIds = new Set(CONTRACTS.map((contract) => contract.id));
  for (const [id, filename] of Object.entries(EXECUTABLE_COVERAGE)) {
    assert.equal(contractIds.has(id), true, `unknown promoted contract: ${id}`);
    assert.match(filename, /^tests\/state_runtime_v2_.*\.test\.js$/);
  }
});

for (const contract of CONTRACTS) {
  if (EXECUTABLE_COVERAGE[contract.id]) continue;
  test.todo(`${contract.id} ${contract.name}`);
}

module.exports = { CONTRACTS, EXECUTABLE_COVERAGE };
