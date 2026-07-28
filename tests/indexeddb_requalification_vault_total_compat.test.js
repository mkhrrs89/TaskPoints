const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const loaderSource = fs.readFileSync(path.join(ROOT, 'indexeddb_requalification_loader.js'), 'utf8');
const codecSource = fs.readFileSync(path.join(ROOT, 'storage_health_codec.js'), 'utf8');

function loaderVaultKeys() {
  const block = loaderSource.match(/const vaultCountKeys = \[([\s\S]*?)\];/)?.[1] || '';
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function writerCounts(state) {
  const keys = [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders'
  ];
  const major = ['tasks', 'completions', 'habits', 'players', 'gameHistory', 'matchups', 'seasonHistory'];
  const counts = Object.fromEntries(keys.map((key) => [key, Array.isArray(state?.[key]) ? state[key].length : 0]));
  counts.total = keys.reduce((sum, key) => sum + counts[key], 0);
  counts.majorTotal = major.reduce((sum, key) => sum + counts[key], 0);
  return counts;
}

test('vault verification checks every writer-owned collection without comparing the incompatible derived total', () => {
  const keys = loaderVaultKeys();
  assert.deepEqual(keys, [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders',
    'majorTotal'
  ]);
  assert.equal(keys.includes('total'), false);
  assert.equal(keys.includes('weightHistory'), false);
  assert.equal(keys.includes('vo2MaxHistory'), false);
});

test('non-empty Weight and VO2 histories cannot create a false vault mismatch', () => {
  const state = {
    tasks: [{ id: 'task' }],
    completions: Array.from({ length: 40 }, (_, id) => ({ id })),
    habits: [{ id: 'habit' }],
    players: Array.from({ length: 12 }, (_, id) => ({ id })),
    flexActions: [{ id: 'flex' }],
    gameHistory: Array.from({ length: 20 }, (_, id) => ({ id })),
    matchups: Array.from({ length: 20 }, (_, id) => ({ id })),
    schedule: [{ id: 'schedule' }],
    seasonHistory: [{ id: 'season' }],
    reminders: [{ id: 'reminder' }],
    weightHistory: Array.from({ length: 3 }, (_, id) => ({ id })),
    vo2MaxHistory: Array.from({ length: 2 }, (_, id) => ({ id }))
  };
  const context = {};
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(codecSource, context, { filename: 'storage_health_codec.js' });

  const checklistCounts = context.TaskPointsStorageHealth.countsFor(state);
  const storedVaultCounts = writerCounts(state);
  assert.notEqual(checklistCounts.total, storedVaultCounts.total);
  assert.equal(checklistCounts.total - storedVaultCounts.total, 5);

  const keys = loaderVaultKeys();
  assert.equal(keys.every((key) => Number(checklistCounts[key] || 0) === Number(storedVaultCounts[key] || 0)), true);
});
