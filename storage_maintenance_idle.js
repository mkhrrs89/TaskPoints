(function installTaskPointsStorageMaintenanceIdle(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__storageMaintenanceIdleInstalled) return;
  core.__storageMaintenanceIdleInstalled = true;

  const QUIET_MS = 1400;
  const POLL_MS = 180;
  const STARTUP_GRACE_MS = 3500;
  const NAVIGATION_GRACE_MS = 3000;
  const STARTUP_NOOP_SAVE_GUARD_MS = 9000;
  const document = global.document;
  const now = () => global.performance?.now?.() ?? Date.now();
  const hasLifecycle = typeof document?.readyState === 'string';
  let lastInteractionAt = now();
  let navigationQuietUntil = hasLifecycle ? now() + STARTUP_GRACE_MS : 0;
  let pageLeaving = false;
  let observedUserInteraction = false;
  let deferredCalls = 0;
  let executedCalls = 0;
  let startupSaveChecks = 0;
  let startupSaveSkips = 0;

  const extendNavigationQuiet = (durationMs = NAVIGATION_GRACE_MS) => {
    navigationQuietUntil = Math.max(navigationQuietUntil, now() + Math.max(0, Number(durationMs) || 0));
  };
  const markInteraction = (event) => {
    lastInteractionAt = now();
    if (event) observedUserInteraction = true;
  };

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
    markInteraction(event);
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

  function operationText(first) {
    return typeof first === 'string'
      ? first
      : first && typeof first === 'object'
        ? String(first.reason || first.source || first.action || first.caller || first.savePath || '')
        : '';
  }

  function explicitOperation(args) {
    return /(manual|recovery|import|reset|smoke|test|explicit|user_requested)/i.test(operationText(args?.[0]));
  }

  function explicitSaveOperation(options) {
    return /(manual|recovery|import|reset|smoke|test|explicit|user_requested|migration|migrate|upgrade|reencode|encoding|compact|backfill|repair)/i.test(operationText(options));
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

  // These are cache/requalification maintenance operations. Their background
  // invocations wait for startup/navigation quiet; explicit recovery and test
  // operations remain immediate.
  [
    'restorePhase4CommittedPrimary',
    'readPhase3ShadowSnapshot',
    'refreshPhase3ReadCache',
    'warmPhase4PrimaryCache',
    'rebuildPhase3NavigationCache'
  ].forEach(wrapAsyncMaintenance);

  function hasPendingHabitJournal() {
    try {
      if ((Number(core.readPendingHabitDeltas?.().length) || 0) > 0) return true;
    } catch (_) {
      return true;
    }
    return false;
  }

  function normalizedStateForComparison(state) {
    if (!state || typeof state !== 'object') return state || {};
    if (typeof core.normalizeState === 'function') return core.normalizeState(state);
    return state;
  }

  function startupStatesMatch(nextState, storageKey) {
    if (!global.localStorage || typeof core.parseTaskPointsStorageJson !== 'function') return null;
    let raw;
    try { raw = global.localStorage.getItem(storageKey); } catch (_) { return null; }
    if (!raw) return null;
    try {
      const stored = core.parseTaskPointsStorageJson(raw, null);
      if (!stored || typeof stored !== 'object') return null;
      const normalizedStored = normalizedStateForComparison(stored);
      const normalizedNext = normalizedStateForComparison(nextState);
      return {
        equal: JSON.stringify(normalizedStored) === JSON.stringify(normalizedNext),
        state: normalizedStored
      };
    } catch (_) {
      return null;
    }
  }

  function installStartupNoopSaveGuard() {
    const original = core.saveStateSnapshot;
    if (typeof original !== 'function' || original.__taskpointsStartupNoopSaveGuard) return;
    const wrapped = function taskPointsStartupNoopSaveGuard(nextState, options = {}) {
      const storageKey = options.storageKey || core.STORAGE_KEY || 'taskpoints_v1';
      const eligible = storageKey === (core.STORAGE_KEY || 'taskpoints_v1')
        && !observedUserInteraction
        && now() <= STARTUP_NOOP_SAVE_GUARD_MS
        && !pageLeaving
        && !explicitSaveOperation(options)
        && options.allowDestructiveOverwrite !== true
        && options.userInitiated !== true
        && !hasPendingHabitJournal();
      if (!eligible) return original.apply(this, arguments);

      startupSaveChecks += 1;
      const comparison = startupStatesMatch(nextState, storageKey);
      if (!comparison?.equal) return original.apply(this, arguments);

      startupSaveSkips += 1;
      try {
        global.TaskPointsPerf?.mark?.('storage.startupNoopSaveSkipped', {
          savePath: String(options.savePath || options.source || options.reason || options.caller || '')
        });
      } catch (_) {}
      return {
        state: comparison.state,
        trimmed: false,
        skipped: false,
        noOp: true,
        storageKey,
        encoding: 'unchanged'
      };
    };
    Object.defineProperty(wrapped, '__taskpointsStartupNoopSaveGuard', { value: true });
    wrapped.__taskPointsOriginal = original;
    core.saveStateSnapshot = wrapped;
  }

  installStartupNoopSaveGuard();

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
    startupNoopSaveGuardMs: STARTUP_NOOP_SAVE_GUARD_MS,
    lastInteractionAgoMs: Math.max(0, Math.round(now() - lastInteractionAt)),
    navigationQuietForMs: Math.max(0, Math.round(navigationQuietUntil - now())),
    pageLeaving,
    activeEditor: activeEditor(),
    observedUserInteraction,
    deferredCalls,
    executedCalls,
    startupSaveChecks,
    startupSaveSkips
  });
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsImageReadBatching(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const originalGetImageBlob = core?.getImageBlob;
  if (!core || core.__imageReadBatchingInstalled || typeof originalGetImageBlob !== 'function') return;
  if (!global.indexedDB?.open) return;

  const DB_NAME = 'taskpoints';
  const STORE_NAME = 'images';
  const pendingReads = new Map();
  let flushScheduled = false;
  let dbPromise = null;
  let batches = 0;
  let transactions = 0;
  let requestedReads = 0;
  let distinctReads = 0;
  let coalescedReads = 0;
  let lastBatchSize = 0;
  let maxBatchSize = 0;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Failed to open TaskPoints image database.'));
      };
    });
    return dbPromise;
  }

  function settleFromOriginal(imageId, waiters) {
    Promise.resolve()
      .then(() => originalGetImageBlob.call(core, imageId))
      .then(
        (value) => waiters.forEach((waiter) => waiter.resolve(value)),
        (error) => waiters.forEach((waiter) => waiter.reject(error))
      );
  }

  function fallbackBatch(batch) {
    for (const [imageId, waiters] of batch) settleFromOriginal(imageId, waiters);
  }

  function flushBatch() {
    flushScheduled = false;
    if (!pendingReads.size) return;

    const batch = Array.from(pendingReads.entries());
    pendingReads.clear();
    batches += 1;
    lastBatchSize = batch.length;
    maxBatchSize = Math.max(maxBatchSize, batch.length);

    openDb().then((db) => {
      let store;
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        transactions += 1;
        store = tx.objectStore(STORE_NAME);
      } catch (_) {
        fallbackBatch(batch);
        return;
      }

      for (const [imageId, waiters] of batch) {
        let request;
        try {
          request = store.get(imageId);
        } catch (_) {
          settleFromOriginal(imageId, waiters);
          continue;
        }

        request.onsuccess = () => {
          const value = request.result || null;
          waiters.forEach((waiter) => waiter.resolve(value));
        };
        request.onerror = () => settleFromOriginal(imageId, waiters);
      }
    }).catch(() => fallbackBatch(batch));
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(flushBatch);
    else Promise.resolve().then(flushBatch);
  }

  core.getImageBlob = function taskPointsBatchedGetImageBlob(imageId) {
    if (!imageId) return Promise.resolve(null);
    requestedReads += 1;
    return new Promise((resolve, reject) => {
      const existing = pendingReads.get(imageId);
      if (existing) {
        coalescedReads += 1;
        existing.push({ resolve, reject });
      } else {
        distinctReads += 1;
        pendingReads.set(imageId, [{ resolve, reject }]);
      }
      scheduleFlush();
    });
  };

  core.getImageReadBatchingStatus = () => ({
    installed: true,
    batches,
    transactions,
    requestedReads,
    distinctReads,
    coalescedReads,
    lastBatchSize,
    maxBatchSize,
    pendingDistinctReads: pendingReads.size
  });
  core.__imageReadBatchingInstalled = true;
})(typeof window !== 'undefined' ? window : globalThis);
