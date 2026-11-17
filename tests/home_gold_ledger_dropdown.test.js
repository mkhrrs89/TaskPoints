const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const start = html.indexOf('/* HOME_PERSONAL_GOLD_LEDGER_BEGIN */');
const end = html.indexOf('/* HOME_PERSONAL_GOLD_LEDGER_END */', start);
assert.ok(start > 0 && end > start, 'read-only Home Gold ledger module exists');
const source = html.slice(start, end);

function setup(candidateState) {
  const context = vm.createContext({
    state: candidateState,
    window: { innerWidth: 390, innerHeight: 800 },
    document: { getElementById: () => null, documentElement: {}, addEventListener() {} },
    getPlayerNameById: id => ({ X: 'Alex', OTHER: 'Other' }[id] || id),
    formatRecentMatchupDate: key => String(key).slice(0, 10),
    escapeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'),
    Map, String, Number, Math, Array, Date
  });
  vm.runInContext(source, context);
  return context;
}
function transactions() {
  const out = [];
  for (let i = 0; i < 17; i++) {
    out.push({
      id: 'tx-' + i, playerId: 'YOU', opponentId: 'X',
      dateKey: '2026-11-' + String(17 - i).padStart(2, '0'),
      createdAtISO: '2026-11-' + String(17 - i).padStart(2, '0') + 'T12:00:00.000Z',
      type: i % 2 ? 'matchup_theft' : 'matchup_margin',
      amount: i % 2 ? -1.2 : 2.3, balanceAfter: 25 - i
    });
  }
  out.push({id:'another-wallet',playerId:'OTHER',amount:1000,createdAtISO:'2026-12-12T23:59:59Z'});
  out.push({id:'missing-player',amount:10});
  return out.reverse();
}

test('filters personal transactions and sorts newest-first without changing Gold', () => {
  const input = transactions();
  const unchanged = JSON.stringify(input);
  const context = setup({ goldLedger: input });
  const rows = context.buildHomePersonalGoldLedgerRows(context.state);
  assert.equal(rows.length, 17);
  assert.equal(rows[0].id, 'tx-0');
  assert.equal(rows[16].id, 'tx-16');
  assert.ok(rows.every(row => row.playerId === 'YOU'));
  assert.equal(JSON.stringify(input), unchanged, 'read-only list');
});

test('same-day transactions use time and ID ordering of full Gold Ledger', () => {
  const context = setup({goldLedger:[
    {id:'b',playerId:'YOU',createdAtISO:'2026-11-17T12:00:00Z'},
    {id:'a',playerId:'YOU',createdAtISO:'2026-11-17T12:00:00Z'},
    {id:'old',playerId:'YOU',createdAtISO:'2026-11-16T20:00:00Z'},
    {id:'other',playerId:'X',createdAtISO:'2026-11-19T20:00:00Z'}
  ]});
  assert.deepEqual(Array.from(context.buildHomePersonalGoldLedgerRows(context.state),row => row.id),['b','a','old']);
});

test('initial five transactions plus See more, then 10, 15 and all 17', () => {
  const context = setup({goldLedger: transactions()});
  const rows = context.buildHomePersonalGoldLedgerRows(context.state);
  const render = count => context.buildHomePersonalGoldLedgerHtml(rows, count);
  for (const count of [5, 10, 15, 20]) {
    assert.equal((render(count).match(/role="listitem"/g)||[]).length, Math.min(count,17));
  }
  assert.match(render(5), /data-home-gold-see-more/);
  assert.match(render(10), /data-home-gold-see-more/);
  assert.match(render(15), /data-home-gold-see-more/);
  assert.doesNotMatch(render(20), /data-home-gold-see-more/);
  assert.match(source, /homePersonalGoldLedgerShown \+ HOME_GOLD_LEDGER_PAGE_SIZE/);
  assert.match(source, /homePersonalGoldLedgerShown = HOME_GOLD_LEDGER_PAGE_SIZE/);
});

test('transaction types and signed amounts are readable; notes are escaped', () => {
  const context = setup({goldLedger:[
    {type:'season_interest',playerId:'YOU',amount:1.8,dateKey:'2026-11-13'},
    {type:'champion_bonus',playerId:'YOU',amount:30,dateKey:'2026-11-14'},
    {type:'manual_adjustment',playerId:'YOU',amount:-4,meta:{mode:'subtract',note:'<script>alert(1)</script>'}},
    {type:'matchup_theft',playerId:'YOU',opponentId:'X',amount:-1.2},
    {type:'opening_balance',playerId:'YOU',amount:20}
  ]});
  const markup = context.buildHomePersonalGoldLedgerHtml(
    context.buildHomePersonalGoldLedgerRows(context.state), 5);
  assert.match(markup, /Season interest/);
  assert.match(markup, /Championship bonus/);
  assert.match(markup, /Gold removed/);
  assert.match(markup, /Stolen by Alex/);
  assert.match(markup, /Opening balance/);
  assert.match(markup, /is-debit/);
  assert.match(markup, /is-credit/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(context.buildHomePersonalGoldLedgerHtml([]), /No Gold transactions/);
});

test('tap, keyboard and see-more preserve Yesterday’s Results and Gold storage', () => {
  assert.match(html, /id="homeYourGoldLedgerTrigger"[\s\S]*role="button"[\s\S]*tabindex="0"[\s\S]*aria-controls="homeYourGoldLedgerDropdown"/);
  assert.match(source, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(source, /closeYesterdayRecentResultsDropdown\(\)/);
  assert.match(html, /function openYesterdayRecentResultsDropdown\(\) \{[\s\S]*closeHomePersonalGoldLedgerDropdown\(\)/);
  assert.match(source, /event\.target\.closest\('\[data-home-gold-see-more\]'\)/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /window\.addEventListener\('scroll', scheduleHomePersonalGoldLedgerPosition/);
  assert.match(html, /bindHomePersonalGoldLedgerDropdown\(\)/);
  assert.doesNotMatch(source, /localStorage|saveStateSnapshot|mergeAndSaveState|reconcileGoldEconomy/);
});

test('same pop-down animation as Yesterday, anchored below scoreboard and above bottom bar', () => {
  assert.match(source, /'yesterday-recent-results-dropdown home-gold-ledger-dropdown'/);
  assert.match(css, /\.home-gold-ledger-row/);
  assert.match(css, /\.yesterday-recent-results-dropdown \{[\s\S]*?transform-origin: top center/);
  assert.match(css, /\.yesterday-recent-results-dropdown\.is-open/);
  assert.match(source, /window\.innerHeight - cardRect\.bottom - toolbarHeight/);
  assert.match(source, /dropdown\.style\.top = Math\.round\(cardRect\.bottom\)/);
});
