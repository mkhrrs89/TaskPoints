const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'storage_diagnostics.html'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(root, 'storage_diagnostics.js'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(root, 'storage_diagnostics_cleanup_controller.js'),
  'utf8'
);

test('Storage Diagnostics loads the guarded cleanup assets and button', () => {
  assert.match(html, /id="cleanupUnreferencedImagesBtn"/);
  assert.match(html, /id="imageCleanupStatus"/);
  assert.match(html, /storage_image_cleanup\.js\?v=20260803-1/);
  assert.match(html, /storage_diagnostics\.js\?v=20260803-1/);
  assert.match(html, /storage_diagnostics_cleanup_controller\.js\?v=20260803-1/);
  assert.match(html, /Only the separately confirmed image-cleanup action can delete storage/);
});

test('runtime analyzes full-state references and blocks unsafe cleanup', () => {
  assert.match(runtimeSource, /buildCleanupPlan\(state, scannedRows\)/);
  assert.match(runtimeSource, /referencePaths: plan\.referencePaths/);
  assert.match(runtimeSource, /unreferencedBytes: plan\.unreferencedBytes/);
  assert.match(runtimeSource, /missingReferences\.length/);
});

test('controller requires confirmation, rejects stale previews, and verifies deletion', () => {
  assert.match(controllerSource, /global\.confirm\(/);
  assert.match(controllerSource, /including current and historical Season data/);
  assert.match(controllerSource, /validateCleanupPreview\(preview, validatedState\.state, validatedReport\.rows\)/);
  assert.match(controllerSource, /validation\.reason === 'missing-references'/);
  assert.match(controllerSource, /finalReport\.missingReferences\.length/);
  assert.match(controllerSource, /const undeleted = deleteIds\.filter/);
  assert.match(controllerSource, /Deleted and verified \$\{deleteIds\.length\}/);
  assert.match(controllerSource, /if \(status && finalMessage\) status\.textContent = finalMessage/);
});

test('validated deletes use exactly one readwrite transaction and close after completion', async () => {
  let transactionCalls = 0;
  const deleted = [];
  let closed = false;
  let transaction = null;

  const db = {
    objectStoreNames: { contains(name) { return name === 'images'; } },
    transaction(storeName, mode) {
      transactionCalls += 1;
      assert.equal(storeName, 'images');
      assert.equal(mode, 'readwrite');
      transaction = {
        error: null,
        objectStore(name) {
          assert.equal(name, 'images');
          return { delete(key) { deleted.push(key); } };
        },
        oncomplete: null,
        onerror: null,
        onabort: null
      };
      return transaction;
    },
    close() { closed = true; }
  };

  const indexedDB = {
    open(name) {
      assert.equal(name, 'taskpoints');
      const request = {
        result: db,
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  };

  const document = {
    addEventListener() {},
    getElementById() { return null; }
  };
  const context = {
    console,
    Promise,
    Set,
    String,
    Error,
    queueMicrotask,
    indexedDB,
    document,
    TaskPointsCore: {
      STORAGE_KEY: 'taskpoints_v1',
      IMAGE_DB_NAME: 'taskpoints',
      IMAGE_STORE_NAME: 'images'
    },
    localStorage: { getItem() { return ''; } },
    confirm() { return false; },
    alert() {}
  };
  context.window = context;
  context.globalThis = context;
  context.module = { exports: {} };

  vm.runInNewContext(controllerSource, context, {
    filename: 'storage_diagnostics_cleanup_controller.js'
  });
  const api = context.module.exports;
  const pending = api.deleteValidatedImageKeys(['orphan-a', 'orphan-b']);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transactionCalls, 1);
  assert.deepEqual(deleted, ['orphan-a', 'orphan-b']);
  assert.equal(closed, false, 'database must remain open until the transaction settles');
  assert.equal(typeof transaction.oncomplete, 'function');

  transaction.oncomplete();
  const result = await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { deleted: 2 });
  assert.equal(closed, true);
});
