const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'rankings_tournament_trophies.js'), 'utf8');
const loaderSource = fs.readFileSync(path.resolve(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

function makeState() {
  return {
    players: [
      { id: 'POPPY', name: 'Poppy' },
      { id: 'CARL', name: 'Carl' },
      { id: 'RUE', name: 'Rue' }
    ],
    currentSeason: {
      id: 'season-3',
      championSummary: { championId: 'POPPY' }
    },
    seasonHistory: [
      { id: 'season-1', championId: 'POPPY' },
      { id: 'season-2', championSummary: { championId: 'POPPY' } },
      { id: 'season-3', championSummary: { championId: 'POPPY' } },
      { id: 'season-4', championId: 'RUE' },
      { id: 'season-5', championSummary: { championId: 'CARL' } },
      { id: 'season-6' }
    ]
  };
}

function makeContext(pathname = '/other.html') {
  const state = makeState();
  const context = vm.createContext({
    console,
    JSON,
    Map,
    Set,
    Math,
    Number,
    String,
    Array,
    Promise,
    location: { pathname },
    localStorage: { getItem: () => null },
    document: {
      readyState: 'complete',
      addEventListener: () => undefined,
      getElementById: () => null
    },
    setTimeout: () => 0,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      loadAppState: () => ({ state }),
      getSeasonChampionFromFinals: () => null,
      computeCanonicalRankings: () => []
    }
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context);
  return { context, state };
}

test('counts one trophy per unique all-time season tournament championship', () => {
  const { context, state } = makeContext();
  const api = context.TaskPointsRankingsTournamentTrophies;

  assert.equal(api.getTournamentWinCount('POPPY', state), 3);
  assert.equal(api.getTournamentWinCount('CARL', state), 1);
  assert.equal(api.getTournamentWinCount('RUE', state), 1);
  assert.equal(api.getTournamentWinCount('NONE', state), 0);
  assert.equal(api.decorateName('Poppy', 'POPPY', state), 'Poppy 🏆🏆🏆');
  assert.equal(api.decorateName('Carl', 'CARL', state), 'Carl 🏆');
  assert.equal(api.decorateName('Rue', 'RUE', state), 'Rue 🏆');
});

test('does not double-count the same season when currentSeason is also archived', () => {
  const { context, state } = makeContext();
  const counts = context.TaskPointsRankingsTournamentTrophies.buildChampionCounts(state);
  assert.equal(counts.get('POPPY'), 3);
});

test('falls back to finals-derived champion when no stored champion id exists', () => {
  const { context } = makeContext();
  context.TaskPointsCore.getSeasonChampionFromFinals = (season) => season?.id === 'season-x' ? { playerId: 'FINALS' } : null;
  const state = { currentSeason: null, seasonHistory: [{ id: 'season-x' }] };
  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('FINALS', state), 1);
});

test('can derive a champion directly from stored finals rows when the season summary is absent', () => {
  const { context } = makeContext();
  const state = {
    currentSeason: null,
    seasonHistory: [{
      id: 'season-finals-only',
      tournamentMatchupResults: [
        { roundId: 'finals', playerAId: 'CARL', playerBId: 'RUE', scoreA: 60, scoreB: 55, winnerId: 'CARL' },
        { roundId: 'finals', playerAId: 'CARL', playerBId: 'RUE', scoreA: 58, scoreB: 54, winnerId: 'CARL' }
      ]
    }]
  };
  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('CARL', state), 1);
});

test('rankings row patch decorates the visible player name and leaves non-champions unchanged', () => {
  const { context } = makeContext('/rankings.html');
  const seenNames = [];
  context.renderRow = (player) => {
    seenNames.push(player.name);
    return player.name;
  };
  context.renderRankings = () => 'rendered';

  const api = context.TaskPointsRankingsTournamentTrophies;
  assert.equal(api.patchRankings(), true);
  context.renderRankings();

  assert.equal(context.renderRow({ id: 'POPPY', playerId: 'POPPY', name: 'Poppy' }), 'Poppy 🏆🏆🏆');
  assert.equal(context.renderRow({ id: 'CARL', playerId: 'CARL', name: 'Carl' }), 'Carl 🏆');
  assert.equal(context.renderRow({ id: 'NONE', playerId: 'NONE', name: 'Nobody' }), 'Nobody');
  assert.deepEqual(seenNames, ['Poppy 🏆🏆🏆', 'Carl 🏆', 'Nobody']);
});

test('post-render DOM decoration fixes names even when renderRow wrapping is bypassed', () => {
  const { context, state } = makeContext('/rankings.html');
  const poppyName = { textContent: 'Poppy' };
  const carlName = { textContent: 'Carl' };
  const otherName = { textContent: 'Nobody' };
  const row = (nameElement) => ({ querySelector: (selector) => selector === '.ranking-name' ? nameElement : null });
  const rows = [row(poppyName), row(carlName), row(otherName)];
  const list = {
    querySelectorAll: (selector) => selector === '.ranking-row' ? rows : []
  };

  context.document.getElementById = (id) => id === 'rankingsList' ? list : null;
  context.getScopedRankingsState = (candidate) => candidate;
  context.TaskPointsCore.computeCanonicalRankings = () => [
    { playerId: 'POPPY' },
    { playerId: 'CARL' },
    { playerId: 'NONE' }
  ];

  assert.equal(context.TaskPointsRankingsTournamentTrophies.decorateRankingsDom(state), true);
  assert.equal(poppyName.textContent, 'Poppy 🏆🏆🏆');
  assert.equal(carlName.textContent, 'Carl 🏆');
  assert.equal(otherName.textContent, 'Nobody');
});

test('trophy decoration is idempotent and never stacks duplicates on an already decorated name', () => {
  const { context, state } = makeContext();
  const api = context.TaskPointsRankingsTournamentTrophies;
  assert.equal(api.decorateName('Poppy 🏆🏆🏆', 'POPPY', state), 'Poppy 🏆🏆🏆');
  assert.equal(api.decorateName('Carl 🏆', 'CARL', state), 'Carl 🏆');
});

test('shared loader injects the trophy helper only on the Rankings page', () => {
  function runLoader(pathname) {
    const appended = [];
    const storage = new Map();
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
      Promise,
      location: { pathname },
      document,
      localStorage: {
        getItem: (key) => storage.get(String(key)) || null,
        setItem: (key, value) => storage.set(String(key), String(value))
      },
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
    return appended;
  }

  const rankingScripts = runLoader('/rankings.html')
    .filter((node) => node.src === 'rankings_tournament_trophies.js');
  const otherScripts = runLoader('/index.html')
    .filter((node) => node.src === 'rankings_tournament_trophies.js');

  assert.equal(rankingScripts.length, 1);
  assert.equal(rankingScripts[0].dataset.taskpointsRankingsTournamentTrophies, 'true');
  assert.equal(otherScripts.length, 0);
});
