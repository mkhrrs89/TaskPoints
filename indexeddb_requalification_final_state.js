(function installTaskPointsRequalificationFinalState(global) {
  'use strict';

  if (global.__taskPointsRequalificationFinalStateInstalled) return;
  global.__taskPointsRequalificationFinalStateInstalled = true;

  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const document = global.document;
  const storage = global.localStorage;
  let applying = false;
  let ownsUi = false;
  let observer = null;
  let rerenderQueued = false;
  let rerenderAttempts = 0;

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

  function requestCurrentStateRender() {
    if (rerenderQueued) return;
    rerenderQueued = true;
    const run = () => {
      rerenderQueued = false;
      if (isFasterModeEnabled()) {
        rerenderAttempts = 0;
        applyFinalState();
        return;
      }

      const refresh = $('refreshBtn');
      if (typeof refresh?.click === 'function' && !refresh.disabled) {
        ownsUi = false;
        rerenderAttempts = 0;
        refresh.click();
        return;
      }

      if (refresh?.disabled && rerenderAttempts < 120) {
        rerenderAttempts += 1;
        global.setTimeout?.(requestCurrentStateRender, 50);
        return;
      }

      ownsUi = false;
      rerenderAttempts = 0;
      global.location?.reload?.();
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(run);
    else global.setTimeout?.(run, 0);
  }

  function applyFinalState() {
    if (applying || !isFasterModeEnabled()) return false;
    applying = true;
    try {
      ownsUi = true;
      rerenderAttempts = 0;
      setText('overallTitle', 'Faster mode is on');
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
    disconnect: () => observer?.disconnect?.()
  };
})(typeof window !== 'undefined' ? window : globalThis);
