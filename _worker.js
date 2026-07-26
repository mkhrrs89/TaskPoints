export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const freshHeaders = (headers) => {
      const next = new Headers(headers);
      next.delete('if-none-match');
      next.delete('if-modified-since');
      next.delete('range');
      return next;
    };

    if (url.pathname === '/settings.html') {
      const settingsRequest = new Request(request.url, {
        method: 'GET',
        headers: freshHeaders(request.headers)
      });
      const settingsResponse = await env.ASSETS.fetch(settingsRequest);
      if (!settingsResponse.ok) return settingsResponse;

      const rewrittenHeaders = new Headers(settingsResponse.headers);
      rewrittenHeaders.delete('content-length');
      rewrittenHeaders.delete('etag');
      rewrittenHeaders.delete('last-modified');
      rewrittenHeaders.set('cache-control', 'no-cache');
      const freshSettingsResponse = new Response(settingsResponse.body, {
        status: 200,
        headers: rewrittenHeaders
      });

      return new HTMLRewriter()
        .on('section[aria-labelledby="shadowMigrationTitle"]', {
          element(element) {
            element.append(
              '<div class="flex flex-wrap gap-2"><a href="dual_write_status.html" class="btn btn-teal btn-toolbar nav-btn">View Dual-Write Status</a><a href="phase3_read_status.html" class="btn btn-teal btn-toolbar nav-btn">View Phase 3 Read Status</a><a href="phase4_storage_status.html" class="btn btn-teal btn-toolbar nav-btn">View Phase 4 Storage</a></div>',
              { html: true }
            );
          }
        })
        .transform(freshSettingsResponse);
    }

    if (url.pathname !== '/scoring_core.js') return env.ASSETS.fetch(request);

    const coreRequest = new Request(request.url, {
      method: 'GET',
      headers: freshHeaders(request.headers)
    });
    const coreResponse = await env.ASSETS.fetch(coreRequest);
    if (!coreResponse.ok) return coreResponse;

    const modulePaths = [
      '/phase2_dual_write.js',
      '/phase2_reset_hook.js',
      '/phase3_read_path.js',
      '/phase3_session_codec.js',
      '/phase3_navigation_cache.js',
      '/phase3_status_cache_guard.js',
      '/phase4_storage_coordinator.js',
      '/phase4_primary_read_path.js',
      '/phase4_cache_guard.js',
      '/phase4_diagnostics.js',
      '/phase5a_native_snapshot.js'
    ];
    const moduleResults = await Promise.allSettled(
      modulePaths.map((pathname) => env.ASSETS.fetch(new Request(new URL(pathname, request.url), {
        method: 'GET',
        headers: freshHeaders(request.headers)
      })))
    );
    const [
      dualWriteResult,
      resetHookResult,
      phase3Result,
      codecResult,
      navigationCacheResult,
      statusGuardResult,
      phase4WriteResult,
      phase4ReadResult,
      phase4CacheResult,
      phase4DiagnosticsResult,
      phase5aNativeResult
    ] = moduleResults;

    const responseFrom = (result) => result?.status === 'fulfilled' ? result.value : null;
    const dualWriteResponse = responseFrom(dualWriteResult);
    const resetHookResponse = responseFrom(resetHookResult);
    const phase3Response = responseFrom(phase3Result);
    const codecResponse = responseFrom(codecResult);
    const navigationCacheResponse = responseFrom(navigationCacheResult);
    const statusGuardResponse = responseFrom(statusGuardResult);
    const phase4WriteResponse = responseFrom(phase4WriteResult);
    const phase4ReadResponse = responseFrom(phase4ReadResult);
    const phase4CacheResponse = responseFrom(phase4CacheResult);
    const phase4DiagnosticsResponse = responseFrom(phase4DiagnosticsResult);
    const phase5aNativeResponse = responseFrom(phase5aNativeResult);

    // Phase 2 remains the required safety floor. A partial Phase 2 install is
    // never served. Later phases are optional and fail back to the last complete
    // reviewed bundle.
    if (!dualWriteResponse?.ok || !resetHookResponse?.ok) return coreResponse;

    let dualWriteSource;
    let resetHookSource;
    try {
      [dualWriteSource, resetHookSource] = await Promise.all([
        dualWriteResponse.text(),
        resetHookResponse.text()
      ]);
    } catch (_) {
      return coreResponse;
    }

    const coreSource = await coreResponse.text();
    let phase3Source = '';
    if (phase3Response?.ok) {
      try { phase3Source = await phase3Response.text(); }
      catch (_) { phase3Source = ''; }
    }

    let codecSource = '';
    let navigationCacheSource = '';
    let statusGuardSource = '';
    if (phase3Source && codecResponse?.ok && navigationCacheResponse?.ok && statusGuardResponse?.ok) {
      try {
        [codecSource, navigationCacheSource, statusGuardSource] = await Promise.all([
          codecResponse.text(),
          navigationCacheResponse.text(),
          statusGuardResponse.text()
        ]);
      } catch (_) {
        codecSource = '';
        navigationCacheSource = '';
        statusGuardSource = '';
      }
    }

    let phase4WriteSource = '';
    let phase4ReadSource = '';
    let phase4CacheSource = '';
    let phase4DiagnosticsSource = '';
    const completePhase3Navigation = Boolean(phase3Source && codecSource && navigationCacheSource && statusGuardSource);
    if (completePhase3Navigation
      && phase4WriteResponse?.ok
      && phase4ReadResponse?.ok
      && phase4CacheResponse?.ok
      && phase4DiagnosticsResponse?.ok) {
      try {
        [phase4WriteSource, phase4ReadSource, phase4CacheSource, phase4DiagnosticsSource] = await Promise.all([
          phase4WriteResponse.text(),
          phase4ReadResponse.text(),
          phase4CacheResponse.text(),
          phase4DiagnosticsResponse.text()
        ]);
      } catch (_) {
        phase4WriteSource = '';
        phase4ReadSource = '';
        phase4CacheSource = '';
        phase4DiagnosticsSource = '';
      }
    }

    let phase5aNativeSource = '';
    const completePhase4 = Boolean(phase4WriteSource && phase4ReadSource && phase4CacheSource && phase4DiagnosticsSource);
    if (completePhase4 && phase5aNativeResponse?.ok) {
      try { phase5aNativeSource = await phase5aNativeResponse.text(); }
      catch (_) { phase5aNativeSource = ''; }
    }

    const headers = new Headers(coreResponse.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.delete('last-modified');
    headers.set('cache-control', 'no-cache');
    headers.set('content-type', 'application/javascript; charset=utf-8');

    const completePhase5A = Boolean(completePhase4 && phase5aNativeSource);
    headers.set('x-taskpoints-phase', completePhase5A
      ? '5a-native-indexeddb-snapshot'
      : (completePhase4 ? '4-indexeddb-primary-capable' : (phase3Source ? '3-read-path' : '2-dual-write')));

    const sources = [coreSource, dualWriteSource, resetHookSource];
    if (phase3Source) sources.push(phase3Source);
    if (completePhase3Navigation) {
      const atomicNavigationBundle = [
        ';(function installTaskPointsPhase3AtomicNavigationBundle() {',
        "  'use strict';",
        "  const global = typeof window !== 'undefined' ? window : globalThis;",
        '  const core = global.TaskPointsCore;',
        '  const storage = global.sessionStorage;',
        '  const prototype = global.Storage?.prototype;',
        "  const names = ['getItem', 'setItem', 'removeItem',",
        "    '__taskPointsPhase3CodecOriginalGetItem',",
        "    '__taskPointsPhase3CodecOriginalSetItem',",
        "    '__taskPointsPhase3CodecOriginalRemoveItem'];",
        '  function snapshot(target) {',
        '    if (!target) return null;',
        '    const result = new Map();',
        '    for (const name of names) {',
        '      try { result.set(name, Object.getOwnPropertyDescriptor(target, name) || null);',
        '      catch (_) { result.set(name, null); }',
        '    }',
        '    return result;',
        '  }',
        '  function restore(target, saved) {',
        '    if (!target || !saved) return;',
        '    for (const [name, descriptor] of saved) {',
        '      try {',
        '        if (descriptor) Object.defineProperty(target, name, descriptor);',
        '        else delete target[name];',
        '      } catch (_) {}',
        '    }',
        '  }',
        '  const prototypeSnapshot = snapshot(prototype);',
        '  const storageSnapshot = snapshot(storage);',
        '  let codecReady = false;',
        '  try {',
        codecSource,
        '    codecReady = !!core?.__phase3SessionCodecInstalled;',
        '  } catch (_) {',
        '    codecReady = false;',
        '  } finally {',
        '    if (!codecReady) {',
        '      restore(prototype, prototypeSnapshot);',
        '      restore(storage, storageSnapshot);',
        '      try { if (core) delete core.__phase3SessionCodecInstalled; } catch (_) {}',
        '    }',
        '  }',
        '  if (!codecReady) return;',
        navigationCacheSource,
        statusGuardSource,
        '})();'
      ].join('\n');
      sources.push(atomicNavigationBundle);
    }

    if (completePhase4) {
      const atomicPhase4Bundle = [
        ';(function installTaskPointsPhase4AtomicBundle() {',
        "  'use strict';",
        "  const global = typeof window !== 'undefined' ? window : globalThis;",
        '  const core = global.TaskPointsCore;',
        '  if (!core) return;',
        '  try {',
        phase4WriteSource,
        phase4ReadSource,
        phase4CacheSource,
        phase4DiagnosticsSource,
        '  } catch (error) {',
        "    try { core.setPhase4StorageMode?.('off'); } catch (_) {}",
        "    console.warn('TaskPoints Phase 4 bundle failed to install; current Phase 3 behavior remains active.', error);",
        '  }',
        '})();'
      ].join('\n');
      sources.push(atomicPhase4Bundle);
    }

    if (completePhase5A) {
      const phase5aBundle = [
        ';(function installTaskPointsPhase5ABundle() {',
        "  'use strict';",
        "  const global = typeof window !== 'undefined' ? window : globalThis;",
        '  const core = global.TaskPointsCore;',
        '  if (!core?.__phase4StorageCoordinatorInstalled || !core?.__phase4PrimaryReadPathInstalled) return;',
        '  try {',
        phase5aNativeSource,
        '  } catch (error) {',
        "    console.warn('TaskPoints Phase 5A native snapshot failed to install; Phase 4 remains active.', error);",
        '  }',
        '})();'
      ].join('\n');
      sources.push(phase5aBundle);
    }

    return new Response(`${sources.map((source) => `;${source}`).join('\n')}\n`, {
      status: 200,
      headers
    });
  }
};
