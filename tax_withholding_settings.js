;(function installTaskPointsTaxWithholdingSettings(global) {
  'use strict';
  if (global.TaskPointsTaxWithholdingSettings?.installed) return;

  // Null means "not entered"; zero is a valid percentage.
  function parsePercent(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { valid: true, percent: null };
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) {
      return { valid: false, percent: null };
    }
    const percent = Number(text);
    const hundredths = Math.round(percent * 100);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100
      || !Number.isSafeInteger(hundredths)) {
      return { valid: false, percent: null };
    }
    return { valid: true, percent: hundredths / 100 };
  }

  function savedPercent(state) {
    const raw = state?.takeHomeTaxPercent;
    if (raw === null || raw === undefined || raw === '') return null;
    const parsed = parsePercent(raw);
    return parsed.valid ? parsed.percent : null;
  }

  function readVerifiedState(core) {
    if (typeof core?.loadAppState !== 'function') throw Error('TaskPoints loader unavailable.');
    const loaded = core.loadAppState({
      syncDerived: false, persistSync: false,
      persistConfirmedHistoricalRepairs: false
    });
    const state = loaded?.state || loaded;
    if (!state || !Array.isArray(state.tasks)
      || !Array.isArray(state.completions) || !Array.isArray(state.habits)) {
      throw Error('Existing TaskPoints data could not be verified.');
    }
    return state;
  }

  function status(doc, message, isError = false) {
    const element = doc.getElementById('takeHomeTaxPercentStatus');
    if (!element) return;
    element.textContent = message;
    element.style.color = isError ? '#fda4af' : '';
  }

  function init() {
    const doc = global.document;
    const input = doc?.getElementById?.('takeHomeTaxPercentInput');
    const form = doc?.getElementById?.('takeHomeTaxPercentForm');
    if (!input || !form || form.dataset.taxWithholdingBound === '1') return false;
    form.dataset.taxWithholdingBound = '1';
    try {
      const percent = savedPercent(readVerifiedState(global.TaskPointsCore));
      input.value = percent === null ? '' : percent.toFixed(2);
    } catch (error) {
      status(doc, 'Unable to load saved tax withholding. No data was changed.', true);
      console.warn('Tax withholding load failed.', error);
    }

    input.addEventListener('input', () => status(doc, ''));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const parsed = parsePercent(input.value);
      if (!parsed.valid) {
        status(doc, 'Enter a percentage between 0 and 100 with no more than two decimals.', true);
        return;
      }
      try {
        const core = global.TaskPointsCore;
        if (typeof core?.saveAppState !== 'function'
          || typeof core?.readTaskPointsStoredState !== 'function') {
          throw Error('TaskPoints storage unavailable.');
        }
        readVerifiedState(core);
        const storageKey = core.STORAGE_KEY || 'taskpoints_v1';
        // A scalar patch: leave hourlyWage, scores, tasks, and all other data unchanged.
        const result = core.saveAppState({ takeHomeTaxPercent: parsed.percent }, {
          storageKey, immediateWrite: true, userInitiated: true,
          savePath: 'settings-take-home-tax-percent'
        });
        if (!result?.state || result?.skipped || result?.blocked || result?.blockedByQuotaCircuit) {
          throw Error('Tax withholding save was not committed.');
        }
        const persisted = core.readTaskPointsStoredState(storageKey, null);
        if (!persisted || typeof persisted !== 'object'
          || savedPercent(persisted) !== parsed.percent) {
          throw Error('Tax withholding save could not be verified.');
        }
        input.value = parsed.percent === null ? '' : parsed.percent.toFixed(2);
        status(doc, parsed.percent === null
          ? 'Tax withholding cleared.'
          : 'Tax withholding saved: ' + parsed.percent.toFixed(2) + '%.');
      } catch (error) {
        console.warn('Tax withholding save could not be verified.', error);
        status(doc, 'Could not verify the tax withholding save. Please try again.', true);
      }
    });
    return true;
  }

  const api = { installed: true, parsePercent, savedPercent, init };
  global.TaskPointsTaxWithholdingSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', init, { once: true });
  } else if (global.document) {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
