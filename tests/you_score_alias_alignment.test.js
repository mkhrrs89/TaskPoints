const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'you_score_alias_alignment.js'), 'utf8');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function baseState() {
  return {
    currentSeason: {
      id: 'season_2_august_2026',
      series: {
        opening5: { id: 'season_2_august_2026_opening_round_5' }
      }
    },
    matchups: [
      {
        id: '2026-08-02_season_2_august_2026_opening_round_5_g1',
        dateKey: '2026-08-02', matchupType: 'tournament', seasonId: 'season_2_august_2026',
        seriesId: 'season_2_august_2026_opening_round_5', gameNumber: 1,
        playerAId: 'YOU', playerBId: 'bavitz',
        scoreA: 48.83, playerAScore: 38.37, scoreB: 9.2, playerBScore: 9.2
      },
      {
        id: '2026-08-03_season_2_august_2026_opening_round_5_g2',
        dateKey: '2026-08-03', matchupType: 'tournament', seasonId: 'season_2_august_2026',
        seriesId: 'season_2_august_2026_opening_round_5', gameNumber: 2,
        playerAId: 'YOU', playerBId: 'bavitz',
        scoreA: 23.81, playerAScore: 22.81, scoreB: 37.1, playerBScore: 37.1
      },
      {
        id: 'npc-conflict', dateKey: '2026-08-02', matchupType: 'tournament', seasonId: 'season_2_august_2026',
        seriesId: 'season_2_august_2026_opening_round_5',
        playerAId: 'npc-a', playerBId: 'npc-b', scoreA: 10, playerAScore: 2, scoreB: 20, playerBScore: 20
      },
      {
        id: 'old-you-conflict', dateKey: '2026-07-31', matchupType: 'tournament', seasonId: 'old-season',
        seriesId: 'old-series', playerAId: 'YOU', playerBId: 'npc-c', scoreA: 44, playerAScore: 33, scoreB: 22, playerBScore: 22
      }
    ],
    schedule: [{
      dateKey: '2026-08-03',
      matchups: [{
        id: '2026-08-03_season_2_august_2026_opening_round_5_g2',
        dateKey: '2026-08-03', matchupType: 'tournament', seasonId: 'season_2_august_2026',
        seriesId: 'season_2_august_2026_opening_round_5', gameNumber: 2,
        playerAId: 'YOU', playerBId: 'bavitz',
        scoreA: 23.81, playerAScore: 22.81, scoreB: 37.1, playerBScore: 37.1
      }]
    }]
  };
}

function makeHarness(initialState, overrides = {}) {
  const storage = new Map([['taskpoints_v1', JSON.stringify(initialState)]]);
  const saves = [];
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    parseTaskPointsStorageJson(raw, fallback) { try { return JSON.parse(raw); } catch (_) { return fallback; } },
    getRecordedSeriesId(row) { return row?.seriesId || row?.seasonSeriesId || ''; },
    syncYouMatchups(state) { return { state, changed: false }; },
    loadAppState() { return { state: JSON.parse(storage.get('taskpoints_v1')) }; },
    saveStateSnapshot(state, options) {
      saves.push({ state: clone(state), options: clone(options || {}) });
      storage.set('taskpoints_v1', JSON.stringify(state));
      return { state, options };
    },
    saveAppState(state, options) { return { state, options }; },
    mergeAndSaveState(state, options) { return { state, options }; },
    ...overrides
  };
  const context = vm.createContext({
    console, Date, Math, Number, String, JSON, Map, Set, Array, Object, structuredClone,
    setTimeout() { return 1; }, addEventListener() {},
    localStorage: {
      getItem(key) { return storage.get(String(key)) || null; },
      setItem(key, value) { storage.set(String(key), String(value)); }
    },
    TaskPointsCore: core,
    module: { exports: {} }
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'you_score_alias_alignment.js' });
  return { context, core, storage, saves };
}

test('repairs the two August YOU aliases and their schedule copy without changing canonical scores', () => {
  const state = baseState();
  const { context } = makeHarness(state);
  const result = context.TaskPointsYouScoreAliasAlignment.alignYouScoreAliases(state, { currentSeasonOnly: true });
  assert.equal(result.changed, true);
  assert.equal(result.repairedSides, 2);
  assert.equal(result.repairedMatchups, 2);
  assert.equal(result.repairedScheduleCopies, 1);
  assert.equal(result.state.matchups[0].scoreA, 48.83);
  assert.equal(result.state.matchups[0].playerAScore, 48.83);
  assert.equal(result.state.matchups[1].scoreA, 23.81);
  assert.equal(result.state.matchups[1].playerAScore, 23.81);
  assert.equal(result.state.schedule[0].matchups[0].scoreA, 23.81);
  assert.equal(result.state.schedule[0].matchups[0].playerAScore, 23.81);
});

test('one-time current-season repair leaves NPC and unrelated old-season conflicts alone', () => {
  const state = baseState();
  const { context } = makeHarness(state);
  const result = context.TaskPointsYouScoreAliasAlignment.alignYouScoreAliases(state, { currentSeasonOnly: true });
  assert.equal(result.state.matchups[2].playerAScore, 2);
  assert.equal(result.state.matchups[3].playerAScore, 33);
});

test('syncYouMatchups wrapper aligns aliases immediately when the canonical YOU score changes', () => {
  const state = baseState();
  const overrides = {
    syncYouMatchups(input) {
      const next = clone(input);
      next.matchups[1].scoreA = 25.5;
      return { state: next, changed: true };
    }
  };
  const { core } = makeHarness(state, overrides);
  const result = core.syncYouMatchups(state);
  assert.equal(result.state.matchups[1].scoreA, 25.5);
  assert.equal(result.state.matchups[1].playerAScore, 25.5);
  assert.equal(result.state.schedule[0].matchups[0].scoreA, 25.5);
  assert.equal(result.state.schedule[0].matchups[0].playerAScore, 25.5);
  assert.equal(result.changed, true);
});

test('save wrapper aligns explicit tournament YOU aliases on every save path', () => {
  const state = baseState();
  const { core, saves } = makeHarness(state);
  core.saveStateSnapshot(state, { savePath: 'habit-toggle' });
  const saved = saves.at(-1).state;
  assert.equal(saved.matchups[0].playerAScore, 48.83);
  assert.equal(saved.matchups[1].playerAScore, 23.81);
  assert.equal(saved.matchups[2].playerAScore, 2);
});

test('startup repair persists once and is idempotent', () => {
  const state = baseState();
  const { context, storage, saves } = makeHarness(state);
  assert.equal(saves.length, 1);
  const persisted = JSON.parse(storage.get('taskpoints_v1'));
  assert.equal(persisted.matchups[0].playerAScore, 48.83);
  assert.equal(persisted.matchups[1].playerAScore, 23.81);
  const second = context.TaskPointsYouScoreAliasAlignment.repairPersistedState();
  assert.equal(second.changed, false);
  assert.equal(saves.length, 1);
});
