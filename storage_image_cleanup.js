(function installTaskPointsStorageImageCleanup(global) {
  'use strict';

  function normalizeImageId(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isImageReferenceKey(key) {
    return /imageId$/i.test(String(key || ''));
  }

  function collectReferencedImageIds(stateInput) {
    const ids = new Set();
    const pathsById = new Map();
    const seen = new WeakSet();

    function visit(value, path) {
      if (!value || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);

      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }

      Object.entries(value).forEach(([key, child]) => {
        const childPath = path ? `${path}.${key}` : key;
        if (isImageReferenceKey(key)) {
          const imageId = normalizeImageId(child);
          if (imageId) {
            ids.add(imageId);
            const paths = pathsById.get(imageId) || [];
            paths.push(childPath);
            pathsById.set(imageId, paths);
          }
        }
        visit(child, childPath);
      });
    }

    visit(stateInput, 'state');
    const referencedIds = [...ids].sort();
    const referencePaths = {};
    referencedIds.forEach((imageId) => {
      referencePaths[imageId] = [...(pathsById.get(imageId) || [])].sort();
    });
    return { referencedIds, referencePaths };
  }

  function normalizeImageRows(rowsInput) {
    const byKey = new Map();
    (Array.isArray(rowsInput) ? rowsInput : []).forEach((row) => {
      const key = normalizeImageId(row?.key);
      if (!key) return;
      const bytes = Number.isFinite(Number(row?.bytes)) && Number(row.bytes) > 0
        ? Number(row.bytes)
        : 0;
      byKey.set(key, {
        key,
        bytes,
        type: typeof row?.type === 'string' ? row.type : ''
      });
    });
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function buildCleanupPlan(stateInput, rowsInput) {
    const rows = normalizeImageRows(rowsInput);
    const { referencedIds, referencePaths } = collectReferencedImageIds(stateInput);
    const availableIds = rows.map((row) => row.key);
    const availableSet = new Set(availableIds);
    const referencedSet = new Set(referencedIds);
    const missingReferences = referencedIds.filter((imageId) => !availableSet.has(imageId));
    const unreferencedRows = rows.filter((row) => !referencedSet.has(row.key));
    const unreferencedIds = unreferencedRows.map((row) => row.key);
    const unreferencedBytes = unreferencedRows.reduce((sum, row) => sum + row.bytes, 0);
    const fingerprint = JSON.stringify({
      referencedIds,
      rows: rows.map((row) => [row.key, row.bytes, row.type])
    });

    return {
      rows,
      availableIds,
      referencedIds,
      referencePaths,
      missingReferences,
      unreferencedRows,
      unreferencedIds,
      unreferencedBytes,
      fingerprint
    };
  }

  function validateCleanupPreview(previewInput, stateInput, rowsInput) {
    const current = buildCleanupPlan(stateInput, rowsInput);
    const previewFingerprint = String(previewInput?.fingerprint || '');
    if (!previewFingerprint) {
      return { ok: false, reason: 'missing-preview', current };
    }
    if (current.missingReferences.length) {
      return { ok: false, reason: 'missing-references', current };
    }
    if (current.fingerprint !== previewFingerprint) {
      return { ok: false, reason: 'stale-preview', current };
    }
    return { ok: true, reason: '', current };
  }

  const api = {
    normalizeImageId,
    isImageReferenceKey,
    collectReferencedImageIds,
    normalizeImageRows,
    buildCleanupPlan,
    validateCleanupPreview
  };

  global.TaskPointsStorageImageCleanup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
