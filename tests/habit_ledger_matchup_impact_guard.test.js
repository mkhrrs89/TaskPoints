const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_matchup_impact_guard.js'),
  'utf8'
);

function loadGuard() {
  const originalBuild = (state) => state.plan;
  let applyCalls = 0;
  const planner = {
    buildHabitLedgerRepairPlan: originalBuild,
    applyHabitLedgerRepairPlan(state, plan) {
      applyCalls += 1;
      return { state, plan };
    }
  };
  const context = {
    console,
    Date,
    Map,
    Set,
    JSON,
    Number,
    String,
    Math,
    structuredClone,
    globalThis: null,
    TaskPointsHabitLedgerRepair: planner
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_ledger_matchup_impact_guard.js' });
  return { context, planner, getApplyCalls: () => applyCalls };
}

function stateWith(pointsRemoved, youScore = 40, opponentScore = 39) {
  return {
    youName: 'Miggy',
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'x', points: 50, dayKey: '2026-07-29', source: 'task' }],
    matchups: [{
      id: 'm',
      dateKey: '2026-07-29',
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: youScore,
      scoreB: opponentScore
    }],
    plan: {
      sourceUpdates: [],
      failedDateRemovals: [{
        completionId: 'bad',
        dayKey: '2026-07-29',
        points: pointsRemoved
      }],
      duplicateRemovals: [],
      manualReview: [],
      pointsRemoved
    }
  };
}

test('preview shows a win-to-loss result change and hard-blocks apply', () => {
  const { planner, getApplyCalls } = loadGuard();
  const state = stateWith(3, 40, 39);
  const plan = planner.buildHabitLedgerRepairPlan(state);

  assert.equal(plan.matchupImpact.blockingDays.length, 1);
  assert.equal(plan.matchupImpact.resultChangingDays.length, 1);
  assert.equal(plan.matchupImpact.days[0].beforeResult, 'Win');
  assert.equal(plan.matchupImpact.days[0].afterResult, 'Loss');
  assert.throws(
    () => planner.applyHabitLedgerRepairPlan(state, plan),
    /No habit rows were changed/
  );
  assert.equal(getApplyCalls(), 0);
});

test('stored score change remains blocked even when W/L result is unchanged', () => {
  const { planner } = loadGuard();
  const state = stateWith(1.5, 64.85, 43.2);
  const day = planner.buildHabitLedgerRepairPlan(state).matchupImpact.days[0];

  assert.equal(day.resultChanges, false);
  assert.equal(day.projectedUserScore, 63.35);
  assert.equal(day.blocking, true);
  assert.equal(day.status, 'stored-score-change');
});

test('point removal on a day without a stored YOU matchup is nonblocking', () => {
  const { planner, getApplyCalls } = loadGuard();
  const state = stateWith(4);
  state.matchups = [];
  const plan = planner.buildHabitLedgerRepairPlan(state);

  assert.equal(plan.matchupImpact.hasBlockingImpact, false);
  assert.equal(plan.matchupImpact.days[0].status, 'no-matchup');
  planner.applyHabitLedgerRepairPlan(state, plan);
  assert.equal(getApplyCalls(), 1);
});

test('multiple YOU matchups on one affected day are ambiguous and blocked', () => {
  const { planner } = loadGuard();
  const state = stateWith(2);
  state.matchups.push({ ...state.matchups[0], id: 'm2' });
  const day = planner.buildHabitLedgerRepairPlan(state).matchupImpact.days[0];

  assert.equal(day.status, 'ambiguous-matchups');
  assert.equal(day.matchupCount, 2);
  assert.equal(day.blocking, true);
});

test('source-only corrections have no score or matchup impact', () => {
  const { planner, getApplyCalls } = loadGuard();
  const state = stateWith(0);
  state.plan = {
    sourceUpdates: [{ completionId: 'source-only' }],
    failedDateRemovals: [],
    duplicateRemovals: [],
    manualReview: [],
    pointsRemoved: 0
  };
  const plan = planner.buildHabitLedgerRepairPlan(state);

  assert.equal(plan.matchupImpact.affectedDays, 0);
  assert.equal(plan.matchupImpact.hasBlockingImpact, false);
  planner.applyHabitLedgerRepairPlan(state, plan);
  assert.equal(getApplyCalls(), 1);
});

test('Audit loader places the impact guard after the repair panel module', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /habit_ledger_matchup_impact_guard\.js\?v=20260801-1/);
  assert.match(worker, /data-taskpoints-habit-matchup-impact="true"/);
  assert.ok(
    worker.indexOf('/habit_ledger_repair_audit.js?v=20260731-1')
      < worker.indexOf('/habit_ledger_matchup_impact_guard.js?v=20260801-1'),
    'impact guard must load after the base repair panel'
  );
});

test('UI and apply paths both enforce blocking impacts', () => {
  assert.match(source, /repairButton\.dataset\.matchupImpactBlocked/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /impact\.hasBlockingImpact/);
  assert.match(source, /No habit rows were changed/);
  assert.match(source, /stored score .*projectedUserScore/s);
});
