const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8')
  .replace(/^export default/, 'module.exports =');
const CODEC_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'phase3_session_codec.js'), 'utf8');
const SESSION_KEY = 'taskpoints_phase3_verified_session_cache_v1';
const MARKERS = [
  '__taskPointsPhase3CodecOriginalGetItem',
  '__taskPointsPhase3CodecOriginalSetItem',
  '__taskPointsPhase3CodecOriginalRemoveItem'
];
const TRACKED = ['getItem', 'setItem', 'removeItem', ...MARKERS];

function loadWorker() {
  const module = { exports: {} };
  class MockHTMLRewriter {
    on() { return this; }
    transform(response) { return response; }
  }
  vm.runInNewContext(WORKER_SOURCE, {
    module,
    exports: module.exports,
    URL,
    Request,
    Response,
    Headers,
    Promise,
    HTMLRewriter: MockHTMLRewriter
  }, { filename: '_worker.js' });
  return module.exports;
}

function createEnv() {
  const bodies = {
    '/scoring_core.js': 'globalThis.TaskPointsCore = {};',
    '/phase2_dual_write.js': '',
    '/phase2_reset_hook.js': '',
    '/phase3_read_path.js': '',
    '/phase3_session_codec.js': CODEC_SOURCE,
    '/phase3_navigation_cache.js': 'globalThis.__phase3NavigationLoaded = true;',
    '/phase3_status_cache_guard.js': 'globalThis.__phase3StatusGuardLoaded = true;'
  };
  return {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        return new Response(bodies[pathname] ?? '', { status: 200 });
      }
    }
  };
}

function snapshotDescriptors(target) {
  const result = new Map();
  for (const name of TRACKED) {
    result.set(name, Object.getOwnPropertyDescriptor(target, name) || null);
  }
  return result;
}

function assertDescriptorsRestored(target, before) {
  for (const [name, descriptor] of before) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, name) || null, descriptor, name);
  }
}

async function assembledCoreSource() {
  const response = await loadWorker().fetch(
    new Request('https://example.test/scoring_core.js'),
    createEnv()
  );
  assert.equal(response.status, 200);
  return response.text();
}

function baseContext(sessionStorage, Storage) {
  const context = {
    sessionStorage,
    JSON,
    Object,
    Array,
    String,
    Number,
    Math,
    Date,
    Promise,
    Error,
    Set,
    Map,
    console
  };
  if (Storage) context.Storage = Storage;
  context.window = context;
  context.globalThis = context;
  return context;
}

test('Worker atomically restores Storage.prototype after a partial codec hook failure', async () => {
  const rows = new Map([[SESSION_KEY, 'raw-session-record']]);
  class MockStorage {}
  const prototype = MockStorage.prototype;
  const originalGetItem = function getItem(key) {
    return rows.has(String(key)) ? rows.get(String(key)) : null;
  };
  const originalSetItem = function setItem(key, value) {
    rows.set(String(key), String(value));
  };
  const originalRemoveItem = function removeItem(key) {
    rows.delete(String(key));
  };
  Object.defineProperty(prototype, 'getItem', {
    value: originalGetItem,
    writable: true,
    configurable: true
  });
  Object.defineProperty(prototype, 'setItem', {
    get() { return originalSetItem; },
    set() { throw new Error('setItem replacement blocked'); },
    configurable: true
  });
  Object.defineProperty(prototype, 'removeItem', {
    value: originalRemoveItem,
    writable: true,
    configurable: true
  });

  const storage = new MockStorage();
  const before = snapshotDescriptors(prototype);
  const context = baseContext(storage, MockStorage);
  vm.runInNewContext(await assembledCoreSource(), context, { filename: 'assembled-scoring-core.js' });

  assertDescriptorsRestored(prototype, before);
  assert.equal(context.TaskPointsCore.__phase3SessionCodecInstalled, undefined);
  assert.equal(context.__phase3NavigationLoaded, undefined);
  assert.equal(context.__phase3StatusGuardLoaded, undefined);
  assert.equal(storage.getItem(SESSION_KEY), 'raw-session-record');
  for (const marker of MARKERS) assert.equal(Object.prototype.hasOwnProperty.call(prototype, marker), false);
});

test('Worker atomically restores the direct sessionStorage instance fallback after a partial failure', async () => {
  const rows = new Map([[SESSION_KEY, 'raw-session-record']]);
  const storage = {};
  const originalGetItem = function getItem(key) {
    return rows.has(String(key)) ? rows.get(String(key)) : null;
  };
  const originalSetItem = function setItem(key, value) {
    rows.set(String(key), String(value));
  };
  const originalRemoveItem = function removeItem(key) {
    rows.delete(String(key));
  };
  Object.defineProperty(storage, 'getItem', {
    value: originalGetItem,
    writable: true,
    configurable: true
  });
  Object.defineProperty(storage, 'setItem', {
    get() { return originalSetItem; },
    set() { throw new Error('setItem replacement blocked'); },
    configurable: true
  });
  Object.defineProperty(storage, 'removeItem', {
    value: originalRemoveItem,
    writable: true,
    configurable: true
  });

  const before = snapshotDescriptors(storage);
  const context = baseContext(storage, null);
  vm.runInNewContext(await assembledCoreSource(), context, { filename: 'assembled-scoring-core.js' });

  assertDescriptorsRestored(storage, before);
  assert.equal(context.TaskPointsCore.__phase3SessionCodecInstalled, undefined);
  assert.equal(context.__phase3NavigationLoaded, undefined);
  assert.equal(context.__phase3StatusGuardLoaded, undefined);
  assert.equal(storage.getItem(SESSION_KEY), 'raw-session-record');
  for (const marker of MARKERS) assert.equal(Object.prototype.hasOwnProperty.call(storage, marker), false);
});
