const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { TextEncoder } = require('node:util');
const { FakeIndexedDB, FakeStorage } = require('./helpers/fake_indexeddb_v2');

const generationSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_generation.js'), 'utf8');
const walSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'state_runtime_v2_wal_bridge.js'), 'utf8');
const verifiedRestoreHtml = fs.readFileSync(path.join(__dirname, '..', 'verified_secondary_restore.html'), 'utf8');
const verifiedRestoreSource = fs.readFileSync(path.join(__dirname, '..', 'verified_secondary_restore.js'), 'utf8');

const DARK = 'taskpoints_state_v2_dark_mode_v1';
const LEGACY_KEY = 'taskpoints_v1';
const WAL_KEY = 'taskpoints_v2_pending_mutations_v1';
const GENERATION_KEY = 'taskpoints_state_v2_generation_v1';
const DB_NAME = 'taskpoints_state_v2';

function legacyState(habitId = 'h1', name = 'Read') {
  return {
    habits: [{ id: habitId, name, pointsPerDay: 4, doneKeys: [], failedKeys: [], iceKeys: [] }],
    completions: []
  };
}

function delta(habitId = 'h1', dayKey = '2026-09-01') {
  return {
    id: `habit:${habitId}:${dayKey}`,
    habitId,
    dayKey,
    source: 'habit',
    status: 'full',
    done: true,
    updatedAtISO: `${dayKey}T12:00:00.000Z`
  };
}

function install({ initialState = legacyState(), initialStorage = {}, uuidNamespace = 'generation-test' } = {}) {
  const localStorage = new FakeStorage({
    [DARK]: '1',
    [LEGACY_KEY]: JSON.stringify(initialState),
    ...initialStorage
  });
  const indexedDB = new FakeIndexedDB();
  let uuid = 0;
  const documentListeners = new Map();

  const core = {
    STORAGE_KEY: LEGACY_KEY,
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    readPendingHabitDeltas() { return []; },
    applyPendingHabitDeltas() {},
    habitCompletionId(habitId, dayKey) { return `habit:${habitId}:${dayKey}`; },
    writePendingHabitDelta(input) { return { ...input }; },
    saveValidatedSnapshot(nextState, options = {}) {
      if (options.testBlocked === true) {
        return { state: JSON.parse(localStorage.getItem(LEGACY_KEY)), blocked: true, reason: 'snapshot-shape-invalid' };
      }
      localStorage.setItem(LEGACY_KEY, JSON.stringify(nextState));
      return { state: nextState, options };
    },
    saveStateSnapshot(nextState, options = {}) {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(nextState));
      return { state: nextState, options };
    },
    safeReplaceTaskPointsStorage(storageKey, serializedCandidate) {
      localStorage.setItem(storageKey, serializedCandidate);
      return true;
    }
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
    TextEncoder,
    crypto: {
      randomUUID() { uuid += 1; return `${uuidNamespace}-${uuid}`; },
      subtle: {
        async digest(algorithm, bytes) {
          if (algorithm !== 'SHA-256') throw Error('unsupported hashing algorithm');
          const digest = createHash('sha256').update(Buffer.from(bytes)).digest();
          return Uint8Array.from(digest).buffer;
        }
      }
    },
    TaskPointsCore: core,
    document: {
      readyState: 'loading',
      addEventListener(type, handler) { documentListeners.set(type, handler); }
    },
    queueMicrotask(fn) { Promise.resolve().then(fn); },
    setTimeout(fn) { Promise.resolve().then(fn); return 1; },
    location: { pathname: '/index.html' }
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  vm.runInNewContext(walSource, context, { filename: 'state_runtime_v2_wal.js' });
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  vm.runInNewContext(bridgeSource, context, { filename: 'state_runtime_v2_wal_bridge.js' });

  async function settle() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  }

  return {
    context,
    core,
    localStorage,
    indexedDB,
    generation: context.TaskPointsStateRuntimeV2Generation,
    wal: context.TaskPointsStateRuntimeV2Wal,
    runtime: context.TaskPointsStateRuntimeV2,
    bridge: context.TaskPointsStateRuntimeV2WalBridge,
    settle
  };
}

function runtimeMeta(app) {
  return app.indexedDB.dump(DB_NAME)?.meta?.find((row) => row.id === 'runtime') || null;
}

test('V2-12 Reset All rotates generation, clears V2 mirror, and preserves old WAL as stale/non-replayable', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const oldGeneration = app.generation.read();
  const appended = app.wal.appendHabitDelta(delta(), { generation: oldGeneration });
  assert.equal(appended.generation, oldGeneration);

  app.localStorage.removeItem(LEGACY_KEY);
  await app.settle();
  await app.bridge.start();

  const newGeneration = app.generation.read();
  assert.notEqual(newGeneration, oldGeneration);
  const replay = await app.bridge.replayPending();
  assert.equal(replay.stale >= 1, true);

  const pending = app.wal.getPendingRows();
  assert.equal(pending.rows.length, 1);
  assert.equal(pending.rows[0].generation, oldGeneration);

  const snapshot = app.indexedDB.dump(DB_NAME);
  assert.equal(snapshot.habits.length, 0);
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.mutations.length, 0);
  assert.equal(runtimeMeta(app).resetGeneration, newGeneration);
  assert.equal(runtimeMeta(app).legacyMissing, true);
});

test('V2-13 an in-flight old-generation mutation is rejected after generation rotation', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const oldGeneration = app.generation.read();

  const applying = app.runtime.applyHabitDelta(delta(), { expectedGeneration: oldGeneration });
  const rotated = app.generation.rotate('reset-all-test');
  assert.notEqual(rotated.generation, oldGeneration);

  await assert.rejects(applying, /state_runtime_v2_stale_generation/);
  await app.settle();
  await app.runtime.seedFromLegacy({ force: true });

  const snapshot = app.indexedDB.dump(DB_NAME);
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.mutations.length, 0);
  assert.equal(snapshot.habits[0].value.doneKeys.length, 0);
  assert.equal(runtimeMeta(app).resetGeneration, rotated.generation);
});

test('V2-14 destructive import rotates generation and makes pre-import WAL permanently stale', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const oldGeneration = app.generation.read();
  app.wal.appendHabitDelta(delta(), { generation: oldGeneration });

  const imported = legacyState('h2', 'Imported Habit');
  app.core.saveValidatedSnapshot(imported, {
    allowDestructiveOverwrite: true,
    source: 'settings-import',
    immediateWrite: true
  });
  await app.settle();
  await app.bridge.start();

  const newGeneration = app.generation.read();
  assert.notEqual(newGeneration, oldGeneration);
  const replay = await app.bridge.replayPending();
  assert.equal(replay.stale >= 1, true);
  assert.equal(app.wal.getPendingRows().rows[0].generation, oldGeneration);

  const snapshot = app.indexedDB.dump(DB_NAME);
  assert.deepEqual(snapshot.habits.map((row) => row.id), ['h2']);
  assert.equal(snapshot.completions.length, 0);
  assert.equal(snapshot.mutations.length, 0);
  assert.equal(runtimeMeta(app).resetGeneration, newGeneration);
});

test('rejected authorized restore preserves original generation, V1 data and pending WAL', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const originalGeneration = app.generation.read();
  const originalState = app.localStorage.getItem(LEGACY_KEY);
  app.wal.appendHabitDelta(delta(), { generation: originalGeneration });

  const rejected = app.core.saveValidatedSnapshot({ habits: [] }, {
    allowDestructiveOverwrite: true,
    source: 'settings-restore',
    immediateWrite: true,
    testBlocked: true
  });
  await app.settle();

  assert.equal(rejected.blocked, true);
  assert.equal(app.localStorage.getItem(LEGACY_KEY), originalState);
  assert.equal(app.generation.read(), originalGeneration, 'rejected restore may not rotate generation');
  assert.equal(app.wal.getPendingRows().rows.length, 1, 'rejected restore must preserve WAL');
});

test('ordinary validated snapshot save does not rotate V2 generation', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const before = app.generation.read();

  app.core.saveValidatedSnapshot(legacyState(), {
    source: 'ordinary-save',
    immediateWrite: true,
    allowDestructiveOverwrite: false
  });
  await app.settle();

  assert.equal(app.generation.read(), before);
});

test('temporary remove-and-replace does not look like Reset All', async () => {
  const app = install();
  await app.runtime.seedFromLegacy();
  const before = app.generation.read();
  const raw = app.localStorage.getItem(LEGACY_KEY);

  app.localStorage.removeItem(LEGACY_KEY);
  app.localStorage.setItem(LEGACY_KEY, raw);
  await app.settle();

  assert.equal(app.generation.read(), before);
});

test('verified-secondary restore loads generation guard and rotates only after verified readback', () => {
  const generationScriptAt = verifiedRestoreHtml.indexOf('state_runtime_v2_generation.js');
  const restoreScriptAt = verifiedRestoreHtml.indexOf('verified_secondary_restore.js');
  assert.ok(generationScriptAt >= 0 && restoreScriptAt > generationScriptAt);

  const countVerifiedAt = verifiedRestoreSource.indexOf('Restored record-count verification failed');
  const verifiedAt = verifiedRestoreSource.indexOf('restoreVerified = true;');
  const rotateAt = verifiedRestoreSource.indexOf("TaskPointsStateRuntimeV2Generation?.rotate?.('verified-secondary-restore')");
  assert.ok(countVerifiedAt >= 0, 'record-count verification must be present');
  assert.ok(verifiedAt > countVerifiedAt, 'restore is marked verified only after exact count verification');
  assert.ok(rotateAt > verifiedAt, 'generation rotates only after the restore is fully verified');
});

test('generation module is default-off and does not create an epoch on production/default state', () => {
  const localStorage = new FakeStorage();
  const context = { localStorage, JSON, Date, Math, String, Number, Boolean, Array, Object, Map, Set, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  assert.equal(context.TaskPointsStateRuntimeV2Generation.getStatus().enabled, false);
  assert.equal(localStorage.getItem(GENERATION_KEY), null);
});

test('silent generation bootstrap write is never acknowledged or published',()=>{
  const localStorage=new FakeStorage({[DARK]:'1'});
  const original=localStorage.setItem.bind(localStorage);
  let swallowed=0;
  localStorage.setItem=(key,value)=>{
    if(String(key)===GENERATION_KEY){swallowed++;return;}
    return original(key,value);
  };
  const context={localStorage,JSON,Date,Math,String,Number,Boolean,
    Array,Object,Map,Set,console};
  context.window=context;
  context.globalThis=context;
  // Automatic bootstrap deliberately catches storage failure at load.
  vm.runInNewContext(generationSource,context,
    {filename:'state_runtime_v2_generation.js'});
  const generation=context.TaskPointsStateRuntimeV2Generation;
  let notifications=0;
  generation.subscribe(()=>notifications++);
  try{
    assert.throws(()=>generation.ensure(),
      /state_runtime_v2_generation_write_failed:unverified_write/);
    assert.ok(swallowed>=2);
    assert.equal(localStorage.getItem(GENERATION_KEY),null);
    assert.equal(generation.getStatus().rotations,0);
    assert.equal(notifications,0);
  }finally{localStorage.setItem=original;}
  const recovered=generation.ensure();
  assert.equal(recovered.created,true);
  assert.equal(recovered.generation,localStorage.getItem(GENERATION_KEY));
  assert.equal(notifications,1);
});

test('silent generation rotation refuses success and never notifies stale WAL consumers',()=>{
  const app=install();
  const previous=app.generation.read();
  const beforeV1=app.localStorage.getItem(LEGACY_KEY);
  const event=app.wal.appendHabitDelta(delta());
  const beforeWal=app.localStorage.getItem(WAL_KEY);
  let notifications=0;
  app.generation.subscribe(()=>notifications++);
  const original=app.localStorage.setItem.bind(app.localStorage);
  let swallowed=0;
  app.localStorage.setItem=(key,value)=>{
    if(String(key)===GENERATION_KEY){swallowed++;return;}
    return original(key,value);
  };
  try{
    assert.throws(()=>app.generation.rotate('reset-must-not-falsely-advance'),
      /state_runtime_v2_generation_write_failed:unverified_write/);
    assert.equal(swallowed,1);
    assert.equal(app.generation.read(),previous);
    assert.equal(app.generation.getStatus().rotations,0);
    assert.equal(notifications,0,'no false epoch notification may be emitted');
    assert.equal(app.localStorage.getItem(WAL_KEY),beforeWal);
    assert.equal(app.localStorage.getItem(LEGACY_KEY),beforeV1);
    assert.deepEqual(app.wal.getPendingRows().rows.map(row=>row.id),[event.mutationId]);
  }finally{app.localStorage.setItem=original;}
  const successful=app.generation.rotate('verified-reset');
  assert.equal(successful.rotated,true);
  assert.notEqual(successful.generation,previous);
  assert.equal(app.generation.read(),successful.generation);
  assert.equal(app.generation.getStatus().rotations,1);
  assert.equal(notifications,1);
  assert.equal(app.localStorage.getItem(WAL_KEY),beforeWal,
    'previous WAL evidence stays inspectable across verified rotation');
});

test('repeated generation UUID cannot falsely confirm the existing epoch',()=>{
  const app=install();
  const previous=app.generation.read();
  const [prefix,uuid]=previous.split(':');
  assert.ok(prefix&&uuid);
  const held=app.wal.appendHabitDelta(delta());
  const v1=app.localStorage.getItem(LEGACY_KEY);
  const wal=app.localStorage.getItem(WAL_KEY);
  let listeners=0,calls=0;
  app.generation.subscribe(()=>listeners++);
  const original=app.context.crypto.randomUUID;
  app.context.crypto.randomUUID=()=>{calls++;return uuid;};
  try{
    assert.throws(()=>app.generation.rotate(prefix),
      /state_runtime_v2_generation_collision/);
    assert.equal(calls,8,'generation collision retries must be bounded');
    assert.equal(app.generation.read(),previous);
    assert.equal(app.generation.getStatus().rotations,0);
    assert.equal(listeners,0);
    assert.equal(app.localStorage.getItem(LEGACY_KEY),v1);
    assert.equal(app.localStorage.getItem(WAL_KEY),wal);
    assert.deepEqual(app.wal.getPendingRows().rows.map(r=>r.id),[held.mutationId]);
  }finally{app.context.crypto.randomUUID=original;}
});

test('generation collision retries a distinct epoch without losing V1 or stale WAL',()=>{
  const app=install();
  const previous=app.generation.read();
  const [prefix,uuid]=previous.split(':');
  const held=app.wal.appendHabitDelta(delta());
  const v1=app.localStorage.getItem(LEGACY_KEY);
  const wal=app.localStorage.getItem(WAL_KEY);
  let calls=0,notifications=0;
  app.generation.subscribe(()=>notifications++);
  const original=app.context.crypto.randomUUID;
  app.context.crypto.randomUUID=()=>{
    calls++;return calls===1?uuid:'verified-distinct-uuid';
  };
  let result;
  try{result=app.generation.rotate(prefix);}
  finally{app.context.crypto.randomUUID=original;}
  assert.equal(calls,2);
  assert.equal(result.rotated,true);
  assert.notEqual(result.generation,previous);
  assert.equal(result.generation,app.generation.read());
  assert.equal(app.generation.getStatus().rotations,1);
  assert.equal(notifications,1);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),v1);
  assert.equal(app.localStorage.getItem(WAL_KEY),wal);
  assert.deepEqual(app.wal.getPendingRows().rows.map(r=>r.id),[held.mutationId]);
});

test('generation rotation refuses a peer epoch changed during token preparation',()=>{
  const app=install();
  const previous=app.generation.read();
  const held=app.wal.appendHabitDelta(delta());
  const previousWal=app.localStorage.getItem(WAL_KEY);
  const previousV1=app.localStorage.getItem(LEGACY_KEY);
  let listenerCalls=0;
  app.generation.subscribe(()=>listenerCalls++);
  const originalGet=app.localStorage.getItem.bind(app.localStorage);
  const originalSet=app.localStorage.setItem.bind(app.localStorage);
  const peer='peer-concurrently-updated-epoch';
  let keyReads=0;
  app.localStorage.getItem=key=>{
    if(String(key)===GENERATION_KEY && ++keyReads===2)
      originalSet(GENERATION_KEY,peer);
    return originalGet(key);
  };
  try{
    assert.throws(()=>app.generation.rotate('stale-local-rotation'),
      /state_runtime_v2_generation_changed_before_write/);
  }finally{app.localStorage.getItem=originalGet;}
  assert.equal(keyReads,2);
  assert.equal(app.generation.read(),peer);
  assert.equal(app.generation.getStatus().rotations,0);
  assert.equal(listenerCalls,0,'the stale rotation must not be announced');
  assert.equal(app.localStorage.getItem(WAL_KEY),previousWal);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),previousV1);
  assert.deepEqual(app.wal.getPendingRows().rows.map(r=>r.id),[held.mutationId]);
  assert.notEqual(peer,previous);
});

test('generation read denial never manufactures an epoch or discards existing WAL evidence', () => {
  const app = install();
  const epoch = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const savedWal = app.localStorage.getItem(WAL_KEY);
  const savedGeneration = app.localStorage.getItem(GENERATION_KEY);
  const originalGet = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = (key) => {
    if (String(key) === GENERATION_KEY) throw new Error('synthetic generation read SecurityError');
    return originalGet(key);
  };
  try {
    assert.throws(() => app.generation.read(), /state_runtime_v2_generation_read_failed/);
    assert.throws(() => app.generation.ensure(), /state_runtime_v2_generation_read_failed/);
    assert.throws(() => app.generation.rotate('unauthorized-rotation'), /state_runtime_v2_generation_read_failed/);
    assert.throws(() => app.wal.appendHabitDelta(delta('h2')), /state_runtime_v2_generation_read_failed/);
    const status = app.generation.getStatus();
    assert.equal(status.generation, null);
    assert.equal(status.generationReadable, false);
    assert.equal(status.rotations, 0);
    assert.match(status.lastError, /state_runtime_v2_generation_read_failed/);
    const walStatus = app.wal.getStatus();
    assert.equal(walStatus.generationReadable, false);
    assert.equal(walStatus.pendingCount, null);
    assert.equal(walStatus.malformed, true);
  } finally {
    app.localStorage.getItem = originalGet;
  }
  assert.equal(app.localStorage.getItem(GENERATION_KEY), savedGeneration);
  assert.equal(app.localStorage.getItem(WAL_KEY), savedWal);
  assert.equal(app.generation.read(), epoch);
  assert.deepEqual(app.wal.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(app.generation.ensure().created, false);
  assert.equal(app.wal.getStatus().generationReadable, true);
  assert.equal(app.wal.getStatus().pendingCount, 1);
});

test('denied generation read during module bootstrap preserves the preexisting epoch for a later reload', () => {
  const localStorage = new FakeStorage({
    [DARK]: '1',
    [GENERATION_KEY]: 'preexisting-generation:abc',
    [WAL_KEY]: '[{"id":"old-evidence","generation":"preexisting-generation:abc","delta":{"habitId":"h1","dayKey":"2026-09-01"}}]'
  });
  const rawRead = localStorage.getItem.bind(localStorage);
  localStorage.getItem = key => {
    if (String(key) === GENERATION_KEY) throw new Error('synthetic bootstrap read SecurityError');
    return rawRead(key);
  };
  const context = { localStorage, JSON, Date, Math, String, Number, Boolean, Array, Object, Map, Set, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(generationSource, context, { filename: 'state_runtime_v2_generation.js' });
  const generation = context.TaskPointsStateRuntimeV2Generation;
  assert.equal(rawRead(GENERATION_KEY), 'preexisting-generation:abc');
  assert.equal(generation.getStatus().generationReadable, false);
  assert.throws(() => generation.ensure(), /state_runtime_v2_generation_read_failed/);
  assert.equal(rawRead(GENERATION_KEY), 'preexisting-generation:abc');
  localStorage.getItem = rawRead;
  assert.equal(generation.ensure().created, false);
  assert.equal(generation.read(), 'preexisting-generation:abc');
  assert.equal(generation.getStatus().rotations, 0);
});

test('Home interaction is held when generation cannot be read, without changing V1 or V2 WAL', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalGeneration = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const originalWal = app.localStorage.getItem(WAL_KEY);
  const originalV1 = app.localStorage.getItem(LEGACY_KEY);
  const get = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = (key) => {
    if (String(key) === GENERATION_KEY) throw new Error('denied generation for resumed tap');
    return get(key);
  };
  try {
    const decision = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
    assert.equal(decision.proceed, false);
    assert.equal(decision.reason, 'generation_unreadable');
    const status = app.runtime.getStatus();
    assert.equal(status.generationReadable, false);
    assert.equal(status.currentGeneration, null);
    assert.equal(status.generationInteractionSafetyBlocks, 1);
    assert.equal(status.readAuthority, 'legacy_only');
  } finally {
    app.localStorage.getItem = get;
  }
  assert.equal(app.localStorage.getItem(LEGACY_KEY), originalV1);
  assert.equal(app.localStorage.getItem(WAL_KEY), originalWal);
  assert.equal(app.generation.read(), originalGeneration);
  assert.deepEqual(app.wal.getPendingRows().rows.map(x => x.id), [first.mutationId]);
  const resumed = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
  assert.equal(resumed.proceed, true);
  assert.equal(app.runtime.getStatus().generationReadable, true);
});

test('temporarily missing generation key blocks stale Home interactions without creating a replacement epoch', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalEpoch = app.generation.read();
  const V1 = app.localStorage.getItem(LEGACY_KEY);
  app.localStorage.removeItem(GENERATION_KEY);
  const blocked = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
  assert.equal(blocked.proceed, false);
  assert.equal(blocked.reason, 'generation_missing');
  assert.equal(app.runtime.getStatus().generationInteractionSafetyBlocks, 1);
  assert.equal(app.localStorage.getItem(GENERATION_KEY), null,
    'a normal tap must not silently manufacture another generation');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), V1);
  app.localStorage.setItem(GENERATION_KEY, originalEpoch);
  assert.equal(app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' }).proceed, true);
});

test('Home Habit guard rejects inaccessible V2 preview flag without losing existing V1 or WAL', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const epoch = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const legacyBefore = app.localStorage.getItem(LEGACY_KEY);
  const walBefore = app.localStorage.getItem(WAL_KEY);
  const get = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = key => {
    if (String(key) === DARK) throw new Error('synthetic dark-mode read SecurityError');
    return get(key);
  };
  try {
    const decision = app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' });
    assert.equal(decision.proceed, false);
    assert.equal(decision.reason, 'dark_mode_unreadable');
    assert.equal(app.runtime.getStatus().generationInteractionSafetyBlocks, 1);
    assert.equal(app.generation.read(), epoch);
  } finally {
    app.localStorage.getItem = get;
  }
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyBefore);
  assert.equal(app.localStorage.getItem(WAL_KEY), walBefore);
  assert.deepEqual(app.wal.getPendingRows().rows.map(row => row.id), [first.mutationId]);
  assert.equal(app.runtime.beforeHabitInteraction({ habitId: 'h1', dayKey: '2026-09-01' }).proceed, true);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('normal V1-only Home remains available when the optional V2 preview flag is unreadable', () => {
  const storage = new FakeStorage({
    [DARK]: '0',
    [LEGACY_KEY]: JSON.stringify(legacyState())
  });
  const context = {
    localStorage: storage, JSON, Date, Math, String, Number, Boolean, Array, Object, Map, Set,
    TaskPointsCore: { STORAGE_KEY: LEGACY_KEY },
    console: { warn() {}, error() {}, log() {} }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(runtimeSource, context, { filename: 'state_runtime_v2.js' });
  const oldGet = storage.getItem.bind(storage);
  storage.getItem = key => {
    if (String(key) === DARK) throw new Error('synthetic optional preview key read failure');
    return oldGet(key);
  };
  try {
    const result = context.TaskPointsStateRuntimeV2.beforeHabitInteraction({
      habitId: 'h1', dayKey: '2026-09-01'
    });
    assert.equal(result.proceed, true);
    assert.equal(result.reason, 'dark_unavailable_without_v2_page');
  } finally { storage.getItem = oldGet; }
});

test('preview pilot readiness checks a stable verified mirror but never switches read authority', async () => {
  const app = install();
  const beforeStart = await app.runtime.inspectPilotReadiness();
  assert.equal(beforeStart.eligible, false);
  assert.equal(beforeStart.reason, 'page_generation_unbound');
  await app.runtime.startCoordinatedDarkMirror();
  const oldMeta = structuredClone(runtimeMeta(app));
  const legacyBefore = app.localStorage.getItem(LEGACY_KEY);
  const ready = await app.runtime.inspectPilotReadiness();
  assert.equal(ready.checked, true);
  assert.equal(ready.eligible, true, JSON.stringify(ready));
  assert.equal(ready.reason, 'pilot_consistent');
  assert.equal(ready.readAuthority, 'legacy_only');
  assert.equal(ready.counts.habits, 1);
  assert.equal(ready.counts.completions, 0);
  assert.deepEqual(runtimeMeta(app), oldMeta, 'inspection must never update meta or seed revision');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyBefore);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('preview pilot readiness refuses pending WAL and unverified same-generation Habit differences', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const initial = await app.runtime.inspectPilotReadiness();
  assert.equal(initial.eligible, true, JSON.stringify(initial));
  const generation = app.generation.read();
  const first = app.wal.appendHabitDelta(delta());
  const blockedWal = await app.runtime.inspectPilotReadiness();
  assert.equal(blockedWal.reason, 'wal_pending');
  assert.equal(blockedWal.eligible, false);
  assert.equal(app.wal.getPendingRows().rows.length, 1);
  app.wal.removeMutation(first.mutationId);
  const originalV1 = app.localStorage.getItem(LEGACY_KEY);
  app.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacyState('h1', 'Later external edit')));
  const mismatch = await app.runtime.inspectPilotReadiness();
  assert.equal(mismatch.reason, 'pilot_parity_mismatch');
  assert.equal(mismatch.eligible, false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY).includes('Later external edit'), true);
  app.localStorage.setItem(LEGACY_KEY, originalV1);
  const recovered = await app.runtime.inspectPilotReadiness();
  assert.equal(recovered.eligible, true, JSON.stringify(recovered));
  assert.equal(app.generation.read(), generation);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('preview pilot readiness fails closed on denied WAL reads and changed generations', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const get = app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem = key => {
    if (String(key) === WAL_KEY) throw Error('temporary WAL read denied');
    return get(key);
  };
  try {
    const denied = await app.runtime.inspectPilotReadiness();
    assert.equal(denied.eligible, false);
    assert.equal(denied.reason, 'wal_unreadable');
  } finally { app.localStorage.getItem = get; }
  assert.equal((await app.runtime.inspectPilotReadiness()).eligible, true);
  const originalEpoch = app.generation.read();
  app.localStorage.setItem(GENERATION_KEY, 'import-replacement-epoch');
  const changed = await app.runtime.inspectPilotReadiness();
  assert.equal(changed.eligible, false);
  assert.equal(changed.reason, 'generation_changed');
  assert.equal(app.localStorage.getItem(GENERATION_KEY), 'import-replacement-epoch');
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
  app.localStorage.setItem(GENERATION_KEY, originalEpoch);
  assert.equal((await app.runtime.inspectPilotReadiness()).eligible, true);
});

test('guarded pilot Habit candidate exposes isolated preview records without replacing V1 authority', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalV1 = app.localStorage.getItem(LEGACY_KEY);
  const originalMeta = structuredClone(runtimeMeta(app));
  const read = await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(read.eligible, true, JSON.stringify(read));
  assert.equal(read.source, 'v2_preview_only');
  assert.equal(read.readAuthority, 'legacy_only');
  assert.equal(read.habit.id, 'h1');
  assert.equal(read.completions.length, 0);
  read.habit.name = 'Mutated preview only';
  assert.equal((await app.runtime.readPilotHabitCandidate('h1')).habit.name, 'Read');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), originalV1);
  assert.deepEqual(runtimeMeta(app), originalMeta);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
  const invalid = await app.runtime.readPilotHabitCandidate('   ');
  assert.equal(invalid.eligible, false);
  assert.equal(invalid.reason, 'habit_id_required');
  assert.equal(Object.hasOwn(invalid, 'habit'), false);
  const missing = await app.runtime.readPilotHabitCandidate('does-not-exist');
  assert.equal(missing.eligible, true);
  assert.equal(missing.habit, null);
  assert.equal(missing.completions.length, 0);
});

test('guarded pilot Habit candidate refuses pending mutations and same-generation V1 mismatch', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const first = app.wal.appendHabitDelta(delta());
  const pending = await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(pending.eligible, false);
  assert.equal(pending.reason, 'wal_pending');
  assert.equal(Object.hasOwn(pending, 'habit'), false);
  app.wal.removeMutation(first.mutationId);
  const initialRaw = app.localStorage.getItem(LEGACY_KEY);
  app.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacyState('h1', 'External edit')));
  const mismatch = await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(mismatch.eligible, false);
  assert.equal(mismatch.reason, 'pilot_parity_mismatch');
  assert.equal(Object.hasOwn(mismatch, 'completions'), false);
  assert.equal(JSON.parse(app.localStorage.getItem(LEGACY_KEY)).habits[0].name, 'External edit');
  app.localStorage.setItem(LEGACY_KEY, initialRaw);
  assert.equal((await app.runtime.readPilotHabitCandidate('h1')).eligible, true);
});

test('guarded pilot Habit candidate rejects a concurrent V1 edit during its read window', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const get = app.localStorage.getItem.bind(app.localStorage);
  let v1Reads = 0;
  app.localStorage.getItem = key => {
    if (String(key) === LEGACY_KEY && ++v1Reads === 3) {
      app.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacyState('h1', 'Changed during async read')));
    }
    return get(key);
  };
  const result = await app.runtime.readPilotHabitCandidate('h1');
  app.localStorage.getItem = get;
  assert.ok(v1Reads >= 3, 'a second preflight must follow the candidate IDB read');
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'pilot_parity_mismatch');
  assert.equal(Object.hasOwn(result, 'habit'), false);
  assert.equal(JSON.parse(app.localStorage.getItem(LEGACY_KEY)).habits[0].name, 'Changed during async read');
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('pilot readiness and Habit preview reject nonpilot completion records without deleting them', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const db = await app.runtime.open();
  const unexpected = {
    id: 'nonpilot:unexpected-task',
    value: { id: 'nonpilot:unexpected-task', habitId: 'h1', source: 'task',
      points: 5, completedAtISO: '2026-09-01T12:00:00.000Z' },
    sequence: 100
  };
  const tx = db.transaction('completions', 'readwrite');
  tx.objectStore('completions').put(unexpected);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  const initialRaw = app.localStorage.getItem(LEGACY_KEY);
  const initialMeta = structuredClone(runtimeMeta(app));
  const blocked = await app.runtime.inspectPilotReadiness();
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reason, 'unexpected_nonpilot_completions');
  const candidate = await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(candidate.eligible, false);
  assert.equal(candidate.reason, 'unexpected_nonpilot_completions');
  assert.equal(Object.hasOwn(candidate, 'completions'), false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY), initialRaw);
  assert.deepEqual(runtimeMeta(app), initialMeta);
  const rows = app.indexedDB.dump(DB_NAME).completions;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], unexpected, 'a refused read must preserve the unexpected record for diagnosis');
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('targeted pilot reader uses Habit primary key, retaining packed cross-Habit duplicate completion order', async () => {
  const first = { id: 'duplicate', source: 'habit', habitId: 'h1', dayKey: '2026-09-02',
    points: 4, completedAtISO: '2026-09-02T08:00:00.000Z' };
  const forH2 = { id: 'duplicate', source: 'habit', habitId: 'h2', dayKey: '2026-09-01',
    points: 5, completedAtISO: '2026-09-01T08:00:00.000Z' };
  const second = { id: 'duplicate', source: 'habit', habitId: 'h1', dayKey: '2026-08-31',
    points: 7, completedAtISO: '2026-08-31T08:00:00.000Z' };
  const app = install({ initialState: {
    habits: [
      { id: 'h1', name: 'Read', doneKeys: [], failedKeys: [], iceKeys: [], pointsPerDay: 4 },
      { id: 'h2', name: 'Walk', doneKeys: [], failedKeys: [], iceKeys: [], pointsPerDay: 5 }
    ],
    completions: [first, forH2, second]
  } });
  await app.runtime.startCoordinatedDarkMirror();
  const packed = app.indexedDB.dump(DB_NAME).completions;
  assert.deepEqual(Array.from(packed.find(row => row.id === 'duplicate').habitIds),
    ['h1', 'h2'], 'shared completion ID must index every participating Habit');
  const db = await app.runtime.open();
  const transaction = db.transaction.bind(db);
  const calls = { targetedHabits: 0, fullHabits: 0, fullCompletions: 0, indexedCompletions: 0 };
  db.transaction = (...args) => {
    const tx = transaction(...args);
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = name => {
      const store = objectStore(name);
      const originalGetAll = store.getAll.bind(store);
      if (name === 'habits') {
        const originalGet = store.get.bind(store);
        store.get = key => { calls.targetedHabits++; return originalGet(key); };
        store.getAll = (...params) => { calls.fullHabits++; return originalGetAll(...params); };
      } else if (name === 'completions') {
        store.getAll = (...params) => { calls.fullCompletions++; return originalGetAll(...params); };
        const originalIndex = store.index.bind(store);
        store.index = (...params) => {
          const index = originalIndex(...params);
          const original = index.getAll.bind(index);
          index.getAll = (...args) => { calls.indexedCompletions++; return original(...args); };
          return index;
        };
      }
      return store;
    };
    return tx;
  };
  const result = await app.runtime.readPilotHabitCandidate('h1');
  db.transaction = transaction;
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.habit.id, 'h1');
  assert.deepEqual(Array.from(result.completions, row => row.points), [4, 7]);
  assert.deepEqual(Array.from(result.completions, row => row.id), ['duplicate','duplicate']);
  assert.equal(calls.targetedHabits, 1);
  assert.equal(calls.fullHabits, 2, 'only the two whole-pilot parity preflights scan all Habits');
  assert.equal(calls.fullCompletions, 2, 'the two complete pilot preflights still scan all completions');
  assert.equal(calls.indexedCompletions, 1, 'candidate reads only the Habit indexed packs');
  assert.equal(result.lookupMode, 'indexed');
  const other = await app.runtime.readPilotHabitCandidate('h2');
  assert.equal(other.eligible, true);
  assert.deepEqual(Array.from(other.completions, row => row.points), [5]);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('targeted Habit candidate read fails closed on IDB primary-key failure and recovers without writes', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const legacyBefore = app.localStorage.getItem(LEGACY_KEY);
  const metaBefore = structuredClone(runtimeMeta(app));
  const habitRowsBefore = structuredClone(app.indexedDB.dump(DB_NAME).habits);
  app.indexedDB.failNext({
    store: 'habits', operation: 'get', error: Error('synthetic targeted IDB read failure')
  });
  const denied = await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(denied.eligible, false);
  assert.equal(denied.reason, 'storage_unreadable');
  assert.equal(Object.hasOwn(denied, 'habit'), false);
  assert.equal(Object.hasOwn(denied, 'completions'), false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY), legacyBefore);
  assert.deepEqual(runtimeMeta(app), metaBefore);
  assert.deepEqual(app.indexedDB.dump(DB_NAME).habits, habitRowsBefore);
  const retry = await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(retry.eligible, true, JSON.stringify(retry));
  assert.equal(retry.habit.id, 'h1');
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('preview completion-index coverage verifies every packed Habit owner without changing the stores', async () => {
  const initialState = {
    habits: [
      { id: 'h1', name: 'Read', pointsPerDay: 4, doneKeys: [], failedKeys: [], iceKeys: [] },
      { id: 'h2', name: 'Walk', pointsPerDay: 5, doneKeys: [], failedKeys: [], iceKeys: [] }
    ],
    completions: [
      { id: 'duplicate', habitId: 'h1', source: 'habit', dayKey: '2026-09-01', points: 4 },
      { id: 'duplicate', habitId: 'h2', source: 'habit', dayKey: '2026-09-01', points: 5 },
      { id: 'h1-second', habitId: 'h1', source: 'habit', dayKey: '2026-09-02', points: 4 }
    ]
  };
  const app = install({ initialState });
  await app.runtime.startCoordinatedDarkMirror();
  const before = structuredClone(app.indexedDB.dump(DB_NAME));
  const rawV1 = app.localStorage.getItem(LEGACY_KEY);
  const report = await app.runtime.inspectPilotCompletionIndexCoverage();
  assert.equal(report.indexReady, true, JSON.stringify(report));
  assert.equal(report.reason, 'metadata_complete');
  assert.deepEqual(JSON.parse(JSON.stringify(report.counts)), {
    total: 2, complete: 2, missing: 0, mismatched: 0
  });
  assert.deepEqual(app.indexedDB.dump(DB_NAME), before,
    'coverage check must not write to or repair V2');
  assert.equal(app.localStorage.getItem(LEGACY_KEY), rawV1);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('preview completion-index coverage detects old rows and stale metadata without auto-backfill', async () => {
  const initialState = {
    habits: [
      { id: 'h1', name: 'Read', pointsPerDay: 4, doneKeys: [], failedKeys: [], iceKeys: [] },
      { id: 'h2', name: 'Walk', pointsPerDay: 5, doneKeys: [], failedKeys: [], iceKeys: [] }
    ],
    completions: [
      { id: 'duplicate', habitId: 'h1', source: 'habit', dayKey: '2026-09-01', points: 4 },
      { id: 'duplicate', habitId: 'h2', source: 'habit', dayKey: '2026-09-01', points: 5 },
      { id: 'h1-second', habitId: 'h1', source: 'habit', dayKey: '2026-09-02', points: 4 }
    ]
  };
  const app = install({ initialState });
  await app.runtime.startCoordinatedDarkMirror();
  const db = await app.runtime.open();
  const originalRows = app.indexedDB.dump(DB_NAME).completions;
  const oldRow = structuredClone(originalRows.find(row => row.id === 'duplicate'));
  delete oldRow.habitIds;
  const wrongRow = structuredClone(originalRows.find(row => row.id === 'h1-second'));
  wrongRow.habitIds = ['h2'];
  const tx = db.transaction('completions', 'readwrite');
  tx.objectStore('completions').put(oldRow);
  tx.objectStore('completions').put(wrongRow);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  const before = structuredClone(app.indexedDB.dump(DB_NAME));
  const report = await app.runtime.inspectPilotCompletionIndexCoverage();
  assert.equal(report.indexReady, false);
  assert.equal(report.reason, 'metadata_backfill_required');
  assert.deepEqual(JSON.parse(JSON.stringify(report.counts)), {
    total: 2, complete: 0, missing: 1, mismatched: 1
  });
  assert.deepEqual(app.indexedDB.dump(DB_NAME), before, 'untrusted metadata remains for diagnosis');
  const reader = await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(reader.eligible, true, JSON.stringify(reader));
  assert.deepEqual(Array.from(reader.completions, item => item.id), ['duplicate', 'h1-second'],
    'legacy scan path must remain usable while historical rows lack index metadata');
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

test('preview completion-index coverage refuses incomplete WAL without inspecting as healthy', async () => {
  const app = install();
  await app.runtime.startCoordinatedDarkMirror();
  const mutation = app.wal.appendHabitDelta(delta());
  const result = await app.runtime.inspectPilotCompletionIndexCoverage();
  assert.equal(result.indexReady, false);
  assert.equal(result.reason, 'wal_pending');
  assert.equal(Object.hasOwn(result, 'counts'), false);
  assert.equal(app.wal.getPendingRows().rows[0].id, mutation.mutationId);
  assert.equal(app.runtime.getStatus().readAuthority, 'legacy_only');
});

async function installLegacyV2Database(app, rows) {
  const request = app.indexedDB.open(DB_NAME, 1);
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['habits', 'completions', 'mutations', 'meta'])
        db.createObjectStore(name, { keyPath: 'id' });
      const store = request.transaction.objectStore('completions');
      for (const row of rows) store.put(row);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test('V2 index upgrade atomically backfills old mixed-Habit completion packs without altering event bytes', async () => {
  const app = install();
  const original = {
    id: 'shared-legacy',
    entries: [
      { sequence: 17, value: { id: 'shared-legacy', habitId: 'h1', source: 'habit', points: 3 } },
      { sequence: 16, value: { id: 'shared-legacy', habitId: 'h2', source: 'vice', points: 4 } },
      { sequence: 15, value: { id: 'shared-legacy', habitId: 'h1', source: 'habit', points: 5 } }
    ]
  };
  await installLegacyV2Database(app, [original]);
  const before = structuredClone(app.indexedDB.dump(DB_NAME));
  const savedV1 = app.localStorage.getItem(LEGACY_KEY);
  const db = await app.runtime.open();
  assert.equal(db.version, 2);
  assert.equal(db.transaction('completions','readonly').objectStore('completions')
    .indexNames.contains('by_habit_ids'), true);
  const backfilled = app.indexedDB.dump(DB_NAME).completions[0];
  assert.deepEqual(Array.from(backfilled.habitIds), ['h1','h2']);
  assert.deepEqual(backfilled.entries, original.entries,
    'upgrade must preserve every packed entry and its ordering/sequence');
  for (const habitId of ['h1','h2']) {
    const tx = db.transaction('completions', 'readonly');
    const result = await new Promise((resolve, reject) => {
      const req = tx.objectStore('completions').index('by_habit_ids').getAll(habitId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    assert.equal(result.length,1);
    assert.equal(result[0].id,original.id);
  }
  assert.equal(app.localStorage.getItem(LEGACY_KEY),savedV1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME).mutations,before.mutations);
  assert.deepEqual(app.indexedDB.dump(DB_NAME).meta,before.meta);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('V2 index migration aborted by a failed backfill rolls back version, index and bytes; retry succeeds', async () => {
  const app = install();
  const old = { id: 'old-row', entries: [
    { sequence: 3, value: { id: 'old-row', habitId: 'h1', source: 'habit' } },
    { sequence: 2, value: { id: 'old-row', habitId: 'h2', source: 'vice' } }
  ] };
  await installLegacyV2Database(app,[old]);
  const original = structuredClone(app.indexedDB.dump(DB_NAME));
  const legacyRaw = app.localStorage.getItem(LEGACY_KEY);
  app.indexedDB.failNext({store:'completions',operation:'put',
    error: new Error('synthetic backfill QuotaExceededError')});
  await assert.rejects(app.runtime.open(), /QuotaExceededError|fake_indexeddb_upgrade_aborted/);
  assert.equal(app.indexedDB._databases.get(DB_NAME).version,1);
  assert.equal(app.indexedDB._databases.get(DB_NAME)._indexes
    .get('completions').has('by_habit_ids'),false);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),original,'no partial upgrade may persist');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),legacyRaw);
  const retry = await app.runtime.open();
  assert.equal(retry.version,2);
  assert.deepEqual(app.indexedDB.dump(DB_NAME).completions[0].habitIds,['h1','h2']);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('V2 index migration read error aborts and retains all legacy completion evidence', async () => {
  const app = install();
  const old = { id:'old', value: {id:'old', habitId:'h1', source:'habit',points:8}, sequence:1 };
  await installLegacyV2Database(app,[old]);
  const original = structuredClone(app.indexedDB.dump(DB_NAME));
  app.indexedDB.failNext({store:'completions',operation:'getAll',
    error:new Error('synthetic upgrade read denial')});
  await assert.rejects(app.runtime.open(), /synthetic upgrade read denial|fake_idb_transaction_aborted/);
  assert.equal(app.indexedDB._databases.get(DB_NAME).version,1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),original);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  const retry=await app.runtime.open();
  assert.equal(retry.version,2);
  assert.deepEqual(app.indexedDB.dump(DB_NAME).completions[0].habitIds,['h1']);
});

test('IndexedDB versionchange closes an older preview connection and refuses stale candidates', async () => {
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const db=await app.runtime.open();
  const legacyRaw=app.localStorage.getItem(LEGACY_KEY);
  const walBefore=app.wal.getPendingRows();
  assert.equal((await app.runtime.readPilotHabitCandidate('h1')).eligible,true);
  assert.equal(typeof db.onversionchange,'function');
  db.onversionchange({oldVersion:2,newVersion:3});
  assert.equal(db._closed,true);
  const status=app.runtime.getStatus();
  assert.equal(status.readAuthority,'legacy_only');
  assert.equal(status.externalRevisionInvalidated,true);
  const blocked=await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(blocked.eligible,false);
  assert.equal(blocked.reason,'external_revision_invalidated');
  assert.equal(Object.hasOwn(blocked,'habit'),false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),legacyRaw);
  assert.deepEqual(app.wal.getPendingRows(),walBefore);
});

test('indexed candidate failures do not expose partial results and recover without reseeding', async () => {
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const before=structuredClone(app.indexedDB.dump(DB_NAME));
  app.indexedDB.failNext({store:'completions',operation:'indexGetAll',
    error:new Error('synthetic IndexedDB indexed read interrupted')});
  const failed=await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(failed.eligible,false);
  assert.equal(failed.reason,'storage_unreadable');
  assert.equal(Object.hasOwn(failed,'completions'),false);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),before);
  const retried=await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(retried.eligible,true,JSON.stringify(retried));
  assert.equal(retried.lookupMode,'indexed');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('blocked V2 open rejects immediately, aborts delayed upgrade and never supersedes a successful retry', async () => {
  const app=install();
  const originalOpen=app.indexedDB.open.bind(app.indexedDB);
  const savedV1=app.localStorage.getItem(LEGACY_KEY);
  let heldRequest=null;
  let aborted=0;
  let lateClosed=0;
  app.indexedDB.open=()=>{
    const request={
      result:{close(){lateClosed++;}},
      transaction:{abort(){aborted++;}},
      error:null,
      onsuccess:null,onerror:null,onblocked:null,onupgradeneeded:null
    };
    heldRequest=request;
    queueMicrotask(()=>request.onblocked?.());
    return request;
  };
  await assert.rejects(app.runtime.open(),/state_runtime_v2_open_blocked/);
  assert.ok(heldRequest);
  // IDB has no cancel-open API: a blocked request may later be granted an
  // upgrade even though the caller has already returned safely to V1.
  heldRequest.onupgradeneeded();
  assert.equal(aborted,1,'abandoned versionchange must abort before writing');
  heldRequest.onsuccess();
  assert.equal(lateClosed,1,'stale late-success connection must be closed');
  app.indexedDB.open=originalOpen;
  const healthy=await app.runtime.open();
  assert.equal(healthy.version,2);
  heldRequest.error=new Error('late blocked request error');
  heldRequest.onerror();
  assert.equal(await app.runtime.open(),healthy,
    'stale late error cannot erase the newer successful open promise');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),savedV1);
  assert.equal(app.wal.getPendingRows().rows.length,0);
});

test('two successive blocked V2 opens cannot invalidate a later healthy open', async () => {
  const app=install();
  const rawOpen=app.indexedDB.open.bind(app.indexedDB);
  const stale=[];
  app.indexedDB.open=()=>{
    const req={result:{close(){}},transaction:{abort(){}},
      error:null,onblocked:null,onupgradeneeded:null,onsuccess:null,onerror:null};
    stale.push(req);
    queueMicrotask(()=>req.onblocked?.());
    return req;
  };
  await assert.rejects(app.runtime.open(),/open_blocked/);
  await assert.rejects(app.runtime.open(),/open_blocked/);
  app.indexedDB.open=rawOpen;
  const healthy=await app.runtime.open();
  for(const request of stale){
    request.onupgradeneeded();
    request.onsuccess();
    request.error=new Error('delayed obsolete IDB request');
    request.onerror();
  }
  assert.equal(await app.runtime.open(),healthy);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('ephemeral V2 read probe remains V1-authoritative, reversible, and read-only',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const original=structuredClone(app.indexedDB.dump(DB_NAME));
  const v1=app.localStorage.getItem(LEGACY_KEY);
  assert.equal((await app.runtime.probePilotHabitRead('h1')).reason,'probe_disabled');
  assert.equal(app.runtime.getStatus().pilotReadProbeEnabled,false);
  assert.equal(app.runtime.setPilotReadProbeEnabled(true).persisted,false);
  const result=await app.runtime.probePilotHabitRead('h1');
  assert.equal(result.matched,true,JSON.stringify(result));
  assert.equal(result.lookupMode,'indexed');
  assert.equal(result.selectedSource,'legacy_only');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  assert.equal(app.runtime.getStatus().pilotReadProbeChecks,1);
  assert.equal(app.runtime.getStatus().pilotReadProbeMatches,1);
  app.runtime.setPilotReadProbeEnabled(false);
  assert.equal((await app.runtime.probePilotHabitRead('h1')).reason,'probe_disabled');
  assert.deepEqual(app.indexedDB.dump(DB_NAME),original);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),v1);
});

test('ephemeral V2 read probe refuses pending WAL and V1 divergence without exposing a record',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.runtime.setPilotReadProbeEnabled(true);
  const pending=app.wal.appendHabitDelta(delta());
  const refused=await app.runtime.probePilotHabitRead('h1');
  assert.equal(refused.reason,'wal_pending');
  assert.equal(refused.selectedSource,'legacy_only');
  assert.equal(Object.hasOwn(refused,'habit'),false);
  app.wal.removeMutation(pending.mutationId);
  app.localStorage.setItem(LEGACY_KEY,JSON.stringify(legacyState('h1','External V1 only')));
  const mismatch=await app.runtime.probePilotHabitRead('h1');
  assert.equal(mismatch.matched,false);
  assert.equal(mismatch.reason,'pilot_parity_mismatch');
  assert.equal(mismatch.selectedSource,'legacy_only');
  assert.equal(Object.hasOwn(mismatch,'completions'),false);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('switching off an in-flight read probe refuses its late IDB candidate without switching authority',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.runtime.setPilotReadProbeEnabled(true);
  const db=await app.runtime.open();
  const originalTransaction=db.transaction.bind(db);
  let triggered=0;
  db.transaction=(...args)=>{
    const tx=originalTransaction(...args);
    const originalStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=originalStore(name);
      if(name==='completions'){
        const originalIndex=store.index.bind(store);
        store.index=indexName=>{
          const index=originalIndex(indexName);
          const originalGetAll=index.getAll.bind(index);
          index.getAll=key=>{
            triggered++;
            app.runtime.setPilotReadProbeEnabled(false);
            return originalGetAll(key);
          };
          return index;
        };
      }
      return store;
    };
    return tx;
  };
  const result=await app.runtime.probePilotHabitRead('h1');
  db.transaction=originalTransaction;
  assert.equal(triggered,1);
  assert.equal(result.matched,false);
  assert.equal(result.reason,'probe_disabled_during_check');
  assert.equal(result.selectedSource,'legacy_only');
  assert.equal(Object.hasOwn(result,'habit'),false);
  assert.equal(app.runtime.getStatus().pilotReadProbeEnabled,false);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('disabling dark mirror during asynchronous parity check makes V2 readiness fail closed',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const db=await app.runtime.open();
  const originalTransaction=db.transaction.bind(db);
  let triggered=0;
  db.transaction=(...args)=>{
    const tx=originalTransaction(...args);
    const originalStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=originalStore(name);
      if(name==='habits'){
        const originalGetAll=store.getAll.bind(store);
        store.getAll=(...params)=>{
          if(!triggered++){app.runtime.disableDarkMirror();}
          return originalGetAll(...params);
        };
      }
      return store;
    };
    return tx;
  };
  const check=await app.runtime.inspectPilotReadiness();
  db.transaction=originalTransaction;
  assert.equal(triggered,1);
  assert.equal(check.eligible,false);
  assert.equal(check.reason,'dark_disabled_during_check');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  assert.equal(app.runtime.getStatus().darkEnabled,false);
  assert.equal(app.wal.getPendingRows().rows.length,0);
});

test('rapid disable and re-enable cannot resurrect an older successful V2 read probe',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.runtime.setPilotReadProbeEnabled(true);
  const db=await app.runtime.open();
  const originalTransaction=db.transaction.bind(db);
  let toggled=0;
  db.transaction=(...args)=>{
    const tx=originalTransaction(...args);
    const originalStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=originalStore(name);
      if(name==='completions'){
        const originalIndex=store.index.bind(store);
        store.index=indexName=>{
          const index=originalIndex(indexName);
          const originalGetAll=index.getAll.bind(index);
          index.getAll=key=>{
            if(toggled++===0){
              app.runtime.setPilotReadProbeEnabled(false);
              app.runtime.setPilotReadProbeEnabled(true);
            }
            return originalGetAll(key);
          };
          return index;
        };
      }
      return store;
    };
    return tx;
  };
  const originalLegacy=app.localStorage.getItem(LEGACY_KEY);
  const originalMirror=structuredClone(app.indexedDB.dump(DB_NAME));
  const stale=await app.runtime.probePilotHabitRead('h1');
  assert.equal(toggled,1);
  assert.equal(stale.reason,'probe_disabled_during_check');
  assert.equal(stale.matched,false);
  assert.equal(stale.selectedSource,'legacy_only');
  assert.equal(Object.hasOwn(stale,'habit'),false);
  assert.equal(app.runtime.getStatus().pilotReadProbeEnabled,true);
  db.transaction=originalTransaction;
  const fresh=await app.runtime.probePilotHabitRead('h1');
  assert.equal(fresh.matched,true,JSON.stringify(fresh));
  assert.equal(fresh.selectedSource,'legacy_only');
  assert.equal(app.runtime.getStatus().pilotReadProbeChecks,2);
  assert.equal(app.runtime.getStatus().pilotReadProbeMatches,1);
  assert.equal(app.runtime.getStatus().pilotReadProbeRefusals,1);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),originalLegacy);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),originalMirror);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('brief dark-mirror disable and re-enable rejects the original parity read even if V1 and V2 match',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalV1=app.localStorage.getItem(LEGACY_KEY);
  const beforeV2=structuredClone(app.indexedDB.dump(DB_NAME));
  const db=await app.runtime.open();
  const originalTransaction=db.transaction.bind(db);
  let changed=0;
  db.transaction=(...args)=>{
    const tx=originalTransaction(...args);
    const originalStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=originalStore(name);
      if(name==='habits'){
        const originalGetAll=store.getAll.bind(store);
        store.getAll=(...params)=>{
          if(changed++===0){
            app.runtime.disableDarkMirror();
            // Simulate a rapid user re-enabling the flag before the
            // asynchronous IndexedDB read settles, without reseeding.
            app.localStorage.setItem(DARK,'1');
          }
          return originalGetAll(...params);
        };
      }
      return store;
    };
    return tx;
  };
  const refused=await app.runtime.inspectPilotReadiness();
  db.transaction=originalTransaction;
  assert.equal(changed,1);
  assert.equal(refused.eligible,false);
  assert.equal(refused.reason,'dark_disabled_during_check');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  assert.equal(app.runtime.getStatus().darkEnabled,true);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),originalV1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),beforeV2);
  assert.equal((await app.runtime.inspectPilotReadiness()).eligible,true,
    'newly started parity check may run only after a fresh complete inspection');
});

test('read probe preserves cross-Habit duplicate-ID coverage and refuses an altered V2 packed entry',async()=>{
  const completions=[
    {id:'shared',source:'habit',habitId:'h1',dayKey:'2026-09-03',points:4},
    {id:'shared',source:'vice',habitId:'h2',dayKey:'2026-09-02',points:3},
    {id:'shared',source:'habit',habitId:'h1',dayKey:'2026-09-01',points:2}
  ];
  const app=install({initialState:{
    habits:[legacyState('h1','Read').habits[0],legacyState('h2','Walk').habits[0]],
    completions
  }});
  await app.runtime.startCoordinatedDarkMirror();
  app.runtime.setPilotReadProbeEnabled(true);
  const one=await app.runtime.probePilotHabitRead('h1');
  const two=await app.runtime.probePilotHabitRead('h2');
  assert.equal(one.matched,true,JSON.stringify(one));
  assert.equal(one.counts.legacyCompletions,2);
  assert.equal(one.counts.candidateCompletions,2);
  assert.equal(two.matched,true,JSON.stringify(two));
  assert.equal(two.counts.candidateCompletions,1);
  const rawV1=app.localStorage.getItem(LEGACY_KEY);
  const db=await app.runtime.open();
  const row=structuredClone(app.indexedDB.dump(DB_NAME).completions[0]);
  row.entries[1].value.points=999;
  const tx=db.transaction('completions','readwrite');
  tx.objectStore('completions').put(row);
  await new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
  const corrupted=structuredClone(app.indexedDB.dump(DB_NAME));
  const refused=await app.runtime.probePilotHabitRead('h2');
  assert.equal(refused.matched,false);
  assert.equal(refused.reason,'pilot_parity_mismatch');
  assert.equal(refused.selectedSource,'legacy_only');
  assert.equal(Object.hasOwn(refused,'completions'),false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),rawV1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),corrupted,
    'a parity refusal must not silently fix or delete corrupted mirror evidence');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('persisted foreign revision signal alone invalidates a stale pilot without storage events',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const healthy=await app.runtime.inspectPilotReadiness();
  assert.equal(healthy.eligible,true,JSON.stringify(healthy));
  const sourceBefore=app.localStorage.getItem(LEGACY_KEY);
  const mirrorBefore=structuredClone(app.indexedDB.dump(DB_NAME));
  const status=app.runtime.getStatus();
  // The fake browser dispatches no storage or BroadcastChannel events.
  app.localStorage.setItem(status.revisionSignalKey,JSON.stringify({
    sourceId:'another-tab-with-a-durable-write',
    generation:status.currentGeneration,
    revision:Number(status.lastKnownRevision||0)+1,
    epochMs:Date.now()+10000,
    atISO:new Date().toISOString()
  }));
  const blocked=await app.runtime.inspectPilotReadiness();
  assert.equal(blocked.eligible,false);
  assert.equal(blocked.reason,'external_revision_invalidated');
  assert.equal(app.runtime.getStatus().externalRevisionInvalidated,true);
  assert.equal(app.runtime.getStatus().externalRevisionSource,'persisted_signal');
  const candidate=await app.runtime.readPilotHabitCandidate('h1');
  assert.equal(candidate.eligible,false);
  assert.equal(Object.hasOwn(candidate,'habit'),false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),sourceBefore);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),mirrorBefore);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('durable foreign revision appearing during an IDB scan rejects the in-flight candidate',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const db=await app.runtime.open();
  const txOriginal=db.transaction.bind(db);
  let injected=0;
  db.transaction=(...args)=>{
    const tx=txOriginal(...args);
    const objectStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=objectStore(name);
      if(name==='habits'){
        const getAll=store.getAll.bind(store);
        store.getAll=(...inputs)=>{
          if(injected++===0){
            const state=app.runtime.getStatus();
            app.localStorage.setItem(state.revisionSignalKey,JSON.stringify({
              sourceId:'late-foreign-context',
              generation:state.currentGeneration,
              revision:Number(state.lastKnownRevision||0)+1,
              epochMs:Date.now()+10000
            }));
          }
          return getAll(...inputs);
        };
      }
      return store;
    };
    return tx;
  };
  const denied=await app.runtime.readPilotHabitCandidate('h1');
  db.transaction=txOriginal;
  assert.equal(injected,1);
  assert.equal(denied.eligible,false);
  assert.equal(denied.readAuthority,'legacy_only');
  assert.equal(Object.hasOwn(denied,'completions'),false);
  assert.equal(app.runtime.getStatus().externalRevisionInvalidated,true);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('mutation-handoff preflight reports proven mirror checks but never grants storage authority',async()=>{
  const app=install({initialState:{
    ...legacyState(),
    completions:[{id:'unrelated-task',source:'task',taskId:'t',points:3}]
  }});
  await app.runtime.startCoordinatedDarkMirror();
  const legacyBefore=app.localStorage.getItem(LEGACY_KEY);
  const v2Before=structuredClone(app.indexedDB.dump(DB_NAME));
  const report=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(report.checked,true);
  assert.equal(report.canPromote,false);
  assert.equal(report.mutationAuthority,'legacy_only');
  assert.equal(report.readAuthority,'legacy_only');
  assert.equal(report.checks.pilotConsistent,true,JSON.stringify(report));
  assert.equal(report.checks.completionIndexReady,true);
  assert.equal(report.checks.legacyJournalEmpty,true);
  assert.equal(report.checks.noObservedMirrorFailures,true);
  assert.equal(report.counts.nonPilotLegacyCompletions,1);
  for(const blocker of ['exclusive_writer_lease_not_implemented',
    'durable_authority_rollback_not_implemented','nonpilot_collections_not_migrated'])
    assert.ok(report.blockers.includes(blocker),JSON.stringify(report));
  assert.equal(app.localStorage.getItem(LEGACY_KEY),legacyBefore);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),v2Before);
});

test('mutation-handoff preflight inventories uncompacted legacy journal without claiming readiness',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.core.readPendingHabitDeltas=()=>[delta()];
  const v1=app.localStorage.getItem(LEGACY_KEY);
  const mirror=structuredClone(app.indexedDB.dump(DB_NAME));
  const report=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(report.canPromote,false);
  assert.equal(report.checks.pilotConsistent,true,JSON.stringify(report));
  assert.equal(report.checks.legacyJournalEmpty,false);
  assert.equal(report.counts.legacyJournalPending,1);
  assert.ok(report.blockers.includes('legacy_journal_pending'));
  assert.equal(app.localStorage.getItem(LEGACY_KEY),v1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),mirror);
});

test('mutation-handoff preflight refuses pending WAL, V1 divergence, and unreadable journal',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const pending=app.wal.appendHabitDelta(delta());
  const wal=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(wal.canPromote,false);
  assert.equal(wal.reason,'pilot_not_consistent');
  assert.ok(wal.blockers.includes('pilot_wal_pending'));
  assert.equal(app.wal.getPendingRows().rows.length,1);
  app.wal.removeMutation(pending.mutationId);
  const original=app.localStorage.getItem(LEGACY_KEY);
  app.localStorage.setItem(LEGACY_KEY,JSON.stringify(legacyState('h1','V1 only correction')));
  const mismatch=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(mismatch.canPromote,false);
  assert.ok(mismatch.blockers.includes('pilot_pilot_parity_mismatch'));
  assert.equal(JSON.parse(app.localStorage.getItem(LEGACY_KEY)).habits[0].name,'V1 only correction');
  app.localStorage.setItem(LEGACY_KEY,original);
  app.core.readPendingHabitDeltas=()=>{throw Error('synthetic unreadable legacy journal');};
  const denial=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(denial.canPromote,false);
  assert.ok(denial.blockers.some(reason=>reason==='pilot_storage_unreadable'
    || reason==='handoff_inventory_unreadable'),JSON.stringify(denial));
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('mutation-handoff preflight refuses a legacy journal change during asynchronous parity inspection',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  let calls=0;
  app.core.readPendingHabitDeltas=()=>{
    calls++;
    // First readiness performs two V1 snapshots before the inventory read.
    return calls>=5 ? [delta()] : [];
  };
  const original=app.localStorage.getItem(LEGACY_KEY);
  const report=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(report.canPromote,false);
  assert.ok(report.blockers.some(reason=>reason==='legacy_journal_changed_during_preflight'
    || reason.startsWith('pilot_')),JSON.stringify({report,calls}));
  assert.equal(app.localStorage.getItem(LEGACY_KEY),original);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('guarded V2 readiness refuses unreadable cross-tab revision signals without touching V1 or WAL',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const initial=await app.runtime.inspectPilotReadiness();
  assert.equal(initial.eligible,true);
  const savedV1=app.localStorage.getItem(LEGACY_KEY);
  const storedV2=structuredClone(app.indexedDB.dump(DB_NAME));
  const signalKey=app.runtime.getStatus().revisionSignalKey;
  const originalGet=app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem=key=>{
    if(String(key)===signalKey) throw Error('synthetic Safari security denial');
    return originalGet(key);
  };
  const blocked=await app.runtime.inspectPilotReadiness();
  const candidate=await app.runtime.readPilotHabitCandidate('h1');
  app.localStorage.getItem=originalGet;
  assert.equal(blocked.eligible,false);
  assert.equal(blocked.reason,'revision_signal_unreadable');
  assert.equal(candidate.eligible,false);
  assert.equal(candidate.reason,'revision_signal_unreadable');
  assert.equal(Object.hasOwn(candidate,'habit'),false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),savedV1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),storedV2);
  assert.equal(app.wal.getPendingRows().rows.length,0);
  assert.equal((await app.runtime.inspectPilotReadiness()).eligible,true);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('guarded V2 readiness rejects revision-signal read denial after asynchronous scan',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const db=await app.runtime.open();
  const originalTx=db.transaction.bind(db);
  const originalGet=app.localStorage.getItem.bind(app.localStorage);
  const signalKey=app.runtime.getStatus().revisionSignalKey;
  let injected=0;
  db.transaction=(...args)=>{
    const tx=originalTx(...args);
    const originalStore=tx.objectStore.bind(tx);
    tx.objectStore=name=>{
      const store=originalStore(name);
      if(name==='habits'){
        const getAll=store.getAll.bind(store);
        store.getAll=(...params)=>{
          if(injected++===0){
            app.localStorage.getItem=key=>{
              if(String(key)===signalKey) throw Error('midflight revision probe denied');
              return originalGet(key);
            };
          }
          return getAll(...params);
        };
      }
      return store;
    };
    return tx;
  };
  const refused=await app.runtime.readPilotHabitCandidate('h1');
  db.transaction=originalTx;
  app.localStorage.getItem=originalGet;
  assert.equal(injected,1);
  assert.equal(refused.eligible,false);
  assert.equal(refused.reason,'revision_signal_unreadable');
  assert.equal(Object.hasOwn(refused,'completions'),false);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  assert.equal((await app.runtime.inspectPilotReadiness()).eligible,true);
});

test('explicit parity forensics reports both matched and preserved mismatch without reseeding',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalV1=app.localStorage.getItem(LEGACY_KEY);
  const originalMirror=structuredClone(app.indexedDB.dump(DB_NAME));
  const matched=await app.runtime.inspectPreservedParityMismatch();
  assert.equal(matched.checked,true);
  assert.equal(matched.stable,true,JSON.stringify(matched));
  assert.equal(matched.mismatch,false);
  assert.equal(matched.reason,'pilot_parity_matched');
  assert.equal(matched.canRepair,false);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),originalMirror);

  // Simulate an unexplained V1-only write after the pilot was last verified.
  app.localStorage.setItem(LEGACY_KEY,JSON.stringify(legacyState('h1','Independent newer V1 edit')));
  const discrepantV1=app.localStorage.getItem(LEGACY_KEY);
  const beforeInspection=structuredClone(app.indexedDB.dump(DB_NAME));
  const report=await app.runtime.inspectPreservedParityMismatch();
  assert.equal(report.checked,true);
  assert.equal(report.stable,true,JSON.stringify(report));
  assert.equal(report.mismatch,true);
  assert.equal(report.canRepair,false);
  assert.equal(report.evidencePreserved,true);
  assert.equal(report.reason,'same_generation_parity_mismatch_preserved');
  assert.equal(report.evidence.changedHabits,1);
  assert.equal(report.evidence.destructiveReseedBlocked,true);
  assert.equal(report.mutationAuthority,'legacy_only');
  assert.equal(report.readAuthority,'legacy_only');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),discrepantV1);
  assert.notEqual(discrepantV1,originalV1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),beforeInspection,
    'forensics must not silently repair or overwrite either side');

  app.localStorage.setItem(LEGACY_KEY,originalV1);
  const recovered=await app.runtime.inspectPreservedParityMismatch();
  assert.equal(recovered.stable,true);
  assert.equal(recovered.mismatch,false);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),originalMirror);
});

test('parity forensics does not create V2 storage when no mirror was opened',async()=>{
  const app=install();
  const v1=app.localStorage.getItem(LEGACY_KEY);
  const evidence=await app.runtime.inspectPreservedParityMismatch();
  assert.equal(evidence.checked,true);
  assert.equal(evidence.stable,false);
  assert.equal(evidence.reason,'v2_not_open');
  assert.equal(evidence.canRepair,false);
  assert.equal(app.indexedDB.dump(DB_NAME),null);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),v1);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('parity forensics refuses a V2-only store edit that never increments revision',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const beforeV1=app.localStorage.getItem(LEGACY_KEY);
  const beforeMeta=structuredClone(runtimeMeta(app));
  const db=await app.runtime.open();
  const originalTransaction=db.transaction.bind(db);
  let reads=0;
  db.transaction=function(names,mode){
    if(Array.isArray(names) && names.includes('habits') && names.includes('completions')){
      reads++;
      if(reads===2){
        // A noncooperating IndexedDB client bypasses the revision marker.
        // Forensics must compare both raw store observations anyway.
        const old=db._stores.get('habits').get('h1');
        db._stores.get('habits').set('h1',{
          ...old,value:{...old.value,name:'Foreign V2-only update during forensics'}
        });
      }
    }
    return originalTransaction(names,mode);
  };
  let refused;
  try{refused=await app.runtime.inspectPreservedParityMismatch();}
  finally{db.transaction=originalTransaction;}
  assert.equal(reads,2);
  assert.equal(refused.stable,false,JSON.stringify(refused));
  assert.equal(refused.mismatch,null);
  assert.equal(refused.reason,'v2_collections_changed_during_inspection');
  assert.equal(refused.canRepair,false);
  assert.equal(refused.evidencePreserved,true);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),beforeV1);
  assert.deepEqual(runtimeMeta(app),beforeMeta,'no silent metadata or revision repair');
  assert.equal(app.indexedDB.dump(DB_NAME).habits[0].value.name,
    'Foreign V2-only update during forensics','the independent V2 write must be preserved');
  const stable=await app.runtime.inspectPreservedParityMismatch();
  assert.equal(stable.stable,true,JSON.stringify(stable));
  assert.equal(stable.mismatch,true);
  assert.equal(stable.evidence.changedHabits,1);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('parity forensics refuses a V1 write while an IndexedDB read is underway',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const db=await app.runtime.open();
  const originalTransaction=db.transaction.bind(db);
  const beforeMirror=structuredClone(app.indexedDB.dump(DB_NAME));
  const newV1=JSON.stringify(legacyState('h1','V1 writer during forensic read'));
  let injected=false;
  db.transaction=function(names,mode){
    if(!injected && Array.isArray(names)&&names.includes('habits')){
      injected=true;
      app.localStorage.setItem(LEGACY_KEY,newV1);
    }
    return originalTransaction(names,mode);
  };
  let refused;
  try{refused=await app.runtime.inspectPreservedParityMismatch();}
  finally{db.transaction=originalTransaction;}
  assert.equal(injected,true);
  assert.equal(refused.stable,false,JSON.stringify(refused));
  assert.equal(refused.mismatch,null);
  assert.equal(refused.reason,'inspection_window_changed');
  assert.equal(refused.canRepair,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),newV1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),beforeMirror);
  const stable=await app.runtime.inspectPreservedParityMismatch();
  assert.equal(stable.stable,true,JSON.stringify(stable));
  assert.equal(stable.mismatch,true);
  assert.equal(stable.evidence.changedHabits,1);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('parity forensics rejects a preview opt-out during the mirror scan',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const db=await app.runtime.open();
  const originalTransaction=db.transaction.bind(db);
  const source=app.localStorage.getItem(LEGACY_KEY);
  const before=structuredClone(app.indexedDB.dump(DB_NAME));
  let triggered=false;
  db.transaction=function(names,mode){
    if(!triggered && Array.isArray(names)&&names.includes('habits')){
      triggered=true;
      app.runtime.disableDarkMirror();
    }
    return originalTransaction(names,mode);
  };
  let refused;
  try{refused=await app.runtime.inspectPreservedParityMismatch();}
  finally{db.transaction=originalTransaction;}
  assert.equal(triggered,true);
  assert.equal(refused.stable,false,JSON.stringify(refused));
  assert.equal(refused.mismatch,null);
  assert.equal(refused.reason,'dark_mode_changed_during_inspection');
  assert.equal(refused.canRepair,false);
  assert.equal(app.runtime.isDarkEnabled(),false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),source);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),before);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('preview peer probe refuses unsupported channels and never creates authority',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const original=app.localStorage.getItem(LEGACY_KEY);
  const mirrored=structuredClone(app.indexedDB.dump(DB_NAME));
  const report=await app.runtime.inspectPreviewWriterPeers();
  assert.equal(report.reason,'coordination_channel_unavailable');
  assert.equal(report.observedPeerCount,0);
  assert.equal(report.allLegacyWritersKnown,false);
  assert.equal(report.productionWritersFenced,false);
  assert.equal(report.canPromote,false);
  assert.equal(report.mutationAuthority,'legacy_only');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),original);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),mirrored);
});

test('preview peer challenge observes a participating tab but never equates replies with full writer coverage',async()=>{
  const app=install({uuidNamespace:'peer-a'}),other=install({uuidNamespace:'peer-b'});
  // Synthetic same-origin, same-generation MessageChannel network. No V1
  // save path or IndexedDB record is altered by either participant.
  const channels=new Set();
  class SimulatedBroadcastChannel {
    constructor(name){this.name=name;this.listeners=[];channels.add(this);}
    addEventListener(type,handler){if(type==='message')this.listeners.push(handler);}
    postMessage(data){
      for(const peer of channels){
        if(peer===this || peer.name!==this.name)continue;
        queueMicrotask(()=>peer.listeners.forEach(fn=>fn({data})));
      }
    }
    close(){channels.delete(this);}
  }
  for(const a of [app,other]){
    a.context.BroadcastChannel=SimulatedBroadcastChannel;
    a.context.navigator={locks:{request:async()=>null}};
  }
  await app.runtime.startCoordinatedDarkMirror();
  other.localStorage.setItem(GENERATION_KEY,app.generation.read());
  await other.runtime.startCoordinatedDarkMirror();
  const original1=app.localStorage.getItem(LEGACY_KEY);
  const original2=other.localStorage.getItem(LEGACY_KEY);
  const v2Before=structuredClone(app.indexedDB.dump(DB_NAME));
  const observed=await app.runtime.inspectPreviewWriterPeers();
  assert.equal(observed.reason,'observational_probe_only',JSON.stringify(observed));
  assert.equal(observed.observedPeerCount,1);
  assert.equal(observed.peers[0].previewEnabled,true);
  assert.equal(observed.peers[0].sameGeneration,true);
  assert.equal(observed.peers[0].webLocksSupported,true);
  assert.equal(observed.allLegacyWritersKnown,false);
  assert.equal(observed.productionWritersFenced,false);
  assert.equal(observed.canPromote,false);
  assert.equal(observed.mutationAuthority,'legacy_only');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),original1);
  assert.equal(other.localStorage.getItem(LEGACY_KEY),original2);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),v2Before);
  const observedReverse=await other.runtime.inspectPreviewWriterPeers();
  assert.equal(observedReverse.observedPeerCount,1,JSON.stringify(observedReverse));
  assert.equal(observedReverse.canPromote,false);
});

test('preview peer challenge detects a responding tab without Web Locks',async()=>{
  const app=install({uuidNamespace:'peer-a'}),other=install({uuidNamespace:'peer-b'});
  const channels=new Set();
  class SimulatedBroadcastChannel{
    constructor(name){this.name=name;this.listeners=[];channels.add(this);}
    addEventListener(type,handler){if(type==='message')this.listeners.push(handler);}
    postMessage(data){for(const peer of channels)if(peer!==this&&peer.name===this.name)
      queueMicrotask(()=>peer.listeners.forEach(fn=>fn({data})));}
    close(){channels.delete(this);}
  }
  app.context.BroadcastChannel=SimulatedBroadcastChannel;
  other.context.BroadcastChannel=SimulatedBroadcastChannel;
  app.context.navigator={locks:{request:async()=>null}};
  await app.runtime.startCoordinatedDarkMirror();
  other.localStorage.setItem(GENERATION_KEY,app.generation.read());
  await other.runtime.startCoordinatedDarkMirror();
  const report=await app.runtime.inspectPreviewWriterPeers();
  assert.equal(report.observedPeerCount,1);
  assert.equal(report.peers[0].webLocksSupported,false);
  assert.equal(report.reason,'observed_peer_not_ready');
  assert.equal(report.allLegacyWritersKnown,false);
  assert.equal(report.canPromote,false);
});

test('cooperative shared writer rehearsal stays explicit and refuses unsupported/production contexts',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const original=app.localStorage.getItem(LEGACY_KEY);
  let attempts=0,executed=0;
  app.context.navigator={locks:{request:async()=>{attempts++;throw Error('not expected');}}};
  const onUnknownHost=await app.runtime.exercisePreviewCooperativeWriterLease(()=>executed++);
  assert.equal(onUnknownHost.reason,'preview_host_required');
  app.context.location.hostname='localhost';
  const noOperation=await app.runtime.exercisePreviewCooperativeWriterLease();
  assert.equal(noOperation.reason,'operation_required');
  app.context.navigator={};
  const unsupported=await app.runtime.exercisePreviewCooperativeWriterLease(()=>executed++);
  assert.equal(unsupported.reason,'lock_manager_unavailable');
  assert.equal(unsupported.canPromote,false);
  assert.equal(attempts,0);
  assert.equal(executed,0);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),original);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('cooperative writer shares the handoff lock but never promotes authority',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.context.location.hostname='localhost';
  const legacy=app.localStorage.getItem(LEGACY_KEY);
  const mirror=structuredClone(app.indexedDB.dump(DB_NAME));
  let request=null,executions=0;
  app.context.navigator={locks:{request:async(name,opts,callback)=>{
    request={name,options:opts};
    return callback({name,mode:'shared'});
  }}};
  const proof=await app.runtime.exercisePreviewCooperativeWriterLease(async()=>{
    executions++;
    // One explicit fixture operation; production V1 writes are not wrapped.
    app.localStorage.setItem('taskpoints_cooperating_writer_fixture','written');
    await Promise.resolve();
  });
  assert.equal(executions,1);
  assert.equal(request.name,'taskpoints_v2_writer_handoff_rehearsal_v1');
  assert.deepEqual(JSON.parse(JSON.stringify(request.options)),
    {mode:'shared',ifAvailable:true});
  assert.equal(proof.sharedLockAcquired,true,JSON.stringify(proof));
  assert.equal(proof.operationRan,true);
  assert.equal(proof.lockHeldAfterReturn,false);
  assert.equal(proof.reason,'cooperative_shared_lock_rehearsed');
  assert.equal(proof.canPromote,false);
  assert.equal(proof.productionWritersFenced,false);
  assert.equal(proof.allLegacyWritersKnown,false);
  assert.equal(proof.mutationAuthority,'legacy_only');
  assert.equal(proof.readAuthority,'legacy_only');
  assert.equal(app.localStorage.getItem('taskpoints_cooperating_writer_fixture'),'written');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),legacy);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),mirror);
});

test('cooperative writer lock conflicts, callback errors and generation changes fail closed',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.context.location.hostname='localhost';
  const original=app.localStorage.getItem(LEGACY_KEY);
  app.context.navigator={locks:{request:async(name,opts,callback)=>callback(null)}};
  let called=0;
  const busy=await app.runtime.exercisePreviewCooperativeWriterLease(()=>called++);
  assert.equal(busy.reason,'lock_held_elsewhere');
  assert.equal(busy.operationRan,false);
  assert.equal(called,0);
  app.context.navigator.locks.request=async(name,opts,cb)=>cb({name});
  const failed=await app.runtime.exercisePreviewCooperativeWriterLease(()=>{
    called++;
    throw Error('synthetic failed cooperative operation');
  });
  assert.equal(failed.reason,'cooperative_operation_failed');
  assert.equal(failed.sharedLockAcquired,true);
  assert.equal(failed.operationRan,true);
  assert.equal(failed.canPromote,false);
  assert.equal(called,1);
  const stale=await app.runtime.exercisePreviewCooperativeWriterLease(async()=>{
    app.runtime.disableDarkMirror();
    app.runtime.enableDarkMirror();
  });
  assert.equal(stale.reason,'generation_or_preview_changed_under_lock');
  assert.equal(stale.sharedLockAcquired,true);
  assert.equal(stale.canPromote,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),original);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('writer-lock rehearsal refuses unsupported browsers, stays nonauthoritative, and never writes state',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const legacy=app.localStorage.getItem(LEGACY_KEY);
  const v2=structuredClone(app.indexedDB.dump(DB_NAME));
  const unsupported=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(unsupported.lockAcquired,false);
  assert.equal(unsupported.reason,'lock_manager_unavailable');
  assert.equal(unsupported.canPromote,false);
  let seen=null;
  app.context.navigator={locks:{
    async request(name,options,callback) {
      seen={name,options};
      return callback({name,mode:options.mode});
    }
  }};
  const proof=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(seen.name,'taskpoints_v2_writer_handoff_rehearsal_v1');
  assert.deepEqual(JSON.parse(JSON.stringify(seen.options)),{mode:'exclusive',ifAvailable:true});
  assert.equal(proof.lockAcquired,true,JSON.stringify(proof));
  assert.equal(proof.lockHeldAfterReturn,false);
  assert.equal(proof.rollbackSourceStable,true);
  assert.equal(proof.canPromote,false);
  assert.equal(proof.mutationAuthority,'legacy_only');
  assert.ok(proof.blockers.includes('durable_authority_rollback_not_implemented'));
  assert.equal(app.localStorage.getItem(LEGACY_KEY),legacy);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),v2);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('busy and denied cross-tab writer lock never grant mutation authority or destroy records',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const legacy=app.localStorage.getItem(LEGACY_KEY);
  const v2=structuredClone(app.indexedDB.dump(DB_NAME));
  app.context.navigator={locks:{request:async(name,options,callback)=>callback(null)}};
  const busy=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(busy.lockAcquired,false);
  assert.equal(busy.reason,'lock_held_elsewhere');
  app.context.navigator.locks.request=async()=>{throw Error('synthetic SecurityError')};
  const denied=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(denied.lockAcquired,false);
  assert.equal(denied.reason,'lock_request_failed');
  assert.equal(denied.canPromote,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),legacy);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),v2);
});

test('writer-lock rehearsal rejects V1 changes while holding exclusive lock',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.context.navigator={locks:{request:async(name,options,callback)=>{
    app.localStorage.setItem(LEGACY_KEY,JSON.stringify(legacyState('h1','Concurrent external V1 edit')));
    return callback({name});
  }}};
  const originalV2=structuredClone(app.indexedDB.dump(DB_NAME));
  const failed=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(failed.lockAcquired,false);
  assert.equal(failed.reason,'pilot_changed_under_lock');
  assert.equal(failed.canPromote,false);
  assert.equal(JSON.parse(app.localStorage.getItem(LEGACY_KEY)).habits[0].name,'Concurrent external V1 edit');
  assert.deepEqual(app.indexedDB.dump(DB_NAME),originalV2);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('writer-lock rehearsal detects nonpilot legacy settings edited by an unfenced tab',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const key='taskpoints_unrelated_legacy_preferences';
  app.localStorage.setItem(key,'before');
  const v1=app.localStorage.getItem(LEGACY_KEY);
  const pilot=structuredClone(app.indexedDB.dump(DB_NAME));
  let acquired=false;
  app.context.navigator={locks:{request:async(name,options,callback)=>{
    acquired=true;
    // An ordinary V1 settings page is not required to acquire this V2
    // rehearsal lock. A pilot-only revision check would miss the edit.
    app.localStorage.setItem(key,'updated by independent legacy tab');
    return callback({name,mode:options.mode});
  }}};
  const denied=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(acquired,true);
  assert.equal(denied.lockAcquired,false);
  assert.equal(denied.reason,'legacy_changed_under_lock');
  assert.equal(denied.canPromote,false);
  assert.equal(denied.mutationAuthority,'legacy_only');
  assert.equal(app.localStorage.getItem(key),'updated by independent legacy tab');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),v1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),pilot);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  // A fresh rehearsal is allowed when the legacy source has stopped
  // changing. No permanent writer authority is granted in either pass.
  const retry=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(retry.lockAcquired,true,JSON.stringify(retry));
  assert.equal(retry.canPromote,false);
});

test('writer-lock rehearsal refuses legacy inventory read denial under the lock',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const source=app.localStorage.getItem(LEGACY_KEY);
  const originalKey=app.localStorage.key.bind(app.localStorage);
  const snapshot=structuredClone(app.indexedDB.dump(DB_NAME));
  app.context.navigator={locks:{request:async(name,options,callback)=>{
    app.localStorage.key=()=>{throw Error('synthetic localStorage permission revoked');};
    try{return await callback({name,mode:options.mode});}
    finally{app.localStorage.key=originalKey;}
  }}};
  const denied=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(denied.lockAcquired,false);
  // The rollback-source audit fails closed before the separate full
  // inventory hash is attempted, because WAL enumeration is unavailable.
  assert.equal(denied.reason,'rollback_source_unavailable');
  assert.equal(denied.canPromote,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),source);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),snapshot);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('writer rehearsal refuses a pending V1 journal even when pilot parity matches',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  // This fake core returns a stable journal but has a no-op overlay replay.
  // Pilot parity therefore remains green despite incomplete V1 compaction.
  app.core.readPendingHabitDeltas=()=>[delta()];
  const report=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(report.checks.pilotConsistent,true,JSON.stringify(report));
  assert.equal(report.checks.legacyJournalEmpty,false);
  let lockRequests=0;
  app.context.navigator={locks:{request:async()=>{lockRequests++;throw Error('lock must not be requested');}}};
  const refused=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(refused.lockAcquired,false);
  assert.equal(refused.reason,'handoff_prerequisites_blocked');
  assert.equal(refused.canPromote,false);
  assert.equal(lockRequests,0);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('writer rehearsal refuses observed bridge failures even with good pilot parity',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalStatus=app.bridge.getStatus;
  app.bridge.getStatus=()=>({...originalStatus(),failures:1});
  const report=await app.runtime.inspectMutationHandoffPrerequisites();
  assert.equal(report.checks.pilotConsistent,true,JSON.stringify(report));
  assert.equal(report.checks.noObservedBridgeFailures,false);
  let lockRequests=0;
  app.context.navigator={locks:{request:async()=>{lockRequests++;throw Error('lock must not be requested');}}};
  const refused=await app.runtime.rehearseExclusiveWriterLease();
  app.bridge.getStatus=originalStatus;
  assert.equal(refused.reason,'handoff_prerequisites_blocked');
  assert.equal(refused.canPromote,false);
  assert.equal(lockRequests,0);
});

test('writer rehearsal refuses new bridge failures after lock acquisition',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const source=app.localStorage.getItem(LEGACY_KEY);
  const v2=structuredClone(app.indexedDB.dump(DB_NAME));
  const originalStatus=app.bridge.getStatus;
  let lockEntered=false;
  app.context.navigator={locks:{request:async(name,options,callback)=>{
    lockEntered=true;
    app.bridge.getStatus=()=>({...originalStatus(),failures:1});
    return callback({name,mode:options.mode});
  }}};
  let refusal;
  try{refusal=await app.runtime.rehearseExclusiveWriterLease();}
  finally{app.bridge.getStatus=originalStatus;}
  assert.equal(lockEntered,true);
  assert.equal(refusal.lockAcquired,false);
  assert.equal(refusal.reason,'handoff_prerequisites_changed_under_lock');
  assert.equal(refusal.canPromote,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),source);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),v2);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('writer rehearsal rejects a nonpilot V1 write during asynchronous lock verification',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const key='taskpoints_unfenced_note_during_digest';
  app.localStorage.setItem(key,'before');
  const rawV1=app.localStorage.getItem(LEGACY_KEY);
  const snapshot=structuredClone(app.indexedDB.dump(DB_NAME));
  const originalDigest=app.context.crypto.subtle.digest;
  let calls=0;
  app.context.navigator={locks:{request:async(name,options,callback)=>
    callback({name,mode:options.mode})}};
  app.context.crypto.subtle.digest=async function(type,bytes){
    calls++;
    if(calls===2){
      // Yield during the in-lock digest, after the bytes were captured but
      // before their checksum resolves, as an ordinary legacy tab might do.
      await Promise.resolve();
      app.localStorage.setItem(key,'changed during SHA-256');
    }
    return originalDigest.call(this,type,bytes);
  };
  let result;
  try { result=await app.runtime.rehearseExclusiveWriterLease(); }
  finally { app.context.crypto.subtle.digest=originalDigest; }
  assert.equal(calls,2);
  assert.equal(result.lockAcquired,false,JSON.stringify(result));
  assert.equal(result.reason,'legacy_changed_during_lock_verification');
  assert.equal(result.canPromote,false);
  assert.equal(app.localStorage.getItem(key),'changed during SHA-256');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),rawV1);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),snapshot);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  const retry=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(retry.lockAcquired,true,JSON.stringify(retry));
  assert.equal(retry.canPromote,false);
});

test('writer rehearsal refuses a lost legacy inventory read after SHA-256 resolves',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalDigest=app.context.crypto.subtle.digest;
  const originalKey=app.localStorage.key.bind(app.localStorage);
  const originalV1=app.localStorage.getItem(LEGACY_KEY);
  let calls=0;
  app.context.navigator={locks:{request:async(name,options,callback)=>
    callback({name,mode:options.mode})}};
  app.context.crypto.subtle.digest=async function(type,bytes){
    calls++;
    const hashed=await originalDigest.call(this,type,bytes);
    if(calls===2) app.localStorage.key=()=>{throw Error('storage enumeration revoked mid-digest');};
    return hashed;
  };
  let denied;
  try { denied=await app.runtime.rehearseExclusiveWriterLease(); }
  finally {
    app.localStorage.key=originalKey;
    app.context.crypto.subtle.digest=originalDigest;
  }
  assert.equal(calls,2);
  assert.equal(denied.lockAcquired,false);
  assert.equal(denied.reason,'legacy_inventory_unreadable');
  assert.equal(denied.canPromote,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),originalV1);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('writer rehearsal refuses preview off-on cycle while an in-lock digest is pending',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const legacy=app.localStorage.getItem(LEGACY_KEY);
  const originalDigest=app.context.crypto.subtle.digest;
  let calls=0;
  app.context.navigator={locks:{request:async(name,options,callback)=>
    callback({name,mode:options.mode})}};
  app.context.crypto.subtle.digest=async function(type,bytes){
    calls++;
    if(calls===2){
      await Promise.resolve();
      app.runtime.disableDarkMirror();
      app.runtime.enableDarkMirror();
    }
    return originalDigest.call(this,type,bytes);
  };
  let refused;
  try { refused=await app.runtime.rehearseExclusiveWriterLease(); }
  finally { app.context.crypto.subtle.digest=originalDigest; }
  assert.equal(calls,2);
  assert.equal(refused.lockAcquired,false,JSON.stringify(refused));
  assert.equal(refused.reason,'dark_mode_changed_during_lock_verification');
  assert.equal(refused.canPromote,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),legacy);
  assert.equal(app.runtime.isDarkEnabled(),true);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('legacy rollback-source audit remains read-only, reports complete V1 scope and refuses WAL denial',async()=>{
  const app=install({initialState:{...legacyState(),
    completions:[{id:'task-one',source:'task',points:1},{id:'task-two',source:'task',points:2}]}});
  await app.runtime.startCoordinatedDarkMirror();
  const raw=app.localStorage.getItem(LEGACY_KEY);
  const mirror=structuredClone(app.indexedDB.dump(DB_NAME));
  const report=await app.runtime.inspectLegacyRollbackSource();
  assert.equal(report.sourceStable,true,JSON.stringify(report));
  assert.equal(report.checkpointExists,false);
  assert.equal(report.canRestoreFromCheckpoint,false);
  assert.equal(report.counts.completions,2);
  assert.equal(report.mutationAuthority,'legacy_only');
  const orig=app.wal.getPendingRows.bind(app.wal);
  app.wal.getPendingRows=()=>({ok:false,error:'synthetic denied WAL'});
  const denied=await app.runtime.inspectLegacyRollbackSource();
  app.wal.getPendingRows=orig;
  assert.equal(denied.sourceStable,false);
  assert.equal(denied.reason,'wal_unreadable');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),raw);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),mirror);
});

test('legacy rollback-source audit refuses inaccessible and changed Habit-order overlay evidence',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const source=app.localStorage.getItem(LEGACY_KEY);
  const mirror=structuredClone(app.indexedDB.dump(DB_NAME));
  const key='taskpoints_habit_order_overlay_v1';
  const originalGet=app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem=value=>{
    if(String(value)===key)throw Error('overlay inaccessible in suspended tab');
    return originalGet(value);
  };
  const unreadable=await app.runtime.inspectLegacyRollbackSource();
  app.localStorage.getItem=originalGet;
  assert.equal(unreadable.sourceStable,false);
  assert.equal(unreadable.reason,'legacy_inventory_unreadable');
  app.localStorage.setItem(key,JSON.stringify({orders:{h1:1}}));
  let requested=0;
  app.localStorage.getItem=value=>{
    if(String(value)===key && requested++===1)
      app.localStorage.setItem(key,JSON.stringify({orders:{h1:2}}));
    return originalGet(value);
  };
  const changed=await app.runtime.inspectLegacyRollbackSource();
  app.localStorage.getItem=originalGet;
  assert.equal(changed.sourceStable,false);
  assert.equal(changed.reason,'legacy_changed_during_inventory');
  assert.equal(changed.checkpointExists,false);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),source);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),mirror);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('writer-lock rehearsal rejects a pending WAL before requesting exclusivity',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  let requested=0;
  app.context.navigator={locks:{request:async()=>{requested++;throw Error('must not acquire')}}};
  const pending=app.wal.appendHabitDelta(delta());
  const report=await app.runtime.rehearseExclusiveWriterLease();
  assert.equal(report.lockAcquired,false);
  assert.equal(report.reason,'pilot_not_consistent');
  assert.equal(requested,0);
  assert.equal(app.wal.getPendingRows().rows[0].id,pending.mutationId);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('explicit checkpoint captures full V1 namespace independently of V2 and verifies integrity',async()=>{
  const app=install({initialState:{
    ...legacyState(),
    completions:[{id:'task:old',source:'task',points:3}]
  }});
  await app.runtime.startCoordinatedDarkMirror();
  app.localStorage.setItem('taskpoints_habit_order_overlay_v1','{"h1":2}');
  app.localStorage.setItem('taskpoints_v2_independent_mutation_sample','{"id":"old"}');
  const source=app.localStorage.getItem(LEGACY_KEY);
  const v2=structuredClone(app.indexedDB.dump(DB_NAME));
  const checkpoint=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(checkpoint.saved,true,JSON.stringify(checkpoint));
  assert.equal(checkpoint.verified,true);
  assert.equal(checkpoint.sourceStable,true);
  assert.equal(checkpoint.canAutoRestore,false);
  assert.equal(checkpoint.mutationAuthority,'legacy_only');
  const recovery='taskpoints_v2_recovery_checkpoints_preview';
  const record=app.indexedDB.dump(recovery)?.snapshots?.[0];
  assert.ok(record);
  assert.equal(record.id,checkpoint.checkpointId);
  const captured=new Map(record.entries);
  assert.equal(captured.get(LEGACY_KEY),source);
  assert.equal(captured.get('taskpoints_habit_order_overlay_v1'),'{"h1":2}');
  assert.equal(captured.get('taskpoints_v2_independent_mutation_sample'),'{"id":"old"}');
  assert.equal(captured.get(GENERATION_KEY),app.generation.read());
  const integrity=await app.runtime.inspectPreviewRecoveryCheckpoint(checkpoint.checkpointId);
  assert.equal(integrity.intact,true,JSON.stringify(integrity));
  assert.equal(integrity.canAutoRestore,false);
  assert.equal(integrity.keyCount,record.entries.length);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),v2);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),source);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('a previously saved checkpoint survives a second denied/quota checkpoint write',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const first=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(first.saved,true,JSON.stringify(first));
  const dbName='taskpoints_v2_recovery_checkpoints_preview';
  const original=structuredClone(app.indexedDB.dump(dbName));
  app.localStorage.setItem('taskpoints_custom_later_note','keep this latest');
  app.indexedDB.failNext({store:'snapshots',operation:'add',
    error:new Error('synthetic QuotaExceededError')});
  const failed=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(failed.saved,false);
  assert.equal(failed.reason,'checkpoint_write_failed');
  assert.deepEqual(app.indexedDB.dump(dbName),original);
  assert.equal((await app.runtime.inspectPreviewRecoveryCheckpoint(first.checkpointId)).intact,true);
  assert.equal(app.localStorage.getItem('taskpoints_custom_later_note'),'keep this latest');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('checkpoint inspection flags damaged data without returning private payloads or auto-repairing',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const made=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(made.saved,true);
  const db=await new Promise((resolve,reject)=>{
    const req=app.indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  const original=structuredClone(app.indexedDB.dump(db.name).snapshots[0]);
  const corrupted=structuredClone(original);
  corrupted.entries[0][1]='tampered checkpoint byte';
  const tx=db.transaction('snapshots','readwrite');
  tx.objectStore('snapshots').put(corrupted);
  await new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
  const verdict=await app.runtime.inspectPreviewRecoveryCheckpoint(made.checkpointId);
  assert.equal(verdict.intact,false);
  assert.equal(verdict.reason,'checkpoint_integrity_failed');
  assert.equal(verdict.canAutoRestore,false);
  assert.equal(Object.hasOwn(verdict,'entries'),false);
  assert.equal(app.indexedDB.dump(db.name).snapshots[0].entries[0][1],'tampered checkpoint byte');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('checkpoint cannot be declared saved when V1 namespace enumeration is unreadable',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const get=app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem=key=>{
    if(String(key)===LEGACY_KEY) throw Error('synthetic denied key');
    return get(key);
  };
  const result=await app.runtime.createPreviewRecoveryCheckpoint();
  app.localStorage.getItem=get;
  assert.equal(result.saved,false);
  assert.equal(result.canAutoRestore,false);
  assert.equal(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'),null);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('checkpoint creation fails closed without WebCrypto rather than saving an unauthenticated checksum',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const v1=app.localStorage.getItem(LEGACY_KEY);
  const originalSubtle=app.context.crypto.subtle;
  app.context.crypto.subtle=null;
  const noHash=await app.runtime.createPreviewRecoveryCheckpoint();
  app.context.crypto.subtle=originalSubtle;
  assert.equal(noHash.saved,false);
  assert.equal(noHash.reason,'checkpoint_write_failed');
  assert.equal(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'),null);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),v1);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
  const fresh=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(fresh.saved,true,JSON.stringify(fresh));
  const inspected=await app.runtime.inspectPreviewRecoveryCheckpoint(fresh.checkpointId);
  assert.equal(inspected.intact,true);
  assert.match(inspected.fingerprint,/^sha256:[0-9a-f]{64}:\d+$/);
  assert.equal(inspected.canAutoRestore,false);
});

test('explicit checkpoint snapshots can coexist without overwriting older snapshots',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const first=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(first.saved,true,JSON.stringify(first));
  const initial=structuredClone(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview').snapshots[0]);
  app.localStorage.setItem('taskpoints_newer_private_note','version two');
  const second=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(second.saved,true,JSON.stringify(second));
  assert.notEqual(second.checkpointId,first.checkpointId);
  const rows=app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview').snapshots;
  assert.equal(rows.length,2);
  assert.deepEqual(rows.find(row=>row.id===first.checkpointId),initial);
  assert.equal((await app.runtime.inspectPreviewRecoveryCheckpoint(first.checkpointId)).intact,true);
  assert.equal((await app.runtime.inspectPreviewRecoveryCheckpoint(second.checkpointId)).intact,true);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('immutable recovery checkpoint remains intact after V2 pilot database is cleared in isolation',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const first=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(first.saved,true,JSON.stringify(first));
  const before=structuredClone(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'));
  const source=app.localStorage.getItem(LEGACY_KEY);
  // Simulate an independent V2 mirror failure or reinitialization. This
  // alters only the fake V2 stores, never actual V1 or the recovery DB.
  const db=await app.runtime.open();
  const tx=db.transaction(['habits','completions','mutations','meta'],'readwrite');
  for(const name of ['habits','completions','mutations','meta'])
    tx.objectStore(name).clear();
  await new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
  const after=await app.runtime.inspectPreviewRecoveryCheckpoint(first.checkpointId);
  assert.equal(after.intact,true,JSON.stringify(after));
  assert.deepEqual(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'),before);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),source);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('checkpoint refuses lost legacy enumeration permission without opening a recovery database',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const originalKey=app.localStorage.key.bind(app.localStorage);
  app.localStorage.key=()=>{throw Error('storage enumeration denied');};
  const denied=await app.runtime.createPreviewRecoveryCheckpoint();
  app.localStorage.key=originalKey;
  assert.equal(denied.saved,false);
  assert.equal(denied.reason,'legacy_source_wal_unreadable',
    'WAL inventory denial must fail before checkpoint creation even starts');
  assert.equal(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'),null);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('V1 changing during asynchronous checkpoint hashing is rejected before an immutable copy is written',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const before=app.localStorage.getItem(LEGACY_KEY);
  const newV1=JSON.stringify(legacyState('h1','External edit while checkpoint saves'));
  const originalDigest=app.context.crypto.subtle.digest.bind(app.context.crypto.subtle);
  let changed=0;
  app.context.crypto.subtle.digest=async(type,bytes)=>{
    if(changed++===0)app.localStorage.setItem(LEGACY_KEY,newV1);
    return originalDigest(type,bytes);
  };
  let rejected;
  try { rejected=await app.runtime.createPreviewRecoveryCheckpoint(); }
  finally { app.context.crypto.subtle.digest=originalDigest; }
  assert.notEqual(newV1,before);
  assert.equal(rejected.saved,false,JSON.stringify(rejected));
  assert.equal(rejected.sourceStable,false);
  assert.equal(rejected.reason,'legacy_changed_during_capture');
  assert.equal(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'),null,
    'an inconsistent snapshot must not become durable rollback evidence');
  assert.equal(app.localStorage.getItem(LEGACY_KEY),newV1);
  const retry=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(retry.saved,true,JSON.stringify(retry));
  assert.equal(retry.sourceStable,true);
  const record=app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview').snapshots[0];
  assert.equal(new Map(record.entries).get(LEGACY_KEY),newV1,
    'clean retry captures the newest authoritative V1 bytes');
  assert.equal((await app.runtime.inspectPreviewRecoveryCheckpoint(retry.checkpointId)).intact,true);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('post-capture V1 changes preserve a verified historical copy without treating it as current',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const before=app.localStorage.getItem(LEGACY_KEY);
  const newV1=JSON.stringify(legacyState('h1','External edit after checkpoint validation'));
  const originalDigest=app.context.crypto.subtle.digest.bind(app.context.crypto.subtle);
  let digests=0;
  app.context.crypto.subtle.digest=async(type,bytes)=>{
    // The first two digests check the captured and freshly re-read namespace.
    // A later unrelated writer can still win after those checks. The
    // checkpoint is historical evidence, never a live restoration token.
    if(++digests===3) app.localStorage.setItem(LEGACY_KEY,newV1);
    return originalDigest(type,bytes);
  };
  let result;
  try { result=await app.runtime.createPreviewRecoveryCheckpoint(); }
  finally { app.context.crypto.subtle.digest=originalDigest; }
  assert.equal(result.saved,true,JSON.stringify(result));
  assert.equal(result.verified,true);
  assert.equal(result.sourceStable,false);
  assert.equal(result.reason,'checkpoint_saved_but_source_changed');
  const record=app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview').snapshots[0];
  assert.equal(new Map(record.entries).get(LEGACY_KEY),before,
    'a historical checkpoint must retain its own immutable pre-edit bytes');
  assert.equal((await app.runtime.inspectPreviewRecoveryCheckpoint(result.checkpointId)).intact,true);
  assert.equal(app.localStorage.getItem(LEGACY_KEY),newV1);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('preview-only rollback plan reports changed, removed, and new V1 keys without restoring them',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  app.localStorage.setItem('taskpoints_old_custom_note','older');
  app.localStorage.setItem('taskpoints_deleted_note','included in checkpoint');
  const first=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(first.saved,true,JSON.stringify(first));
  app.localStorage.setItem('taskpoints_old_custom_note','newer');
  app.localStorage.removeItem('taskpoints_deleted_note');
  app.localStorage.setItem('taskpoints_extra_note','retain current');
  const before=Array.from(app.localStorage.rows.entries());
  const backup=structuredClone(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'));
  const mirror=structuredClone(app.indexedDB.dump(DB_NAME));
  const plan=await app.runtime.inspectPreviewRollbackPlan(first.checkpointId);
  assert.equal(plan.planValid,true,JSON.stringify(plan));
  assert.equal(plan.canApply,false);
  assert.equal(plan.reason,'dry_run_only');
  assert.equal(plan.generationMatches,true);
  assert.equal(plan.counts.restoreMissing,1);
  assert.equal(plan.counts.removeNewer,1);
  assert.equal(plan.counts.replaceChanged,1);
  assert.ok(plan.blockers.includes('external_checkpoint_backup_unverified'));
  assert.ok(!Object.hasOwn(plan,'entries'));
  assert.equal(plan.mutationAuthority,'legacy_only');
  assert.equal(plan.readAuthority,'legacy_only');
  assert.deepEqual(Array.from(app.localStorage.rows.entries()),before);
  assert.deepEqual(app.indexedDB.dump('taskpoints_v2_recovery_checkpoints_preview'),backup);
  assert.deepEqual(app.indexedDB.dump(DB_NAME),mirror);
});

test('rollback plan refuses an invalid checkpoint and a different generation without performing restore',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const first=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(first.saved,true);
  assert.equal((await app.runtime.inspectPreviewRollbackPlan('missing')).planValid,false);
  const generation=app.generation.read();
  app.localStorage.setItem(GENERATION_KEY,'simulated-import-replacement');
  const noRestore=await app.runtime.inspectPreviewRollbackPlan(first.checkpointId);
  assert.equal(noRestore.planValid,true,JSON.stringify(noRestore));
  assert.equal(noRestore.generationMatches,false);
  assert.equal(noRestore.canApply,false);
  assert.equal(noRestore.reason,'checkpoint_generation_differs');
  assert.equal(app.localStorage.getItem(GENERATION_KEY),'simulated-import-replacement');
  app.localStorage.setItem(GENERATION_KEY,generation);
  assert.equal((await app.runtime.inspectPreviewRollbackPlan(first.checkpointId)).reason,'dry_run_only');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('rollback dry run refuses storage read denial without exposing snapshot records',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const first=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(first.saved,true);
  const originalGet=app.localStorage.getItem.bind(app.localStorage);
  app.localStorage.getItem=key=>{
    if(String(key)==='taskpoints_v1')throw Error('synthetic locked V1');
    return originalGet(key);
  };
  const blocked=await app.runtime.inspectPreviewRollbackPlan(first.checkpointId);
  app.localStorage.getItem=originalGet;
  assert.equal(blocked.planValid,false);
  assert.equal(blocked.canApply,false);
  assert.equal(Object.hasOwn(blocked,'entries'),false);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('new checkpoint SHA-256 protects generation and capture provenance, not just payload',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const saved=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(saved.saved,true,JSON.stringify(saved));
  const db=await new Promise((resolve,reject)=>{
    const req=app.indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  const original=structuredClone(app.indexedDB.dump(db.name).snapshots[0]);
  assert.equal(original.integrityVersion,2);
  const verified=await app.runtime.inspectPreviewRecoveryCheckpoint(saved.checkpointId);
  assert.equal(verified.intact,true,JSON.stringify(verified));
  assert.equal(verified.integrityCoverage,'metadata_and_payload');
  const modified=structuredClone(original);
  modified.generation='fake-import-authority';
  const tx=db.transaction('snapshots','readwrite');
  tx.objectStore('snapshots').put(modified);
  await new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
  const denied=await app.runtime.inspectPreviewRecoveryCheckpoint(saved.checkpointId);
  assert.equal(denied.intact,false);
  assert.equal(denied.reason,'checkpoint_integrity_failed');
  assert.equal(denied.canAutoRestore,false);
  assert.equal((await app.runtime.inspectPreviewRollbackPlan(saved.checkpointId)).planValid,false);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('older payload-only checkpoint records remain inspectable without upgrading or erasing them',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const saved=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(saved.saved,true);
  const db=await new Promise((resolve,reject)=>{
    const req=app.indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  const original=structuredClone(app.indexedDB.dump(db.name).snapshots[0]);
  const older=structuredClone(original);
  delete older.integrityVersion;
  const bytes=Buffer.from(JSON.stringify(older.entries),'utf8');
  older.fingerprint='sha256:'+createHash('sha256').update(bytes).digest('hex')+':'+bytes.byteLength;
  const tx=db.transaction('snapshots','readwrite');
  tx.objectStore('snapshots').put(older);
  await new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
  const before=structuredClone(app.indexedDB.dump(db.name));
  const verdict=await app.runtime.inspectPreviewRecoveryCheckpoint(saved.checkpointId);
  assert.equal(verdict.intact,true,JSON.stringify(verdict));
  assert.equal(verdict.integrityCoverage,'legacy_payload_only');
  assert.deepEqual(app.indexedDB.dump(db.name),before);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('payload-only historical checkpoint stays inspectable but is barred from rollback planning',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const saved=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(saved.saved,true,JSON.stringify(saved));
  const db=await new Promise((resolve,reject)=>{
    const req=app.indexedDB.open('taskpoints_v2_recovery_checkpoints_preview',1);
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  const original=structuredClone(app.indexedDB.dump(db.name).snapshots[0]);
  const historical=structuredClone(original);
  delete historical.integrityVersion;
  historical.generation='unverified-claimed-generation';
  historical.capturedAtISO='1990-01-01T00:00:00.000Z';
  const bytes=Buffer.from(JSON.stringify(historical.entries),'utf8');
  historical.fingerprint='sha256:'+createHash('sha256').update(bytes).digest('hex')+':'+bytes.byteLength;
  const tx=db.transaction('snapshots','readwrite');
  tx.objectStore('snapshots').put(historical);
  await new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);
  });
  const before=structuredClone(app.indexedDB.dump(db.name));
  const readable=await app.runtime.inspectPreviewRecoveryCheckpoint(saved.checkpointId);
  assert.equal(readable.intact,true,JSON.stringify(readable));
  assert.equal(readable.integrityCoverage,'legacy_payload_only');
  const plan=await app.runtime.inspectPreviewRollbackPlan(saved.checkpointId);
  assert.equal(plan.planValid,false);
  assert.equal(plan.canApply,false);
  assert.equal(plan.reason,'checkpoint_provenance_unverified');
  assert.equal(Object.hasOwn(plan,'entries'),false);
  assert.deepEqual(app.indexedDB.dump(db.name),before,
    'rejecting weak historical provenance must not rewrite its original evidence');
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});

test('metadata-authenticated checkpoint remains eligible for read-only rollback diff',async()=>{
  const app=install();
  await app.runtime.startCoordinatedDarkMirror();
  const checkpoint=await app.runtime.createPreviewRecoveryCheckpoint();
  assert.equal(checkpoint.saved,true);
  const intact=await app.runtime.inspectPreviewRecoveryCheckpoint(checkpoint.checkpointId);
  assert.equal(intact.integrityCoverage,'metadata_and_payload');
  const plan=await app.runtime.inspectPreviewRollbackPlan(checkpoint.checkpointId);
  assert.equal(plan.planValid,true,JSON.stringify(plan));
  assert.equal(plan.reason,'dry_run_only');
  assert.equal(plan.canApply,false);
  assert.equal(plan.generationMatches,true);
  assert.equal(app.runtime.getStatus().readAuthority,'legacy_only');
});
