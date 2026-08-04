const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'home_indexeddb_bootstrap.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const phase5c = fs.readFileSync(path.join(root, 'phase5b_deferred_mirror.js'), 'utf8');

function hashRaw(raw) {
  const text = String(raw || '');
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `${(value >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function makeRecord(raw, revision = 'revision-one') {
  return {
    id: 'home_native_latest',
    schemaVersion: 1,
    snapshotFormat: 'home_structured_clone_v1',
    status: 'passed_verification',
    state: { tasks: [{ id: 'task-1' }], completions: [] },
    rawHash: hashRaw(raw),
    rawLength: raw.length,
    rawHead: raw.slice(0, 64),
    rawTail: raw.slice(-64),
    revision,
    verifiedAtISO: '2026-08-04T20:00:00.000Z',
    stateHash: 'state-hash'
  };
}

async function runBootstrap({ raw = 'compressed-authoritative-state', revision = 'revision-one', journal = '[]', record = null } = {}) {
  const values = new Map([
    ['taskpoints_v1', raw],
    ['taskpoints_state_revision_v1', revision],
    ['taskpoints_pending_habit_deltas_v1', journal]
  ]);
  const localStorage = {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); }
  };
  const storedRecord = record === null ? makeRecord(raw, revision) : record;
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains(name) { return name === 'snapshots'; } },
          transaction() {
            const transaction = {
              objectStore() {
                return {
                  get() {
                    const read = {};
                    queueMicrotask(() => {
                      read.result = storedRecord;
                      read.onsuccess?.();
                      queueMicrotask(() => transaction.oncomplete?.());
                    });
                    return read;
                  }
                };
              }
            };
            return transaction;
          },
          close() {}
        };
        request.onsuccess?.();
      });
      return request;
    }
  };
  const context = {
    window: null,
    globalThis: null,
    localStorage,
    indexedDB,
    location: { search: '' },
    performance: { now: (() => { let value = 0; return () => ++value; })() },
    URLSearchParams,
    Promise,
    JSON,
    String,
    Number,
    Object,
    Array,
    Math,
    Date,
    console,
    queueMicrotask
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(bootstrap, context);
  await context.TaskPointsHomeNativeBoot.promise;
  return { context, values };
}

test('Home starts the native IndexedDB read before the main app script', () => {
  const bootstrapAt = home.indexOf('<script src="home_indexeddb_bootstrap.js"></script>');
  const coreAt = home.indexOf('<script src="scoring_core.js"></script>');
  assert.ok(bootstrapAt >= 0);
  assert.ok(coreAt > bootstrapAt);
  assert.match(home, /const nativeCandidate = nativeBoot\?\.takeReadyState\?\.\(\) \|\| null;/);
  assert.match(home, /TaskPointsCore\.prepareHomeNativeState\(nativeCandidate/);
  assert.match(home, /window\.__TP_HOME_BOOT_SOURCE = 'indexeddb-native';/);
  assert.match(home, /const s = normalizeState\(load\(\)\);/);
});

test('a matching verified native snapshot is consumed without parsing the compressed mirror', async () => {
  const { context } = await runBootstrap();
  const api = context.TaskPointsHomeNativeBoot;
  assert.equal(api.status, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(api.takeReadyState())), {
    tasks: [{ id: 'task-1' }],
    completions: []
  });
  assert.equal(api.status, 'consumed');
});

test('a source change after the IndexedDB read forces the existing fallback path', async () => {
  const { context, values } = await runBootstrap();
  assert.equal(context.TaskPointsHomeNativeBoot.status, 'ready');
  values.set('taskpoints_v1', 'new-authoritative-state');
  assert.equal(context.TaskPointsHomeNativeBoot.takeReadyState(), null);
  assert.equal(context.TaskPointsHomeNativeBoot.status, 'fallback');
  assert.equal(context.TaskPointsHomeNativeBoot.reason, 'authoritative_changed_after_native_read');
});

test('pending habit journal prevents native state use', async () => {
  const { context } = await runBootstrap({ journal: '[{"id":"pending"}]' });
  assert.equal(context.TaskPointsHomeNativeBoot.status, 'fallback');
  assert.equal(context.TaskPointsHomeNativeBoot.reason, 'pending_habit_journal');
});

test('verified secondary atomically promotes a structured Home snapshot', () => {
  assert.match(phase5c, /const HOME_NATIVE_ID = 'home_native_latest';/);
  assert.match(phase5c, /snapshotFormat: HOME_NATIVE_FORMAT/);
  assert.match(phase5c, /store\.put\(\{[\s\S]*id: HOME_NATIVE_ID/);
  assert.match(phase5c, /request\(latestStore\.get\(HOME_NATIVE_ID\)\)/);
  assert.match(phase5c, /stateHash\(nativeLatest\.state\) !== sourceStateHash/);
  assert.match(phase5c, /core\.prepareHomeNativeState = prepareHomeNativeState;/);
  assert.match(phase5c, /core\.readPendingHabitDeltas\?\.\(\) \|\| \[\]/);
  assert.match(phase5c, /global\.requestIdleCallback\(backfill, \{ timeout: 5000 \}\)/);
});
