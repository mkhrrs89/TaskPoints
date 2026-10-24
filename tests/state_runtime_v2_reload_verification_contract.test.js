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


test('a newly explicit empty Time of Day does not wipe V2 incremental history on reload', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });

  const runtimeA = installRuntime(indexedDB, localStorage, 'time-of-day-a');
  await runtimeA.seedFromLegacy();
  await runtimeA.applyHabitDelta(delta());
  const state = await runtimeA.buildCompatibilitySnapshot();

  // Main's Home normalization starts persisting this blank default after the
  // existing V2 mirror and its WAL-backed mutation ledger were established.
  state.habits[0].timeOfDay = '';
  localStorage.setItem(LEGACY_KEY, JSON.stringify(state));
  const before = indexedDB.dump(DB_NAME);
  assert.equal(Object.prototype.hasOwnProperty.call(before.habits[0].value, 'timeOfDay'), false);
  assert.equal(before.mutations.length, 1);

  const runtimeB = installRuntime(indexedDB, localStorage, 'time-of-day-b');
  const seedB = await runtimeB.seedFromLegacy();
  const afterB = indexedDB.dump(DB_NAME);

  assert.equal(seedB.seeded, false, 'the default-only divergence does not justify a full reseed');
  assert.equal(seedB.reason, 'verified_current');
  assert.equal(seedB.verifiedExisting, true);
  assert.deepEqual(plain(afterB.habits), plain(before.habits));
  assert.deepEqual(plain(afterB.completions), plain(before.completions));
  assert.deepEqual(plain(afterB.mutations), plain(before.mutations));
  assert.equal(afterB.meta[0].revision, before.meta[0].revision);
  assert.equal((await runtimeB.verifyParity()).match, true);

  const runtimeC = installRuntime(indexedDB, localStorage, 'time-of-day-c');
  const seedC = await runtimeC.seedFromLegacy();
  assert.equal(seedC.seeded, false);
  assert.equal(seedC.reason, 'already_current');
  assert.deepEqual(plain(indexedDB.dump(DB_NAME)), plain(afterB),
    'subsequent reloads retain V2 rows and mutation evidence byte-for-byte');
});

test('reload startup emits explicit non-destructive reuse evidence', () => {
  assert.match(runtimeSource, /mark\('stateV2\.seedAlreadyCurrent'/);
  assert.match(runtimeSource, /mark\('stateV2\.seedAdoptedExisting'/);
  assert.match(runtimeSource, /reason: 'already_current'/);
  assert.match(runtimeSource, /reason: 'verified_current'/);
});


test('full seed diagnostics identify why a destructive seed occurred', () => {
  assert.match(runtimeSource, /reseedReason/);
  assert.match(runtimeSource, /'initial_bootstrap'/);
  assert.match(runtimeSource, /'generation_changed'/);
  assert.match(runtimeSource, /'schema_changed'/);
  assert.match(runtimeSource, /'previous_legacy_missing'/);
  assert.match(runtimeSource, /'parity_mismatch'/);
  assert.match(runtimeSource, /hadPreviousMeta/);
  assert.match(runtimeSource, /previousResetGeneration/);
  assert.match(runtimeSource, /parityComparedBeforeReseed/);
});


test('same-generation V1 rollback after three WAL-equivalent commits preserves V2 evidence instead of reseeding', async () => {
  const indexedDB = new FakeIndexedDB();
  const initialLegacy = legacyState();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(initialLegacy)
  });
  const runtimeA = installRuntime(indexedDB, localStorage, 'burst-protect-a');
  await runtimeA.seedFromLegacy();
  const day = '2026-10-14';
  for (let i = 0; i < 3; i += 1) {
    const extraHabitId = 'burst-' + i;
    const state = JSON.parse(localStorage.getItem(LEGACY_KEY));
    state.habits.push({
      id: extraHabitId, name: 'Burst ' + i,
      pointsPerDay: 4, doneKeys: [], failedKeys: [], iceKeys: []
    });
    localStorage.setItem(LEGACY_KEY, JSON.stringify(state));
    await runtimeA.applyHabitPresenceSnapshot(
      runtimeA.captureHabitPresenceSnapshotFromLegacy(extraHabitId, { source: 'burst-setup' })
    );
  }
  // Mirror three durable V1 Habit journal mutations, but simulate a legacy
  // full-state rollback that omitted their pending journal before next reload.
  for (let i = 0; i < 3; i += 1) {
    const d = {
      ...delta(), id: 'habit:burst-' + i + ':' + day,
      habitId: 'burst-' + i, dayKey: day,
      updatedAtISO: '2026-10-14T22:22:' + String(i).padStart(2, '0') + '.000Z'
    };
    await runtimeA.applyHabitDelta(d);
  }
  const before = plain(indexedDB.dump(DB_NAME));
  const v2Before = before.completions.length;
  assert.equal(v2Before, 3);
  const revisionBefore = before.meta[0].revision;
  const runtimeB = installRuntime(indexedDB, localStorage, 'burst-protect-b');

  await assert.rejects(
    runtimeB.seedFromLegacy(),
    (error) => {
      assert.equal(error.code, 'STATE_V2_PARITY_MISMATCH_PRESERVED');
      assert.equal(error.evidence.actual.completions, 3);
      assert.equal(error.evidence.expected.completions, 0);
      assert.equal(error.evidence.v2OnlyCompletions, 3);
      assert.equal(error.evidence.v2OnlyCompletionIds.length, 3);
      assert.equal(error.evidence.evidencePreserved, true);
      assert.equal(error.evidence.destructiveReseedBlocked, true);
      return true;
    }
  );
  assert.deepEqual(plain(indexedDB.dump(DB_NAME)), before,
    'the three pilot completions and mutation ledger must remain intact');
  assert.equal(indexedDB.dump(DB_NAME).meta[0].revision, revisionBefore);
  await assert.rejects(
    runtimeB.applyHabitDelta({ ...delta(), habitId: 'h1' }),
    /same_generation_parity_mismatch_preserved/,
    'new V2 writes must fail closed until the mismatch is resolved'
  );
  assert.deepEqual(plain(indexedDB.dump(DB_NAME)), before);
});

test('same-generation mismatch resolves by read-only adoption if V1 journal catches up', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtimeA = installRuntime(indexedDB, localStorage, 'catchup-a');
  await runtimeA.seedFromLegacy();
  await runtimeA.applyHabitDelta(delta());
  const before = plain(indexedDB.dump(DB_NAME));

  const runtimeB = installRuntime(indexedDB, localStorage, 'catchup-b');
  await assert.rejects(runtimeB.seedFromLegacy(), /same_generation_parity_mismatch_preserved/);

  // After the production journal/authoritative source catches up, the next
  // startup should adopt V2 without clearing the recovered mutation ledger.
  const recoveredLegacy = await runtimeA.buildCompatibilitySnapshot();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(recoveredLegacy));
  const result = await runtimeB.seedFromLegacy();
  assert.equal(result.seeded, false);
  assert.equal(result.reason, 'verified_current');
  assert.deepEqual(plain(indexedDB.dump(DB_NAME).completions), before.completions);
  assert.deepEqual(plain(indexedDB.dump(DB_NAME).mutations), before.mutations);
});

test('forced bootstrap remains available for separately authorized repair', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const runtimeA = installRuntime(indexedDB, localStorage, 'explicit-a');
  await runtimeA.seedFromLegacy();
  await runtimeA.applyHabitDelta(delta());
  const runtimeB = installRuntime(indexedDB, localStorage, 'explicit-b');
  await assert.rejects(runtimeB.seedFromLegacy(), /same_generation_parity_mismatch_preserved/);
  const fixed = await runtimeB.seedFromLegacy({ force: true });
  assert.equal(fixed.seeded, true);
  assert.equal(fixed.reseedReason, 'forced');
  assert.equal(indexedDB.dump(DB_NAME).completions.length, 0);
});


test('a temporarily missing V1 key preserves V2 completion and ledger across repeated tabs and restarts', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const first = installRuntime(indexedDB, localStorage, 'missing-v1-first');
  await first.seedFromLegacy();
  await first.applyHabitDelta(delta());
  const recoveredLegacy = await first.buildCompatibilitySnapshot();
  const before = plain(indexedDB.dump(DB_NAME));
  localStorage.removeItem(LEGACY_KEY);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tab = installRuntime(indexedDB, localStorage, 'missing-v1-tab-' + attempt);
    await assert.rejects(tab.seedFromLegacy(), error => {
      assert.equal(error.code, 'STATE_V2_LEGACY_MISSING_PRESERVED');
      assert.equal(error.evidence.destructiveReseedBlocked, true);
      assert.equal(error.evidence.existingRevision, before.meta[0].revision);
      return true;
    });
    assert.deepEqual(plain(indexedDB.dump(DB_NAME)), before,
      'reopening must never erase a potentially recoverable incremental V2 copy');
    assert.equal(tab.getStatus().readAuthority, 'legacy_only');
  }

  localStorage.setItem(LEGACY_KEY, JSON.stringify(recoveredLegacy));
  const recovered = installRuntime(indexedDB, localStorage, 'missing-v1-recovered');
  const adoption = await recovered.seedFromLegacy();
  assert.equal(adoption.reason, 'verified_current');
  assert.equal(indexedDB.dump(DB_NAME).completions.length, 1);
  assert.equal(indexedDB.dump(DB_NAME).mutations.length, 1);
  assert.equal((await recovered.verifyParity()).match, true);
});

test('a newer cross-tab revision aborts an in-flight destructive seed without clearing evidence', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const first = installRuntime(indexedDB, localStorage, 'seed-race-first');
  await first.seedFromLegacy();
  await first.applyHabitDelta(delta());
  const db = await first.open();
  const originalTransaction = db.transaction.bind(db);
  let injected = false;

  // Simulate the other tab committing between readMeta() and the seed's
  // readwrite transaction. The stale tab must fail closed.
  db.transaction = function (names, mode) {
    if (!injected && mode === 'readwrite' && Array.isArray(names)
        && names.includes('mutations') && names.includes('meta')) {
      injected = true;
      const current = db._stores.get('meta').get('runtime');
      db._stores.get('meta').set('runtime', {
        ...current, revision: current.revision + 1, lastMutationId: 'other-tab-commit'
      });
      db._stores.get('mutations').set('other-tab-commit', {
        id: 'other-tab-commit', status: 'committed',
        revision: current.revision + 1, resetGeneration: current.resetGeneration
      });
    }
    return originalTransaction(names, mode);
  };

  const second = installRuntime(indexedDB, localStorage, 'seed-race-second');
  await assert.rejects(second.seedFromLegacy({ force: true }), error => {
    assert.equal(error.code, 'STATE_RUNTIME_V2_REVISION_CONFLICT');
    assert.equal(error.actualRevision, error.expectedRevision + 1);
    return true;
  });
  assert.equal(injected, true, 'the startup replacement path was exercised');
  const saved = indexedDB.dump(DB_NAME);
  assert.equal(saved.completions.length, 1);
  assert.equal(saved.mutations.length, 2);
  assert.equal(saved.mutations.some(row => row.id === 'other-tab-commit'), true);
  assert.equal(saved.meta[0].revision, 3);
  assert.equal(second.getStatus().readAuthority, 'legacy_only');
});

test('a concurrent cross-tab commit cannot be erased by a delayed verified seed marker', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const first = installRuntime(indexedDB, localStorage, 'marker-race-first');
  await first.seedFromLegacy();
  await first.applyHabitDelta(delta());
  const compatible = await first.buildCompatibilitySnapshot();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(compatible));

  const db = await first.open();
  const originalTransaction = db.transaction.bind(db);
  let injected = false;
  db.transaction = function (names, mode) {
    if (!injected && names === 'meta' && mode === 'readwrite') {
      injected = true;
      const current = db._stores.get('meta').get('runtime');
      db._stores.get('meta').set('runtime', {
        ...current, revision: current.revision + 1, lastMutationId: 'cross-tab-newer'
      });
      db._stores.get('mutations').set('cross-tab-newer', {
        id: 'cross-tab-newer', status: 'committed',
        revision: current.revision + 1, resetGeneration: current.resetGeneration
      });
    }
    return originalTransaction(names, mode);
  };

  const second = installRuntime(indexedDB, localStorage, 'marker-race-second');
  await assert.rejects(second.seedFromLegacy(), error => {
    assert.equal(error.code, 'STATE_RUNTIME_V2_REVISION_CONFLICT');
    return true;
  });
  assert.equal(injected, true);
  const persisted = indexedDB.dump(DB_NAME);
  assert.equal(persisted.meta[0].revision, 3);
  assert.equal(persisted.meta[0].lastMutationId, 'cross-tab-newer');
  assert.notEqual(persisted.meta[0].seedVerifiedRevision, 3,
    'the delayed marker cannot falsely mark the newer revision verified');
  assert.equal(persisted.mutations.length, 2);
  assert.equal(persisted.completions.length, 1);
});


test('order-only V1/V2 mismatch preserves all rows and ledger until canonical order is restored', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const first = installRuntime(indexedDB, localStorage, 'order-evidence-first');
  await first.seedFromLegacy();
  await first.applyHabitDelta(delta());
  await first.applyHabitDelta({
    ...delta(),
    id: 'habit:h1:2026-09-04', dayKey: '2026-09-04',
    updatedAtISO: '2026-09-04T14:30:00.000Z'
  });
  const canonical = await first.buildCompatibilitySnapshot();
  assert.equal(canonical.completions.length, 2);
  const reordered = structuredClone(canonical);
  reordered.completions.reverse();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(reordered));
  const before = plain(indexedDB.dump(DB_NAME));

  for (let attempt = 0; attempt < 3; attempt++) {
    const reader = installRuntime(indexedDB, localStorage, 'order-evidence-tab-' + attempt);
    await assert.rejects(reader.seedFromLegacy(), (error) => {
      assert.equal(error.code, 'STATE_V2_PARITY_MISMATCH_PRESERVED');
      assert.equal(error.evidence.completionOrderDisagreements, 2);
      assert.equal(error.evidence.v2OnlyCompletions, 0);
      assert.equal(error.evidence.legacyOnlyCompletions, 0);
      assert.equal(error.evidence.changedCompletions, 0);
      assert.equal(error.evidence.destructiveReseedBlocked, true);
      assert.deepEqual(plain(error.evidence.expectedCompletionOrderIds),
        canonical.completions.map(c => c.id).reverse());
      assert.deepEqual(plain(error.evidence.actualCompletionOrderIds),
        canonical.completions.map(c => c.id));
      return true;
    });
    assert.deepEqual(plain(indexedDB.dump(DB_NAME)), before,
      'a strict order mismatch must never repair V2 by replacing its ledger');
  }

  localStorage.setItem(LEGACY_KEY, JSON.stringify(canonical));
  const recovered = installRuntime(indexedDB, localStorage, 'order-evidence-recovered');
  const result = await recovered.seedFromLegacy();
  assert.equal(result.reason, 'verified_current');
  const after = plain(indexedDB.dump(DB_NAME));
  assert.deepEqual(after.mutations, before.mutations);
  assert.deepEqual(after.completions, before.completions);
  assert.equal((await recovered.verifyParity()).match, true);
});


test('equal-timestamp cross-tab ordering ambiguity stays blocked and preserves original V2 data', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = new FakeStorage({
    [DARK_MODE_KEY]: '1',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const writer = installRuntime(indexedDB, localStorage, 'equal-timestamp-writer');
  await writer.seedFromLegacy();
  const when = '2026-09-14T12:00:00.000Z';
  const a = { ...delta(), dayKey: '2026-09-12',
    id: 'habit:h1:2026-09-12', updatedAtISO: when };
  const b = { ...delta(), dayKey: '2026-09-13',
    id: 'habit:h1:2026-09-13', updatedAtISO: when };
  await writer.applyHabitDelta(a);
  await writer.applyHabitDelta(b);
  const before = plain(indexedDB.dump(DB_NAME));
  assert.equal(before.mutations.length, 2);

  const reversed = await writer.buildCompatibilitySnapshot();
  reversed.habits[0].doneKeys.reverse();
  reversed.completions.reverse();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(reversed));

  for (let i = 0; i < 4; i++) {
    const tab = installRuntime(indexedDB, localStorage, 'equal-timestamp-tab-' + i);
    await assert.rejects(tab.seedFromLegacy(), error => {
      assert.equal(error.code, 'STATE_V2_PARITY_MISMATCH_PRESERVED');
      assert.equal(error.evidence.destructiveReseedBlocked, true);
      assert.equal(error.evidence.evidencePreserved, true);
      assert.equal(error.evidence.completionOrderDisagreements, 2);
      assert.equal(error.evidence.changedHabits, 1);
      assert.equal(error.evidence.v2OnlyCompletions, 0);
      assert.equal(error.evidence.legacyOnlyCompletions, 0);
      assert.equal(error.evidence.changedCompletions, 0);
      return true;
    });
    assert.deepEqual(plain(indexedDB.dump(DB_NAME)), before,
      'ambiguous tie ordering must preserve both V2 events and mutation evidence');
    assert.equal(tab.getStatus().readAuthority, 'legacy_only');
  }
  const canonical = await writer.buildCompatibilitySnapshot();
  localStorage.setItem(LEGACY_KEY, JSON.stringify(canonical));
  // A matching V1 snapshot permits read-only reuse without a destructive seed.
  const recovered = installRuntime(indexedDB, localStorage, 'equal-timestamp-recovered');
  const seed = await recovered.seedFromLegacy();
  assert.equal(seed.reason, 'verified_current');
  assert.equal((await recovered.verifyParity()).match, true);
  assert.deepEqual(plain(indexedDB.dump(DB_NAME).mutations), before.mutations);
});

