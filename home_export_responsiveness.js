;(function installTaskPointsResponsiveExport(global) {
  'use strict';

  if (global.TaskPointsResponsiveExport?.installed) return;

  const EXPORT_SELECTOR = '[data-export-button]';
  const STATUS_ID = 'tpResponsiveExportStatus';
  const IMAGE_CONCURRENCY = 4;
  const FILE_CONCURRENCY = 4;
  const URL_REVOKE_DELAY_MS = 60000;
  const ANCHOR_REMOVE_DELAY_MS = 1500;
  const imageBlobCache = new Map();

  function createSingleFlightRunner() {
    let active = null;
    return function run(task) {
      if (active) return active;
      active = Promise.resolve()
        .then(task)
        .finally(() => {
          active = null;
        });
      return active;
    };
  }

  const runSingleExport = createSingleFlightRunner();

  function nextPaint() {
    return new Promise((resolve) => {
      const raf = global.requestAnimationFrame || ((callback) => global.setTimeout(callback, 0));
      raf(() => raf(resolve));
    });
  }

  async function mapWithConcurrency(items, limit, worker) {
    const list = Array.from(items || []);
    if (!list.length) return [];
    const output = new Array(list.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(Number(limit) || 1, list.length));

    async function runWorker() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= list.length) return;
        output[index] = await worker(list[index], index, list.length);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return output;
  }

  function exportButtons() {
    return Array.from(global.document?.querySelectorAll?.(EXPORT_SELECTOR) || []);
  }

  function ensureStatus() {
    const document = global.document;
    if (!document?.createElement) return null;
    let status = document.getElementById?.(STATUS_ID) || null;
    if (status) return status;

    status = document.createElement('div');
    status.id = STATUS_ID;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    status.style.cssText = [
      'position:fixed',
      'top:calc(env(safe-area-inset-top, 0px) + 4.75rem)',
      'right:1rem',
      'z-index:100001',
      'max-width:min(78vw, 19rem)',
      'padding:.65rem .85rem',
      'border:1px solid rgba(148,163,184,.35)',
      'border-radius:.85rem',
      'background:rgba(15,23,42,.96)',
      'color:#f8fafc',
      'font:600 .86rem/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 10px 28px rgba(0,0,0,.35)',
      'pointer-events:none'
    ].join(';');
    (document.body || document.documentElement)?.appendChild?.(status);
    return status;
  }

  function updateStatus(message, { error = false, hidden = false } = {}) {
    const status = ensureStatus();
    if (!status) return;
    status.hidden = hidden;
    status.textContent = String(message || '');
    status.style.borderColor = error ? 'rgba(248,113,113,.7)' : 'rgba(148,163,184,.35)';
    status.style.color = error ? '#fecaca' : '#f8fafc';
  }

  function rememberButtonLabel(button) {
    if (!button?.getAttribute) return;
    if (!button.getAttribute('data-tp-export-original-label')) {
      button.setAttribute('data-tp-export-original-label', String(button.textContent || 'Export').trim() || 'Export');
    }
  }

  function setButtonsBusy(label) {
    exportButtons().forEach((button) => {
      rememberButtonLabel(button);
      button.disabled = true;
      button.setAttribute?.('aria-busy', 'true');
      button.textContent = label;
    });
  }

  function restoreButtons() {
    exportButtons().forEach((button) => {
      const label = button.getAttribute?.('data-tp-export-original-label') || 'Export';
      button.textContent = label;
      button.disabled = false;
      button.removeAttribute?.('aria-busy');
    });
  }

  function stripLegacyImageFields(snapshot) {
    const next = { ...(snapshot || {}) };
    if (next.youImage) delete next.youImage;
    if (Array.isArray(next.players)) {
      next.players = next.players.map((player) => {
        if (!player || typeof player !== 'object') return player;
        const { imageData, ...rest } = player;
        return rest;
      });
    }
    return next;
  }

  function loadProjects() {
    try {
      const raw = global.localStorage?.getItem?.('tp_projects_v1');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function bestNotes(state) {
    if (typeof global.syncNotesStorageLocations === 'function') {
      try { return global.syncNotesStorageLocations('responsive-export-sync'); } catch (_) {}
    }
    let cached = '';
    try { cached = global.localStorage?.getItem?.('taskpoints_notes_v1') || ''; } catch (_) {}
    const stateNotes = typeof state?.notes === 'string' ? state.notes : '';
    if (cached.trim() && !stateNotes.trim()) return cached;
    if (stateNotes.trim() && !cached.trim()) return stateNotes;
    return cached.length >= stateNotes.length ? cached : stateNotes;
  }

  function buildExportPayload() {
    const core = global.TaskPointsCore || {};
    core.flushPendingSaves?.();

    if (typeof global.getTaskPointsExportSnapshot === 'function') {
      const payload = global.getTaskPointsExportSnapshot();
      if (payload?.exportType === 'taskpoints_full_backup' && payload?.state) return payload;
    }

    let state = {};
    if (typeof core.loadAppState === 'function') {
      try {
        state = core.loadAppState({ syncDerived: false, persistSync: false })?.state || {};
      } catch (error) {
        console.warn('Responsive export could not read TaskPointsCore state', error);
      }
    }
    if (!state || typeof state !== 'object' || !Object.keys(state).length) {
      try {
        const key = core.STORAGE_KEY || 'taskpoints_v1';
        state = typeof core.readTaskPointsStoredState === 'function'
          ? core.readTaskPointsStoredState(key, {})
          : JSON.parse(global.localStorage?.getItem?.(key) || '{}');
      } catch (_) {
        state = {};
      }
    }

    const normalized = stripLegacyImageFields({ ...state, projects: loadProjects() });
    const notesText = bestNotes(normalized);
    normalized.notes = notesText;
    let projectsRaw = null;
    try { projectsRaw = global.localStorage?.getItem?.('tp_projects_v1'); } catch (_) {}

    return {
      exportType: 'taskpoints_full_backup',
      version: 2,
      exportedAtISO: new Date().toISOString(),
      state: normalized,
      aux: {
        taskpoints_notes_v1: notesText,
        ...(typeof projectsRaw === 'string' ? { tp_projects_v1: projectsRaw } : {})
      }
    };
  }

  function imageIdsFromState(state) {
    const ids = new Set();
    if (state?.youImageId) ids.add(String(state.youImageId));
    (Array.isArray(state?.players) ? state.players : []).forEach((player) => {
      if (player?.imageId) ids.add(String(player.imageId));
    });
    return [...ids];
  }

  let fallbackImageDbPromise = null;
  function openFallbackImageDb() {
    if (fallbackImageDbPromise) return fallbackImageDbPromise;
    fallbackImageDbPromise = new Promise((resolve, reject) => {
      const core = global.TaskPointsCore || {};
      const request = global.indexedDB.open(core.IMAGE_DB_NAME || 'taskpoints', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Image database unavailable'));
    });
    return fallbackImageDbPromise;
  }

  async function getImageBlobFallback(imageId) {
    if (!global.indexedDB) return null;
    const core = global.TaskPointsCore || {};
    const db = await openFallbackImageDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(core.IMAGE_STORE_NAME || 'images', 'readonly');
      const request = transaction.objectStore(core.IMAGE_STORE_NAME || 'images').get(imageId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error(`Unable to read image ${imageId}`));
    });
  }

  function cachedImageBlob(imageId) {
    if (imageBlobCache.has(imageId)) return imageBlobCache.get(imageId);
    const getter = global.TaskPointsCore?.getImageBlob || getImageBlobFallback;
    const promise = Promise.resolve()
      .then(() => getter(imageId))
      .catch((error) => {
        imageBlobCache.delete(imageId);
        throw error;
      });
    imageBlobCache.set(imageId, promise);
    return promise;
  }

  function extensionForBlob(blob) {
    const type = String(blob?.type || '').toLowerCase();
    if (type.includes('png')) return 'png';
    if (type.includes('webp')) return 'webp';
    if (type.includes('gif')) return 'gif';
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    return 'bin';
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[i] = value >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i += 1) {
      crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function writeUint16LE(buffer, offset, value) {
    buffer[offset] = value & 0xFF;
    buffer[offset + 1] = (value >>> 8) & 0xFF;
  }

  function writeUint32LE(buffer, offset, value) {
    buffer[offset] = value & 0xFF;
    buffer[offset + 1] = (value >>> 8) & 0xFF;
    buffer[offset + 2] = (value >>> 16) & 0xFF;
    buffer[offset + 3] = (value >>> 24) & 0xFF;
  }

  async function buildZipBlob(files, onProgress = null) {
    let completed = 0;
    const prepared = await mapWithConcurrency(files, FILE_CONCURRENCY, async (file) => {
      const bytes = file.data instanceof Uint8Array
        ? file.data
        : new Uint8Array(await file.blob.arrayBuffer());
      completed += 1;
      onProgress?.(completed, files.length);
      return { path: file.path, data: bytes };
    });

    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of prepared) {
      const nameBytes = encoder.encode(file.path);
      const data = file.data;
      const crc = crc32(data);

      const localHeader = new Uint8Array(30 + nameBytes.length);
      writeUint32LE(localHeader, 0, 0x04034b50);
      writeUint16LE(localHeader, 4, 20);
      writeUint16LE(localHeader, 6, 0);
      writeUint16LE(localHeader, 8, 0);
      writeUint32LE(localHeader, 14, crc);
      writeUint32LE(localHeader, 18, data.length);
      writeUint32LE(localHeader, 22, data.length);
      writeUint16LE(localHeader, 26, nameBytes.length);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      writeUint32LE(centralHeader, 0, 0x02014b50);
      writeUint16LE(centralHeader, 4, 20);
      writeUint16LE(centralHeader, 6, 20);
      writeUint16LE(centralHeader, 8, 0);
      writeUint16LE(centralHeader, 10, 0);
      writeUint32LE(centralHeader, 16, crc);
      writeUint32LE(centralHeader, 20, data.length);
      writeUint32LE(centralHeader, 24, data.length);
      writeUint16LE(centralHeader, 28, nameBytes.length);
      writeUint32LE(centralHeader, 42, offset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const endRecord = new Uint8Array(22);
    writeUint32LE(endRecord, 0, 0x06054b50);
    writeUint16LE(endRecord, 8, prepared.length);
    writeUint16LE(endRecord, 10, prepared.length);
    writeUint32LE(endRecord, 12, centralSize);
    writeUint32LE(endRecord, 16, offset);

    return new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' });
  }

  function exportFilename(now = new Date()) {
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `taskpoints-backup-with-images-${y}-${mo}-${d}_${hh}-${mm}-${ss}.zip`;
  }

  function triggerDownload(blob, filename, dependencies = {}) {
    const document = dependencies.document || global.document;
    const urlApi = dependencies.URL || global.URL;
    const setTimeoutFn = dependencies.setTimeout || global.setTimeout;
    const url = urlApi.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();

    setTimeoutFn(() => anchor.remove(), ANCHOR_REMOVE_DELAY_MS);
    setTimeoutFn(() => urlApi.revokeObjectURL(url), URL_REVOKE_DELAY_MS);
    return { url, anchor };
  }

  async function createExportArtifact(onProgress = null) {
    const payload = buildExportPayload();
    const ids = imageIdsFromState(payload.state);
    let loaded = 0;
    const imageFiles = await mapWithConcurrency(ids, IMAGE_CONCURRENCY, async (imageId) => {
      const blob = await cachedImageBlob(imageId);
      loaded += 1;
      onProgress?.({ phase: 'images', completed: loaded, total: ids.length });
      if (!blob) return null;
      return { path: `images/${imageId}.${extensionForBlob(blob)}`, blob };
    });

    const files = [
      {
        path: 'manifest.json',
        blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      },
      ...imageFiles.filter(Boolean)
    ];

    const zipBlob = await buildZipBlob(files, (completed, total) => {
      onProgress?.({ phase: 'zip', completed, total });
    });
    return { blob: zipBlob, filename: exportFilename(), payload, imageCount: imageFiles.filter(Boolean).length };
  }

  function progressMessage(progress) {
    if (!progress) return 'Preparing…';
    if (progress.phase === 'images') {
      return progress.total ? `Images ${progress.completed}/${progress.total}` : 'Preparing images…';
    }
    if (progress.phase === 'zip') {
      return progress.total ? `Packing ${progress.completed}/${progress.total}` : 'Packing…';
    }
    return 'Preparing…';
  }

  function startExport() {
    return runSingleExport(async () => {
      setButtonsBusy('Preparing…');
      updateStatus('Preparing your full backup…');
      await nextPaint();

      try {
        const artifact = await createExportArtifact((progress) => {
          const message = progressMessage(progress);
          setButtonsBusy(message);
          updateStatus(message);
        });
        setButtonsBusy('Opening…');
        updateStatus('Opening the export screen…');
        await nextPaint();
        triggerDownload(artifact.blob, artifact.filename);
        updateStatus(`Backup ready${artifact.imageCount ? ` with ${artifact.imageCount} images` : ''}.`);
        global.setTimeout?.(() => updateStatus('', { hidden: true }), 2500);
        return artifact;
      } catch (error) {
        console.error('TaskPoints responsive export failed', error);
        updateStatus('Export failed. Tap Export to try again.', { error: true });
        throw error;
      } finally {
        restoreButtons();
      }
    });
  }

  function captureExportClick(event) {
    const button = event.target?.closest?.(EXPORT_SELECTOR);
    if (!button) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    startExport().catch(() => {});
  }

  global.document?.addEventListener?.('click', captureExportClick, true);

  const api = {
    installed: true,
    createSingleFlightRunner,
    mapWithConcurrency,
    buildExportPayload,
    buildZipBlob,
    triggerDownload,
    createExportArtifact,
    startExport,
    imageBlobCache,
    constants: {
      IMAGE_CONCURRENCY,
      FILE_CONCURRENCY,
      URL_REVOKE_DELAY_MS,
      ANCHOR_REMOVE_DELAY_MS
    }
  };
  global.TaskPointsResponsiveExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
