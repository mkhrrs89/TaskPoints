(function installTaskPointsStorageDiagnosticsCleanupController(global) {
  'use strict';

  if (global.TaskPointsStorageDiagnosticsCleanupController?.installed) return;

  const BUTTON_SELECTOR = '#cleanupUnreferencedImagesBtn';
  const STATUS_ID = 'imageCleanupStatus';
  const RUN_BUTTON_ID = 'runDiagnosticsBtn';
  const STORAGE_KEY = global.TaskPointsCore?.STORAGE_KEY || 'taskpoints_v1';
  const IMAGE_DB_NAME = global.TaskPointsCore?.IMAGE_DB_NAME || 'taskpoints';
  const IMAGE_STORE_NAME = global.TaskPointsCore?.IMAGE_STORE_NAME || 'images';
  let busy = false;

  const byId = (id) => global.document?.getElementById?.(id) || null;

  function diagnosticsApi() {
    const api = global.TaskPointsStorageDiagnostics;
    if (!api?.readCurrentState || !api?.getImageDatabaseReport || !api?.runDiagnostics) {
      throw new Error('Storage Diagnostics is not ready. Reload the page and try again.');
    }
    return api;
  }

  function safetyApi() {
    const api = global.TaskPointsStorageImageCleanup;
    if (!api?.validateCleanupPreview) {
      throw new Error('The image cleanup safety module did not load. Reload the page and try again.');
    }
    return api;
  }

  function openExistingImageDb() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        resolve(null);
        return;
      }
      const request = global.indexedDB.open(IMAGE_DB_NAME);
      request.onupgradeneeded = () => {
        try { request.transaction?.abort(); } catch (_) {}
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        if (request.error?.name === 'AbortError') resolve(null);
        else reject(request.error || new Error('Could not open image database.'));
      };
      request.onblocked = () => reject(new Error('Image database is blocked by another TaskPoints tab.'));
    });
  }

  async function deleteValidatedImageKeys(keysInput) {
    const keys = [...new Set((Array.isArray(keysInput) ? keysInput : []).map(String).filter(Boolean))];
    if (!keys.length) return { deleted: 0 };

    const db = await openExistingImageDb();
    if (!db || !db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
      try { db?.close(); } catch (_) {}
      throw new Error('Image database or image store is unavailable.');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const close = () => { try { db.close(); } catch (_) {} };
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        close();
        resolve(value);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        close();
        reject(error);
      };

      let transaction;
      try {
        transaction = db.transaction(IMAGE_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(IMAGE_STORE_NAME);
        keys.forEach((key) => store.delete(key));
      } catch (error) {
        try { transaction?.abort(); } catch (_) {}
        rejectOnce(error);
        return;
      }

      transaction.oncomplete = () => resolveOnce({ deleted: keys.length });
      transaction.onerror = () => rejectOnce(transaction.error || new Error('Image cleanup transaction failed.'));
      transaction.onabort = () => rejectOnce(transaction.error || new Error('Image cleanup transaction was aborted.'));
    });
  }

  async function refreshReport() {
    try {
      return await diagnosticsApi().runDiagnostics();
    } catch (_) {
      return null;
    }
  }

  async function cleanupUnreferencedImages() {
    if (busy) return;
    busy = true;

    const button = byId('cleanupUnreferencedImagesBtn');
    const status = byId(STATUS_ID);
    const runButton = byId(RUN_BUTTON_ID);
    const priorButtonText = button?.textContent || 'Delete Unreferenced Images';
    const priorButtonDisabled = Boolean(button?.disabled);
    let reportRefreshed = false;
    let finalMessage = '';

    if (button) {
      button.disabled = true;
      button.textContent = 'Rechecking…';
    }
    if (runButton) runButton.disabled = true;
    if (status) status.textContent = 'Re-reading the current state and image database before showing confirmation…';

    try {
      const diagnostics = diagnosticsApi();
      const safety = safetyApi();
      const formatBytes = diagnostics.formatBytes || ((bytes) => `${Number(bytes || 0).toLocaleString()} B`);

      const previewState = diagnostics.readCurrentState();
      const preview = await diagnostics.getImageDatabaseReport(previewState.state);
      if (!preview.available) throw new Error(preview.reason || 'Image database is unavailable.');
      if (preview.missingReferences.length) {
        throw new Error(`Cleanup blocked: ${preview.missingReferences.length} referenced image blob(s) are already missing.`);
      }
      if (!preview.unreferenced.length) {
        await refreshReport();
        reportRefreshed = true;
        finalMessage = 'No unreferenced image blobs remain.';
        return;
      }

      const confirmed = global.confirm(
        `Delete ${preview.unreferenced.length} unreferenced image blob(s) totaling ${formatBytes(preview.unreferencedBytes)}?\n\n` +
        'TaskPoints will protect image IDs referenced anywhere in the current state, including current and historical Season data. ' +
        'The cleanup will be revalidated after you confirm. This deletion cannot be undone.'
      );
      if (!confirmed) {
        finalMessage = 'Cleanup canceled. No image blobs were deleted.';
        return;
      }

      if (button) button.textContent = 'Revalidating…';
      if (status) status.textContent = 'Checking that the state and image database did not change after confirmation…';
      const validatedState = diagnostics.readCurrentState();
      const validatedReport = await diagnostics.getImageDatabaseReport(validatedState.state);
      if (!validatedReport.available) throw new Error(validatedReport.reason || 'Image database is unavailable.');

      const validation = safety.validateCleanupPreview(preview, validatedState.state, validatedReport.rows);
      if (!validation.ok) {
        await refreshReport();
        reportRefreshed = true;
        const reason = validation.reason === 'missing-references'
          ? 'A referenced image is missing.'
          : 'The TaskPoints state or image database changed after the preview.';
        finalMessage = `${reason} Nothing was deleted; review the refreshed report and try again.`;
        global.alert(`${reason}\n\nNothing was deleted. Review the refreshed report before trying again.`);
        return;
      }

      if ((global.localStorage?.getItem?.(STORAGE_KEY) || '') !== validatedState.raw) {
        await refreshReport();
        reportRefreshed = true;
        finalMessage = 'The TaskPoints state changed immediately before deletion. Nothing was deleted; review the refreshed report.';
        return;
      }

      const deleteIds = validation.current.unreferencedIds;
      const deleteBytes = validation.current.unreferencedBytes;
      if (button) button.textContent = 'Deleting…';
      if (status) status.textContent = `Deleting ${deleteIds.length} revalidated unreferenced image blob(s) in one transaction…`;
      await deleteValidatedImageKeys(deleteIds);

      if (button) button.textContent = 'Verifying…';
      if (status) status.textContent = 'Verifying active image references and the completed deletion…';
      const finalState = diagnostics.readCurrentState();
      const finalReport = await diagnostics.getImageDatabaseReport(finalState.state);
      if (!finalReport.available) throw new Error(finalReport.reason || 'Image database became unavailable during verification.');
      if (finalReport.missingReferences.length) {
        throw new Error(`Cleanup verification failed: ${finalReport.missingReferences.length} referenced image blob(s) are missing.`);
      }
      const remainingIds = new Set(finalReport.rows.map((row) => row.key));
      const undeleted = deleteIds.filter((imageId) => remainingIds.has(imageId));
      if (undeleted.length) {
        throw new Error(`Cleanup verification failed: ${undeleted.length} intended image blob(s) still remain.`);
      }

      await refreshReport();
      reportRefreshed = true;
      finalMessage = `Deleted and verified ${deleteIds.length} unreferenced image blob(s), freeing ${formatBytes(deleteBytes)}. Active references remain intact.`;
    } catch (error) {
      console.error('Unreferenced image cleanup failed', error);
      await refreshReport();
      reportRefreshed = true;
      finalMessage = `Cleanup failed: ${error?.message || String(error)} No player, Season, score, or other state records were changed.`;
      global.alert(`Image cleanup failed:\n\n${error?.message || String(error)}`);
    } finally {
      busy = false;
      if (runButton) runButton.disabled = false;
      if (!reportRefreshed && button) {
        button.textContent = priorButtonText;
        button.disabled = priorButtonDisabled;
      }
      if (status && finalMessage) status.textContent = finalMessage;
    }
  }

  function captureCleanupClick(event) {
    const button = event.target?.closest?.(BUTTON_SELECTOR);
    if (!button) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    cleanupUnreferencedImages().catch((error) => console.error(error));
  }

  global.document?.addEventListener?.('click', captureCleanupClick, true);

  const api = {
    installed: true,
    openExistingImageDb,
    deleteValidatedImageKeys,
    cleanupUnreferencedImages,
    captureCleanupClick
  };
  global.TaskPointsStorageDiagnosticsCleanupController = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
