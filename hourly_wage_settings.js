;(function installTaskPointsHourlyWageSettings(global) {
  'use strict';
  if (global.TaskPointsHourlyWageSettings?.installed) return;

  function parseAmount(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { valid: true, amount: null };
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return { valid: false, amount: null };
    const number = Number(text), cents = Math.round(number * 100);
    return Number.isFinite(number) && number >= 0 && Number.isSafeInteger(cents)
      ? { valid: true, amount: cents / 100 }
      : { valid: false, amount: null };
  }

  function savedAmount(state) {
    const raw = state?.hourlyWage;
    if (raw == null || raw === '') return null;
    const value = Number(raw), cents = Math.round(value * 100);
    return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(cents)
      ? cents / 100 : null;
  }

  function setStatus(doc, message, isError = false) {
    const status = doc.getElementById('hourlyWageStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#fda4af' : '';
  }

  function loadState(core) {
    if (typeof core?.loadAppState !== 'function') throw Error('TaskPoints loader unavailable.');
    const loaded = core.loadAppState({
      syncDerived: false, persistSync: false, persistConfirmedHistoricalRepairs: false
    });
    const state = loaded?.state || loaded;
    if (!state || !Array.isArray(state.tasks) || !Array.isArray(state.completions)
      || !Array.isArray(state.habits)) throw Error('TaskPoints snapshot unreadable.');
    return state;
  }

  function init() {
    const doc = global.document;
    const input = doc?.getElementById?.('hourlyWageInput');
    const form = doc?.getElementById?.('hourlyWageForm');
    if (!input || !form || form.dataset.hourlyWageBound === '1') return false;
    form.dataset.hourlyWageBound = '1';
    try {
      const wage = savedAmount(loadState(global.TaskPointsCore));
      input.value = wage === null ? '' : wage.toFixed(2);
    } catch (error) {
      setStatus(doc, 'Unable to load the hourly wage. Existing data was not changed.', true);
      console.warn('Hourly wage load failed.', error);
    }

    input.addEventListener('input', () => setStatus(doc, ''));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const parsed = parseAmount(input.value);
      if (!parsed.valid) {
        setStatus(doc, 'Enter a nonnegative amount with up to two decimal places.', true);
        return;
      }
      try {
        const core = global.TaskPointsCore;
        if (typeof core?.saveAppState !== 'function'
          || typeof core?.readTaskPointsStoredState !== 'function') {
          throw Error('TaskPoints save helper unavailable.');
        }
        loadState(core);
        const storageKey = core.STORAGE_KEY || 'taskpoints_v1';
        // Merge only the wage field; do not replace other saved domains.
        const result = core.saveAppState({ hourlyWage: parsed.amount }, {
          storageKey, immediateWrite: true, userInitiated: true,
          savePath: 'settings-hourly-wage'
        });
        if (!result?.state || result?.skipped || result?.blocked || result?.blockedByQuotaCircuit) {
          throw Error('Save was not committed.');
        }
        const persisted = core.readTaskPointsStoredState(storageKey, null);
        if (!persisted || typeof persisted !== 'object'
          || savedAmount(persisted) !== parsed.amount) throw Error('Save read-back mismatch.');

        input.value = parsed.amount === null ? '' : parsed.amount.toFixed(2);
        setStatus(doc, parsed.amount === null
          ? 'Hourly wage cleared.'
          : 'Hourly wage saved: $' + parsed.amount.toFixed(2) + ' per hour.');
      } catch (error) {
        console.warn('Hourly wage save not verified.', error);
        setStatus(doc, 'Could not verify the hourly wage save. Please try again.', true);
      }
    });
    return true;
  }

  const api = { installed: true, parseAmount, savedAmount, init };
  global.TaskPointsHourlyWageSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', init, { once: true });
  } else if (global.document) init();
})(typeof window !== 'undefined' ? window : globalThis);
