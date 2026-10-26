const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const generationSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_generation.js'), 'utf8');
const walSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal.js'), 'utf8');

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
  get length() { return this.rows.size; }
  key(index) { return [...this.rows.keys()][index] ?? null; }
}

function install(initial = {}, sharedStorage = null) {
  const localStorage = sharedStorage || new FakeStorage(initial);
  let uuid = 0;
  const context = {
    localStorage,
    structuredClone,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    console,
    crypto: { randomUUID() { uuid += 1; return `wal-test-${uuid}`; } }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  vm.runInNewContext(walSource, context, { filename: 'state_runtime_v2_wal.js' });
  return { api: context.TaskPointsStateRuntimeV2Wal, generation: context.TaskPointsStateRuntimeV2Generation, localStorage, context };
}

const DARK = 'taskpoints_state_v2_dark_mode_v1';
const KEY = 'taskpoints_v2_pending_mutations_v1';
const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
const deltaA = { id: 'habit:h1:2026-08-31', habitId: 'h1', dayKey: '2026-08-31', status: 'full', done: true, updatedAtISO: '2026-08-31T12:00:00.000Z' };
const deltaB = { id: 'habit:h2:2026-08-31', habitId: 'h2', dayKey: '2026-08-31', status: 'half', done: true, completionFraction: 0.5, updatedAtISO: '2026-08-31T12:01:00.000Z' };

test('V2 WAL is default-off and does not persist while dark mode is disabled', () => {
  const { api, localStorage } = install();
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, false);
  assert.equal(result.reason, 'dark_disabled');
  assert.equal(localStorage.getItem(KEY), null);
  assert.equal(localStorage.getItem(GENERATION_KEY), null);
});

test('V2 WAL synchronously persists a generation-stamped habit mutation under the dedicated key', () => {
  const { api, generation, localStorage } = install({ [DARK]: '1' });
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, true);
  const raw = localStorage.getItem(KEY);
  assert.ok(raw);
  const rows = JSON.parse(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.mutationId);
  assert.equal(rows[0].type, 'habit-completion-set');
  assert.equal(rows[0].delta.habitId, 'h1');
  assert.equal(rows[0].generation, generation.read());
  assert.equal(result.generation, generation.read());
});

test('duplicate mutation id is idempotent within the same generation', () => {
  const { api } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const second = api.appendHabitDelta(deltaA);
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.mutationId, first.mutationId);
  assert.equal(api.getPendingRows().rows.length, 1);
});

test('same delta after a generation rotation gets a distinct mutation id', () => {
  const { api, generation } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  generation.rotate('reset-test');
  const second = api.appendHabitDelta(deltaA);
  assert.equal(second.written, true);
  assert.notEqual(second.generation, first.generation);
  assert.notEqual(second.mutationId, first.mutationId);
  assert.equal(api.getPendingRows().rows.length, 2);
});

test('verified commit cleanup removes only the matching WAL mutation', () => {
  const { api } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const second = api.appendHabitDelta(deltaB);
  const removed = api.removeMutation(first.mutationId);
  assert.equal(removed.removed, true);
  const pending = api.getPendingRows();
  assert.equal(pending.rows.length, 1);
  assert.equal(pending.rows[0].id, second.mutationId);
});

test('malformed WAL is preserved and never silently cleared or overwritten', () => {
  const malformed = '{ definitely not valid json';
  const { api, localStorage } = install({ [DARK]: '1', [KEY]: malformed });
  const read = api.getPendingRows();
  assert.equal(read.ok, false);
  assert.equal(localStorage.getItem(KEY), malformed);
  assert.throws(() => api.appendHabitDelta(deltaA), /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(KEY), malformed);
  assert.throws(() => api.removeMutation('anything'), /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(KEY), malformed);
});

test('mutation identity is stable for the same normalized delta and generation', () => {
  const { api, generation } = install({ [DARK]: '1' });
  const activeGeneration = generation.read();
  assert.equal(api.mutationIdForDelta(deltaA, activeGeneration), api.mutationIdForDelta({ ...deltaA }, activeGeneration));
});

test('source explicitly uses the contract WAL and generation keys with synchronous localStorage writes', () => {
  assert.match(walSource, /taskpoints_v2_pending_mutations_v1/);
  assert.match(walSource, /taskpoints_state_v2_generation_v1/);
  assert.match(walSource, /localStorage\?\.setItem/);
  assert.doesNotMatch(walSource, /setTimeout\([^)]*appendHabitDelta/s);
});

test('WAL preserves canonical completion time and distinguishes timestamp corrections', () => {
  const { api } = install({ [DARK]: '1' });
  const delta = { ...deltaA, completedAtISO: '2026-08-31T16:00:00.000Z' };
  const saved = api.appendHabitDelta(delta);
  assert.equal(saved.row.delta.completedAtISO, delta.completedAtISO);
  assert.notEqual(api.mutationIdForDelta(delta), api.mutationIdForDelta(deltaA));
});

test('independent WAL events survive a stale shared-key overwrite and selective cleanup', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA);
  const b = api.appendHabitDelta(deltaB);
  const sidecarPrefix = 'taskpoints_v2_pending_mutation_event_v1:';
  assert.equal(localStorage.getItem(sidecarPrefix + a.mutationId) !== null, true);
  assert.equal(localStorage.getItem(sidecarPrefix + b.mutationId) !== null, true);
  // Simulates another tab writing an obsolete view of the shared array.
  localStorage.setItem(KEY, JSON.stringify([a.row]));
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    [a.mutationId,b.mutationId].sort());
  api.removeMutation(a.mutationId);
  assert.equal(localStorage.getItem(sidecarPrefix + a.mutationId), null);
  assert.equal(api.getPendingRows().rows.length, 1);
  assert.equal(api.getPendingRows().rows[0].id, b.mutationId);
  api.removeMutation(b.mutationId);
  assert.equal(api.getPendingRows().rows.length, 0);
  assert.equal(api.getStatus().independentEventCount, 0);
});

test('independent WAL event survives a shared-key write failure before the tab closes', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key) === KEY) throw new Error('simulated full WAL array quota error');
    return original(key, value);
  };
  assert.throws(() => api.appendHabitDelta(deltaA), /state_runtime_v2_wal_write_failed/);
  localStorage.setItem = original;
  const surviving = api.getPendingRows();
  assert.equal(surviving.ok, true);
  assert.equal(surviving.rows.length, 1);
  assert.equal(surviving.rows[0].delta.habitId, 'h1');
  assert.equal(api.getStatus().independentEventCount, 1);
});

test('malformed independently durable WAL event fails closed and preserves its bytes', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const key = 'taskpoints_v2_pending_mutation_event_v1:corrupted';
  const original = '{"incomplete":';
  localStorage.setItem(key, original);
  const read = api.getPendingRows();
  assert.equal(read.ok, false);
  assert.match(read.error, /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(key), original);
  assert.throws(() => api.appendHabitDelta(deltaA), /state_runtime_v2_wal_malformed/);
  assert.throws(() => api.removeMutation('corrupted'), /state_runtime_v2_wal_malformed/);
  assert.equal(localStorage.getItem(key), original);
});


test('two independent browser contexts preserve WAL events when a stale shared array replaces newer rows', () => {
  const storage = new FakeStorage({ [DARK]: '1' });
  const tabA = install({}, storage).api;
  const tabB = install({}, storage).api;
  const first = tabA.appendHabitDelta(deltaA);
  const staleShared = storage.getItem(KEY);
  const second = tabB.appendHabitDelta(deltaB);
  storage.setItem(KEY, staleShared);
  const expected = [first.mutationId, second.mutationId].sort();
  assert.deepEqual(tabA.getPendingRows().rows.map(r=>r.id).sort(), expected);
  assert.deepEqual(tabB.getPendingRows().rows.map(r=>r.id).sort(), expected);
  tabA.removeMutation(first.mutationId);
  assert.deepEqual(tabB.getPendingRows().rows.map(r=>r.id), [second.mutationId]);
  tabB.removeMutation(second.mutationId);
  assert.equal(tabA.getPendingRows().rows.length, 0);
});

test('quota-denied independent WAL append does not create a shared-only mutation', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const before = localStorage.getItem(KEY);
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key).startsWith('taskpoints_v2_pending_mutation_event_v1:'))
      throw new Error('synthetic WAL sidecar QuotaExceededError');
    return original(key, value);
  };
  assert.throws(() => api.appendHabitDelta(deltaA),
    /state_runtime_v2_wal_independent_write_failed/);
  localStorage.setItem = original;
  assert.equal(localStorage.getItem(KEY), before,
    'shared WAL must never claim durability when the independent record failed');
  assert.equal(api.getPendingRows().rows.length, 0);
  assert.equal(api.getStatus().independentEventCount, 0);
});

test('interrupted shared WAL cleanup retains independent evidence and can retry', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA), b = api.appendHabitDelta(deltaB);
  const before = localStorage.getItem(KEY);
  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key) === KEY) throw new Error('synthetic shared WAL cleanup quota');
    return original(key, value);
  };
  assert.throws(() => api.removeMutation(a.mutationId), /state_runtime_v2_wal_write_failed/);
  localStorage.setItem = original;
  assert.equal(localStorage.getItem(KEY), before);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    [a.mutationId, b.mutationId].sort());
  assert.equal(api.removeMutation(a.mutationId).removed, true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id), [b.mutationId]);
});

test('interrupted independent WAL cleanup retains evidence after shared cleanup until retry', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const a = api.appendHabitDelta(deltaA), b = api.appendHabitDelta(deltaB);
  const prefix = 'taskpoints_v2_pending_mutation_event_v1:';
  const original = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = key => {
    if (String(key) === prefix + a.mutationId)
      throw new Error('synthetic WAL sidecar removal interruption');
    return original(key);
  };
  assert.throws(() => api.removeMutation(a.mutationId),
    /state_runtime_v2_wal_independent_remove_failed/);
  localStorage.removeItem = original;
  assert.ok(localStorage.getItem(prefix+a.mutationId),
    'unremoved sidecar is retained as recoverable evidence');
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    [a.mutationId,b.mutationId].sort());
  assert.equal(api.removeMutation(a.mutationId).removed, true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id), [b.mutationId]);
  assert.equal(api.getStatus().independentEventCount, 1);
});

test('three generation rotations retain stale evidence without cross-generation mutation identity collision', () => {
  const { api, generation, localStorage } = install({ [DARK]: '1' });
  const events = [];
  for (let round=0;round<4;round++) {
    if (round) generation.rotate('simulated-import-'+round);
    const item=api.appendHabitDelta(deltaA);
    assert.equal(item.written,true);
    assert.equal(item.generation,generation.read());
    events.push(item);
  }
  assert.equal(new Set(events.map(e=>e.mutationId)).size,4);
  assert.equal(api.getStatus().independentEventCount,4);
  assert.equal(api.getPendingRows().rows.length,4);
  const all=api.getPendingRows().rows;
  assert.equal(all.filter(x=>x.generation===generation.read()).length,1);
  // Earlier-generation rows must remain inspectable, not silently migrated.
  const keyPrefix='taskpoints_v2_pending_mutation_event_v1:';
  for (const row of events.slice(0,-1))
    assert.ok(localStorage.getItem(keyPrefix+row.mutationId));
  assert.equal(api.removeMutation(events[3].mutationId).removed,true);
  assert.deepEqual(api.getPendingRows().rows.map(r=>r.id).sort(),
    events.slice(0,-1).map(e=>e.mutationId).sort());
  assert.equal(api.getStatus().independentEventCount,3);
});

test('a malformed shared record conflicts with an intact independent row without deleting evidence', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const mutation=api.appendHabitDelta(deltaA);
  const sidecar='taskpoints_v2_pending_mutation_event_v1:'+mutation.mutationId;
  const saved=localStorage.getItem(sidecar);
  localStorage.setItem(KEY, JSON.stringify([{...mutation.row,
    delta:{...mutation.row.delta,status:'off'}}]));
  const read=api.getPendingRows();
  assert.equal(read.ok,false);
  assert.match(read.error,/wal_shared_independent_identity_conflict/);
  assert.equal(localStorage.getItem(sidecar),saved);
  assert.throws(()=>api.removeMutation(mutation.mutationId), /wal_shared_independent_identity_conflict/);
  assert.equal(localStorage.getItem(sidecar),saved);
});

test('shared WAL read denial is not mistaken for an empty log or permission to clear evidence', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sidecarKey = 'taskpoints_v2_pending_mutation_event_v1:' + first.mutationId;
  const originalShared = localStorage.getItem(KEY);
  const originalSidecar = localStorage.getItem(sidecarKey);
  const originalGet = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (String(key) === KEY) throw new Error('synthetic WAL shared read SecurityError');
    return originalGet(key);
  };

  try {
    const unreadable = api.getPendingRows();
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.error, /wal_storage_read_failed/);
    assert.throws(() => api.appendHabitDelta(deltaB), /wal_storage_read_failed/);
    assert.throws(() => api.removeMutation(first.mutationId), /wal_storage_read_failed/);
  } finally {
    localStorage.getItem = originalGet;
  }

  assert.equal(localStorage.getItem(KEY), originalShared, 'shared bytes survive denied reads');
  assert.equal(localStorage.getItem(sidecarKey), originalSidecar, 'sidecar bytes survive denied reads');
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [first.mutationId],
    'recovery can inspect the original WAL again when reads resume');
});

test('independent sidecar read denial blocks replay and selective cleanup without losing a row', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sidecarKey = 'taskpoints_v2_pending_mutation_event_v1:' + first.mutationId;
  const originalShared = localStorage.getItem(KEY);
  const originalSidecar = localStorage.getItem(sidecarKey);
  const originalGet = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (String(key) === sidecarKey) throw new Error('synthetic WAL sidecar read SecurityError');
    return originalGet(key);
  };

  try {
    const unreadable = api.getPendingRows();
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.error, /wal_storage_read_failed/);
    assert.throws(() => api.appendHabitDelta(deltaB), /wal_storage_read_failed/);
    assert.throws(() => api.removeMutation(first.mutationId), /wal_storage_read_failed/);
  } finally {
    localStorage.getItem = originalGet;
  }

  assert.equal(localStorage.getItem(KEY), originalShared);
  assert.equal(localStorage.getItem(sidecarKey), originalSidecar);
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(api.removeMutation(first.mutationId).removed, true,
    'selective cleanup resumes only once both durable records are readable');
  assert.equal(api.getPendingRows().rows.length, 0);
});

test('denied WAL key enumeration fails closed without crashing status or dropping sidecars', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sharedBefore = localStorage.getItem(KEY);
  const sidecarKey = 'taskpoints_v2_pending_mutation_event_v1:' + first.mutationId;
  const sidecarBefore = localStorage.getItem(sidecarKey);
  const originalKey = localStorage.key;
  localStorage.key = () => { throw new Error('synthetic localStorage.key SecurityError'); };
  try {
    const pending = api.getPendingRows();
    assert.equal(pending.ok, false);
    assert.match(pending.error, /synthetic localStorage\.key SecurityError/);
    const status = api.getStatus();
    assert.equal(status.malformed, true);
    assert.equal(status.pendingCount, null);
    assert.equal(status.independentEventCount, null);
    assert.match(status.lastError, /state_runtime_v2_wal_inventory_unreadable/);
    assert.throws(() => api.appendHabitDelta(deltaB), /state_runtime_v2_wal_malformed/);
    assert.throws(() => api.removeMutation(first.mutationId), /state_runtime_v2_wal_malformed/);
  } finally {
    localStorage.key = originalKey;
  }
  assert.equal(localStorage.getItem(KEY), sharedBefore);
  assert.equal(localStorage.getItem(sidecarKey), sidecarBefore);
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(api.getStatus().malformed, false);
  assert.equal(api.removeMutation(first.mutationId).removed, true);
});

test('denied localStorage length inventory keeps pending WAL unknown rather than falsely zero', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const sharedBefore = localStorage.getItem(KEY);
  Object.defineProperty(localStorage, 'length', {
    configurable: true,
    get() { throw new Error('synthetic localStorage.length SecurityError'); }
  });
  try {
    const status = api.getStatus();
    assert.equal(status.malformed, true);
    assert.equal(status.pendingCount, null);
    assert.equal(status.independentEventCount, null);
    assert.match(status.lastError, /state_runtime_v2_wal_inventory_unreadable/);
    assert.equal(api.getPendingRows().ok, false);
    assert.throws(() => api.removeMutation(first.mutationId), /state_runtime_v2_wal_malformed/);
  } finally {
    delete localStorage.length;
  }
  assert.equal(localStorage.getItem(KEY), sharedBefore);
  assert.equal(api.getPendingRows().rows.length, 1);
  assert.equal(api.getStatus().independentEventCount, 1);
});

test('standalone WAL fallback never manufactures a new epoch when generation read is denied', () => {
  const oldEpoch = 'original-stored-generation';
  const first = install({ [DARK]: '1', [GENERATION_KEY]: oldEpoch });
  const { api, localStorage, context } = first;
  const saved = api.appendHabitDelta(deltaA);
  assert.equal(saved.generation, oldEpoch);
  const walBefore = localStorage.getItem(KEY);
  const sidecarBefore = localStorage.getItem('taskpoints_v2_pending_mutation_event_v1:' + saved.mutationId);
  // Simulate recovery while the generation module is unavailable. The WAL
  // module must not interpret transient storage denial as an absent epoch.
  context.TaskPointsStateRuntimeV2Generation = null;
  const get = localStorage.getItem.bind(localStorage);
  localStorage.getItem = key => {
    if (String(key) === GENERATION_KEY) throw new Error('generation key SecurityError');
    return get(key);
  };
  try {
    assert.throws(() => api.ensureGeneration(), /wal_storage_read_failed/);
    assert.throws(() => api.mutationIdForDelta(deltaB), /wal_storage_read_failed/);
    assert.throws(() => api.appendHabitDelta(deltaB), /wal_storage_read_failed/);
    const status = api.getStatus();
    assert.equal(status.generationReadable, false);
    assert.equal(status.pendingCount, null);
    assert.equal(status.malformed, true);
  } finally {
    localStorage.getItem = get;
  }
  assert.equal(localStorage.getItem(GENERATION_KEY), oldEpoch);
  assert.equal(localStorage.getItem(KEY), walBefore);
  assert.equal(localStorage.getItem('taskpoints_v2_pending_mutation_event_v1:' + saved.mutationId),
    sidecarBefore);
  assert.deepEqual(api.getPendingRows().rows.map(row => row.id), [saved.mutationId]);
  assert.equal(api.ensureGeneration(), oldEpoch);
  assert.equal(api.appendHabitDelta(deltaB).written, true);
  assert.equal(api.getPendingRows().rows.length, 2);
});

test('standalone WAL fallback creates an epoch only when storage proves key is missing', () => {
  const { api, context, localStorage } = install({ [DARK]: '1' });
  // The full generation module creates its bootstrap epoch during setup.
  // Remove it deliberately to model a truly absent key with verified reads.
  localStorage.removeItem(GENERATION_KEY);
  context.TaskPointsStateRuntimeV2Generation = null;
  assert.equal(localStorage.getItem(GENERATION_KEY), null);
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, true);
  assert.equal(result.generation, localStorage.getItem(GENERATION_KEY));
  assert.equal(api.getPendingRows().rows.length, 1);
});

test('WAL never bypasses an installed generation authority that declines to provide an epoch', () => {
  const { api, context, localStorage } = install({ [DARK]: '1' });
  const original = context.TaskPointsStateRuntimeV2Generation;
  context.TaskPointsStateRuntimeV2Generation = {
    ensure() { return { enabled: false, generation: null }; },
    read() { return null; }
  };
  assert.throws(() => api.appendHabitDelta(deltaA), /wal_generation_unavailable/);
  assert.equal(localStorage.getItem(GENERATION_KEY), null);
  assert.equal(localStorage.getItem(KEY), null);
  context.TaskPointsStateRuntimeV2Generation = original;
  assert.equal(api.appendHabitDelta(deltaA).written, true);
});
