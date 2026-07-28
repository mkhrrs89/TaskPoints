(function installTaskPointsRequalificationFinalState(global) {
  'use strict';

  if (global.__taskPointsRequalificationFinalStateInstalled) return;
  global.__taskPointsRequalificationFinalStateInstalled = true;

  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const FINAL_TITLE = 'Faster mode is on';
  const RELEASE_RETRY_MS = 1000;
  const MAX_RELEASE_ATTEMPTS = 3;
  const document = global.document;
  const storage = global.localStorage;
  let applying = false;
  let ownsUi = false;
  let observer = null;
  let rerenderQueued = false;
  let releaseInFlight = false;
  let releaseAttempts = 0;
  let releaseTimer = null;
  let reloadRequested = false;

  const get = (key) => {
    try { return storage?.getItem?.(key) ?? null; }
    catch (_) { return null; }
  };
  const parseJson = (raw, fallback = null) => {
    try { return JSON.parse(raw); }
    catch (_) { return fallback; }
  };
  const $ = (id) => document?.getElementById?.(id) || null;

  function isFasterModeEnabled() {
    const mode = get(MODE_KEY) || 'off';
    const gate = parseJson(get(GATE_KEY), {}) || {};
    return mode === 'indexeddb_primary' && gate.status === 'fast_mode_enabled';
  }

  function setText(id, value) {
    const element = $(id);
    if (element && element.textContent !== value) element.textContent = value;
  }

  function disableAction(id) {
    const button = $(id);
    if (!button) return;
    if (!button.disabled) button.disabled = true;
    if (button.dataset.allowed !== 'false') button.dataset.allowed = 'false';
  }

  function clearReleaseTimer() {
    if (releaseTimer == null) return;
    global.clearTimeout?.(releaseTimer);
    releaseTimer = null;
  }

  function cancelRelease() {
    clearReleaseTimer();
    releaseInFlight = false;
    releaseAttempts = 0;
    reloadRequested = false;
  }

  function finalUiIsVisible() {
    return $('overallTitle')?.textContent === FINAL_TITLE;
  }

  function completeReleaseIfRendered() {
    if (!ownsUi) return true;
    if (finalUiIsVisible()) return false;
    ownsUi = false;
    cancelRelease();
    return true;
  }

  function requestReload() {
    if (reloadRequested) return;
    reloadRequested = true;
    global.location?.reload?.();
  }

  function scheduleReleaseCheck() {
    clearReleaseTimer();
    releaseTimer = global.setTimeout?.(() => {
      releaseTimer = null;
      if (isFasterModeEnabled()) {
        cancelRelease();
        applyFinalState();
        return;
      }
      if (completeReleaseIfRendered()) return;
      releaseInFlight = false;
      if (releaseAttempts >= MAX_RELEASE_ATTEMPTS) {
        requestReload();
        return;
      }
      requestCurrentStateRender();
    }, RELEASE_RETRY_MS) ?? null;
  }

  function requestCurrentStateRender() {
    if (!ownsUi || isFasterModeEnabled() || rerenderQueued || releaseInFlight || reloadRequested) return;
    rerenderQueued = true;
    const run = () => {
      rerenderQueued = false;
      if (isFasterModeEnabled()) {
        cancelRelease();
        applyFinalState();
        return;
      }
      if (completeReleaseIfRendered()) return;

      const refresh = $('refreshBtn');
      if (refresh?.disabled) {
        scheduleReleaseCheck();
        return;
      }
      if (typeof refresh?.click !== 'function') {
        requestReload();
        return;
      }

      releaseAttempts += 1;
      releaseInFlight = true;
      refresh.click();
      if (completeReleaseIfRendered()) return;
      scheduleReleaseCheck();
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(run);
    else global.setTimeout?.(run, 0);
  }

  function applyFinalState() {
    if (applying || !isFasterModeEnabled()) return false;
    applying = true;
    try {
      cancelRelease();
      ownsUi = true;
      setText('overallTitle', FINAL_TITLE);
      setText('overallDetail', 'TaskPoints is using the faster database copy, while the working copy and backups remain in place.');
      setText('modeValue', 'Faster mode');
      setText('actionMessage', 'The short test is complete. No further setup action is needed.');
      disableAction('startTestBtn');
      disableAction('finishTestBtn');
      return true;
    } finally {
      applying = false;
    }
  }

  function reconcileState() {
    if (isFasterModeEnabled()) return applyFinalState();
    if (!ownsUi) return false;
    if (completeReleaseIfRendered()) return false;
    requestCurrentStateRender();
    return false;
  }

  function scheduleReconcile() {
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(reconcileState);
    else global.setTimeout?.(reconcileState, 0);
  }

  document?.addEventListener?.('click', (event) => {
    const target = event?.target?.closest?.('#startTestBtn, #finishTestBtn')
      || (['startTestBtn', 'finishTestBtn'].includes(event?.target?.id) ? event.target : null);
    if (!target || !isFasterModeEnabled()) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    applyFinalState();
  }, true);

  function startWatching() {
    reconcileState();
    if (typeof global.MutationObserver === 'function' && document?.documentElement) {
      observer = new global.MutationObserver(scheduleReconcile);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'data-allowed']
      });
    }
  }

  if (document?.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWatching, { once: true });
  else startWatching();

  global.addEventListener?.('storage', (event) => {
    if (!event || event.key === MODE_KEY || event.key === GATE_KEY) scheduleReconcile();
  });
  global.addEventListener?.('pageshow', scheduleReconcile);

  global.TaskPointsRequalificationFinalState = {
    isFasterModeEnabled,
    applyFinalState,
    reconcileState,
    ownsUi: () => ownsUi,
    releaseInFlight: () => releaseInFlight,
    disconnect: () => {
      observer?.disconnect?.();
      clearReleaseTimer();
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
