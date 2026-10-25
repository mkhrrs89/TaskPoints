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

function install(initial = {}) {
  const localStorage = new FakeStorage(initial);
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
  return { api: context.TaskPointsStateRuntimeV2Wal, generation: context.TaskPointsStateRuntimeV2Generation, localStorage };
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

