const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'state_v2_preview_cleanup.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
assert.ok(scriptMatch, 'cleanup page script must exist');
const source = scriptMatch[1];

class FakeStorage {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
}

function runCleanup(hostname) {
  const localStorage = new FakeStorage({
    taskpoints_v1: 'PRODUCTION_STATE_SENTINEL',
    taskpoints_verified_secondary_v1: 'VERIFIED_SECONDARY_SENTINEL',
    taskpoints_state_v2_dark_mode_v1: '1',
    taskpoints_state_v2_generation_v1: 'generation:test',
    taskpoints_v2_pending_mutations_v1: '[{"id":"pending"}]',
    unrelated_key: 'keep-me'
  });
  const status = { className: '', textContent: '' };
  const deleteCalls = [];
  let deleteRequest = null;
  const indexedDB = {
    deleteDatabase(name) {
      deleteCalls.push(String(name));
      deleteRequest = { onsuccess: null, onerror: null, onblocked: null };
      return deleteRequest;
    }
  };
  const context = {
    localStorage,
    indexedDB,
    location: { hostname },
    document: { getElementById() { return status; } },
    Object,
    String,
    Set,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'state_v2_preview_cleanup.html' });
  return { localStorage, status, deleteCalls, deleteRequest };
}

test('preview cleanup removes only V2 keys and only the dedicated V2 IndexedDB database', () => {
  const app = runCleanup('agent-state-runtime-v2-plan.taskpoints.pages.dev');

  assert.equal(app.localStorage.getItem('taskpoints_state_v2_dark_mode_v1'), null);
  assert.equal(app.localStorage.getItem('taskpoints_state_v2_generation_v1'), null);
  assert.equal(app.localStorage.getItem('taskpoints_v2_pending_mutations_v1'), null);
  assert.equal(app.localStorage.getItem('taskpoints_v1'), 'PRODUCTION_STATE_SENTINEL');
  assert.equal(app.localStorage.getItem('taskpoints_verified_secondary_v1'), 'VERIFIED_SECONDARY_SENTINEL');
  assert.equal(app.localStorage.getItem('unrelated_key'), 'keep-me');
  assert.deepEqual(app.deleteCalls, ['taskpoints_state_v2']);

  app.deleteRequest.onsuccess();
  assert.equal(app.status.className, 'ok');
  assert.match(app.status.textContent, /Production TaskPoints state and images were not touched/);
});

test('cleanup is blocked on the production hostname before any V2 or production storage changes', () => {
  const app = runCleanup('taskpoints.pages.dev');

  assert.equal(app.localStorage.getItem('taskpoints_state_v2_dark_mode_v1'), '1');
  assert.equal(app.localStorage.getItem('taskpoints_state_v2_generation_v1'), 'generation:test');
  assert.equal(app.localStorage.getItem('taskpoints_v2_pending_mutations_v1'), '[{"id":"pending"}]');
  assert.equal(app.localStorage.getItem('taskpoints_v1'), 'PRODUCTION_STATE_SENTINEL');
  assert.equal(app.localStorage.getItem('taskpoints_verified_secondary_v1'), 'VERIFIED_SECONDARY_SENTINEL');
  assert.deepEqual(app.deleteCalls, []);
  assert.equal(app.status.className, 'bad');
  assert.match(app.status.textContent, /blocked on the production TaskPoints hostname/);
});

test('cleanup source never targets the legacy state, image database, or verified-secondary key', () => {
  assert.doesNotMatch(source, /removeItem\(['"]taskpoints_v1['"]\)/);
  assert.doesNotMatch(source, /removeItem\(['"]taskpoints_verified_secondary_v1['"]\)/);
  assert.doesNotMatch(source, /deleteDatabase\(['"]taskpoints['"]\)/);
  assert.match(source, /deleteDatabase\(V2_DATABASE\)/);
  assert.match(source, /const V2_DATABASE = 'taskpoints_state_v2'/);
});
