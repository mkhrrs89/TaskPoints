const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'season_champion_gold_bonus.js'), 'utf8');
const loaderSource = fs.readFileSync(path.resolve(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

function makeState() {
  return {
    matchups: [
      {
        id: 'season-3-game',
        dateKey: '2026-09-01',
        playerAId: 'A',
        playerBId: 'B',
        scoreA: 60,
        scoreB: 50,
        winnerId: 'A',
        loserId: 'B'
      }
    ],
    gameHistory: [
      {
        id: 'history-s2-a',
        matchupId: 'season-2-game',
        dateKey: '2026-07-10',
        playerId: 'A',
        opponentId: 'B',
        score: 55,
        winnerId: 'A',
        loserId: 'B'
      },
      {
        id: 'history-s2-b',
        matchupId: 'season-2-game',
        dateKey: '2026-07-10',
        playerId: 'B',
        opponentId: 'A',
        score: 50,
        winnerId: 'A',
        loserId: 'B'
      }
    ],
    currentSeason: {
      id: 'season-2',
      endDate: '2026-08-31',
      championSummary: { championId: 'A' }
    },
    seasonHistory: [
      {
        id: 'season-2',
        endDate: '2026-08-31',
        championSummary: { championId: 'A' },
        tournamentMatchupResults: [
          {
            id: 'season-2-final',
            dateKey: '2026-08-31',
            playerAId: 'A',
            playerBId: 'B',
            scoreA: 70,
            scoreB: 60,
            winnerId: 'A',
            loserId: 'B'
          }
        ]
      },
      { id: 'season-3', endDate: '2026-12-31', championId: 'A' },
      { id: 'season-1', endDate: '2026-06-30', championId: 'A' },
      { id: 'season-4', endDate: '2027-03-31', championId: 'B' }
    ]
  };
}

function makeContext(pathname = '/other.html') {
  const storage = new Map();
  const state = makeState();

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

test('reconstructs missing historical ranking matchups from gameHistory and archived tournament results', () => {
  const { context, state } = makeContext();
  const rows = context.TaskPointsSeasonChampionGoldBonus.collectCompleteRankingMatchups(state);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(rows.map((row) => row.id).sort())),
    ['season-2-final', 'season-2-game', 'season-3-game']
  );
});

test('cumulative matchup Gold includes every post-June season regardless of selected ranking scope', () => {
  const { context, state } = makeContext();
  assert.equal(
    context.TaskPointsSeasonChampionGoldBonus.getCumulativeMatchupGold('A', state, { todayKey: '2026-09-03' }),
    2.5
  );
  assert.equal(
    context.TaskPointsSeasonChampionGoldBonus.getCumulativeMatchupGold('B', state, { todayKey: '2026-09-03' }),
    0
  );
});

test('rankings state wrapper restores historical matchups before the page applies its scope', () => {
  const { context, state } = makeContext('/rankings.html');
  context.getScopedRankingsState = (candidate) => candidate;
  assert.equal(context.TaskPointsSeasonChampionGoldBonus.patchRankingsHistory(), true);
  const scoped = context.getScopedRankingsState(state);
  assert.equal(scoped.matchups.length, 3);
  assert.equal(scoped[context.TaskPointsSeasonChampionGoldBonus.ALL_MATCHUPS_KEY].length, 3);
});

test('rankings Gold carries all past matchup and championship Gold into a Season 3 view', () => {
  const { context, state } = makeContext('/rankings.html');
  context.getScopedRankingsState = (candidate) => ({
    ...candidate,
    matchups: (candidate.matchups || []).filter((row) => String(row.dateKey || '') >= '2026-09-01')
  });
  context.computeRankingExtrasForPlayer = () => ({ gold: 1, mov: 7, baseDelta: 1 });

  context.TaskPointsSeasonChampionGoldBonus.patchRankingsHistory();
  context.TaskPointsSeasonChampionGoldBonus.patchRankingsGold();

  const scoped = context.getScopedRankingsState(state);
  const result = context.computeRankingExtrasForPlayer({ id: 'A' }, { playerId: 'A' }, scoped);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { gold: 52.5, mov: 7, baseDelta: 1 });
});

test('rankings Gold remains cumulative even when the visible scope contains no Gold-era games', () => {
  const { context, state } = makeContext('/rankings.html');
  context.getScopedRankingsState = (candidate) => ({
    ...candidate,
    matchups: (candidate.matchups || []).filter((row) => String(row.dateKey || '') < '2026-07-01')
  });
  context.computeRankingExtrasForPlayer = () => ({ gold: 0, mov: 0, baseDelta: 0 });

  context.TaskPointsSeasonChampionGoldBonus.patchRankingsHistory();
  context.TaskPointsSeasonChampionGoldBonus.patchRankingsGold();

  const scoped = context.getScopedRankingsState(state);
  assert.equal(context.computeRankingExtrasForPlayer({ id: 'A' }, { playerId: 'A' }, scoped).gold, 52.5);
});

test('homepage Gold wrapper preserves cumulative matchup Gold and adds champion bonuses once', () => {
  const { context } = makeContext('/index.html');
  context.getHomepageGoldValue = () => 2.5;
  assert.equal(context.TaskPointsSeasonChampionGoldBonus.patchHomepageGold(), true);
  assert.equal(context.getHomepageGoldValue('A'), 52.5);
  assert.equal(context.formatHomepageGold('A'), 'Gold: 52.5');
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
  const championGoldScripts = appended.filter((node) => node.src === 'season_champion_gold_bonus.js');
  assert.equal(championGoldScripts.length, 1);
  assert.equal(championGoldScripts[0].dataset.taskpointsChampionGold, 'true');
});
