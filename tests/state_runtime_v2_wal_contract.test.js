const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const walSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal.js'), 'utf8');

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function install(initial = {}) {
  const localStorage = new FakeStorage(initial);
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
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(walSource, context, { filename: 'state_runtime_v2_wal.js' });
  return { api: context.TaskPointsStateRuntimeV2Wal, localStorage };
}

const DARK = 'taskpoints_state_v2_dark_mode_v1';
const KEY = 'taskpoints_v2_pending_mutations_v1';
const deltaA = { id: 'habit:h1:2026-08-31', habitId: 'h1', dayKey: '2026-08-31', status: 'full', done: true, updatedAtISO: '2026-08-31T12:00:00.000Z' };
const deltaB = { id: 'habit:h2:2026-08-31', habitId: 'h2', dayKey: '2026-08-31', status: 'half', done: true, completionFraction: 0.5, updatedAtISO: '2026-08-31T12:01:00.000Z' };

test('V2 WAL is default-off and does not persist while dark mode is disabled', () => {
  const { api, localStorage } = install();
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, false);
  assert.equal(result.reason, 'dark_disabled');
  assert.equal(localStorage.getItem(KEY), null);
});

test('V2 WAL synchronously persists a habit mutation under the dedicated key', () => {
  const { api, localStorage } = install({ [DARK]: '1' });
  const result = api.appendHabitDelta(deltaA);
  assert.equal(result.written, true);
  const raw = localStorage.getItem(KEY);
  assert.ok(raw);
  const rows = JSON.parse(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.mutationId);
  assert.equal(rows[0].type, 'habit-completion-set');
  assert.equal(rows[0].delta.habitId, 'h1');
});

test('duplicate mutation id is idempotent and does not append twice', () => {
  const { api } = install({ [DARK]: '1' });
  const first = api.appendHabitDelta(deltaA);
  const second = api.appendHabitDelta(deltaA);
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.mutationId, first.mutationId);
  assert.equal(api.getPendingRows().rows.length, 1);
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

test('mutation identity is stable for the same normalized delta', () => {
  const { api } = install({ [DARK]: '1' });
  assert.equal(api.mutationIdForDelta(deltaA), api.mutationIdForDelta({ ...deltaA }));
});

test('source explicitly uses the contract WAL key and synchronous localStorage write', () => {
  assert.match(walSource, /taskpoints_v2_pending_mutations_v1/);
  assert.match(walSource, /localStorage\?\.setItem/);
  assert.doesNotMatch(walSource, /setTimeout\([^)]*appendHabitDelta/s);
});
