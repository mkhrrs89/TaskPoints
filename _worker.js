import baseWorker from './_worker_core.js';
import { isHomePagePath, transformHomeBoot } from './mobile_boot_gate.js';

const CORE_BUNDLE_ASSET_PATHS = Object.freeze([
  '/scoring_core.js',
  '/phase2_dual_write.js',
  '/phase2_reset_hook.js',
  '/phase3_read_path.js',
  '/phase3_session_codec.js',
  '/phase3_navigation_cache.js',
  '/phase3_status_cache_guard.js',
  '/phase4_storage_coordinator.js',
  '/phase4_primary_read_path.js',
  '/indexeddb_requalification_guard.js',
  '/phase4_cache_guard.js',
  '/phase4_diagnostics.js',
  '/phase5a_native_snapshot.js',
  '/phase5b_deferred_mirror.js',
  '/home_yesterday_result_consistency.js',
  '/flex_action_fast_path.js',
  '/score_alias_consistency.js',
  '/you_score_alias_alignment.js',
  '/habit_completion_source_guard.js',
  '/save_pipeline_shared_work.js',
  '/inbox_count_badge.js'
]);
const CORE_BUNDLE_QUERY_KEY = 'v';
const CORE_BUNDLE_BROWSER_MAX_AGE = 31536000;
const CORE_REDIRECT_BROWSER_MAX_AGE = 60;
let coreBundleVersionPromise = null;
const coreBundleBuildPromises = new Map();

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

function fnv1a(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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

async function readAssetFingerprint(env, request, pathname) {
  const assetUrl = new URL(pathname, request.url);
  try {
    const headResponse = await env.ASSETS.fetch(new Request(assetUrl, {
      method: 'HEAD',
      headers: freshHeaders(request.headers)
    }));
    const headEtag = headResponse?.headers?.get?.('etag');
    if (headResponse?.ok && headEtag) return `${pathname}|etag:${headEtag}`;
  } catch (_) {}

  try {
    const response = await env.ASSETS.fetch(new Request(assetUrl, {
      method: 'GET',
      headers: freshHeaders(request.headers)
    }));
    if (!response.ok) return `${pathname}|missing:${response.status}`;
    const etag = response.headers.get('etag');
    if (etag) return `${pathname}|etag:${etag}`;
    const source = await response.text();
    return `${pathname}|body:${fnv1a(source)}:${source.length}`;
  } catch (error) {
    return `${pathname}|error:${String(error?.name || error?.message || 'asset_read_failed')}`;
  }
}

function getCoreBundleVersion(env, request) {
  if (!coreBundleVersionPromise) {
    coreBundleVersionPromise = Promise.all(
      CORE_BUNDLE_ASSET_PATHS.map((pathname) => readAssetFingerprint(env, request, pathname))
    ).then((fingerprints) => `tp-${fnv1a(fingerprints.join('\n'))}`);
  }
  return coreBundleVersionPromise;
}

function coreBundleCacheKey(request, version) {
  const url = new URL(request.url);
  url.pathname = '/__taskpoints_cached/scoring_core.js';
  url.search = '';
  url.searchParams.set(CORE_BUNDLE_QUERY_KEY, version);
  return new Request(url.toString(), { method: 'GET' });
}

function withBundleCacheStatus(response, status, version) {
  const headers = new Headers(response.headers);
  headers.set('x-taskpoints-bundle-cache', status);
  headers.set('x-taskpoints-core-bundle-version', version);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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

function immutableJavascriptResponse(source, response, version, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('last-modified');
  headers.set('cache-control', `public, max-age=${CORE_BUNDLE_BROWSER_MAX_AGE}, immutable`);
  headers.set('content-type', 'application/javascript; charset=utf-8');
  headers.set('etag', `"${version}"`);
  headers.set('x-taskpoints-core-bundle-version', version);
  headers.set('x-taskpoints-bundle-cache', 'miss');
  Object.entries(extraHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(source, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function redirectToCurrentCoreBundle(request, version) {
  const target = new URL(request.url);
  target.search = '';
  target.searchParams.set(CORE_BUNDLE_QUERY_KEY, version);
  return new Response(null, {
    status: 307,
    headers: {
      location: target.toString(),
      'cache-control': `public, max-age=${CORE_REDIRECT_BROWSER_MAX_AGE}, must-revalidate`,
      etag: `"${version}"`,
      'x-taskpoints-core-bundle-version': version,
      'x-taskpoints-bundle-redirect': 'current-version'
    }
  });
}

async function buildCoreBundle(request, env, ctx, version) {
  const response = await baseWorker.fetch(request, env, ctx);
  if (!response.ok) return response;

  let coreSource = '';
  try { coreSource = await response.text(); }
  catch (_) { return response; }

  const [aliasSource, youAliasSource, habitGuardSource, sharedSaveWorkSource, inboxBadgeSource] = await Promise.all([
    readAssetSource(env, request, '/score_alias_consistency.js'),
    readAssetSource(env, request, '/you_score_alias_alignment.js'),
    readAssetSource(env, request, '/habit_completion_source_guard.js'),
    readAssetSource(env, request, '/save_pipeline_shared_work.js'),
    readAssetSource(env, request, '/inbox_count_badge.js')
  ]);
  const additions = [aliasSource, youAliasSource, habitGuardSource, sharedSaveWorkSource, inboxBadgeSource].filter(Boolean);
  const source = additions.length ? `${coreSource}\n${additions.join('\n')}\n` : coreSource;

  return immutableJavascriptResponse(source, response, version, {
    'x-taskpoints-score-alias-bundle': aliasSource ? 'included' : 'missing',
    'x-taskpoints-you-score-alias-alignment': youAliasSource ? 'included' : 'missing',
    'x-taskpoints-habit-source-guard': habitGuardSource ? 'included' : 'missing',
    'x-taskpoints-shared-save-work': sharedSaveWorkSource ? 'included' : 'missing',
    'x-taskpoints-inbox-count-badge': inboxBadgeSource ? 'included' : 'missing'
  });
}

async function serveCurrentCoreBundle(request, env, ctx, version) {
  const cacheKey = coreBundleCacheKey(request, version);
  const edgeCache = globalThis.caches?.default;
  if (edgeCache) {
    try {
      const cached = await edgeCache.match(cacheKey);
      if (cached) return withBundleCacheStatus(cached, 'hit', version);
    } catch (_) {}
  }

  let buildPromise = coreBundleBuildPromises.get(version);
  if (!buildPromise) {
    buildPromise = buildCoreBundle(request, env, ctx, version)
      .finally(() => coreBundleBuildPromises.delete(version));
    coreBundleBuildPromises.set(version, buildPromise);
  }

  const built = await buildPromise;
  if (built.ok && edgeCache) {
    const putPromise = edgeCache.put(cacheKey, built.clone()).catch(() => undefined);
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(putPromise);
    else await putPromise;
  }
  return built.clone();
}

async function handleCoreBundleRequest(request, env, ctx) {
  const version = await getCoreBundleVersion(env, request);
  const requestedVersion = new URL(request.url).searchParams.get(CORE_BUNDLE_QUERY_KEY);
  if (requestedVersion !== version) return redirectToCurrentCoreBundle(request, version);
  return serveCurrentCoreBundle(request, env, ctx, version);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/scoring_core.js') {
      return handleCoreBundleRequest(request, env, ctx);
    }

    const response = await baseWorker.fetch(request, env, ctx);

    if (request.method === 'GET' && response.ok && isHomePagePath(url.pathname)) {
      return transformHomeBoot(response);
    }

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
          + '<script src="/habit_ledger_repair_planner.js?v=20260731-1" data-taskpoints-habit-ledger-planner="true"></script>'
          + '<script src="/habit_ledger_repair_matchup_prelude.js?v=20260801-2" data-taskpoints-habit-matchup-prelude="true"></script>'
          + '<script src="/habit_ledger_repair_audit.js?v=20260731-1" data-taskpoints-habit-ledger-repair="true"></script>'
          + '<script src="/habit_ledger_matchup_impact_guard.js?v=20260801-1" data-taskpoints-habit-matchup-impact="true"></script>'
          + '<script src="/habit_ledger_matchup_impact_canonical.js?v=20260801-1" data-taskpoints-habit-matchup-canonical="true"></script>'
          + '<script src="/habit_ledger_matchup_impact_dateiso.js?v=20260801-1" data-taskpoints-habit-matchup-dateiso="true"></script>'
          + '<script src="/habit_ledger_matchup_impact_legacy_scores.js?v=20260801-1" data-taskpoints-habit-matchup-legacy-scores="true"></script>'
          + '<script src="/habit_ledger_matchup_restore_transform.js?v=20260801-1" data-taskpoints-habit-matchup-restore-transform="true"></script>'
          + '<script src="/habit_ledger_matchup_impact_attestation.js?v=20260801-1" data-taskpoints-habit-matchup-attestation="true"></script>'
          + '<script src="/habit_ledger_matchup_restore_ui.js?v=20260801-1" data-taskpoints-habit-matchup-restore-ui="true"></script>'
          + '<script src="/habit_ledger_matchup_restore_apply.js?v=20260801-1" data-taskpoints-habit-matchup-restore-apply="true"></script>'
          + '<script src="/habit_ledger_matchup_impact_stale_guard.js?v=20260803-3" data-taskpoints-habit-matchup-stale-guard="true"></script>'
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
      try { auditSource = await response.text(); }
      catch (_) { return response; }

      const [sameDaySource, historyRepairSource, historyAliasSyncSource, aliasSource, bootstrapSource] = await Promise.all([
        readAssetSource(env, request, '/audit_same_day_reconciliation.js'),
        readAssetSource(env, request, '/game_history_reconciliation_repair.js'),
        readAssetSource(env, request, '/game_history_repair_alias_sync.js'),
        readAssetSource(env, request, '/score_alias_consistency.js'),
        readAssetSource(env, request, '/score_alias_audit_bootstrap.js')
      ]);
      const modules = [auditSource, sameDaySource, historyRepairSource, historyAliasSyncSource, aliasSource, bootstrapSource]
        .filter(Boolean)
        .join('\n');
      return javascriptResponse(modules || auditSource, response, {
        'x-taskpoints-audit-same-day-reconciliation': sameDaySource ? 'included' : 'missing',
        'x-taskpoints-game-history-repair': historyRepairSource ? 'included' : 'missing',
        'x-taskpoints-game-history-alias-sync': historyAliasSyncSource ? 'included' : 'missing',
        'x-taskpoints-score-alias-audit-bundle': aliasSource && bootstrapSource ? 'included' : 'partial'
      });
    }

    return response;
  }
};
