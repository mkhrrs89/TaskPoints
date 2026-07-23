export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/settings.html') {
      // Always retrieve a fresh response body before rewriting. A cached 304
      // has no body, so forwarding browser validators could prevent the
      // in-app diagnostics links from appearing for returning Home Screen users.
      const settingsHeaders = new Headers(request.headers);
      settingsHeaders.delete('if-none-match');
      settingsHeaders.delete('if-modified-since');
      settingsHeaders.delete('range');
      const settingsRequest = new Request(request.url, {
        method: 'GET',
        headers: settingsHeaders
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
              '<div class="flex flex-wrap gap-2"><a href="dual_write_status.html" class="btn btn-teal btn-toolbar nav-btn">View Dual-Write Status</a><a href="phase3_read_status.html" class="btn btn-teal btn-toolbar nav-btn">View Phase 3 Read Status</a></div>',
              { html: true }
            );
          }
        })
        .transform(freshSettingsResponse);
    }

    if (url.pathname !== '/scoring_core.js') return env.ASSETS.fetch(request);

    // Do not forward browser cache validators to the static asset binding. A
    // 304 has no response body to augment, so always retrieve the current core
    // asset and return a fresh 200 response containing the migration modules.
    const assetHeaders = new Headers(request.headers);
    assetHeaders.delete('if-none-match');
    assetHeaders.delete('if-modified-since');
    assetHeaders.delete('range');
    const coreRequest = new Request(request.url, {
      method: 'GET',
      headers: assetHeaders
    });
    const coreResponse = await env.ASSETS.fetch(coreRequest);
    if (!coreResponse.ok) return coreResponse;

    const modulePaths = [
      '/phase2_dual_write.js',
      '/phase2_reset_hook.js',
      '/phase3_read_path.js',
      '/phase3_session_codec.js',
      '/phase3_navigation_cache.js',
      '/phase3_status_cache_guard.js'
    ];
    const moduleResults = await Promise.allSettled(
      modulePaths.map((pathname) => env.ASSETS.fetch(new Request(new URL(pathname, request.url), { method: 'GET' })))
    );
    const [dualWriteResult, resetHookResult, phase3Result, codecResult, navigationCacheResult, statusGuardResult] = moduleResults;
    const dualWriteResponse = dualWriteResult.status === 'fulfilled' ? dualWriteResult.value : null;
    const resetHookResponse = resetHookResult.status === 'fulfilled' ? resetHookResult.value : null;
    const phase3Response = phase3Result.status === 'fulfilled' ? phase3Result.value : null;
    const codecResponse = codecResult.status === 'fulfilled' ? codecResult.value : null;
    const navigationCacheResponse = navigationCacheResult.status === 'fulfilled' ? navigationCacheResult.value : null;
    const statusGuardResponse = statusGuardResult.status === 'fulfilled' ? statusGuardResult.value : null;

    // Phase 2 remains the production safety floor. If either required Phase 2
    // module is unavailable or its asset fetch rejects, return the untouched
    // core rather than a partial hook. Phase 3 modules are optional and degrade
    // independently: the navigation bundle can never take down the read path.
    if (!dualWriteResponse?.ok || !resetHookResponse?.ok) return coreResponse;

    let dualWriteSource;
    let resetHookSource;
    try {
      [dualWriteSource, resetHookSource] = await Promise.all([
        dualWriteResponse.text(),
        resetHookResponse.text()
      ]);
    } catch (_) {
      // A required Phase 2 module whose body cannot be read is equivalent to a
      // missing required module. The untouched core response is still unread.
      return coreResponse;
    }

    const coreSource = await coreResponse.text();
    let phase3Source = '';
    if (phase3Response?.ok) {
      try {
        phase3Source = await phase3Response.text();
      } catch (_) {
        // Phase 3 is optional. A body-read failure must preserve complete Phase 2.
        phase3Source = '';
      }
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
        // The codec, navigation cache, and status guard form one optional bundle.
        // If any body cannot be read, preserve the reviewed Phase 3 path.
        codecSource = '';
        navigationCacheSource = '';
        statusGuardSource = '';
      }
    }

    const headers = new Headers(coreResponse.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.delete('last-modified');
    headers.set('cache-control', 'no-cache');
    headers.set('content-type', 'application/javascript; charset=utf-8');
    headers.set('x-taskpoints-phase', phase3Source ? '3-read-path' : '2-dual-write');

    const sources = [coreSource, dualWriteSource, resetHookSource];
    if (phase3Source) sources.push(phase3Source);
    if (codecSource && navigationCacheSource && statusGuardSource) {
      sources.push(codecSource, navigationCacheSource, statusGuardSource);
    }
    return new Response(`${sources.map((source) => `;${source}`).join('\n')}\n`, {
      status: 200,
      headers
    });
  }
};
