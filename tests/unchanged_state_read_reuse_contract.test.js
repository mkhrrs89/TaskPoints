const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const coreSource = read('scoring_core.js');
const sharedSource = read('save_pipeline_shared_work.js');
const seasonSource = read('season_result_integrity_guard.js');
const clone = data => JSON.parse(JSON.stringify(data));

function storageHarness() {
  const rows = new Map();
  const storage = {
    getItem(key) { return rows.has(String(key)) ? rows.get(String(key)) : null; },
    setItem(key, value) { rows.set(String(key), String(value)); },
    removeItem(key) { rows.delete(String(key)); },
    key(i) { return Array.from(rows.keys())[i] ?? null; },
    get length() { return rows.size; }
  };
  const context = {
    localStorage: storage, document: { readyState: 'loading', addEventListener() {} },
    setTimeout() {}, clearTimeout() {}, addEventListener() {},
    location: { pathname: '/game' }, console: { log() {}, warn() {}, error() {} },
    structuredClone: clone, Date, JSON, Array, Object, Math, Set, Map
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(coreSource, context, { filename: 'scoring_core.js' });
  const core = context.TaskPointsCore;
  let parseCalls = 0;
  const originalParse = core.parseTaskPointsStorageJson.bind(core);
  core.parseTaskPointsStorageJson = (...args) => {
    parseCalls += 1;
    return originalParse(...args);
  };
  vm.runInContext(sharedSource, context, { filename: 'save_pipeline_shared_work.js' });
  return { core, storage, parseCalls: () => parseCalls };
}

test('normal state loads share an exact-byte decode without giving callers mutable shared objects', () => {
  const h = storageHarness();
  const fixture = h.core.normalizeState({
    players: [{ id: 'A', name: 'First', greed: 20 }],
    matchups: [{ id: 'old', dateKey: '2026-11-01', playerAId: 'A', playerBId: 'YOU', scoreA: 60, scoreB: 45 }],
    gameHistory: [{ id: 'old-result', playerId: 'A', score: 60, date: '2026-11-01' }],
    tasks: [{ id: 'task', title: 'Keep this' }],
    habits: [], completions: [], schedule: []
  });
  h.core.saveStateSnapshot(fixture, { immediateWrite: true });
  const unchangedRaw = h.storage.getItem(h.core.STORAGE_KEY);
  const before = h.parseCalls();
  const first = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  first.players[0].greed = 94;
  first.tasks.push({ id: 'not-saved' });
  const second = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  const third = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(h.parseCalls() - before, 1, 'a verified exact-byte snapshot is decoded only once');
  assert.equal(second.players[0].greed, 20, 'caller edits never affect the cached snapshot');
  assert.equal(third.tasks.length, 1);
  assert.equal(second.matchups.length, 1);
  assert.equal(second.gameHistory.length, 1);
  assert.equal(h.storage.getItem(h.core.STORAGE_KEY), unchangedRaw);
  assert.ok(h.core.getSharedSaveWorkStatus().parseReuseCount >= 2);
});

test('an actual storage change invalidates exact-byte parser reuse; Player journal still replays', () => {
  const h = storageHarness();
  const state = h.core.normalizeState({ players: [{ id: 'A', greed: 20 }], habits: [], tasks: [], completions: [] });
  h.core.saveStateSnapshot(state, { immediateWrite: true });
  h.core.loadAppState({ syncDerived: false, persistSync: false });
  const updated = clone(state);
  updated.players[0].greed = 32;
  h.core.saveStateSnapshot(updated, { immediateWrite: true });
  const afterSave = h.parseCalls();
  assert.equal(h.core.loadAppState({ syncDerived: false, persistSync: false }).state.players[0].greed, 32);
  assert.equal(h.parseCalls() - afterSave, 1, 'new canonical bytes require fresh decoding');
  const journalState = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  journalState.players[0].greed = 75;
  assert.equal(h.core.stagePlayerEdit(journalState, 'A').saved, true);
  const reread = h.core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(reread.players[0].greed, 75, 'journal always applies after base decode');
  assert.equal(h.core.parseTaskPointsStorageJson(h.storage.getItem(h.core.STORAGE_KEY), {}).players[0].greed, 32);
});

function seasonHarness(state) {
  const initialRaw = JSON.stringify(state);
  let raw = initialRaw;
  let todayKey = '2026-11-06';
  let parses = 0;
  let saves = 0;
  const handlers = {};
  const timers = [];
  const core = {
    STORAGE_KEY: 'taskpoints_v1',
    todayKey: () => todayKey,
    parseTaskPointsStorageJson(source) { parses += 1; return JSON.parse(source); },
    readPendingHabitDeltas() { return []; },
    readPendingPlayerEdits() { return []; },
    loadAppState() { return { state: JSON.parse(raw) }; },
    saveStateSnapshot(nextState) { saves += 1; raw = JSON.stringify(nextState); return { state: nextState }; }
  };
  const context = {
    TaskPointsCore: core,
    localStorage: { getItem(key) { return key === 'taskpoints_v1' ? raw : null; } },
    setTimeout(callback) { timers.push(callback); },
    addEventListener(name, callback) { handlers[name] = callback; },
    structuredClone: clone,
    console: { warn() {}, log() {} }, Date, JSON, Object, Array, Set, Map, Math
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(seasonSource, context, { filename: 'season_result_integrity_guard.js' });
  return {
    api: context.TaskPointsSeasonResultIntegrity,
    runDeferred() { timers.splice(0).forEach(fn => fn()); },
    pageShow() { handlers.pageshow?.(); },
    setDate(value) { todayKey = value; },
    changeStored(mutate) { const next = JSON.parse(raw); mutate(next); raw = JSON.stringify(next); },
    get parsed() { return parses; },
    get saves() { return saves; },
    get raw() { return raw; },
    initialRaw
  };
}

test('automatic season-integrity checks reuse only the same clean stored bytes and day', () => {
  const data = { matchups: [
    { id: 'old', dateKey: '2026-11-01', playerAId: 'A', playerBId: 'B' }
  ], schedule: [], gameHistory: [], seasonHistory: [] };
  const h = seasonHarness(data);
  assert.equal(h.parsed, 1);
  h.runDeferred();
  h.pageShow();
  assert.equal(h.parsed, 1, 'reopening an unchanged page does not reparse and rescan history');
  assert.equal(h.raw, h.initialRaw, 'a clean integrity check never writes the state');
  h.changeStored(s => s.matchups.push({ id: 'new', dateKey: '2026-11-02', playerAId: 'C', playerBId: 'D' }));
  h.pageShow();
  assert.equal(h.parsed, 2, 'even one changed stored byte invalidates the shortcut');
  h.setDate('2026-11-07');
  h.pageShow();
  assert.equal(h.parsed, 3, 'a new day forces a fresh season check');
  h.api.repairAuthoritativeStoredState();
  assert.equal(h.parsed, 4, 'an explicitly requested repair always rechecks');
  assert.equal(h.saves, 0);
});

test('duplicate typed/legacy slates are still fully repaired when content changes', () => {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push({ id: 't' + i, dateKey: '2026-11-05', matchupType: 'season',
      playerAId: 'a' + i, playerBId: 'b' + i });
    rows.push({ id: 'l' + i, dateKey: '2026-11-05',
      playerAId: 'a' + i, playerBId: 'b' + i });
  }
  rows.push({ id: 'previous', dateKey: '2026-11-04', playerAId: 'A', playerBId: 'B' });
  const h = seasonHarness({ matchups: rows, schedule: [], gameHistory: [], seasonHistory: [] });
  assert.equal(h.saves, 1, 'real repairs must still invoke the protected full-save function');
  const repaired = JSON.parse(h.raw);
  assert.equal(repaired.matchups.length, 5);
  assert.deepEqual(repaired.matchups.map(row => row.id), ['t0', 't1', 't2', 't3', 'previous']);
  h.runDeferred();
  h.pageShow();
  assert.equal(h.saves, 1, 'the same repaired result should never be saved twice');
});
