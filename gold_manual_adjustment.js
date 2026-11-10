;(function installTaskPointsManualGoldAdjustment(global) {
  'use strict';

  const STORAGE_KEY = 'taskpoints_v1';
  const RECOVERY_HOLD_KEY = 'taskpoints_emergency_recovery_hold_v1';
  const MAX_GOLD_ENTRY = 1000000;
  const MAX_NOTE_LENGTH = 200;
  const MODES = new Set(['add', 'subtract', 'set']);
  let saving = false;

  function roundGold(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  }

  function toTenths(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10);
  }

  function parseGoldAmount(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!/^\d+(?:\.\d)?$/.test(raw)) {
      throw new Error('Enter a nonnegative Gold amount with at most one decimal place.');
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount > MAX_GOLD_ENTRY) {
      throw new Error('Enter an amount between 0.0 and 1,000,000.0 Gold.');
    }
    return toTenths(amount);
  }

  function playerExists(state, id) {
    if (id === 'YOU') return true;
    return Array.isArray(state?.players) && state.players.some(player => {
      return String(player?.id || player?.playerId || '') === id;
    });
  }

  function currentBalanceTenths(state, playerId) {
    let total = 0;
    let running = 0;
    for (const row of state.goldLedger) {
      if (String(row?.playerId || '') !== playerId) continue;
      const amount = Number(row.amount);
      if (!Number.isFinite(amount) || Math.abs(toTenths(amount) / 10 - amount) > 0.001) {
        throw new Error('This player has an invalid historical Gold transaction. Review Gold integrity before editing.');
      }
      const delta = toTenths(amount);
      running += delta;
      if (running < 0) {
        throw new Error('This player has a negative historical Gold balance. Review Gold integrity before editing.');
      }
      if (row.balanceAfter != null && row.balanceAfter !== ''
        && (!Number.isFinite(Number(row.balanceAfter)) || Math.abs(Number(row.balanceAfter) * 10 - running) > 1.01)) {
        throw new Error('This player has inconsistent Gold history. Review Gold integrity before editing.');
      }
      total += delta;
    }
    return total;
  }

  function plan(state, request) {
    if (!state || Number(state.goldEconomy?.version) !== 1 || !Array.isArray(state.goldLedger)) {
      throw new Error('Gold Ledger is not fully initialized. No changes were made.');
    }
    const playerId = String(request?.playerId || '').trim();
    const mode = String(request?.mode || '').trim();
    if (!playerId || !playerExists(state, playerId)) {
      throw new Error('Choose a valid player before adjusting Gold.');
    }
    if (!MODES.has(mode)) {
      throw new Error('Choose Add, Subtract, or Set balance.');
    }
    const amountTenths = parseGoldAmount(request?.amount);
    if (mode !== 'set' && amountTenths <= 0) {
      throw new Error('Enter an amount greater than zero to add or subtract Gold.');
    }
    const note = String(request?.note == null ? '' : request.note).trim();
    if (note.length > MAX_NOTE_LENGTH) {
      throw new Error('The optional note must be 200 characters or fewer.');
    }
    const beforeTenths = currentBalanceTenths(state, playerId);
    const deltaTenths = mode === 'add' ? amountTenths
      : mode === 'subtract' ? -amountTenths
      : amountTenths - beforeTenths;
    const afterTenths = beforeTenths + deltaTenths;
    if (afterTenths < 0) throw new Error('A Gold balance cannot go below zero.');
    if (afterTenths > MAX_GOLD_ENTRY * 10) {
      throw new Error('The resulting Gold balance cannot exceed 1,000,000.0.');
    }
    if (!deltaTenths) throw new Error('The player already has that exact Gold balance.');
    return {
      playerId, mode, note,
      requested: amountTenths / 10,
      before: beforeTenths / 10,
      delta: deltaTenths / 10,
      after: afterTenths / 10
    };
  }

  function recoveryHoldActive(storage) {
    const raw = storage.getItem(RECOVERY_HOLD_KEY);
    if (!raw) return false;
    try {
      const value = JSON.parse(raw);
      return value?.active === true;
    } catch (_) {
      // Malformed recovery locks are not safe to override through this feature.
      return true;
    }
  }

  function requireCore() {
    const core = global.TaskPointsCore;
    if (!core || typeof core.loadAppState !== 'function'
      || typeof core.saveValidatedSnapshot !== 'function'
      || typeof core.parseTaskPointsStorageJson !== 'function') {
      throw new Error('The protected TaskPoints storage system is not available. No Gold was changed.');
    }
    return core;
  }

  function readLatest() {
    const core = requireCore();
    const storage = global.localStorage;
    if (!storage) throw new Error('This browser cannot access saved TaskPoints data.');
    if (recoveryHoldActive(storage)) {
      throw new Error('Emergency Recovery is active. Gold adjustments are disabled to protect saved data.');
    }
    if (!storage.getItem(STORAGE_KEY)) {
      throw new Error('No authoritative saved TaskPoints data was found. Nothing was changed.');
    }
    const loaded = core.loadAppState({ syncDerived: false, persistSync: false });
    const state = loaded?.state || loaded;
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || !state || typeof state !== 'object') {
      throw new Error('Saved TaskPoints data could not be read. Nothing was changed.');
    }
    return { core, storage, state, raw };
  }

  function preview(request) {
    const latest = readLatest();
    return { ...plan(latest.state, request), raw: latest.raw };
  }

  function makeId(state) {
    const ids = new Set(state.goldLedger.map(row => String(row?.id || '')));
    for (let attempt = 0; attempt < 5; attempt++) {
      const unique = typeof global.crypto?.randomUUID === 'function'
        ? global.crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + attempt;
      const id = 'gold:manual:' + unique;
      if (!ids.has(id)) return id;
    }
    throw new Error('Could not generate a unique transaction ID.');
  }

  function localDateKey(now) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function buildEntry(state, prepared, now = new Date()) {
    const id = makeId(state);
    return {
      id,
      type: 'manual_adjustment',
      playerId: prepared.playerId,
      opponentId: '',
      matchupId: '',
      seasonId: '',
      dateKey: localDateKey(now),
      createdAtISO: now.toISOString(),
      amount: prepared.delta,
      balanceAfter: prepared.after,
      meta: {
        mode: prepared.mode,
        requestedAmount: prepared.requested,
        balanceBefore: prepared.before,
        note: prepared.note,
        source: 'gold_ledger_manual_adjustment'
      }
    };
  }

  function commit(request, confirmed) {
    if (saving) throw new Error('A Gold adjustment is already being saved.');
    saving = true;
    try {
      const latest = readLatest();
      if (!confirmed || typeof confirmed.raw !== 'string' || confirmed.raw !== latest.raw) {
        throw new Error('Saved data changed since the confirmation. Review the new balance and try again.');
      }
      const prepared = plan(latest.state, request);
      if (prepared.playerId !== confirmed.playerId || prepared.mode !== confirmed.mode
        || prepared.requested !== confirmed.requested
        || prepared.before !== confirmed.before || prepared.after !== confirmed.after
        || prepared.note !== confirmed.note) {
        throw new Error('The adjustment changed since confirmation. Review it and try again.');
      }
      if (latest.storage.getItem(STORAGE_KEY) !== latest.raw) {
        throw new Error('Saved data changed while preparing the adjustment. Review and try again.');
      }

      const beforeIds = new Set(latest.state.goldLedger.map(row => String(row?.id || '')));
      const transaction = buildEntry(latest.state, prepared);
      // Clone only the ledger array, not the whole app state, before a protected
      // save. Do not mutate the loaded state on a failed persistence attempt.
      const candidate = {
        ...latest.state,
        goldLedger: [...latest.state.goldLedger, transaction]
      };

      const result = latest.core.saveValidatedSnapshot(candidate, {
        storageKey: STORAGE_KEY,
        immediateWrite: true,
        savePath: 'gold-manual-adjustment',
        source: 'gold-manual-adjustment'
      });
      if (!result || result.blocked || result.skipped || result.blockedByQuotaCircuit
        || result.ok === false) {
        throw new Error('The protected save was declined. No successful Gold adjustment was confirmed.');
      }

      // Verify the exact entry and historical IDs from the actual stored bytes,
      // not just the object returned by the save API.
      const writtenRaw = latest.storage.getItem(STORAGE_KEY);
      if (!writtenRaw) throw new Error('Gold save could not be verified. Check the ledger before retrying.');
      const written = latest.core.parseTaskPointsStorageJson(writtenRaw, null);
      if (!written || !Array.isArray(written.goldLedger)) {
        throw new Error('Gold save could not be verified. Check the ledger before retrying.');
      }
      const row = written.goldLedger.find(item => item?.id === transaction.id);
      const after = planBalance(written, prepared.playerId);
      const savedIds = new Set(written.goldLedger.map(item => String(item?.id || '')));
      const intact = [...beforeIds].every(id => savedIds.has(id));
      if (!row || Number(row.amount) !== transaction.amount
        || Number(row.balanceAfter) !== transaction.balanceAfter
        || after !== prepared.after || !intact) {
        throw new Error('Gold adjustment was not fully verified. Inspect the ledger before retrying; do not submit twice.');
      }
      return { transaction, balance: prepared.after, state: written };
    } finally {
      saving = false;
    }
  }

  function planBalance(state, playerId) {
    return roundGold(state.goldLedger.reduce((sum, row) =>
      String(row?.playerId || '') === playerId ? sum + (Number(row.amount) || 0) : sum, 0));
  }

  const api = { plan, preview, commit, buildEntry, parseGoldAmount, readLatest };
  global.TaskPointsManualGoldAdjustment = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  function installForm() {
    const form = global.document?.getElementById?.('goldManualForm');
    if (!form || form.dataset.installed === '1') return;
    form.dataset.installed = '1';
    const select = global.document.getElementById('goldManualPlayer');
    const modeInput = global.document.getElementById('goldManualMode');
    const amountInput = global.document.getElementById('goldManualAmount');
    const noteInput = global.document.getElementById('goldManualNote');
    const previewEl = global.document.getElementById('goldManualPreview');
    const status = global.document.getElementById('goldManualStatus');
    const button = global.document.getElementById('goldManualSubmit');

    function nameFor(state, id) {
      if (id === 'YOU') return String(state.youName || 'You');
      const player = state.players?.find(item => String(item?.id || item?.playerId || '') === id);
      return String(player?.name || id);
    }
    function fmt(n) { return Number(n).toFixed(1); }
    function values() {
      return {
        playerId: select.value, mode: modeInput.value,
        amount: amountInput.value, note: noteInput.value
      };
    }
    function message(text, isError = false) {
      status.textContent = text;
      status.classList.toggle('gold-manual-error', isError);
    }
    function refreshPreview() {
      try {
        if (!select.value || !amountInput.value.trim()) {
          previewEl.textContent = 'Select a player and enter an amount to preview the change.';
          return;
        }
        const next = preview(values());
        previewEl.textContent = fmt(next.before) + ' Gold → ' + fmt(next.after)
          + ' Gold (' + (next.delta > 0 ? '+' : '') + fmt(next.delta) + ')';
      } catch (error) {
        previewEl.textContent = error?.message || String(error);
      }
    }
    try {
      const current = readLatest();
      const ids = new Set(['YOU']);
      (Array.isArray(current.state.players) ? current.state.players : []).forEach(player => {
        const id = String(player?.id || player?.playerId || '').trim();
        if (id) ids.add(id);
      });
      [...ids].map(id => ({ id, name: nameFor(current.state, id) }))
        .sort((a, b) => a.id === 'YOU' ? -1 : b.id === 'YOU' ? 1 : a.name.localeCompare(b.name))
        .forEach(item => {
          const option = global.document.createElement('option');
          option.value = item.id;
          option.textContent = item.name;
          select.appendChild(option);
        });
      button.disabled = false;
    } catch (error) {
      message(error?.message || 'Gold adjustments are unavailable until saved data can be read.', true);
      button.disabled = true;
    }

    for (const input of [select, modeInput, amountInput, noteInput]) {
      input.addEventListener('change', refreshPreview);
      input.addEventListener('input', refreshPreview);
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (saving || button.disabled) return;
      button.disabled = true;
      let confirmed = null;
      try {
        const request = values();
        confirmed = preview(request);
        const name = nameFor(readLatest().state, confirmed.playerId);
        const details = name + '\nCurrent balance: ' + fmt(confirmed.before)
          + ' Gold\nChange: ' + (confirmed.delta > 0 ? '+' : '') + fmt(confirmed.delta)
          + ' Gold\nNew balance: ' + fmt(confirmed.after) + ' Gold\n\n'
          + 'Save this permanent manual Gold transaction?';
        if (!global.confirm(details)) return;
        const outcome = commit(request, confirmed);
        message('Saved: ' + name + ' now has ' + fmt(outcome.balance) + ' Gold.');
        amountInput.value = '';
        noteInput.value = '';
        previewEl.textContent = 'Adjustment saved to the permanent Gold Ledger.';
        global.dispatchEvent?.(new CustomEvent('taskpoints:gold-manual-adjusted', {
          detail: { state: outcome.state }
        }));
      } catch (error) {
        message(error?.message || 'Unable to save Gold adjustment.', true);
        refreshPreview();
      } finally {
        button.disabled = false;
      }
    });
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', installForm, { once: true });
  } else {
    installForm();
  }
})(typeof window !== 'undefined' ? window : globalThis);
