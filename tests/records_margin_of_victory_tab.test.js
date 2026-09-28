const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'records_margin_of_victory_tab.js'), 'utf8');
const guardSource = fs.readFileSync(path.join(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

function installModule() {
  const document = {
    readyState: 'loading',
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
    head: { appendChild() {} }
  };
  const context = {
    document,
    location: { pathname: '/records.html' },
    localStorage: { getItem() { return null; } },
    TaskPointsCore: {},
    Date,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    JSON,
    Math,
    Promise,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(moduleSource, context, { filename: 'records_margin_of_victory_tab.js' });
  return context.TaskPointsMarginOfVictoryRecordsTab;
}

test('margin records rank finalized winning matchup margins and dedupe historical copies', () => {
  const api = installModule();
  const state = {
    youName: 'Miggy',
    players: [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'Gamma' }
    ],
    matchups: [
      { id: 'm1', dateKey: '2026-09-20', playerAId: 'a', playerBId: 'b', scoreA: 80, scoreB: 60 },
      { id: 'm2', dateKey: '2026-09-21', playerAId: 'b', playerBId: 'c', scoreA: 40, scoreB: 75 },
      { id: 'tie', dateKey: '2026-09-22', playerAId: 'a', playerBId: 'c', scoreA: 70, scoreB: 70 },
      { id: 'future', dateKey: '2026-09-28', playerAId: 'a', playerBId: 'c', scoreA: 90, scoreB: 1 }
    ],
    currentSeason: {
      tournamentMatchupResults: [
        { id: 'm3', dateKey: '2026-09-23', playerAId: 'YOU', playerBId: 'a', scoreA: 100, scoreB: 50, matchupType: 'tournament' }
      ]
    },
    seasonHistory: [
      {
        tournamentMatchupResults: [
          { id: 'm4', dateKey: '2026-09-19', playerAId: 'c', playerBId: 'a', scoreA: 70, scoreB: 68, matchupType: 'tournament' }
        ]
      }
    ],
    schedule: [
      {
        matchups: [
          { id: 'm1', dateKey: '2026-09-20', playerAId: 'a', playerBId: 'b', scoreA: 80, scoreB: 60 }
        ]
      }
    ]
  };

  const rows = api.buildMarginRows([state], { now: new Date('2026-09-27T12:00:00.000Z') });
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => [row.matchupId, row.margin, row.winnerId, row.loserId, row.winnerScore, row.loserScore]),
    [
      ['m3', 50, 'YOU', 'a', 100, 50],
      ['m2', 35, 'c', 'b', 75, 40],
      ['m1', 20, 'a', 'b', 80, 60],
      ['m4', 2, 'c', 'a', 70, 68]
    ]
  );
  assert.equal(rows[0].winnerName, 'Miggy');
  assert.equal(rows[1].winnerName, 'Gamma');
});

test('margin records UI mirrors the existing Records subtab structure', () => {
  assert.match(moduleSource, /button\.textContent = 'Margin of Victory'/);
  assert.match(moduleSource, /Largest Single-Game Margins of Victory/);
  assert.match(moduleSource, /class="glass mb-4 recordsControlsCard collapsed"/);
  assert.match(moduleSource, /class="recordsControlsToggle"/);
  assert.match(moduleSource, /marginRecordsSearchInput/);
  assert.match(moduleSource, /marginRecordsIncludeSelect/);
  assert.match(moduleSource, /marginRecordsTopSelect/);
  assert.match(moduleSource, /marginRecordsRefreshBtn/);
  assert.match(moduleSource, /marginRecordsCopyBtn/);
  assert.match(moduleSource, /<th class="scoreCell">Margin<\/th>/);
  assert.match(moduleSource, /<th class="playerCell">Winner<\/th>/);
  assert.match(moduleSource, /<th class="opponentCell">Opponent<\/th>/);
  assert.match(moduleSource, /<th class="finalScoreCell">Final Score<\/th>/);
  assert.match(moduleSource, /pill pill-orange/);
  assert.match(moduleSource, /pill pill-blue/);
});

test('margin record ranking uses canonical matchup scoreA and scoreB and excludes ties', () => {
  assert.match(moduleSource, /const scoreA = Number\(matchup\?\.scoreA\)/);
  assert.match(moduleSource, /const scoreB = Number\(matchup\?\.scoreB\)/);
  assert.match(moduleSource, /if \(scoreA === scoreB\) return/);
  assert.match(moduleSource, /const margin = Math\.abs\(scoreA - scoreB\)/);
  assert.match(moduleSource, /if \(!isRevealed\(date, now\)\) return/);
});

test('production Records loader includes the margin-of-victory extension only on Records', () => {
  assert.match(guardSource, /loadTaskPointsRecordsMarginOfVictoryTab/);
  const loaderStart = guardSource.indexOf('loadTaskPointsRecordsMarginOfVictoryTab');
  const loaderEnd = guardSource.indexOf('})(typeof window', loaderStart);
  const loader = guardSource.slice(loaderStart, loaderEnd);
  assert.match(loader, /\/\(\^\|\\\/\)records\(\?:\\\.html\)\?\$\/i\.test\(path\)/);
  assert.match(guardSource, /records_margin_of_victory_tab\.js\?v=20260927-1/);
  assert.match(guardSource, /data-taskpoints-records-margin-of-victory-tab/);
});
