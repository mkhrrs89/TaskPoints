(function installTaskPointsSharedSaveWork(global) {
  'use strict';

  const core = global.TaskPointsCore;
  if (!core || core.__sharedSaveWorkInstalled) return;
  if (typeof core.parseTaskPointsStorageJson !== 'function' || typeof core.shadowSourceSummary !== 'function') return;
  core.__sharedSaveWorkInstalled = true;

  const originalParse = core.parseTaskPointsStorageJson.bind(core);
  const originalSummary = core.shadowSourceSummary.bind(core);
  const originalStructuredClone = typeof global.structuredClone === 'function'
    ? global.structuredClone.bind(global)
    : null;
  const snapshotMeta = new WeakMap();
  let recentParse = null;
  let parseReuseCount = 0;
  let summaryReuseCount = 0;
  let clonePropagationCount = 0;

  function pendingJournalCount() {
    try { return Number(core.readPendingHabitDeltas?.().length) || 0; }
    catch (_) { return 1; }
  }

  function verifiedCacheForRaw(raw) {
    const cache = core.getPhase4VerifiedPrimaryCache?.();
    if (!cache || cache.status !== 'passed_verification') return null;
    if (!cache.state || typeof cache.state !== 'object' || Array.isArray(cache.state)) return null;
    if (typeof raw !== 'string' || cache.mirrorRaw !== raw) return null;
    if ((Number(core.getPendingShadowDualWriteCount?.()) || 0) > 0) return null;
    if ((Number(core.getPendingPhase4WriteCount?.()) || 0) > 0) return null;
    if (pendingJournalCount() > 0) return null;
    return cache;
  }

  function summaryFromCache(cache) {
    const stateHash = cache.destinationHash || cache.sourceHash || cache.stateHash || null;
    if (!stateHash) return null;
    return {
      counts: cache.destinationCounts || cache.sourceCounts || null,
      hashes: { state: stateHash }
    };
  }

  function cloneSnapshot(value) {
    if (originalStructuredClone) return originalStructuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function rememberSnapshot(value, metadata) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !metadata) return value;
    snapshotMeta.set(value, metadata);
    return value;
  }

  function rememberRecentParse(raw, parsed) {
    if (typeof raw !== 'string' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      recentParse = null;
      return;
    }
    recentParse = {
      raw,
      source: parsed,
      snapshot: cloneSnapshot(parsed),
      summary: null
    };
  }

  if (originalStructuredClone) {
    global.structuredClone = function taskPointsSharedStructuredClone(value, options) {
      const cloned = originalStructuredClone(value, options);
      const metadata = value && typeof value === 'object' ? snapshotMeta.get(value) : null;
      if (metadata && cloned && typeof cloned === 'object') {
        snapshotMeta.set(cloned, metadata);
        clonePropagationCount += 1;
      }
      return cloned;
    };
  }

  core.parseTaskPointsStorageJson = function sharedSaveParse(raw, fallback = {}) {
    const cache = verifiedCacheForRaw(raw);
    const cachedSummary = cache ? summaryFromCache(cache) : null;
    if (cache && cachedSummary) {
      parseReuseCount += 1;
      return rememberSnapshot(cloneSnapshot(cache.state), {
        raw,
        sequence: Number(cache.sequence) || 0,
        summary: cachedSummary,
        verifiedAt: cache.verifiedAt || null
      });
    }

    if (recentParse && typeof raw === 'string' && recentParse.raw === raw) {
      parseReuseCount += 1;
      const cloned = cloneSnapshot(recentParse.snapshot);
      if (recentParse.summary) {
        rememberSnapshot(cloned, {
          raw,
          sequence: 0,
          summary: recentParse.summary,
          verifiedAt: null
        });
      }
      return cloned;
    }

    const parsed = originalParse(raw, fallback);
    rememberRecentParse(raw, parsed);
    return parsed;
  };

  core.shadowSourceSummary = function sharedSaveSummary(state) {
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      const metadata = snapshotMeta.get(state);
      if (metadata?.summary) {
        summaryReuseCount += 1;
        return metadata.summary;
      }

      const cache = core.getPhase4VerifiedPrimaryCache?.();
      if (cache?.status === 'passed_verification' && cache.state === state) {
        const cachedSummary = summaryFromCache(cache);
        if (cachedSummary) {
          snapshotMeta.set(state, {
            raw: cache.mirrorRaw,
            sequence: Number(cache.sequence) || 0,
            summary: cachedSummary,
            verifiedAt: cache.verifiedAt || null
          });
          summaryReuseCount += 1;
          return cachedSummary;
        }
      }
    }

    const result = originalSummary(state);
    if (recentParse && recentParse.source === state) {
      recentParse.summary = result;
      rememberSnapshot(recentParse.snapshot, {
        raw: recentParse.raw,
        sequence: 0,
        summary: result,
        verifiedAt: null
      });
    }
    return result;
  };

  core.getSharedVerifiedSavePackage = function getSharedVerifiedSavePackage(raw = null) {
    const targetRaw = typeof raw === 'string'
      ? raw
      : (() => {
          try { return global.localStorage?.getItem?.(core.STORAGE_KEY) ?? null; }
          catch (_) { return null; }
        })();
    const cache = verifiedCacheForRaw(targetRaw);
    if (!cache) return null;
    const summary = summaryFromCache(cache);
    if (!summary) return null;
    rememberSnapshot(cache.state, {
      raw: targetRaw,
      sequence: Number(cache.sequence) || 0,
      summary,
      verifiedAt: cache.verifiedAt || null
    });
    return {
      schemaVersion: 1,
      sequence: Number(cache.sequence) || 0,
      raw: targetRaw,
      state: cache.state,
      summary,
      mirrorHash: cache.mirrorHash || null,
      verifiedAt: cache.verifiedAt || null,
      status: 'passed_verification'
    };
  };

  core.clearSharedSaveWork = function clearSharedSaveWork() {
    recentParse = null;
  };

  core.getSharedSaveWorkStatus = () => ({
    installed: true,
    parseReuseCount,
    summaryReuseCount,
    clonePropagationCount,
    recentRawPresent: Boolean(recentParse?.raw),
    packageReady: Boolean(core.getSharedVerifiedSavePackage?.())
  });
})(typeof window !== 'undefined' ? window : globalThis);
