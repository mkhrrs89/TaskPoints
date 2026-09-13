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
      championSummary: { championId: 'POPPY', championName: 'Poppy' }
    },
    seasonHistory: [
      { id: 'season-1', championId: 'POPPY', championName: 'Poppy' },
      {
        id: 'season-2',
        championSummary: { championName: 'Poppy' },
        finalPlacements: [
          { playerId: 'POPPY', playerName: 'Poppy', finish: 'Champion', finishTier: 0 },
          { playerId: 'RUE', playerName: 'Rue', finish: 'Runner-Up', finishTier: 1 }
        ]
      },
      { id: 'season-3', championSummary: { championId: 'POPPY', championName: 'Poppy' } },
      { id: 'season-4', championId: 'RUE', championName: 'Rue' },
      {
        id: 'season-5',
        championSummary: { championName: 'Carl' },
        finalPlacements: [
          { playerId: 'CARL', playerName: 'Carl', finish: 'Champion' }
        ]
      },
      { id: 'season-6' }
    ]
  };
}

function navLink(href, textContent) {
  const attrs = new Map([['href', href]]);
  return {
    textContent,
    getAttribute(name) { return attrs.get(String(name)) || null; },
    setAttribute(name, value) { attrs.set(String(name), String(value)); }
  };
}

function makeContext(pathname = '/other.html') {
  const state = makeState();
  const links = [];
  const context = vm.createContext({
    console,
    JSON,
    Map,
    Set,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    location: { pathname },
    localStorage: { getItem: () => null },
    document: {
      readyState: 'complete',
      documentElement: null,
      addEventListener: () => undefined,
      getElementById: () => null,
      querySelectorAll: (selector) => selector === 'a[href]' ? links : []
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
  return { context, state, links };
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

test('reads legacy finalized archive champion from finalPlacements when championId is absent', () => {
  const { context } = makeContext();
  const state = {
    players: [{ id: 'CARL', name: 'Carl' }, { id: 'POPPY', name: 'Poppy' }],
    currentSeason: null,
    seasonHistory: [
      {
        id: 'legacy-carl',
        championSummary: { championName: 'Carl', finalsResult: 'Carl defeats Poppy, 4–2' },
        finalPlacements: [
          { playerId: 'CARL', playerName: 'Carl', finish: 'Champion', finishTier: 0 },
          { playerId: 'POPPY', playerName: 'Poppy', finish: 'Runner-Up' }
        ]
      },
      {
        id: 'legacy-poppy',
        championSummary: { championName: 'Poppy' },
        tournamentStats: [
          { playerId: 'POPPY', playerName: 'Poppy', finish: 'Champion' }
        ]
      }
    ]
  };

  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('CARL', state), 1);
  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('POPPY', state), 1);
});

test('reads archived Finals winner when finalPlacements is absent', () => {
  const { context } = makeContext();
  const state = {
    players: [{ id: 'CARL', name: 'Carl' }],
    seasonHistory: [{
      id: 'archive-series',
      championSummary: { championName: 'Carl' },
      finalsSeries: { roundId: 'finals', winnerId: 'CARL', winnerName: 'Carl' }
    }]
  };
  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('CARL', state), 1);
});

test('does not double-count the same season when currentSeason is also archived', () => {
  const { context, state } = makeContext();
  const counts = context.TaskPointsRankingsTournamentTrophies.buildChampionCounts(state);
  assert.equal(counts.get('POPPY'), 3);
});

test('falls back to finals-derived champion when archived fields do not identify one', () => {
  const { context } = makeContext();
  context.TaskPointsCore.getSeasonChampionFromFinals = (season) => season?.id === 'season-x' ? { playerId: 'FINALS', playerName: 'Finals Player' } : null;
  const state = { currentSeason: null, seasonHistory: [{ id: 'season-x' }] };
  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('FINALS', state), 1);
});

test('can derive a champion directly from stored finals rows when summaries and archive placements are absent', () => {
  const { context } = makeContext();
  const state = {
    players: [{ id: 'CARL', name: 'Carl' }, { id: 'RUE', name: 'Rue' }],
    currentSeason: null,
    seasonHistory: [{
      id: 'season-finals-only',
      tournamentMatchupResults: [
        { roundId: 'finals', playerAId: 'CARL', playerAName: 'Carl', playerBId: 'RUE', playerBName: 'Rue', scoreA: 60, scoreB: 55, winnerId: 'CARL' },
        { roundId: 'finals', playerAId: 'CARL', playerAName: 'Carl', playerBId: 'RUE', playerBName: 'Rue', scoreA: 58, scoreB: 54, winnerId: 'CARL' }
      ]
    }]
  };
  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('CARL', state), 1);
});

test('post-render DOM decoration shows trophies for Poppy and Carl from archived season data', () => {
  const { context, state } = makeContext('/rankings.html');
  const poppyName = { textContent: 'Poppy' };
  const carlName = { textContent: 'Carl' };
  const otherName = { textContent: 'Nobody' };
  const row = (nameElement) => ({ querySelector: (selector) => selector === '.ranking-name' ? nameElement : null });
  const rows = [row(poppyName), row(carlName), row(otherName)];
  const list = { querySelectorAll: (selector) => selector === '.ranking-row' ? rows : [] };

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

test('name fallback still decorates a champion if an old archive only preserved championName', () => {
  const { context } = makeContext();
  const state = {
    players: [{ id: 'CARL', name: 'Carl' }],
    seasonHistory: [{ id: 'name-only', championSummary: { championName: 'Carl' } }]
  };
  assert.equal(context.TaskPointsRankingsTournamentTrophies.decorateName('Carl', 'CARL', state), 'Carl 🏆');
  assert.equal(context.TaskPointsRankingsTournamentTrophies.getTournamentWinCount('CARL', state), 1);
});

test('trophy decoration is idempotent and never stacks duplicates', () => {
  const { context, state } = makeContext();
  const api = context.TaskPointsRankingsTournamentTrophies;
  assert.equal(api.decorateName('Poppy 🏆🏆🏆', 'POPPY', state), 'Poppy 🏆🏆🏆');
  assert.equal(api.decorateName('Carl 🏆', 'CARL', state), 'Carl 🏆');
});

test('Rankings navigation label is renamed to Power Rankings on any page', () => {
  const { context, links } = makeContext('/index.html');
  links.push(navLink('rankings.html', 'Rankings'), navLink('standings.html', 'Standings'));
  context.TaskPointsRankingsTournamentTrophies.renameRankingsLinks();
  assert.equal(links[0].textContent, 'Power Rankings');
  assert.equal(links[1].textContent, 'Standings');
});

test('shared loader injects the helper globally so dynamically rendered navs can say Power Rankings', () => {
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

  for (const pathname of ['/rankings.html', '/index.html', '/game.html']) {
    const scripts = runLoader(pathname)
      .filter((node) => String(node.src || '').startsWith('rankings_tournament_trophies.js'));
    assert.equal(scripts.length, 1, pathname);
    assert.equal(scripts[0].src, 'rankings_tournament_trophies.js?v=20260913-3');
    assert.equal(scripts[0].dataset.taskpointsRankingsTournamentTrophies, 'true');
  }
});
