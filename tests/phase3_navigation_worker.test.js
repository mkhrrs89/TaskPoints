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
    on() { return this; }
    transform(response) { return response; }
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
  return module.exports;
}

function unreadableResponse() {
  return { ok: true, async text() { throw new Error('unreadable'); } };
}

function createEnv(options = {}) {
  const bodies = {
    '/scoring_core.js': 'CORE',
    '/phase2_dual_write.js': 'P2D',
    '/phase2_reset_hook.js': 'P2R',
    '/phase3_read_path.js': 'P3',
    '/phase3_session_codec.js': 'CODEC',
    '/phase3_navigation_cache.js': 'NAV',
    '/phase3_status_cache_guard.js': 'GUARD'
  };
  return {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (options.rejectCodec && pathname === '/phase3_session_codec.js') throw new Error('codec rejected');
        if (options.failCodec && pathname === '/phase3_session_codec.js') return new Response('missing', { status: 404 });
        if (options.unreadableCodec && pathname === '/phase3_session_codec.js') return unreadableResponse();
        if (options.rejectNavigation && pathname === '/phase3_navigation_cache.js') throw new Error('navigation rejected');
        if (options.failNavigation && pathname === '/phase3_navigation_cache.js') return new Response('missing', { status: 404 });
        if (options.unreadableNavigation && pathname === '/phase3_navigation_cache.js') return unreadableResponse();
        if (options.rejectGuard && pathname === '/phase3_status_cache_guard.js') throw new Error('guard rejected');
        if (options.failGuard && pathname === '/phase3_status_cache_guard.js') return new Response('missing', { status: 404 });
        if (options.unreadableGuard && pathname === '/phase3_status_cache_guard.js') return unreadableResponse();
        if (options.failPhase3 && pathname === '/phase3_read_path.js') return new Response('missing', { status: 404 });
        return new Response(bodies[pathname] || 'OTHER', { status: 200 });
      }
    }
  };
}

test('codec, navigation cache, and status guard are appended after the Phase 3 read path', async () => {
  const response = await loadWorker().fetch(
    new Request('https://example.test/scoring_core.js'),
    createEnv()
  );
  const body = await response.text();
  assert.ok(body.indexOf('P2D') < body.indexOf('P2R'));
  assert.ok(body.indexOf('P2R') < body.indexOf('P3'));
  assert.ok(body.indexOf('P3') < body.indexOf('CODEC'));
  assert.ok(body.indexOf('CODEC') < body.indexOf('NAV'));
  assert.ok(body.indexOf('NAV') < body.indexOf('GUARD'));
  assert.equal(response.headers.get('x-taskpoints-phase'), '3-read-path');
});

for (const [name, options] of [
  ['missing codec', { failCodec: true }],
  ['rejected codec', { rejectCodec: true }],
  ['unreadable codec', { unreadableCodec: true }],
  ['missing navigation', { failNavigation: true }],
  ['rejected navigation', { rejectNavigation: true }],
  ['unreadable navigation', { unreadableNavigation: true }],
  ['missing guard', { failGuard: true }],
  ['rejected guard', { rejectGuard: true }],
  ['unreadable guard', { unreadableGuard: true }]
]) {
  test(`${name} omits the whole navigation bundle and preserves reviewed Phase 3`, async () => {
    const response = await loadWorker().fetch(
      new Request('https://example.test/scoring_core.js'),
      createEnv(options)
    );
    const body = await response.text();
    assert.match(body, /P3/);
    assert.doesNotMatch(body, /CODEC/);
    assert.doesNotMatch(body, /NAV/);
    assert.doesNotMatch(body, /GUARD/);
    assert.equal(response.headers.get('x-taskpoints-phase'), '3-read-path');
  });
}

test('navigation bundle is never appended when the Phase 3 path is absent', async () => {
  const response = await loadWorker().fetch(
    new Request('https://example.test/scoring_core.js'),
    createEnv({ failPhase3: true })
  );
  const body = await response.text();
  assert.doesNotMatch(body, /P3/);
  assert.doesNotMatch(body, /CODEC/);
  assert.doesNotMatch(body, /NAV/);
  assert.doesNotMatch(body, /GUARD/);
  assert.match(body, /P2D/);
  assert.match(body, /P2R/);
  assert.equal(response.headers.get('x-taskpoints-phase'), '2-dual-write');
});
