const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => { storage.set(String(key), String(value)); },
  removeItem: (key) => { storage.delete(String(key)); },
  key: (index) => Array.from(storage.keys())[index] || null,
  get length() { return storage.size; }
};
require('../scoring_core.js');
const core = global.TaskPointsCore;

function largeState() {
  const repeated = 'Repeated history payload that compresses extremely well. '.repeat(12);
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `row-${index}`,
    title: repeated,
    note: repeated,
    date: '2026-07-19',
    completedAtISO: '2026-07-19T12:00:00.000Z',
    points: 10
  }));
  return core.normalizeState({
    tasks: rows.map((row) => ({ ...row, id: `task-${row.id}` })),
    reminders: rows.map((row) => ({ ...row, id: `reminder-${row.id}` })),
    completions: rows.map((row) => ({ ...row, id: `completion-${row.id}`, taskId: 'task-row-1' })),
    players: rows.slice(0, 4).map((row) => ({ ...row, id: `player-${row.id}`, name: row.id })),
    habits: rows.slice(0, 5).map((row) => ({ ...row, id: `habit-${row.id}` })),
    gameHistory: rows.map((row) => ({ ...row, id: `game-${row.id}`, playerId: 'player-row-0' })),
    matchups: rows.map((row) => ({ ...row, id: `matchup-${row.id}`, playerAId: 'player-row-0', playerBId: 'player-row-1' })),
    seasonHistory: rows.map((row) => ({ ...row, id: `season-${row.id}` })),
    weightHistory: rows.map((row) => ({ ...row, id: `weight-${row.id}`, weight: 180 })),
    vo2MaxHistory: rows.map((row) => ({ ...row, id: `vo2-${row.id}`, vo2Max: 42 })),
    schedule: [], opponentDripSchedules: {}, flexActions: []
  });
}

const protectedFields = ['tasks', 'reminders', 'completions', 'players', 'habits', 'gameHistory', 'matchups', 'seasonHistory', 'weightHistory', 'vo2MaxHistory'];

test('optimized storage chooses and decodes compressed packed JSON without count loss', () => {
  const state = largeState();
  const plan = core.buildOptimizedTaskPointsStorageRaw(state);
  assert.equal(plan.chosenEncoding, 'lz16-packed-v1');
  assert.ok(plan.chosenRaw.length < plan.packedRawJson.length * 0.9);
  assert.equal(core.getTaskPointsStorageEncodingInfo(plan.chosenRaw).label, 'compressed packed JSON');
  const decoded = core.parseTaskPointsStorageJson(plan.chosenRaw, {});
  protectedFields.forEach((field) => assert.equal(decoded[field].length, state[field].length, `${field} count`));
});

test('stored-state reader supports compressed, packed, and plain JSON', () => {
  const state = largeState();
  const compressed = core.buildOptimizedTaskPointsStorageRaw(state).chosenRaw;
  storage.set(core.STORAGE_KEY, compressed);
  assert.equal(core.readTaskPointsStoredState(core.STORAGE_KEY, {}).completions.length, state.completions.length);

  storage.set(core.STORAGE_KEY, JSON.stringify(core.packTaskPointsStorageState(state)));
  assert.equal(core.readTaskPointsStoredState(core.STORAGE_KEY, {}).matchups.length, state.matchups.length);

  storage.set(core.STORAGE_KEY, JSON.stringify(state));
  assert.equal(core.readTaskPointsStoredState(core.STORAGE_KEY, {}).tasks.length, state.tasks.length);
});

test('saveStateSnapshot writes compressed storage and preserves protected histories', () => {
  storage.clear();
  const state = largeState();
  core.saveStateSnapshot(state, { storageKey: core.STORAGE_KEY, immediateWrite: true });
  const raw = storage.get(core.STORAGE_KEY);
  assert.equal(core.getTaskPointsStorageEncodingInfo(raw).label, 'compressed packed JSON');
  const saved = core.parseTaskPointsStorageJson(raw, {});
  protectedFields.forEach((field) => assert.equal(saved[field].length, state[field].length, `${field} was preserved`));
});

test('interactive save writes fast packed JSON below the safe threshold and preserves protected histories', () => {
  storage.clear();
  const state = largeState();
  const result = core.saveStateSnapshot(state, { storageKey: core.STORAGE_KEY, interactive: true, deferCompression: true, immediateWrite: true });
  const raw = storage.get(core.STORAGE_KEY);
  assert.equal(result.deferredCompression, true);
  assert.equal(core.getTaskPointsStorageEncodingInfo(raw).label, 'packed JSON');
  const saved = core.parseTaskPointsStorageJson(raw, {});
  protectedFields.forEach((field) => assert.equal(saved[field].length, state[field].length, `${field} was preserved`));
  core.flushPendingInteractiveRecompresses();
  assert.equal(core.getTaskPointsStorageEncodingInfo(storage.get(core.STORAGE_KEY)).label, 'compressed packed JSON');
});

test('rapid interactive saves coalesce a latest-state idle recompress', () => {
  storage.clear();
  const first = largeState();
  const second = largeState();
  second.habits[0].name = 'latest habit value';
  core.saveStateSnapshot(first, { storageKey: core.STORAGE_KEY, interactive: true, deferCompression: true, immediateWrite: true });
  core.saveStateSnapshot(second, { storageKey: core.STORAGE_KEY, interactive: true, deferCompression: true, immediateWrite: true });
  assert.equal(core.getPendingInteractiveRecompressCount(), 1);
  core.flushPendingInteractiveRecompresses();
  assert.equal(core.getPendingInteractiveRecompressCount(), 0);
  assert.equal(core.parseTaskPointsStorageJson(storage.get(core.STORAGE_KEY), {}).habits[0].name, 'latest habit value');
});

test('failed idle recompress retains the fast packed save', () => {
  storage.clear();
  const originalSetItem = global.localStorage.setItem;
  const state = largeState();
  core.saveStateSnapshot(state, { storageKey: core.STORAGE_KEY, interactive: true, deferCompression: true, immediateWrite: true });
  const fastRaw = storage.get(core.STORAGE_KEY);
  global.localStorage.setItem = (key, value) => {
    if (String(value).includes('__taskpointsStorageEncoding')) throw new Error('background compression write failed');
    originalSetItem(key, value);
  };
  try {
    assert.equal(core.flushPendingInteractiveRecompresses(), undefined);
    assert.equal(storage.get(core.STORAGE_KEY), fastRaw);
  } finally {
    global.localStorage.setItem = originalSetItem;
  }
});

test('interactive save falls back to compressed JSON above the packed safety threshold', () => {
  storage.clear();
  const state = largeState();
  // Incompressible-ish unique task text makes the packed form exceed 3.75 MiB.
  state.tasks = Array.from({ length: 4200 }, (_, index) => ({ id: `large-${index}`, title: `${index}-${'x'.repeat(1000)}` }));
  const result = core.saveStateSnapshot(state, { storageKey: core.STORAGE_KEY, interactive: true, deferCompression: true, immediateWrite: true });
  assert.equal(result.deferredCompression, false);
  assert.equal(core.getTaskPointsStorageEncodingInfo(storage.get(core.STORAGE_KEY)).label, 'compressed packed JSON');
});

test('quota warning fallback is serialized through the optimized storage builder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.match(source, /const warningRaw = buildOptimizedTaskPointsStorageRaw\([\s\S]*?\)\.chosenRaw;/);
  assert.doesNotMatch(source, /safeReplaceTaskPointsStorage\(storageKey, JSON\.stringify\(packTaskPointsStorageState/);
});

test('TaskPoints storage uses compression and application readers do not directly parse taskpoints_v1 localStorage', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.doesNotMatch(source, /TASKPOINTS_ENABLE_COMPRESSED_STORAGE\s*=\s*false/);
  const files = fs.readdirSync(path.join(__dirname, '..')).filter((file) => /\.(?:js|html)$/.test(file) && file !== 'scoring_core.js');
  files.forEach((file) => {
    const contents = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(contents, /JSON\.parse\(\s*localStorage\.getItem\(\s*['"]taskpoints_v1['"]\s*\)\s*\)/, file);
  });
});

test('habit toggles use interactive deferred compression and Storage Health distinguishes already optimized state', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  assert.match(indexSource, /function scheduleHabitSave\(\)[\s\S]*?interactive:\s*true[\s\S]*?deferCompression:\s*true/);
  assert.match(indexSource, /function handleHabitBubbleTap\([\s\S]*?applyHabitDayToggle[\s\S]*?applyHabitBubbleStyle[\s\S]*?refreshHabitRowWeekCompleteVisual\([\s\S]*?scheduleHabitSave\(\)[\s\S]*?scheduleHabitRerender\(\)/);
  assert.match(settingsSource, /Main state is already optimized\./);
  assert.match(settingsSource, /Optimized version was not smaller\./);
  const coreSource = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.match(coreSource, /addEventListener\('pagehide', flushPendingInteractiveRecompresses\)/);
  assert.match(coreSource, /visibilityState === 'hidden'/);
  assert.match(coreSource, /const criticalArrays = \['completions', 'matchups', 'gameHistory', 'seasonHistory', 'weightHistory', 'vo2MaxHistory', 'reminders', 'players', 'habits'\]/);
});

test('habit tap rerenders defer full DOM work while preserving immediate weekly feedback', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(indexSource, /row\.dataset\.habitRowId\s*=\s*h\.id;/);
  assert.match(indexSource, /row\.dataset\.habitRowCategory\s*=\s*\(h\.category \|\| 'habit'\) === 'vice' \? 'vice' : 'habit';/);
  assert.match(indexSource, /row\.dataset\.habitRowCategory\s*=\s*'vice';/);
  assert.match(indexSource, /function refreshHabitRowWeekCompleteVisual\(row, habit, days\)[\s\S]*?habitWeekCompleteRowClasses[\s\S]*?week-complete-row[\s\S]*?addHabitWeeklyCompleteClasses/);
  assert.match(indexSource, /const stack = row\.closest\('\.habitWeekCompleteStack'\);/);
  assert.match(indexSource, /if \(!isAffectedRowWeeklyComplete && stack\) \{[\s\S]*?stack\.removeChild\(row\);[\s\S]*?stack\.(?:before|after)\(row\);[\s\S]*?if \(!stack\.children\.length\) stack\.remove\(\);/);
  assert.match(indexSource, /if \(stack\?\.isConnected\) \{[\s\S]*?stack\.children[\s\S]*?rowsToRefresh\.push\(stackRow\)/);

  assert.match(indexSource, /function scheduleHabitFullRestackRerender\(\)[\s\S]*?renderHabits\(\);[\s\S]*?renderVices\(\);[\s\S]*?renderHomeStreakBonusSidecar\(\);[\s\S]*?\}, 750\);/);
  assert.match(indexSource, /function scheduleHabitStatsRefresh\(\)[\s\S]*?\}, 1200\);/);
  assert.match(indexSource, /function scheduleHabitStatsRefresh\([\s\S]*?renderStats\(\)/);
  assert.doesNotMatch(indexSource, /function scheduleHabitFullRestackRerender\([\s\S]*?renderHabits\(\);\s*renderStats\(\);\s*renderVices\(\);/);
  const scheduleHabitRerenderSource = indexSource.match(/function scheduleHabitRerender\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(scheduleHabitRerenderSource, /scheduleHabitFullRestackRerender\(\);/);
  assert.match(scheduleHabitRerenderSource, /scheduleHabitStatsRefresh\(\);/);
  assert.doesNotMatch(scheduleHabitRerenderSource, /render(?:Habits|Stats|Vices)\(/);
  assert.match(indexSource, /tap->bubble[\s\S]*?tap->rowWeekVisual/);
  assert.match(indexSource, /tap->save/);
  assert.match(indexSource, /tap->fullHabitRerender/);
  assert.match(indexSource, /tap->statsRefresh/);
});
