const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'gold_theft_top50_notifications.js'), 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseState() {
  return {
    players: [
      { id: 'A', name: 'Alpha', greed: 100 },
      { id: 'B', name: 'Beta', greed: 50 }
    ],
    goldEconomy: {
      version: 1,
      launchDateKey: '2026-09-01',
      settledMatchupKeys: ['id:m1'],
      ignoredSameDayMatchupKeys: [],
      settledChampionKeys: [],
      ignoredChampionKeys: []
    },
    goldLedger: [
      { id: 'open-a', type: 'opening_balance', playerId: 'A', amount: 10, dateKey: '2026-09-01', createdAtISO: '2026-09-01T08:00:00.000Z', balanceAfter: 10 },
      { id: 'open-b', type: 'opening_balance', playerId: 'B', amount: 20, dateKey: '2026-09-01', createdAtISO: '2026-09-01T08:00:00.000Z', balanceAfter: 20 },
      { id: 'margin-a', type: 'matchup_margin', playerId: 'A', opponentId: 'B', matchupId: 'm1', amount: 1, dateKey: '2026-09-10', createdAtISO: '2026-09-10T12:00:00.000Z', balanceAfter: 11 },
      { id: 'theft-b', type: 'matchup_theft', playerId: 'B', opponentId: 'A', matchupId: 'm1', amount: -2, dateKey: '2026-09-10', createdAtISO: '2026-09-10T12:00:00.000Z', balanceAfter: 18 },
      { id: 'theft-a', type: 'matchup_theft', playerId: 'A', opponentId: 'B', matchupId: 'm1', amount: 2, dateKey: '2026-09-10', createdAtISO: '2026-09-10T12:00:00.000Z', balanceAfter: 13 }
    ],
    matchups: [{
      id: 'm1',
      matchupId: 'm1',
      dateKey: '2026-09-10',
      playerAId: 'A',
      playerBId: 'B',
      scoreA: 50,
      playerAScore: 50,
      scoreB: 40,
      playerBScore: 40,
      playerAEffects: { greedRating: 100 },
      playerBEffects: { greedRating: 50 },
      goldOutcome: {
        settled: true,
        tie: false,
        winnerId: 'A',
        loserId: 'B',
        winnerPregameGold: 10,
        loserPregameGold: 20,
        winnerEffectiveGreed: 100,
        theftRate: 0.1,
        marginGoldAwarded: 1,
        theftGoldStolen: 2,
        settledAtISO: '2026-09-10T12:00:00.000Z'
      }
    }],
    schedule: [],
    seasonHistory: []
  };
}

function install(initialState) {
  let saved = clone(initialState);
  const storage = new Map([['taskpoints_v1', JSON.stringify(saved)]]);
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); }
  };
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    parseTaskPointsStorageJson(raw, fallback) {
      try { return JSON.parse(raw); } catch (_) { return fallback; }
    },
    saveStateSnapshot(state) {
      saved = clone(state);
      localStorage.setItem('taskpoints_v1', JSON.stringify(saved));
      return { state: saved };
    }
  };
  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    encodeURIComponent,
    module: { exports: {} },
    TaskPointsCore: core,
    localStorage,
    document: {},
    location: { pathname: '/matchups.html' },
    addEventListener() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestIdleCallback() {}
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'gold_theft_top50_notifications.js' });
  return {
    context,
    core: context.TaskPointsCore,
    getSaved: () => clone(saved)
  };
}

function balance(state, playerId) {
  return Math.round((state.goldLedger
    .filter((row) => row.playerId === playerId)
    .reduce((sum, row) => sum + Number(row.amount || 0), 0) + Number.EPSILON) * 10) / 10;
}

test('adding 2 points to a previous win adds exactly 0.2 Gold without rewriting original ledger rows', () => {
  const initial = baseState();
  const { core, getSaved } = install(initial);
  const edited = clone(initial);
  edited.matchups[0].scoreA = 52;
  edited.matchups[0].playerAScore = 52;

  core.saveStateSnapshot(edited, { savePath: 'matchups-edit-result' });
  const saved = getSaved();
  const adjustments = saved.goldLedger.filter((row) => row.type === 'matchup_adjustment');

  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].playerId, 'A');
  assert.equal(adjustments[0].amount, 0.2);
  assert.equal(balance(saved, 'A'), 13.2);
  assert.equal(balance(saved, 'B'), 18);
  assert.equal(saved.goldLedger.find((row) => row.id === 'margin-a').amount, 1);
  assert.equal(saved.matchups[0].goldOutcome.marginGoldAwarded, 1.2);
  assert.equal(saved.matchups[0].goldOutcome.theftGoldStolen, 2);
  assert.equal(saved.matchups[0].goldOutcome.adjustmentRevision, 1);
});

test('reducing an old winning margin subtracts only the Gold difference', () => {
  const initial = baseState();
  const { core, getSaved } = install(initial);
  const edited = clone(initial);
  edited.matchups[0].scoreA = 47;
  edited.matchups[0].playerAScore = 47;

  core.saveStateSnapshot(edited, { savePath: 'matchups-edit-result' });
  const saved = getSaved();
  const adjustment = saved.goldLedger.find((row) => row.type === 'matchup_adjustment');

  assert.equal(adjustment.playerId, 'A');
  assert.equal(adjustment.amount, -0.3);
  assert.equal(balance(saved, 'A'), 12.7);
  assert.equal(saved.matchups[0].goldOutcome.marginGoldAwarded, 0.7);
  assert.equal(saved.matchups[0].goldOutcome.theftGoldStolen, 2);
});

test('flipping an old win reverses the old margin and theft and applies the corrected result', () => {
  const initial = baseState();
  const { core, getSaved } = install(initial);
  const edited = clone(initial);
  edited.matchups[0].scoreA = 38;
  edited.matchups[0].playerAScore = 38;

  core.saveStateSnapshot(edited, { savePath: 'matchups-edit-result' });
  const saved = getSaved();
  const adjustments = saved.goldLedger.filter((row) => row.type === 'matchup_adjustment');
  const byPlayer = Object.fromEntries(adjustments.map((row) => [row.playerId, row.amount]));

  assert.equal(byPlayer.A, -3.5);
  assert.equal(byPlayer.B, 2.7);
  assert.equal(balance(saved, 'A'), 9.5);
  assert.equal(balance(saved, 'B'), 20.7);
  assert.equal(saved.matchups[0].goldOutcome.winnerId, 'B');
  assert.equal(saved.matchups[0].goldOutcome.loserId, 'A');
  assert.equal(saved.matchups[0].goldOutcome.marginGoldAwarded, 0.2);
  assert.equal(saved.matchups[0].goldOutcome.theftGoldStolen, 0.5);
});

test('saving the same corrected score again is idempotent and does not duplicate adjustments', () => {
  const initial = baseState();
  const { core, getSaved } = install(initial);
  const edited = clone(initial);
  edited.matchups[0].scoreA = 52;
  edited.matchups[0].playerAScore = 52;

  core.saveStateSnapshot(edited, { savePath: 'matchups-edit-result' });
  const once = getSaved();
  core.saveStateSnapshot(clone(once), { savePath: 'matchups-edit-result' });
  const twice = getSaved();

  assert.equal(twice.goldLedger.filter((row) => row.type === 'matchup_adjustment').length, 1);
  assert.equal(balance(twice, 'A'), 13.2);
  assert.equal(twice.matchups[0].goldOutcome.adjustmentRevision, 1);
});
