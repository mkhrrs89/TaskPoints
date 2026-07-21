export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/settings.html') {
      // Always retrieve a fresh response body before rewriting. A cached 304
      // has no body, so forwarding browser validators could prevent the new
      // in-app status link from appearing for returning Home Screen users.
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
              '<div class="flex flex-wrap gap-2"><a href="dual_write_status.html" class="btn btn-teal btn-toolbar nav-btn">View Dual-Write Status</a></div>',
              { html: true }
            );
          }
        })
        .transform(freshSettingsResponse);
    }

    if (url.pathname !== '/scoring_core.js') return env.ASSETS.fetch(request);

    // Do not forward browser cache validators to the static asset binding. A
    // 304 has no response body to augment, so always retrieve the current core
    // asset and return a fresh 200 response containing the Phase 2 modules.
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

    const moduleRequests = [
      '/phase2_dual_write.js',
      '/phase2_reset_hook.js'
    ].map((pathname) => env.ASSETS.fetch(new Request(new URL(pathname, request.url), {
      method: 'GET'
    })));
    const [dualWriteResponse, resetHookResponse] = await Promise.all(moduleRequests);
    if (!dualWriteResponse.ok || !resetHookResponse.ok) return coreResponse;

    const [coreSource, dualWriteSource, resetHookSource] = await Promise.all([
      coreResponse.text(),
      dualWriteResponse.text(),
      resetHookResponse.text()
    ]);
    const headers = new Headers(coreResponse.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.delete('last-modified');
    headers.set('cache-control', 'no-cache');
    headers.set('content-type', 'application/javascript; charset=utf-8');
    headers.set('x-taskpoints-phase', '2-dual-write');

    return new Response(`${coreSource}\n;${dualWriteSource}\n;${resetHookSource}\n`, {
      status: 200,
      headers
    });
  }
};
