const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sources = ['scoring_core.js', 'greed_gold_economy.js', 'gold_season_interest.js']
  .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
const clone = value => JSON.parse(JSON.stringify(value));

function setup() {
  const data = new Map();
  const storage = {
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
    key(index) { return Array.from(data.keys())[index] ?? null; },
    get length() { return data.size; }
  };
  class SeasonDate extends Date {
    constructor(...args) {
      if (!args.length) super('2027-01-01T08:30:00');
      else super(...args);
    }
  }
  const context = {
    localStorage: storage,
    document: { readyState: 'loading', addEventListener() {} },
    location: { pathname: '/settings.html' },
    setTimeout() {}, clearTimeout() {}, addEventListener() {},
    console: { log() {}, warn() {}, error() {} },
    structuredClone: clone,
    Date: SeasonDate,
    JSON, Math, Array, Object, Map, Set, Promise
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const [name, source] of sources) vm.runInContext(source, context, { filename: name });
  const core = context.TaskPointsCore;
  const seed = core.normalizeState({
    youName: 'You',
    tasks: [{ id: 'task-keep', title: 'Keep this task' }],
    completions: [{ id: 'completion-keep', points: 6, dateKey: '2026-12-30' }],
    players: [{ id: 'A', name: 'Alpha', active: true, greed: 50 },
      { id: 'B', name: 'Beta', active: false, greed: 60 }],
    matchups: [],
    gameHistory: [],
    seasonHistory: [],
    goldEconomy: {
      version: 1, launchedAtISO: '2026-11-01T08:00:00.000Z',
      launchDateKey: '2026-11-01',
      ignoredSameDayMatchupKeys: [],
      settledMatchupKeys: [],
      ignoredChampionKeys: [],
      settledChampionKeys: []
    },
    goldLedger: [
      { id: 'opening-a', type: 'opening_balance', playerId: 'A', amount: 100,
        balanceAfter: 100, dateKey: '2026-11-01' },
      { id: 'opening-b', type: 'opening_balance', playerId: 'B', amount: 20,
        balanceAfter: 20, dateKey: '2026-11-01' },
      { id: 'opening-you', type: 'opening_balance', playerId: 'YOU', amount: 11.1,
        balanceAfter: 11.1, dateKey: '2026-11-01' },
      { id: 'opening-retired', type: 'opening_balance', playerId: 'RETIRED', amount: 2.5,
        balanceAfter: 2.5, dateKey: '2026-11-01' }
    ]
  });
  const saved = core.saveStateSnapshot(seed, { immediateWrite: true, savePath: 'season-interest-seed' });
  assert.ok(saved?.state);
  return { core, storage, api: context.TaskPointsGoldSeasonInterest };
}

test('rate setting and 2027 season interest survive real compressed TaskPoints storage and Gold reconciliation', () => {
  const h = setup();
  const before = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(h.core.getGoldBalance(before, 'A'), 100);
  assert.equal(h.api.saveRate('3').ratePercent, 3);
  assert.equal(h.core.loadAppState({ syncDerived: false, persistSync: false }).state.goldEconomy.interestRatePercent, 3);
  const p = h.api.preview('2027-01-01');
  assert.equal(p.recipientCount, 4);
  assert.equal(p.totalInterest, 4);
  h.api.decide('applied', p);
  const after = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(h.core.getGoldBalance(after, 'A'), 103);
  assert.equal(h.core.getGoldBalance(after, 'B'), 20.6);
  assert.equal(h.core.getGoldBalance(after, 'YOU'), 11.4);
  assert.equal(h.core.getGoldBalance(after, 'RETIRED'), 2.6);
  assert.equal(after.goldLedger.filter(row => row.type === 'season_interest').length, 4);
  assert.equal(after.goldEconomy.seasonInterestDecisions.length, 1);
  for (const field of ['tasks', 'completions', 'players', 'matchups', 'gameHistory', 'seasonHistory']) {
    assert.deepEqual(clone(after[field]), clone(before[field]), field + ' survives real save');
  }
  assert.equal(h.core.reconcileGoldEconomy(after).changed, false);
  assert.throws(() => h.api.preview('2027-01-01'), /already been decided/);
});

test('an older saved Home snapshot cannot reset the interest rate, awards or season decision', () => {
  const h = setup();
  const oldState = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  h.api.saveRate('3');
  h.api.decide('applied', h.api.preview('2027-01-01'));

  // This stale snapshot predates both the new interest rate and the seasonal
  // Gold award. Existing sticky ledger and decision protections must win.
  h.core.saveStateSnapshot(oldState, { immediateWrite: true, savePath: 'simulated-stale-home-tab' });
  const after = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(after.goldEconomy.interestRatePercent, 3);
  assert.equal(after.goldEconomy.seasonInterestDecisions[0].status, 'applied');
  assert.equal(h.core.getGoldBalance(after, 'A'), 103);
  assert.equal(after.goldLedger.filter(row => row.type === 'season_interest').length, 4);
});

test('real protected save blocks crediting interest under emergency recovery hold', () => {
  const h = setup();
  h.api.saveRate('3');
  const before = h.storage.getItem('taskpoints_v1');
  h.storage.setItem('taskpoints_emergency_recovery_hold_v1', JSON.stringify({ active: true }));
  assert.throws(() => h.api.preview('2027-01-01'), /Emergency Recovery/);
  assert.equal(h.storage.getItem('taskpoints_v1'), before);
});
