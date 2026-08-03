const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_score_reconciliation.js'),
  'utf8'
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dayTotals(state) {
  const own = new Map();
  (state.completions || []).forEach((row) => {
    const day = row.dayKey;
    own.set(day, (own.get(day) || 0) + Number(row.points || 0));
  });
  const day1 = own.get('2026-04-12') || 0;
  const day2 = own.get('2026-04-13') || 0;
  return {
    '2026-04-12': day1,
    '2026-04-13': Number((day2 + day1 * 0.1).toFixed(4))
  };
}

function install(overrides = {}) {
  const planner = {
    __habitLedgerBaseApply(state, plan) {
      const removals = new Set((plan.failedDateRemovals || []).map((item) => item.completionIndex));
      const next = clone(state);
      next.completions = next.completions.filter((row, index) => !removals.has(index));
      return {
        state: next,
        sourceRowsUpdated: 0,
        failedRowsRemoved: removals.size,
        duplicateRowsRemoved: 0
      };
    },
    applyHabitLedgerRepairPlan() {
      throw new Error('guarded apply should be bypassed only during verified simulation');
    }
  };

  const basePlan = {
    failedDateRemovals: [{
      completionIndex: 1,
      completionId: 'remove-me',
      habitId: 'habit-1',
      dayKey: '2026-04-12',
      points: 5
    }],
    duplicateRemovals: [],
    sourceUpdates: [],
    manualReview: [],
    matchupImpact: {
      completeImpactChain: true,
      days: [],
      blockingDays: [],
      resultChangingDays: [],
      hasBlockingImpact: false
    }
  };
  const fullPlan = {
    basePlan,
    doneKeyAdditions: [],
    failedKeyRemovals: [],
    sourceFixes: [],
    manualReview: []
  };

  const repair = {
    buildPlan() { return clone(fullPlan); },
    applyPlan(state, preview) {
      const base = planner.applyHabitLedgerRepairPlan(state, preview.basePlan);
      return { ...base, doneKeysAdded: 0, failedKeysRemoved: 0 };
    },
    fingerprint(plan) { return JSON.stringify(plan); },
    totalCount() { return 1; }
  };

  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    dateKey(date) { return date.toISOString().slice(0, 10); },
    youDailyTotalsWithInertia: dayTotals,
    ...overrides.core
  };

  const context = {
    console,
    JSON,
    Date,
    Map,
    Set,
    WeakSet,
    Number,
    String,
    Object,
    Array,
    structuredClone: clone,
    setTimeout() { return 1; },
    document: { getElementById() { return null; } },
    TaskPointsCore: core,
    TaskPointsHabitLedgerRepair: planner,
    TaskPointsCompletionBackedHabitRepair: repair,
    module: { exports: {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_ledger_score_reconciliation.js' });
  return { api: context.TaskPointsHabitLedgerScoreReconciliation, core, planner, repair };
}

function fixture(opponentScore = 10) {
  return {
    tasks: [],
    reminders: [],
    habits: [{ id: 'habit-1', doneKeys: ['2026-04-12'], failedKeys: [], iceKeys: [] }],
    completions: [
      { id: 'keep', source: 'habit', habitId: 'habit-1', dayKey: '2026-04-12', points: 10 },
      { id: 'remove-me', source: 'habit', habitId: 'habit-1', dayKey: '2026-04-12', points: 5 },
      { id: 'day-two', source: 'habit', habitId: 'habit-1', dayKey: '2026-04-13', points: 20 }
    ],
    matchups: [{
      id: 'match-1', matchupId: 'match-1', dateKey: '2026-04-13',
      playerAId: 'YOU', playerBId: 'xander',
      scoreA: 21.5, playerAScore: 21.5,
      scoreB: opponentScore, playerBScore: opponentScore,
      winnerId: opponentScore < 21.5 ? 'YOU' : 'xander',
      loserId: opponentScore < 21.5 ? 'xander' : 'YOU',
      result: opponentScore < 21.5 ? 'W' : 'L',
      finalizedAtISO: '2026-04-14T00:00:00Z'
    }],
    schedule: [{
      dateKey: '2026-04-13',
      matchups: [{
        id: 'match-1', matchupId: 'match-1', dateKey: '2026-04-13',
        playerAId: 'YOU', playerBId: 'xander',
        scoreA: 21.5, playerAScore: 21.5,
        scoreB: opponentScore, playerBScore: opponentScore,
        winnerId: opponentScore < 21.5 ? 'YOU' : 'xander'
      }]
    }],
    gameHistory: [{
      id: 'history-you', matchupId: 'match-1', dateKey: '2026-04-13',
      playerId: 'YOU', opponentId: 'xander', score: 21.5, points: 21.5, total: 21.5,
      winnerId: opponentScore < 21.5 ? 'YOU' : 'xander'
    }],
    currentSeason: null,
    seasonHistory: [{
      id: 'season-old',
      tournamentMatchupResults: [{
        id: 'match-1', matchupId: 'match-1', dateKey: '2026-04-13',
        playerAId: 'YOU', playerBId: 'xander',
        scoreA: 21.5, playerAScore: 21.5,
        scoreB: opponentScore, playerBScore: opponentScore,
        winnerId: opponentScore < 21.5 ? 'YOU' : 'xander',
        loserId: opponentScore < 21.5 ? 'xander' : 'YOU'
      }],
      series: {
        s1: {
          id: 's1',
          gameResults: [{
            id: 'match-1', matchupId: 'match-1', dateKey: '2026-04-13',
            playerAId: 'YOU', playerBId: 'xander',
            playerAScore: 21.5, playerBScore: opponentScore,
            winnerId: opponentScore < 21.5 ? 'YOU' : 'xander',
            loserId: opponentScore < 21.5 ? 'xander' : 'YOU'
          }]
        }
      }
    }],
    players: [],
    flexActions: [],
    opponentDripSchedules: [],
    scoringSettings: {},
    habitTagColors: {},
    gold: 99
  };
}

test('one removed completion can safely reconcile a later inertia-driven matchup day', () => {
  const { api, core, planner, repair } = install();
  const state = fixture();
  const plan = api.buildReconciliationPlan(state, { core, planner, repair });

  assert.equal(plan.affectedDays, 2);
  assert.equal(plan.noMatchupDayCount, 1);
  assert.equal(plan.matchupDays, 1);
  assert.equal(plan.canApply, true);
  assert.equal(plan.resultChanges, 0);
  assert.equal(plan.scoreUpdates[0].dayKey, '2026-04-13');
  assert.equal(plan.scoreUpdates[0].fromScore, 21.5);
  assert.equal(plan.scoreUpdates[0].toScore, 21);
});

test('apply updates every score copy while preserving opponents, results, Gold, and unrelated domains', () => {
  const { api, core, planner, repair } = install();
  const state = fixture();
  const before = clone(state);
  const plan = api.buildReconciliationPlan(state, { core, planner, repair });
  const result = api.applyReconciliationPlan(state, plan, { core, planner, repair });
  const next = result.state;

  assert.deepEqual(state, before, 'input state is not mutated');
  assert.equal(next.completions.some((row) => row.id === 'remove-me'), false);
  assert.equal(next.matchups[0].scoreA, 21);
  assert.equal(next.matchups[0].playerAScore, 21);
  assert.equal(next.matchups[0].scoreB, 10);
  assert.equal(next.matchups[0].winnerId, 'YOU');
  assert.equal(next.matchups[0].loserId, 'xander');
  assert.equal(next.matchups[0].result, 'W');
  assert.equal(next.schedule[0].matchups[0].scoreA, 21);
  assert.equal(next.schedule[0].matchups[0].playerAScore, 21);
  assert.equal(next.gameHistory[0].score, 21);
  assert.equal(next.gameHistory[0].points, 21);
  assert.equal(next.gameHistory[0].total, 21);
  assert.equal(next.seasonHistory[0].tournamentMatchupResults[0].scoreA, 21);
  assert.equal(next.seasonHistory[0].tournamentMatchupResults[0].playerAScore, 21);
  assert.equal(next.seasonHistory[0].series.s1.gameResults[0].playerAScore, 21);
  assert.equal(next.seasonHistory[0].series.s1.gameResults[0].winnerId, 'YOU');
  assert.equal(next.gold, 99);
  assert.equal(result.matchupRowsUpdated, 1);
  assert.equal(result.scheduleCopiesUpdated, 1);
  assert.equal(result.historyRowsUpdated, 1);
  assert.equal(result.seasonCopiesUpdated, 2);
});

test('preview blocks a score change that would alter the stored result', () => {
  const { api, core, planner, repair } = install();
  const state = fixture(21.2);
  state.matchups[0].winnerId = 'YOU';
  state.matchups[0].loserId = 'xander';
  state.matchups[0].result = 'W';
  const plan = api.buildReconciliationPlan(state, { core, planner, repair });

  assert.equal(plan.canApply, false);
  assert.equal(plan.resultChanges, 1);
  assert.equal(plan.blockingIssues[0].type, 'result-change');
});

test('preview blocks duplicate You matchups on an affected date', () => {
  const { api, core, planner, repair } = install();
  const state = fixture();
  state.matchups.push({ ...clone(state.matchups[0]), id: 'match-2', matchupId: 'match-2' });
  const plan = api.buildReconciliationPlan(state, { core, planner, repair });

  assert.equal(plan.canApply, false);
  assert.equal(plan.blockingIssues.some((item) => item.type === 'ambiguous-matchups'), true);
});

test('preview blocks ambiguous You gameHistory copies', () => {
  const { api, core, planner, repair } = install();
  const state = fixture();
  state.gameHistory.push({ ...clone(state.gameHistory[0]), id: 'history-you-2' });
  const plan = api.buildReconciliationPlan(state, { core, planner, repair });

  assert.equal(plan.canApply, false);
  assert.equal(plan.blockingIssues.some((item) => item.type === 'ambiguous-history'), true);
});

test('preview includes a compatible legacy history row when an explicit row also exists', () => {
  const { api, core, planner, repair } = install();
  const state = fixture();
  state.gameHistory.push({
    ...clone(state.gameHistory[0]),
    id: 'history-you-legacy',
    matchupId: ''
  });
  const plan = api.buildReconciliationPlan(state, { core, planner, repair });

  assert.equal(plan.canApply, false);
  const issue = plan.blockingIssues.find((item) => item.type === 'ambiguous-history');
  assert.ok(issue);
  assert.match(issue.reason, /^2 You gameHistory rows match/);
});

test('apply rejects a stale preview after completions change', () => {
  const { api, core, planner, repair } = install();
  const state = fixture();
  const plan = api.buildReconciliationPlan(state, { core, planner, repair });
  const changed = clone(state);
  changed.completions.push({
    id: 'late-change', source: 'habit', habitId: 'habit-1', dayKey: '2026-04-13', points: 1
  });

  assert.throws(
    () => api.applyReconciliationPlan(changed, plan, { core, planner, repair }),
    /changed after preview/
  );
});
