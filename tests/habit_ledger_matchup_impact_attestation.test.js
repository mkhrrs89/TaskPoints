const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preludeSource = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_repair_matchup_prelude.js'),
  'utf8'
);
const attestationSource = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_matchup_impact_attestation.js'),
  'utf8'
);

function basePlan() {
  return {
    failedDateRemovals: [{ completionId: 'remove-me' }],
    duplicateRemovals: [],
    sourceUpdates: [],
    pointsRemoved: 3,
    matchupImpact: {
      days: [],
      blockingDays: [],
      resultChangingDays: [],
      affectedDays: 0,
      hasBlockingImpact: false
    }
  };
}

test('guard-only preview cannot authorize a point-removing repair', () => {
  let applyCalls = 0;
  const planner = {
    buildHabitLedgerRepairPlan: () => basePlan(),
    applyHabitLedgerRepairPlan() {
      applyCalls += 1;
      return {};
    }
  };
  const context = {
    console,
    globalThis: null,
    TaskPointsHabitLedgerRepair: planner,
    TaskPointsHabitLedgerMatchupImpact: {}
  };
  context.globalThis = context;
  vm.runInNewContext(preludeSource, context);
  vm.runInNewContext(attestationSource, context);

  const plan = planner.buildHabitLedgerRepairPlan({});
  assert.equal(plan.matchupImpact.completeImpactChain, false);
  assert.equal(plan.matchupImpact.hasBlockingImpact, true);
  assert.equal(plan.matchupImpact.days[0].status, 'impact-chain-incomplete');
  assert.throws(
    () => planner.applyHabitLedgerRepairPlan({}, plan),
    /complete canonical matchup-impact preview is unavailable/
  );
  assert.equal(applyCalls, 0);
});

test('attestation succeeds only when every required impact layer is installed', () => {
  const planner = {
    buildHabitLedgerRepairPlan: () => basePlan(),
    applyHabitLedgerRepairPlan: () => ({})
  };
  const context = {
    console,
    globalThis: null,
    TaskPointsHabitLedgerRepair: planner,
    TaskPointsHabitLedgerMatchupImpact: {},
    TaskPointsCanonicalHabitLedgerMatchupImpact: {},
    TaskPointsHabitLedgerDateIsoImpact: {},
    TaskPointsHabitLedgerLegacyScoreFallback: {}
  };
  context.globalThis = context;
  vm.runInNewContext(attestationSource, context);

  const plan = planner.buildHabitLedgerRepairPlan({});
  assert.equal(plan.matchupImpact.completeImpactChain, true);
  assert.equal(plan.matchupImpact.impactChainVersion, '20260801-1');
  assert.equal(plan.matchupImpact.hasBlockingImpact, false);
});

test('source-only corrections do not require the point-removal attestation to apply', () => {
  let applyCalls = 0;
  const planner = {
    buildHabitLedgerRepairPlan: () => ({
      failedDateRemovals: [],
      duplicateRemovals: [],
      sourceUpdates: [{ completionId: 'source-only' }],
      pointsRemoved: 0,
      matchupImpact: { days: [], hasBlockingImpact: false }
    }),
    applyHabitLedgerRepairPlan() {
      applyCalls += 1;
      return {};
    }
  };
  const context = { console, globalThis: null, TaskPointsHabitLedgerRepair: planner };
  context.globalThis = context;
  vm.runInNewContext(preludeSource, context);
  vm.runInNewContext(attestationSource, context);

  const plan = planner.buildHabitLedgerRepairPlan({});
  planner.applyHabitLedgerRepairPlan({}, plan);
  assert.equal(applyCalls, 1);
});

test('worker loads attestation after all required layers and before stale guard', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /habit_ledger_matchup_impact_attestation\.js\?v=20260801-1/);
  const attestationAt = worker.indexOf('/habit_ledger_matchup_impact_attestation.js?v=20260801-1');
  assert.ok(worker.indexOf('/habit_ledger_matchup_impact_guard.js?v=20260801-1') < attestationAt);
  assert.ok(worker.indexOf('/habit_ledger_matchup_impact_canonical.js?v=20260801-2') < attestationAt);
  assert.ok(worker.indexOf('/habit_ledger_matchup_impact_dateiso.js?v=20260801-2') < attestationAt);
  assert.ok(worker.indexOf('/habit_ledger_matchup_impact_legacy_scores.js?v=20260801-1') < attestationAt);
  assert.ok(attestationAt < worker.indexOf('/habit_ledger_matchup_impact_stale_guard.js?v=20260801-1'));
});
