const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('greed_gold_economy.js', 'utf8');

function stateWithGold(youGold = 0) {
  return {
    players: [],
    matchups: [],
    gameHistory: [],
    seasonHistory: [],
    currentSeason: null,
    goldEconomy: {
      version: 1,
      launchedAtISO: '2026-09-03T12:00:00.000Z',
      launchDateKey: '2026-09-03',
      ignoredSameDayMatchupKeys: [],
      settledMatchupKeys: [],
      ignoredChampionKeys: [],
      settledChampionKeys: []
    },
    goldLedger: youGold ? [{
      id: 'opening-you',
      type: 'opening_balance',
      playerId: 'YOU',
      amount: youGold,
      balanceAfter: youGold,
      dateKey: '2026-09-03',
      createdAtISO: '2026-09-03T12:00:00.000Z'
    }] : []
  };
}

function makeHarness({ liveState = null, storedState = stateWithGold(3) } = {}) {
  let canonical = structuredClone(storedState);
  let loadCalls = 0;
  let saveCalls = 0;
  const storage = new Map([
    ['taskpoints_v1', JSON.stringify(canonical)],
    ['taskpoints_state_revision_v1', 'r1']
  ]);
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    parseTaskPointsStorageJson(raw, fallback) {
      try { return JSON.parse(raw); } catch (_) { return fallback; }
    },
    loadAppState(options = {}) {
      loadCalls += 1;
      return { state: structuredClone(canonical), options };
    },
    saveStateSnapshot(state) {
      saveCalls += 1;
      canonical = structuredClone(state);
      localStorage.setItem('taskpoints_v1', JSON.stringify(canonical));
      return { state };
    },
    mergeAndSaveState(state) { return { state }; },
    saveAppState(state) { return { state }; }
  };
  const document = {
    readyState: 'complete',
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return {}; }
  };
  const context = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    RegExp,
    encodeURIComponent,
    structuredClone,
    setTimeout() { return 0; },
    clearTimeout() {},
    localStorage,
    document,
    TaskPointsCore: core,
    getHomepageGoldValue() { return -1; }
  };
  if (liveState !== null) {
    context.TaskPointsHomeLiveState = { getState: () => liveState };
  }
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'greed_gold_economy.js' });
  return {
    context,
    core: context.TaskPointsCore,
    get loadCalls() { return loadCalls; },
    get saveCalls() { return saveCalls; },
    setRevision(value) { localStorage.setItem('taskpoints_state_revision_v1', value); }
  };
}

test('Home Gold display reads use Home live state without full-state loads even across revisions', () => {
  const live = stateWithGold(12.5);
  const h = makeHarness({ liveState: live, storedState: stateWithGold(3) });

  assert.equal(h.context.getHomepageGoldValue('YOU'), 12.5);
  h.setRevision('r2');
  assert.equal(h.context.getHomepageGoldValue('YOU'), 12.5);
  h.setRevision('r3');
  assert.equal(h.context.getHomepageGoldValue('YOU'), 12.5);
  assert.equal(h.loadCalls, 0, 'display-only Home Gold reads must not reload the full persisted state');
  assert.equal(h.saveCalls, 0);
});

test('Gold display retains persisted-state fallback when Home live state is unavailable', () => {
  const h = makeHarness({ storedState: stateWithGold(7.5) });
  assert.equal(h.context.getHomepageGoldValue('YOU'), 7.5);
  assert.equal(h.loadCalls, 1);
});

test('uninitialized Home live state falls back so Greed Gold initialization behavior is preserved', () => {
  const h = makeHarness({ liveState: { players: [], goldLedger: [] }, storedState: stateWithGold(4) });
  assert.equal(h.context.getHomepageGoldValue('YOU'), 4);
  assert.equal(h.loadCalls, 1);
});
