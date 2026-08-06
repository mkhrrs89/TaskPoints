const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WORKER_PATH = path.join(ROOT, '_worker.js');
const CORE_WORKER_PATH = path.join(ROOT, '_worker_core.js');

function loadWorker({ assetVersion = 'a' } = {}) {
  let source = fs.readFileSync(WORKER_PATH, 'utf8');
  source = source
    .replace("import baseWorker from './_worker_core.js';", 'const baseWorker = globalThis.__baseWorker;')
    .replace("import { isHomePagePath, transformHomeBoot } from './mobile_boot_gate.js';", 'const { isHomePagePath, transformHomeBoot } = globalThis.__mobileBootGate;')
    .replace('export default {', 'globalThis.__worker = {');

  let baseFetchCalls = 0;
  const edgeRows = new Map();
  const waitUntilRows = [];

  const baseWorker = {
    async fetch() {
      baseFetchCalls += 1;
      return new Response('CORE', {
        status: 200,
        headers: {
          'content-type': 'application/javascript',
          'cache-control': 'no-cache',
          'x-taskpoints-phase': '5b-indexeddb-native-deferred-mirror'
        }
      });
    }
  };

  const env = {
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { etag: `"${assetVersion}:${url.pathname}"` }
          });
        }
        if (url.pathname === '/score_alias_consistency.js') return new Response('ALIAS');
        if (url.pathname === '/you_score_alias_alignment.js') return new Response('YOU_ALIAS');
        if (url.pathname === '/habit_completion_source_guard.js') return new Response('GUARD');
        if (url.pathname === '/save_pipeline_shared_work.js') return new Response('SHARED');
        if (url.pathname === '/inbox_count_badge.js') return new Response('INBOX');
        if (url.pathname === '/season_series_upset_notifications.js') return new Response('SERIES_UPSET');
        return new Response(`ASSET:${url.pathname}`);
      }
    }
  };

  const cache = {
    async match(request) {
      const stored = edgeRows.get(request.url);
      return stored ? stored.clone() : undefined;
    },
    async put(request, response) {
      edgeRows.set(request.url, response.clone());
    }
  };

  const context = {
    __baseWorker: baseWorker,
    __mobileBootGate: {
      isHomePagePath: () => false,
      transformHomeBoot: (response) => response
    },
    caches: { default: cache },
    Request,
    Response,
    Headers,
    URL,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    Math,
    JSON,
    globalThis: null,
    console
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: '_worker.js' });

  return {
    worker: context.__worker,
    env,
    ctx: { waitUntil(promise) { waitUntilRows.push(Promise.resolve(promise)); } },
    baseFetchCalls: () => baseFetchCalls,
    flush: () => Promise.all(waitUntilRows.splice(0))
  };
}

test('unversioned scoring core redirects to the current fingerprinted bundle', async () => {
  const harness = loadWorker();
  const response = await harness.worker.fetch(
    new Request('https://taskpoints.test/scoring_core.js'),
    harness.env,
    harness.ctx
  );

  assert.equal(response.status, 307);
  const target = new URL(response.headers.get('location'));
  assert.equal(target.pathname, '/scoring_core.js');
  assert.match(target.searchParams.get('v') || '', /^tp-[0-9a-f]{8}$/);
  assert.match(response.headers.get('cache-control') || '', /max-age=60/);
  assert.equal(harness.baseFetchCalls(), 0);
});

test('the versioned bundle is immutable and reused from the edge cache', async () => {
  const harness = loadWorker();
  const redirect = await harness.worker.fetch(
    new Request('https://taskpoints.test/scoring_core.js'),
    harness.env,
    harness.ctx
  );
  const versionedUrl = redirect.headers.get('location');

  const first = await harness.worker.fetch(new Request(versionedUrl), harness.env, harness.ctx);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'CORE\nALIAS\nYOU_ALIAS\nGUARD\nSHARED\nINBOX\nSERIES_UPSET\n');
  assert.match(first.headers.get('cache-control') || '', /max-age=31536000/);
  assert.match(first.headers.get('cache-control') || '', /immutable/);
  assert.equal(first.headers.get('x-taskpoints-bundle-cache'), 'miss');
  assert.equal(first.headers.get('x-taskpoints-you-score-alias-alignment'), 'included');
  assert.equal(first.headers.get('x-taskpoints-season-series-upsets'), 'included');
  assert.equal(harness.baseFetchCalls(), 1);
  await harness.flush();

  const second = await harness.worker.fetch(new Request(versionedUrl), harness.env, harness.ctx);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), 'CORE\nALIAS\nYOU_ALIAS\nGUARD\nSHARED\nINBOX\nSERIES_UPSET\n');
  assert.equal(second.headers.get('x-taskpoints-bundle-cache'), 'hit');
  assert.equal(harness.baseFetchCalls(), 1);
});

test('changing a bundled asset changes the public bundle version', async () => {
  const firstHarness = loadWorker({ assetVersion: 'a' });
  const secondHarness = loadWorker({ assetVersion: 'b' });
  const first = await firstHarness.worker.fetch(
    new Request('https://taskpoints.test/scoring_core.js'), firstHarness.env, firstHarness.ctx
  );
  const second = await secondHarness.worker.fetch(
    new Request('https://taskpoints.test/scoring_core.js'), secondHarness.env, secondHarness.ctx
  );

  const firstVersion = new URL(first.headers.get('location')).searchParams.get('v');
  const secondVersion = new URL(second.headers.get('location')).searchParams.get('v');
  assert.notEqual(firstVersion, secondVersion);
});

test('the fingerprint list covers every module assembled by the core worker', () => {
  const outer = fs.readFileSync(WORKER_PATH, 'utf8');
  const core = fs.readFileSync(CORE_WORKER_PATH, 'utf8');
  const moduleBlock = core.match(/const modulePaths = \[([\s\S]*?)\n\s*\];/);
  assert.ok(moduleBlock, 'core worker module list must remain discoverable');
  const modulePaths = [...moduleBlock[1].matchAll(/'([^']+\.js)'/g)].map((match) => match[1]);
  for (const pathname of [
    '/scoring_core.js',
    ...modulePaths,
    '/score_alias_consistency.js',
    '/you_score_alias_alignment.js',
    '/habit_completion_source_guard.js',
    '/save_pipeline_shared_work.js',
    '/inbox_count_badge.js',
    '/season_series_upset_notifications.js'
  ]) {
    const escaped = pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(outer, new RegExp(`['"]${escaped}['"]`), pathname);
  }
});
