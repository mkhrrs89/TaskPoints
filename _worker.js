import baseWorker from './_worker_core.js';

function freshHeaders(headers) {
  const next = new Headers(headers);
  next.delete('if-none-match');
  next.delete('if-modified-since');
  next.delete('range');
  return next;
}

export default {
  async fetch(request, env, ctx) {
    const response = await baseWorker.fetch(request, env, ctx);
    const url = new URL(request.url);

    if (request.method !== 'GET' || url.pathname !== '/scoring_core.js' || !response.ok) {
      return response;
    }

    let coreSource = '';
    try {
      coreSource = await response.text();
    } catch (_) {
      return response;
    }

    let aliasSource = '';
    try {
      const aliasRequest = new Request(new URL('/score_alias_consistency.js', request.url), {
        method: 'GET',
        headers: freshHeaders(request.headers)
      });
      const aliasResponse = await env.ASSETS.fetch(aliasRequest);
      if (aliasResponse.ok) aliasSource = await aliasResponse.text();
    } catch (_) {
      aliasSource = '';
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.delete('last-modified');
    headers.set('cache-control', 'no-cache');
    headers.set('content-type', 'application/javascript; charset=utf-8');

    if (!aliasSource) {
      return new Response(coreSource, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    headers.set('x-taskpoints-score-alias-bundle', 'included');
    return new Response(`${coreSource}\n${aliasSource}\n`, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
