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

test('pending habit delta journal synchronously coalesces and replays final off state', () => {
  storage.clear();
  const base = core.normalizeState({ habits: [{ id: 'cal', name: 'Work On Cal App', pointsPerDay: 2, doneKeys: ['2026-07-19'], failedKeys: [] }], completions: [{ id: 'habit:cal:2026-07-19', source: 'habit', habitId: 'cal', dayKey: '2026-07-19', points: 2 }] });
  core.writePendingHabitDelta({ habitId: 'cal', dayKey: '2026-07-19', source: 'habit', status: 'full', completionFraction: 1, updatedAtISO: '2026-07-20T12:00:00.000Z' });
  core.writePendingHabitDelta({ habitId: 'cal', dayKey: '2026-07-19', source: 'habit', status: 'half', completionFraction: .5, updatedAtISO: '2026-07-20T12:01:00.000Z' });
  core.writePendingHabitDelta({ habitId: 'cal', dayKey: '2026-07-19', source: 'habit', status: 'off', completionFraction: 0, updatedAtISO: '2026-07-20T12:02:00.000Z' });
  const journal = core.readPendingHabitDeltas();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].status, 'off');
  core.applyPendingHabitDeltas(base, journal);
  assert.ok(!base.habits[0].doneKeys.includes('2026-07-19'));
  assert.ok(!base.completions.some(c => c.id === 'habit:cal:2026-07-19'));
  assert.equal(core.clearCompactedHabitDeltas(journal), 1);
  assert.equal(core.readPendingHabitDeltas().length, 0);
});

test('shared loader replays exact normal, vice, and shower journal states', () => {
  storage.clear();
  const base = core.normalizeState({ habits: [
    { id: 'normal', name: 'Normal', pointsPerDay: 2, doneKeys: [], failedKeys: [] },
    { id: 'vice', name: 'Vice', category: 'vice', pointsPerDay: -3, doneKeys: [], failedKeys: [] },
    { id: 'shower', name: 'Shower', pointsPerDay: 2, doneKeys: [], failedKeys: [], iceKeys: [] }
  ], completions: [], gameHistory: [{ id: 'protected' }] });
  core.saveStateSnapshot(base, { immediateWrite: true });
  core.writePendingHabitDelta({ habitId: 'normal', dayKey: '2026-07-19', source: 'habit', status: 'half', done: true, failed: false, icy: false, completionFraction: .5, completionPoints: 1, updatedAtISO: '2026-07-19T12:00:00.000Z' });
  core.writePendingHabitDelta({ habitId: 'vice', dayKey: '2026-07-19', source: 'vice', status: 'failed', done: false, failed: true, icy: false, updatedAtISO: '2026-07-19T12:00:00.000Z' });
  core.writePendingHabitDelta({ habitId: 'shower', dayKey: '2026-07-19', source: 'habit', status: 'full', done: true, failed: false, icy: true, completionFraction: 1, completionPoints: 2.5, updatedAtISO: '2026-07-19T12:00:00.000Z' });
  const loaded = core.loadAppState({ syncDerived: false, persistSync: false }).state;
  assert.equal(loaded.habits.find(h => h.id === 'normal').doneKeys.includes('2026-07-19'), true);
  assert.equal(loaded.habits.find(h => h.id === 'vice').failedKeys.includes('2026-07-19'), true);
  const shower = loaded.habits.find(h => h.id === 'shower');
  assert.equal(shower.doneKeys.includes('2026-07-19'), true);
  assert.equal(shower.iceKeys.includes('2026-07-19'), true);
  assert.equal(loaded.completions.find(c => c.id === 'habit:shower:2026-07-19').points, 2.5);
  assert.equal(loaded.gameHistory.length, 1);
});

test('malformed journal is preserved and cannot be overwritten by a new delta', () => {
  storage.clear();
  storage.set(core.PENDING_HABIT_DELTAS_KEY, '{not json');
  assert.throws(() => core.writePendingHabitDelta({ habitId: 'h', dayKey: '2026-07-19', source: 'habit', status: 'full' }));
  assert.equal(storage.get(core.PENDING_HABIT_DELTAS_KEY), '{not json');
  storage.clear();
});

test('compaction clears only deltas applied and verified in main storage', async () => {
  storage.clear();
  const base = core.normalizeState({ habits: [{ id: 'present', name: 'Present', pointsPerDay: 3, doneKeys: [], failedKeys: [] }], completions: [] });
  core.saveStateSnapshot(base, { immediateWrite: true });
  core.writePendingHabitDelta({ habitId: 'present', dayKey: '2026-07-19', source: 'habit', status: 'full', done: true, completionFraction: 1, completionPoints: 3, updatedAtISO: '2026-07-19T12:00:00.000Z' });
  core.writePendingHabitDelta({ habitId: 'missing', dayKey: '2026-07-19', source: 'habit', status: 'full', done: true, completionFraction: 1, completionPoints: 2, updatedAtISO: '2026-07-19T12:00:00.000Z' });
  const loaded = core.loadAppState({ syncDerived: false, persistSync: false }).state;
  core.schedulePendingHabitDeltaCompaction(loaded, { delayMs: 0 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(core.readPendingHabitDeltas().map(delta => delta.habitId), ['missing']);
  const raw = storage.get(core.STORAGE_KEY);
  const persisted = core.parseTaskPointsStorageJson(raw, {});
  assert.equal(persisted.completions.find(c => c.id === core.habitCompletionId('present', '2026-07-19')).points, 3);
});

test('vice full legacy fraction and vice failed/off states verify canonically', () => {
  const habitId = 'vice-check'; const dayKey = '2026-07-19';
  const full = { id: `vice:${habitId}:${dayKey}`, habitId, dayKey, source: 'vice', status: 'full', done: true, failed: false, icy: false, completionFraction: 1, completionPoints: -2, updatedAtISO: '2026-07-19T12:00:00.000Z' };
  const persistedFull = { habits: [{ id: habitId, updatedAtISO: full.updatedAtISO, doneKeys: [dayKey], failedKeys: [], iceKeys: [] }], completions: [{ id: core.habitCompletionId(habitId, dayKey), habitId, dayKey, source: 'vice', points: -2 }] };
  assert.equal(core.verifyPersistedHabitDeltas(persistedFull, [full], [full]).length, 1);
  const failed = { ...full, status: 'failed', done: false, failed: true, completionPoints: null };
  const persistedFailed = { habits: [{ id: habitId, updatedAtISO: full.updatedAtISO, doneKeys: [], failedKeys: [dayKey], iceKeys: [] }], completions: [] };
  assert.equal(core.verifyPersistedHabitDeltas(persistedFailed, [failed], [failed]).length, 1);
  const off = { ...full, status: 'off', done: false, failed: false, completionPoints: null };
  const persistedOff = { habits: [{ id: habitId, updatedAtISO: full.updatedAtISO, doneKeys: [], failedKeys: [], iceKeys: [] }], completions: [] };
  assert.equal(core.verifyPersistedHabitDeltas(persistedOff, [off], [off]).length, 1);
});

test('three same-habit journal days compact with newest timestamp and clear together', async () => {
  storage.clear();
  const habitId = 'many-days';
  const state = core.normalizeState({ habits: [{ id: habitId, name: 'Many', pointsPerDay: 2, doneKeys: [], failedKeys: [] }], completions: [] });
  core.saveStateSnapshot(state, { immediateWrite: true });
  const days = ['2026-07-17', '2026-07-18', '2026-07-19'];
  days.forEach((dayKey, index) => core.writePendingHabitDelta({ habitId, dayKey, source: 'habit', status: index === 1 ? 'half' : 'full', done: true, failed: false, icy: false, completionFraction: index === 1 ? .5 : 1, completionPoints: index === 1 ? 1 : 2, updatedAtISO: `2026-07-${17 + index}T12:00:00.000Z` }));
  const loaded = core.loadAppState({ syncDerived: false, persistSync: false }).state;
  core.schedulePendingHabitDeltaCompaction(loaded, { delayMs: 0 });
  await new Promise(resolve => setTimeout(resolve, 10));
  const persisted = core.parseTaskPointsStorageJson(storage.get(core.STORAGE_KEY), {});
  const habit = persisted.habits.find(item => item.id === habitId);
  assert.deepEqual(habit.doneKeys.sort(), days);
  assert.equal(habit.updatedAtISO, '2026-07-19T12:00:00.000Z');
  assert.equal(persisted.completions.find(c => c.id === core.habitCompletionId(habitId, '2026-07-18')).points, 1);
  assert.equal(core.readPendingHabitDeltas().length, 0);
  assert.equal(core.loadAppState({ syncDerived: false, persistSync: false }).state.habits.find(item => item.id === habitId).updatedAtISO, '2026-07-19T12:00:00.000Z');
});

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
  assert.match(indexSource, /function handleHabitBubbleTap\([\s\S]*?applyHabitDayToggle[\s\S]*?applyCanonicalHabitBubbleVisual[\s\S]*?refreshHabitRowWeekCompleteVisual\([\s\S]*?scheduleHabitSave\(\)[\s\S]*?scheduleHabitRerender\(\)/);
  assert.match(settingsSource, /Main state is already optimized\./);
  assert.match(settingsSource, /Optimized version was not smaller\./);
  const coreSource = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  assert.match(coreSource, /addEventListener\('pagehide', flushPendingInteractiveRecompresses\)/);
  assert.match(coreSource, /visibilityState === 'hidden'/);
  assert.match(coreSource, /const criticalArrays = \['completions', 'matchups', 'gameHistory', 'seasonHistory', 'weightHistory', 'vo2MaxHistory', 'reminders', 'players', 'habits'\]/);
});

test('pending habit journals recover and compact the Work On Cal App fixture through shared loading', async () => {
  storage.clear();
  const habitId = 'work-on-cal-app';
  const dayKey = '2026-07-19';
  const state = core.normalizeState({
    habits: [{
      id: habitId,
      name: 'Work On Cal App',
      halfPointEnabled: true,
      daysPerCompleteWeek: 5,
      tag: 'Vibe Coding',
      pointsPerDay: 4,
      doneKeys: ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18'],
      updatedAtISO: '2026-07-18T12:00:00.000Z'
    }],
    completions: [
      { id: `habit:${habitId}:2026-07-17`, source: 'habit', habitId, dayKey: '2026-07-17', completionFraction: 0.5 },
      { id: `habit:${habitId}:2026-07-18`, source: 'habit', habitId, dayKey: '2026-07-18', completionFraction: 0.5 }
    ]
  });

  // Persist July 19 off, then simulate a durable journal-only tap.
  core.saveStateSnapshot(state, {
    storageKey: core.STORAGE_KEY,
    immediateWrite: true,
    userInitiated: true,
    replaceCompletions: true,
    interactive: true,
    deferCompression: true
  });
  core.writePendingHabitDelta({ habitId, dayKey, source: 'habit', status: 'full', done: true, failed: false, icy: false, completionFraction: 1, completionPoints: 4, updatedAtISO: '2026-07-19T12:00:00.000Z' });

  const reloaded = core.loadAppState({ syncDerived: false, persistSync: false }).state;
  const savedHabit = reloaded.habits.find((item) => item.id === habitId);
  assert.ok(savedHabit.doneKeys.includes(dayKey));
  assert.equal(savedHabit.updatedAtISO, '2026-07-19T12:00:00.000Z');
  assert.ok(reloaded.completions.some((item) => item.id === `habit:${habitId}:${dayKey}`));
  assert.equal(reloaded.completions.find((item) => item.id === `habit:${habitId}:${dayKey}`).points, 4);
  // The automatic startup scheduler can be invoked at zero delay in this test.
  core.schedulePendingHabitDeltaCompaction(reloaded, { delayMs: 0 });
  await new Promise(resolve => setTimeout(resolve, 10));
  const compacted = core.readTaskPointsStoredState(core.STORAGE_KEY, {});
  assert.ok(compacted.habits.find(item => item.id === habitId).doneKeys.includes(dayKey));
  assert.equal(compacted.completions.find(item => item.id === `habit:${habitId}:${dayKey}`).points, 4);
  assert.equal(core.readPendingHabitDeltas().length, 0);

  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(indexSource, /taskpoints_pending_habit_deltas_v1/);
  assert.match(indexSource, /function scheduleHabitSave\(\)[\s\S]*?\}, 3000\);/);
  assert.doesNotMatch(indexSource, /function handleHabitBubbleTap\([\s\S]*?applyHabitDayToggle[\s\S]*?savePendingHabitState\(/);
  assert.match(indexSource, /flushPendingHabitSave\('pagehide'\)/);
  assert.match(indexSource, /flushPendingHabitSave\('visibilitychange'\)/);
  assert.match(indexSource, /flushPendingHabitSave\('before-navigation'\)/);
  assert.match(indexSource, /function getTaskPointsExportSnapshot\(\) \{[\s\S]*?let latestState = state \|\| \{\}/);
});

test('completed-week stack decorations cannot intercept habit taps', () => {
  const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(stylesSource, /\.habitWeekCompleteStack::before\s*\{[\s\S]*?pointer-events:\s*none;/);
  assert.match(stylesSource, /\.habitWeekCompleteStack::after\s*\{[\s\S]*?pointer-events:\s*none;/);
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
  assert.match(indexSource, /tap->journal/);
  assert.match(indexSource, /tap->fullHabitRerender/);
  assert.match(indexSource, /tap->statsRefresh/);
});

test('canonical habit bubble visual projection clears stale classes through executable state cycles', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const match = indexSource.match(/function applyCanonicalHabitBubbleVisual\([\s\S]*?\n}\n\nfunction applyHabitBubbleStyle/);
  assert.ok(match, 'canonical visual helper is present');
  const helperSource = match[0].replace(/\nfunction applyHabitBubbleStyle$/, '');
  class ClassList {
    constructor(values = []) { this.values = new Set(values); }
    remove(...values) { values.forEach(value => this.values.delete(value)); }
    add(...values) { values.forEach(value => this.values.add(value)); }
    toggle(value, enabled) { if (enabled) this.add(value); else this.remove(value); }
    contains(value) { return this.values.has(value); }
  }
  const bubble = { classList: new ClassList(['off', 'half', 'habit-half', 'past-incomplete']), removeAttribute() {}, setAttribute() {} };
  const helper = new Function('todayKey', 'isShowerHabit', 'applyHabitBubbleStyle', `${helperSource}; return applyCanonicalHabitBubbleVisual;`)(
    () => '2026-07-20', habit => habit.name === 'Shower', () => {}
  );
  const primary = () => ['on', 'off', 'half', 'failed'].filter(value => bubble.classList.contains(value));
  const habit = { category: 'habit', name: 'Work', iceKeys: [] };
  ['on', 'half', 'off', 'on'].forEach(status => {
    helper(bubble, habit, '2026-07-20', status);
    assert.deepEqual(primary(), [status]);
    assert.equal(bubble.classList.contains('habit-half'), status === 'half');
  });
  const vice = { category: 'vice', name: 'Vice', iceKeys: [] };
  ['on', 'failed', 'off'].forEach(status => {
    helper(bubble, vice, '2026-07-19', status);
    assert.deepEqual(primary(), [status]);
    assert.equal(bubble.classList.contains('past-failed'), status === 'failed');
  });
  const shower = { category: 'habit', name: 'Shower', iceKeys: ['2026-07-20'] };
  helper(bubble, shower, '2026-07-20', 'on');
  assert.equal(bubble.classList.contains('icy'), true);
  helper(bubble, shower, '2026-07-20', 'off');
  assert.deepEqual(primary(), ['off']);
  assert.equal(bubble.classList.contains('icy'), false);
});
