;(function installTaskPointsScwmInteractionFastPath(global) {
  'use strict';

  if (global.TaskPointsScwmInteractionFastPath?.installed) return;

  const VERSION = 1;
  const SAVE_IDLE_TIMEOUT_MS = 900;
  const ARM_WINDOW_MS = 2400;
  const CANONICAL_REFRESH_DELAY_MS = 1800;
  const DOMAIN_RENDERERS = Object.freeze({
    sleep: 'renderSleepHistory',
    calories: 'renderCaloriesHistory',
    work: 'renderWorkHistory',
    mood: 'renderMoodHistory'
  });
  const FUNCTION_DOMAINS = Object.freeze({
    saveSleepScore: 'sleep',
    submitSleepEditModal: 'sleep',
    saveCalories: 'calories',
    editTodayCalories: 'calories',
    saveWorkScore: 'work',
    submitWorkEditModal: 'work',
    saveMoodScore: 'mood',
    submitMoodEditModal: 'mood'
  });
  const SAVE_BUTTON_DOMAINS = Object.freeze({
    sleepEditSaveBtn: 'sleep',
    caloriesEditSaveBtn: 'calories',
    workEditSaveBtn: 'work',
    moodEditSaveBtn: 'mood'
  });

  const originals = {};
  const wrappedFunctions = new Set();
  const pendingDomains = new Set();
  const counters = {
    installs: 0,
    commitsObserved: 0,
    savesDeferred: 0,
    savesFlushed: 0,
    fullRendersIntercepted: 0,
    targetedRenders: 0,
    fallbacks: 0
  };

  let installed = false;
  let installAttempts = 0;
  let commitDepth = 0;
  let armedUntil = 0;
  let renderInterceptUntil = 0;
  let pendingSave = null;
  let saveTimer = null;
  let saveIdleId = null;
  let saveIdleUsesTimeout = false;
  let canonicalTimer = null;

  function now() {
    return Number(global.performance?.now?.()) || Date.now();
  }

  function isArmed() {
    return commitDepth > 0 || now() <= armedUntil;
  }

  function shouldInterceptRender() {
    return isArmed() || now() <= renderInterceptUntil;
  }

  function rememberDomain(domain) {
    if (DOMAIN_RENDERERS[domain]) pendingDomains.add(domain);
  }

  function arm(domain) {
    rememberDomain(domain);
    armedUntil = Math.max(armedUntil, now() + ARM_WINDOW_MS);
  }

  function clearSaveSchedule() {
    if (saveTimer != null) global.clearTimeout?.(saveTimer);
    saveTimer = null;
    if (saveIdleId != null) {
      if (saveIdleUsesTimeout) global.clearTimeout?.(saveIdleId);
      else global.cancelIdleCallback?.(saveIdleId);
    }
    saveIdleId = null;
    saveIdleUsesTimeout = false;
  }

  function flushDeferredSave() {
    clearSaveSchedule();
    const queued = pendingSave;
    pendingSave = null;
    if (!queued || typeof originals.save !== 'function') return false;
    try {
      originals.save.apply(queued.thisArg, queued.args);
      counters.savesFlushed += 1;
      return true;
    } catch (error) {
      counters.fallbacks += 1;
      console.warn('TaskPoints SCWM deferred save failed', error);
      return false;
    }
  }

  function queueDeferredSave() {
    clearSaveSchedule();
    const afterPaint = () => {
      saveTimer = null;
      const run = () => {
        saveIdleId = null;
        saveIdleUsesTimeout = false;
        flushDeferredSave();
      };
      if (typeof global.requestIdleCallback === 'function') {
        saveIdleUsesTimeout = false;
        saveIdleId = global.requestIdleCallback(run, { timeout: SAVE_IDLE_TIMEOUT_MS });
      } else {
        saveIdleUsesTimeout = true;
        saveIdleId = global.setTimeout(run, 0);
      }
    };
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(() => {
        global.requestAnimationFrame(afterPaint);
      });
    } else {
      saveTimer = global.setTimeout(afterPaint, 0);
    }
  }

  function targetedSave() {
    if (!isArmed()) return originals.save.apply(this, arguments);
    pendingSave = { thisArg: this, args: Array.from(arguments) };
    renderInterceptUntil = Math.max(renderInterceptUntil, now() + ARM_WINDOW_MS);
    counters.savesDeferred += 1;
    queueDeferredSave();
    return undefined;
  }

  function scheduleCanonicalRefresh() {
    if (canonicalTimer != null) global.clearTimeout?.(canonicalTimer);
    canonicalTimer = global.setTimeout(() => {
      canonicalTimer = null;
      try {
        const control = global.TaskPointsHomeTargetedRenderControl;
        if (typeof control?.scheduleCanonicalStatsRefresh === 'function') {
          control.scheduleCanonicalStatsRefresh();
        } else if (typeof global.renderStats === 'function') {
          global.renderStats();
        }
      } catch (error) {
        counters.fallbacks += 1;
        if (global.TP_DEBUG_PERF) console.warn('[TP SCWM fast path] canonical refresh failed', error);
      }
    }, CANONICAL_REFRESH_DELAY_MS);
  }

  function renderPendingDomains() {
    const domains = Array.from(pendingDomains);
    pendingDomains.clear();
    try {
      domains.forEach((domain) => {
        const renderer = global[DOMAIN_RENDERERS[domain]];
        if (typeof renderer !== 'function') throw new Error(`${DOMAIN_RENDERERS[domain]} unavailable`);
        renderer.call(global);
        counters.targetedRenders += 1;
      });
      const control = global.TaskPointsHomeTargetedRenderControl;
      if (typeof control?.refreshLiveScorePanels === 'function') {
        control.refreshLiveScorePanels({ includeYesterday: true });
      } else {
        global.renderTodayPointsSummary?.();
        global.renderTodaysMatchup?.();
        global.updateTodayBreakdown?.();
      }
      global.updateCriticalTasksIsland?.();
      scheduleCanonicalRefresh();
      return true;
    } catch (error) {
      counters.fallbacks += 1;
      if (global.TP_DEBUG_PERF) console.warn('[TP SCWM fast path] targeted render failed; using renderAll', error);
      originals.renderAll?.call(global);
      return false;
    }
  }

  function targetedScheduleRender(callback) {
    if (shouldInterceptRender() && callback === originals.renderAll) {
      counters.fullRendersIntercepted += 1;
      renderInterceptUntil = Math.max(renderInterceptUntil, now() + ARM_WINDOW_MS);
      return originals.scheduleRender.call(this, renderPendingDomains);
    }
    return originals.scheduleRender.apply(this, arguments);
  }

  function wrapCommitFunction(name, domain) {
    if (wrappedFunctions.has(name) || typeof global[name] !== 'function') return false;
    const original = global[name];
    originals[name] = original;
    global[name] = function taskPointsScwmCommitWrapper() {
      arm(domain);
      counters.commitsObserved += 1;
      commitDepth += 1;
      let result;
      try {
        result = original.apply(this, arguments);
      } catch (error) {
        commitDepth = Math.max(0, commitDepth - 1);
        throw error;
      }
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => {
          commitDepth = Math.max(0, commitDepth - 1);
        });
      }
      commitDepth = Math.max(0, commitDepth - 1);
      return result;
    };
    wrappedFunctions.add(name);
    return true;
  }

  function wrapAvailableCommitFunctions() {
    Object.entries(FUNCTION_DOMAINS).forEach(([name, domain]) => wrapCommitFunction(name, domain));
  }

  function domainFromEventTarget(target) {
    const element = target?.closest?.('[id]') || target;
    const id = String(element?.id || '');
    if (SAVE_BUTTON_DOMAINS[id]) return SAVE_BUTTON_DOMAINS[id];
    const modal = target?.closest?.('#sleepEditModal, #caloriesEditModal, #workEditModal, #moodEditModal');
    if (!modal) return '';
    if (modal.id === 'sleepEditModal') return 'sleep';
    if (modal.id === 'caloriesEditModal') return 'calories';
    if (modal.id === 'workEditModal') return 'work';
    if (modal.id === 'moodEditModal') return 'mood';
    return '';
  }

  function onPointerOrClick(event) {
    const domain = domainFromEventTarget(event?.target);
    const id = String(event?.target?.closest?.('[id]')?.id || event?.target?.id || '');
    if (domain && SAVE_BUTTON_DOMAINS[id]) arm(domain);
  }

  function onKeyDown(event) {
    if (event?.key !== 'Enter') return;
    const domain = domainFromEventTarget(event?.target);
    if (domain) arm(domain);
  }

  function install() {
    if (installed) {
      wrapAvailableCommitFunctions();
      return true;
    }
    if (
      typeof global.save !== 'function'
      || typeof global.scheduleRender !== 'function'
      || typeof global.renderAll !== 'function'
    ) {
      installAttempts += 1;
      if (installAttempts < 240) global.setTimeout?.(install, 50);
      return false;
    }

    originals.save = global.save;
    originals.scheduleRender = global.scheduleRender;
    originals.renderAll = global.renderAll;
    global.save = targetedSave;
    global.scheduleRender = targetedScheduleRender;
    wrapAvailableCommitFunctions();

    global.document?.addEventListener?.('pointerdown', onPointerOrClick, true);
    global.document?.addEventListener?.('click', onPointerOrClick, true);
    global.document?.addEventListener?.('keydown', onKeyDown, true);
    global.addEventListener?.('pagehide', flushDeferredSave, { capture: true });
    global.document?.addEventListener?.('visibilitychange', () => {
      if (global.document.hidden) flushDeferredSave();
      else wrapAvailableCommitFunctions();
    });

    installed = true;
    counters.installs += 1;
    return true;
  }

  const api = {
    installed: true,
    version: VERSION,
    install,
    flush: flushDeferredSave,
    arm,
    getStatus() {
      return {
        installed,
        version: VERSION,
        pendingDomains: Array.from(pendingDomains),
        pendingSave: Boolean(pendingSave),
        wrappedFunctions: Array.from(wrappedFunctions),
        counters: { ...counters }
      };
    }
  };

  global.TaskPointsScwmInteractionFastPath = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener?.('DOMContentLoaded', install, { once: true });
  } else {
    global.setTimeout?.(install, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
