(function installTaskPointsRequalificationFinalState(global) {
  'use strict';

  if (global.__taskPointsRequalificationFinalStateInstalled) return;
  global.__taskPointsRequalificationFinalStateInstalled = true;

  const MODE_KEY = 'taskpoints_phase4_storage_mode_v1';
  const GATE_KEY = 'taskpoints_indexeddb_requalification_v1';
  const document = global.document;
  const storage = global.localStorage;
  let applying = false;
  let observer = null;
  let ownsUi = false;
  let previousUi = null;

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

  function captureUi() {
    if (previousUi) return;
    previousUi = {
      overallTitle: $('overallTitle')?.textContent ?? '',
      overallDetail: $('overallDetail')?.textContent ?? '',
      modeValue: $('modeValue')?.textContent ?? '',
      actionMessage: $('actionMessage')?.textContent ?? '',
      startDisabled: Boolean($('startTestBtn')?.disabled),
      startAllowed: $('startTestBtn')?.dataset?.allowed ?? 'false',
      finishDisabled: Boolean($('finishTestBtn')?.disabled),
      finishAllowed: $('finishTestBtn')?.dataset?.allowed ?? 'false'
    };
  }

  function applyFinalState() {
    if (applying || !isFasterModeEnabled()) return false;
    applying = true;
    try {
      captureUi();
      ownsUi = true;
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

  function releaseFinalState() {
    if (applying || !ownsUi || !previousUi || isFasterModeEnabled()) return false;
    applying = true;
    try {
      setText('overallTitle', previousUi.overallTitle);
      setText('overallDetail', previousUi.overallDetail);
      setText('modeValue', previousUi.modeValue);
      setText('actionMessage', previousUi.actionMessage);
      const start = $('startTestBtn');
      const finish = $('finishTestBtn');
      if (start) {
        start.disabled = previousUi.startDisabled;
        start.dataset.allowed = previousUi.startAllowed;
      }
      if (finish) {
        finish.disabled = previousUi.finishDisabled;
        finish.dataset.allowed = previousUi.finishAllowed;
      }
      ownsUi = false;
      previousUi = null;
      return true;
    } finally {
      applying = false;
    }
  }

  function syncState() {
    return isFasterModeEnabled() ? applyFinalState() : releaseFinalState();
  }

  function scheduleSync() {
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(syncState);
    else global.setTimeout?.(syncState, 0);
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
    syncState();
    if (typeof global.MutationObserver === 'function' && document?.documentElement) {
      observer = new global.MutationObserver(scheduleSync);
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
    if (!event || event.key === MODE_KEY || event.key === GATE_KEY) scheduleSync();
  });
  global.addEventListener?.('pageshow', scheduleSync);

  global.TaskPointsRequalificationFinalState = {
    isFasterModeEnabled,
    applyFinalState,
    releaseFinalState,
    syncState,
    disconnect: () => observer?.disconnect?.()
  };
})(typeof window !== 'undefined' ? window : globalThis);
