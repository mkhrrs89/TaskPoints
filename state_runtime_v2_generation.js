(function installTaskPointsStateRuntimeV2Generation(global) {
  'use strict';

  if (!global || global.TaskPointsStateRuntimeV2Generation?.__installedModule) return;

  const KEY = 'taskpoints_state_v2_generation_v1';
  const DARK_MODE_KEY = 'taskpoints_state_v2_dark_mode_v1';
  const PERF_KEY = 'tp_perf_trace_enabled_v1';
  const productionHosts = new Set(['taskpoints.pages.dev', 'www.taskpoints.pages.dev']);
  const FORCED_PREVIEW_HOST = 'arch-state-runtime-v2-plan.taskpoints.pages.dev';
  const listeners = new Set();
  let sequence = 0;
  let rotations = 0;
  let externalChanges = 0;
  let lastReason = null;
  let lastError = null;
  let previewQueryBootstrap = false;
  let forcedPreviewBootstrap = false;

  function safeGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; }
    catch (error) { lastError = String(error?.message || error); return null; }
  }

  function safeSet(key, value) {
    try {
      global.localStorage?.setItem?.(key, String(value));
      return true;
    } catch (error) {
      lastError = String(error?.message || error);
      return false;
    }
  }

  function safeRemove(key) {
    try {
      global.localStorage?.removeItem?.(key);
      return true;
    } catch (error) {
      lastError = String(error?.message || error);
      return false;
    }
  }

  function safeSessionSet(key, value) {
    try {
      global.sessionStorage?.setItem?.(key, String(value));
      return true;
    } catch (error) {
      lastError = String(error?.message || error);
      return false;
    }
  }

  function hostname() {
    return String(global.location?.hostname || '').toLowerCase();
  }

  function isForcedPreviewHost() {
    return hostname() === FORCED_PREVIEW_HOST;
  }

  function bootstrapForcedPreviewHost() {
    if (!isForcedPreviewHost()) return false;
    if (!safeSet(DARK_MODE_KEY, '1')) return false;
    forcedPreviewBootstrap = true;
    lastReason = 'forced-preview-host-bootstrap';
    try {
      global.TaskPointsPerf?.mark?.('stateV2.previewForcedEnabled', {
        hostname: FORCED_PREVIEW_HOST
      });
    } catch (_) {}
    return true;
  }

  function bootstrapFromPreviewQuery() {
    const currentHostname = hostname();
    const previewHost = currentHostname.endsWith('.taskpoints.pages.dev') && !productionHosts.has(currentHostname);
    const localHost = currentHostname === 'localhost' || currentHostname === '127.0.0.1';
    let params;
    try { params = new URLSearchParams(global.location?.search || ''); }
    catch (_) { return false; }

    const requested = String(params.get('v2dark') || '').toLowerCase();
    if (requested !== '1' && requested !== 'on') return false;

    if (productionHosts.has(currentHostname)) {
      safeRemove(DARK_MODE_KEY);
      return false;
    }
    if (!previewHost && !localHost) return false;

    if (!safeSet(DARK_MODE_KEY, '1')) return false;
    const perf = String(params.get('perf') || params.get('tpperf') || '').toLowerCase();
    if (perf === '1' || perf === 'on') safeSessionSet(PERF_KEY, '1');
    previewQueryBootstrap = true;
    lastReason = 'preview-query-bootstrap';

    // Remove only the one-time V2 signal after consuming it. Keep perf=1 so the
    // existing diagnostics bootstrap can independently see it on this load.
    try {
      params.delete('v2dark');
      const nextSearch = params.toString();
      const nextUrl = `${global.location?.pathname || '/'}${nextSearch ? `?${nextSearch}` : ''}${global.location?.hash || ''}`;
      global.history?.replaceState?.(global.history.state, '', nextUrl);
    } catch (_) {}
    return true;
  }

  // The dedicated architecture branch is a test environment. Force dark mode
  // there on every page load so mobile browser storage/redirect quirks cannot
  // silently turn V2 off. Production remains explicitly blocked below and the
  // hostname check means this behavior cannot activate on main if merged later.
  bootstrapForcedPreviewHost();
  bootstrapFromPreviewQuery();

  function isEnabled() {
    return isForcedPreviewHost() || safeGet(DARK_MODE_KEY) === '1';
  }

  function createGeneration(reason = 'generation') {
    sequence += 1;
    const random = global.crypto?.randomUUID?.()
      || `${Date.now()}-${sequence}-${Math.random().toString(36).slice(2)}`;
    return `${String(reason || 'generation').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40)}:${random}`;
  }

  function read() {
    const value = safeGet(KEY);
    return typeof value === 'string' && value ? value : null;
  }

  function notify(event) {
    for (const listener of Array.from(listeners)) {
      try { listener(event); } catch (_) {}
    }
    try { global.TaskPointsPerf?.mark?.('stateV2.generationChanged', event); } catch (_) {}
  }

  function ensure() {
    if (!isEnabled()) return { enabled: false, generation: null, created: false };
    const existing = read();
    if (existing) return { enabled: true, generation: existing, created: false };
    const generation = createGeneration('v2-bootstrap');
    if (!safeSet(KEY, generation)) throw new Error(`state_runtime_v2_generation_write_failed:${lastError || 'unknown'}`);
    lastReason = forcedPreviewBootstrap ? 'forced-preview-bootstrap' : 'bootstrap';
    notify({ generation, previousGeneration: null, reason: lastReason, source: 'local' });
    return { enabled: true, generation, created: true };
  }

  function rotate(reason = 'epoch-change') {
    if (!isEnabled()) return { rotated: false, reason: 'dark_disabled', generation: read() };
    const previousGeneration = read();
    const generation = createGeneration(reason);
    if (!safeSet(KEY, generation)) throw new Error(`state_runtime_v2_generation_write_failed:${lastError || 'unknown'}`);
    rotations += 1;
    lastReason = String(reason || 'epoch-change');
    const event = { generation, previousGeneration, reason: lastReason, source: 'local' };
    notify(event);
    return { rotated: true, ...event };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getStatus() {
    return {
      installed: true,
      enabled: isEnabled(),
      key: KEY,
      generation: read(),
      rotations,
      externalChanges,
      previewQueryBootstrap,
      forcedPreviewBootstrap,
      forcedPreviewHost: isForcedPreviewHost(),
      lastReason,
      lastError
    };
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', (event) => {
      if (event?.key !== KEY || !event.newValue || event.newValue === event.oldValue) return;
      externalChanges += 1;
      lastReason = 'external-storage-event';
      notify({
        generation: String(event.newValue),
        previousGeneration: event.oldValue ? String(event.oldValue) : null,
        reason: lastReason,
        source: 'storage'
      });
    });
  }

  const api = {
    __installedModule: true,
    KEY,
    DARK_MODE_KEY,
    FORCED_PREVIEW_HOST,
    isForcedPreviewHost,
    isEnabled,
    createGeneration,
    read,
    ensure,
    rotate,
    subscribe,
    getStatus
  };

  global.TaskPointsStateRuntimeV2Generation = api;
  if (isEnabled()) {
    try { ensure(); } catch (_) {}
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
