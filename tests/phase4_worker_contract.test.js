const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWorker() {
  const appended = [];
  const source = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8')
    .replace(/^export default/, 'module.exports =');
  const module = { exports: {} };
  class MockHTMLRewriter {
    constructor() {
      this.handlers = [];
    }
    on(selector, handler) {
      this.handlers.push({ selector, handler });
      return this;
    }
    transform(response) {
      this.handlers.forEach(({ handler }) => {
        handler?.element?.({ append(html) { appended.push(html); } });
      });
      return response;
    }
  }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    URL,
    Request,
    Response,
    Headers,
    Promise,
    HTMLRewriter: MockHTMLRewriter
  }, { filename: '_worker.js' });
  return { worker: module.exports, appended };
}

function unreadableResponse() {
  return { ok: true, async text() { throw new Error('unreadable'); } };
}

function createEnv(options = {}) {
  const calls = [];
  const bodies = {
    '/scoring_core.js': 'CORE',
    '/settings.html': '<section aria-labelledby="shadowMigrationTitle"></section><details id="storageHealthSection"></details>',
    '/phase2_dual_write.js': 'P2D',
    '/phase2_reset_hook.js': 'P2R',
    '/phase3_read_path.js': 'P3',
    '/phase3_session_codec.js': 'CODEC',
    '/phase3_navigation_cache.js': 'NAV',
    '/phase3_status_cache_guard.js': 'GUARD',
    '/phase4_storage_coordinator.js': 'P4WRITE',
    '/phase4_primary_read_path.js': 'P4READ',
    '/phase4_cache_guard.js': 'P4CACHE',
    '/phase4_diagnostics.js': 'P4DIAG'
  };
  return {
    calls,
    env: {
      ASSETS: {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          calls.push({ pathname, headers: new Headers(request.headers) });
          const failPath = options.failPath;
          const rejectPath = options.rejectPath;
          const unreadablePath = options.unreadablePath;
          if (pathname === rejectPath) throw new Error('rejected');
          if (pathname === failPath) return new Response('missing', { status: 404 });
          if (pathname === unreadablePath) return unreadableResponse();
          if (options.failPhase3 && pathname === '/phase3_read_path.js') return new Response('missing', { status: 404 });
          if (options.failPhase2 && pathname === '/phase2_dual_write.js') return new Response('missing', { status: 404 });
          return new Response(bodies[pathname] || 'OTHER', {
            status: 200,
            headers: { etag: 'old', 'last-modified': 'yesterday' }
          });
        }
      }
    }
  };
}

test('the complete Phase 4 bundle is appended after the reviewed Phase 3 bundle', async () => {
  const { worker } = loadWorker();
  const setup = createEnv();
  const response = await worker.fetch(new Request('https://example.test/scoring_core.js'), setup.env);
  const body = await response.text();

  assert.ok(body.indexOf('P2D') < body.indexOf('P2R'));
  assert.ok(body.indexOf('P2R') < body.indexOf('P3'));
  assert.ok(body.indexOf('P3') < body.indexOf('CODEC'));
  assert.ok(body.indexOf('CODEC') < body.indexOf('NAV'));
  assert.ok(body.indexOf('NAV') < body.indexOf('GUARD'));
  assert.ok(body.indexOf('GUARD') < body.indexOf('P4WRITE'));
  assert.ok(body.indexOf('P4WRITE') < body.indexOf('P4READ'));
  assert.ok(body.indexOf('P4READ') < body.indexOf('P4CACHE'));
  assert.ok(body.indexOf('P4CACHE') < body.indexOf('P4DIAG'));
  assert.equal(response.headers.get('x-taskpoints-phase'), '4-indexeddb-primary-capable');
});

for (const pathname of [
  '/phase4_storage_coordinator.js',
  '/phase4_primary_read_path.js',
  '/phase4_cache_guard.js',
  '/phase4_diagnostics.js'
]) {
  for (const [kind, key] of [['missing', 'failPath'], ['rejected', 'rejectPath'], ['unreadable', 'unreadablePath']]) {
    test(`${kind} ${pathname} omits the entire Phase 4 bundle and preserves complete Phase 3`, async () => {
      const { worker } = loadWorker();
      const setup = createEnv({ [key]: pathname });
      const response = await worker.fetch(new Request('https://example.test/scoring_core.js'), setup.env);
      const body = await response.text();
      assert.match(body, /P3/);
      assert.match(body, /CODEC/);
      assert.match(body, /NAV/);
      assert.match(body, /GUARD/);
      assert.doesNotMatch(body, /P4WRITE|P4READ|P4CACHE|P4DIAG/);
      assert.equal(response.headers.get('x-taskpoints-phase'), '3-read-path');
    });
  }
}

test('Phase 4 is never appended when the Phase 3 read path is unavailable', async () => {
  const { worker } = loadWorker();
  const setup = createEnv({ failPhase3: true });
  const response = await worker.fetch(new Request('https://example.test/scoring_core.js'), setup.env);
  const body = await response.text();
  assert.doesNotMatch(body, /P3|P4WRITE|P4READ|P4CACHE|P4DIAG/);
  assert.match(body, /P2D/);
  assert.match(body, /P2R/);
  assert.equal(response.headers.get('x-taskpoints-phase'), '2-dual-write');
});

test('a required Phase 2 failure still returns the untouched core with no later phases', async () => {
  const { worker } = loadWorker();
  const setup = createEnv({ failPhase2: true });
  const response = await worker.fetch(new Request('https://example.test/scoring_core.js'), setup.env);
  const body = await response.text();
  assert.equal(body, 'CORE');
  assert.doesNotMatch(body, /P2R|P3|P4WRITE|P4READ|P4CACHE|P4DIAG/);
});

test('Phase 4 module requests strip browser validators and range headers', async () => {
  const { worker } = loadWorker();
  const setup = createEnv();
  await worker.fetch(new Request('https://example.test/scoring_core.js', {
    headers: {
      'if-none-match': 'cached',
      'if-modified-since': 'yesterday',
      range: 'bytes=0-20'
    }
  }), setup.env);

  for (const pathname of [
    '/phase4_storage_coordinator.js',
    '/phase4_primary_read_path.js',
    '/phase4_cache_guard.js',
    '/phase4_diagnostics.js'
  ]) {
    const call = setup.calls.find((entry) => entry.pathname === pathname);
    assert.ok(call, pathname);
    assert.equal(call.headers.has('if-none-match'), false, pathname);
    assert.equal(call.headers.has('if-modified-since'), false, pathname);
    assert.equal(call.headers.has('range'), false, pathname);
  }
});

test('Settings gains a Phase 4 status/control entry without replacing existing migration links', async () => {
  const { worker, appended } = loadWorker();
  const setup = createEnv();
  await worker.fetch(new Request('https://example.test/settings.html'), setup.env);
  const html = appended.join('\n');
  assert.match(html, /dual_write_status\.html/);
  assert.match(html, /phase3_read_status\.html/);
  assert.match(html, /phase4_storage_status\.html/);
  assert.match(html, /Phase 4/i);
});

test('Settings exposes the Faster Storage Setup inside Storage Health', async () => {
  const { worker, appended } = loadWorker();
  const setup = createEnv();
  await worker.fetch(new Request('https://example.test/settings.html'), setup.env);
  const html = appended.join('\n');
  assert.match(html, /indexeddb_requalification\.html/);
  assert.match(html, /Faster Storage Setup/);
});

test('unrelated routes bypass all migration module fetching', async () => {
  const { worker } = loadWorker();
  const setup = createEnv();
  const response = await worker.fetch(new Request('https://example.test/standings.html'), setup.env);
  assert.equal(await response.text(), 'OTHER');
  assert.deepEqual(setup.calls.map((entry) => entry.pathname), ['/standings.html']);
});
