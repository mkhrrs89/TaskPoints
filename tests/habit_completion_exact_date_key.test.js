const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const guardSource = fs.readFileSync(
  path.join(__dirname, '..', 'habit_completion_source_guard.js'),
  'utf8'
);
const repairSource = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_completion_backed_repair.js'),
  'utf8'
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function installGuard(previous) {
  let saved = null;
  const context = {
    console,
    JSON,
    Date,
    Set,
    structuredClone: clone,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      dateKey(date) { return date.toISOString().slice(0, 10); },
      readTaskPointsStoredState() { return clone(previous); },
      saveStateSnapshot(state) {
        saved = clone(state);
        return { state };
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(guardSource, context, { filename: 'habit_completion_source_guard.js' });
  return { core: context.TaskPointsCore, saved: () => saved };
}

function installRepair() {
  const planner = {
    buildHabitLedgerRepairPlan() {
      return {
        sourceUpdates: [],
        failedDateRemovals: [],
        duplicateRemovals: [],
        manualReview: [],
        matchupImpact: {
          completeImpactChain: true,
          hasBlockingImpact: false,
          blockingDays: [],
          affectedDays: 0
        }
      };
    },
    applyHabitLedgerRepairPlan(state) {
      return {
        state: clone(state),
        sourceRowsUpdated: 0,
        failedRowsRemoved: 0,
        duplicateRowsRemoved: 0,
        skippedStale: 0
      };
    },
    planFingerprint(plan) { return JSON.stringify(plan); }
  };
  const context = {
    console,
    JSON,
    Date,
    Map,
    Set,
    Number,
    String,
    Object,
    Array,
    structuredClone: clone,
    setTimeout() { return 1; },
    document: { getElementById() { return null; } },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      dateKey(date) { return date.toISOString().slice(0, 10); }
    },
    TaskPointsHabitLedgerRepair: planner,
    module: { exports: {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(repairSource, context, {
    filename: 'habit_ledger_completion_backed_repair.js'
  });
  return context.TaskPointsCompletionBackedHabitRepair;
}

test('new-completion guard rejects prefixed datetime ledger keys and uses the timestamp date', () => {
  const previous = {
    habits: [{ id: 'habit-1', category: 'habit', doneKeys: [], failedKeys: [], iceKeys: [] }],
    completions: []
  };
  const { core, saved } = installGuard(previous);
  const next = clone(previous);
  next.completions.push({
    id: 'new-row',
    source: 'habit',
    habitId: 'habit-1',
    dayKey: '2026-08-03T12:00:00Z',
    completedAtISO: '2026-08-04T01:00:00Z',
    points: 1
  });

  core.saveStateSnapshot(next, {});

  assert.deepEqual(saved().habits[0].doneKeys, ['2026-08-04']);
  assert.equal(saved().habits[0].doneKeys.includes('2026-08-03'), false);
});

test('completion-backed repair rejects prefixed datetime ledger keys and uses the timestamp date', () => {
  const api = installRepair();
  const state = {
    habits: [{
      id: 'habit-1',
      name: 'Study',
      category: 'habit',
      doneKeys: [],
      failedKeys: [],
      iceKeys: []
    }],
    completions: [{
      id: 'existing-row',
      source: 'habit',
      habitId: 'habit-1',
      dateKey: '2026-08-03T12:00:00Z',
      completedAtISO: '2026-08-04T01:00:00Z',
      points: 1
    }]
  };

  const plan = api.buildCompletionBackedPlan(state);

  assert.deepEqual(
    Array.from(plan.doneKeyAdditions, (item) => item.dayKey),
    ['2026-08-04']
  );
  assert.equal(plan.doneKeyAdditions.some((item) => item.dayKey === '2026-08-03'), false);
});
