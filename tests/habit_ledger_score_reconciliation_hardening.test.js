const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'habit_ledger_score_reconciliation_hardening.js'),
  'utf8'
);
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(opponentScore = 10) {
  const matchup = {
    id: 'm1', matchupId: 'm1', dateKey: '2026-04-13',
    playerAId: 'YOU', playerBId: 'npc', scoreA: 21.5, scoreB: 10,
    playerAScore: 21.5, playerBScore: 10
  };
  return {
    habits: [], completions: [],
    matchups: [matchup], schedule: [], gameHistory: [],
    currentSeason: {
      series: {
        s1: {
          playerAId: 'YOU', playerBId: 'npc',
          gameResults: [{
            matchupId: 'm1', playerAScore: 21.5, playerBScore: opponentScore,
            winnerId: 'YOU', loserId: 'npc'
          }]
        }
      }
    },
    seasonHistory: []
  };
}

function install() {
  let applyCalls = 0;
  let receivedPreview = null;
  const api = {
    installed: true,
    sameMatchup(left, right) {
      const leftId = String(left?.matchupId || left?.id || '');
      const rightId = String(right?.matchupId || right?.id || '');
      return Boolean(leftId && rightId && leftId === rightId);
    },
    rowDay(row) { return row?.dayKey || row?.dateKey || ''; },
    buildReconciliationPlan() {
      return {
        fullPlan: {}, projectedState: {}, projectedResult: {},
        scoreChanges: [{ dayKey: '2026-04-13', fromScore: 21.5, toScore: 21 }],
        scoreUpdates: [{
          dayKey: '2026-04-13', matchupId: 'm1', playerAId: 'YOU', playerBId: 'npc',
          side: 'A', fromScore: 21.5, liveCanonicalScore: 21.5, toScore: 21,
          opponentScore: 10, beforeResult: 'Win', afterResult: 'Win', historyRowCount: 0
        }],
        noMatchupDays: [], blockingIssues: [], affectedDays: 1, matchupDays: 1,
        noMatchupDayCount: 0, resultChanges: 0, canApply: true, fingerprint: 'base-fingerprint'
      };
    },
    applyReconciliationPlan(state, preview) {
      applyCalls += 1;
      receivedPreview = preview;
      return {
        state: clone(state), scoreDaysChanged: 1, matchupRowsUpdated: 1,
        historyRowsUpdated: 0, scheduleCopiesUpdated: 0, seasonCopiesUpdated: 1
      };
    }
  };
  const context = {
    console, JSON, Date, Map, Set, WeakSet, Number, String, Object, Array, Math,
    structuredClone: clone,
    setTimeout() { return 1; },
    document: { getElementById() { return null; } },
    TaskPointsCore: {},
    TaskPointsHabitLedgerScoreReconciliation: api,
    module: { exports: {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'hardening.js' });
  return {
    api,
    getApplyCalls: () => applyCalls,
    getReceivedPreview: () => receivedPreview
  };
}

test('blocks a Season copy whose own score boundary would flip', () => {
  const { api } = install();
  const plan = api.buildReconciliationPlan(fixture(21.2), {});
  assert.equal(plan.canApply, false);
  assert.equal(plan.resultChanges, 1);
  assert.equal(
    plan.blockingIssues.some((item) => item.type === 'season-copy-result-change'),
    true
  );
});

test('allows a Season copy whose own result remains unchanged', () => {
  const { api } = install();
  const plan = api.buildReconciliationPlan(fixture(10), {});
  assert.equal(plan.canApply, true);
  assert.equal(plan.blockingIssues.length, 0);
});

test('stale Season score changes invalidate the preview', () => {
  const { api, getApplyCalls } = install();
  const state = fixture(10);
  const preview = api.buildReconciliationPlan(state, {});
  state.currentSeason.series.s1.gameResults[0].playerBScore = 9.5;
  assert.throws(
    () => api.applyReconciliationPlan(state, preview, {}),
    /copied matchup, schedule, history, or Season record changed after preview/
  );
  assert.equal(getApplyCalls(), 0);
});

test('adding a matching Season result after preview invalidates the preview', () => {
  const { api, getApplyCalls } = install();
  const state = fixture(10);
  const preview = api.buildReconciliationPlan(state, {});
  state.currentSeason.series.s1.gameResults.push({
    matchupId: 'm1', playerAScore: 21.5, playerBScore: 10
  });
  assert.throws(
    () => api.applyReconciliationPlan(state, preview, {}),
    /changed after preview/
  );
  assert.equal(getApplyCalls(), 0);
});

test('schedule copy edits after preview invalidate the preview', () => {
  const { api } = install();
  const state = fixture(10);
  state.schedule = [{ dateKey: '2026-04-13', matchups: [clone(state.matchups[0])] }];
  const preview = api.buildReconciliationPlan(state, {});
  state.schedule[0].matchups[0].scoreB = 9;
  assert.throws(
    () => api.applyReconciliationPlan(state, preview, {}),
    /changed after preview/
  );
});

test('unchanged state delegates to original apply with its base fingerprint', () => {
  const { api, getApplyCalls, getReceivedPreview } = install();
  const state = fixture(10);
  const preview = api.buildReconciliationPlan(state, {});
  const result = api.applyReconciliationPlan(state, preview, {});
  assert.equal(getApplyCalls(), 1);
  assert.equal(getReceivedPreview().fingerprint, 'base-fingerprint');
  assert.equal(result.matchupRowsUpdated, 1);
});
