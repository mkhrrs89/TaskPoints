export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/scoring_core.js') return env.ASSETS.fetch(request);

    const coreResponse = await env.ASSETS.fetch(request);
    if (!coreResponse.ok) return coreResponse;

    const dualWriteUrl = new URL('/phase2_dual_write.js', request.url);
    const dualWriteResponse = await env.ASSETS.fetch(new Request(dualWriteUrl, request));
    if (!dualWriteResponse.ok) return coreResponse;

    const [coreSource, dualWriteSource] = await Promise.all([
      coreResponse.text(),
      dualWriteResponse.text()
    ]);
    const headers = new Headers(coreResponse.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('content-type', 'application/javascript; charset=utf-8');
    headers.set('x-taskpoints-phase', '2-dual-write');

    return new Response(`${coreSource}\n;${dualWriteSource}\n`, {
      status: coreResponse.status,
      statusText: coreResponse.statusText,
      headers
    });
  }
};
