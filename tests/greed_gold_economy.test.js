const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'indexeddb_requalification_guard.js'), 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function install(initialState = {}) {
  let savedState = clone(initialState);
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    setPhase4StorageMode(mode) { return mode; },
    getPhase4StorageMode() { return 'off'; },
    parseTaskPointsStorageJson(raw, fallback) {
      try { return JSON.parse(raw); } catch (_) { return fallback; }
    },
    saveStateSnapshot(state) {
      savedState = clone(state);
      localStorage.setItem('taskpoints_v1', JSON.stringify(savedState));
      return { state };
    },
    loadAppState() { return { state: savedState }; },
    simulateAiScoreForPlayerCore(player, dateKey, options = {}) {
      options.context?.captureEffects?.({ intimidationApplied: false, poiseApplied: false });
      return Number(options.baseScore ?? player.baseScore ?? 50);
    },
    materializeSeasonSlateMatchupsForDate(state) { return { state, changed: false, materializedCount: 0 }; }
  };
  const document = {
    readyState: 'complete',
    head: { appendChild() {} },
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
