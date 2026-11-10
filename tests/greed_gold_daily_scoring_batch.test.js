const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'greed_gold_economy.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function install() {
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    simulateAiScoreForPlayerCore(player, dayKey, options = {}) {
      options.context?.captureEffects?.({
        intimidationApplied: false,
        poiseApplied: true,
        baseScore: player.baseScore
      });
      return player.baseScore;
    }
  };
  const context = vm.createContext({
    TaskPointsCore: core,
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; } },
    console: { warn() {}, error() {}, log() {} },
    setTimeout() {}, clearTimeout() {},
    Date, Math, JSON, Map, Set, Object, String, Number, Array, encodeURIComponent
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'greed_gold_economy.js' });
  return { api: context.TaskPointsGreedGoldEconomy, core: context.TaskPointsCore };
}

function makeState({ pendingMatchup = false } = {}) {
  const players = Array.from({ length: 125 }, (_, i) => ({
    id: 'NPC-' + i,
    name: 'NPC-' + i,
    active: i < 120,
    greed: (i * 13) % 101,
    baseScore: 45 + (i % 26)
  }));
  const goldLedger = players.map((p, i) => ({
    id: 'gold:opening:' + p.id, type: 'opening_balance',
    playerId: p.id, dateKey: '2026-11-05',
    amount: i < 120 ? 10 + i / 10 : 800 + i, balanceAfter: i < 120 ? 10 + i / 10 : 800 + i
  }));
  goldLedger.push({ id: 'gold:opening:YOU', type: 'opening_balance', playerId: 'YOU', amount: 3000, balanceAfter: 3000 });
  for (let i = 0; i < 120; i++) {
    goldLedger.push({ id: 'gold:manual:' + i, type: 'manual_adjustment',
      playerId: players[i].id, dateKey: '2026-11-06', amount: 0.1 });
  }
  const matchups = Array.from({ length: 370 }, (_, i) => ({
    id: 'prior-' + i, dateKey: '2026-11-06',
    playerAId: players[i % 120].id,
    playerBId: players[(i + 1) % 120].id,
    scoreA: 65, scoreB: 44,
    goldOutcome: { settled: true }
  }));
  const settledMatchupKeys = matchups.map(row => 'id:' + row.id);
  if (pendingMatchup) {
    matchups.push({
      id: 'new-finished-game', dateKey: '2026-11-07',
      playerAId: 'NPC-4', playerBId: 'NPC-8',
      scoreA: 69, scoreB: 51,
      playerAEffects: { greedRating: 72 }
    });
  }
  return {
    players,
    goldLedger,
    matchups,
    gameHistory: [],
    seasonHistory: [],
    goldEconomy: {
      version: 1, launchDateKey: '2026-11-05',
      launchedAtISO: '2026-11-05T09:00:00.000Z',
      settledMatchupKeys,
      ignoredSameDayMatchupKeys: [],
      settledChampionKeys: [], ignoredChampionKeys: []
    }
  };
}

function scorePlayers(core, state) {
  const players = state.players.filter(player => player.active !== false);
  return players.map((player, i) => {
    const opponent = players[(i + 1) % players.length];
    let effects = null;
    const score = core.simulateAiScoreForPlayerCore(player, '2026-11-10', {
      state,
      context: {
        opponent,
        captureEffects(value) { effects = clone(value); }
      }
    });
    return { score, effects };
  });
}

function countHistoryReads(state) {
  let ledgerReads = 0, matchupReads = 0;
  const ledger = state.goldLedger;
  const matchups = state.matchups;
  Object.defineProperty(state, 'goldLedger', {
    configurable: true, get() { ledgerReads++; return ledger; },
    set() { throw new Error('The Gold ledger may not be replaced during scoring.'); }
  });
  Object.defineProperty(state, 'matchups', {
    configurable: true, get() { matchupReads++; return matchups; },
    set() { throw new Error('Matchups may not be replaced during scoring.'); }
  });
  return { ledgerReads: () => ledgerReads, matchupReads: () => matchupReads };
}

test('Home wraps only pregame NPC scoring in the temporary Gold batch', () => {
  const start = home.indexOf('function simulateToday() {');
  const end = home.indexOf('function getHistoryDateKey(g)', start);
  const simulation = home.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(simulation.includes('const scoreNpcParticipants = () => participantIds.forEach(id => {'));
  assert.ok(simulation.includes('TaskPointsCore.withGoldNpcScoringBatch(state, scoreNpcParticipants);'));
  assert.ok(simulation.includes('scoreNpcParticipants();'),
    'the previous scoring loop must remain available without the Gold module');
  assert.ok(simulation.indexOf('TaskPointsCore.withGoldNpcScoringBatch(state, scoreNpcParticipants);')
    < simulation.indexOf('todaysPairs.forEach(pair => {'),
    'the Gold snapshot must expire before any new matchups are settled');
  assert.ok(simulation.includes('save();'), 'the existing protected save is preserved');
});

test('120 NPC scores and captured Greed effects are identical with and without one-batch Gold', () => {
  const { api, core } = install();
  const baseline = makeState();
  const optimized = clone(baseline);
  const baselineReads = countHistoryReads(baseline);
  const optimizedReads = countHistoryReads(optimized);
  const originalRows = clone(optimized.goldLedger);
  const expected = scorePlayers(core, baseline);
  const actual = api.withGoldNpcScoringBatch(optimized, () => scorePlayers(core, optimized));

  assert.deepEqual(actual, expected, 'score caps, Greed bonuses and captured NPC effects must be identical');
  assert.deepEqual(clone(optimized.goldLedger), originalRows, 'scoring does not create or remove Gold transactions');
  assert.deepEqual(clone(optimized.goldEconomy), clone(baseline.goldEconomy),
    'existing Gold settlement markers remain unchanged');

  // Measure the repeated history/ledger work itself, not flaky elapsed wall time.
  assert.ok(baselineReads.matchupReads() >= 120, 'the legacy path reconciled each NPC separately');
  assert.ok(optimizedReads.matchupReads() <= 3, 'the batch reconciles historical matchups just once');
  assert.ok(optimizedReads.ledgerReads() * 30 < baselineReads.ledgerReads(),
    'one cached snapshot must eliminate most repeated transaction scans');
});

test('an uncredited finished game settles once before the snapshot with identical Gold outcomes', () => {
  const { api, core } = install();
  const baseline = makeState({ pendingMatchup: true });
  const optimized = clone(baseline);
  const expected = scorePlayers(core, baseline);
  const actual = api.withGoldNpcScoringBatch(optimized, () => scorePlayers(core, optimized));
  assert.deepEqual(actual, expected);
  assert.deepEqual(clone(optimized.goldLedger), clone(baseline.goldLedger),
    'margin awards, theft transfers and balanceAfter stay identical');
  assert.deepEqual(clone(optimized.goldEconomy), clone(baseline.goldEconomy),
    'settled keys stay identical');
  assert.deepEqual(clone(optimized.matchups), clone(baseline.matchups),
    'linked Gold outcomes remain unchanged');
  const priorLength = optimized.goldLedger.length;
  api.reconcileGoldEconomy(optimized);
  assert.equal(optimized.goldLedger.length, priorLength, 'completed games never get paid twice');
});

test('leaving the batch or throwing away a scoring pass immediately restores live Gold reads', () => {
  const { api, core } = install();
  const state = makeState();
  const npc = state.players[0], opponent = state.players[1];
  function result() {
    let captured;
    const score = core.simulateAiScoreForPlayerCore(npc, '2026-11-10', {
      state, context: { opponent, captureEffects(value) { captured = clone(value); } }
    });
    return { score, captured };
  }
  const first = api.withGoldNpcScoringBatch(state, () => result());
  state.goldLedger.push({ id: 'gold:manual:outside', playerId: opponent.id, amount: 5000,
    type: 'manual_adjustment', dateKey: '2026-11-10' });
  const changed = result();
  assert.notDeepEqual(changed, first, 'manual Gold edits must be visible after the batch exits');
  assert.throws(() => api.withGoldNpcScoringBatch(state, () => { throw new Error('NPC scoring stopped'); }),
    /NPC scoring stopped/);
  state.goldLedger.push({ id: 'gold:manual:second', playerId: npc.id, amount: 2000,
    type: 'manual_adjustment', dateKey: '2026-11-10' });
  const newer = result();
  assert.notDeepEqual(newer, changed, 'an exception must not strand stale Gold balance caches');
});

test('Gold batch scopes by state identity and never affects unrelated Gold balances', () => {
  const { api, core } = install();
  const state = makeState();
  const other = makeState();
  other.goldLedger.push({ id: 'bonus:other', type: 'manual_adjustment',
    playerId: other.players[1].id, dateKey: '2026-11-09', amount: 10000 });
  const ordinary = scorePlayers(core, other);
  api.withGoldNpcScoringBatch(state, () => {
    assert.deepEqual(scorePlayers(core, other), ordinary);
  });
  assert.deepEqual(scorePlayers(core, other), ordinary);
});
