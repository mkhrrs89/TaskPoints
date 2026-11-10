const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');

function harness(raw) {
  const rows = new Map();
  if (raw !== null) rows.set('taskpoints_v1', raw);
  let writes = 0;
  const localStorage = {
    getItem(key) { return rows.has(key) ? rows.get(key) : null; },
    setItem(key, value) { writes += 1; rows.set(String(key), String(value)); },
    removeItem(key) { rows.delete(key); },
    key(i) { return Array.from(rows.keys())[i] ?? null; },
    get length() { return rows.size; }
  };
  const context = {
    localStorage, document: { readyState: 'loading', addEventListener() {} },
    location: { pathname: '/' },
    addEventListener() {}, setTimeout() {}, clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
    structuredClone(value) { return JSON.parse(JSON.stringify(value)); },
    JSON, Math, Array, Map, Set, Date, Object, Error
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'scoring_core.js' });
  return { core: context.TaskPointsCore, localStorage, writes: () => writes };
}

test('corrupted primary payload stops app initialization without writing empty state', () => {
  const raw = '{"tasks":[{"id":"existing"}], "completions":';
  const h = harness(raw);
  assert.throws(
    () => h.core.loadAppState({ syncDerived: false, persistSync: false }),
    /saved data could not be read/
  );
  assert.equal(h.localStorage.getItem('taskpoints_v1'), raw);
  assert.equal(h.writes(), 0);
});

test('normal populated state still loads and a genuinely missing state remains a valid new account', () => {
  const populated = harness(JSON.stringify({
    tasks: [{ id: 'existing-task', title: 'Important' }],
    completions: [{ id: 'existing-completion', points: 3 }],
    players: [{ id: 'existing-player', name: 'Player' }]
  }));
  const result = populated.core.loadAppState({ syncDerived: false, persistSync: false });
  assert.equal(result.state.tasks[0].id, 'existing-task');
  assert.equal(result.state.completions[0].id, 'existing-completion');
  assert.equal(result.state.players[0].id, 'existing-player');
  assert.equal(populated.writes(), 0);
  const fresh = harness(null);
  const empty = fresh.core.loadAppState({ syncDerived: false, persistSync: false });
  assert.equal(empty.state.tasks.length, 0);
  assert.equal(fresh.writes(), 0);
});
