const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'greed_gold_economy.js'), 'utf8');
const workerSource = fs.readFileSync(path.resolve(__dirname, '..', '_worker.js'), 'utf8');
const ledgerPageSource = fs.readFileSync(path.resolve(__dirname, '..', 'gold_ledger.html'), 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function install(initialState = {}, coreOverrides = {}) {
  let savedState = clone(initialState);
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); }
  };
  localStorage.setItem('taskpoints_v1', JSON.stringify(savedState));
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    parseTaskPointsStorageJson(raw, fallback) {
      try { return JSON.parse(raw); } catch (_) { return fallback; }
    },
    saveStateSnapshot(state) {
      savedState = clone(state);
      localStorage.setItem('taskpoints_v1', JSON.stringify(savedState));
      return { state };
    },
    mergeAndSaveState(state) {
      savedState = clone(state);
      localStorage.setItem('taskpoints_v1', JSON.stringify(savedState));
      return { state };
    },
    saveAppState(state) {
      savedState = clone(state);
      localStorage.setItem('taskpoints_v1', JSON.stringify(savedState));
      return { state };
    },
    loadAppState() { return { state: clone(savedState) }; },
    simulateAiScoreForPlayerCore(player, dateKey, options = {}) {
      options.context?.captureEffects?.({ intimidationApplied: false, poiseApplied: false });
      return Number(options.baseScore ?? player.baseScore ?? 50);
    },
    materializeSeasonSlateMatchupsForDate(state) { return { state, changed: false, materializedCount: 0 }; },
    ...coreOverrides
  };
  const document = {
    readyState: 'complete',
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { dataset: {} }; },
    addEventListener() {}
  };
  const context = vm.createContext({
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    RegExp,
    encodeURIComponent,
    setTimeout() {},
    clearTimeout() {},
    localStorage,
    document,
    TaskPointsCore: core
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context);
  return {
    context,
    core: context.TaskPointsCore,
    api: context.TaskPointsGreedGoldEconomy,
    getSaved: () => clone(savedState)
  };
}

function ledgerState(players, balances) {
  const goldLedger = [];
  Object.entries(balances).forEach(([playerId, amount], index) => {
    if (!amount) return;
    goldLedger.push({
      id: `opening-${index}`,
      type: 'opening_balance',
      playerId,
      amount,
      balanceAfter: amount,
      dateKey: '2026-09-03',
      createdAtISO: '2026-09-03T12:00:00.000Z'
    });
  });
  return {
    players,
    goldLedger,
    goldEconomy: {
      version: 1,
      launchedAtISO: '2026-09-03T12:00:00.000Z',
      launchDateKey: '2026-09-03',
      ignoredSameDayMatchupKeys: [],
      settledMatchupKeys: [],
      ignoredChampionKeys: [],
      settledChampionKeys: []
    },
    matchups: [],
    gameHistory: [],
    seasonHistory: []
  };
}

test('champion bonus is 30 going forward without rewriting settled historical awards', () => {
  const { api } = install();
  assert.equal(api.LEGACY_CHAMPION_BONUS, 25);
  assert.equal(api.CHAMPION_BONUS, 30);
  assert.equal(api.CHAMPION_BONUS_EFFECTIVE_DATE, '2026-09-28');
  assert.equal(api.championBonusForSeason({ endDate: '2026-09-27' }), 25);
  assert.equal(api.championBonusForSeason({ endDate: '2026-10-31' }), 30);

  const state = ledgerState([{ id: 'A', greed: 0, active: true }], {});
  state.goldLedger.push({
    id: 'gold:champion:old:A',
    type: 'champion_bonus',
    playerId: 'A',
    amount: 25,
    balanceAfter: 25,
    seasonId: 'old',
    dateKey: '2026-08-31'
  });
  state.goldEconomy.settledChampionKeys = ['old'];
  state.seasonHistory = [
    { id: 'old', endDate: '2026-08-31', championId: 'A' },
    { id: 'future', endDate: '2026-10-31', championId: 'A' }
  ];

  assert.equal(api.reconcileChampionBonuses(state), true);
  const championRows = state.goldLedger.filter((row) => row.type === 'champion_bonus');
  assert.deepEqual(championRows.map((row) => row.amount), [25, 30]);
  assert.equal(api.goldBalance(state, 'A'), 55);
});

test('Greed performance bonus multiplies GR by normalized opponent Gold', () => {
  const { api } = install();
  const state = ledgerState([
    { id: 'A', greed: 50, active: true },
    { id: 'B', greed: 25, active: true },
    { id: 'RICH', greed: 0, active: true },
    { id: 'RETIRED', greed: 100, active: false }
  ], { A: 10, B: 20, RICH: 40, RETIRED: 500, YOU: 1000 });

  assert.equal(api.richestActiveNpcGold(state), 40);
  assert.equal(api.opponentGoldRating(state, 'B'), 50);
  assert.equal(api.opponentGoldRating(state, 'RICH'), 100);
  assert.equal(api.opponentGoldRating(state, 'YOU'), 0);
  assert.equal(api.greedPerformance(state, state.players[0], state.players[2]).potentialBonus, 2.5);
  assert.equal(api.greedPerformance(state, state.players[0], state.players[1]).potentialBonus, 1.25);
});

test('zero opponent Gold nullifies Greed even at GR100', () => {
  const { api } = install();
  const state = ledgerState([
    { id: 'A', greed: 100, active: true },
    { id: 'B', greed: 0, active: true }
  ], {});
  const effect = api.greedPerformance(state, state.players[0], state.players[1]);
  assert.equal(effect.richestActiveNpcGold, 0);
  assert.equal(effect.opponentGoldRating, 0);
  assert.equal(effect.potentialBonus, 0);
});

test('YOU participates in theft at effective GR50 but never in performance boosts', () => {
  const { api } = install();
  const state = ledgerState([{ id: 'A', greed: 100, active: true }], { A: 20, YOU: 40 });
  assert.equal(api.effectiveTheftGreed(state, 'YOU'), 50);
  assert.equal(api.greedPerformance(state, { id: 'A', greed: 100 }, { id: 'YOU' }).eligible, false);
  assert.equal(api.greedPerformance(state, { id: 'YOU', greed: 50 }, { id: 'A' }).eligible, false);
});

test('GR100 winner keeps margin Gold and steals 10 percent without creating theft Gold', () => {
  const { api } = install();
  const state = ledgerState([
    { id: 'A', greed: 100, active: true },
    { id: 'B', greed: 0, active: true }
  ], { B: 20 });
  const matchup = {
    id: 'm1',
    dateKey: '2026-09-04',
    playerAId: 'A',
    playerBId: 'B',
    scoreA: 60,
    scoreB: 50,
    playerAEffects: { greedRating: 100 }
  };
  state.matchups.push(matchup);

  assert.equal(api.settleOneMatchup(state, matchup), true);
  assert.equal(api.goldBalance(state, 'A'), 3);
  assert.equal(api.goldBalance(state, 'B'), 18);
  const margin = state.goldLedger.find((row) => row.type === 'matchup_margin');
  const theftRows = state.goldLedger.filter((row) => row.type === 'matchup_theft');
  assert.equal(margin.amount, 1);
  assert.deepEqual(theftRows.map((row) => row.amount).sort((a, b) => a - b), [-2, 2]);
  assert.equal(theftRows.reduce((sum, row) => sum + row.amount, 0), 0);
  assert.equal(matchup.goldOutcome.theftGoldStolen, 2);
  assert.equal(matchup.goldOutcome.winnerEffectiveGreed, 100);

  const ledgerLength = state.goldLedger.length;
  assert.equal(api.settleOneMatchup(state, matchup), false);
  assert.equal(state.goldLedger.length, ledgerLength);
  assert.equal(api.goldBalance(state, 'A'), 3);
  assert.equal(api.goldBalance(state, 'B'), 18);
});

test('GR50 steals 5 percent and YOU also steals 5 percent', () => {
  const { api } = install();
  const npcState = ledgerState([
    { id: 'A', greed: 50, active: true },
    { id: 'B', greed: 0, active: true }
  ], { B: 20 });
  const npcGame = { id: 'npc', dateKey: '2026-09-04', playerAId: 'A', playerBId: 'B', scoreA: 51, scoreB: 50, playerAEffects: { greedRating: 50 } };
  npcState.matchups.push(npcGame);
  api.settleOneMatchup(npcState, npcGame);
  assert.equal(npcGame.goldOutcome.theftGoldStolen, 1);

  const youState = ledgerState([{ id: 'B', greed: 100, active: true }], { B: 20 });
  const youGame = { id: 'you', dateKey: '2026-09-04', playerAId: 'YOU', playerBId: 'B', scoreA: 51, scoreB: 50 };
  youState.matchups.push(youGame);
  api.settleOneMatchup(youState, youGame);
  assert.equal(youGame.goldOutcome.winnerEffectiveGreed, 50);
  assert.equal(youGame.goldOutcome.theftGoldStolen, 1);
});

test('theft rounds to one decimal and never overdrafts the loser', () => {
  const { api } = install();
  const state = ledgerState([
    { id: 'A', greed: 100, active: true },
    { id: 'B', greed: 0, active: true }
  ], { B: 13.7 });
  const matchup = { id: 'rounding', dateKey: '2026-09-04', playerAId: 'A', playerBId: 'B', scoreA: 55, scoreB: 50, playerAEffects: { greedRating: 100 } };
  state.matchups.push(matchup);
  api.settleOneMatchup(state, matchup);
  assert.equal(matchup.goldOutcome.theftGoldStolen, 1.4);
  assert.equal(api.goldBalance(state, 'B'), 12.3);
});

test('launch creates opening balances but does not backfill old or already-complete launch-day games', () => {
  const { api } = install();
  const state = {
    players: [{ id: 'A', greed: 100, active: true }, { id: 'B', greed: 0, active: true }],
    matchups: [
      { id: 'old', dateKey: '2026-09-02', playerAId: 'A', playerBId: 'B', scoreA: 60, scoreB: 50 },
      { id: 'same-day-before-launch', dateKey: '2026-09-03', playerAId: 'A', playerBId: 'B', scoreA: 70, scoreB: 50 }
    ],
    gameHistory: [],
    seasonHistory: []
  };
  const init = api.ensureGoldEconomy(state, { dateKey: '2026-09-03', nowISO: '2026-09-03T14:00:00.000Z' });
  assert.equal(init.initialized, true);
  assert.equal(api.goldBalance(state, 'A'), 1);
  assert.equal(state.goldLedger.filter((row) => row.type === 'opening_balance').length, 1);
  assert.equal(state.goldLedger.some((row) => row.type === 'matchup_margin'), false);
  assert.equal(api.settleOneMatchup(state, state.matchups[0]), false);
  assert.equal(api.settleOneMatchup(state, state.matchups[1]), false);
});

test('Greed score application gives max +5, scales continuously, and preserves the existing 85 cap', () => {
  const { api } = install();
  const state = ledgerState([
    { id: 'A', greed: 100, active: true },
    { id: 'B', greed: 0, active: true }
  ], { B: 40 });
  const matchup = { id: 'score', dateKey: '2026-09-04', playerAId: 'A', playerBId: 'B', scoreA: 50, scoreB: 50 };
  state.matchups.push(matchup);
  assert.equal(api.applyGreedToMatchup(state, matchup), true);
  assert.equal(matchup.scoreA, 55);
  assert.equal(matchup.playerAEffects.greedBonus, 5);
  assert.equal(matchup.playerAEffects.greedPotentialBonus, 5);

  const capped = { id: 'cap', dateKey: '2026-09-04', playerAId: 'A', playerBId: 'B', scoreA: 83, scoreB: 50 };
  state.matchups.push(capped);
  assert.equal(api.applyGreedToMatchup(state, capped), true);
  assert.equal(capped.scoreA, 85);
  assert.equal(capped.playerAEffects.greedBonus, 2);
  assert.equal(capped.playerAEffects.greedPotentialBonus, 5);
});

test('matchups involving YOU get zero Greed score bonus on both sides', () => {
  const { api } = install();
  const state = ledgerState([{ id: 'A', greed: 100, active: true }], { A: 40, YOU: 100 });
  const matchup = { id: 'you-score', dateKey: '2026-09-04', playerAId: 'A', playerBId: 'YOU', scoreA: 50, scoreB: 55 };
  state.matchups.push(matchup);
  assert.equal(api.applyGreedToMatchup(state, matchup), true);
  assert.equal(matchup.scoreA, 50);
  assert.equal(matchup.scoreB, 55);
  assert.equal(matchup.playerAEffects.greedPerformanceEligible, false);
  assert.equal(matchup.playerAEffects.greedBonus, 0);
});

test('settled theft remains permanent after later Greed edits', () => {
  const { api } = install();
  const state = ledgerState([
    { id: 'A', greed: 25, active: true },
    { id: 'B', greed: 0, active: true }
  ], { B: 40 });
  const matchup = { id: 'permanent', dateKey: '2026-09-04', playerAId: 'A', playerBId: 'B', scoreA: 51, scoreB: 50, playerAEffects: { greedRating: 25 } };
  state.matchups.push(matchup);
  api.settleOneMatchup(state, matchup);
  assert.equal(matchup.goldOutcome.theftGoldStolen, 1);
  state.players[0].greed = 100;
  api.reconcileGoldEconomy(state);
  assert.equal(matchup.goldOutcome.theftGoldStolen, 1);
  assert.equal(api.goldBalance(state, 'B'), 39);
});

test('season materialization applies Greed before deciding winner, margin Gold, and theft', () => {
  const state = ledgerState([
    { id: 'A', name: 'Alpha', greed: 100, active: true },
    { id: 'B', name: 'Beta', greed: 0, active: true }
  ], { B: 40 });

  const { core, api } = install(state, {
    materializeSeasonSlateMatchupsForDate(nextState, dateKey) {
      nextState.matchups.push({
        id: 'materialized',
        dateKey,
        playerAId: 'A',
        playerBId: 'B',
        scoreA: 50,
        scoreB: 52,
        playerAScore: 50,
        playerBScore: 52,
        completedAtISO: `${dateKey}T12:00:00.000Z`
      });
      return { state: nextState, changed: true, materializedCount: 1 };
    }
  });

  const result = core.materializeSeasonSlateMatchupsForDate(state, '2026-09-04', { nowISO: '2026-09-04T12:00:00.000Z' });
  const matchup = result.state.matchups[0];
  assert.equal(matchup.scoreA, 55);
  assert.equal(matchup.scoreB, 52);
  assert.equal(matchup.winnerId, 'A');
  assert.equal(matchup.goldOutcome.winnerId, 'A');
  assert.equal(matchup.goldOutcome.marginGoldAwarded, 0.3);
  assert.equal(matchup.goldOutcome.theftGoldStolen, 4);
  assert.equal(api.goldBalance(result.state, 'A'), 4.3);
  assert.equal(api.goldBalance(result.state, 'B'), 36);
});

test('partial page saves preserve the established Gold ledger', () => {
  const initial = ledgerState([{ id: 'A', greed: 50, active: true }], { A: 12.5 });
  const { core, getSaved } = install(initial);
  core.mergeAndSaveState({ players: initial.players, matchups: [], gameHistory: [] }, { savePath: 'partial-page' });
  const saved = getSaved();
  assert.equal(saved.goldEconomy.version, 1);
  assert.equal(saved.goldLedger.length, 1);
  assert.equal(saved.goldLedger[0].amount, 12.5);
});

test('matchup telemetry explains Greed bonus and Gold outcome after completion', () => {
  const { api } = install({ players: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }] });
  const matchup = {
    playerAId: 'A',
    playerBId: 'B',
    playerAEffects: { greedTelemetryVersion: 1, greedPerformanceEligible: true, greedBonus: 2.5, greedRating: 50, opponentGoldRating: 100 },
    playerBEffects: { greedTelemetryVersion: 1, greedPerformanceEligible: true, greedBonus: 0, greedRating: 0, opponentGoldRating: 50 },
    goldOutcome: { settled: true, winnerId: 'A', marginGoldAwarded: 1.2, theftGoldStolen: 2.4 }
  };
  const detail = api.formatMatchupGreedDetails(matchup);
  assert.match(detail, /Greed \+2\.5 \(GR 50, OG 100\)/);
  assert.match(detail, /Gold: .*\+1\.2 margin Gold.*stole 2\.4 Gold/);
});

test('Gold Ledger page exposes balances and transaction filters without historical backfill', () => {
  assert.match(ledgerPageSource, /<title>TaskPoints — Gold Ledger<\/title>/);
  assert.match(ledgerPageSource, /id="goldBalances"/);
  assert.match(ledgerPageSource, /id="playerFilter"/);
  assert.match(ledgerPageSource, /id="typeFilter"/);
  assert.match(ledgerPageSource, /Historical activity before launch is condensed into a legacy-rule opening balance/);
  assert.match(ledgerPageSource, /<script src="scoring_core\.js"><\/script>/);
});

test('Cloudflare core bundle includes Greed Gold runtime last with a diagnostic header', () => {
  assert.match(workerSource, /'\/greed_gold_economy\.js'/);
  assert.match(workerSource, /storageIdleSource, greedGoldSource\]\.filter\(Boolean\)/);
  assert.match(workerSource, /x-taskpoints-greed-gold-economy/);
});

test('orphaned Gold transactions are not erased by accidental economy reinitialization', () => {
  const { api } = install();
  const state = {
    players: [{id:'A',greed:100},{id:'B',greed:50}],
    goldLedger: [{id:'saved-theft',type:'matchup_theft',playerId:'A',opponentId:'B',amount:12,dateKey:'2026-10-01'}],
    matchups: [], gameHistory:[], seasonHistory:[]
  };
  const before = clone(state.goldLedger);
  const result = api.reconcileGoldEconomy(state, {dateKey:'2026-11-05'});
  assert.equal(result.blocked, true);
  assert.deepEqual(state.goldLedger, before);
  assert.equal(state.goldEconomy, undefined);
});

test('established economy without readable ledger is blocked, not silently reset', () => {
  const { api } = install();
  const state = {goldEconomy:{version:1,launchedAtISO:'2026-09-01T08:00:00Z',launchDateKey:'2026-09-01'},players:[],matchups:[],gameHistory:[],seasonHistory:[]};
  const result = api.reconcileGoldEconomy(state, {dateKey:'2026-11-05'});
  assert.equal(result.blocked, true);
  assert.equal(state.goldLedger, undefined);
  assert.equal(state.goldEconomy.launchDateKey, '2026-09-01');
});

test('Gold transactions and settlement keys are protected by verified snapshot save', () => {
  const source = fs.readFileSync(path.resolve(__dirname,'..','scoring_core.js'),'utf8');
  assert.match(source, /options\.allowGoldLedgerReset !== true/);
  assert.match(source, /const ledgerWouldShrink = savedLedger\.some/);
  assert.match(source, /next\.goldLedger = savedLedger/);
  assert.match(source, /'settledMatchupKeys', 'ignoredChampionKeys'/);
  assert.match(source, /const criticalArrays = \[[^\n]*'goldLedger'/);
});

test('both missing Gold ledger AND metadata cannot reset a previously settled Gold economy',()=>{
 const {api}=install();
 const state={
   players:[{id:'A',greed:100},{id:'B',greed:100}],
   matchups:[{id:'old',dateKey:'2026-11-03',playerAId:'A',playerBId:'B',
     scoreA:60,scoreB:50,
     goldOutcome:{settled:true,winnerId:'A',loserId:'B',theftGoldStolen:2}}],
   gameHistory:[],seasonHistory:[]
 };
 const before=clone(state);
 const result=api.reconcileGoldEconomy(state,{dateKey:'2026-11-05'});
 assert.equal(result.blocked,true);
 assert.deepEqual(state,before,'neither a new economy nor a new ledger may be synthesized');
});

test('Gold reconciliation skips long settled history without recopying settled keys per game', () => {
  const { api, context } = install();
  const oldRows = Array.from({ length: 1200 }, (_, index) => ({
    id: 'old-' + index,
    dateKey: '2026-10-11',
    playerAId: 'A',
    playerBId: 'B',
    scoreA: 70,
    scoreB: 50
  }));
  const state = ledgerState([
    { id: 'A', greed: 50, active: true },
    { id: 'B', greed: 50, active: true }
  ], { A: 1000, B: 1000 });
  state.goldEconomy.settledMatchupKeys = oldRows.map(row => 'id:' + row.id);
  state.matchups = oldRows.concat([{
    id: 'new-gold-result',
    dateKey: '2026-11-06',
    playerAId: 'A',
    playerBId: 'B',
    scoreA: 70,
    scoreB: 50
  }]);

  // Count expensive Set snapshots rather than using a flaky wall-clock limit.
  // A large historical Set may be built for the one genuinely new match,
  // but not once for every one of the 1,200 already-settled matches.
  const OriginalSet = context.Set;
  let fullHistorySnapshots = 0;
  context.Set = class ObservedSet extends OriginalSet {
    constructor(values) {
      super(values);
      if (Array.isArray(values) && values.length >= 1200
        && String(values[0]) === 'id:old-0') fullHistorySnapshots += 1;
    }
  };
  try {
    const result = api.reconcileGoldEconomy(state);
    assert.equal(result.changed, true);
    assert.equal(state.goldEconomy.settledMatchupKeys.length, 1201);
    assert.equal(state.goldLedger.filter(row => row.type === 'matchup_margin').length, 1);
    assert.equal(state.goldLedger.filter(row => row.type === 'matchup_theft').length, 2);
    assert.equal(state.goldLedger.filter(row => row.type === 'opening_balance').length, 2);

    const afterFirst = clone(state);
    const again = api.reconcileGoldEconomy(state);
    assert.equal(again.changed, false, 'settled matches must not be replayed');
    assert.equal(JSON.stringify(state), JSON.stringify(afterFirst), 'repeat reconciliation must not mutate balances or history');
    assert.ok(fullHistorySnapshots <= 10,
      `already settled history must not trigger quadratic reprocessing (created ${fullHistorySnapshots} full-history sets)`);
  } finally {
    context.Set = OriginalSet;
  }
});
