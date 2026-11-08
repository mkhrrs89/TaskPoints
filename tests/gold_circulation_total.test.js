const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { calculate } = require('../gold_circulation_total.js');
const page = fs.readFileSync(path.join(root, 'gold_ledger.html'), 'utf8');

function state(ledger = []) {
  return {
    players: [
      { id: 'A', name: 'Current player', active: true },
      { id: 'B', name: 'Retired player', active: false }
    ],
    goldEconomy: { version: 1, launchDateKey: '2026-11-01' },
    goldLedger: ledger
  };
}

const row = (id, playerId, amount) => ({ id, playerId, amount });

test('circulation counts YOU, active, inactive, and roster-deleted wallets exactly once', () => {
  const input = state([
    row('open-a', 'A', 10),
    row('open-b', 'B', 3.7),
    row('open-old', 'DELETED-PLAYER', 1.2),
    row('open-you', 'YOU', 2.4),
    row('theft-out', 'B', -1.1),
    row('theft-in', 'A', 1.1),
    row('manual-plus', 'A', 5.3),
    row('manual-minus', 'YOU', -0.4)
  ]);
  const before = JSON.stringify(input);
  assert.deepEqual(calculate(input), { ok: true, total: 22.2, walletCount: 4 });
  assert.equal(JSON.stringify(input), before, 'rendering the total must never alter saved data');
});

test('a Gold theft transfers currency without changing the total', () => {
  const before = state([row('a', 'A', 40), row('b', 'B', 12)]);
  const after = state([...before.goldLedger,
    row('theft-winner', 'A', 2.3),
    row('theft-loser', 'B', -2.3)
  ]);
  assert.equal(calculate(before).total, 52);
  assert.equal(calculate(after).total, 52);
});

test('awards and manual credits increase circulation; removal decreases it', () => {
  const before = state([row('a', 'A', 40)]);
  const awarded = state([...before.goldLedger, row('bonus', 'A', 8.2)]);
  const removed = state([...awarded.goldLedger, row('manual', 'A', -11.3)]);
  assert.equal(calculate(before).total, 40);
  assert.equal(calculate(awarded).total, 48.2);
  assert.equal(calculate(removed).total, 36.9);
});

test('one-decimal math does not accumulate binary floating-point drift', () => {
  const input = state(Array.from({ length: 1000 }, (_, i) => row('credit-' + i, 'A', 0.1)));
  assert.equal(calculate(input).total, 100);
});

test('an initialized but empty ledger reports zero, including zero-balance players', () => {
  assert.deepEqual(calculate(state()), { ok: true, total: 0, walletCount: 3 });
});

test('an unreadable or incomplete ledger never claims there is zero Gold', () => {
  const bad = [
    {}, { players: [], goldEconomy: { version: 1 } },
    { players: [], goldEconomy: { version: 2 }, goldLedger: [] },
    state([row('invalid', '', 5)]),
    state([row('invalid', 'A', null)]),
    state([row('invalid', 'A', '')]),
    state([row('invalid', 'A', 'Infinity')]),
    state([row('invalid', 'A', 1.234)]),
    state([row('negative', 'A', -2)])
  ];
  for (const input of bad) {
    assert.equal(calculate(input).ok, false, JSON.stringify(input));
  }
});

test('Gold Ledger displays circulation prominently and refreshes it after manual adjustments', () => {
  assert.match(page, /Gold in Circulation/);
  assert.match(page, /id="goldCirculationTotal"/);
  assert.match(page, /id="goldCirculationContext"/);
  const helperIndex = page.indexOf('src="gold_circulation_total.js');
  const renderIndex = page.indexOf('function renderGoldCirculation()');
  assert.ok(helperIndex >= 0 && renderIndex > helperIndex, 'calculator must load before rendering');
  assert.match(page, /function renderBalances\(\) \{\s*renderGoldCirculation\(\)/);
  assert.match(page, /window\.addEventListener\('taskpoints:gold-manual-adjusted'/);
  const adjusted = page.split("window.addEventListener('taskpoints:gold-manual-adjusted'")[1];
  assert.match(adjusted, /renderBalances\(\)/);
  assert.match(page, /state\.goldLedger[\s\S]*?ids\.add\(id\)/,
    'wallets present only in historical Gold transactions must stay visible');
});

test('Gold Ledger clears the iPhone status bar and hides only its stray mobile Projects shortcut', () => {
  assert.ok(page.includes('@media (max-width:767px)'));
  assert.ok(page.includes('padding-top: max(76px, calc(env(safe-area-inset-top, 0px) + 16px))'));
  assert.ok(page.includes('.gold-shell .header-nav > a[href="projects.html"]'));
  assert.ok(page.includes('display: none !important;'));
  assert.ok(page.includes('<a href="projects.html" class="btn btn-teal btn-toolbar nav-btn">Projects</a>'),
    'the desktop Projects shortcut remains intact');
  assert.ok(page.includes('<script src="toolbar.js" defer></script>'),
    'the existing mobile navigation is retained');
});
