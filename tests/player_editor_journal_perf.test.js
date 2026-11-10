const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const coreCode = fs.readFileSync(path.join(ROOT, 'scoring_core.js'), 'utf8');
const hotCacheCode = fs.readFileSync(path.join(ROOT, 'state_hot_cache.js'), 'utf8');
const game = fs.readFileSync(path.join(ROOT, 'game.html'), 'utf8');
const profile = fs.readFileSync(path.join(ROOT, 'player_profile.js'), 'utf8');

function install(existingStore = new Map(), { hotCache = false } = {}) {
  const calls = [];
  const storage = {
    getItem(key) { return existingStore.has(String(key)) ? existingStore.get(String(key)) : null; },
    setItem(key, value) { calls.push({ key: String(key), value: String(value) }); existingStore.set(String(key), String(value)); },
    removeItem(key) { existingStore.delete(String(key)); },
    key(i) { return Array.from(existingStore.keys())[i] ?? null; },
    get length() { return existingStore.size; }
  };
  const context = {
    localStorage: storage, console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout() { return 1; }, clearTimeout() {}, addEventListener() {},
    document: { visibilityState: 'visible', addEventListener() {} },
    Date, Math, JSON, Map, Set, String, Number, Array, Object,
    structuredClone: global.structuredClone
  };
  context.window = context; context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(coreCode, context);
  if (hotCache) vm.runInContext(hotCacheCode, context);
  return { core: context.TaskPointsCore, storage, calls, map: existingStore };
}
function base(core) {
  return core.normalizeState({
    players: [
      { id: 'A', name: 'Athlete A', active: true, greed: 20, poise: 40, momentum: 55, notes: 'Original', imageId: 'img_A' },
      { id: 'B', name: 'Athlete B', active: true, greed: 45, poise: 50 }
    ],
    completions: [{ id: 'completion-history', points: 3, completedAtISO: '2026-11-05T12:00:00Z' }],
    matchups: [{ id: 'historical-game', dateKey: '2026-11-05', playerAId: 'A', playerBId: 'B', scoreA: 60, scoreB: 50 }],
    gameHistory: [{ id: 'historical-score', date: '2026-11-05', playerId: 'A', score: 60 }],
    habits: [], tasks: [{ id: 'task-historical', title: 'Keep intact' }],
    reminders: [], flexActions: [], schedule: [], opponentDripSchedules: []
  });
}
function savedPlayer(core, storage, id) {
  return core.parseTaskPointsStorageJson(storage.getItem(core.STORAGE_KEY), {}).players.find(row => row.id === id);
}

test('Player rating is durably journaled without compressing the entire canonical snapshot', () => {
  const h = install();
  h.core.saveStateSnapshot(base(h.core), { immediateWrite: true });
  const canonical = h.storage.getItem(h.core.STORAGE_KEY);
  const edits = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  edits.players.find(p => p.id === 'A').greed = 79;
  edits.players.find(p => p.id === 'A').poise = 87;
  h.calls.length = 0;
  assert.equal(h.core.stagePlayerEdit(edits, 'A').saved, true);
  assert.equal(h.storage.getItem(h.core.STORAGE_KEY), canonical);
  assert.equal(h.calls.filter(row => row.key === h.core.STORAGE_KEY).length, 0);
  assert.equal(h.core.readPendingPlayerEdits().length, 1);
  assert.equal(h.core.loadAppState({ syncDerived: false, persistSync: false }).state.players[0].greed, 79);
  assert.equal(h.core.readTaskPointsStoredState().players[0].poise, 87);
  assert.equal(savedPlayer(h.core, h.storage, 'A').greed, 20, 'canonical is intentionally unchanged until compaction');
});

test('Rapid updates coalesce; reloading another JS context replays the same durable values', () => {
  const h = install();
  h.core.saveStateSnapshot(base(h.core), { immediateWrite: true });
  const first = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  first.players[0].greed = 70;
  assert.equal(h.core.stagePlayerEdit(first, 'A').saved, true);
  first.players[0].greed = 92;
  assert.equal(h.core.stagePlayerEdit(first, 'A').saved, true);
  first.players[1].greed = 37;
  assert.equal(h.core.stagePlayerEdit(first, 'B').saved, true);
  assert.equal(h.core.readPendingPlayerEdits().length, 2);
  const restarted = install(h.map);
  const state = restarted.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(state.players.find(x => x.id === 'A').greed, 92);
  assert.equal(state.players.find(x => x.id === 'B').greed, 37);
  assert.equal(state.gameHistory.length, 1);
  assert.equal(state.matchups.length, 1);
  assert.equal(state.tasks.length, 1);
});

test('Profile edit followed by ratings edit preserves both unsaved field sets across reload', () => {
  const h = install();
  h.core.saveStateSnapshot(base(h.core), { immediateWrite: true });
  const playerState = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  const player = playerState.players.find(row => row.id === 'A');

  player.name = 'Renamed Athlete';
  player.notes = 'New profile notes';
  player.primaryColor = '#aabbcc';
  assert.equal(h.core.stagePlayerEdit(playerState, 'A', { profile: true }).saved, true);

  player.greed = 96;
  player.poise = 73;
  assert.equal(h.core.stagePlayerEdit(playerState, 'A').saved, true);

  const journal = h.core.readPendingPlayerEdits();
  assert.equal(journal.length, 1, 'two changes should coalesce to one durable entry');
  assert.equal(journal[0].patch.name, 'Renamed Athlete');
  assert.equal(journal[0].patch.notes, 'New profile notes');
  assert.equal(journal[0].patch.greed, 96);
  const restarted = install(h.map);
  const restored = restarted.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  const loaded = restored.players.find(row => row.id === 'A');
  assert.equal(loaded.name, 'Renamed Athlete');
  assert.equal(loaded.notes, 'New profile notes');
  assert.equal(loaded.primaryColor, '#aabbcc');
  assert.equal(loaded.greed, 96);
  assert.equal(loaded.poise, 73);
  assert.equal(restored.gameHistory.length, 1);
  assert.equal(restored.matchups.length, 1);
});

test('An unrelated full save merges the journal and clears it only after readback validation', () => {
  const h = install();
  h.core.saveStateSnapshot(base(h.core), { immediateWrite: true });
  const edit = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  edit.players[0].greed = 77;
  assert.equal(h.core.stagePlayerEdit(edit, 'A').saved, true);
  const old = h.core.parseTaskPointsStorageJson(h.storage.getItem(h.core.STORAGE_KEY), {});
  const result = h.core.mergeAndSaveState({ notes: 'Updated notes', players: old.players }, { savePath: 'unrelated-feature-edit' });
  assert.equal(result.blocked, undefined);
  assert.equal(savedPlayer(h.core, h.storage, 'A').greed, 77);
  assert.equal(h.core.parseTaskPointsStorageJson(h.storage.getItem(h.core.STORAGE_KEY), {}).notes, 'Updated notes');
  assert.equal(h.core.readPendingPlayerEdits().length, 0);
  assert.equal(h.core.loadAppState({ syncDerived: false, persistSync: false }).state.gameHistory.length, 1);
});

test('A malformed or failed journal write does not delete or corrupt the primary state', () => {
  const h = install();
  h.core.saveStateSnapshot(base(h.core), { immediateWrite: true });
  const primary = h.storage.getItem(h.core.STORAGE_KEY);
  const state = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  state.players[0].poise = 95;
  const originalSet = h.storage.setItem;
  h.storage.setItem = function(key, value) {
    if (key === 'taskpoints_pending_player_edits_v1') throw new Error('QuotaExceededError');
    return originalSet.call(h.storage, key, value);
  };
  assert.equal(h.core.stagePlayerEdit(state, 'A').saved, false);
  assert.equal(h.storage.getItem(h.core.STORAGE_KEY), primary);
  h.storage.setItem = originalSet;
  h.storage.setItem('taskpoints_pending_player_edits_v1', '{corrupt');
  assert.throws(() => h.core.readPendingPlayerEdits(), /malformed/);
  assert.equal(h.storage.getItem('taskpoints_pending_player_edits_v1'), '{corrupt');
  assert.equal(h.storage.getItem(h.core.STORAGE_KEY), primary);
});

test('Player editor fast saves preserve hot-cache coherency', () => {
  const h = install(new Map(), { hotCache: true });
  h.core.saveStateSnapshot(base(h.core), { immediateWrite: true });
  const prev = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  h.core.readTaskPointsStoredState();
  const g0 = h.core.getStateHotCacheStatus().generation;
  prev.players[0].greed = 82;
  assert.equal(h.core.stagePlayerEdit(prev, 'A').saved, true);
  assert.ok(h.core.getStateHotCacheStatus().generation > g0);
  const current = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(current.players[0].greed, 82);
});

test('Other edits retain protected full-save paths and UI never stages roster or photo mutations', () => {
  assert.match(game, /const playerEditId = options\.playerRatingJournalId \|\| options\.playerProfileJournalId/);
  assert.match(game, /!imageData && wasActive === nextActive/);
  assert.match(game, /state = saveState\(result\.state\)/);
  assert.match(game, /refreshScheduleAfterRosterChange\(\)/);
  assert.match(profile, /playerRatingJournalId: id/);
  assert.match(profile, /!pidAssignment\?\.changed && wasActive === active/);
});
