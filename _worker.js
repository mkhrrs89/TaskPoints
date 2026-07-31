import baseWorker from './_worker_core.js';

function freshHeaders(headers) {
  const next = new Headers(headers);
  next.delete('if-none-match');
  next.delete('if-modified-since');
  next.delete('range');
  return next;
}

function noCacheHeaders(headers) {
  const next = new Headers(headers);
  next.delete('content-length');
  next.delete('etag');
  next.delete('last-modified');
  next.set('cache-control', 'no-cache, no-store, must-revalidate');
  return next;
}

function isDirectAliasPage(pathname) {
  return pathname === '/audit.html'
    || pathname === '/audit'
    || pathname === '/matchups.html'
    || pathname === '/matchups';
}

export default {
  async fetch(request, env, ctx) {
    const response = await baseWorker.fetch(request, env, ctx);
    const url = new URL(request.url);

    if (request.method === 'GET' && response.ok && isDirectAliasPage(url.pathname)) {
      const headers = noCacheHeaders(response.headers);
      headers.set('content-type', 'text/html; charset=utf-8');
      const freshResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });

      return new HTMLRewriter()
        .on('body', {
          element(element) {
            element.append(
              '<script src="/score_alias_consistency.js?v=20260730-3" data-taskpoints-score-alias-direct="true"></script>',
              { html: true }
            );
          }
        })
        .transform(freshResponse);
    }

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

    const headers = noCacheHeaders(response.headers);
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
