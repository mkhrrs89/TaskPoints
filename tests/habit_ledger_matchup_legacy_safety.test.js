const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preludeSource = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_repair_matchup_prelude.js'),
  'utf8'
);
const legacySource = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_matchup_impact_legacy_scores.js'),
  'utf8'
);

test('fail-closed prelude requires impact analysis for a removal with missing raw points', () => {
  let applyCalls = 0;
  const planner = {
    applyHabitLedgerRepairPlan() {
      applyCalls += 1;
      return {};
    }
  };
  const context = { console, globalThis: null, TaskPointsHabitLedgerRepair: planner };
  context.globalThis = context;
  vm.runInNewContext(preludeSource, context, { filename: 'habit_ledger_repair_matchup_prelude.js' });

  assert.throws(
    () => planner.applyHabitLedgerRepairPlan({}, {
      failedDateRemovals: [{ completionId: 'derived-points-row' }],
      duplicateRemovals: []
    }),
    /complete canonical matchup-impact preview is unavailable/
  );
  assert.equal(applyCalls, 0);
});

test('blank primary scores fall back to populated compatibility aliases', () => {
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    matchups: [{
      id: 'legacy-matchup',
      dateKey: '2026-07-29',
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: '',
      scoreB: '',
      playerAScore: 40,
      playerBScore: 39
    }]
  };
  const planner = {
    buildHabitLedgerRepairPlan() {
      return {
        matchupImpact: {
          days: [{
            dayKey: '2026-07-29',
            matchupCount: 1,
            matchupId: 'legacy-matchup',
            projectedUserScore: 35,
            status: 'stored-score-change',
            blocking: true
          }],
          blockingDays: [],
          resultChangingDays: [],
          affectedDays: 1,
          hasBlockingImpact: false
        }
      };
    }
  };
  const context = {
    console,
    Date,
    Number,
    String,
    globalThis: null,
    TaskPointsCore: { dateKey: (value) => String(value).slice(0, 10) },
    TaskPointsHabitLedgerRepair: planner
  };
  context.globalThis = context;
  vm.runInNewContext(legacySource, context, { filename: 'habit_ledger_matchup_impact_legacy_scores.js' });

  const impact = planner.buildHabitLedgerRepairPlan(state).matchupImpact;
  const day = impact.days[0];
  assert.equal(day.storedUserScore, 40);
  assert.equal(day.opponentScore, 39);
  assert.equal(day.beforeResult, 'Win');
  assert.equal(day.afterResult, 'Loss');
  assert.equal(day.resultChanges, true);
  assert.equal(impact.hasBlockingImpact, true);
  assert.equal(impact.resultChangingDays.length, 1);
});

test('empty score strings are never interpreted as numeric zero', () => {
  const planner = { buildHabitLedgerRepairPlan: () => ({ matchupImpact: { days: [] } }) };
  const context = {
    console,
    Date,
    Number,
    String,
    globalThis: null,
    TaskPointsCore: {},
    TaskPointsHabitLedgerRepair: planner
  };
  context.globalThis = context;
  vm.runInNewContext(legacySource, context);
  assert.equal(context.TaskPointsHabitLedgerLegacyScoreFallback.scoreValue('', 12.5), 12.5);
  assert.equal(context.TaskPointsHabitLedgerLegacyScoreFallback.scoreValue('', ''), null);
});

test('worker loads legacy score correction after canonical scoring and before stale guard', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /habit_ledger_matchup_impact_legacy_scores\.js\?v=20260801-1/);
  assert.ok(
    worker.indexOf('/habit_ledger_matchup_impact_canonical.js?v=20260801-1')
      < worker.indexOf('/habit_ledger_matchup_impact_legacy_scores.js?v=20260801-1')
  );
  assert.ok(
    worker.indexOf('/habit_ledger_matchup_impact_legacy_scores.js?v=20260801-1')
      < worker.indexOf('/habit_ledger_matchup_impact_stale_guard.js?v=20260801-1')
  );
});
