const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); },
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};
require('../scoring_core.js');
const core = global.TaskPointsCore;

function largeState() {
  const repeated = 'Repeated history payload that compresses extremely well. '.repeat(12);
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `row-${index}`,
    title: repeated,
    note: repeated,
    date: '2026-07-19',
    completedAtISO: '2026-07-19T12:00:00.000Z',
    points: 10
  }));
  return core.normalizeState({
    tasks: rows.map((row) => ({ ...row, id: `task-${row.id}` })),
    reminders: rows.map((row) => ({ ...row, id: `reminder-${row.id}` })),
    completions: rows.map((row) => ({ ...row, id: `completion-${row.id}`, taskId: 'task-row-1' })),
    players: rows.slice(0, 4).map((row) => ({ ...row, id: `player-${row.id}`, name: row.id })),
    habits: rows.slice(0, 5).map((row) => ({ ...row, id: `habit-${row.id}` })),
    gameHistory: rows.map((row) => ({ ...row, id: `game-${row.id}`, playerId: 'player-row-0' })),
    matchups: rows.map((row) => ({ ...row, id: `matchup-${row.id}`, playerAId: 'player-row-0', playerBId: 'player-row-1' })),
    seasonHistory: rows.map((row) => ({ ...row, id: `season-${row.id}` })),
    weightHistory: rows.map((row) => ({ ...row, id: `weight-${row.id}`, weight: 180 })),
    vo2MaxHistory: rows.map((row) => ({ ...row, id: `vo2-${row.id}`, vo2Max: 42 })),
    schedule: [], opponentDripSchedules: {}, flexActions: []
  });
}

const protectedFields = ['tasks', 'reminders', 'completions', 'players', 'habits', 'gameHistory', 'matchups', 'seasonHistory', 'weightHistory', 'vo2MaxHistory'];

test('optimized storage chooses and decodes compressed packed JSON without count loss', () => {
  const state = largeState();
  const plan = core.buildOptimizedTaskPointsStorageRaw(state);
  assert.equal(plan.chosenEncoding, 'lz16-packed-v1');
  assert.ok(plan.chosenRaw.length < plan.packedRawJson.length * 0.9);
  assert.equal(core.getTaskPointsStorageEncodingInfo(plan.chosenRaw).label, 'compressed packed JSON');
  const decoded = core.parseTaskPointsStorageJson(plan.chosenRaw, {});
  protectedFields.forEach((field) => assert.equal(decoded[field].length, state[field].length, `${field} count`));
});

test('stored-state reader supports compressed, packed, and plain JSON', () => {
  const state = largeState();
  const compressed = core.buildOptimizedTaskPointsStorageRaw(state).chosenRaw;
  storage.set(core.STORAGE_KEY, compressed);
  assert.equal(core.readTaskPointsStoredState(core.STORAGE_KEY, {}).completions.length, state.completions.length);

  storage.set(core.STORAGE_KEY, JSON.stringify(core.packTaskPointsStorageState(state)));
  assert.equal(core.readTaskPointsStoredState(core.STORAGE_KEY, {}).matchups.length, state.matchups.length);

  storage.set(core.STORAGE_KEY, JSON.stringify(state));
  assert.equal(core.readTaskPointsStoredState(core.STORAGE_KEY, {}).tasks.length, state.tasks.length);
});

test('saveStateSnapshot writes compressed storage and preserves protected histories', () => {
  storage.clear();
  const state = largeState();
  core.saveStateSnapshot(state, { storageKey: core.STORAGE_KEY, immediateWrite: true });
  const raw = storage.get(core.STORAGE_KEY);
  assert.equal(core.getTaskPointsStorageEncodingInfo(raw).label, 'compressed packed JSON');
  const saved = core.parseTaskPointsStorageJson(raw, {});
  protectedFields.forEach((field) => assert.equal(saved[field].length, state[field].length, `${field} was preserved`));
});

test('quota warning fallback is serialized through the optimized storage builder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.match(source, /const warningRaw = buildOptimizedTaskPointsStorageRaw\([\s\S]*?\)\.chosenRaw;/);
  assert.doesNotMatch(source, /safeReplaceTaskPointsStorage\(storageKey, JSON\.stringify\(packTaskPointsStorageState/);
});

test('TaskPoints storage uses compression and application readers do not directly parse taskpoints_v1 localStorage', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.doesNotMatch(source, /TASKPOINTS_ENABLE_COMPRESSED_STORAGE\s*=\s*false/);
  const files = fs.readdirSync(path.join(__dirname, '..')).filter((file) => /\.(?:js|html)$/.test(file) && file !== 'scoring_core.js');
  files.forEach((file) => {
    const contents = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(contents, /JSON\.parse\(\s*localStorage\.getItem\(\s*['"]taskpoints_v1['"]\s*\)\s*\)/, file);
  });
});
