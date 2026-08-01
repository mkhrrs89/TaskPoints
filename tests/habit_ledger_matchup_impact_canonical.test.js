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
  let batchCalls = 0;
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
    youDailyTotalsWithInertia(state) {
      batchCalls += 1;
      const totals = {};
      const direct = {};
      (state.completions || []).forEach((row) => {
        const day = dayOf(row);
        direct[day] = (direct[day] || 0) + Number(row.points || 0);
      });
      Object.keys(direct).forEach((day) => { totals[day] = direct[day]; });
      const prior = direct['2026-07-29'] || 0;
      totals['2026-07-30'] = (direct['2026-07-30'] || 0) + prior * 0.25;
      return totals;
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
  return {
    planner,
    context,
    getApplyCalls: () => applyCalls,
    getBatchCalls: () => batchCalls
  };
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

test('canonical preview includes a legacy dateISO matchup in the batch pass', () => {
  const { planner } = loadCanonicalGuard();
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'a', dayKey: '2026-07-29', points: 4 }],
    matchups: [{
      id: 'legacy-dateiso',
      dateISO: '2026-07-29T12:00:00.000Z',
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: 4,
      scoreB: 2
    }],
    plan: {
      sourceUpdates: [],
      failedDateRemovals: [{ completionIndex: 0, completionId: 'a', dayKey: '2026-07-29', points: 4 }],
      duplicateRemovals: [],
      manualReview: [],
      pointsRemoved: 4
    }
  };

  const day = planner.buildHabitLedgerRepairPlan(state).matchupImpact.blockingDays[0];
  assert.equal(day.matchupId, 'legacy-dateiso');
  assert.equal(day.beforeResult, 'Win');
  assert.equal(day.afterResult, 'Loss');
});

test('canonical preview builds only one live and one projected score map', () => {
  const { planner, getBatchCalls } = loadCanonicalGuard();
  const matchups = [];
  for (let day = 1; day <= 28; day += 1) {
    const key = `2026-07-${String(day).padStart(2, '0')}`;
    matchups.push({
      id: `m-${day}`,
      dateKey: key,
      playerAId: 'YOU',
      playerBId: 'opp',
      scoreA: 10,
      scoreB: 5
    });
  }
  const state = {
    players: [{ id: 'opp', name: 'Reynolds' }],
    completions: [{ id: 'a', dayKey: '2026-07-29', points: 4 }],
    matchups,
    plan: {
      sourceUpdates: [],
      failedDateRemovals: [{ completionIndex: 0, completionId: 'a', dayKey: '2026-07-29', points: 4 }],
      duplicateRemovals: [],
      manualReview: [],
      pointsRemoved: 4
    }
  };

  planner.buildHabitLedgerRepairPlan(state);
  assert.equal(getBatchCalls(), 2);
});

test('source-only corrections with no canonical score change show zero affected days', () => {
  const { planner } = loadCanonicalGuard();
  const state = {
    completions: [{ id: 'a', dayKey: '2026-07-29', points: 4, source: 'habit' }],
    matchups: [],
    plan: {
      sourceUpdates: [{ completionIndex: 0, completionId: 'a', dayKey: '2026-07-29', toSource: 'vice' }],
      failedDateRemovals: [],
      duplicateRemovals: [],
      manualReview: [],
      pointsRemoved: 0
    }
  };
  const impact = planner.buildHabitLedgerRepairPlan(state).matchupImpact;
  assert.equal(impact.affectedDays, 0);
  assert.equal(impact.hasBlockingImpact, false);
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

test('canonical implementation uses the shared batch scorer instead of per-date snapshots', () => {
  assert.match(canonicalSource, /core\.youDailyTotalsWithInertia/);
  assert.match(canonicalSource, /buildCanonicalScoreMaps/);
  assert.match(canonicalSource, /matchupsByDay\.forEach/);
  assert.doesNotMatch(canonicalSource, /core\.buildDaySnapshot/);
  assert.doesNotMatch(canonicalSource, /core\.computeDayTotals/);
  assert.doesNotMatch(canonicalSource, /Math\.abs\(Number\(item\.points\)\) > 0\.05/);
});
