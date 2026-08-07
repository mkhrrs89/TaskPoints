;(function installTaskPointsScwmFastPath(global) {
  'use strict';

  if (global.TaskPointsScwmInteractionFastPath?.installed) return;

  const VERSION = 3;
  const MODALS = '#sleepEditModal, #caloriesEditModal, #workEditModal, #moodEditModal';
  const PANEL_ID = 'homePanelScwm';
  const HISTORY_DAYS = 14;
  const SAVE_IDLE_TIMEOUT = 900;
  const ARM_MS = 2400;
  const POLL_GUARD_MS = 300;
  const HEARTBEAT_MS = 850;

  const originals = {};
  const wrapped = new Set();
  const status = {
    installs: 0,
    savesDeferred: 0,
    savesFlushed: 0,
    fullRendersSuppressed: 0,
    scwmRenders: 0,
    indexBuilds: 0,
    compactRenders: 0,
    pollsSuppressed: 0,
    idleTouches: 0,
    modalLocksBypassed: 0
  };

  let installed = false;
  let installAttempts = 0;
  let installTimer = null;
  let armedUntil = 0;
  let commitDepth = 0;
  let pendingSave = null;
  let saveTimer = null;
  let saveIdle = null;
  let pendingFullRender = false;
  let index = null;
  let indexDirty = true;
  let compactDepth = 0;
  let pollGuardUntil = 0;
  let fakeIntervalId = -1;
  let modalHeartbeat = null;
  const modalLockStack = [];

  const now = () => Number(global.performance?.now?.()) || Date.now();

  function isMobile() {
    try {
      return typeof global.matchMedia !== 'function'
        || global.matchMedia('(max-width: 767px)').matches;
    } catch (_) {
      return true;
    }
  }

  function visible(el) {
    return Boolean(
      el
      && el.hidden !== true
      && !el.classList?.contains?.('hidden')
      && el.getAttribute?.('aria-hidden') !== 'true'
    );
  }

  function scwmPanelActive() {
    if (!isMobile()) return false;
    const panel = global.document?.getElementById?.(PANEL_ID);
    return visible(panel) && Boolean(panel?.classList?.contains?.('is-active'));
  }

  function openScwmModal() {
    const nodes = global.document?.querySelectorAll?.(MODALS) || [];
    return Array.from(nodes).find(visible) || null;
  }

  function armed() {
    return commitDepth > 0 || now() <= armedUntil;
  }

  function scwmBusy() {
    return isMobile() && (scwmPanelActive() || Boolean(openScwmModal()) || armed());
  }

  function homeState() {
    if (global.__tpScwmStateForTest && typeof global.__tpScwmStateForTest === 'object') {
      return global.__tpScwmStateForTest;
    }
    if (global.state && typeof global.state === 'object') return global.state;
    try {
      return typeof global.eval === 'function'
        ? global.eval('typeof state !== "undefined" ? state : null')
        : null;
    } catch (_) {
      return null;
    }
  }

  function dayKey(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      const key = global.dateKey?.(date);
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return String(key);
    } catch (_) {}
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  }

  function cutoffKey() {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - HISTORY_DAYS - 1);
    return dayKey(date);
  }

  function category(entry) {
    const title = String(entry?.title || '');
    if (title.startsWith('Sleep Score')) return 'sleep';
    if (title.startsWith('Calories')) return 'calories';
    if (title.startsWith('Work Score')) return 'work';
    if (title.startsWith('Mood Score')) return 'mood';
    return '';
  }

  function completionDay(entry) {
    const stored = String(entry?.dateKey || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(stored) ? stored : dayKey(entry?.completedAtISO);
  }

  function invalidateIndex() {
    indexDirty = true;
  }

  function buildIndex() {
    const state = homeState();
    const completions = Array.isArray(state?.completions) ? state.completions : [];
    const currentDay = dayKey(new Date());
    const cutoff = cutoffKey();
    const byId = new Map();
    const byDayCategory = new Map();
    const compact = [];

    for (const entry of completions) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.id != null && !byId.has(String(entry.id))) byId.set(String(entry.id), entry);
      const cat = category(entry);
      if (!cat) continue;
      const key = completionDay(entry);
      if (!key) continue;
      if (!byDayCategory.has(`${key}|${cat}`)) byDayCategory.set(`${key}|${cat}`, entry);
      if (key >= cutoff) compact.push(entry);
    }

    index = {
      source: completions,
      length: completions.length,
      day: currentDay,
      byId,
      byDayCategory,
      compact
    };
    indexDirty = false;
    status.indexBuilds += 1;
    return index;
  }

  function ensureIndex() {
    const state = homeState();
    const completions = Array.isArray(state?.completions) ? state.completions : [];
    const currentDay = dayKey(new Date());
    if (
      indexDirty
      || !index
      || index.source !== completions
      || index.length !== completions.length
      || index.day !== currentDay
    ) return buildIndex();
    return index;
  }

  function compactCall(fn, thisArg, args) {
    const state = homeState();
    if (!state || !Array.isArray(state.completions) || compactDepth) {
      return fn.apply(thisArg, args);
    }
    const full = state.completions;
    state.completions = ensureIndex().compact;
    compactDepth += 1;
    try {
      status.compactRenders += 1;
      return fn.apply(thisArg, args);
    } finally {
      state.completions = full;
      compactDepth -= 1;
    }
  }

  function wrapIndexConsumers() {
    if (typeof global.markCompletionsDirty === 'function' && !wrapped.has('markCompletionsDirty')) {
      originals.markCompletionsDirty = global.markCompletionsDirty;
      global.markCompletionsDirty = function () {
        invalidateIndex();
        return originals.markCompletionsDirty.apply(this, arguments);
      };
      wrapped.add('markCompletionsDirty');
    }

    if (typeof global.resolveCompletionRef === 'function' && !wrapped.has('resolveCompletionRef')) {
      originals.resolveCompletionRef = global.resolveCompletionRef;
      global.resolveCompletionRef = function (ref) {
        const hit = ref?.id != null ? ensureIndex().byId.get(String(ref.id)) : null;
        return hit || originals.resolveCompletionRef.apply(this, arguments);
      };
      wrapped.add('resolveCompletionRef');
    }

    const todayHelpers = {
      getTodaySleepEntry: 'sleep',
      getTodayCaloriesEntry: 'calories',
      getTodayWorkEntry: 'work',
      getTodayMoodEntry: 'mood'
    };
    Object.entries(todayHelpers).forEach(([name, cat]) => {
      if (wrapped.has(name) || typeof global[name] !== 'function') return;
      originals[name] = global[name];
      global[name] = function () {
        const hit = ensureIndex().byDayCategory.get(`${dayKey(new Date())}|${cat}`);
        return hit || originals[name].apply(this, arguments);
      };
      wrapped.add(name);
    });

    ['renderScoreDashboardV2_Skeleton', 'renderScoreV2RecentGrid'].forEach((name) => {
      if (wrapped.has(name) || typeof global[name] !== 'function') return;
      originals[name] = global[name];
      global[name] = function () {
        return compactCall(originals[name], this, arguments);
      };
      wrapped.add(name);
    });
  }

  function clearSaveSchedule() {
    if (saveTimer != null) global.clearTimeout?.(saveTimer);
    if (saveIdle != null) {
      global.cancelIdleCallback?.(saveIdle);
      global.clearTimeout?.(saveIdle);
    }
    saveTimer = null;
    saveIdle = null;
  }

  function flushSave() {
    clearSaveSchedule();
    const queued = pendingSave;
    pendingSave = null;
    if (!queued || typeof originals.save !== 'function') return false;
    originals.save.apply(queued.thisArg, queued.args);
    status.savesFlushed += 1;
    return true;
  }

  function queueSave() {
    clearSaveSchedule();
    const afterPaint = () => {
      const run = () => {
        saveIdle = null;
        flushSave();
      };
      if (typeof global.requestIdleCallback === 'function') {
        saveIdle = global.requestIdleCallback(run, { timeout: SAVE_IDLE_TIMEOUT });
      } else {
        saveIdle = global.setTimeout?.(run, 0);
      }
    };
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(() => global.requestAnimationFrame(afterPaint));
    } else {
      saveTimer = global.setTimeout?.(afterPaint, 0);
    }
  }

  function fastSave() {
    if (!scwmBusy()) return originals.save.apply(this, arguments);
    pendingSave = { thisArg: this, args: Array.from(arguments) };
    status.savesDeferred += 1;
    queueSave();
  }

  function refreshScwm() {
    status.scwmRenders += 1;
    try {
      if (typeof global.refreshScoreV2UI === 'function') global.refreshScoreV2UI();
      else {
        global.renderScoreDashboardV2_Skeleton?.();
        global.renderScoreV2RecentGrid?.();
      }
      const control = global.TaskPointsHomeTargetedRenderControl;
      if (typeof control?.refreshLiveScorePanels === 'function') {
        control.refreshLiveScorePanels({ includeYesterday: true });
      } else {
        global.renderTodayPointsSummary?.();
        global.renderTodaysMatchup?.();
        global.updateTodayBreakdown?.();
      }
      return true;
    } catch (error) {
      if (global.TP_DEBUG_PERF) console.warn('[TP SCWM] lightweight refresh failed', error);
      return false;
    }
  }

  function fastRenderAll() {
    if (scwmBusy()) {
      pendingFullRender = true;
      status.fullRendersSuppressed += 1;
      return refreshScwm();
    }
    pendingFullRender = false;
    return originals.renderAll.apply(this, arguments);
  }

  function flushFullRender() {
    if (!pendingFullRender || typeof originals.renderAll !== 'function') return false;
    if (scwmBusy()) {
      if (!scwmPanelActive() && !openScwmModal() && armed()) {
        global.setTimeout?.(flushFullRender, Math.max(20, armedUntil - now() + 20));
      }
      return false;
    }
    pendingFullRender = false;
    originals.renderAll.call(global);
    return true;
  }

  function wrapCommits() {
    const funcs = {
      saveSleepScore: 'sleep',
      submitSleepEditModal: 'sleep',
      saveCalories: 'calories',
      editTodayCalories: 'calories',
      saveWorkScore: 'work',
      submitWorkEditModal: 'work',
      saveMoodScore: 'mood',
      submitMoodEditModal: 'mood'
    };
    Object.entries(funcs).forEach(([name]) => {
      if (wrapped.has(name) || typeof global[name] !== 'function') return;
      originals[name] = global[name];
      global[name] = function () {
        armedUntil = Math.max(armedUntil, now() + ARM_MS);
        commitDepth += 1;
        let result;
        try {
          result = originals[name].apply(this, arguments);
        } catch (error) {
          commitDepth = Math.max(0, commitDepth - 1);
          throw error;
        }
        const finish = () => {
          commitDepth = Math.max(0, commitDepth - 1);
          invalidateIndex();
          global.requestAnimationFrame?.(refreshScwm);
        };
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).finally(finish);
        }
        finish();
        return result;
      };
      wrapped.add(name);
    });
  }

  function installPollGuard() {
    if (global.setInterval?.__tpScwmPollGuard || typeof global.setInterval !== 'function') return;
    originals.setInterval = global.setInterval.bind(global);
    const guarded = function (callback, delay) {
      let source = '';
      try { source = Function.prototype.toString.call(callback); } catch (_) {}
      const legacyPoll = (
        Number(delay) === 100
        && now() <= pollGuardUntil
        && source.includes('beforeTitle')
        && source.includes('beforePts')
        && source.includes('nowTitle')
        && source.includes('nowPts')
        && source.includes('renderScoreDashboardV2_Skeleton')
      );
      if (legacyPoll) {
        status.pollsSuppressed += 1;
        return --fakeIntervalId;
      }
      return originals.setInterval.apply(global, arguments);
    };
    guarded.__tpScwmPollGuard = true;
    global.setInterval = guarded;
  }

  function noteInteraction() {
    try {
      global.TaskPointsHomeIdleQueue?.noteInteraction?.();
      status.idleTouches += 1;
    } catch (_) {}
  }

  function stopHeartbeat() {
    if (modalHeartbeat != null) global.clearTimeout?.(modalHeartbeat);
    modalHeartbeat = null;
  }

  function startHeartbeat() {
    stopHeartbeat();
    const tick = () => {
      modalHeartbeat = null;
      if (global.document?.hidden || !openScwmModal()) return;
      noteInteraction();
      modalHeartbeat = global.setTimeout?.(tick, HEARTBEAT_MS);
    };
    noteInteraction();
    modalHeartbeat = global.setTimeout?.(tick, HEARTBEAT_MS);
  }

  function afterPaint(fn) {
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(() => global.setTimeout?.(fn, 0));
    } else global.setTimeout?.(fn, 0);
  }

  function wrapModalFunctions() {
    const openers = {
      promptEditSleepEntry: 'sleepEditScoreInput',
      promptEditWorkEntry: 'workEditScoreInput'
    };
    Object.entries(openers).forEach(([name, inputId]) => {
      if (wrapped.has(name) || typeof global[name] !== 'function') return;
      originals[name] = global[name];
      global[name] = function () {
        pollGuardUntil = now() + POLL_GUARD_MS;
        noteInteraction();
        const input = global.document?.getElementById?.(inputId);
        const focus = typeof input?.focus === 'function' ? input.focus.bind(input) : null;
        const select = typeof input?.select === 'function' ? input.select.bind(input) : null;
        let wantsFocus = false;
        let wantsSelect = false;
        let patched = false;
        if (input && focus) {
          try {
            input.focus = () => { wantsFocus = true; };
            input.select = () => { wantsSelect = true; };
            patched = true;
          } catch (_) {}
        }
        let result;
        try {
          result = originals[name].apply(this, arguments);
        } finally {
          if (patched) {
            try {
              delete input.focus;
              delete input.select;
            } catch (_) {}
          }
          global.document?.body?.classList?.toggle?.('tp-scwm-editing', Boolean(openScwmModal()));
          startHeartbeat();
        }
        if (patched && (wantsFocus || wantsSelect)) {
          afterPaint(() => {
            if (wantsFocus) focus?.({ preventScroll: true });
            if (wantsSelect) select?.();
          });
        }
        return result;
      };
      wrapped.add(name);
    });

    ['closeSleepEditModal', 'closeWorkEditModal', 'closeMoodEditModal'].forEach((name) => {
      if (wrapped.has(name) || typeof global[name] !== 'function') return;
      originals[name] = global[name];
      global[name] = function () {
        const result = originals[name].apply(this, arguments);
        afterPaint(() => {
          const modalOpen = Boolean(openScwmModal());
          global.document?.body?.classList?.toggle?.('tp-scwm-editing', modalOpen);
          if (!modalOpen) stopHeartbeat();
        });
        return result;
      };
      wrapped.add(name);
    });
  }

  function installSmartModalLock() {
    if (
      global.lockScrollForModal?.__tpScwmSmartLock
      || typeof global.lockScrollForModal !== 'function'
      || typeof global.unlockScrollForModal !== 'function'
    ) return;

    originals.lockScrollForModal = global.lockScrollForModal;
    originals.unlockScrollForModal = global.unlockScrollForModal;

    const lock = function () {
      const bypass = isMobile() && Boolean(openScwmModal());
      modalLockStack.push(bypass ? 'scwm' : 'normal');
      if (bypass) {
        status.modalLocksBypassed += 1;
        startHeartbeat();
        return;
      }
      return originals.lockScrollForModal.apply(this, arguments);
    };
    const unlock = function () {
      const mode = modalLockStack.length ? modalLockStack.pop() : 'normal';
      if (mode === 'scwm') {
        if (!openScwmModal()) stopHeartbeat();
        return;
      }
      return originals.unlockScrollForModal.apply(this, arguments);
    };
    lock.__tpScwmSmartLock = true;
    unlock.__tpScwmSmartLock = true;
    global.lockScrollForModal = lock;
    global.unlockScrollForModal = unlock;
  }

  function insideScwm(target) {
    try {
      return Boolean(target?.closest?.(MODALS) || target?.closest?.(`#${PANEL_ID}`));
    } catch (_) {
      return false;
    }
  }

  function installInteractionGuards() {
    if (global.__tpScwmInteractionGuards) return;
    global.__tpScwmInteractionGuards = true;
    const doc = global.document;

    ['beforeinput', 'input', 'focusin', 'compositionstart', 'compositionupdate', 'keydown', 'pointerdown', 'touchstart']
      .forEach((name) => doc?.addEventListener?.(name, (event) => {
        if (insideScwm(event?.target) || openScwmModal()) noteInteraction();
      }, true));

    doc?.addEventListener?.('touchmove', (event) => {
      if (event?.target?.closest?.(MODALS) && event.cancelable) event.preventDefault();
    }, { capture: true, passive: false });

    doc?.addEventListener?.('click', (event) => {
      const tab = event?.target?.closest?.('[data-home-tab]');
      if (!tab) return;
      noteInteraction();
      if (String(tab.dataset?.homeTab || '') !== 'scwm') {
        global.setTimeout?.(flushFullRender, 0);
      }
    }, true);

    doc?.addEventListener?.('visibilitychange', () => {
      if (doc.hidden) {
        flushSave();
        stopHeartbeat();
      } else if (openScwmModal()) startHeartbeat();
    });

    global.addEventListener?.('pagehide', () => {
      flushSave();
      stopHeartbeat();
    }, { capture: true });
  }

  function install() {
    if (typeof global.save !== 'function' || typeof global.renderAll !== 'function') {
      if (++installAttempts < 240 && installTimer == null) {
        installTimer = global.setTimeout?.(() => {
          installTimer = null;
          install();
        }, 50);
      }
      return false;
    }

    if (!installed) {
      originals.save = global.save;
      originals.renderAll = global.renderAll;
      global.save = fastSave;
      global.renderAll = fastRenderAll;
      installPollGuard();
      installInteractionGuards();
      installed = true;
      status.installs += 1;
    }

    wrapCommits();
    wrapIndexConsumers();
    wrapModalFunctions();
    installSmartModalLock();
    return true;
  }

  global.TaskPointsScwmInteractionFastPath = {
    installed: true,
    version: VERSION,
    install,
    flush: flushSave,
    refreshScwm,
    flushPendingFullRender: flushFullRender,
    invalidateCompletionIndex: invalidateIndex,
    ensureCompletionIndex: ensureIndex,
    getStatus() {
      return {
        installed,
        version: VERSION,
        pendingSave: Boolean(pendingSave),
        pendingFullRender,
        compactEntryCount: index?.compact?.length || 0,
        counters: { ...status }
      };
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TaskPointsScwmInteractionFastPath;
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', install, { once: true });
  } else global.setTimeout?.(install, 0);
})(typeof window !== 'undefined' ? window : globalThis);
