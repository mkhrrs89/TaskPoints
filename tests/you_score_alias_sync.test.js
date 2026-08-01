const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bundledSource = fs.readFileSync(path.join(__dirname, '..', 'save_pipeline_shared_work.js'), 'utf8');
const marker = ';(function installTaskPointsYouScoreAliasSync';
const markerIndex = bundledSource.indexOf(marker);
assert.notEqual(markerIndex, -1, 'YOU score alias module must be bundled after shared save work');
const source = bundledSource.slice(markerIndex);

function fixture() {
  return {
    youName: 'Miggy',
    players: [{ id: 'npc', name: 'Opponent' }],
    matchups: [
      {
        id: 'daily-a',
        dateKey: '2026-08-01',
        playerAId: 'YOU',
        playerBId: 'npc',
        scoreA: 38.24,
        scoreB: 50,
        playerAScore: 7.4,
        playerBScore: 50,
        diff: -11.76,
        result: 'Loss'
      },
      {
        id: 'npc-only',
        dateKey: '2026-08-01',
        playerAId: 'npc-2',
        playerBId: 'npc-3',
        scoreA: 20,
        scoreB: 30,
        playerAScore: 1,
        playerBScore: 2
      }
    ],
    schedule: [{
      dateKey: '2026-08-01',
      matchups: [{
        id: 'daily-a',
        dateKey: '2026-08-01',
        playerAId: 'YOU',
        playerBId: 'npc',
        scoreA: 38.24,
        scoreB: 50,
        playerAScore: 7.4,
        playerBScore: 50
      }]
    }],
    gameHistory: [{ id: 'history-safe', score: 50 }],
    currentSeason: { id: 'season-safe' },
    goldLedger: [{ id: 'gold-safe' }],
    reminders: [{ id: 'reminder-safe' }]
  };
}

function install(previousState = fixture()) {
  let persisted = structuredClone(previousState);
  let saved = null;
  let saveCalls = 0;
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    readTaskPointsStoredState() { return structuredClone(persisted); },
    loadAppState() { return { state: structuredClone(persisted) }; },
    saveStateSnapshot(state) {
      saveCalls += 1;
      persisted = structuredClone(state);
      saved = structuredClone(state);
      return { state: structuredClone(state), ok: true };
    }
  };
  const context = {
    TaskPointsCore: core,
    structuredClone,
    JSON, Object, Array, String, Number, Boolean, Promise, Error, Date, Math, Map, Set,
    console,
    globalThis: null
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'you_score_alias_sync.js' });
  return {
    api: context.TaskPointsYouScoreAliasSync,
    core,
    context,
    getSaved: () => saved,
    getPersisted: () => structuredClone(persisted),
    getSaveCalls: () => saveCalls
  };
}

test('preview identifies only stale YOU aliases and reports matching schedule copies', () => {
  const { api } = install();
  const state = fixture();
  const before = structuredClone(state);
  const plan = api.buildYouScoreAliasRepairPlan(state);

  assert.equal(plan.scannedYouSides, 1);
  assert.equal(plan.repairs.length, 1);
  assert.equal(plan.repairedMatchups, 1);
  assert.equal(plan.scheduleCopies, 1);
  assert.equal(plan.repairs[0].side, 'A');
  assert.equal(plan.repairs[0].aliasScore, 7.4);
  assert.equal(plan.repairs[0].primaryScore, 38.24);
  assert.deepEqual(state, before, 'preview must be read-only');
});

test('one-time repair changes only YOU aliases and matching schedule copies', () => {
  const { api } = install();
  const state = fixture();
  const before = structuredClone(state);
  const plan = api.buildYouScoreAliasRepairPlan(state);
  const result = api.applyYouScoreAliasRepair(state, plan);

  assert.equal(result.repairedSides, 1);
  assert.equal(result.repairedMatchups, 1);
  assert.equal(result.scheduleCopies, 1);
  assert.equal(result.skippedStale, 0);
  assert.equal(result.state.matchups[0].playerAScore, 38.24);
  assert.equal(result.state.schedule[0].matchups[0].playerAScore, 38.24);
  assert.equal(result.state.matchups[0].scoreA, before.matchups[0].scoreA);
  assert.equal(result.state.matchups[0].scoreB, before.matchups[0].scoreB);
  assert.equal(result.state.matchups[0].result, before.matchups[0].result);
  assert.equal(result.state.matchups[0].diff, before.matchups[0].diff);
  assert.deepEqual(result.state.matchups[1], before.matchups[1], 'NPC-only aliases remain untouched');
  assert.deepEqual(result.state.gameHistory, before.gameHistory);
  assert.deepEqual(result.state.currentSeason, before.currentSeason);
  assert.deepEqual(result.state.goldLedger, before.goldLedger);
  assert.deepEqual(result.state.reminders, before.reminders);
  assert.equal(result.remainingPlan.repairs.length, 0);
  assert.deepEqual(state, before, 'apply must return a repaired clone');
});

test('changed data after preview is rejected', () => {
  const { api } = install();
  const state = fixture();
  const plan = api.buildYouScoreAliasRepairPlan(state);
  const changed = structuredClone(state);
  changed.matchups[0].scoreA = 39;
  assert.throws(
    () => api.applyYouScoreAliasRepair(changed, plan),
    /changed after the preview/
  );
});

test('automatic guard does not silently clean unchanged history but syncs a later primary change', () => {
  const previous = fixture();
  const harness = install(previous);

  const unchanged = structuredClone(previous);
  unchanged.notes = 'unrelated save';
  harness.core.saveStateSnapshot(unchanged, { savePath: 'notes' });
  assert.equal(harness.getSaved().matchups[0].playerAScore, 7.4, 'historical stale alias stays preview-first');

  const changed = harness.getPersisted();
  changed.matchups[0].scoreA = 41.5;
  changed.schedule[0].matchups[0].scoreA = 41.5;
  harness.core.saveStateSnapshot(changed, { savePath: 'today-live-score' });
  assert.equal(harness.getSaved().matchups[0].playerAScore, 41.5);
  assert.equal(harness.getSaved().schedule[0].matchups[0].playerAScore, 41.5);
  assert.equal(harness.getSaved().matchups[0].playerBScore, 50);
  assert.equal(harness.getSaved().matchups[1].playerAScore, 1);
  assert.equal(harness.api.getStatus().automaticSynchronizedSides, 1);
});

test('automatic guard initializes a new YOU matchup alias without touching primary scores', () => {
  const previous = fixture();
  const harness = install(previous);
  const next = structuredClone(previous);
  next.matchups.push({
    id: 'new-daily',
    dateKey: '2026-08-02',
    playerAId: 'npc',
    playerBId: 'YOU',
    scoreA: 44,
    scoreB: 12.75,
    playerAScore: 44
  });
  next.schedule.push({
    dateKey: '2026-08-02',
    matchups: [{
      id: 'new-daily',
      dateKey: '2026-08-02',
      playerAId: 'npc',
      playerBId: 'YOU',
      scoreA: 44,
      scoreB: 12.75,
      playerAScore: 44
    }]
  });

  harness.core.saveStateSnapshot(next, { savePath: 'new-matchup' });
  const saved = harness.getSaved();
  const row = saved.matchups.find((item) => item.id === 'new-daily');
  const copy = saved.schedule[1].matchups[0];
  assert.equal(row.playerBScore, 12.75);
  assert.equal(copy.playerBScore, 12.75);
  assert.equal(row.scoreB, 12.75);
  assert.equal(row.scoreA, 44);
});

test('source includes preview-first Audit UI and guarded save contract', () => {
  assert.match(source, /YOU Score-Alias Repair/);
  assert.match(source, /Preview YOU Alias Repair/);
  assert.match(source, /I exported a fresh full backup/);
  assert.match(source, /audit-you-score-alias-repair/);
  assert.match(source, /document\.getElementById\('auditChecks'\)/);
  assert.match(source, /Primary scores changed: 0/);
  assert.match(source, /Winners\/results changed: 0/);
  assert.match(source, /saveStateSnapshotWithYouAliasSync/);
});
