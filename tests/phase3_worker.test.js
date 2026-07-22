const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWorker() {
  const source = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8')
    .replace(/^export default/, 'module.exports =');
  const module = { exports: {} };
  class MockHTMLRewriter {
    on(selector, handler) { this.selector = selector; this.handler = handler; return this; }
    async transform(response) {
      const original = await response.text();
      let appended = '';
      this.handler.element({ append(html) { appended += html; } });
      return new Response(original.replace('</section>', `${appended}</section>`), {
        status: response.status,
        headers: response.headers
      });
    }
  }
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, Request, Response, Headers, Promise, HTMLRewriter: MockHTMLRewriter
  }, { filename: '_worker.js' });
  return module.exports;
}

function createEnv(options = {}) {
  const calls = [];
  const bodies = {
    '/scoring_core.js': 'CORE_SOURCE',
    '/phase2_dual_write.js': 'PHASE2_DUAL',
    '/phase2_reset_hook.js': 'PHASE2_RESET',
    '/phase3_read_path.js': 'PHASE3_READ',
    '/settings.html': '<html><section aria-labelledby="shadowMigrationTitle">SETTINGS</section></html>',
    '/other.js': 'OTHER'
  };
  return {
    calls,
    env: {
      ASSETS: {
        async fetch(request) {
          const url = new URL(request.url);
          calls.push({ path: url.pathname, headers: new Headers(request.headers) });
          if (options.failPhase3 && url.pathname === '/phase3_read_path.js') return new Response('missing', { status: 404 });
          if (options.failPhase2 && url.pathname === '/phase2_dual_write.js') return new Response('missing', { status: 404 });
          return new Response(bodies[url.pathname] || 'UNKNOWN', {
            status: 200,
            headers: { etag: 'cached-etag', 'last-modified': 'yesterday', 'content-length': '10' }
          });
        }
      }
    }
  };
}

test('scoring core appends Phase 3 after both Phase 2 modules and strips validators', async () => {
  const worker = loadWorker();
  const { env, calls } = createEnv();
  const request = new Request('https://example.test/scoring_core.js', {
    headers: { 'if-none-match': 'old', 'if-modified-since': 'old', range: 'bytes=0-5' }
  });
  const response = await worker.fetch(request, env);
  const body = await response.text();
  assert.ok(body.indexOf('CORE_SOURCE') < body.indexOf('PHASE2_DUAL'));
  assert.ok(body.indexOf('PHASE2_DUAL') < body.indexOf('PHASE2_RESET'));
  assert.ok(body.indexOf('PHASE2_RESET') < body.indexOf('PHASE3_READ'));
  assert.equal(response.headers.get('x-taskpoints-phase'), '3-read-path');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('etag'), null);
  const coreCall = calls.find((call) => call.path === '/scoring_core.js');
  assert.equal(coreCall.headers.get('if-none-match'), null);
  assert.equal(coreCall.headers.get('if-modified-since'), null);
  assert.equal(coreCall.headers.get('range'), null);
});

test('a missing Phase 3 module preserves the complete Phase 2 augmentation', async () => {
  const worker = loadWorker();
  const { env } = createEnv({ failPhase3: true });
  const response = await worker.fetch(new Request('https://example.test/scoring_core.js'), env);
  const body = await response.text();
  assert.match(body, /CORE_SOURCE/);
  assert.match(body, /PHASE2_DUAL/);
  assert.match(body, /PHASE2_RESET/);
  assert.doesNotMatch(body, /PHASE3_READ/);
  assert.equal(response.headers.get('x-taskpoints-phase'), '2-dual-write');
});

test('a missing required Phase 2 module returns the untouched core asset', async () => {
  const worker = loadWorker();
  const { env } = createEnv({ failPhase2: true });
  const response = await worker.fetch(new Request('https://example.test/scoring_core.js'), env);
  assert.equal(await response.text(), 'CORE_SOURCE');
  assert.equal(response.headers.get('x-taskpoints-phase'), null);
});

test('Settings receives both diagnostics links through a fresh rewritten 200 response', async () => {
  const worker = loadWorker();
  const { env, calls } = createEnv();
  const response = await worker.fetch(new Request('https://example.test/settings.html', {
    headers: { 'if-none-match': 'old', 'if-modified-since': 'old', range: 'bytes=0-5' }
  }), env);
  const body = await response.text();
  assert.match(body, /dual_write_status\.html/);
  assert.match(body, /phase3_read_status\.html/);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('etag'), null);
  const call = calls.find((entry) => entry.path === '/settings.html');
  assert.equal(call.headers.get('if-none-match'), null);
  assert.equal(call.headers.get('if-modified-since'), null);
  assert.equal(call.headers.get('range'), null);
});

test('Phase 3 status page exposes a guarded in-place verified read test', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'phase3_read_status.html'), 'utf8');
  assert.match(source, /id="testVerifiedReadBtn"/);
  assert.match(source, /core\.testPhase3VerifiedRead\(\)/);
  assert.doesNotMatch(source, /core\.loadAppState\(\{ persistSync: false \}\)/);
  assert.match(source, /indexedDbReadsTotal/);
});

test('Phase 3 test readiness checks live storage state and fails closed after errors', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'phase3_read_status.html'), 'utf8');
  assert.match(source, /readPendingHabitDeltas/);
  assert.match(source, /pendingHabitJournalCount\(\) === 0/);
  assert.match(source, /function clearReadiness\(\)/);
  assert.match(source, /latestStatus = null/);
  assert.match(source, /window\.addEventListener\('storage'/);
  assert.match(source, /event\.key === null/);
});

test('unrelated routes bypass the worker augmentation', async () => {
  const worker = loadWorker();
  const { env, calls } = createEnv();
  const response = await worker.fetch(new Request('https://example.test/other.js', { headers: { 'if-none-match': 'keep' } }), env);
  assert.equal(await response.text(), 'OTHER');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('if-none-match'), 'keep');
});