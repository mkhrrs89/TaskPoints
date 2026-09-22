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

function legacyState() {
  return {
    habits: [{
      id: 'h1',
      name: 'Read',
      pointsPerDay: 6,
      doneKeys: [],
      failedKeys: [],
      iceKeys: []
    }],
    completions: [],
    tasks: [{ id: 't1', title: 'Must remain legacy-owned' }]
  };
}

function installRuntime(indexedDB, localStorage, label) {
  let uuid = 0;
  const core = {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(input) { return { ...input }; }
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
    crypto: { randomUUID() { uuid += 1; return `${label}-${uuid}`; } },
    TaskPointsCore: core,
    document: { readyState: 'loading', addEventListener() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: `state_runtime_v2_${label}.js` });
  return context.TaskPointsStateRuntimeV2;
}

function delta() {
  return {
    id: 'habit:h1:2026-09-03',
    habitId: 'h1',
    dayKey: '2026-09-03',
    source: 'habit',
    status: 'full',
    done: true,
    completionFraction: 1,
    completionPoints: 6,
    updatedAtISO: '2026-09-03T14:30:00.000Z'
  };
}

function runtimeMeta(indexedDB) {
  return indexedDB.dump(DB_NAME).meta.find((row) => row.id === 'runtime');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('reload seed captures the pre-mutation legacy baseline before awaiting IndexedDB', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });

  const runtimeA = installRuntime(indexedDB, localStorage, 'capture-a');
  await runtimeA.seedFromLegacy();
  await runtimeA.applyHabitDelta(delta());
  const checkpoint = await runtimeA.buildCompatibilitySnapshot();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(checkpoint));

  const runtimeB = installRuntime(indexedDB, localStorage, 'capture-b');
  const seedPromise = runtimeB.seedFromLegacy();

  // Simulate the user adding a Habit while IndexedDB startup work is still
  // pending. The seed must keep the authority snapshot from the instant it was
  // requested, then let the explicit presence mutation mirror this later add.
  const afterAdd = JSON.parse(localStorage.getItem(LEGACY_KEY));
  afterAdd.habits.push({
    id: 'h2',
    name: 'Added While Seed Is Pending',
    pointsPerDay: 3,
    doneKeys: [],
    failedKeys: [],
    iceKeys: []
  });
  localStorage.setItem(LEGACY_KEY, JSON.stringify(afterAdd));

  const seed = await seedPromise;
  assert.equal(seed.seeded, false);
  assert.equal(seed.reason, 'verified_current');
  assert.equal(await runtimeB.getHabit('h2'), null, 'pending seed must not absorb a later user mutation into its baseline');

  const presence = await runtimeB.applyHabitPresenceSnapshot(
    runtimeB.captureHabitPresenceSnapshotFromLegacy('h2', { source: 'reload-race-test' })
  );
  assert.equal(presence.committed, true);
  assert.equal((await runtimeB.verifyParity()).match, true);
});

test('V2 preview survives repeated runtime recreation and repeated parity verification without duplicating state', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });

  const runtimeA = installRuntime(indexedDB, localStorage, 'reload-a');
  await runtimeA.seedFromLegacy();
  await runtimeA.applyHabitDelta(delta());

  const compatibility = await runtimeA.buildCompatibilitySnapshot();
  assert.equal(compatibility.tasks[0].title, 'Must remain legacy-owned');
  localStorage.setItem(LEGACY_KEY, JSON.stringify(compatibility));

  const revisionAfterMutation = runtimeMeta(indexedDB).revision;
  const beforeReloadVerification = indexedDB.dump(DB_NAME);
  const runtimeB = installRuntime(indexedDB, localStorage, 'reload-b');
  const reloadVerification = await runtimeB.seedFromLegacy();
  assert.equal(reloadVerification.seeded, false, 'reload adopts an already-correct V2 mirror instead of reseeding it');
  assert.equal(reloadVerification.reason, 'verified_current');
  assert.equal(reloadVerification.verifiedExisting, true);
  assert.equal(runtimeMeta(indexedDB).revision, revisionAfterMutation, 'read-only reload verification does not advance the mutation revision');

  const parityB1 = await runtimeB.verifyParity();
  const parityB2 = await runtimeB.verifyParity();
  assert.equal(parityB1.match, true);
  assert.equal(parityB2.match, true);
  assert.deepEqual(plain(parityB2.expectedCounts), { habits: 1, completions: 1 });
  assert.deepEqual(plain(parityB2.actualCounts), { habits: 1, completions: 1 });

  const afterB = indexedDB.dump(DB_NAME);
  assert.equal(afterB.habits[0].value.doneKeys.includes('2026-09-03'), true);
  assert.equal(afterB.completions.length, 1);
  assert.equal(afterB.mutations.length, 1, 'verified reload preserves the incremental mutation ledger');
  assert.deepEqual(
    plain(afterB.habits),
    plain(beforeReloadVerification.habits),
    'verified reload does not rewrite Habit rows'
  );
  assert.deepEqual(
    plain(afterB.completions),
    plain(beforeReloadVerification.completions),
    'verified reload does not rewrite completion rows'
  );

  const runtimeC = installRuntime(indexedDB, localStorage, 'reload-c');
  const beforeC = indexedDB.dump(DB_NAME);
  const seedC = await runtimeC.seedFromLegacy();
  const parityC = await runtimeC.verifyParity();
  const afterC = indexedDB.dump(DB_NAME);

  assert.equal(seedC.seeded, false);
  assert.equal(seedC.reason, 'already_current');
  assert.equal(parityC.match, true);
  assert.deepEqual(afterC, beforeC, 'a parity-marked reload performs no destructive rewrite');
  assert.equal(runtimeC.getStatus().readAuthority, 'legacy_only');
});


test('reload startup emits explicit non-destructive reuse evidence', () => {
  assert.match(runtimeSource, /mark\('stateV2\.seedAlreadyCurrent'/);
  assert.match(runtimeSource, /mark\('stateV2\.seedAdoptedExisting'/);
  assert.match(runtimeSource, /reason: 'already_current'/);
  assert.match(runtimeSource, /reason: 'verified_current'/);
});
