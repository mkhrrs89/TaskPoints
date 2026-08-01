const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_matchup_impact_dateiso.js'),
  'utf8'
);

test('legacy dateISO matchup replaces a false no-matchup result with a blocking impact', () => {
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'remove-me', dayKey: '2026-07-29', points: 4 }],
    matchups: [{
      id: 'legacy-dateiso',
      dateISO: '2026-07-29T12:00:00.000Z',
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: 4,
      scoreB: 2
    }]
  };
  const basePlan = {
    failedDateRemovals: [{ completionIndex: 0, dayKey: '2026-07-29', points: 4 }],
    duplicateRemovals: [],
    sourceUpdates: [],
    pointsRemoved: 4,
    matchupImpact: {
      days: [{
        dayKey: '2026-07-29',
        pointsRemoved: 4,
        matchupCount: 0,
        status: 'no-matchup',
        blocking: false,
        resultChanges: false
      }],
      blockingDays: [],
      resultChangingDays: [],
      affectedDays: 1,
      hasBlockingImpact: false
    }
  };
  const planner = { buildHabitLedgerRepairPlan: () => basePlan };
  const canonical = {
    buildProjectedState(input) {
      return { ...input, completions: [] };
    },
    canonicalScore(input) {
      return input.completions.length ? 4 : 0;
    }
  };
  const context = {
    console,
    Date,
    Number,
    String,
    Math,
    Map,
    Set,
    globalThis: null,
    TaskPointsCore: { dateKey: (value) => value.toISOString().slice(0, 10) },
    TaskPointsHabitLedgerRepair: planner,
    TaskPointsCanonicalHabitLedgerMatchupImpact: canonical
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_ledger_matchup_impact_dateiso.js' });

  const impact = planner.buildHabitLedgerRepairPlan(state).matchupImpact;
  assert.equal(impact.days.length, 1);
  assert.equal(impact.days[0].matchupId, 'legacy-dateiso');
  assert.equal(impact.days[0].status, 'result-change');
  assert.equal(impact.days[0].beforeResult, 'Win');
  assert.equal(impact.days[0].afterResult, 'Loss');
  assert.equal(impact.hasBlockingImpact, true);
});

test('dateISO normalization uses aliases when primary scores are blank', () => {
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'remove-me', dayKey: '2026-07-29', points: 1 }],
    matchups: [{
      id: 'legacy-dateiso-alias',
      dateISO: '2026-07-29T12:00:00.000Z',
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: '',
      scoreB: '',
      playerAScore: 3,
      playerBScore: 2
    }]
  };
  const planner = {
    buildHabitLedgerRepairPlan: () => ({
      failedDateRemovals: [{ completionIndex: 0, dayKey: '2026-07-29', points: 1 }],
      duplicateRemovals: [],
      sourceUpdates: [],
      pointsRemoved: 1,
      matchupImpact: { days: [], blockingDays: [], resultChangingDays: [], affectedDays: 0, hasBlockingImpact: false }
    })
  };
  const context = {
    console,
    Date,
    Number,
    String,
    Math,
    Map,
    Set,
    globalThis: null,
    TaskPointsCore: { dateKey: (value) => value.toISOString().slice(0, 10) },
    TaskPointsHabitLedgerRepair: planner,
    TaskPointsCanonicalHabitLedgerMatchupImpact: {
      buildProjectedState: (input) => ({ ...input, completions: [] }),
      canonicalScore: (input) => input.completions.length ? 3 : 0
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const day = planner.buildHabitLedgerRepairPlan(state).matchupImpact.days[0];
  assert.equal(day.storedUserScore, 3);
  assert.equal(day.opponentScore, 2);
  assert.equal(day.beforeResult, 'Win');
  assert.equal(day.afterResult, 'Loss');
});

test('worker loads dateISO normalization after canonical scoring and before score/stale guards', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /habit_ledger_matchup_impact_dateiso\.js\?v=20260801-1/);
  assert.ok(
    worker.indexOf('/habit_ledger_matchup_impact_canonical.js?v=20260801-1')
      < worker.indexOf('/habit_ledger_matchup_impact_dateiso.js?v=20260801-1')
  );
  assert.ok(
    worker.indexOf('/habit_ledger_matchup_impact_dateiso.js?v=20260801-1')
      < worker.indexOf('/habit_ledger_matchup_impact_legacy_scores.js?v=20260801-1')
  );
});
