const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preludeSource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_repair_matchup_prelude.js'), 'utf8');
const impactSource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_matchup_impact_guard.js'), 'utf8');
const canonicalSource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_matchup_impact_canonical.js'), 'utf8');
const staleSource = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_matchup_impact_stale_guard.js'), 'utf8');

function dayOf(row) {
  return row.dayKey || String(row.completedAtISO || '').slice(0, 10);
}

function loadCanonicalGuard() {
  let applyCalls = 0;
  const planner = {
    buildHabitLedgerRepairPlan: (state) => state.plan,
    applyHabitLedgerRepairPlan(state, plan) {
      applyCalls += 1;
      return { state, plan };
    }
  };
  const core = {
    dateKey(value) {
      return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
    },
    buildDaySnapshot(dayKey, state) {
      const current = (state.completions || [])
        .filter((row) => dayOf(row) === dayKey)
        .reduce((sum, row) => sum + Number(row.points || 0), 0);
      const prior = dayKey === '2026-07-30'
        ? (state.completions || [])
          .filter((row) => dayOf(row) === '2026-07-29')
          .reduce((sum, row) => sum + Number(row.points || 0), 0)
        : 0;
      return { total: current + prior * 0.25 };
    },
    computeDayTotals(snapshot) {
      return { total: snapshot.total };
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
    TaskPointsCore: core,
    TaskPointsHabitLedgerRepair: planner
  };
  context.globalThis = context;
  [preludeSource, impactSource, canonicalSource, staleSource].forEach((source) => {
    vm.runInNewContext(source, context);
  });
  return { planner, getApplyCalls: () => applyCalls };
}

test('canonical preview detects a later matchup changed by scoring inertia', () => {
  const { planner } = loadCanonicalGuard();
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'a', dayKey: '2026-07-29', points: 4 }],
    matchups: [{
      id: 'm',
      dateKey: '2026-07-30',
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: 1,
      scoreB: 0.5
    }],
    plan: {
      sourceUpdates: [],
      failedDateRemovals: [{ completionIndex: 0, completionId: 'a', dayKey: '2026-07-29', points: 4 }],
      duplicateRemovals: [],
      manualReview: [],
      pointsRemoved: 4
    }
  };

  const plan = planner.buildHabitLedgerRepairPlan(state);
  assert.equal(plan.matchupImpact.blockingDays.length, 1);
  assert.equal(plan.matchupImpact.blockingDays[0].dayKey, '2026-07-30');
  assert.equal(plan.matchupImpact.blockingDays[0].projectedUserScore, 0);
  assert.equal(plan.matchupImpact.blockingDays[0].resultChanges, true);
});

test('canonical preview retains a 0.05-point removal', () => {
  const { planner } = loadCanonicalGuard();
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'a', dayKey: '2026-07-29', points: 0.05 }],
    matchups: [{
      id: 'm',
      dateKey: '2026-07-29',
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: 0.05,
      scoreB: 0
    }],
    plan: {
      sourceUpdates: [],
      failedDateRemovals: [{ completionIndex: 0, completionId: 'a', dayKey: '2026-07-29', points: 0.05 }],
      duplicateRemovals: [],
      manualReview: [],
      pointsRemoved: 0.05
    }
  };

  const plan = planner.buildHabitLedgerRepairPlan(state);
  assert.equal(plan.matchupImpact.blockingDays.length, 1);
  assert.equal(plan.matchupImpact.blockingDays[0].projectedUserScore, 0);
});

test('canonical preview rejects a changed score calculation after preview', () => {
  const { planner, getApplyCalls } = loadCanonicalGuard();
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'a', dayKey: '2026-07-29', points: 4 }],
    matchups: [],
    plan: {
      sourceUpdates: [],
      failedDateRemovals: [{ completionIndex: 0, completionId: 'a', dayKey: '2026-07-29', points: 4 }],
      duplicateRemovals: [],
      manualReview: [],
      pointsRemoved: 4
    }
  };
  const preview = planner.buildHabitLedgerRepairPlan(state);
  const changed = structuredClone(state);
  changed.matchups.push({
    id: 'later',
    dateKey: '2026-07-30',
    playerAId: 'YOU',
    playerBId: 'opp',
    scoreA: 1,
    scoreB: 0.5
  });

  assert.throws(
    () => planner.applyHabitLedgerRepairPlan(changed, preview),
    /canonical score or matchup state changed after preview/
  );
  assert.equal(getApplyCalls(), 0);
});

test('worker loads the canonical scorer between impact UI and stale guard', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /habit_ledger_matchup_impact_canonical\.js\?v=20260801-1/);
  assert.ok(
    worker.indexOf('/habit_ledger_matchup_impact_guard.js?v=20260801-1')
      < worker.indexOf('/habit_ledger_matchup_impact_canonical.js?v=20260801-1')
  );
  assert.ok(
    worker.indexOf('/habit_ledger_matchup_impact_canonical.js?v=20260801-1')
      < worker.indexOf('/habit_ledger_matchup_impact_stale_guard.js?v=20260801-1')
  );
});

test('canonical implementation uses the shared day scorer rather than raw subtraction', () => {
  assert.match(canonicalSource, /core\.buildDaySnapshot/);
  assert.match(canonicalSource, /core\.computeDayTotals/);
  assert.match(canonicalSource, /matchupsByDay\.forEach/);
  assert.doesNotMatch(canonicalSource, /Math\.abs\(Number\(item\.points\)\) > 0\.05/);
});
