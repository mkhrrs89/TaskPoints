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

;(function installTaskPointsRecurringTaskDoneTodayUi(global) {
  'use strict';

  const core = global.TaskPointsCore;
  const document = global.document;
  if (!global || !core || !document || global.TaskPointsRecurringTaskDoneTodayUi?.installed) return;

  const pathname = String(global.location?.pathname || '').replace(/\/+$/, '');
  const isHome = pathname === '' || pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
  if (!isHome) return;

  const INSTALL_POLL_MS = 50;
  const MAX_INSTALL_ATTEMPTS = 240;
  let installAttempts = 0;
  let refreshFrame = 0;
  let midnightTimer = 0;
  let lastDecoratedCount = -1;

  function localDayKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function isRecurringTask(task) {
    return String(task?.recurrence?.mode || 'none') !== 'none';
  }

  function loadJournalAwareState() {
    try {
      const loaded = core.loadAppState?.({ syncDerived: false, persistSync: false });
      if (loaded?.state && typeof loaded.state === 'object') return loaded.state;
      if (loaded && typeof loaded === 'object') return loaded;
    } catch (_) {}
    return null;
  }

  function refresh() {
    const list = document.getElementById('taskList');
    if (!list) return;

    const state = loadJournalAwareState();
    if (!state) return;

    const today = localDayKey(new Date());
    const completedToday = new Set();
    for (const completion of Array.isArray(state.completions) ? state.completions : []) {
      const taskId = String(completion?.taskId || '');
      if (!taskId || localDayKey(completion?.completedAtISO) !== today) continue;
      completedToday.add(taskId);
    }

    const tasksById = new Map(
      (Array.isArray(state.tasks) ? state.tasks : [])
        .filter((task) => task?.id)
        .map((task) => [String(task.id), task])
    );

    let decoratedCount = 0;
    list.querySelectorAll('button[data-task-action="complete"][data-task-id]').forEach((button) => {
      const taskId = String(button.getAttribute('data-task-id') || '');
      const task = tasksById.get(taskId);
      const doneToday = completedToday.has(taskId) && isRecurringTask(task);

      if (doneToday) {
        decoratedCount += 1;
        if (button.dataset.taskDoneToday !== '1') {
          button.dataset.taskDoneToday = '1';
          button.disabled = true;
          button.setAttribute('aria-disabled', 'true');
          button.setAttribute('aria-label', 'Already completed today');
          button.setAttribute('title', 'Already completed today');
          button.textContent = '✓ Today';
          button.style.opacity = '0.62';
          button.style.cursor = 'default';
        }
      } else if (button.dataset.taskDoneToday === '1') {
        delete button.dataset.taskDoneToday;
        button.disabled = false;
        button.removeAttribute('aria-disabled');
        button.setAttribute('aria-label', 'Done');
        button.removeAttribute('title');
        button.textContent = '✓';
        button.style.removeProperty('opacity');
        button.style.removeProperty('cursor');
      }
    });

    if (decoratedCount !== lastDecoratedCount) {
      lastDecoratedCount = decoratedCount;
      try {
        global.TaskPointsPerf?.mark?.('taskAction.doneTodayUiRefreshed', {
          decoratedCount,
          dayKey: today
        });
      } catch (_) {}
    }
  }

  function scheduleRefresh() {
    if (refreshFrame) return;
    const run = () => {
      refreshFrame = 0;
      refresh();
    };
    if (typeof global.requestAnimationFrame === 'function') {
      refreshFrame = global.requestAnimationFrame(run);
    } else {
      refreshFrame = global.setTimeout?.(run, 0) || 0;
    }
  }

  function scheduleMidnightRefresh() {
    if (midnightTimer) global.clearTimeout?.(midnightTimer);
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 1, 0);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    midnightTimer = global.setTimeout?.(() => {
      midnightTimer = 0;
      scheduleRefresh();
      scheduleMidnightRefresh();
    }, delay) || 0;
  }

  function install() {
    const list = document.getElementById('taskList');
    if (!list || typeof global.MutationObserver !== 'function') return false;

    const observer = new global.MutationObserver(() => scheduleRefresh());
    observer.observe(list, { childList: true, subtree: true });

    global.addEventListener?.('taskpoints:state-revision', scheduleRefresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleRefresh();
    });

    global.TaskPointsRecurringTaskDoneTodayUi = {
      installed: true,
      refresh: scheduleRefresh,
      observer,
      get decoratedCount() { return Math.max(0, lastDecoratedCount); }
    };

    scheduleRefresh();
    scheduleMidnightRefresh();

    try {
      global.TaskPointsPerf?.mark?.('taskAction.doneTodayUiInstalled', {});
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
