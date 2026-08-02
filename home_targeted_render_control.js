(function installTaskPointsHomeTargetedRenderControl(global) {
  'use strict';

  if (global.TaskPointsHomeTargetedRenderControl?.version) return;

  const DISABLED_KEY = 'taskpoints_home_targeted_render_disabled_v1';
  const DEFAULT_TIMING = Object.freeze({
    liveRefreshDelayMs: 180,
    habitRestackDelayMs: 1800,
    canonicalStatsDelayMs: 6500,
    canonicalStatsIdleTimeoutMs: 12000
  });
  const timing = {
    ...DEFAULT_TIMING,
    ...(global.__TP_HOME_TARGETED_RENDER_TIMING || {})
  };

  const originals = {};
  const counters = {
    installs: 0,
    habitTapsObserved: 0,
    habitCategoryRenders: 0,
    lightweightScoreRefreshes: 0,
    canonicalStatsRefreshes: 0,
    taskRenderAllIntercepts: 0,
    fallbacks: 0
  };

  const pendingHabitCategories = new Set();
  const pendingAffectedDays = new Set();
  let installed = false;
  let habitRestackTimer = null;
  let liveRefreshTimer = null;
  let canonicalStatsTimer = null;
  let canonicalStatsIdleId = null;
  let canonicalStatsPending = false;
  let taskCompletionCallbackDepth = 0;

  function safeStorageGet(key) {
    try { return global.localStorage?.getItem?.(key) ?? null; }
    catch (_) { return null; }
  }

  function safeStorageSet(key, value) {
    try {
      global.localStorage?.setItem?.(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function safeStorageRemove(key) {
    try {
      global.localStorage?.removeItem?.(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  function disabled() {
    return global.__TP_DISABLE_HOME_TARGETED_RENDER === true
      || safeStorageGet(DISABLED_KEY) === '1';
  }

  function cancelTimer(name) {
    const id = name === 'restack'
      ? habitRestackTimer
      : name === 'live'
        ? liveRefreshTimer
        : canonicalStatsTimer;
    if (id != null) global.clearTimeout?.(id);
    if (name === 'restack') habitRestackTimer = null;
    else if (name === 'live') liveRefreshTimer = null;
    else canonicalStatsTimer = null;
  }

  function cancelCanonicalIdle() {
    if (canonicalStatsIdleId != null && typeof global.cancelIdleCallback === 'function') {
      try { global.cancelIdleCallback(canonicalStatsIdleId); } catch (_) {}
    }
    canonicalStatsIdleId = null;
  }

  function cancelPendingWork() {
    cancelTimer('restack');
    cancelTimer('live');
    cancelTimer('canonical');
    cancelCanonicalIdle();
    canonicalStatsPending = false;
    pendingHabitCategories.clear();
    pendingAffectedDays.clear();
  }

  function afterPaintAndIdle(callback, timeoutMs = 1000) {
    const afterPaint = () => {
      if (typeof global.requestIdleCallback === 'function') {
        global.requestIdleCallback(callback, { timeout: timeoutMs });
      } else {
        global.setTimeout(callback, 0);
      }
    };
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(afterPaint);
    } else {
      global.setTimeout(afterPaint, 0);
    }
  }

  function affectedYesterday() {
    if (!pendingAffectedDays.size) return false;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = typeof global.getGameDayKey === 'function'
      ? global.getGameDayKey(yesterday)
      : (typeof global.dateKey === 'function' ? global.dateKey(yesterday) : '');
    return Boolean(yesterdayKey && pendingAffectedDays.has(yesterdayKey));
  }

  function setSimpleStats(derived, dailyTotals) {
    const doc = global.document;
    if (!doc) return;
    const lifetime = doc.getElementById?.('lifetimePoints');
    if (lifetime && Number.isFinite(Number(derived?.lifetimePoints))) {
      lifetime.textContent = String(derived.lifetimePoints);
    }
    const dailyAverage = doc.getElementById?.('dailyAvg');
    if (dailyAverage) {
      const values = Object.values(dailyTotals || {}).map(Number).filter(Number.isFinite);
      dailyAverage.textContent = values.length
        ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)
        : '0.0';
    }
  }

  function refreshLiveScorePanels(options = {}) {
    try {
      if (typeof global.getDerived !== 'function') throw new Error('getDerived unavailable');
      const derived = global.getDerived();
      const dailyTotals = derived?.agg?.dailyTotals || {};
      const todayKey = typeof global.todayKey === 'function'
        ? global.todayKey()
        : (typeof global.dateKey === 'function' ? global.dateKey(new Date()) : '');
      const matchupKey = typeof global.getGameDayKey === 'function'
        ? global.getGameDayKey(new Date())
        : todayKey;
      if (!todayKey || typeof global.deriveTodayWithInertia !== 'function') {
        throw new Error('score derivation unavailable');
      }

      const today = global.deriveTodayWithInertia(dailyTotals, todayKey) || {};
      const matchup = global.deriveTodayWithInertia(dailyTotals, matchupKey) || {};
      setSimpleStats(derived, dailyTotals);

      global.renderTodayPointsSummary?.(
        Number(today.todayPoints) || 0,
        Number(today.inertia) || 0,
        Number(today.average) || 0
      );
      global.renderTodaysMatchup?.(matchupKey, Number(matchup.todayPoints) || 0);

      const todayList = derived?.byDay?.get?.(todayKey) || [];
      global.updateTodayBreakdown?.(todayList, todayKey, Number(today.inertia) || 0);
      global.renderHomeStreakBonusSidecar?.();

      if (options.includeYesterday === true || affectedYesterday()) {
        global.renderYesterdaysResult?.(dailyTotals);
      }

      counters.lightweightScoreRefreshes += 1;
      return true;
    } catch (error) {
      counters.fallbacks += 1;
      if (global.TP_DEBUG_PERF) console.warn('[TP targeted render] lightweight refresh failed', error);
      return false;
    }
  }

  function runCanonicalStatsRefresh() {
    canonicalStatsTimer = null;
    canonicalStatsIdleId = null;
    if (!canonicalStatsPending) return false;
    if (global.document?.hidden) return false;
    canonicalStatsPending = false;
    try {
      const renderer = originals.renderStats || global.renderStats;
      if (typeof renderer !== 'function') throw new Error('renderStats unavailable');
      renderer.call(global);
      counters.canonicalStatsRefreshes += 1;
      pendingAffectedDays.clear();
      return true;
    } catch (error) {
      counters.fallbacks += 1;
      if (global.TP_DEBUG_PERF) console.warn('[TP targeted render] canonical stats refresh failed', error);
      return false;
    }
  }

  function scheduleCanonicalStatsRefresh() {
    canonicalStatsPending = true;
    cancelTimer('canonical');
    cancelCanonicalIdle();
    canonicalStatsTimer = global.setTimeout(() => {
      canonicalStatsTimer = null;
      if (global.document?.hidden) return;
      if (typeof global.requestIdleCallback === 'function') {
        canonicalStatsIdleId = global.requestIdleCallback(
          runCanonicalStatsRefresh,
          { timeout: Number(timing.canonicalStatsIdleTimeoutMs) || DEFAULT_TIMING.canonicalStatsIdleTimeoutMs }
        );
      } else {
        canonicalStatsIdleId = global.setTimeout(runCanonicalStatsRefresh, 0);
      }
    }, Number(timing.canonicalStatsDelayMs) || DEFAULT_TIMING.canonicalStatsDelayMs);
  }

  function scheduleLightweightScoreRefresh(options = {}) {
    cancelTimer('live');
    liveRefreshTimer = global.setTimeout(() => {
      liveRefreshTimer = null;
      afterPaintAndIdle(() => {
        const ok = refreshLiveScorePanels(options);
        if (!ok && typeof originals.scheduleHabitStatsRefresh === 'function') {
          originals.scheduleHabitStatsRefresh.call(global);
        }
      }, 700);
    }, Number(timing.liveRefreshDelayMs) || DEFAULT_TIMING.liveRefreshDelayMs);
    scheduleCanonicalStatsRefresh();
  }

  function categoryFromBubble(bubble) {
    if (!bubble) return '';
    if (bubble.classList?.contains?.('viceDay')) return 'vice';
    const rowCategory = bubble.closest?.('.habitRow[data-habit-row-category]')?.dataset?.habitRowCategory;
    if (rowCategory === 'vice') return 'vice';
    if (rowCategory === 'habit') return 'habit';
    return bubble.getAttribute?.('data-habit') ? 'habit' : '';
  }

  function rememberHabitInteraction(bubble) {
    const category = categoryFromBubble(bubble);
    const dayKey = String(bubble?.getAttribute?.('data-day') || bubble?.dataset?.day || '').slice(0, 10);
    if (category) pendingHabitCategories.add(category);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) pendingAffectedDays.add(dayKey);
    counters.habitTapsObserved += 1;
  }

  function renderPendingHabitCategories() {
    habitRestackTimer = null;
    const categories = Array.from(pendingHabitCategories);
    pendingHabitCategories.clear();
    if (!categories.length) {
      originals.scheduleHabitFullRestackRerender?.call(global);
      return;
    }

    afterPaintAndIdle(() => {
      try {
        categories.forEach((category) => {
          if (category === 'vice') {
            if (typeof global.renderVices !== 'function') throw new Error('renderVices unavailable');
            global.renderVices();
          } else {
            if (typeof global.renderHabits !== 'function') throw new Error('renderHabits unavailable');
            global.renderHabits();
          }
          counters.habitCategoryRenders += 1;
        });
        global.renderHomeStreakBonusSidecar?.();
      } catch (error) {
        counters.fallbacks += 1;
        if (global.TP_DEBUG_PERF) console.warn('[TP targeted render] category restack failed', error);
        originals.scheduleHabitFullRestackRerender?.call(global);
      }
    }, 1200);
  }

  function targetedHabitRestackScheduler() {
    if (disabled()) return originals.scheduleHabitFullRestackRerender?.apply(this, arguments);
    if (!pendingHabitCategories.size) {
      return originals.scheduleHabitFullRestackRerender?.apply(this, arguments);
    }
    cancelTimer('restack');
    habitRestackTimer = global.setTimeout(
      renderPendingHabitCategories,
      Number(timing.habitRestackDelayMs) || DEFAULT_TIMING.habitRestackDelayMs
    );
  }

  function targetedHabitStatsScheduler() {
    if (disabled()) return originals.scheduleHabitStatsRefresh?.apply(this, arguments);
    scheduleLightweightScoreRefresh({ includeYesterday: affectedYesterday() });
  }

  function targetedScheduleRender(callback) {
    if (
      !disabled()
      && taskCompletionCallbackDepth > 0
      && callback === originals.renderAll
    ) {
      counters.taskRenderAllIntercepts += 1;
      return originals.scheduleRender.call(this, () => {
        try {
          if (typeof global.renderTasks !== 'function') throw new Error('renderTasks unavailable');
          global.renderTasks();
          global.updateCriticalTasksIsland?.();
          const ok = refreshLiveScorePanels({ includeYesterday: false });
          if (!ok) throw new Error('live score refresh failed');
          scheduleCanonicalStatsRefresh();
        } catch (error) {
          counters.fallbacks += 1;
          if (global.TP_DEBUG_PERF) console.warn('[TP targeted render] task refresh failed; using renderAll', error);
          originals.renderAll.call(global);
        }
      });
    }
    return originals.scheduleRender.apply(this, arguments);
  }

  function targetedAnimateTaskCompletion(taskId, onDone) {
    if (disabled() || typeof onDone !== 'function') {
      return originals.animateTaskCompletion.apply(this, arguments);
    }
    const wrappedDone = function wrappedTaskCompletionDone() {
      taskCompletionCallbackDepth += 1;
      try {
        return onDone.apply(this, arguments);
      } finally {
        taskCompletionCallbackDepth = Math.max(0, taskCompletionCallbackDepth - 1);
      }
    };
    return originals.animateTaskCompletion.call(this, taskId, wrappedDone);
  }

  function install() {
    if (installed) return true;
    const required = [
      'handleHabitBubbleTap',
      'scheduleHabitFullRestackRerender',
      'scheduleHabitStatsRefresh',
      'animateTaskCompletion',
      'scheduleRender',
      'renderAll',
      'renderStats'
    ];
    if (required.some((name) => typeof global[name] !== 'function')) return false;

    originals.handleHabitBubbleTap = global.handleHabitBubbleTap;
    originals.scheduleHabitFullRestackRerender = global.scheduleHabitFullRestackRerender;
    originals.scheduleHabitStatsRefresh = global.scheduleHabitStatsRefresh;
    originals.animateTaskCompletion = global.animateTaskCompletion;
    originals.scheduleRender = global.scheduleRender;
    originals.renderAll = global.renderAll;
    originals.renderStats = global.renderStats;

    global.handleHabitBubbleTap = function targetedHabitBubbleTap(bubble) {
      if (!disabled()) rememberHabitInteraction(bubble);
      return originals.handleHabitBubbleTap.apply(this, arguments);
    };
    global.scheduleHabitFullRestackRerender = targetedHabitRestackScheduler;
    global.scheduleHabitStatsRefresh = targetedHabitStatsScheduler;
    global.animateTaskCompletion = targetedAnimateTaskCompletion;
    global.scheduleRender = targetedScheduleRender;

    if (global.document?.addEventListener) {
      global.document.addEventListener('visibilitychange', () => {
        if (!global.document.hidden && canonicalStatsPending && canonicalStatsTimer == null && canonicalStatsIdleId == null) {
          scheduleCanonicalStatsRefresh();
        }
      });
    }

    installed = true;
    counters.installs += 1;
    return true;
  }

  function disable() {
    global.__TP_DISABLE_HOME_TARGETED_RENDER = true;
    safeStorageSet(DISABLED_KEY, '1');
    cancelPendingWork();
    try { originals.scheduleHabitFullRestackRerender?.call(global); } catch (_) {}
    try { originals.scheduleHabitStatsRefresh?.call(global); } catch (_) {}
    return getStatus();
  }

  function enable() {
    global.__TP_DISABLE_HOME_TARGETED_RENDER = false;
    safeStorageRemove(DISABLED_KEY);
    return getStatus();
  }

  function reconcileNow() {
    cancelTimer('live');
    cancelTimer('canonical');
    cancelCanonicalIdle();
    canonicalStatsPending = true;
    return runCanonicalStatsRefresh();
  }

  function getStatus() {
    return {
      version: 1,
      installed,
      enabled: !disabled(),
      disabledKey: DISABLED_KEY,
      pendingHabitCategories: Array.from(pendingHabitCategories),
      pendingAffectedDays: Array.from(pendingAffectedDays),
      canonicalStatsPending,
      timing: { ...timing },
      counters: { ...counters }
    };
  }

  const api = {
    version: 1,
    DISABLED_KEY,
    install,
    enable,
    disable,
    reconcileNow,
    refreshLiveScorePanels,
    scheduleCanonicalStatsRefresh,
    getStatus
  };

  global.TaskPointsHomeTargetedRenderControl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
      global.setTimeout(install, 0);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
