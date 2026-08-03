const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'home_export_responsiveness.js'), 'utf8');

function install(overrides = {}) {
  const listeners = [];
  const context = {
    console,
    Promise,
    Blob,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    Date,
    JSON,
    Math,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    Error,
    URL: {
      createObjectURL() { return 'blob:test'; },
      revokeObjectURL() {}
    },
    document: {
      addEventListener(type, handler, capture) { listeners.push({ type, handler, capture }); },
      querySelectorAll() { return []; },
      getElementById() { return null; },
      createElement() { return { style: {}, setAttribute() {}, click() {}, remove() {} }; },
      body: { appendChild() {} },
      documentElement: { appendChild() {} }
    },
    localStorage: { getItem() { return null; } },
    setTimeout(callback) { callback(); return 1; },
    requestAnimationFrame(callback) { callback(); return 1; },
    module: { exports: {} },
    ...overrides
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'home_export_responsiveness.js' });
  return { api: context.TaskPointsResponsiveExport, context, listeners };
}

test('single-flight runner ignores repeated taps until the first export finishes', async () => {
  const { api } = install();
  const run = api.createSingleFlightRunner();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });

  const first = run(async () => {
    calls += 1;
    await pending;
    return 'done';
  });
  const second = run(async () => {
    calls += 1;
    return 'duplicate';
  });

  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'done');

  const third = run(async () => {
    calls += 1;
    return 'next';
  });
  assert.equal(await third, 'next');
  assert.equal(calls, 2);
});

test('bounded concurrency never exceeds the requested worker limit', async () => {
  const { api } = install();
  let active = 0;
  let maxActive = 0;
  const gates = [];

  const work = api.mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => gates.push(resolve));
    active -= 1;
    return value * 2;
  });

  await Promise.resolve();
  assert.equal(maxActive, 3);
  while (gates.length) {
    gates.shift()();
    await Promise.resolve();
  }
  assert.deepEqual(Array.from(await work), [2, 4, 6, 8, 10, 12]);
  assert.equal(maxActive, 3);
});

test('download URL is not revoked immediately on iOS-style delayed consumption', () => {
  const timers = [];
  let clicked = 0;
  let removed = 0;
  let revoked = 0;
  let appended = 0;
  const anchor = {
    style: {},
    click() { clicked += 1; },
    remove() { removed += 1; }
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'a');
      return anchor;
    },
    body: { appendChild(node) { assert.strictEqual(node, anchor); appended += 1; } }
  };
  const urlApi = {
    createObjectURL() { return 'blob:delayed'; },
    revokeObjectURL(value) { assert.equal(value, 'blob:delayed'); revoked += 1; }
  };
  const setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  const { api } = install();

  api.triggerDownload(new Blob(['backup']), 'backup.zip', { document, URL: urlApi, setTimeout });

  assert.equal(appended, 1);
  assert.equal(clicked, 1);
  assert.equal(removed, 0);
  assert.equal(revoked, 0);

  timers.find((timer) => timer.delay === api.constants.ANCHOR_REMOVE_DELAY_MS).callback();
  assert.equal(removed, 1);
  assert.equal(revoked, 0);

  timers.find((timer) => timer.delay === api.constants.URL_REVOKE_DELAY_MS).callback();
  assert.equal(revoked, 1);
});

test('home export reuses the in-memory full-backup snapshot instead of reloading storage', () => {
  let loadCalls = 0;
  let flushCalls = 0;
  const payload = {
    exportType: 'taskpoints_full_backup',
    version: 2,
    exportedAtISO: '2026-08-03T19:34:00.000Z',
    state: { tasks: [{ id: 'fresh' }], players: [] },
    aux: {}
  };
  const { api } = install({
    TaskPointsCore: {
      flushPendingSaves() { flushCalls += 1; },
      loadAppState() { loadCalls += 1; return { state: { tasks: [{ id: 'stale' }] } }; }
    },
    getTaskPointsExportSnapshot() { return payload; }
  });

  const result = api.buildExportPayload();
  assert.strictEqual(result, payload);
  assert.equal(flushCalls, 1);
  assert.equal(loadCalls, 0);
});

test('zip builder emits a valid local header and end-of-central-directory marker', async () => {
  const { api } = install();
  const zip = await api.buildZipBlob([
    { path: 'manifest.json', blob: new Blob(['{}'], { type: 'application/json' }) }
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());

  const read32 = (offset) => (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;

  assert.equal(read32(0), 0x04034b50);
  assert.equal(read32(bytes.length - 22), 0x06054b50);
});
