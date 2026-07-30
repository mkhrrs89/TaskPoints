const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'score_alias_consistency.js'), 'utf8');

function makeContext(initialState, pathname = '/other.html') {
  const storage = new Map([['taskpoints_v1', JSON.stringify(initialState)]]);
  let saved = null;
  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    JSON,
    Map,
    Set,
    Array,
    Object,
    structuredClone,
    setTimeout: () => 0,
    location: { pathname },
    localStorage: {
      getItem: (key) => storage.get(String(key)) || null,
      setItem: (key, value) => storage.set(String(key), String(value))
    },
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      parseTaskPointsStorageJson: (raw, fallback) => {
        try { return JSON.parse(raw); } catch (_) { return fallback; }
      },
      loadAppState: () => ({ state: JSON.parse(storage.get('taskpoints_v1')) }),
      saveStateSnapshot: (state, options) => {
        saved = structuredClone(state);
        storage.set('taskpoints_v1', JSON.stringify(state));
        return { state, options };
      }
    }
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context);
  return { context, storage, getSaved: () => saved };
}

function baseState() {
  return {
    players: [
      { id: 'A', name: 'Alpha' },
      { id: 'B', name: 'Beta' },
      { id: 'C', name: 'Gamma' }
    ],
    matchups: [
      { id: 'm1', date: '2026-04-01', playerAId: 'A', playerBId: 'B', scoreA: 10, playerAScore: -10, scoreB: 20, playerBScore: 20 },
      { id: 'm2', date: '2026-04-02', playerAId: 'C', playerBId: 'YOU', scoreA: 30, playerAScore: 99, scoreB: 40, playerBScore: 40 }
    ],
    gameHistory: [
      { id: 'h1', date: '2026-04-01', playerId: 'A', score: 10 },
      { id: 'h2', date: '2026-04-01', playerId: 'B', score: 20 },
      { id: 'h3', date: '2026-04-02', playerId: 'C', score: 99 }
    ],
    schedule: [{
      date: '2026-04-01',
      matchups: [{ id: 'm1', date: '2026-04-01', playerAId: 'A', playerBId: 'B', scoreA: 10, playerAScore: -10, scoreB: 20, playerBScore: 20 }]
    }]
  };
}

test('preview confirms primary score only when game history supports it', () => {
  const { context } = makeContext(baseState());
  const plan = context.TaskPointsScoreAliasConsistency.buildScoreAliasRepairPlan(baseState());
  assert.equal(plan.confirmed.length, 1);
  assert.equal(plan.confirmed[0].matchupId, 'm1');
  assert.equal(plan.uncertain.length, 1);
  assert.match(plan.uncertain[0].reason, /alias instead of the primary/i);
});

test('repair changes aliases and schedule copies but never primary scores', () => {
  const { context } = makeContext(baseState());
  const api = context.TaskPointsScoreAliasConsistency;
  const result = api.applyScoreAliasRepair(baseState());
  assert.equal(result.repairedSides, 1);
  assert.equal(result.repairedMatchups, 1);
  assert.equal(result.scheduleCopies, 1);
  assert.equal(result.state.matchups[0].scoreA, 10);
  assert.equal(result.state.matchups[0].playerAScore, 10);
  assert.equal(result.state.schedule[0].matchups[0].scoreA, 10);
  assert.equal(result.state.schedule[0].matchups[0].playerAScore, 10);
  assert.equal(result.state.matchups[1].playerAScore, 99);
  const second = api.applyScoreAliasRepair(result.state);
  assert.equal(second.repairedSides, 0);
});

test('Edit Scores save path syncs only primary scores changed since persisted state', () => {
  const initial = baseState();
  const { context, getSaved } = makeContext(initial);
  const edited = structuredClone(initial);
  edited.matchups[0].scoreB = 25;
  edited.gameHistory[1].score = 25;
  context.TaskPointsCore.saveStateSnapshot(edited, { savePath: 'matchups-edit-result' });
  const saved = getSaved();
  assert.equal(saved.matchups[0].playerBScore, 25);
  assert.equal(saved.schedule[0].matchups[0].scoreB, 25);
  assert.equal(saved.schedule[0].matchups[0].playerBScore, 25);
  assert.equal(saved.matchups[0].playerAScore, -10, 'unrelated historical conflict stays preview-only');
});
