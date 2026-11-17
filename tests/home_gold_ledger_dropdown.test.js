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
    getGameDayKey: () => '2026-11-17',
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

test('popup reads authoritative Gold view even if Home boot state lacks transactions', () => {
  const ctx = setup({goldLedger:[],matchups:[]});
  ctx.window.TaskPointsGreedGoldEconomy = {getGoldLedgerViewState:()=>({
    goldEconomy:{version:1},goldLedger:[
      {id:'actual',playerId:'YOU',type:'season_interest',amount:2.5,dateKey:'2026-11-16'}
    ]
  })};
  const rows = ctx.buildHomePersonalGoldLedgerRows(ctx.getHomePersonalGoldLedgerSource());
  assert.deepEqual(Array.from(rows,r=>r.id), ['actual']);
  assert.equal(rows[0].amount,2.5);
  assert.doesNotMatch(ctx.buildHomePersonalGoldLedgerHtml(rows),/Historical winning margins/);
});

test('historical win margins are visible but not misrepresented as ledger entries', () => {
  const ctx=setup({goldEconomy:{version:1,launchDateKey:'2026-11-15'},goldLedger:[],matchups:[
    {id:'old-win',dateKey:'2026-11-14',playerAId:'YOU',playerBId:'X',scoreA:51,scoreB:28},
    {id:'loss',dateKey:'2026-11-13',playerAId:'YOU',playerBId:'X',scoreA:11,scoreB:28},
    {id:'invalid',dateKey:'2026-11-12',playerAId:'YOU',playerBId:'X',scoreA:null,scoreB:22},
    {id:'after-launch',dateKey:'2026-11-16',playerAId:'YOU',playerBId:'X',scoreA:61,scoreB:30},
    {id:'before-start',dateKey:'2026-06-30',playerAId:'YOU',playerBId:'X',scoreA:61,scoreB:30}
  ]});
  const before=JSON.stringify(ctx.state);
  const rows=ctx.buildHomePersonalGoldLedgerRows(ctx.state);
  assert.deepEqual(Array.from(rows,r=>r.id), ['historical:old-win']);
  assert.equal(rows[0].amount,2.3);
  assert.equal(rows[0].balanceAfter,undefined);
  const markup=ctx.buildHomePersonalGoldLedgerHtml(rows);
  assert.match(markup,/Historical win vs Alex/);
  assert.match(markup,/not separate transactions or extra Gold/);
  assert.doesNotMatch(markup,/Balance:/);
  assert.equal(JSON.stringify(ctx.state),before);
});

test('official Gold ledger always wins over legacy events without double counting', () => {
  const ctx=setup({goldEconomy:{version:1,launchDateKey:'2026-11-15'},
    goldLedger:[{id:'official',playerId:'YOU',amount:5,type:'manual_adjustment'}],
    matchups:[{id:'older',dateKey:'2026-11-10',playerAId:'YOU',playerBId:'X',scoreA:65,scoreB:20}]});
  const rows=ctx.buildHomePersonalGoldLedgerRows(ctx.state);
  assert.deepEqual(Array.from(rows,r=>r.id), ['official']);
  assert.doesNotMatch(ctx.buildHomePersonalGoldLedgerHtml(rows),/Historical winning margins/);
});

test('authoritative Greed accessor does not reconcile or write storage', () => {
  const src=fs.readFileSync(path.join(__dirname,'..','greed_gold_economy.js'),'utf8');
  const start=src.indexOf('function getGoldLedgerViewState()');
  const end=src.indexOf('function patchGoldDisplays()',start);
  assert.ok(start>0&&end>start);
  const getter=src.slice(start,end);
  assert.match(getter,/readStoredState\(\)/);
  assert.match(getter,/displayStateCache/);
  assert.doesNotMatch(getter,/reconcileGoldEconomy|saveStateSnapshot|mergeAndSaveState|loadCurrentState/);
  assert.match(src,/    getGoldLedgerViewState,/);
});
