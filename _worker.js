export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
