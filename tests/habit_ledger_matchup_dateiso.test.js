const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_matchup_impact_dateiso.js'),
  'utf8'
);

test('batched canonical dateISO coverage passes through unchanged', () => {
  const originalImpact = {
    days: [{ dayKey: '2026-07-29', status: 'result-change', blocking: true, resultChanges: true }],
    blockingDays: [{ dayKey: '2026-07-29' }],
    resultChangingDays: [{ dayKey: '2026-07-29' }],
    affectedDays: 1,
    hasBlockingImpact: true,
    includesDateISO: true,
    batchedScoreMaps: true
  };
  const planner = {
    buildHabitLedgerRepairPlan: () => ({ matchupImpact: originalImpact })
  };
  const context = { console, globalThis: null, TaskPointsHabitLedgerRepair: planner };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_ledger_matchup_impact_dateiso.js' });

  const impact = planner.buildHabitLedgerRepairPlan({}).matchupImpact;
  assert.equal(impact.includesDateISO, true);
  assert.equal(impact.batchedScoreMaps, true);
  assert.equal(impact.days.length, 1);
  assert.equal(impact.days[0].status, 'result-change');
});

test('missing batched dateISO attestation fails closed', () => {
  const planner = {
    buildHabitLedgerRepairPlan: () => ({
      pointsRemoved: 4,
      matchupImpact: {
        days: [],
        blockingDays: [],
        resultChangingDays: [],
        affectedDays: 0,
        hasBlockingImpact: false,
        includesDateISO: false,
        batchedScoreMaps: false
      }
    })
  };
  const context = { console, globalThis: null, TaskPointsHabitLedgerRepair: planner };
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const impact = planner.buildHabitLedgerRepairPlan({}).matchupImpact;
  assert.equal(impact.hasBlockingImpact, true);
  assert.equal(impact.includesDateISO, false);
  assert.equal(impact.days[0].status, 'dateiso-analysis-incomplete');
});

test('worker loads dateISO coverage verifier after canonical scoring and before score/stale guards', () => {
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
