const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function installSourceGuard(previousState) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'habit_completion_source_guard.js'), 'utf8');
  let savedState = null;
  const context = {
    console,
    JSON,
    Date,
    Set,
    structuredClone: clone,
    localStorage: { getItem() { return JSON.stringify({ packed: true }); } },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      readTaskPointsStoredState(key, fallback) {
        return key === 'taskpoints_v1' ? clone(previousState) : fallback;
      },
      saveStateSnapshot(state) {
        savedState = clone(state);
        return { state };
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_completion_source_guard.js' });
  return {
    core: context.TaskPointsCore,
    saved: () => savedState
  };
}

test('new completion changes only its target ledger date', () => {
  const target = '2026-08-03';
  const previous = {
    habits: [{
      id: 'vice-1',
      category: 'vice',
      doneKeys: ['bad-done', '2026-01-01', '2026-01-01'],
      failedKeys: ['bad-failed', target, target, '2026-02-02'],
      iceKeys: ['bad-ice', '2026-03-03', '2026-03-03']
    }],
    completions: [{
      id: 'existing',
      source: 'habit',
      habitId: 'vice-1',
      dayKey: '2025-12-07',
      points: 3
    }]
  };
  const harness = installSourceGuard(previous);
  const next = clone(previous);
  next.completions.push({
    id: 'new-completion',
    source: 'habit',
    viceId: 'vice-1',
    dayKey: target,
    points: 3
  });

  harness.core.saveStateSnapshot(next, { savePath: 'habit-toggle' });
  const saved = harness.saved();
  const habit = saved.habits[0];

  assert.deepEqual(
    Array.from(habit.doneKeys),
    ['bad-done', '2026-01-01', '2026-01-01', target],
    'unrelated malformed and duplicate doneKeys retain their order'
  );
  assert.deepEqual(
    Array.from(habit.failedKeys),
    ['bad-failed', '2026-02-02'],
    'only occurrences of the new completion date are removed'
  );
  assert.deepEqual(
    Array.from(habit.iceKeys),
    previous.habits[0].iceKeys,
    'iceKeys remain byte-for-byte untouched'
  );
  assert.equal(saved.completions[0].source, 'habit', 'historical completion is untouched');
  assert.equal(saved.completions[1].source, 'vice');
  assert.equal(saved.completions[1].habitId, 'vice-1');
});

test('new completion does not replace a malformed ledger container', () => {
  const previous = {
    habits: [{
      id: 'habit-1',
      category: 'habit',
      doneKeys: 'malformed-history',
      failedKeys: ['2026-08-03'],
      iceKeys: []
    }],
    completions: []
  };
  const harness = installSourceGuard(previous);
  const next = clone(previous);
  next.completions.push({
    id: 'new-completion',
    source: 'habit',
    habitId: 'habit-1',
    dayKey: '2026-08-03',
    points: 1
  });

  harness.core.saveStateSnapshot(next, {});
  const saved = harness.saved();
  assert.equal(saved.habits[0].doneKeys, 'malformed-history');
  assert.deepEqual(Array.from(saved.habits[0].failedKeys), ['2026-08-03']);
  assert.deepEqual(Array.from(saved.habits[0].iceKeys), []);
});

function installCompletionBackedRepair() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_completion_backed_repair.js'), 'utf8');

  function basePlan(state) {
    return {
      sourceUpdates: [],
      failedDateRemovals: [],
      duplicateRemovals: [],
      manualReview: [
        {
          type: 'completion-without-ledger-status',
          completionIndex: 0,
          completionId: 'missing-done',
          habitId: 'habit-a',
          dayKey: '2026-08-03'
        },
        {
          type: 'conflicting-ledger-status',
          completionIndex: 1,
          completionId: 'done-failed',
          habitId: 'habit-b',
          dayKey: '2026-08-02'
        }
      ],
      matchupImpact: {
        completeImpactChain: true,
        hasBlockingImpact: false,
        blockingDays: [],
        affectedDays: 0
      }
    };
  }

  const planner = {
    buildHabitLedgerRepairPlan: basePlan,
    applyHabitLedgerRepairPlan(state) {
      return {
        state: clone(state),
        sourceRowsUpdated: 0,
        failedRowsRemoved: 0,
        duplicateRowsRemoved: 0,
        skippedStale: 0
      };
    },
    planFingerprint(plan) {
      return JSON.stringify(plan);
    }
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
  vm.runInNewContext(source, context, { filename: 'habit_ledger_completion_backed_repair.js' });
  return context.TaskPointsCompletionBackedHabitRepair;
}

test('previewed repair preserves every unrelated ledger element and its ordering', () => {
  const api = installCompletionBackedRepair();
  const state = {
    habits: [
      {
        id: 'habit-a',
        name: 'Study',
        category: 'habit',
        doneKeys: ['bad-a', '2026-01-01', '2026-01-01'],
        failedKeys: ['bad-failed-a', '2026-01-02'],
        iceKeys: ['bad-ice-a', '2026-01-03', '2026-01-03']
      },
      {
        id: 'habit-b',
        name: 'Art',
        category: 'habit',
        doneKeys: ['2026-08-02', 'bad-b', '2026-08-02'],
        failedKeys: ['bad-failed-b', '2026-08-02', '2026-04-04', '2026-08-02'],
        iceKeys: ['bad-ice-b', '2026-05-05', '2026-05-05']
      }
    ],
    completions: [
      {
        id: 'missing-done',
        source: 'habit',
        habitId: 'habit-a',
        dayKey: '2026-08-03',
        points: 2
      },
      {
        id: 'done-failed',
        source: 'habit',
        habitId: 'habit-b',
        dayKey: '2026-08-02',
        points: 1
      }
    ],
    matchups: [{ id: 'keep-matchup' }],
    gameHistory: [{ id: 'keep-history' }],
    currentSeason: { id: 'keep-season' }
  };
  const before = clone(state);
  const preview = api.buildCompletionBackedPlan(state);
  const result = api.applyCompletionBackedPlan(state, preview);

  assert.deepEqual(state, before, 'the input remains immutable');
  assert.deepEqual(result.state.matchups, before.matchups);
  assert.deepEqual(result.state.gameHistory, before.gameHistory);
  assert.deepEqual(result.state.currentSeason, before.currentSeason);

  const habitA = result.state.habits.find((habit) => habit.id === 'habit-a');
  assert.deepEqual(
    Array.from(habitA.doneKeys),
    ['bad-a', '2026-01-01', '2026-01-01', '2026-08-03']
  );
  assert.deepEqual(Array.from(habitA.failedKeys), before.habits[0].failedKeys);
  assert.deepEqual(Array.from(habitA.iceKeys), before.habits[0].iceKeys);

  const habitB = result.state.habits.find((habit) => habit.id === 'habit-b');
  assert.deepEqual(Array.from(habitB.doneKeys), before.habits[1].doneKeys);
  assert.deepEqual(
    Array.from(habitB.failedKeys),
    ['bad-failed-b', '2026-04-04']
  );
  assert.deepEqual(Array.from(habitB.iceKeys), before.habits[1].iceKeys);

  assert.equal(result.doneKeysAdded, 1);
  assert.equal(result.failedKeysRemoved, 1);
  assert.equal(api.fullConfirmedCount(api.buildCompletionBackedPlan(result.state)), 0);
});

test('malformed ledger containers stay in manual review', () => {
  const api = installCompletionBackedRepair();
  const state = {
    habits: [{
      id: 'habit-a',
      name: 'Study',
      category: 'habit',
      doneKeys: 'malformed',
      failedKeys: [],
      iceKeys: []
    }],
    completions: [{
      id: 'missing-done',
      source: 'habit',
      habitId: 'habit-a',
      dayKey: '2026-08-03',
      points: 2
    }]
  };

  const plan = api.buildCompletionBackedPlan(state);
  assert.equal(plan.doneKeyAdditions.length, 0);
  assert.ok(plan.manualReview.some((item) => item.type === 'malformed-ledger-container'));
});

test('Audit bootstrap cache-busts both repair loader levels', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  const staleGuard = fs.readFileSync(
    path.join(__dirname, '..', 'habit_ledger_matchup_impact_stale_guard.js'),
    'utf8'
  );
  assert.match(worker, /habit_ledger_matchup_impact_stale_guard\.js\?v=20260803-2/);
  assert.doesNotMatch(worker, /habit_ledger_matchup_impact_stale_guard\.js\?v=20260801-1/);
  assert.match(staleGuard, /habit_ledger_completion_backed_repair\.js\?v=20260803-2/);
});
