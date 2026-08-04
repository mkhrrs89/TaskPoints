(() => {
  'use strict';

  const STORAGE_KEY = window.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const IMAGE_DB_NAME = window.TaskPointsCore?.IMAGE_DB_NAME || 'taskpoints';
  const IMAGE_STORE_NAME = window.TaskPointsCore?.IMAGE_STORE_NAME || 'images';
  let latestReport = null;
  let cleanupBusy = false;

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  function cleanupApi() {
    const api = window.TaskPointsStorageImageCleanup;
    if (!api?.buildCleanupPlan || !api?.validateCleanupPreview) {
      throw new Error('The image cleanup safety module did not load. Reload TaskPoints and try again.');
    }
    return api;
  }

  function utf8Bytes(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    try {
      return new TextEncoder().encode(text).length;
    } catch (_) {
      return text.length * 2;
    }
  }

  function localStorageBytes(key, value) {
    return (String(key ?? '').length + String(value ?? '').length) * 2;
  }

  function formatBytes(bytes) {
    const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (safe < 1024) return `${safe.toLocaleString()} B`;
    if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(2)} KiB`;
    if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(2)} MiB`;
    return `${(safe / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  function formatMs(value) {
    const safe = Number(value || 0);
    return safe < 1 ? `${safe.toFixed(3)} ms` : `${safe.toFixed(2)} ms`;
  }

  async function measure(name, work, timings) {
    const start = performance.now();
    try {
      return await work();
    } finally {
      timings[name] = performance.now() - start;
    }
  }

  function getLocalStorageReport() {
    const entries = [];
    let totalUtf8Bytes = 0;
    let totalStorageBytes = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) || '';
      const utf8 = utf8Bytes(value);
      const storage = localStorageBytes(key, value);
      totalUtf8Bytes += utf8;
      totalStorageBytes += storage;
      entries.push({ key, utf8Bytes: utf8, storageBytes: storage, chars: value.length });
    }
    entries.sort((a, b) => b.storageBytes - a.storageBytes);
    return { entries, totalUtf8Bytes, totalStorageBytes };
  }

  function parseStoredState(raw) {
    const core = window.TaskPointsCore || {};
    if (!raw) return {};
    if (typeof core.parseTaskPointsStorageJson === 'function') {
      return core.parseTaskPointsStorageJson(raw, {});
    }
    if (typeof core.readTaskPointsStoredState === 'function') {
      return core.readTaskPointsStoredState(STORAGE_KEY, {});
    }
    return JSON.parse(raw);
  }

  function readCurrentState() {
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    return { raw, state: parseStoredState(raw) };
  }

  function describeValue(value) {
    if (Array.isArray(value)) return { type: 'array', count: value.length };
    if (value && typeof value === 'object') return { type: 'object', count: Object.keys(value).length };
    if (typeof value === 'string') return { type: 'string', count: value.length };
    if (value === null) return { type: 'null', count: 0 };
    return { type: typeof value, count: 1 };
  }

  function buildCollectionReport(state) {
    const rows = [];
    for (const [key, value] of Object.entries(state || {})) {
      let json = '';
      let error = '';
      try {
        json = JSON.stringify(value);
      } catch (err) {
        error = err?.message || String(err);
      }
      const descriptor = describeValue(value);
      rows.push({
        key,
        type: descriptor.type,
        count: descriptor.count,
        bytes: utf8Bytes(json),
        chars: json.length,
        error
      });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    return rows;
  }

  async function getBrowserStorageReport() {
    const storage = navigator.storage;
    if (!storage) return { available: false, persisted: null, estimate: null };
    let persisted = null;
    let estimate = null;
    try {
      if (typeof storage.persisted === 'function') persisted = await storage.persisted();
    } catch (_) {}
    try {
      if (typeof storage.estimate === 'function') estimate = await storage.estimate();
    } catch (_) {}
    return { available: true, persisted, estimate };
  }

  function openExistingImageDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      const request = indexedDB.open(IMAGE_DB_NAME);
      request.onupgradeneeded = () => {
        try { request.transaction.abort(); } catch (_) {}
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        const errorName = request.error?.name || '';
        if (errorName === 'AbortError') resolve(null);
        else reject(request.error || new Error('Could not open image database.'));
      };
      request.onblocked = () => reject(new Error('Image database is blocked by another tab.'));
    });
  }

  function readImageRows(db) {
    return new Promise((resolve, reject) => {
      const output = [];
      const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        const size = value && Number.isFinite(value.size)
          ? Number(value.size)
          : utf8Bytes(JSON.stringify(value ?? null));
        output.push({ key: String(cursor.key), bytes: size, type: value?.type || typeof value });
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('Image cursor failed.'));
      tx.oncomplete = () => resolve(output);
      tx.onerror = () => reject(tx.error || new Error('Image transaction failed.'));
      tx.onabort = () => reject(tx.error || new Error('Image transaction was aborted.'));
    });
  }

  async function getImageDatabaseReport(state) {
    if (!window.indexedDB) {
      return { available: false, reason: 'IndexedDB is unavailable.', count: 0, totalBytes: 0, rows: [] };
    }

    let db = null;
    try {
      db = await openExistingImageDb();
      if (!db) return { available: false, reason: 'Image database does not exist.', count: 0, totalBytes: 0, rows: [] };
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        return { available: false, reason: `Store ${IMAGE_STORE_NAME} was not found.`, count: 0, totalBytes: 0, rows: [] };
      }

      const scannedRows = await readImageRows(db);
      const plan = cleanupApi().buildCleanupPlan(state, scannedRows);
      const rows = [...plan.rows].sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));

      return {
        available: true,
        reason: '',
        count: rows.length,
        totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
        rows,
        referencedCount: plan.referencedIds.length,
        referencedIds: plan.referencedIds,
        referencePaths: plan.referencePaths,
        missingReferences: plan.missingReferences,
        unreferenced: plan.unreferencedIds,
        unreferencedRows: plan.unreferencedRows,
        unreferencedBytes: plan.unreferencedBytes,
        fingerprint: plan.fingerprint
      };
    } catch (err) {
      return { available: false, reason: err?.message || String(err), count: 0, totalBytes: 0, rows: [] };
    } finally {
      try { db?.close(); } catch (_) {}
    }
  }

  function deleteImageKeys(keysInput) {
    const keys = [...new Set((Array.isArray(keysInput) ? keysInput : []).map(String).filter(Boolean))];
    if (!keys.length) return Promise.resolve({ deleted: 0 });

    return new Promise(async (resolve, reject) => {
      let db = null;
      try {
        db = await openExistingImageDb();
        if (!db || !db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
          reject(new Error('Image database or image store is unavailable.'));
          return;
        }
        const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(IMAGE_STORE_NAME);
        keys.forEach((key) => store.delete(key));
        tx.oncomplete = () => resolve({ deleted: keys.length });
        tx.onerror = () => reject(tx.error || new Error('Image cleanup transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('Image cleanup transaction was aborted.'));
      } catch (error) {
        reject(error);
      } finally {
        const closeWhenFinished = () => { try { db?.close(); } catch (_) {} };
        if (db) setTimeout(closeWhenFinished, 0);
      }
    });
  }

  function buildWarnings(report) {
    const warnings = [];
    const mainEntry = report.localStorage.entries.find((entry) => entry.key === STORAGE_KEY);
    if (!mainEntry) {
      warnings.push({ level: 'danger', text: `${STORAGE_KEY} was not found. Do not begin migration until the current data source is identified.` });
    } else if (mainEntry.storageBytes >= 4.5 * 1024 * 1024) {
      warnings.push({ level: 'danger', text: `The main localStorage snapshot is ${formatBytes(mainEntry.storageBytes)}, which is already near the common Web Storage ceiling.` });
    } else if (mainEntry.storageBytes >= 3.5 * 1024 * 1024) {
      warnings.push({ level: 'warn', text: `The main localStorage snapshot is ${formatBytes(mainEntry.storageBytes)} and has limited remaining headroom.` });
    }

    const backupBytes = report.localStorage.entries
      .filter((entry) => /backup|snapshot|before|quarantine/i.test(entry.key))
      .reduce((sum, entry) => sum + entry.storageBytes, 0);
    if (backupBytes >= 512 * 1024) {
      warnings.push({ level: 'warn', text: `Backup-like localStorage keys consume ${formatBytes(backupBytes)} and should move out of localStorage during the migration.` });
    }

    if (report.images.available) {
      if (report.images.missingReferences.length) {
        warnings.push({ level: 'danger', text: `${report.images.missingReferences.length} image reference(s) in the current TaskPoints state point to missing blobs. Cleanup is blocked until those references are repaired.` });
      }
      if (report.images.unreferenced.length) {
        warnings.push({ level: 'warn', text: `${report.images.unreferenced.length} image blob(s), totaling ${formatBytes(report.images.unreferencedBytes)}, are not referenced anywhere in the current TaskPoints state.` });
      }
    } else {
      warnings.push({ level: 'warn', text: `Player image byte totals could not be read: ${report.images.reason || 'unknown reason'}` });
    }

    if (report.browserStorage.persisted === false) {
      warnings.push({ level: 'warn', text: 'Persistent browser storage has not been granted on this device.' });
    }

    const largest = report.collections[0];
    if (largest && report.unpackedBytes > 0 && largest.bytes / report.unpackedBytes >= 0.35) {
      warnings.push({ level: 'info', text: `${largest.key} is the largest top-level collection at ${formatBytes(largest.bytes)}. It is a strong candidate for the first record-based migration.` });
    }

    if (!warnings.length) {
      warnings.push({ level: 'good', text: 'No immediate integrity warnings were detected. The report is ready to guide schema planning.' });
    }
    return warnings;
  }

  function renderSummaryCards(report) {
    const mainEntry = report.localStorage.entries.find((entry) => entry.key === STORAGE_KEY);
    const quota = Number(report.browserStorage.estimate?.quota || 0);
    const usage = Number(report.browserStorage.estimate?.usage || 0);
    const cards = [
      ['Main snapshot', mainEntry ? formatBytes(mainEntry.storageBytes) : 'Missing', `${report.rawChars.toLocaleString()} stored characters`],
      ['Unpacked state', formatBytes(report.unpackedBytes), `${report.collections.length} top-level fields`],
      ['Player images', report.images.available ? formatBytes(report.images.totalBytes) : 'Unavailable', report.images.available ? `${report.images.count} image blobs` : report.images.reason],
      ['Origin storage', quota ? `${((usage / quota) * 100).toFixed(3)}%` : 'Unavailable', quota ? `${formatBytes(usage)} of ${formatBytes(quota)}` : 'No quota estimate']
    ];
    $('summaryCards').innerHTML = cards.map(([label, value, detail]) => `
      <div class="glass space-y-1">
        <div class="muted text-xs uppercase tracking-wide">${escapeHtml(label)}</div>
        <div class="text-xl font-bold">${escapeHtml(value)}</div>
        <div class="muted text-xs break-words">${escapeHtml(detail || '')}</div>
      </div>
    `).join('');
  }

  function renderWarnings(report) {
    const classByLevel = {
      danger: 'border-rose-500/30 bg-rose-950/20 text-rose-100',
      warn: 'border-amber-400/30 bg-amber-950/20 text-amber-100',
      info: 'border-cyan-400/30 bg-cyan-950/20 text-cyan-100',
      good: 'border-emerald-400/30 bg-emerald-950/20 text-emerald-100'
    };
    $('warningsOutput').innerHTML = report.warnings.map((warning) => `
      <div class="rounded-xl border p-3 ${classByLevel[warning.level] || classByLevel.info}">${escapeHtml(warning.text)}</div>
    `).join('');
  }

  function renderTimings(report) {
    const rows = Object.entries(report.timings).sort((a, b) => b[1] - a[1]);
    $('timingsOutput').innerHTML = `
      <table class="w-full text-sm">
        <thead><tr><th class="text-left py-2 pr-4">Operation</th><th class="text-right py-2">Time</th></tr></thead>
        <tbody>${rows.map(([name, value]) => `<tr><td class="py-1 pr-4">${escapeHtml(name)}</td><td class="py-1 text-right">${formatMs(value)}</td></tr>`).join('')}</tbody>
      </table>
    `;
  }

  function renderCollections(report) {
    const total = Math.max(1, report.collections.reduce((sum, row) => sum + row.bytes, 0));
    $('collectionsOutput').innerHTML = `
      <table class="w-full text-xs sm:text-sm">
        <thead><tr><th class="text-left py-2 pr-3">Field</th><th class="text-left py-2 pr-3">Type</th><th class="text-right py-2 pr-3">Count</th><th class="text-right py-2 pr-3">JSON size</th><th class="text-right py-2">Share</th></tr></thead>
        <tbody>${report.collections.map((row) => `
          <tr>
            <td class="py-1 pr-3 break-all">${escapeHtml(row.key)}</td>
            <td class="py-1 pr-3">${escapeHtml(row.type)}</td>
            <td class="py-1 pr-3 text-right">${row.count.toLocaleString()}</td>
            <td class="py-1 pr-3 text-right">${formatBytes(row.bytes)}</td>
            <td class="py-1 text-right">${((row.bytes / total) * 100).toFixed(1)}%</td>
          </tr>
        `).join('')}</tbody>
      </table>
    `;
  }

  function updateCleanupControls(imageReport) {
    const button = $('cleanupUnreferencedImagesBtn');
    const status = $('imageCleanupStatus');
    if (!button || !status) return;

    if (cleanupBusy) {
      button.disabled = true;
      return;
    }
    if (!imageReport?.available) {
      button.disabled = true;
      button.textContent = 'Cleanup Unavailable';
      status.textContent = imageReport?.reason || 'Run diagnostics to inspect image storage.';
      return;
    }
    if (imageReport.missingReferences.length) {
      button.disabled = true;
      button.textContent = 'Cleanup Blocked';
      status.textContent = `${imageReport.missingReferences.length} referenced image blob(s) are missing. Repair those references before deleting anything.`;
      return;
    }
    if (!imageReport.unreferenced.length) {
      button.disabled = true;
      button.textContent = 'No Unreferenced Images';
      status.textContent = 'Every stored image blob is referenced somewhere in the current TaskPoints state.';
      return;
    }

    button.disabled = false;
    button.textContent = `Delete ${imageReport.unreferenced.length} Unreferenced (${formatBytes(imageReport.unreferencedBytes)})`;
    status.textContent = 'Review the unreferenced IDs below. Deletion requires a separate confirmation and revalidation.';
  }

  function renderImages(report) {
    const imageReport = report.images;
    updateCleanupControls(imageReport);
    if (!imageReport.available) {
      $('imagesOutput').innerHTML = `<div class="rounded-xl border border-amber-400/30 bg-amber-950/20 p-3">${escapeHtml(imageReport.reason || 'Image database unavailable.')}</div>`;
      return;
    }
    $('imagesOutput').innerHTML = `
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><span class="muted">Blobs:</span> <strong>${imageReport.count.toLocaleString()}</strong></div>
        <div><span class="muted">Total size:</span> <strong>${formatBytes(imageReport.totalBytes)}</strong></div>
        <div><span class="muted">Referenced IDs:</span> <strong>${imageReport.referencedCount.toLocaleString()}</strong></div>
        <div><span class="muted">Missing / unreferenced:</span> <strong>${imageReport.missingReferences.length} / ${imageReport.unreferenced.length}</strong></div>
      </div>
      <div class="muted text-xs">References are collected across the full current TaskPoints state, including current and archived Season snapshots.</div>
      <div class="overflow-x-auto">
        <div class="text-xs font-semibold mb-1">Largest image blobs</div>
        <table class="w-full text-xs"><thead><tr><th class="text-left py-1 pr-3">Image ID</th><th class="text-left py-1 pr-3">Type</th><th class="text-right py-1">Size</th></tr></thead><tbody>
          ${imageReport.rows.slice(0, 20).map((row) => `<tr><td class="py-1 pr-3 break-all">${escapeHtml(row.key)}</td><td class="py-1 pr-3">${escapeHtml(row.type)}</td><td class="py-1 text-right">${formatBytes(row.bytes)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted py-2">No image blobs found.</td></tr>'}
        </tbody></table>
      </div>
      ${imageReport.missingReferences.length ? `<div class="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3"><strong>Missing referenced IDs:</strong><div class="text-xs break-all mt-1">${imageReport.missingReferences.map(escapeHtml).join('<br>')}</div></div>` : ''}
      ${imageReport.unreferenced.length ? `<details class="rounded-xl border border-white/10 p-3"><summary class="cursor-pointer font-semibold">Unreferenced image IDs (${imageReport.unreferenced.length}, ${formatBytes(imageReport.unreferencedBytes)})</summary><div class="text-xs break-all mt-2">${imageReport.unreferenced.map(escapeHtml).join('<br>')}</div></details>` : ''}
    `;
  }

  function renderLocalStorage(report) {
    $('localStorageOutput').innerHTML = `
      <div class="muted text-xs mb-2">Estimated synchronous storage: <strong>${formatBytes(report.localStorage.totalStorageBytes)}</strong> across ${report.localStorage.entries.length} keys.</div>
      <table class="w-full text-xs sm:text-sm">
        <thead><tr><th class="text-left py-2 pr-3">Key</th><th class="text-right py-2 pr-3">Characters</th><th class="text-right py-2 pr-3">UTF-8</th><th class="text-right py-2">Storage estimate</th></tr></thead>
        <tbody>${report.localStorage.entries.map((entry) => `<tr><td class="py-1 pr-3 break-all">${escapeHtml(entry.key)}</td><td class="py-1 pr-3 text-right">${entry.chars.toLocaleString()}</td><td class="py-1 pr-3 text-right">${formatBytes(entry.utf8Bytes)}</td><td class="py-1 text-right">${formatBytes(entry.storageBytes)}</td></tr>`).join('')}</tbody>
      </table>
    `;
  }

  function renderBrowserStorage(report) {
    const storage = report.browserStorage;
    const estimate = storage.estimate;
    const usage = Number(estimate?.usage || 0);
    const quota = Number(estimate?.quota || 0);
    const usageDetails = estimate?.usageDetails && typeof estimate.usageDetails === 'object'
      ? Object.entries(estimate.usageDetails).sort((a, b) => Number(b[1]) - Number(a[1]))
      : [];
    $('browserStorageOutput').innerHTML = `
      <div><span class="muted">Storage API:</span> <strong>${storage.available ? 'Available' : 'Unavailable'}</strong></div>
      <div><span class="muted">Persistent:</span> <strong>${storage.persisted === true ? 'Yes' : storage.persisted === false ? 'No' : 'Unknown'}</strong></div>
      <div><span class="muted">Origin usage:</span> <strong>${estimate ? formatBytes(usage) : 'Unavailable'}</strong></div>
      <div><span class="muted">Estimated quota:</span> <strong>${estimate ? formatBytes(quota) : 'Unavailable'}</strong></div>
      <div><span class="muted">Quota used:</span> <strong>${quota ? `${((usage / quota) * 100).toFixed(4)}%` : 'Unavailable'}</strong></div>
      ${usageDetails.length ? `<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr><th class="text-left py-1">Category</th><th class="text-right py-1">Bytes</th></tr></thead><tbody>${usageDetails.map(([key, value]) => `<tr><td class="py-1">${escapeHtml(key)}</td><td class="py-1 text-right">${formatBytes(Number(value || 0))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted text-xs">This browser did not provide category-level usage details.</div>'}
    `;
  }

  function renderReport(report) {
    renderSummaryCards(report);
    renderWarnings(report);
    renderTimings(report);
    renderCollections(report);
    renderImages(report);
    renderLocalStorage(report);
    renderBrowserStorage(report);
  }

  async function runDiagnostics() {
    const button = $('runDiagnosticsBtn');
    const exportButton = $('exportDiagnosticsBtn');
    button.disabled = true;
    exportButton.disabled = true;
    $('diagnosticStatus').textContent = 'Reading current storage without changing it…';

    const timings = {};
    try {
      const localStorageReport = await measure('Scan localStorage keys', async () => getLocalStorageReport(), timings);
      const raw = await measure('Read main snapshot', async () => localStorage.getItem(STORAGE_KEY) || '', timings);
      const state = await measure('Parse / decompress main snapshot', async () => parseStoredState(raw), timings);
      const unpackedJson = await measure('Serialize unpacked state', async () => JSON.stringify(state || {}), timings);
      const collections = await measure('Measure top-level collections', async () => buildCollectionReport(state), timings);
      const browserStorage = await measure('Read browser storage estimate', async () => getBrowserStorageReport(), timings);
      const images = await measure('Scan image IndexedDB', async () => getImageDatabaseReport(state), timings);

      const encodingInfo = (() => {
        try {
          return window.TaskPointsCore?.getTaskPointsStorageEncodingInfo?.(raw) || null;
        } catch (_) {
          return null;
        }
      })();

      latestReport = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        page: location.href,
        userAgent: navigator.userAgent,
        storageKey: STORAGE_KEY,
        imageDatabase: { name: IMAGE_DB_NAME, store: IMAGE_STORE_NAME },
        rawChars: raw.length,
        rawUtf8Bytes: utf8Bytes(raw),
        rawStorageBytes: localStorageBytes(STORAGE_KEY, raw),
        unpackedChars: unpackedJson.length,
        unpackedBytes: utf8Bytes(unpackedJson),
        encodingInfo,
        localStorage: localStorageReport,
        collections,
        browserStorage,
        images,
        timings
      };
      latestReport.warnings = buildWarnings(latestReport);

      renderReport(latestReport);
      exportButton.disabled = false;
      $('diagnosticStatus').textContent = `Report completed at ${new Date().toLocaleTimeString()}. No TaskPoints data was changed.`;
      return latestReport;
    } catch (err) {
      console.error('Storage diagnostics failed', err);
      $('diagnosticStatus').textContent = `Diagnostics failed: ${err?.message || String(err)}`;
      $('warningsOutput').innerHTML = `<div class="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3">${escapeHtml(err?.stack || err?.message || String(err))}</div>`;
      throw err;
    } finally {
      button.disabled = false;
    }
  }

  async function cleanupUnreferencedImages() {
    if (cleanupBusy) return;
    cleanupBusy = true;
    const cleanupButton = $('cleanupUnreferencedImagesBtn');
    const runButton = $('runDiagnosticsBtn');
    const cleanupStatus = $('imageCleanupStatus');
    cleanupButton.disabled = true;
    runButton.disabled = true;
    cleanupButton.textContent = 'Rechecking…';
    cleanupStatus.textContent = 'Re-reading the current state and image database before showing confirmation…';

    try {
      const previewState = readCurrentState();
      const preview = await getImageDatabaseReport(previewState.state);
      if (!preview.available) throw new Error(preview.reason || 'Image database is unavailable.');
      if (preview.missingReferences.length) {
        throw new Error(`Cleanup blocked: ${preview.missingReferences.length} referenced image blob(s) are already missing.`);
      }
      if (!preview.unreferenced.length) {
        await runDiagnostics();
        cleanupStatus.textContent = 'No unreferenced image blobs remain.';
        return;
      }

      const confirmation = window.confirm(
        `Delete ${preview.unreferenced.length} unreferenced image blob(s) totaling ${formatBytes(preview.unreferencedBytes)}?\n\n` +
        'TaskPoints will protect image IDs referenced anywhere in the current state, including current and historical Season data. ' +
        'The cleanup will be revalidated after you confirm. This deletion cannot be undone.'
      );
      if (!confirmation) {
        cleanupStatus.textContent = 'Cleanup canceled. No image blobs were deleted.';
        return;
      }

      cleanupButton.textContent = 'Revalidating…';
      cleanupStatus.textContent = 'Checking that the state and image database did not change after confirmation…';
      const validatedState = readCurrentState();
      const validatedReport = await getImageDatabaseReport(validatedState.state);
      if (!validatedReport.available) throw new Error(validatedReport.reason || 'Image database is unavailable.');
      const validation = cleanupApi().validateCleanupPreview(preview, validatedState.state, validatedReport.rows);
      if (!validation.ok) {
        await runDiagnostics();
        const reason = validation.reason === 'missing-references'
          ? 'A referenced image is missing.'
          : 'The TaskPoints state or image database changed after the preview.';
        cleanupStatus.textContent = `${reason} Nothing was deleted; review the refreshed report and try again.`;
        window.alert(`${reason}\n\nNothing was deleted. Review the refreshed report before trying again.`);
        return;
      }

      if ((localStorage.getItem(STORAGE_KEY) || '') !== validatedState.raw) {
        await runDiagnostics();
        cleanupStatus.textContent = 'The TaskPoints state changed immediately before deletion. Nothing was deleted; review the refreshed report.';
        return;
      }

      const deleteIds = validation.current.unreferencedIds;
      const deleteBytes = validation.current.unreferencedBytes;
      cleanupButton.textContent = 'Deleting…';
      cleanupStatus.textContent = `Deleting ${deleteIds.length} revalidated unreferenced image blob(s) in one transaction…`;
      await deleteImageKeys(deleteIds);

      cleanupButton.textContent = 'Verifying…';
      cleanupStatus.textContent = 'Verifying active image references and the completed deletion…';
      const finalState = readCurrentState();
      const finalReport = await getImageDatabaseReport(finalState.state);
      if (!finalReport.available) throw new Error(finalReport.reason || 'Image database became unavailable during verification.');
      if (finalReport.missingReferences.length) {
        throw new Error(`Cleanup verification failed: ${finalReport.missingReferences.length} referenced image blob(s) are missing.`);
      }
      const remainingIds = new Set(finalReport.rows.map((row) => row.key));
      const undeleted = deleteIds.filter((imageId) => remainingIds.has(imageId));
      if (undeleted.length) {
        throw new Error(`Cleanup verification failed: ${undeleted.length} intended image blob(s) still remain.`);
      }

      await runDiagnostics();
      cleanupStatus.textContent = `Deleted and verified ${deleteIds.length} unreferenced image blob(s), freeing ${formatBytes(deleteBytes)}. Active references remain intact.`;
    } catch (err) {
      console.error('Unreferenced image cleanup failed', err);
      cleanupStatus.textContent = `Cleanup failed: ${err?.message || String(err)} No player or Season records were changed.`;
      window.alert(`Image cleanup failed:\n\n${err?.message || String(err)}`);
      try { await runDiagnostics(); } catch (_) {}
    } finally {
      cleanupBusy = false;
      runButton.disabled = false;
      updateCleanupControls(latestReport?.images || null);
    }
  }

  function exportDiagnostics() {
    if (!latestReport) return;
    const safeReport = JSON.parse(JSON.stringify(latestReport));
    const blob = new Blob([JSON.stringify(safeReport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
    anchor.href = url;
    anchor.download = `taskpoints-storage-diagnostics-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function requestPersistence() {
    const button = $('requestPersistenceBtn');
    button.disabled = true;
    try {
      if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
        alert('Persistent storage requests are not available in this browser.');
        return;
      }
      const granted = await navigator.storage.persist();
      alert(granted ? 'Persistent storage was granted.' : 'Persistent storage was not granted by the browser.');
      await runDiagnostics();
    } catch (err) {
      alert(`Persistent storage request failed: ${err?.message || String(err)}`);
    } finally {
      button.disabled = false;
    }
  }

  $('runDiagnosticsBtn')?.addEventListener('click', () => runDiagnostics().catch(() => {}));
  $('exportDiagnosticsBtn')?.addEventListener('click', exportDiagnostics);
  $('requestPersistenceBtn')?.addEventListener('click', requestPersistence);
  $('cleanupUnreferencedImagesBtn')?.addEventListener('click', cleanupUnreferencedImages);

  const api = {
    formatBytes,
    parseStoredState,
    readCurrentState,
    getImageDatabaseReport,
    deleteImageKeys,
    runDiagnostics,
    cleanupUnreferencedImages,
    getLatestReport: () => latestReport
  };
  window.TaskPointsStorageDiagnostics = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => runDiagnostics().catch(() => {}), { once: true });
  } else {
    runDiagnostics().catch(() => {});
  }
})();
