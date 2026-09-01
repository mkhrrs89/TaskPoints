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

function install() {
  const legacy = {
    habits: [{
      id: 'h1',
      name: 'Read',
      pointsPerDay: 4,
      doneKeys: [],
      failedKeys: [],
      iceKeys: []
    }],
    completions: [
      { id: 'legacy-task-completion', title: 'Preexisting task completion', points: 2, source: 'task', completedAtISO: '2026-08-31T08:00:00.000Z' }
    ],
    tasks: [{ id: 't1', title: 'Unrelated export state' }],
    settings: { theme: 'dark' }
  };
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacy)
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
    crypto: { randomUUID() { uuid += 1; return `export-${uuid}`; } },
    TaskPointsCore: core,
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  return { api: context.TaskPointsStateRuntimeV2, indexedDB, legacy };
}

function delta(dayKey, status = 'full') {
  return {
    id: `habit:h1:${dayKey}`,
    habitId: 'h1',
    dayKey,
    source: 'habit',
    status,
    done: status === 'full' || status === 'half',
    completionFraction: status === 'half' ? 0.5 : 1,
    updatedAtISO: `${dayKey}T12:00:00.000Z`
  };
}

test('V2-21 compatibility export snapshot includes every committed V2 mutation exactly once and preserves unrelated legacy state', async () => {
  const app = install();
  await app.api.seedFromLegacy();

  const first = await app.api.applyHabitDelta(delta('2026-09-01', 'full'));
  const second = await app.api.applyHabitDelta(delta('2026-09-02', 'half'));
  assert.equal(first.committed, true);
  assert.equal(second.committed, true);
  assert.equal(second.revision, first.revision + 1);

  const duplicate = await app.api.applyHabitDelta(delta('2026-09-02', 'half'));
  assert.equal(duplicate.committed, false);
  assert.equal(duplicate.duplicate, true);

  const snapshot = await app.api.buildCompatibilitySnapshot();
  const serializedExport = JSON.stringify(snapshot);
  const exported = JSON.parse(serializedExport);

  assert.deepEqual(exported.tasks, app.legacy.tasks);
  assert.deepEqual(exported.settings, app.legacy.settings);

  const habit = exported.habits.find((row) => row.id === 'h1');
  assert.deepEqual(new Set(habit.doneKeys), new Set(['2026-09-01', '2026-09-02']));

  const day1 = exported.completions.filter((row) => row.id === 'habit:h1:2026-09-01');
  const day2 = exported.completions.filter((row) => row.id === 'habit:h1:2026-09-02');
  assert.equal(day1.length, 1);
  assert.equal(day2.length, 1);
  assert.equal(day1[0].completionFraction, 1);
  assert.equal(day2[0].completionFraction, 0.5);
  assert.equal(exported.completions.some((row) => row.id === 'legacy-task-completion'), true);

  const durable = app.indexedDB.dump(DB_NAME);
  assert.equal(durable.mutations.length, 2, 'only the two unique committed V2 mutations belong in the mutation ledger');
  assert.deepEqual(
    durable.mutations.map((row) => row.revision).sort((a, b) => a - b),
    [first.revision, second.revision]
  );
  assert.equal(durable.meta.find((row) => row.id === 'runtime').revision, second.revision);
});

test('V2-21 compatibility export reads V2 habit and completion state together in one readonly transaction', () => {
  const readStart = runtimeSource.indexOf('async function readV2Collections()');
  const snapshotStart = runtimeSource.indexOf('async function buildCompatibilitySnapshot()');
  const readSource = runtimeSource.slice(readStart, snapshotStart);
  assert.match(readSource, /db\.transaction\(\['habits', 'completions'\], 'readonly'\)/);
  assert.match(readSource, /habitsRequest/);
  assert.match(readSource, /completionsRequest/);
  assert.match(readSource, /Promise\.all/);
});
