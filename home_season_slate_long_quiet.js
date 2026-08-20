(function installTaskPointsHomeSeasonSlateLongQuiet(global) {
  'use strict';

  const document = global.document;
  const core = global.TaskPointsCore;
  if (!global || !document || !core || global.TaskPointsHomeSeasonSlateLongQuiet?.installed) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome) return;

  const TARGET_JOB = 'home-season-materialization';
  const REQUIRED_QUIET_MS = 8000;
  const POLL_MS = 250;
  const INSTALL_POLL_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;

  let installAttempts = 0;
  let deferrals = 0;
  let runs = 0;

  function idleStatus() {
    try {
      const status = core.getStorageMaintenanceIdleStatus?.();
      return status && typeof status === 'object' ? status : null;
    } catch (_) {
      return null;
    }
  }

  function readyForLongQuiet(status) {
    if (!status) return null;
    if (document.visibilityState === 'hidden') return false;
    if (status.pageLeaving === true || status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
  }

  function waitForLongQuiet(run) {
    return new Promise((resolve, reject) => {
      let deferred = false;

      const attempt = () => {
        const status = idleStatus();
        const ready = readyForLongQuiet(status);

        // If the shared interaction tracker is unavailable, preserve the
        // existing season materialization rather than risking a job that can
        // never run.
        if (ready == null) {
          Promise.resolve().then(run).then(resolve, reject);
          return;
        }

        if (!ready) {
          deferrals += 1;
          if (!deferred) {
            deferred = true;
            try {
              global.TaskPointsPerf?.mark?.('homeSeason.longQuietDeferred', {
                requiredQuietMs: REQUIRED_QUIET_MS,
                lastInteractionAgoMs: Number(status.lastInteractionAgoMs || 0),
                navigationQuietForMs: Number(status.navigationQuietForMs || 0),
                activeEditor: status.activeEditor === true
              });
            } catch (_) {}
          }
          global.setTimeout?.(attempt, POLL_MS);
          return;
        }

        if (deferred) {
          try {
            global.TaskPointsPerf?.mark?.('homeSeason.longQuietReleased', {
              requiredQuietMs: REQUIRED_QUIET_MS,
              lastInteractionAgoMs: Number(status.lastInteractionAgoMs || 0)
            });
          } catch (_) {}
        }

        runs += 1;
        Promise.resolve().then(run).then(resolve, reject);
      };

      attempt();
    });
  }

  function install() {
    const queue = global.TaskPointsHomeIdleQueue;
    if (!queue || typeof queue.enqueue !== 'function') return false;
    if (queue.enqueue.__taskpointsHomeSeasonSlateLongQuiet) return true;

    const originalEnqueue = queue.enqueue.bind(queue);

    const guardedEnqueue = function taskPointsHomeSeasonSlateLongQuietEnqueue(name, run, options = {}) {
      if (String(name || '') !== TARGET_JOB || typeof run !== 'function') {
        return originalEnqueue(name, run, options);
      }

      return originalEnqueue(name, () => waitForLongQuiet(run), options);
    };

    guardedEnqueue.__taskpointsHomeSeasonSlateLongQuiet = true;
    guardedEnqueue.__taskPointsOriginal = originalEnqueue;
    queue.enqueue = guardedEnqueue;

    global.TaskPointsHomeSeasonSlateLongQuiet = {
      installed: true,
      targetJob: TARGET_JOB,
      requiredQuietMs: REQUIRED_QUIET_MS,
      pollMs: POLL_MS,
      get deferrals() { return deferrals; },
      get runs() { return runs; }
    };

    try {
      global.TaskPointsPerf?.mark?.('homeSeason.longQuietGuardInstalled', {
        requiredQuietMs: REQUIRED_QUIET_MS,
        targetJob: TARGET_JOB
      });
    } catch (_) {}

    return true;
  }

  function installWhenReady() {
    installAttempts += 1;
    if (!install() && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, INSTALL_POLL_MS);
    }
  }

  installWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsHomeInboxNoRedundantPersist(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!global || !core || !document || global.TaskPointsHomeInboxNoRedundantPersist?.installed) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome) return;

  const INSTALL_POLL_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;
  let installAttempts = 0;
  let suppressedLoads = 0;

  function install() {
    if (global.TaskPointsHomeInboxNoRedundantPersist?.installed) return true;

    const original = global.autoPopulateTaskPointsInbox;
    if (typeof original !== 'function') return false;
    if (original.__taskpointsHomeInboxNoRedundantPersist === true) return true;

    const wrapped = function taskPointsHomeInboxNoRedundantPersist(...args) {
      const originalLoad = core.loadAppState;
      if (typeof originalLoad !== 'function') return original.apply(this, args);

      core.loadAppState = function taskPointsHomeInboxLoadState(options = {}) {
        if (options && options.syncDerived === true && options.persistSync === true) {
          suppressedLoads += 1;
          try {
            global.TaskPointsPerf?.mark?.('toolbar.inboxPersistSyncSuppressed', {
              suppressedLoads,
              syncDerived: true,
              originalPersistSync: true,
              effectivePersistSync: false
            });
          } catch (_) {}
          return originalLoad.call(this, { ...options, persistSync: false });
        }
        return originalLoad.apply(this, arguments);
      };

      try {
        return original.apply(this, args);
      } finally {
        core.loadAppState = originalLoad;
      }
    };

    wrapped.__taskpointsHomeInboxNoRedundantPersist = true;
    wrapped.__taskPointsOriginal = original;
    global.autoPopulateTaskPointsInbox = wrapped;
    global.TaskPointsHomeInboxNoRedundantPersist = {
      installed: true,
      get suppressedLoads() { return suppressedLoads; }
    };

    try {
      global.TaskPointsPerf?.mark?.('toolbar.inboxNoRedundantPersistInstalled', {});
    } catch (_) {}

    return true;
  }

  function installWhenReady() {
    installAttempts += 1;
    if (!install() && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, INSTALL_POLL_MS);
    }
  }

  installWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);
