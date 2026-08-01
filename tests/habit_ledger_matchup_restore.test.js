const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preludeSource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_repair_matchup_prelude.js'), 'utf8');
const transformSource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_matchup_restore_transform.js'), 'utf8');
const applySource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_matchup_restore_apply.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_matchup_restore_ui.js'), 'utf8');

function restorePlan(projectedUserScore = 10) {
  const day = {
    dayKey: '2026-07-29',
    matchupCount: 1,
    matchupId: 'm',
    storedUserScore: 10,
    projectedUserScore,
    opponentScore: 8,
    beforeResult: 'Win',
    afterResult: projectedUserScore > 8 ? 'Win' : (projectedUserScore === 8 ? 'Tie' : 'Loss'),
    status: 'stored-score-change',
    blocking: true,
    resultChanges: projectedUserScore <= 8
  };
  return {
    failedDateRemovals: [{ completionIndex: 0, completionId: 'stale', dayKey: '2026-07-29', points: 2 }],
    duplicateRemovals: [],
    sourceUpdates: [],
    manualReview: [],
    pointsRemoved: 2,
    matchupImpact: {
      days: [day],
      blockingDays: [day],
      resultChangingDays: day.resultChanges ? [day] : [],
      affectedDays: 1,
      hasBlockingImpact: true,
      completeImpactChain: true
    }
  };
}

function loadRestoreFlow(plan) {
  let baseApplyCalls = 0;
  let rawApplyCalls = 0;
  const planner = {
    buildHabitLedgerRepairPlan: () => structuredClone(plan),
    applyHabitLedgerRepairPlan() {
      baseApplyCalls += 1;
      return { ok: true };
    }
  };
  const context = {
    console,
    JSON,
    Number,
    Math,
    structuredClone,
    globalThis: null,
    TaskPointsHabitLedgerRepair: planner,
    TaskPointsCanonicalHabitLedgerMatchupImpact: {
      impactFingerprint(impact) {
        return JSON.stringify(impact.days);
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(preludeSource, context);

  const previous = planner.applyHabitLedgerRepairPlan.bind(planner);
  planner.applyHabitLedgerRepairPlan = function simulatedRawGuard(state, preview) {
    rawApplyCalls += 1;
    if (preview?.matchupImpact?.days?.length) throw new Error('raw guard blocked');
    return previous(state, preview);
  };

  vm.runInNewContext(transformSource, context);
  vm.runInNewContext(applySource, context);
  return {
    planner,
    context,
    getBaseApplyCalls: () => baseApplyCalls,
    getRawApplyCalls: () => rawApplyCalls
  };
}

test('projected canonical score equal to stored score is a safe restoration', () => {
  const { planner, context } = loadRestoreFlow(restorePlan(10));
  const plan = planner.buildHabitLedgerRepairPlan({});
  const day = plan.matchupImpact.days[0];

  assert.equal(day.status, 'restores-stored-score');
  assert.equal(day.blocking, false);
  assert.equal(day.resultChanges, false);
  assert.equal(plan.matchupImpact.hasBlockingImpact, false);
  assert.equal(plan.matchupImpact.restoredScoreDays, 1);
  assert.equal(context.__latestHabitLedgerMatchupImpact.days[0].status, 'restores-stored-score');
});

test('verified restoration bypasses the obsolete raw approximation but still uses base stale-plan checks', () => {
  const { planner, getBaseApplyCalls, getRawApplyCalls } = loadRestoreFlow(restorePlan(10));
  const plan = planner.buildHabitLedgerRepairPlan({});
  const result = planner.applyHabitLedgerRepairPlan({}, plan);

  assert.equal(result.ok, true);
  assert.equal(getBaseApplyCalls(), 1);
  assert.equal(getRawApplyCalls(), 0, 'safe restoration must not be rejected by the earlier raw estimate');
});

test('a projected score that differs from the stored score remains blocked', () => {
  const { planner, getBaseApplyCalls } = loadRestoreFlow(restorePlan(9));
  const plan = planner.buildHabitLedgerRepairPlan({});

  assert.equal(plan.matchupImpact.days[0].status, 'stored-score-change');
  assert.equal(plan.matchupImpact.hasBlockingImpact, true);
  assert.throws(() => planner.applyHabitLedgerRepairPlan({}, plan), /raw guard blocked/);
  assert.equal(getBaseApplyCalls(), 0);
});

test('restoration UI uses the exact analyzed status rather than rounded score text', () => {
  assert.match(uiSource, /SAFE RESTORATION/);
  assert.match(uiSource, /__latestHabitLedgerMatchupImpact/);
  assert.match(uiSource, /status === 'restores-stored-score'/);
  assert.doesNotMatch(uiSource, /Math\.abs\(stored - projected\)/);
  assert.match(uiSource, /restores the finalized matchup score/);
});

test('worker orders restoration transform before attestation and restoration apply before stale guard', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  const transformAt = worker.indexOf('/habit_ledger_matchup_restore_transform.js?v=20260801-1');
  const attestationAt = worker.indexOf('/habit_ledger_matchup_impact_attestation.js?v=20260801-1');
  const applyAt = worker.indexOf('/habit_ledger_matchup_restore_apply.js?v=20260801-1');
  const staleAt = worker.indexOf('/habit_ledger_matchup_impact_stale_guard.js?v=20260801-1');
  assert.ok(transformAt > 0 && transformAt < attestationAt);
  assert.ok(applyAt > attestationAt && applyAt < staleAt);
});
