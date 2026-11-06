const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const goldCode = fs.readFileSync(path.join(root, 'greed_gold_economy.js'), 'utf8');
const gate = fs.readFileSync(path.join(root, 'mobile_boot_gate.js'), 'utf8');
const earlyBoot = fs.readFileSync(path.join(root, 'home_indexeddb_bootstrap.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, '_worker.js'), 'utf8');

function install() {
  const core = {};
  const sandbox = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    TaskPointsCore: core,
    localStorage: { getItem: () => null },
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [] },
    setTimeout() {},
    Date, JSON, Object, String, Number, Math, Set, Map, Array, RegExp, encodeURIComponent
  });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(goldCode, sandbox);
  return sandbox.TaskPointsGreedGoldEconomy;
}
const clone = value => JSON.parse(JSON.stringify(value));

test('batch Gold reconciliation matches individual settlement, including duplicates and champion credit', () => {
  const api = install();
  const priorRows = Array.from({ length: 500 }, (_, i) => ({
    id: 'historical-' + i,
    dateKey: '2026-10-11',
    playerAId: 'A', playerBId: 'B', scoreA: 51, scoreB: 49,
    goldOutcome: { settled: true, winnerId: 'A' }
  }));
  const newRows = Array.from({ length: 220 }, (_, i) => ({
    id: 'nov-' + String(i).padStart(3, '0'),
    dateKey: '2026-11-06',
    playerAId: i % 7 === 0 ? 'YOU' : i % 2 === 0 ? 'B' : 'A',
    playerBId: i % 7 === 0 ? 'A' : i % 2 === 0 ? 'A' : 'B',
    scoreA: i % 13 === 0 ? 50 : 57 + (i % 4),
    scoreB: 50,
    playerAEffects: { greedRating: 55 },
    playerBEffects: { greedRating: 35 }
  }));
  const base = {
    players: [{ id: 'A', greed: 60 }, { id: 'B', greed: 40 }],
    goldEconomy: {
      version: 1, launchDateKey: '2026-09-01',
      launchedAtISO: '2026-09-01T12:00:00Z',
      ignoredSameDayMatchupKeys: [], ignoredChampionKeys: [],
      settledChampionKeys: [], settledMatchupKeys: priorRows.map(row => 'id:' + row.id)
    },
    goldLedger: [
      { id: 'initial-A', playerId: 'A', type: 'opening_balance', amount: 900 },
      { id: 'initial-B', playerId: 'B', type: 'opening_balance', amount: 1300 }
    ],
    matchups: priorRows.concat(newRows),
    schedule: [{ date: '2026-11-06', matchups: [clone(newRows[6])] }],
    seasonHistory: [{
      id: 'season4', endDate: '2026-10-31', championId: 'B',
      tournamentMatchupResults: [clone(newRows[9])]
    }],
    gameHistory: []
  };
  const expected = clone(base);
  const actual = clone(base);

  for (const row of expected.matchups.slice(priorRows.length)) {
    assert.equal(api.settleOneMatchup(expected, row), true);
  }
  api.reconcileChampionBonuses(expected);

  const first = api.reconcileGoldEconomy(actual);
  assert.equal(first.changed, true);
  assert.deepEqual(clone(actual), expected, 'settlement, ledger order, Gold values and linked game results must match');
  for (const id of ['YOU', 'A', 'B']) {
    assert.equal(api.goldBalance(actual, id), api.goldBalance(expected, id));
  }

  const beforeSecondPass = clone(actual);
  assert.equal(api.reconcileGoldEconomy(actual).changed, false);
  assert.deepEqual(clone(actual), beforeSecondPass, 'second pass must never duplicate transactions');
});

test('mobile tap actually interrupts sequential animation without revealing an uninitialized page', () => {
  assert.match(gate, /window\.__tpSkipSequentialMatrix\(\)/);
  assert.match(earlyBoot, /global\.__tpSkipSequentialMatrix = \(\) =>/);
  assert.match(earlyBoot, /finishSequence\(\{ skipped: true \}\)/);
  assert.doesNotMatch(gate, /event\.stopImmediatePropagation\(\)/);
  assert.match(gate, /if \(revealed \|\| !revealOptions \|\| !runtimeReady\) return/);
  assert.match(gate, /titleEl\.style\.display = 'none'/);
  assert.match(gate, /Loading your saved data/);
  assert.match(home, /id="bootSplash"/);
});

test('Home scoring bundle is preloaded and replayed from exactly the same versioned endpoint', () => {
  assert.match(gate, /preload" href="\/scoring_core\.js"/);
  assert.match(home, /<script src="\/scoring_core\.js"><\/script>/);
  assert.match(worker, /getCoreBundleVersion\(env, request\)/);
  assert.match(worker, /redirectToCurrentCoreBundle\(request, version\)/);
  assert.match(worker, /CORE_BUNDLE_BROWSER_MAX_AGE/);
});
