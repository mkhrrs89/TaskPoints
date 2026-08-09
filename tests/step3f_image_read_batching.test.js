const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'storage_maintenance_idle.js'), 'utf8');

function makeHarness(options = {}) {
  const records = new Map(options.records || Array.from({ length: 120 }, (_, index) => [
    `img-${index}`,
    { id: `blob-${index}` }
  ]));
  let transactionCount = 0;
  let originalReadCount = 0;

  const originalGetImageBlob = async (imageId) => {
    originalReadCount += 1;
    return records.get(imageId) || null;
  };

  const objectStoreNames = { contains: (name) => name === 'images' };
  const db = {
    objectStoreNames,
    createObjectStore() {},
    transaction(storeName, mode) {
      if (options.failTransaction) throw new Error('forced transaction failure');
      assert.equal(storeName, 'images');
      assert.equal(mode, 'readonly');
      transactionCount += 1;
      return {
        objectStore(name) {
          assert.equal(name, 'images');
          return {
            get(key) {
              if (options.failGetFor === key) throw new Error('forced get failure');
              const request = { result: undefined, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                request.result = records.get(key);
                request.onsuccess?.();
              });
              return request;
            }
          };
        }
      };
    }
  };

  const indexedDB = {
    open(name, version) {
      assert.equal(name, 'taskpoints');
      assert.equal(version, 1);
      const request = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null
      };
      queueMicrotask(() => {
        if (options.failOpen) {
          request.error = new Error('forced open failure');
          request.onerror?.();
          return;
        }
        request.onsuccess?.();
      });
      return request;
    }
  };

  const core = {
    getImageBlob: originalGetImageBlob,
    saveStateSnapshot() {},
    normalizeState(value) { return value; },
    parseTaskPointsStorageJson(raw) { return JSON.parse(raw); },
    STORAGE_KEY: 'taskpoints_v1',
    readPendingHabitDeltas() { return []; }
  };

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    activeElement: null,
    addEventListener() {}
  };

  const sandbox = {
    TaskPointsCore: core,
    indexedDB,
    document,
    localStorage: { getItem() { return null; } },
    performance: { now: () => 10000 },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    Map,
    JSON,
    Math,
    Date,
    Error,
    console,
    addEventListener() {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(moduleSource, sandbox, { filename: 'storage_maintenance_idle.js' });

  return {
    core,
    get transactionCount() { return transactionCount; },
    get originalReadCount() { return originalReadCount; }
  };
}

test('same-turn image requests share one IndexedDB readonly transaction', async () => {
  const harness = makeHarness();
  const reads = Array.from({ length: 100 }, (_, index) => harness.core.getImageBlob(`img-${index}`));
  const results = await Promise.all(reads);

  assert.equal(harness.transactionCount, 1);
  assert.equal(harness.originalReadCount, 0);
  assert.equal(results.length, 100);
  assert.equal(results[0].id, 'blob-0');
  assert.equal(results[99].id, 'blob-99');

  const status = harness.core.getImageReadBatchingStatus();
  assert.equal(status.installed, true);
  assert.equal(status.transactions, 1);
  assert.equal(status.batches, 1);
  assert.equal(status.requestedReads, 100);
  assert.equal(status.distinctReads, 100);
  assert.equal(status.maxBatchSize, 100);
});

test('duplicate IDs coalesce inside a batch without changing results', async () => {
  const harness = makeHarness();
  const [a, b, c, missing] = await Promise.all([
    harness.core.getImageBlob('img-5'),
    harness.core.getImageBlob('img-5'),
    harness.core.getImageBlob('img-5'),
    harness.core.getImageBlob('missing')
  ]);

  assert.equal(harness.transactionCount, 1);
  assert.equal(a.id, 'blob-5');
  assert.equal(b.id, 'blob-5');
  assert.equal(c.id, 'blob-5');
  assert.equal(missing, null);

  const status = harness.core.getImageReadBatchingStatus();
  assert.equal(status.requestedReads, 4);
  assert.equal(status.distinctReads, 2);
  assert.equal(status.coalescedReads, 2);
});

test('a later read wave uses a fresh transaction and empty IDs stay transaction-free', async () => {
  const harness = makeHarness();
  assert.equal(await harness.core.getImageBlob(''), null);
  assert.equal(harness.transactionCount, 0);

  const first = await harness.core.getImageBlob('img-1');
  assert.equal(first.id, 'blob-1');
  assert.equal(harness.transactionCount, 1);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await harness.core.getImageBlob('img-2');
  assert.equal(second.id, 'blob-2');
  assert.equal(harness.transactionCount, 2);
});

test('transaction failure falls back to original getImageBlob for every requested image', async () => {
  const harness = makeHarness({ failTransaction: true });
  const results = await Promise.all([
    harness.core.getImageBlob('img-3'),
    harness.core.getImageBlob('img-4')
  ]);

  assert.equal(harness.transactionCount, 0);
  assert.equal(harness.originalReadCount, 2);
  assert.equal(results[0].id, 'blob-3');
  assert.equal(results[1].id, 'blob-4');
});

test('individual get failure falls back only that image while the batch still serves others', async () => {
  const harness = makeHarness({ failGetFor: 'img-7' });
  const results = await Promise.all([
    harness.core.getImageBlob('img-6'),
    harness.core.getImageBlob('img-7'),
    harness.core.getImageBlob('img-8')
  ]);

  assert.equal(harness.transactionCount, 1);
  assert.equal(harness.originalReadCount, 1);
  assert.equal(results[0].id, 'blob-6');
  assert.equal(results[1].id, 'blob-7');
  assert.equal(results[2].id, 'blob-8');
});
