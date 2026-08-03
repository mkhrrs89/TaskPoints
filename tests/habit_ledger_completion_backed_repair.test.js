const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'habit_ledger_completion_backed_repair.js'), 'utf8');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function basePlanner() {
  function build(state) {
    const habits = new Map((state.habits || []).map((h) => [h.id, h]));
    const sourceUpdates = [];
    const failedDateRemovals = [];
    const manualReview = [];
    (state.completions || []).forEach((row, index) => {
      if (!['habit', 'vice'].includes(row.source)) return;
      const habit = habits.get(row.habitId || row.viceId);
      if (!habit) return;
      const day = row.dayKey;
      const done = (habit.doneKeys || []).includes(day);
      const failed = (habit.failedKeys || []).includes(day);
      const iced = (habit.iceKeys || []).includes(day);
      if (failed && !done && !iced) {
        failedDateRemovals.push({ completionIndex: index, completionId: row.id, habitId: habit.id, dayKey: day, points: row.points, fingerprint: JSON.stringify(row) });
      } else if (failed && (done || iced)) {
        manualReview.push({ type: 'conflicting-ledger-status', completionIndex: index, completionId: row.id, habitId: habit.id, dayKey: day });
      } else if (!done) {
        manualReview.push({ type: 'completion-without-ledger-status', completionIndex: index, completionId: row.id, habitId: habit.id, dayKey: day });
      } else {
        const expected = habit.category === 'vice' ? 'vice' : 'habit';
        if (row.source !== expected) sourceUpdates.push({ completionIndex: index, completionId: row.id, toSource: expected });
      }
    });
    return {
      sourceUpdates,
      failedDateRemovals,
      duplicateRemovals: [],
      manualReview,
      matchupImpact: { completeImpactChain: true, hasBlockingImpact: false, blockingDays: [], affectedDays: failedDateRemovals.length }
    };
  }
  function apply(state, plan) {
    const next = clone(state);
    const removals = new Set(plan.failedDateRemovals.map((x) => x.completionIndex));
    const updates = new Map(plan.sourceUpdates.map((x) => [x.completionIndex, x.toSource]));
    next.completions = next.completions.flatMap((row, index) => {
      if (removals.has(index)) return [];
      if (updates.has(index)) return [{ ...row, source: updates.get(index) }];
      return [row];
    });
    return {
      state: next,
      sourceRowsUpdated: updates.size,
      failedRowsRemoved: removals.size,
      duplicateRowsRemoved: 0,
      skippedStale: 0
    };
  }
  return { buildHabitLedgerRepairPlan: build, applyHabitLedgerRepairPlan: apply, planFingerprint: (plan) => JSON.stringify(plan) };
}

function install() {
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
    TaskPointsCore: { STORAGE_KEY: 'taskpoints_v1', dateKey(d) { return d.toISOString().slice(0, 10); } },
    TaskPointsHabitLedgerRepair: basePlanner(),
    module: { exports: {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'habit_ledger_completion_backed_repair.js' });
  return context.TaskPointsCompletionBackedHabitRepair;
}

function fixture() {
  return {
    habits: [
      { id: 'habit-1', name: 'Study', category: 'habit', doneKeys: [], failedKeys: [], iceKeys: [] },
      { id: 'vice-1', name: 'No Weed', category: 'vice', doneKeys: [], failedKeys: ['2026-03-03'], iceKeys: [] },
      { id: 'habit-2', name: 'Art', category: 'habit', doneKeys: ['2026-04-01'], failedKeys: ['2026-04-01'], iceKeys: [] }
    ],
    completions: [
      { id: 'neutral', source: 'habit', habitId: 'habit-1', dayKey: '2026-04-02', points: 2 },
      { id: 'failed-only', source: 'vice', habitId: 'vice-1', dayKey: '2026-03-03', points: 3 },
      { id: 'conflict', source: 'habit', habitId: 'habit-2', dayKey: '2026-04-01', points: 1 },
      { id: 'neutral-vice', source: 'habit', habitId: 'vice-1', dayKey: '2026-03-04', points: 3 }
    ],
    matchups: [{ id: 'keep-matchup' }],
    gameHistory: [{ id: 'keep-history' }],
    currentSeason: { id: 'keep-season' }
  };
}

test('preview restores completion-backed doneKeys and clears corroborated failedKeys', () => {
  const api = install();
  const plan = api.buildCompletionBackedPlan(fixture());
  assert.deepEqual(Array.from(plan.doneKeyAdditions, (x) => `${x.habitId}|${x.dayKey}`), [
    'vice-1|2026-03-04',
    'habit-1|2026-04-02'
  ]);
  assert.deepEqual(Array.from(plan.failedKeyRemovals, (x) => `${x.habitId}|${x.dayKey}`), ['habit-2|2026-04-01']);
  assert.equal(plan.basePlan.failedDateRemovals.length, 1);
  assert.equal(plan.basePlan.failedDateRemovals[0].completionId, 'failed-only');
  assert.equal(plan.sourceFixes.length, 1);
  assert.equal(plan.sourceFixes[0].completionId, 'neutral-vice');
  assert.equal(plan.manualReview.length, 0);
});

test('apply changes only habits and completions and is idempotent', () => {
  const api = install();
  const state = fixture();
  const before = clone(state);
  const plan = api.buildCompletionBackedPlan(state);
  const result = api.applyCompletionBackedPlan(state, plan);

  assert.deepEqual(state, before);
  assert.deepEqual(result.state.matchups, before.matchups);
  assert.deepEqual(result.state.gameHistory, before.gameHistory);
  assert.deepEqual(result.state.currentSeason, before.currentSeason);
  assert.equal(result.state.completions.some((row) => row.id === 'failed-only'), false);
  assert.equal(result.state.completions.find((row) => row.id === 'neutral-vice').source, 'vice');
  assert.deepEqual(Array.from(result.state.habits.find((h) => h.id === 'habit-1').doneKeys), ['2026-04-02']);
  assert.deepEqual(Array.from(result.state.habits.find((h) => h.id === 'vice-1').doneKeys), ['2026-03-04']);
  assert.deepEqual(Array.from(result.state.habits.find((h) => h.id === 'habit-2').failedKeys), []);
  assert.equal(result.doneKeysAdded, 2);
  assert.equal(result.failedKeysRemoved, 1);

  const second = api.buildCompletionBackedPlan(result.state);
  assert.equal(api.fullConfirmedCount(second), 0);
  assert.equal(second.manualReview.length, 0);
});

test('doneKeys without completion rows are not converted into point rows', () => {
  const api = install();
  const state = fixture();
  state.habits[0].doneKeys.push('2026-03-01');
  const beforeCount = state.completions.length;
  const result = api.applyCompletionBackedPlan(state, api.buildCompletionBackedPlan(state));
  assert.equal(result.state.completions.length, beforeCount - 1, 'only the failed stale completion is removed');
  assert.equal(result.state.completions.some((row) => row.dayKey === '2026-03-01'), false);
});

test('nonidentical duplicate groups stay manual and are not status-repaired', () => {
  const state = fixture();
  state.completions.push({ id: 'neutral-2', source: 'habit', habitId: 'habit-1', dayKey: '2026-04-02', points: 99 });
  const base = basePlanner();
  base.buildHabitLedgerRepairPlan = function (input) {
    const plan = basePlanner().buildHabitLedgerRepairPlan(input);
    plan.manualReview.push({ type: 'nonidentical-duplicate', habitId: 'habit-1', dayKey: '2026-04-02', completionIds: ['neutral', 'neutral-2'] });
    return plan;
  };
  const context = {
    console, JSON, Date, Map, Set, Number, String, Object, Array, structuredClone: clone,
    setTimeout() { return 1; }, document: { getElementById() { return null; } },
    TaskPointsCore: { STORAGE_KEY: 'taskpoints_v1', dateKey(d) { return d.toISOString().slice(0, 10); } },
    TaskPointsHabitLedgerRepair: base, module: { exports: {} }
  };
  context.window = context; context.globalThis = context;
  vm.runInNewContext(source, context);
  const plan = context.TaskPointsCompletionBackedHabitRepair.buildCompletionBackedPlan(state);
  assert.equal(plan.doneKeyAdditions.some((x) => x.habitId === 'habit-1' && x.dayKey === '2026-04-02'), false);
  assert.equal(plan.manualReview.some((x) => x.type === 'nonidentical-duplicate'), true);
});
