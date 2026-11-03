const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeIndexedDB, FakeStorage } = require('./helpers/fake_indexeddb_v2');

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const DB_NAME = 'taskpoints_state_v2';
const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';

function install(legacyState) {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState)
  });
  let uuid = 0;
  const core = {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(delta) { return { ...delta }; }
  };
  const context = {
    indexedDB,
    localStorage,
    structuredClone,
    JSON,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Promise,
    console: { warn() {}, log() {}, error() {} },
    crypto: { randomUUID() { uuid += 1; return `compat-${uuid}`; } },
    TaskPointsCore: core,
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return { api: context.TaskPointsStateRuntimeV2, indexedDB, localStorage };
}

function baseHabit(id, name, group, order) {
  return {
    id,
    name,
    group,
    order,
    pointsPerDay: 4,
    doneKeys: [],
    failedKeys: [],
    iceKeys: []
  };
}

test('V2-16 compatibility snapshot preserves exact legacy habit array order and stable habit shape', async () => {
  const legacy = {
    profile: { name: 'You' },
    settings: { habitSort: 'manual' },
    habits: [
      baseHabit('h-z', 'Last group first', 'zeta', 40),
      baseHabit('h-a2', 'Alpha second', 'alpha', 20),
      baseHabit('h-a1', 'Alpha first', 'alpha', 10),
      baseHabit('h-m', 'Middle', 'middle', 30)
    ],
    completions: [],
    tasks: [{ id: 't1', title: 'Unrelated state must remain' }]
  };
  const app = install(legacy);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.habits, legacy.habits);
  assert.deepEqual(snapshot.tasks, legacy.tasks);
  assert.deepEqual(snapshot.profile, legacy.profile);
  assert.deepEqual(snapshot.settings, legacy.settings);
  assert.deepEqual(snapshot.habits.map((habit) => habit.id), ['h-z', 'h-a2', 'h-a1', 'h-m']);

  const storedHabitRows = app.indexedDB.dump(DB_NAME).habits;
  assert.equal(storedHabitRows.length, legacy.habits.length);
  assert.deepEqual(
    storedHabitRows.slice().sort((a, b) => a.legacyIndex - b.legacyIndex).map((row) => row.value.id),
    legacy.habits.map((habit) => habit.id)
  );
});

test('V2-17 compatibility snapshot preserves completion order, duplicate IDs, differing duplicate payloads, and id-less rows exactly', async () => {
  const duplicateFirst = {
    id: 'duplicate-id',
    title: 'first duplicate',
    source: 'habit',
    habitId: 'h1',
    dayKey: '2026-08-30',
    points: 4,
    completedAtISO: '2026-08-30T09:00:00.000Z'
  };
  const duplicateSecond = {
    id: 'duplicate-id',
    title: 'second duplicate with different payload',
    source: 'habit',
    habitId: 'h1',
    dayKey: '2026-08-30',
    points: 99,
    completedAtISO: '2026-08-30T09:05:00.000Z'
  };
  const idless = {
    title: 'legacy malformed row without id',
    source: 'manual',
    points: 3,
    completedAtISO: '2026-08-29T10:00:00.000Z'
  };
  const legacy = {
    habits: [baseHabit('h1', 'Read', 'default', 1)],
    completions: [
      duplicateFirst,
      { id: 'unique-middle', title: 'middle', source: 'task', points: 2, completedAtISO: '2026-08-30T08:00:00.000Z' },
      duplicateSecond,
      idless,
      { id: 'unique-last', title: 'last', source: 'task', points: 1, completedAtISO: '2026-08-28T08:00:00.000Z' }
    ]
  };
  const app = install(legacy);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.completions, legacy.completions);
  assert.equal(snapshot.completions.length, 5);
  assert.equal(snapshot.completions.filter((row) => row.id === 'duplicate-id').length, 2);
  assert.equal(snapshot.completions[0].points, 4);
  assert.equal(snapshot.completions[2].points, 99);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.completions[3], 'id'), false);

  const storedRows = app.indexedDB.dump(DB_NAME).completions;
  const duplicateStorageRow = storedRows.find((row) => row.id === 'duplicate-id');
  assert.equal(Array.isArray(duplicateStorageRow.entries), true);
  assert.equal(duplicateStorageRow.entries.length, 2);
  assert.equal(app.api.getStatus().schemaVersion, 2);

  const parity = await app.api.verifyParity();
  assert.equal(parity.match, true);
  assert.equal(parity.expectedCounts.habits, 1);
  assert.equal(parity.expectedCounts.completions, 2);
  assert.equal(parity.actualCounts.habits, 1);
  assert.equal(parity.actualCounts.completions, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(parity.scopeExcludedCounts)), {
    expectedCompletions: 3,
    actualCompletions: 0
  });
});

test('V2-17 a new V2 habit completion sorts ahead of preserved unrelated duplicate legacy rows', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Read', 'default', 1)],
    completions: [
      { id: 'dup', title: 'duplicate A', source: 'task', points: 1, completedAtISO: '2026-08-20T08:00:00.000Z' },
      { id: 'dup', title: 'duplicate B', source: 'task', points: 2, completedAtISO: '2026-08-19T08:00:00.000Z' },
      { id: 'tail', title: 'tail', source: 'task', points: 3, completedAtISO: '2026-08-18T08:00:00.000Z' }
    ]
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();

  const result = await app.api.applyHabitDelta({
    id: 'habit:h1:2026-09-01',
    habitId: 'h1',
    dayKey: '2026-09-01',
    source: 'habit',
    status: 'full',
    done: true,
    updatedAtISO: '2026-09-01T12:00:00.000Z'
  });
  assert.equal(result.committed, true);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.equal(snapshot.completions[0].id, 'habit:h1:2026-09-01');
  assert.deepEqual(snapshot.completions.slice(1), legacy.completions);
  assert.equal(snapshot.completions.filter((row) => row.id === 'dup').length, 2);
});


test('parity identifies changed fields and reordered records without exposing values or repairing data', async () => {
  const initial = { habits: [baseHabit('h1', 'Read', '', 0), baseHabit('h2', 'Walk', '', 1)], completions: [] };
  const { api, localStorage, indexedDB } = install(initial);
  await api.seedFromLegacy();
  const before = JSON.stringify(indexedDB.dump(DB_NAME));
  const changed = structuredClone(initial);
  changed.habits[0].name = 'Private changed name';
  changed.habits.reverse();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(changed));
  const parity = await api.verifyParity();
  assert.equal(parity.match, false);
  assert.equal(parity.differences.collections.habits.changed, 1);
  assert.equal(parity.differences.collections.habits.moved, 2);
  const row = parity.differences.samples.find((sample) => sample.kind === 'changed');
  assert.equal(row.id, 'h1');
  assert.equal(Array.from(row.fields).join(','), 'name');
  assert.equal(JSON.stringify(parity.differences).includes('Private changed name'), false);
  assert.equal(JSON.stringify(indexedDB.dump(DB_NAME)), before);
});

test('parity diagnostics cap samples while keeping full mismatch counts', async () => {
  const initial = { habits: Array.from({ length: 40 }, (_, i) => baseHabit(`h${i}`, 'Before', '', i)), completions: [] };
  const { api, localStorage } = install(initial);
  await api.seedFromLegacy();
  initial.habits.forEach((habit) => { habit.name = 'After'; });
  localStorage.setItem(LEGACY_KEY, JSON.stringify(initial));
  const result = await api.verifyParity();
  assert.equal(result.differences.collections.habits.changed, 40);
  assert.equal(result.differences.samples.length, 20);
  assert.equal(result.differences.truncated, true);
});

test('parity ignores only the three recomputed Habit caches without changing storage or exports', async () => {
  const initial = { habits: [{ ...baseHabit('h1', 'Read', '', 0), __streak: 2, __completion: 50, __failedStreak: 0 }], completions: [] };
  const { api, localStorage, indexedDB } = install(initial);
  await api.seedFromLegacy();
  const before = JSON.stringify(indexedDB.dump(DB_NAME));
  const changed = structuredClone(initial);
  changed.habits[0].__streak = 3;
  changed.habits[0].__completion = 75;
  delete changed.habits[0].__failedStreak;
  const raw = JSON.stringify(changed);
  localStorage.setItem(LEGACY_KEY, raw);
  const result = await api.verifyParity();
  assert.equal(result.match, true);
  assert.equal(result.expectedHash, result.actualHash);
  assert.equal(result.differences, null);
  assert.equal(result.ignoredDerivedCacheDifferences.records, 1);
  assert.equal(result.ignoredDerivedCacheDifferences.fields.__failedStreak, 1);
  assert.equal(localStorage.getItem(LEGACY_KEY), raw);
  assert.equal(JSON.stringify(indexedDB.dump(DB_NAME)), before);
  assert.equal((await api.buildCompatibilitySnapshot()).habits[0].__streak, 2);
});

test('Habit timestamps, unknown double-underscore fields and every completion field remain strict', async () => {
  const initial = { habits: [{ ...baseHabit('h1', 'Read', '', 0), updatedAtISO: '2026-09-12T12:00:00.000Z' }], completions: [{ id: 'habit:h1:2026-09-12', source: 'habit', habitId: 'h1', dayKey: '2026-09-12', points: 4, __streak: 1 }] };
  const { api, localStorage } = install(initial);
  await api.seedFromLegacy();
  initial.habits[0].updatedAtISO = '2026-09-12T12:00:01.000Z';
  initial.habits[0].__other = 7;
  initial.completions[0].__streak = 2;
  localStorage.setItem(LEGACY_KEY, JSON.stringify(initial));
  const result = await api.verifyParity();
  assert.equal(result.match, false);
  const habit = result.differences.samples.find((row) => row.collection === 'habits');
  assert.equal(habit.fields.includes('updatedAtISO'), true);
  assert.equal(habit.fields.includes('__other'), true);
  const timestamp = habit.fieldDetails.find((row) => row.field === 'updatedAtISO');
  assert.equal(timestamp.expected.value, '2026-09-12T12:00:01.000Z');
  assert.equal(timestamp.actual.value, '2026-09-12T12:00:00.000Z');
  assert.equal(result.differences.collections.completions.changed, 1);
});

test('forty-six Habit mismatches cannot crowd four completion mismatches out of the report', async () => {
  const initial = {
    habits: Array.from({ length: 46 }, (_, i) => ({ ...baseHabit(`h${i}`, 'Read', '', i), __streak: 0, updatedAtISO: 'before' })),
    completions: Array.from({ length: 4 }, (_, i) => ({ id: `habit:h${i}:2026-09-10`, source: 'habit', habitId: `h${i}`, dayKey: '2026-09-10', points: 4, title: 'Private original title' }))
  };
  const { api, localStorage } = install(initial);
  await api.seedFromLegacy();
  for (const habit of initial.habits) { habit.__streak = 1; habit.updatedAtISO = 'after'; }
  for (const completion of initial.completions) { completion.points = 8; completion.title = 'Private changed title'; }
  localStorage.setItem(LEGACY_KEY, JSON.stringify(initial));
  const result = await api.verifyParity();
  assert.equal(result.match, false);
  assert.equal(result.ignoredDerivedCacheDifferences.records, 46);
  assert.equal(result.differences.sampleCounts.habits, 20);
  assert.equal(result.differences.sampleCounts.completions, 4);
  assert.equal(result.differences.samples.length, 24);
  assert.equal(result.differences.sampleLimitPerCollection, 20);
  assert.equal(result.differences.truncated, true);
  const completion = result.differences.samples.find((row) => row.collection === 'completions');
  assert.equal(completion.fieldDetails.find((row) => row.field === 'points').expected.value, 8);
  assert.equal(completion.fieldDetails.find((row) => row.field === 'points').actual.value, 4);
  assert.equal(JSON.stringify(result).includes('Private'), false);
});

test('backdated completion retains its canonical date through legacy replay and V2, independently of tap time', async () => {
  const initial = { habits: [baseHabit('h1', 'Read', '', 1)], completions: [] };
  const { api, localStorage } = install(initial);
  await api.seedFromLegacy();
  const delta = { habitId: 'h1', dayKey: '2026-09-10', source: 'habit', status: 'full', done: true,
    updatedAtISO: '2026-09-12T21:40:08.329Z', completedAtISO: '2026-09-10T16:00:00.000Z' };
  const coreSource = fs.readFileSync(path.join(__dirname, '..', 'scoring_core.js'), 'utf8');
  const replaySource = coreSource.slice(coreSource.indexOf('  function applyPendingHabitDeltas('), coreSource.indexOf('  function verifyPersistedHabitDeltas('));
  const context = { Date, console, global: {}, habitCompletionId: (id, day) => `habit:${id}:${day}` };
  vm.runInNewContext(replaySource, context);
  const legacy = structuredClone(initial);
  context.applyPendingHabitDeltas(legacy, [delta]);
  localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
  await api.applyHabitDelta(delta);
  assert.equal((await api.verifyParity()).match, true);
  assert.equal((await api.getCompletionsForHabit('h1'))[0].completedAtISO, delta.completedAtISO);
  assert.equal((await api.getHabit('h1')).updatedAtISO, delta.updatedAtISO);
  const fallback = structuredClone(initial);
  const oldDelta = { ...delta }; delete oldDelta.completedAtISO;
  context.applyPendingHabitDeltas(fallback, [oldDelta]);
  assert.equal(fallback.completions[0].completedAtISO, delta.updatedAtISO);
});

test('V2-compat snapshot refuses a V2 revision change during its asynchronous collection read', async () => {
  const legacy = {
    profile: { name: 'Snapshot guard fixture' },
    habits: [baseHabit('h1', 'Read', 'default', 0)],
    tasks: [{ id: 't1', title: 'Preserve task' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const db = app.indexedDB._databases.get(DB_NAME);
  assert.ok(db, 'seeded V2 database exists');
  assert.ok(db._stores.get('meta').has('runtime'), 'revision metadata exists');

  // Simulate a second V2 writer committing a newer revision after the first
  // metadata read but before the separate Habit/completion read completes.
  // No V1 key or journal changes, so a V1-only guard would falsely pass.
  const originalFailure = app.indexedDB._consumeFailure.bind(app.indexedDB);
  let injected = false;
  app.indexedDB._consumeFailure = (store, operation) => {
    if (!injected && store === 'habits' && operation === 'getAll') {
      injected = true;
      const metaStore = db._stores.get('meta');
      const prior = metaStore.get('runtime');
      metaStore.set('runtime', { ...prior, revision: Number(prior.revision || 0) + 1 });
    }
    return originalFailure(store, operation);
  };

  await assert.rejects(
    app.api.buildCompatibilitySnapshot(),
    /state_runtime_v2_compatibility_v2_revision_changed_during_read/
  );
  assert.equal(injected, true, 'racing V2 metadata mutation was exercised');
  assert.deepEqual(JSON.parse(app.localStorage.getItem(LEGACY_KEY)), legacy,
    'refusal must never replace or remove the authoritative V1 snapshot');
});

test('V2 compatibility export captures metadata and collections in a single readonly transaction', async () => {
  const legacy = {
    profile: { name: 'Atomic read fixture' },
    habits: [baseHabit('h1', 'Read', 'default', 0)],
    tasks: [{ id: 't1', title: 'Unrelated task' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const db = app.indexedDB._databases.get(DB_NAME);
  const original = db.transaction.bind(db);
  const observed = [];
  db.transaction = (stores, mode = 'readonly') => {
    observed.push({ stores: Array.isArray(stores) ? [...stores] : [stores], mode });
    return original(stores, mode);
  };

  const snapshot = await app.api.buildCompatibilitySnapshot();
  assert.deepEqual(snapshot.habits, legacy.habits);
  assert.deepEqual(snapshot.tasks, legacy.tasks);
  const together = observed.filter(({ stores, mode }) =>
    mode === 'readonly' && ['habits', 'completions', 'meta'].every(store => stores.includes(store)));
  assert.equal(together.length, 1, 'metadata and both collections must be read atomically');
  assert.equal(observed.filter(({ stores }) => stores.length === 2
    && stores.includes('habits') && stores.includes('completions')).length, 0,
    'compatibility snapshot must not fetch its collections in a separate transaction');
  assert.equal(observed.filter(({ stores }) => stores.length === 1 && stores[0] === 'meta').length, 1,
    'one later meta read must still detect a post-snapshot V2 revision race');
  assert.equal(observed.some(({ mode }) => mode !== 'readonly'), false,
    'export construction must not write into the V2 database after prior seeding');
});

test('V2 compatibility export refuses missing metadata without touching authoritative V1', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Read', 'default', 0)],
    tasks: [{ id: 't1', title: 'Keep me' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  app.indexedDB._databases.get(DB_NAME)._stores.get('meta').delete('runtime');

  await assert.rejects(app.api.buildCompatibilitySnapshot(),
    /state_runtime_v2_compatibility_metadata_not_ready/);
  assert.deepEqual(JSON.parse(app.localStorage.getItem(LEGACY_KEY)), legacy);
});

test('V2 seed refuses transient V1 read denial without clearing durable V2 records', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Preserve existing Habit', 'default', 0)],
    tasks: [{ id: 't1', title: 'Preserve existing Task' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const storedBefore = app.indexedDB.dump(DB_NAME);
  const originalGet = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = key => {
    if (key === LEGACY_KEY) throw new Error('temporary_browser_storage_denial');
    return originalGet(key);
  };
  await assert.rejects(app.api.seedFromLegacy({ force: true }),
    /state_runtime_v2_legacy_snapshot_unreadable/);
  assert.deepEqual(app.indexedDB.dump(DB_NAME), storedBefore,
    'read denial must not trigger an empty-state seed or destroy mirrored data');
  assert.equal(originalGet(LEGACY_KEY), JSON.stringify(legacy));
});

test('V2 compatibility export refuses V1 access denial after inventory, not an empty export', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Read', 'default', 0)],
    tasks: [{ id: 't1', title: 'Preserve Task' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const storedBefore = app.indexedDB.dump(DB_NAME);
  const originalGet = app.localStorage.getItem.bind(app.localStorage);
  let legacyReads = 0;
  app.localStorage.getItem = key => {
    if (key === LEGACY_KEY && ++legacyReads === 2)
      throw new Error('intermittent_denied_read');
    return originalGet(key);
  };
  await assert.rejects(app.api.buildCompatibilitySnapshot(),
    /state_runtime_v2_legacy_snapshot_unreadable/);
  assert.equal(legacyReads, 2, 'failure occurs after full-origin inventory');
  assert.deepEqual(app.indexedDB.dump(DB_NAME), storedBefore);
  assert.deepEqual(JSON.parse(originalGet(LEGACY_KEY)), legacy);
});

test('V2 compatibility export rejects same-generation V1 disappearance while V2 evidence survives', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Still mirrored', 'default', 0)],
    tasks: [{ id: 't1', title: 'Not erased by temporary disappearance' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const before = app.indexedDB.dump(DB_NAME);
  app.localStorage.removeItem(LEGACY_KEY);
  await assert.rejects(app.api.buildCompatibilitySnapshot(),
    /state_runtime_v2_compatibility_legacy_missing_unverified/);
  assert.deepEqual(app.indexedDB.dump(DB_NAME), before,
    'unverified missing legacy must retain all V2 recovery evidence');
});

test('V2 compatibility export keeps verified generation-rotated empty reset behavior', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Pre-reset', 'default', 0)],
    tasks: [{ id: 't1', title: 'Pre-reset' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem('taskpoints_state_v2_generation_v1', 'new-explicit-reset-generation');
  assert.equal(JSON.stringify(await app.api.buildCompatibilitySnapshot()), '{}');
  const stored = app.indexedDB.dump(DB_NAME);
  assert.equal(stored.habits.length, 0);
  assert.equal(stored.completions.length, 0);
  assert.equal(stored.meta.find(row => row.id === 'runtime').legacyMissing, true);
});

test('V2 forced reseed cannot reinterpret same-generation V1 disappearance as reset', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Do not erase', 'default', 0)],
    tasks: [{ id: 't1', title: 'Retain task' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const original = app.indexedDB.dump(DB_NAME);
  app.localStorage.removeItem(LEGACY_KEY);
  await assert.rejects(app.api.seedFromLegacy({ force: true }), error => {
    assert.equal(error.code, 'STATE_V2_LEGACY_MISSING_PRESERVED');
    assert.equal(error.evidence.destructiveReseedBlocked, true);
    return true;
  });
  assert.deepEqual(app.indexedDB.dump(DB_NAME), original);
});

test('V2 refuses empty seeding when another tab restores V1 during async meta read', async () => {
  const original = {
    habits: [baseHabit('h1', 'Preserve before race', 'default', 0)],
    tasks: [{ id: 't1', title: 'Original Task' }],
    completions: []
  };
  const restored = {
    habits: [baseHabit('h2', 'Restored while DB opens', 'default', 0)],
    tasks: [{ id: 't2', title: 'Newer Task' }],
    completions: []
  };
  const app = install(original);
  await app.api.seedFromLegacy();
  const priorV2 = app.indexedDB.dump(DB_NAME);
  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem('taskpoints_state_v2_generation_v1', 'approved-reset-generation');
  const originalConsume = app.indexedDB._consumeFailure.bind(app.indexedDB);
  let restoredDuringRead = false;
  app.indexedDB._consumeFailure = (store, operation) => {
    if (!restoredDuringRead && store === 'meta' && operation === 'get') {
      restoredDuringRead = true;
      app.localStorage.setItem(LEGACY_KEY, JSON.stringify(restored));
    }
    return originalConsume(store, operation);
  };

  await assert.rejects(app.api.seedFromLegacy({ force: true }),
    /state_runtime_v2_empty_seed_source_restored/);
  assert.equal(restoredDuringRead, true, 'V1 must be restored after initial missing read');
  assert.deepEqual(app.indexedDB.dump(DB_NAME), priorV2,
    'never erase V2 evidence after a concurrent restore');
  assert.deepEqual(JSON.parse(app.localStorage.getItem(LEGACY_KEY)), restored);
});

test('V2 refuses empty seeding when reset generation rotates again during async read', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Retain across reset race', 'default', 0)],
    tasks: [],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const priorV2 = app.indexedDB.dump(DB_NAME);
  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem('taskpoints_state_v2_generation_v1', 'first-new-generation');
  const originalConsume = app.indexedDB._consumeFailure.bind(app.indexedDB);
  let rotated = false;
  app.indexedDB._consumeFailure = (store, operation) => {
    if (!rotated && store === 'meta' && operation === 'get') {
      rotated = true;
      app.localStorage.setItem('taskpoints_state_v2_generation_v1', 'second-new-generation');
    }
    return originalConsume(store, operation);
  };

  await assert.rejects(app.api.seedFromLegacy({ force: true }),
    /state_runtime_v2_empty_seed_context_changed/);
  assert.equal(rotated, true);
  assert.deepEqual(app.indexedDB.dump(DB_NAME), priorV2);
});

test('V2 refuses an empty seed when localStorage access is denied after initial absent read', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Keep in V2', 'default', 0)],
    tasks: [],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const priorV2 = app.indexedDB.dump(DB_NAME);
  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem('taskpoints_state_v2_generation_v1', 'new-generation');
  const originalGet = app.localStorage.getItem.bind(app.localStorage);
  let calls = 0;
  app.localStorage.getItem = key => {
    if (key === LEGACY_KEY && ++calls >= 2) throw new Error('denied_after_capture');
    return originalGet(key);
  };
  await assert.rejects(app.api.seedFromLegacy({ force: true }),
    /state_runtime_v2_empty_seed_source_unreadable/);
  assert.equal(calls >= 2, true);
  assert.deepEqual(app.indexedDB.dump(DB_NAME), priorV2);
});

test('V2 refuses an empty seed if V1 returns inside the destructive transaction', async () => {
  const legacy = {
    habits: [baseHabit('h1', 'Keep before transaction race', 'default', 0)],
    tasks: [{ id: 't1', title: 'Durable before transaction' }],
    completions: []
  };
  const app = install(legacy);
  await app.api.seedFromLegacy();
  const storedBefore = app.indexedDB.dump(DB_NAME);
  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem('taskpoints_state_v2_generation_v1', 'rotated-generation');
  const originalConsume = app.indexedDB._consumeFailure.bind(app.indexedDB);
  let metaGets = 0;
  app.indexedDB._consumeFailure = (store, operation) => {
    if (store === 'meta' && operation === 'get' && ++metaGets === 2)
      app.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    return originalConsume(store, operation);
  };
  await assert.rejects(app.api.seedFromLegacy({ force: true }),
    /state_runtime_v2_empty_seed_source_restored/);
  assert.equal(metaGets >= 2, true, 'V1 restoration must occur at the in-transaction guard');
  assert.deepEqual(app.indexedDB.dump(DB_NAME), storedBefore,
    'an aborted empty-seed transaction must leave the previous mirror unchanged');
});

async function verifiedEmptyResetApp() {
  const app = install({
    habits: [baseHabit('h1', 'Before reset', 'default', 0)],
    completions: [{
      id: 'prior-completion', source: 'habit', habitId: 'h1',
      dayKey: '2026-09-03', points: 4
    }],
    tasks: [{ id: 'task-1', title: 'Before reset' }]
  });
  await app.api.seedFromLegacy();
  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem('taskpoints_state_v2_generation_v1',
    'explicit-empty-reset-generation');
  assert.equal(JSON.stringify(await app.api.buildCompatibilitySnapshot()), '{}');
  return app;
}

for (const store of ['habits', 'completions', 'mutations']) {
  test(`V2 verified empty reset export rejects retained ${store} evidence`, async () => {
    const app = await verifiedEmptyResetApp();
    const rows = app.indexedDB._databases.get(DB_NAME)._stores.get(store);
    const evidence = store === 'habits'
      ? { id: 'stranded-habit', legacyIndex: 0, value: baseHabit('stranded-habit', 'Survived reset', 'default', 0) }
      : store === 'completions'
        ? { id: 'stranded-completion', habitIds: ['h1'], entries: [{
          value: { id: 'stranded-completion', source: 'habit',
            habitId: 'h1', dayKey: '2026-09-03', points: 4 },
          sequence: 1
        }] }
        : { id: 'stranded-mutation', kind: 'historical-write' };
    rows.set(evidence.id, evidence);
    const before = app.indexedDB.dump(DB_NAME);
    await assert.rejects(app.api.buildCompatibilitySnapshot(),
      /state_runtime_v2_compatibility_empty_evidence_retained/);
    assert.deepEqual(app.indexedDB.dump(DB_NAME), before,
      'unexpected V2 evidence must be preserved, not silently deleted');
    assert.equal(app.localStorage.getItem(LEGACY_KEY), null);
  });
}

test('V2 refuses empty reset export on a denied IndexedDB count read', async () => {
  const app = await verifiedEmptyResetApp();
  const before = app.indexedDB.dump(DB_NAME);
  app.indexedDB.failNext({
    store: 'completions', operation: 'count',
    error: new Error('indexeddb_count_denied')
  });
  await assert.rejects(app.api.buildCompatibilitySnapshot(),
    /state_runtime_v2_compatibility_empty_evidence_unreadable/);
  assert.deepEqual(app.indexedDB.dump(DB_NAME), before);
});

test('V2 refuses empty reset export when revision advances after atomic count snapshot', async () => {
  const app = await verifiedEmptyResetApp();
  const meta = app.indexedDB._databases.get(DB_NAME)._stores.get('meta');
  const originalConsume = app.indexedDB._consumeFailure.bind(app.indexedDB);
  let metaReads = 0;
  app.indexedDB._consumeFailure = (store, operation) => {
    if (store === 'meta' && operation === 'get' && ++metaReads === 2) {
      const before = meta.get('runtime');
      meta.set('runtime', { ...before, revision: Number(before.revision) + 1 });
    }
    return originalConsume(store, operation);
  };
  await assert.rejects(app.api.buildCompatibilitySnapshot(),
    /state_runtime_v2_compatibility_v2_revision_changed_during_read/);
  assert.equal(metaReads, 2);
  assert.equal(app.indexedDB.dump(DB_NAME).meta.find(r=>r.id==='runtime').legacyMissing, true);
});

test('V2 verified empty export counts stores without loading full record contents', async () => {
  const app = await verifiedEmptyResetApp();
  const originalConsume = app.indexedDB._consumeFailure.bind(app.indexedDB);
  const operations = [];
  app.indexedDB._consumeFailure = (store, operation) => {
    operations.push([store, operation]);
    return originalConsume(store, operation);
  };
  assert.equal(JSON.stringify(await app.api.buildCompatibilitySnapshot()), '{}');
  assert.deepEqual(operations.filter(([,op])=>op==='count')
    .map(([store])=>store).sort(), ['completions','habits','mutations']);
  assert.equal(operations.some(([,op])=>op==='getAll'), false,
    'verified empty exports should never deserialize all historical records');
});
