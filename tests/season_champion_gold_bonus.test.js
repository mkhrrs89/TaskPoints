const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'season_champion_gold_bonus.js'), 'utf8');
const loaderSource = fs.readFileSync(path.resolve(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

function makeContext(pathname = '/other.html') {
  const storage = new Map();
  const state = {
    currentSeason: {
      id: 'season-2',
      endDate: '2026-08-31',
      championSummary: { championId: 'A' }
    },
    seasonHistory: [
      { id: 'season-2', endDate: '2026-08-31', championSummary: { championId: 'A' } },
      { id: 'season-3', endDate: '2026-12-31', championId: 'A' },
      { id: 'season-1', endDate: '2026-06-30', championId: 'A' },
      { id: 'season-4', endDate: '2027-03-31', championId: 'B' }
    ]
  };

  const localStorage = {
    getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key))
  };

  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    JSON,
    Map,
    Set,
    location: { pathname },
    document: { readyState: 'complete', getElementById: () => null },
    localStorage,
    setTimeout: () => 0,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      loadAppState: () => ({ state }),
      getSeasonChampionFromFinals: () => null
    }
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context);
  return { context, state };
}

test('awards 25 Gold once per unique post-June championship', () => {
  const { context, state } = makeContext();
  assert.equal(context.TaskPointsCore.getTournamentChampionGoldBonus('A', state), 50);
  assert.equal(context.TaskPointsCore.getTournamentChampionGoldBonus('B', state), 25);
  assert.equal(context.TaskPointsCore.getTournamentChampionGoldBonus('C', state), 0);
});

test('homepage Gold wrapper adds the champion bonus once', () => {
  const { context } = makeContext('/index.html');
  context.getHomepageGoldValue = () => 2.5;
  assert.equal(context.TaskPointsSeasonChampionGoldBonus.patchHomepageGold(), true);
  assert.equal(context.getHomepageGoldValue('A'), 52.5);
  assert.equal(context.formatHomepageGold('A'), 'Gold: 52.5');
});

test('rankings Gold wrapper includes only championships allowed by the active scope', () => {
  const { context, state } = makeContext('/rankings.html');
  context.rankingsScopeAllowsDate = (dateKey) => dateKey >= '2027-01-01';
  context.computeRankingExtrasForPlayer = () => ({ gold: 4.2, mov: 7, baseDelta: 1 });
  assert.equal(context.TaskPointsSeasonChampionGoldBonus.patchRankingsGold(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.computeRankingExtrasForPlayer({ id: 'A' }, { playerId: 'A' }, state))),
    { gold: 4.2, mov: 7, baseDelta: 1 }
  );
});

test('Season 1 rankings scope excludes post-June champion bonuses', () => {
  const { context, state } = makeContext('/rankings.html');
  context.rankingsScopeAllowsDate = (dateKey) => dateKey < '2026-07-01';
  context.computeRankingExtrasForPlayer = () => ({ gold: 3, mov: 0, baseDelta: 0 });
  context.TaskPointsSeasonChampionGoldBonus.patchRankingsGold();
  assert.equal(context.computeRankingExtrasForPlayer({ id: 'A' }, { playerId: 'A' }, state).gold, 3);
});

test('shared scoring bundle loader requests the champion Gold module once', () => {
  const appended = [];
  const localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined
  };
  const document = {
    head: { appendChild: (node) => appended.push(node) },
    querySelector: () => null,
    createElement: () => ({ dataset: {} })
  };
  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    JSON,
    Map,
    Set,
    document,
    localStorage,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      PHASE4_STORAGE_MODE_KEY: 'taskpoints_phase4_storage_mode_v1',
      setPhase4StorageMode: (mode) => mode,
      getPhase4StorageMode: () => 'off'
    }
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(loaderSource, context);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, 'season_champion_gold_bonus.js');
  assert.equal(appended[0].dataset.taskpointsChampionGold, 'true');
});
