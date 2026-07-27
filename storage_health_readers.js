(function installTaskPointsStorageHealthReaders(global) {
  'use strict';
  const api = global.TaskPointsStorageHealth || {};
  const { safeJson, countsFor } = api;
  const VAULT_DB_NAME = 'taskpoints_safety_vault_v1';
  const VAULT_STORE = 'snapshots';
  const VAULT_SLOT_IDS = ['latest','prev1','prev2','prev3'];
  const IMAGE_DB_NAME = 'taskpoints';
  const IMAGE_STORE_NAME = 'images';
  const BACKUP_KEYS = ['taskpoints_backup_latest','taskpoints_backup_prev1','taskpoints_backup_prev2','taskpoints_backup_prev3'];
  function formatBytes(bytes) {
    const safe = Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? Number(bytes) : 0;
    if (safe < 1024) return `${safe.toLocaleString()} B`;
    if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(2)} KiB`;
    if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(2)} MiB`;
    return `${(safe / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  function formatTimestamp(value) {
    if (!value) return 'No timestamp';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
      transaction.onerror = () => undefined;
    });
  }

  async function openExistingDatabase(name) {
    if (!window.indexedDB) return null;
    if (typeof indexedDB.databases === 'function') {
      try {
        const databases = await indexedDB.databases();
        if (!databases.some((entry) => entry?.name === name)) return null;
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      let created = false;
      request.onupgradeneeded = () => { created = true; try { request.transaction?.abort(); } catch (_) {} };
      request.onsuccess = () => { if (created) { request.result?.close?.(); resolve(null); } else resolve(request.result); };
      request.onerror = () => created || request.error?.name === 'AbortError' ? resolve(null) : reject(request.error || new Error(`Could not open ${name}.`));
      request.onblocked = () => reject(new Error(`${name} is blocked by another TaskPoints tab.`));
    });
  }

  async function readSafetyVault() {
    const db = await openExistingDatabase(VAULT_DB_NAME);
    if (!db) return { available: false, slots: [], error: '' };
    try {
      if (!db.objectStoreNames.contains(VAULT_STORE)) return { available: false, slots: [], error: 'Snapshot store is missing.' };
      const transaction = db.transaction(VAULT_STORE, 'readonly');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(VAULT_STORE);
      const slots = await Promise.all(VAULT_SLOT_IDS.map((id) => requestResult(store.get(id))));
      await done;
      return { available: true, slots: slots.filter(Boolean), error: '' };
    } finally { db.close(); }
  }

  async function readImageReport(state) {
    const db = await openExistingDatabase(IMAGE_DB_NAME);
    if (!db) return { available: false, count: 0, referencedCount: 0, missingReferences: [], unreferenced: [], error: '' };
    try {
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) return { available: false, count: 0, referencedCount: 0, missingReferences: [], unreferenced: [], error: 'Image store is missing.' };
      const transaction = db.transaction(IMAGE_STORE_NAME, 'readonly');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(IMAGE_STORE_NAME);
      const keys = (await requestResult(store.getAllKeys())).map((key) => String(key));
      await done;
      const availableKeys = new Set(keys);
      const referenced = new Set();
      if (typeof state?.youImageId === 'string' && state.youImageId) referenced.add(state.youImageId);
      for (const player of Array.isArray(state?.players) ? state.players : []) {
        if (typeof player?.imageId === 'string' && player.imageId) referenced.add(player.imageId);
      }
      return {
        available: true,
        count: keys.length,
        referencedCount: referenced.size,
        missingReferences: [...referenced].filter((key) => !availableKeys.has(key)).sort(),
        unreferenced: keys.filter((key) => !referenced.has(key)).sort(),
        error: ''
      };
    } finally { db.close(); }
  }

  async function readBrowserStorage() {
    const storage = navigator.storage;
    if (!storage) return { available: false, persisted: null, estimate: null };
    let persisted = null;
    let estimate = null;
    try { if (typeof storage.persisted === 'function') persisted = await storage.persisted(); } catch (_) {}
    try { if (typeof storage.estimate === 'function') estimate = await storage.estimate(); } catch (_) {}
    return { available: true, persisted, estimate };
  }

  function rollingBackups() {
    return BACKUP_KEYS.map((key, index) => {
      const record = safeJson(localStorage.getItem(key), null);
      if (!record?.state) return null;
      return { id: key, label: index === 0 ? 'latest' : `previous ${index}`, timestamp: record.timestamp || '', reason: record.reason || '', counts: countsFor(record.state) };
    }).filter(Boolean);
  }

  function parseJournalCount(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return { present: false, count: 0, readable: true };
    const parsed = safeJson(raw, null);
    const values = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? (Array.isArray(parsed.operations) ? parsed.operations : Object.values(parsed)) : null);
    return { present: true, count: Array.isArray(values) ? values.length : 0, readable: Array.isArray(values) };
  }

  Object.assign(api, {
    formatBytes, formatTimestamp, readSafetyVault, readImageReport,
    readBrowserStorage, rollingBackups, parseJournalCount
  });
  global.TaskPointsStorageHealth = api;
})(typeof window !== 'undefined' ? window : globalThis);
