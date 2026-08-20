(function installTaskPointsPhase4Diagnostics(global) {
  'use strict';
  const core = global.TaskPointsCore;
  if (!core || core.__phase4DiagnosticsInstalled) return;
  core.__phase4DiagnosticsInstalled = true;

  const originalStatus = core.getPhase4StorageStatus;
  core.getPhase4StorageStatus = function phase4StorageStatus(options = {}) {
    const status = typeof originalStatus === 'function' ? originalStatus.call(core, options) : {};
    return {
      schemaVersion: 1,
      phase: 'indexeddb_primary',
      configuredMode: core.getPhase4StorageMode?.() || 'off',
      effectiveSource: 'localStorage',
      latestQueuedSequence: 0,
      latestPassedSequence: 0,
      pendingWrites: Number(core.getPendingPhase4WriteCount?.()) || 0,
      lastFallbackReason: null,
      cacheReadyThisPage: Boolean(core.getPhase4VerifiedPrimaryCache?.()),
      ...status
    };
  };
  core.refreshPhase4StorageStatus = async function refreshPhase4StorageStatus() {
    return core.getPhase4StorageStatus({ refresh: true });
  };
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsPhase4HomeLongQuietGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__phase4HomeLongQuietGuardInstalled) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome) return;

  const HOME_LONG_QUIET_MS = 8000;
  const HOME_LONG_QUIET_POLL_MS = 250;
  const MAX_INSTALL_ATTEMPTS = 240;
  let installAttempts = 0;

  function installGuard() {
    if (core.__phase4HomeLongQuietGuardInstalled) return true;

    // storage_maintenance_idle.js is appended later in the final core bundle
    // and owns the final generic 1.4s maintenance gate. Install only after that
    // final shared gate exists so this Home-specific wrapper cannot be replaced.
    if (!core.__storageMaintenanceIdleInstalled || typeof core.whenStorageMaintenanceQuiet !== 'function') {
      return false;
    }

    const originalGate = core.whenStorageMaintenanceQuiet.bind(core);

    function maintenanceStatus() {
      try {
        const value = core.getStorageMaintenanceIdleStatus?.();
        return value && typeof value === 'object' ? value : null;
      } catch (_) {
        return null;
      }
    }

    function isPhase4PrimaryBackground(options = {}) {
      const reason = String(options.reason || options.source || '');
      return reason.startsWith('phase4_primary_write_');
    }

    function authoritativeStateMissing() {
      try { return global.localStorage?.getItem?.(core.STORAGE_KEY) == null; }
      catch (_) { return false; }
    }

    function readyForHomeLongQuiet(status) {
      if (!status) return null;
      if (status.pageLeaving === true || status.activeEditor === true) return false;
      if (Number(status.navigationQuietForMs || 0) > 0) return false;
      return Number(status.lastInteractionAgoMs || 0) >= HOME_LONG_QUIET_MS;
    }

    function waitForHomeLongQuiet(callback, options = {}) {
      return new Promise((resolve, reject) => {
        let deferred = false;

        const run = () => {
          // An actual reset must not wait for the Home quiet window. Phase 4's
          // reset tombstone/cleanup path remains immediate once the ordinary
          // maintenance gate releases it.
          if (authoritativeStateMissing()) {
            Promise.resolve().then(callback).then(resolve, reject);
            return;
          }

          const status = maintenanceStatus();
          const ready = readyForHomeLongQuiet(status);

          // If the shared idle-status helper is unavailable, preserve Phase 4's
          // existing generic-gate behavior rather than blocking maintenance.
          if (ready == null) {
            Promise.resolve().then(callback).then(resolve, reject);
            return;
          }

          if (!ready) {
            if (!deferred) {
              deferred = true;
              try {
                global.TaskPointsPerf?.mark?.('phase4.homeLongQuietDeferred', {
                  requiredQuietMs: HOME_LONG_QUIET_MS,
                  lastInteractionAgoMs: Number(status.lastInteractionAgoMs || 0),
                  navigationQuietForMs: Number(status.navigationQuietForMs || 0),
                  activeEditor: status.activeEditor === true,
                  reason: String(options.reason || options.source || '')
                });
              } catch (_) {}
            }
            global.setTimeout?.(run, HOME_LONG_QUIET_POLL_MS);
            return;
          }

          if (deferred) {
            try {
              global.TaskPointsPerf?.mark?.('phase4.homeLongQuietReleased', {
                requiredQuietMs: HOME_LONG_QUIET_MS,
                lastInteractionAgoMs: Number(status.lastInteractionAgoMs || 0),
                reason: String(options.reason || options.source || '')
              });
            } catch (_) {}
          }

          Promise.resolve().then(callback).then(resolve, reject);
        };

        run();
      });
    }

    core.whenStorageMaintenanceQuiet = function phase4HomeLongQuietMaintenanceGate(callback, options = {}) {
      if (typeof callback !== 'function' || !isPhase4PrimaryBackground(options)) {
        return originalGate(callback, options);
      }
      return originalGate(() => waitForHomeLongQuiet(callback, options), options);
    };

    core.__phase4HomeLongQuietGuardInstalled = true;
    try {
      global.TaskPointsPerf?.mark?.('phase4.homeLongQuietGuardInstalled', {
        requiredQuietMs: HOME_LONG_QUIET_MS,
        storageIdleInstalled: core.__storageMaintenanceIdleInstalled === true
      });
    } catch (_) {}
    return true;
  }

  function installWhenReady() {
    installAttempts += 1;
    if (!installGuard() && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, 50);
    }
  }

  // Phase 4 is embedded earlier than storage_maintenance_idle.js in the same
  // final scoring_core.js response. A microtask runs only after the entire
  // script finishes evaluating, making the normal install order deterministic.
  const startPostBundleInstall = () => installWhenReady();
  if (typeof global.queueMicrotask === 'function') {
    global.queueMicrotask(startPostBundleInstall);
  } else {
    Promise.resolve().then(startPostBundleInstall);
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsScwmHistoryLoadMore(global) {
  'use strict';
  const document = global.document;
  if (!document) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome) return;

  const load = () => {
    if (global.TaskPointsScwmHistoryLoadMore?.installed) return;
    if (document.querySelector('script[data-taskpoints-scwm-history-load-more]')) return;
    const script = document.createElement('script');
    script.src = '/scwm_history_load_more.js?v=20260820-1';
    script.async = true;
    script.dataset.taskpointsScwmHistoryLoadMore = 'true';
    (document.head || document.documentElement).appendChild(script);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load, { once: true });
  } else {
    load();
  }
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsHomeSeasonSlateLongQuiet(global) {
  'use strict';
  const document = global.document;
  if (!document) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome) return;

  if (document.querySelector('script[data-taskpoints-home-season-slate-long-quiet]')) return;
  const script = document.createElement('script');
  script.src = '/home_season_slate_long_quiet.js?v=20260820-1';
  script.async = true;
  script.dataset.taskpointsHomeSeasonSlateLongQuiet = 'true';
  (document.head || document.documentElement).appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);

;(function loadTaskPointsTournamentBracketZoom(global) {
  'use strict';
  const document = global.document;
  if (!document) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isTournament = pathname === '/tournament' || pathname === '/tournament.html' || pathname.endsWith('/tournament.html');
  if (!isTournament) return;

  if (document.querySelector('script[data-taskpoints-tournament-bracket-zoom]')) return;
  const script = document.createElement('script');
  script.src = '/tournament_bracket_zoom.js?v=20260820-2';
  script.async = true;
  script.dataset.taskpointsTournamentBracketZoom = 'true';
  (document.head || document.documentElement).appendChild(script);
})(typeof window !== 'undefined' ? window : globalThis);

;(function installTaskPointsToolbarLongQuietGuard(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!core || !document || global.__taskPointsToolbarLongQuietGuardInstalled) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isInbox = pathname === '/inbox.html' || pathname.endsWith('/inbox.html');
  if (isInbox) return;

  const REQUIRED_QUIET_MS = 8000;
  const QUIET_POLL_MS = 250;
  const INSTALL_RETRY_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;
  let installAttempts = 0;

  function maintenanceStatus() {
    try {
      const value = core.getStorageMaintenanceIdleStatus?.();
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function readyForLongQuiet(status) {
    if (!status) return null;
    if (document.hidden === true) return false;
    if (status.pageLeaving === true || status.activeEditor === true) return false;
    if (Number(status.navigationQuietForMs || 0) > 0) return false;
    return Number(status.lastInteractionAgoMs || 0) >= REQUIRED_QUIET_MS;
  }

  function installGuard() {
    if (global.__taskPointsToolbarLongQuietGuardInstalled) return true;

    const original = global.runTaskPointsToolbarMaintenance;
    if (typeof original !== 'function') return false;
    if (original.__taskpointsToolbarLongQuietGuard === true) {
      global.__taskPointsToolbarLongQuietGuardInstalled = true;
      return true;
    }

    function runAfterLongQuiet(context, args) {
      return new Promise((resolve, reject) => {
        let deferred = false;

        const attempt = () => {
          const status = maintenanceStatus();
          const ready = readyForLongQuiet(status);

          // If the shared maintenance-status helper is unavailable, preserve
          // toolbar/Inbox behavior rather than risking a maintenance deadlock.
          if (ready == null) {
            Promise.resolve(original.apply(context, args)).then(resolve, reject);
            return;
          }

          if (!ready) {
            if (!deferred) {
              deferred = true;
              try {
                global.TaskPointsPerf?.mark?.('toolbar.longQuietDeferred', {
                  requiredQuietMs: REQUIRED_QUIET_MS,
                  lastInteractionAgoMs: Number(status.lastInteractionAgoMs || 0),
                  navigationQuietForMs: Number(status.navigationQuietForMs || 0),
                  activeEditor: status.activeEditor === true
                });
              } catch (_) {}
            }
            global.setTimeout?.(attempt, QUIET_POLL_MS);
            return;
          }

          if (deferred) {
            try {
              global.TaskPointsPerf?.mark?.('toolbar.longQuietReleased', {
                requiredQuietMs: REQUIRED_QUIET_MS,
                lastInteractionAgoMs: Number(status.lastInteractionAgoMs || 0)
              });
            } catch (_) {}
          }

          Promise.resolve(original.apply(context, args)).then(resolve, reject);
        };

        attempt();
      });
    }

    const wrapped = function taskPointsToolbarLongQuietMaintenance(...args) {
      const status = maintenanceStatus();
      const ready = readyForLongQuiet(status);

      // Preserve the original synchronous return when maintenance is already
      // safe to start, or when the shared status helper is unavailable.
      if (ready === true || ready == null) {
        return original.apply(this, args);
      }
      return runAfterLongQuiet(this, args);
    };

    wrapped.__taskpointsToolbarLongQuietGuard = true;
    wrapped.__taskPointsOriginal = original;
    global.runTaskPointsToolbarMaintenance = wrapped;
    global.__taskPointsToolbarLongQuietGuardInstalled = true;

    try {
      const status = maintenanceStatus();
      global.TaskPointsPerf?.mark?.('toolbar.longQuietGuardInstalled', {
        requiredQuietMs: REQUIRED_QUIET_MS,
        storageIdleInstalled: core.__storageMaintenanceIdleInstalled === true,
        lastInteractionAgoMs: Number(status?.lastInteractionAgoMs || 0)
      });
    } catch (_) {}

    return true;
  }

  function installWhenReady() {
    installAttempts += 1;
    if (!installGuard() && installAttempts < MAX_INSTALL_ATTEMPTS) {
      global.setTimeout?.(installWhenReady, INSTALL_RETRY_MS);
    }
  }

  // toolbar.js is a later classic script. Retry until its global maintenance
  // entry point exists, then wrap that entry point without changing Inbox logic.
  installWhenReady();
})(typeof window !== 'undefined' ? window : globalThis);
