(function installTaskPointsStorageMaintenanceIdle(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__storageMaintenanceIdleInstalled) return;
  core.__storageMaintenanceIdleInstalled = true;

  const QUIET_MS = 1400;
  const POLL_MS = 180;
  const STARTUP_GRACE_MS = 3500;
  const NAVIGATION_GRACE_MS = 3000;
  const document = global.document;
  const now = () => global.performance?.now?.() ?? Date.now();
  const hasLifecycle = typeof document?.readyState === 'string';
  let lastInteractionAt = now();
  let navigationQuietUntil = hasLifecycle ? now() + STARTUP_GRACE_MS : 0;
  let pageLeaving = false;
  let deferredCalls = 0;
  let executedCalls = 0;

  const extendNavigationQuiet = (durationMs = NAVIGATION_GRACE_MS) => {
    navigationQuietUntil = Math.max(navigationQuietUntil, now() + Math.max(0, Number(durationMs) || 0));
  };
  const markInteraction = () => { lastInteractionAt = now(); };

  function activeEditor() {
    const element = document?.activeElement;
    if (!element) return false;
    const tag = String(element.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
  }

  function navigationAnchorFromEvent(event) {
    const target = event?.target;
    const anchor = target?.closest?.('a[href]') || (String(target?.tagName || '').toLowerCase() === 'a' ? target : null);
    if (!anchor?.getAttribute) return null;
    const href = String(anchor.getAttribute('href') || '').trim();
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return null;
    if (anchor.hasAttribute?.('download')) return null;
    const targetName = String(anchor.getAttribute('target') || '').trim().toLowerCase();
    if (targetName && targetName !== '_self') return null;
    return anchor;
  }

  function markPotentialNavigation(event) {
    markInteraction();
    if (navigationAnchorFromEvent(event)) extendNavigationQuiet();
  }

  function quietEnough() {
    if (pageLeaving) return false;
    if (document?.visibilityState === 'hidden') return false;
    if (hasLifecycle && document.readyState !== 'complete') return false;
    if (now() < navigationQuietUntil) return false;
    if (activeEditor()) return false;
    return now() - lastInteractionAt >= QUIET_MS;
  }

  function explicitOperation(args) {
    const first = args?.[0];
    const text = typeof first === 'string'
      ? first
      : first && typeof first === 'object'
        ? String(first.reason || first.source || first.action || first.caller || '')
        : '';
    return /(manual|recovery|import|reset|smoke|test|explicit|user_requested)/i.test(text);
  }

  function whenQuiet(run) {
    if (quietEnough()) return Promise.resolve().then(run);
    deferredCalls += 1;
    return new Promise((resolve, reject) => {
      const retry = () => {
        if (!quietEnough()) {
          global.setTimeout?.(retry, POLL_MS);
          return;
        }
        Promise.resolve()
          .then(run)
          .then(resolve, reject);
      };
      global.setTimeout?.(retry, POLL_MS);
    });
  }

  function wrapAsyncMaintenance(name) {
    const original = core[name];
    if (typeof original !== 'function' || original.__taskpointsIdleMaintenanceWrapped) return;
    const wrapped = function taskPointsIdleMaintenanceWrapper(...args) {
      if (explicitOperation(args)) return original.apply(this, args);
      return whenQuiet(() => {
        executedCalls += 1;
        return original.apply(this, args);
      });
    };
    Object.defineProperty(wrapped, '__taskpointsIdleMaintenanceWrapped', { value: true });
    core[name] = wrapped;
  }

  // These are cache/requalification maintenance operations. Authoritative
  // localStorage saves are not wrapped and remain synchronous as before.
  [
    'restorePhase4CommittedPrimary',
    'queuePhase4PrimaryWrite',
    'readPhase3ShadowSnapshot',
    'refreshPhase3ReadCache'
  ].forEach(wrapAsyncMaintenance);

  const interactionEvents = ['pointerdown', 'touchstart', 'keydown', 'beforeinput', 'input', 'focusin'];
  interactionEvents.forEach((name) => document?.addEventListener?.(name, markInteraction, { capture: true, passive: true }));
  document?.addEventListener?.('click', markPotentialNavigation, { capture: true, passive: true });

  global.addEventListener?.('beforeunload', () => { pageLeaving = true; });
  global.addEventListener?.('pagehide', () => { pageLeaving = true; });
  global.addEventListener?.('pageshow', () => {
    pageLeaving = false;
    markInteraction();
    extendNavigationQuiet(NAVIGATION_GRACE_MS);
  });
  global.addEventListener?.('load', () => {
    pageLeaving = false;
    extendNavigationQuiet(STARTUP_GRACE_MS);
  }, { once: true });

  core.noteStorageUserInteraction = markInteraction;
  core.noteStorageNavigationIntent = () => {
    markInteraction();
    extendNavigationQuiet(NAVIGATION_GRACE_MS);
  };
  core.isStorageMaintenanceQuiet = quietEnough;
  core.whenStorageMaintenanceQuiet = (run, options = {}) => {
    if (typeof run !== 'function') return Promise.resolve(false);
    if (explicitOperation([options])) return Promise.resolve().then(run);
    return whenQuiet(() => {
      executedCalls += 1;
      return run();
    });
  };
  core.getStorageMaintenanceIdleStatus = () => ({
    installed: true,
    quietMs: QUIET_MS,
    startupGraceMs: STARTUP_GRACE_MS,
    navigationGraceMs: NAVIGATION_GRACE_MS,
    lastInteractionAgoMs: Math.max(0, Math.round(now() - lastInteractionAt)),
    navigationQuietForMs: Math.max(0, Math.round(navigationQuietUntil - now())),
    pageLeaving,
    activeEditor: activeEditor(),
    deferredCalls,
    executedCalls
  });
})(typeof window !== 'undefined' ? window : globalThis);
