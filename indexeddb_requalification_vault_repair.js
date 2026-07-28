(function installTaskPointsVaultMetadataRepair(global) {
  'use strict';

  const api = global.TaskPointsStorageHealth;
  const document = global.document;
  if (!api || !document || global.__taskPointsVaultMetadataRepairInstalled) return;
  global.__taskPointsVaultMetadataRepairInstalled = true;

  const VAULT_DB = 'taskpoints_safety_vault_v1';
  const VAULT_STORE = 'snapshots';
  const VAULT_ID = 'latest';
  const VAULT_COUNT_KEYS = [
    'tasks', 'completions', 'habits', 'players', 'flexActions',
    'gameHistory', 'matchups', 'schedule', 'seasonHistory', 'reminders',
    'total', 'majorTotal'
  ];

  const $ = (id) => document.getElementById(id);

  function countsMatch(left, right) {
    return VAULT_COUNT_KEYS.every((key) => Number(left?.[key] || 0) === Number(right?.[key] || 0));
  }

  function vaultCountsFor(state) {
    const all = api.countsFor(state);
    return Object.fromEntries(VAULT_COUNT_KEYS.map((key) => [key, Number(all?.[key] || 0)]));
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Emergency backup request failed.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('Emergency backup update was interrupted.'));
      transaction.onerror = () => undefined;
    });
  }

  async function openExistingVault() {
    if (!global.indexedDB) return null;
    if (typeof global.indexedDB.databases === 'function') {
      try {
        const databases = await global.indexedDB.databases();
        if (!databases.some((entry) => entry?.name === VAULT_DB)) return null;
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(VAULT_DB);
      let upgradeAttempted = false;
      request.onupgradeneeded = () => {
        upgradeAttempted = true;
        try { request.transaction?.abort(); } catch (_) {}
      };
      request.onsuccess = () => {
        if (upgradeAttempted) {
          try { request.result?.close?.(); } catch (_) {}
          resolve(null);
        } else resolve(request.result);
      };
      request.onerror = () => {
        if (upgradeAttempted || request.error?.name === 'AbortError') resolve(null);
        else reject(request.error || new Error('The emergency backup vault could not be opened.'));
      };
      request.onblocked = () => reject(new Error('Close every other TaskPoints window, then try again.'));
    });
  }

  function inspectRecord(record) {
    if (!record?.raw) return { repairable: false, reason: 'missing' };
    const calculatedHash = api.rawHash(record.raw);
    if (!record.rawHash || record.rawHash !== calculatedHash) {
      return { repairable: false, reason: 'fingerprint' };
    }
    let parsed;
    try { parsed = api.parseStoredRaw(record.raw); }
    catch (_) { return { repairable: false, reason: 'unreadable' }; }
    const counts = vaultCountsFor(parsed.state);
    if (counts.majorTotal < 30) return { repairable: false, reason: 'too-small' };
    return {
      repairable: !record.counts || !countsMatch(counts, record.counts),
      reason: countsMatch(counts, record.counts) ? 'already-valid' : 'count-metadata',
      rawHash: calculatedHash,
      counts
    };
  }

  async function readLatest() {
    const db = await openExistingVault();
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains(VAULT_STORE)) return null;
      const transaction = db.transaction(VAULT_STORE, 'readonly');
      const done = transactionDone(transaction);
      const record = await requestResult(transaction.objectStore(VAULT_STORE).get(VAULT_ID));
      await done;
      return record || null;
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  async function refreshRepairButton() {
    const button = $('repairVaultCountsBtn');
    if (!button) return;
    button.classList.add('hidden');
    button.disabled = true;
    try {
      const result = inspectRecord(await readLatest());
      if (result.repairable && result.reason === 'count-metadata') {
        button.classList.remove('hidden');
        button.disabled = false;
      }
    } catch (_) {}
  }

  async function repairLatestCounts() {
    const db = await openExistingVault();
    if (!db) throw new Error('The emergency backup vault is unavailable.');
    let repairError = null;
    let repaired = false;
    try {
      if (!db.objectStoreNames.contains(VAULT_STORE)) throw new Error('The emergency backup snapshot store is missing.');
      const transaction = db.transaction(VAULT_STORE, 'readwrite');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(VAULT_STORE);
      const request = store.get(VAULT_ID);
      request.onsuccess = () => {
        try {
          const record = request.result;
          const result = inspectRecord(record);
          if (!result.repairable || result.reason !== 'count-metadata') {
            if (result.reason === 'already-valid') return;
            throw new Error('The emergency backup is not eligible for metadata-only repair.');
          }
          store.put({
            ...record,
            counts: result.counts,
            metadataRepairedAtISO: new Date().toISOString(),
            metadataRepairReason: 'verified-raw-count-recalculation'
          });
          repaired = true;
        } catch (error) {
          repairError = error;
          try { transaction.abort(); } catch (_) {}
        }
      };
      request.onerror = () => {
        repairError = request.error || new Error('The emergency backup could not be read for repair.');
        try { transaction.abort(); } catch (_) {}
      };
      await done;
      if (repairError) throw repairError;
      return repaired;
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    refreshRepairButton();
    $('repairVaultCountsBtn')?.addEventListener('click', async () => {
      const button = $('repairVaultCountsBtn');
      const message = $('actionMessage');
      if (button) button.disabled = true;
      if (message) message.textContent = 'Verifying the emergency backup and repairing only its stored record totals…';
      try {
        const repaired = await repairLatestCounts();
        if (message) message.textContent = repaired
          ? 'Emergency backup count metadata repaired. Running the read-only checks again…'
          : 'The emergency backup metadata was already valid. Running the checks again…';
        button?.classList.add('hidden');
        global.setTimeout?.(() => $('refreshBtn')?.click(), 0);
      } catch (error) {
        if (message) message.textContent = `Nothing was changed: ${String(error?.message || error)}`;
        await refreshRepairButton();
      }
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);
