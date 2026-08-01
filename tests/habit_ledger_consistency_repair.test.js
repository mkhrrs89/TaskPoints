const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repair = require('../habit_ledger_repair_planner.js');

function fixture() {
  return {
    habits: [
      {
        id: 'vice-1',
        name: 'No Late Night Eats',
        category: 'vice',
        pointsPerDay: 3,
        doneKeys: ['2026-07-28'],
        failedKeys: ['2026-07-29'],
        iceKeys: []
      },
      {
        id: 'habit-1',
        name: 'Shower',
        category: 'habit',
        pointsPerDay: 1,
        doneKeys: ['2026-01-26'],
        failedKeys: [],
        iceKeys: []
      }
    ],
    completions: [
      {
        id: 'vice-source',
        taskId: 'habit:vice-1:2026-07-28',
        title: '[Habit] No Late Night Eats (2026-07-28)',
        points: 3,
        completedAtISO: '2026-07-28T21:00:00.000Z',
        source: 'habit',
        habitId: 'vice-1',
        dayKey: '2026-07-28'
      },
      {
        id: 'vice-failed',
        taskId: 'habit:vice-1:2026-07-29',
        title: '[Habit] No Late Night Eats (2026-07-29)',
        points: 3,
        completedAtISO: '2026-07-29T21:00:00.000Z',
        source: 'vice',
        habitId: 'vice-1',
        dayKey: '2026-07-29'
      },
      {
        id: 'shower-newer',
        taskId: 'habit:habit-1:2026-01-26',
        title: '[Habit] Shower (2026-01-26)',
        points: 1,
        completedAtISO: '2026-01-26T22:29:54.915Z',
        source: 'habit',
        habitId: 'habit-1',
        dayKey: '2026-01-26'
      },
      {
        id: 'shower-older',
        taskId: 'habit:habit-1:2026-01-26',
        title: '[Habit] Shower (2026-01-26)',
        points: 1,
        completedAtISO: '2026-01-26T17:00:00.000Z',
        source: 'habit',
        habitId: 'habit-1',
        dayKey: '2026-01-26'
      },
      {
        id: 'neutral',
        taskId: 'habit:habit-1:2026-07-30',
        title: '[Habit] Shower (2026-07-30)',
        points: 1,
        completedAtISO: '2026-07-30T20:00:00.000Z',
        source: 'habit',
        habitId: 'habit-1',
        dayKey: '2026-07-30'
      }
    ],
    matchups: [{ id: 'safe-matchup' }],
    gameHistory: [{ id: 'safe-history' }],
    goldLedger: [{ id: 'safe-gold' }],
    currentSeason: { id: 'safe-season' },
    reminders: [{ id: 'safe-reminder' }]
  };
}

test('preview separates confirmed completion repairs from neutral manual review', () => {
  const plan = repair.buildHabitLedgerRepairPlan(fixture());

  assert.equal(plan.sourceUpdates.length, 1);
  assert.equal(plan.sourceUpdates[0].completionId, 'vice-source');
  assert.equal(plan.sourceUpdates[0].toSource, 'vice');

  assert.equal(plan.failedDateRemovals.length, 1);
  assert.equal(plan.failedDateRemovals[0].completionId, 'vice-failed');

  assert.equal(plan.duplicateRemovals.length, 1);
  assert.equal(plan.duplicateRemovals[0].completionId, 'shower-older');
  assert.equal(plan.duplicateRemovals[0].keepCompletionId, 'shower-newer');

  assert.equal(plan.manualReview.length, 1);
  assert.equal(plan.manualReview[0].type, 'completion-without-ledger-status');
  assert.equal(plan.manualReview[0].completionId, 'neutral');
  assert.equal(plan.pointsRemoved, 4);
});

test('apply changes completions only and remains idempotent', () => {
  const state = fixture();
  const before = structuredClone(state);
  const plan = repair.buildHabitLedgerRepairPlan(state);
  const result = repair.applyHabitLedgerRepairPlan(state, plan);

  assert.equal(result.sourceRowsUpdated, 1);
  assert.equal(result.failedRowsRemoved, 1);
  assert.equal(result.duplicateRowsRemoved, 1);
  assert.equal(result.skippedStale, 0);
  assert.equal(result.manualReviewCount, 1);

  assert.deepEqual(state, before);
  assert.deepEqual(result.state.habits, before.habits);
  assert.deepEqual(result.state.matchups, before.matchups);
  assert.deepEqual(result.state.gameHistory, before.gameHistory);
  assert.deepEqual(result.state.goldLedger, before.goldLedger);
  assert.deepEqual(result.state.currentSeason, before.currentSeason);
  assert.deepEqual(result.state.reminders, before.reminders);

  assert.equal(result.state.completions.find((row) => row.id === 'vice-source').source, 'vice');
  assert.equal(result.state.completions.some((row) => row.id === 'vice-failed'), false);
  assert.equal(result.state.completions.some((row) => row.id === 'shower-older'), false);
  assert.equal(result.state.completions.some((row) => row.id === 'shower-newer'), true);
  assert.equal(result.state.completions.some((row) => row.id === 'neutral'), true);

  const secondPlan = repair.buildHabitLedgerRepairPlan(result.state);
  assert.equal(secondPlan.sourceUpdates.length, 0);
  assert.equal(secondPlan.failedDateRemovals.length, 0);
  assert.equal(secondPlan.duplicateRemovals.length, 0);
  assert.equal(secondPlan.manualReview.length, 1);

  const second = repair.applyHabitLedgerRepairPlan(result.state, secondPlan);
  assert.equal(second.sourceRowsUpdated + second.failedRowsRemoved + second.duplicateRowsRemoved, 0);
});

test('changed live state invalidates a preview', () => {
  const state = fixture();
  const plan = repair.buildHabitLedgerRepairPlan(state);
  const changed = structuredClone(state);
  changed.completions[0].points = 99;

  assert.throws(
    () => repair.applyHabitLedgerRepairPlan(changed, plan),
    /changed after the preview/
  );
});

test('failed dates with conflicting done or ice markers remain fully manual', () => {
  const state = fixture();
  state.habits[0].doneKeys.push('2026-07-29');
  state.completions.find((row) => row.id === 'vice-failed').source = 'habit';
  const plan = repair.buildHabitLedgerRepairPlan(state);

  assert.equal(plan.failedDateRemovals.length, 0);
  assert.equal(plan.sourceUpdates.some((item) => item.completionId === 'vice-failed'), false);
  assert.equal(plan.duplicateRemovals.some((item) => item.completionId === 'vice-failed'), false);
  assert.ok(plan.manualReview.some((item) => item.type === 'conflicting-ledger-status'));
});

test('duplicate completion IDs on failed dates remain fully manual', () => {
  const state = fixture();
  state.completions = [
    {
      id: 'duplicate-failed-id',
      taskId: 'habit:vice-1:2026-07-29',
      title: '[Vice] No Late Night Eats (2026-07-29)',
      points: 3,
      completedAtISO: '2026-07-29T20:00:00.000Z',
      source: 'vice',
      habitId: 'vice-1',
      dayKey: '2026-07-29'
    },
    {
      id: 'duplicate-failed-id',
      taskId: 'habit:vice-1:2026-07-29',
      title: '[Vice] No Late Night Eats (2026-07-29)',
      points: 3,
      completedAtISO: '2026-07-29T21:00:00.000Z',
      source: 'vice',
      habitId: 'vice-1',
      dayKey: '2026-07-29'
    }
  ];

  const plan = repair.buildHabitLedgerRepairPlan(state);
  assert.ok(plan.manualReview.some((item) => item.type === 'duplicate-completion-id'));
  assert.equal(plan.failedDateRemovals.length, 0);
  assert.equal(plan.duplicateRemovals.length, 0);
  assert.equal(plan.sourceUpdates.length, 0);
});

test('timestamp fallback uses the shared local date key', () => {
  const previousCore = global.TaskPointsCore;
  let sharedDateCalls = 0;
  global.TaskPointsCore = {
    dateKey(value) {
      assert.ok(value instanceof Date);
      sharedDateCalls += 1;
      return '2026-07-29';
    }
  };

  try {
    const state = {
      habits: [{
        id: 'vice-1',
        name: 'No Late Night Eats',
        category: 'vice',
        pointsPerDay: 3,
        doneKeys: [],
        failedKeys: ['2026-07-29'],
        iceKeys: []
      }],
      completions: [{
        id: 'near-midnight',
        source: 'vice',
        habitId: 'vice-1',
        points: 3,
        completedAtISO: '2026-07-30T01:30:00.000Z'
      }]
    };

    const plan = repair.buildHabitLedgerRepairPlan(state);
    assert.ok(sharedDateCalls > 0);
    assert.equal(plan.failedDateRemovals.length, 1);
    assert.equal(plan.failedDateRemovals[0].dayKey, '2026-07-29');
  } finally {
    if (previousCore === undefined) delete global.TaskPointsCore;
    else global.TaskPointsCore = previousCore;
  }
});

test('future source guard corrects only newly added vice completions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'habit_completion_source_guard.js'), 'utf8');
  let savedState = null;
  const previous = {
    habits: [{ id: 'vice-1', name: 'No Weed', category: 'vice' }],
    completions: [{
      id: 'existing',
      source: 'habit',
      habitId: 'vice-1',
      dayKey: '2026-07-30',
      points: 3
    }]
  };
  let decoderReads = 0;
  const context = {
    console,
    structuredClone,
    JSON,
    Date,
    Map,
    Set,
    globalThis: null,
    localStorage: {
      getItem(key) {
        return key === 'taskpoints_v1'
          ? JSON.stringify({ __taskpointsStorageEncoding: 'lz16-packed-v1', payload: 'opaque' })
          : null;
      }
    },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      readTaskPointsStoredState(key, fallback) {
        decoderReads += 1;
        return key === 'taskpoints_v1' ? structuredClone(previous) : fallback;
      },
      saveStateSnapshot(state) {
        savedState = structuredClone(state);
        return { state };
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_completion_source_guard.js' });

  context.TaskPointsCore.saveStateSnapshot({
    habits: previous.habits,
    completions: [
      previous.completions[0],
      {
        id: 'new-row',
        source: 'habit',
        viceId: 'vice-1',
        dayKey: '2026-07-31',
        points: 3
      }
    ]
  }, { savePath: 'today' });

  assert.ok(decoderReads > 0, 'the packed previous snapshot is read through TaskPointsCore');
  assert.equal(savedState.completions[0].source, 'habit', 'existing rows are not silently rewritten');
  assert.equal(savedState.completions[1].source, 'vice');
  assert.equal(savedState.completions[1].habitId, 'vice-1');
});

test('panel is preview-first and requires a fresh backup confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_repair_audit.js'), 'utf8');
  assert.match(source, /Preview Habit-Ledger Repair/);
  assert.match(source, /I exported a fresh full backup of the current phone data/);
  assert.match(source, /audit-habit-ledger-consistency-repair/);
  assert.match(source, /readTaskPointsStoredState/);
  assert.match(source, /replaceCompletions:\s*true/);
  assert.match(source, /allowDestructiveOverwrite:\s*true/);
  assert.match(source, /persisted\.completions\.length !== result\.state\.completions\.length/);
  assert.match(source, /if \(!auditChecks\) return false/);
  assert.doesNotMatch(source, /querySelector\('main'\)/);
  assert.match(source, /Manual-review rows will not be changed/);
  assert.match(source, /backupCheckbox\.checked = false;[\s\S]*previewPlan = null;[\s\S]*updateEnabled\(\)/);
});

test('worker loads the repair directly on Audit and through scoring core', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /habit_ledger_repair_planner\.js\?v=20260731-1/);
  assert.match(worker, /habit_ledger_repair_audit\.js\?v=20260731-1/);
  assert.match(worker, /data-taskpoints-habit-ledger-repair="true"/);
  assert.match(worker, /readAssetSource\(env, request, '\/habit_completion_source_guard\.js'\)/);
  assert.match(worker, /x-taskpoints-habit-source-guard/);
});
