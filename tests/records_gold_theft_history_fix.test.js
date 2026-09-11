const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'records_gold_theft_history_fix.js'), 'utf8');

function loadApi() {
  const context = {
    console,
    Date,
    URL,
    setTimeout() { return 1; },
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener() {},
    document: {
      getElementById() { return null; },
      querySelectorAll() { return []; }
    },
    localStorage: { getItem() { return null; } }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.TaskPointsGoldTheftRecordsHistoryFix;
}

test('recovers older thefts from saved goldOutcome when ledger has only current-day rows', () => {
  const api = loadApi();
  const state = {
    players: [
      { id: 'old-winner', name: 'Old Winner', active: false },
      { id: 'old-loser', name: 'Old Loser', active: true },
      { id: 'today-winner', name: 'Today Winner', active: true }
    ],
    goldLedger: [
      { id: 'gain-today', transferId: 't-today', type: 'matchup_theft', playerId: 'today-winner', opponentId: 'old-loser', matchupId: 'm-today', dateKey: '2026-09-11', amount: 2.1 }
    ],
    matchups: [
      {
        id: 'm-old',
        dateKey: '2026-09-09',
        playerAId: 'old-winner',
        playerBId: 'old-loser',
        goldOutcome: { settled: true, winnerId: 'old-winner', loserId: 'old-loser', theftGoldStolen: 4.7, settledAtISO: '2026-09-09T14:00:00.000Z' }
      }
    ]
  };

  const rows = api.allTheftRows(state);
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => row.date).sort(), ['2026-09-09', '2026-09-11']);
  const old = rows.find(row => row.date === '2026-09-09');
  assert.equal(old.playerName, 'Old Winner');
  assert.equal(old.amount, 4.7);
});

test('ledger row wins and goldOutcome does not duplicate the same matchup', () => {
  const api = loadApi();
  const state = {
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    goldLedger: [
      { id: 'gain', transferId: 'transfer', type: 'matchup_theft', playerId: 'a', opponentId: 'b', matchupId: 'match-1', dateKey: '2026-09-10', amount: 3.2 }
    ],
    matchups: [
      { id: 'match-1', dateKey: '2026-09-10', playerAId: 'a', playerBId: 'b', goldOutcome: { settled: true, winnerId: 'a', loserId: 'b', theftGoldStolen: 3.2 } }
    ]
  };
  const rows = api.allTheftRows(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 3.2);
});

test('inactive status does not exclude historical theft records', () => {
  const api = loadApi();
  const rows = api.allTheftRows({
    players: [{ id: 'inactive', name: 'Inactive Player', active: false }, { id: 'b', name: 'B' }],
    goldLedger: [{ type: 'matchup_theft', playerId: 'inactive', opponentId: 'b', matchupId: 'm', dateKey: '2026-09-08', amount: 1.5 }]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].playerName, 'Inactive Player');
});

test('history reader rerenders immediately after its late install', () => {
  assert.match(source, /global\.setTimeout\(render, 0\);/);
  assert.match(source, /taskpoints:state-revision/);
  assert.match(source, /pageshow/);
});
