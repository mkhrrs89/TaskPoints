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

function directAliasPageKind(pathname) {
  const clean = String(pathname || '').replace(/\/+$/, '');
  if (/(^|\/)audit(?:\.html)?$/.test(clean)) return 'audit';
  if (/(^|\/)matchups(?:\.html)?$/.test(clean)) return 'matchups';
  return '';
}

async function readAssetSource(env, request, pathname) {
  try {
    const assetRequest = new Request(new URL(pathname, request.url), {
      method: 'GET',
      headers: freshHeaders(request.headers)
    });
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    return assetResponse.ok ? await assetResponse.text() : '';
  } catch (_) {
    return '';
  }
}

function javascriptResponse(source, response, extraHeaders = {}) {
  const headers = noCacheHeaders(response.headers);
  headers.set('content-type', 'application/javascript; charset=utf-8');
  Object.entries(extraHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(source, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env, ctx) {
    const response = await baseWorker.fetch(request, env, ctx);
    const url = new URL(request.url);
    const directPageKind = directAliasPageKind(url.pathname);

    if (request.method === 'GET' && response.ok && directPageKind) {
      const headers = noCacheHeaders(response.headers);
      headers.set('content-type', 'text/html; charset=utf-8');
      const freshResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
      const auditBootstrap = directPageKind === 'audit'
        ? '<script src="/audit_same_day_reconciliation.js?v=20260731-3" data-taskpoints-audit-same-day-direct="true"></script>'
          + '<script src="/game_history_reconciliation_repair.js?v=20260731-1" data-taskpoints-game-history-repair="true"></script>'
          + '<script src="/game_history_repair_alias_sync.js?v=20260731-1" data-taskpoints-game-history-alias-sync="true"></script>'
          + '<script src="/habit_ledger_consistency_repair.js?v=20260731-1" data-taskpoints-habit-ledger-repair="true"></script>'
          + '<script src="/score_alias_audit_bootstrap.js?v=20260731-2" data-taskpoints-score-alias-audit-bootstrap="true"></script>'
        : '';

      return new HTMLRewriter()
        .on('body', {
          element(element) {
            element.append(
              '<script src="/score_alias_consistency.js?v=20260731-5" data-taskpoints-score-alias-direct="true"></script>' + auditBootstrap,
              { html: true }
            );
          }
        })
        .transform(freshResponse);
    }

    if (request.method === 'GET' && response.ok && url.pathname === '/audit_integrity.js') {
      let auditSource = '';
      try {
        auditSource = await response.text();
      } catch (_) {
        return response;
      }
      const [sameDaySource, historyRepairSource, historyAliasSyncSource, aliasSource, bootstrapSource] = await Promise.all([
        readAssetSource(env, request, '/audit_same_day_reconciliation.js'),
        readAssetSource(env, request, '/game_history_reconciliation_repair.js'),
        readAssetSource(env, request, '/game_history_repair_alias_sync.js'),
        readAssetSource(env, request, '/score_alias_consistency.js'),
        readAssetSource(env, request, '/score_alias_audit_bootstrap.js')
      ]);
      const modules = [
        auditSource,
        sameDaySource,
        historyRepairSource,
        historyAliasSyncSource,
        aliasSource,
        bootstrapSource
      ].filter(Boolean).join('\n');
      return javascriptResponse(modules || auditSource, response, {
        'x-taskpoints-audit-same-day-reconciliation': sameDaySource ? 'included' : 'missing',
        'x-taskpoints-game-history-repair': historyRepairSource ? 'included' : 'missing',
        'x-taskpoints-game-history-alias-sync': historyAliasSyncSource ? 'included' : 'missing',
        'x-taskpoints-score-alias-audit-bundle': aliasSource && bootstrapSource ? 'included' : 'partial'
      });
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

    const [aliasSource, habitLedgerSource] = await Promise.all([
      readAssetSource(env, request, '/score_alias_consistency.js'),
      readAssetSource(env, request, '/habit_ledger_consistency_repair.js')
    ]);
    const additions = [aliasSource, habitLedgerSource].filter(Boolean);
    if (!additions.length) return javascriptResponse(coreSource, response);

    return javascriptResponse(`${coreSource}\n${additions.join('\n')}\n`, response, {
      'x-taskpoints-score-alias-bundle': aliasSource ? 'included' : 'missing',
      'x-taskpoints-habit-ledger-bundle': habitLedgerSource ? 'included' : 'missing'
    });
  }
};
