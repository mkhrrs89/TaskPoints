/* Test-only feasibility candidate. Never loaded by the application.
 * One IDB transaction owns generation, revision, payload and retry receipts.
 * This is NOT a production WAL, backup, migration or old-client fence.
 */
(() => {
  const DB = 'taskpoints_admission_feasibility_ONLY';
  const LEGACY = 'tp_projects_v1';
  const LOCK = 'taskpoints_admission_feasibility_ONLY';
  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('state');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function transact(change) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite');
        const store = tx.objectStore('state');
        let result;
        const r = store.get('root');
        r.onsuccess = () => {
          try {
            result = change(r.result);
            if (result.abort) { tx.abort(); return; }
            if (result.next) store.put(result.next, 'root');
          } catch (e) { result = {error:e.message}; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(new Error(result?.error || 'interrupted_before_commit'));
        tx.onerror = () => {};
      });
    } finally { db.close(); }
  }
  async function read() {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('state');
        const r = tx.objectStore('state').get('root');
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async function seed() {
    const legacy = localStorage.getItem(LEGACY);
    return transact(prior => prior ? {reason:'already_seeded'} : {
      next:{generation:0, revision:0, legacy, payload:JSON.parse(legacy), receipts:{}}
    });
  }
  async function admit(input) {
    // Snapshot intent before yielding; every cooperating caller uses this lock.
    const intent = structuredClone(input);
    return navigator.locks.request(LOCK, () => transact(prior => {
      if (!prior) throw Error('not_seeded');
      if (intent.generation !== prior.generation) return {reason:'stale_generation'};
      const fingerprint = JSON.stringify(intent);
      if (Object.hasOwn(prior.receipts, intent.id)) return {
        reason:prior.receipts[intent.id] === fingerprint ? 'duplicate' : 'conflicting_retry'
      };
      if (localStorage.getItem(LEGACY) !== prior.legacy) return {reason:'legacy_diverged'};
      if (intent.revision !== prior.revision) return {reason:'stale_revision'};
      if (intent.abort) return {abort:true};
      return {reason:'committed', next:{...prior, revision:prior.revision+1,
        payload:intent.payload, receipts:{...prior.receipts, [intent.id]:fingerprint}}};
    }));
  }
  async function reset() {
    return navigator.locks.request(LOCK, () => transact(prior => ({
      reason:'reset', next:{...prior, generation:prior.generation+1,
        revision:0, payload:[], receipts:{}}
    })));
  }
  window.BoundaryExperiment = {seed, admit, read, reset, LOCK};
})();
