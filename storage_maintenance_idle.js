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

;(function installTaskPointsHomeHabitCompactionQuietGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!core || !document || core.__homeHabitCompactionQuietGuardInstalled) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome) return;

  const REQUIRED_QUIET_MS = 8000;
  const POLL_MS = 250;
  const MAX_INSTALL_ATTEMPTS = 240;
  let installAttempts = 0;
  let installed = false;
  let pending = false;
  let timer = 0;
  let deferred = false;
  let deferrals = 0;
  let runs = 0;
  let originalScheduleHabitSave = null;
  let originalSavePendingHabitState = null;
  let originalFlushPendingHabitSave = null;

  function cancelTimer() {
    if (timer) global.clearTimeout?.(timer);
    timer = 0;
  }

  function idleStatus() {
    try {
      const status = core.getStorageMaintenanceIdleStatus?.();
      return status && typeof status === 'object' ? status : null;
    } catch (_) {
      return null;
    }
  }

  function compactionReady(status = idleStatus()) {
    if (!status) return null;
    if (status.pageLeaving === true || document.visibilityState === 'hidden') return false;
    if (status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
  }

  function markDeferred(status) {
    if (deferred) return;
    deferred = true;
    try {
      global.TaskPointsPerf?.mark?.('habit.compactionDeferred', {
        requiredQuietMs: REQUIRED_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0),
        navigationQuietForMs: Number(status?.navigationQuietForMs || 0),
        activeEditor: status?.activeEditor === true
      });
    } catch (_) {}
  }

  function markReleased(status) {
    if (!deferred) return;
    deferred = false;
    try {
      global.TaskPointsPerf?.mark?.('habit.compactionReleased', {
        requiredQuietMs: REQUIRED_QUIET_MS,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0)
      });
    } catch (_) {}
  }

  function attemptCompaction() {
    timer = 0;
    if (!pending || typeof originalSavePendingHabitState !== 'function') return false;

    const status = idleStatus();
    const ready = compactionReady(status);
    if (ready === null) {
      // If the maintenance tracker is unavailable, preserve the legacy Home
      // scheduler rather than risking a journal that can never compact.
      pending = false;
      deferred = false;
      originalScheduleHabitSave?.();
      return true;
    }
    if (!ready) {
      deferrals += 1;
      markDeferred(status);
      timer = global.setTimeout?.(attemptCompaction, POLL_MS) || 0;
      return false;
    }

    pending = false;
    markReleased(status);
    runs += 1;
    originalSavePendingHabitState();
    return true;
  }

  function scheduleGuardedHabitCompaction() {
    pending = true;
    cancelTimer();
    timer = global.setTimeout?.(attemptCompaction, POLL_MS) || 0;
  }

  function install() {
    if (installed) return true;
    if (typeof global.scheduleHabitSave !== 'function'
      || typeof global.savePendingHabitState !== 'function'
      || typeof global.flushPendingHabitSave !== 'function') return false;

    originalScheduleHabitSave = global.scheduleHabitSave;
    originalSavePendingHabitState = global.savePendingHabitState;
    originalFlushPendingHabitSave = global.flushPendingHabitSave;

    scheduleGuardedHabitCompaction.__taskpointsHomeHabitCompactionQuietGuard = true;
    scheduleGuardedHabitCompaction.__taskPointsOriginal = originalScheduleHabitSave;
    global.scheduleHabitSave = scheduleGuardedHabitCompaction;

    const guardedFlush = function taskPointsHomeHabitCompactionQuietFlush(...args) {
      const hadGuardPending = pending || Boolean(timer);
      cancelTimer();
      pending = false;
      deferred = false;
      const legacyPending = originalFlushPendingHabitSave.apply(this, args);
      return Boolean(hadGuardPending || legacyPending);
    };
    guardedFlush.__taskpointsHomeHabitCompactionQuietGuard = true;
    guardedFlush.__taskPointsOriginal = originalFlushPendingHabitSave;
    global.flushPendingHabitSave = guardedFlush;

    core.getHomeHabitCompactionQuietGuardStatus = () => ({
      installed: true,
      requiredQuietMs: REQUIRED_QUIET_MS,
      pollMs: POLL_MS,
      pending,
      deferred,
      deferrals,
      runs
    });
    core.__homeHabitCompactionQuietGuardInstalled = true;
    installed = true;
    return true;
  }

  function installWhenReady() {
    installAttempts += 1;
    if (!install() && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, 50);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installWhenReady, { once: true });
  else installWhenReady();
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

;(function installTaskPointsHeavyStorageLongQuietGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!core || !document || core.__heavyStorageLongQuietGuardInstalled) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome || typeof core.whenStorageMaintenanceQuiet !== 'function') return;

  const REQUIRED_QUIET_MS = 20000;
  const POLL_MS = 250;
  const HEAVY_REASONS = new Set(['phase2_dual_write_coalesced', 'phase5c_verified_secondary']);
  const originalWhenQuiet = core.whenStorageMaintenanceQuiet.bind(core);
  let deferrals = 0;
  let releases = 0;
  let pendingWaiters = 0;
  let lastReason = '';

  function optionReason(options = {}) {
    return String(options.reason || options.source || options.action || options.caller || '');
  }

  function status() {
    try {
      const value = core.getStorageMaintenanceIdleStatus?.();
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function deepQuietReady(current = status()) {
    if (!current) return null;
    if (document.visibilityState === 'hidden') return false;
    if (current.pageLeaving === true || current.activeEditor === true) return false;
    if (Number(current.navigationQuietForMs || 0) > 0) return false;
    return Number(current.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
  }

  function mark(name, detail = {}) {
    try { global.TaskPointsPerf?.mark?.(name, detail); } catch (_) {}
  }

  function waitForDeepQuiet(reason) {
    const current = status();
    const ready = deepQuietReady(current);
    if (ready === null) return Promise.resolve();
    if (ready) return Promise.resolve();

    deferrals += 1;
    pendingWaiters += 1;
    lastReason = reason;
    mark('storage.heavyMaintenanceDeferred', {
      reason,
      requiredQuietMs: REQUIRED_QUIET_MS,
      lastInteractionAgoMs: Number(current?.lastInteractionAgoMs || 0),
      navigationQuietForMs: Number(current?.navigationQuietForMs || 0),
      activeEditor: current?.activeEditor === true
    });

    return new Promise((resolve) => {
      const retry = () => {
        const next = status();
        const nextReady = deepQuietReady(next);
        if (nextReady === false) {
          global.setTimeout?.(retry, POLL_MS);
          return;
        }
        pendingWaiters = Math.max(0, pendingWaiters - 1);
        releases += 1;
        mark('storage.heavyMaintenanceReleased', {
          reason,
          requiredQuietMs: REQUIRED_QUIET_MS,
          lastInteractionAgoMs: Number(next?.lastInteractionAgoMs || 0)
        });
        resolve();
      };
      global.setTimeout?.(retry, POLL_MS);
    });
  }

  core.whenStorageMaintenanceQuiet = function taskPointsHeavyStorageLongQuiet(run, options = {}) {
    const reason = optionReason(options);
    if (typeof run !== 'function' || !HEAVY_REASONS.has(reason)) {
      return originalWhenQuiet(run, options);
    }

    return waitForDeepQuiet(reason).then(() => originalWhenQuiet(() => {
      // Re-check at the final execution boundary. If a touch landed while the
      // shared 1.4 s maintenance gate was resolving, restart the deep-idle wait
      // instead of beginning a multi-second IndexedDB mirror beside that touch.
      if (deepQuietReady(status()) === false) {
        return core.whenStorageMaintenanceQuiet(run, options);
      }
      return run();
    }, options));
  };

  core.getHeavyStorageLongQuietGuardStatus = () => ({
    installed: true,
    requiredQuietMs: REQUIRED_QUIET_MS,
    pollMs: POLL_MS,
    heavyReasons: Array.from(HEAVY_REASONS),
    deferrals,
    releases,
    pendingWaiters,
    lastReason
  });
  core.__heavyStorageLongQuietGuardInstalled = true;
})(typeof window !== 'undefined' ? window : globalThis);
