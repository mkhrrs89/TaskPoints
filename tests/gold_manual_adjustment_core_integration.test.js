const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const files = ['scoring_core.js', 'greed_gold_economy.js', 'gold_manual_adjustment.js']
  .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
const snapshot = value => JSON.parse(JSON.stringify(value));

function setup() {
  const rows = new Map();
  const storage = {
    getItem(key) { return rows.has(String(key)) ? rows.get(String(key)) : null; },
    setItem(key, value) { rows.set(String(key), String(value)); },
    removeItem(key) { rows.delete(String(key)); },
    key(index) { return Array.from(rows.keys())[index] ?? null; },
    get length() { return rows.size; }
  };
  const context = {
    localStorage: storage,
    document: { readyState: 'loading', addEventListener() {} },
    location: { pathname: '/gold_ledger.html' },
    setTimeout() {}, clearTimeout() {}, addEventListener() {},
    console: { log() {}, warn() {}, error() {} },
    structuredClone: snapshot,
    crypto: { randomUUID: () => 'verified-core-integration-uuid' },
    JSON, Date, Math, Array, Object, Map, Set, Promise
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const [name, source] of files) vm.runInContext(source, context, { filename: name });
  const core = context.TaskPointsCore;
  const seed = core.normalizeState({
    youName: 'You',
    tasks: [{ id: 'protected-task', title: 'Keep this task' }],
    completions: [{ id: 'protected-completion', points: 5, dateKey: '2026-11-03' }],
    players: [{ id: 'A', name: 'Alpha', active: true, greed: 50 }],
    matchups: [],
    gameHistory: [],
    seasonHistory: [],
    goldEconomy: {
      version: 1,
      launchedAtISO: '2026-11-01T00:00:00.000Z',
      launchDateKey: '2026-11-01',
      ignoredSameDayMatchupKeys: [],
      settledMatchupKeys: [],
      ignoredChampionKeys: [],
      settledChampionKeys: []
    },
    goldLedger: [
      { id: 'gold:opening:A', type: 'opening_balance', playerId: 'A',
        amount: 12.3, balanceAfter: 12.3, dateKey: '2026-11-01' }
    ]
  });
  const saved = core.saveStateSnapshot(seed, { immediateWrite: true, savePath: 'integration-seed' });
  assert.ok(saved?.state, 'fixture must be saved using real TaskPoints storage');
  return { core, storage, api: context.TaskPointsManualGoldAdjustment };
}

test('manual Gold survives a real compressed/packed TaskPoints save, reload and Greed reconciliation', () => {
  const h = setup();
  const before = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(h.core.getGoldBalance(before, 'A'), 12.3);
  const input = { playerId: 'A', mode: 'set', amount: '50.0', note: 'Commissioner adjustment' };
  const confirmed = h.api.preview(input);
  const result = h.api.commit(input, confirmed);
  assert.equal(result.balance, 50);
  const after = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(h.core.getGoldBalance(after, 'A'), 50);
  assert.equal(after.goldLedger.length, before.goldLedger.length + 1);
  assert.equal(after.goldLedger.at(-1).amount, 37.7);
  assert.equal(after.goldLedger.at(-1).balanceAfter, 50);
  assert.equal(after.goldLedger.at(-1).type, 'manual_adjustment');
  for (const field of ['tasks', 'completions', 'players', 'matchups', 'gameHistory', 'seasonHistory']) {
    assert.deepEqual(snapshot(after[field]), snapshot(before[field]), field + ' persisted unchanged');
  }
  const ids = after.goldLedger.map(row => row.id);
  assert.ok(ids.includes('gold:opening:A'));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(h.core.reconcileGoldEconomy(after).changed, false);
});

test('real save with recovery hold prevents manual Gold from being committed', () => {
  const h = setup();
  const input = { playerId: 'A', mode: 'add', amount: '5' };
  const before = h.storage.getItem('taskpoints_v1');
  h.storage.setItem('taskpoints_emergency_recovery_hold_v1', JSON.stringify({ active: true }));
  assert.throws(() => h.api.preview(input), /Recovery is active/);
  assert.equal(h.storage.getItem('taskpoints_v1'), before);
});
