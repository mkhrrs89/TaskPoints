const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'phase5b_deferred_mirror.js');
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const STORAGE_KEY = 'taskpoints_v1';
const JOURNAL_KEY = 'taskpoints_phase5b_pending_changes_v1';

class FakeStorage {
  constructor(initial = {}) { this.rows = new Map(Object.entries(initial).map(([k,v]) => [String(k), String(v)])); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
  key(index) { return [...this.rows.keys()][index] ?? null; }
  get length() { return this.rows.size; }
}

function clone(value) { return structuredClone(value); }
function deepMerge(base, update) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) base = {};
  if (!update || typeof update !== 'object' || Array.isArray(update)) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}
function normalize(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    ...s,
    tasks: Array.isArray(s.tasks) ? s.tasks : [], reminders: Array.isArray(s.reminders) ? s.reminders : [],
    completions: Array.isArray(s.completions) ? s.completions : [], habits: Array.isArray(s.habits) ? s.habits : [],
    players: Array.isArray(s.players) ? s.players : [], flexActions: Array.isArray(s.flexActions) ? s.flexActions : [],
    gameHistory: Array.isArray(s.gameHistory) ? s.gameHistory : [], matchups: Array.isArray(s.matchups) ? s.matchups : [],
    schedule: Array.isArray(s.schedule) ? s.schedule : [], opponentDripSchedules: Array.isArray(s.opponentDripSchedules) ? s.opponentDripSchedules : [],
    seasonHistory: Array.isArray(s.seasonHistory) ? s.seasonHistory : [], scoringSettings: s.scoringSettings || {}
  };
}
function baseState() { return normalize({ tasks: [{ id: 't1', title: 'Old' }], scoringSettings: { mood: { multiplier: 1 } } }); }

function install(options = {}) {
  const localStorage = options.localStorage || new FakeStorage({
    [STORAGE_KEY]: JSON.stringify(options.base || baseState()),
    taskpoints_phase4_storage_mode_v1: options.mode || 'indexeddb_primary',
    taskpoints_pending_habit_deltas_v1: '[]'
  });
  let phase4Cache = { status: 'passed_verification', sequence: 4, committedSequence: 4, state: baseState(), mirrorRaw: localStorage.getItem(STORAGE_KEY) };
  let nativeCache = null;
  let originalSaveCalls = 0;
  let originalValidatedCalls = 0;
  let nativeQueueCalls = 0;
  const listeners = new Map();
  const core = {
    __phase5aNativeSnapshotInstalled: true,
    STORAGE_KEY,
    PENDING_HABIT_DELTAS_KEY: 'taskpoints_pending_habit_deltas_v1',
    getPhase4StorageMode: () => localStorage.getItem('taskpoints_phase4_storage_mode_v1') || 'off',
    normalizeState: normalize,
    mergeState(next, opts = {}) { return { state: normalize(deepMerge(opts.existing || JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'), next || {})), storageKey: opts.storageKey || STORAGE_KEY }; },
    loadAppState() { return { state: normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')), storageKeysFound: [STORAGE_KEY], pendingHabitDeltas: [] }; },
    saveAppState() { originalSaveCalls++; return { state: normalize({ original: true }) }; },
    mergeAndSaveState() { originalSaveCalls++; return { state: normalize({ original: true }) }; },
    saveStateSnapshot(state) { originalSaveCalls++; localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return { state }; },
    saveValidatedSnapshot(state) { originalValidatedCalls++; localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return { state }; },
    readTaskPointsStoredState() { return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); },
    writeTaskPointsStoredState(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return localStorage.getItem(STORAGE_KEY); },
    safeReplaceTaskPointsStorage(key, raw) { localStorage.setItem(key, raw); },
    buildOptimizedTaskPointsStorageRaw(state) { const raw = JSON.stringify(state); return { chosenRaw: raw, chosenEncoding: 'plain-json' }; },
    compactStateForLocalStorage: (state) => clone(state),
    parseTaskPointsStorageJson: (raw) => JSON.parse(raw),
    getScoringSettings(state) { return state?.scoringSettings || {}; },
    getRecoveryCandidate: () => null,
    restoreBackupSlot: () => ({ restored: false }),
    getPhase4VerifiedPrimaryCache: () => phase4Cache,
    setPhase4VerifiedPrimaryCache(value) { phase4Cache = value; return value; },
    queuePhase5ANativeSnapshotWrite() {
      nativeQueueCalls++;
      nativeCache = {
        ...phase4Cache,
        state: clone(phase4Cache.state),
        mirrorRaw: localStorage.getItem(STORAGE_KEY),
        status: 'passed_verification'
      };
      return Promise.resolve(true);
    },
    flushPhase5ANativeSnapshotWrites: () => Promise.resolve(),
    getPhase5ANativeSnapshotCache: () => nativeCache,
    shadowCanonicalJson(value) {
      if (Array.isArray(value)) return `[${value.map(core.shadowCanonicalJson).join(',')}]`;
      if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${core.shadowCanonicalJson(value[k])}`).join(',')}}`;
      return JSON.stringify(value);
    },
    readPendingHabitDeltas: () => JSON.parse(localStorage.getItem('taskpoints_pending_habit_deltas_v1') || '[]'),
    applyPendingHabitDeltas: (state, deltas) => { state.pendingApplied = deltas.length; return { state }; }
  };
  const context = {
    TaskPointsCore: core,
    localStorage,
    sessionStorage: new FakeStorage(),
    Storage: FakeStorage,
    structuredClone,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    requestIdleCallback: (cb) => setTimeout(cb, 0),
    cancelIdleCallback: clearTimeout,
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    document: { visibilityState: 'visible' },
    Date, JSON, Math, Object, Array, String, Number, Boolean, Promise, Error, Set, Map, console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context, { filename: 'phase5b_deferred_mirror.js' });
  return {
    core, localStorage, context, listeners,
    originalSaveCalls: () => originalSaveCalls,
    originalValidatedCalls: () => originalValidatedCalls,
    nativeQueueCalls: () => nativeQueueCalls,
    nativeCache: () => nativeCache
  };
}

test('normal save journals synchronously, updates native state, and leaves mirror unchanged', async () => {
  const h = install();
  const before = h.localStorage.getItem(STORAGE_KEY);
  const result = h.core.saveAppState({ tasks: [{ id: 't1', title: 'New' }] }, { savePath: 'task-edit' });
  assert.equal(result.encoding, 'indexeddb-native');
  assert.equal(result.deferredMirror, true);
  assert.equal(result.state.tasks[0].title, 'New');
  assert.equal(h.localStorage.getItem(STORAGE_KEY), before);
  assert.ok(h.localStorage.getItem(JOURNAL_KEY));
  await h.core.flushPhase5BNativeWrites();
  assert.equal(h.nativeQueueCalls(), 1);
  assert.equal(h.nativeCache().state.tasks[0].title, 'New');
  assert.equal(h.originalSaveCalls(), 0);
});

test('journal reconstructs latest state synchronously after a reload before checkpoint', () => {
  const first = install();
  first.core.saveAppState({ tasks: [{ id: 't1', title: 'Recovered' }] }, { savePath: 'task-edit' });
  const second = install({ localStorage: first.localStorage, base: baseState() });
  const loaded = second.core.loadAppState({ persistSync: false });
  assert.equal(loaded.state.tasks[0].title, 'Recovered');
  assert.equal(second.core.getPhase5BStatus().journalPresent, true);
});

test('manual checkpoint writes compressed-mirror candidate and clears journal', () => {
  const h = install();
  h.core.saveAppState({ tasks: [{ id: 't1', title: 'Checkpointed' }] }, { savePath: 'task-edit' });
  assert.ok(h.localStorage.getItem(JOURNAL_KEY));
  assert.equal(h.core.flushPhase5BMirrorCheckpoint('test'), true);
  assert.equal(h.localStorage.getItem(JOURNAL_KEY), null);
  assert.equal(JSON.parse(h.localStorage.getItem(STORAGE_KEY)).tasks[0].title, 'Checkpointed');
});

test('destructive validated snapshot bypasses deferred path after checkpoint', () => {
  const h = install();
  const replacement = normalize({ tasks: [{ id: 'imported', title: 'Imported' }] });
  const result = h.core.saveValidatedSnapshot(replacement, { allowDestructiveOverwrite: true, source: 'import' });
  assert.equal(h.originalValidatedCalls(), 1);
  assert.equal(result.state.tasks[0].id, 'imported');
  assert.equal(h.localStorage.getItem(JOURNAL_KEY), null);
});

test('pagehide forces the rollback checkpoint', () => {
  const h = install();
  h.core.saveAppState({ tasks: [{ id: 't1', title: 'Hidden' }] }, { savePath: 'task-edit' });
  for (const fn of h.listeners.get('pagehide') || []) fn();
  assert.equal(h.localStorage.getItem(JOURNAL_KEY), null);
  assert.equal(JSON.parse(h.localStorage.getItem(STORAGE_KEY)).tasks[0].title, 'Hidden');
});


test('habit journal defers native write until the crash-safe journal clears', async () => {
  const h = install();
  h.localStorage.setItem('taskpoints_pending_habit_deltas_v1', JSON.stringify([{ id: 'h1', habitId: 'h1', dayKey: '2026-07-26', source: 'habit' }]));
  h.core.saveAppState({ tasks: [{ id: 't1', title: 'Habit-safe' }] }, { savePath: 'habit-toggle' });
  await h.core.flushPhase5BNativeWrites();
  assert.equal(h.nativeCache(), null);
  h.localStorage.setItem('taskpoints_pending_habit_deltas_v1', '[]');
  await h.core.flushPhase5BNativeWrites();
  assert.equal(h.nativeCache().state.tasks[0].title, 'Habit-safe');
});

test('habit journal compaction keeps the original synchronous mirror path', () => {
  const h = install();
  const state = normalize({ tasks: [{ id: 't1', title: 'Compacted' }] });
  const result = h.core.saveStateSnapshot(state, { savePath: 'habit-journal-startup-compaction', interactive: true, deferCompression: true });
  assert.equal(h.originalSaveCalls(), 1);
  assert.equal(result.state.tasks[0].title, 'Compacted');
  assert.equal(JSON.parse(h.localStorage.getItem(STORAGE_KEY)).tasks[0].title, 'Compacted');
  assert.equal(h.localStorage.getItem(JOURNAL_KEY), null);
});

test('mode off uses original save behavior', () => {
  const h = install({ mode: 'off' });
  h.core.saveAppState({ tasks: [{ id: 't1', title: 'Off' }] }, { savePath: 'task-edit' });
  assert.equal(h.originalSaveCalls(), 1);
  assert.equal(h.localStorage.getItem(JOURNAL_KEY), null);
});


test('worker installs Phase 5B only after Phase 5A is complete', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
  assert.match(worker, /'\/phase5b_deferred_mirror\.js'/);
  assert.match(worker, /completePhase5B/);
  assert.match(worker, /5b-indexeddb-native-deferred-mirror/);
  assert.match(worker, /Phase 5B deferred mirror failed to install; Phase 5A remains active/);
});
